/**
 * ==============================================================================
 * TREIDILOR — CENTRO DE «ALERTAS DE PRECIO» (independiente de Mi Radar)
 * ==============================================================================
 * Dos tipos de aviso, con datos y preferencias PROPIOS (fichero `price-alert-center.json`, nada se guarda en radar-*.json):
 *   A) Alertas por PRECIO OBJETIVO que crea el usuario (con o sin gastos de envío). Cuando el precio registrado alcanza el objetivo se genera
 *      una notificación interna y, si el usuario lo permite, un correo.
 *   B) Bajadas de precio de productos VISITADOS por un usuario identificado. Exige una bajada real y verificable (señal de observaciones
 *      comparables, `lib/offerObservations.ts`). DESACTIVADO por defecto en el servidor (`PRICE_DROP_VISITS_ENABLED=true` para activarlo) hasta
 *      resolver la base jurídica (RGPD/LSSI): mientras tanto NO se registran visitas ni se envía ningún aviso de este tipo.
 *
 * Sólo se comparte con Mi Radar la INFRAESTRUCTURA de identidad (la sesión de cuenta) y el envío SMTP; ni la lógica ni los datos.
 *
 * Garantías: sólo el propietario ve/modifica sus datos (todas las funciones exigen `userId`); una misma bajada/objetivo no se notifica dos
 * veces (clave de deduplicación); tope de correos por usuario y día y por ejecución; cada ejecución del vigilante queda registrada con sus
 * errores. El precio que se compara es el REGISTRADO en el catálogo (con su fecha de captura): si no hay un precio válido no se dispara nada.
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataFile } from './paths';
import { findCatalogProduct, productKey } from './catalog';
import { getComparableOffers } from './comparableOffers';
import { captureDateOf, formatDateEs } from './commercialClaims';
import { activeSignal, freshnessOf, DEFAULT_MAX_AGE_HOURS, type PriceSignal } from './offerObservations';
import { findRadarUserById } from './radarAuth';
import { sendGenericMailSmtp } from './mailer';

/* ───────────────────────────── Tipos ───────────────────────────── */

export interface PriceAlert {
  id: string;
  userId: string;
  productId: string;
  productTitle: string;
  productImage: string;
  targetPrice: number;
  includeShipping: boolean;
  /** Activa = se vigila. Pausada = el usuario la desactivó. */
  active: boolean;
  /** 'met' cuando ya se cumplió (queda en «cumplidas»; editar el objetivo la rearma). */
  status: 'watching' | 'met';
  createdAt: string;
  updatedAt: string;
  metAt?: string;
  metPrice?: number;
  lastCheckedAt?: string;
}

export type NotificationKind = 'target_met' | 'price_drop';
export type EmailStatus = 'sent' | 'failed' | 'skipped' | 'disabled';

export interface AlertNotification {
  id: string;
  userId: string;
  kind: NotificationKind;
  alertId?: string;
  productId: string;
  title: string;
  image: string;
  /** Precio anterior (sólo si está acreditado). */
  oldPrice?: number;
  newPrice: number;
  targetPrice?: number;
  /** Bajada verificada en %, sólo con precio anterior acreditado. */
  pct?: number;
  includeShipping?: boolean;
  /** Fecha de captura del precio detectado. */
  priceAsOf?: string;
  createdAt: string;
  readAt?: string;
  dedupeKey: string;
  email: { status: EmailStatus; at?: string; reason?: string };
}

export interface AlertPrefs {
  targets: { inApp: boolean; email: boolean };
  drops: { inApp: boolean; email: boolean };
  updatedAt?: string;
}

interface Visit { productId: string; title: string; lastVisitAt: string; notifiedKey?: string }

export interface RunRecord {
  at: string;
  durationMs: number;
  alertsChecked: number;
  targetsMet: number;
  dropsFound: number;
  emailsSent: number;
  emailsFailed: number;
  errors: string[];
}

interface State {
  version: 1;
  alerts: PriceAlert[];
  notifications: AlertNotification[];
  prefs: Record<string, AlertPrefs>;
  visits: Record<string, Record<string, Visit>>;
  runs: RunRecord[];
}

/* ───────────────────────────── Persistencia ───────────────────────────── */

const FILE = () => dataFile('price-alert-center.json');
const MAX_ALERTS_PER_USER = 50;
const MAX_NOTIFICATIONS_PER_USER = 200;
const MAX_VISITS_PER_USER = 100;
const MAX_RUNS = 100;
/** Topes anti-saturación de correos. */
export const MAX_EMAILS_PER_USER_PER_DAY = 3;
export const MAX_EMAILS_PER_RUN = 40;

export const DEFAULT_PREFS: AlertPrefs = { targets: { inApp: true, email: true }, drops: { inApp: true, email: true } };

const empty = (): State => ({ version: 1, alerts: [], notifications: [], prefs: {}, visits: {}, runs: [] });

function load(): State {
  try {
    const f = FILE();
    if (!fs.existsSync(f)) return empty();
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { ...empty(), ...raw, alerts: raw.alerts ?? [], notifications: raw.notifications ?? [], prefs: raw.prefs ?? {}, visits: raw.visits ?? {}, runs: raw.runs ?? [] };
  } catch (error) {
    console.error('[AlertasPrecio] No se pudo leer el almacén; se ignora esta lectura:', error);
    throw error; // nunca se reescribe sobre un fichero ilegible
  }
}

function save(state: State): void {
  const f = FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

/** Lectura-modificación-escritura SÍNCRONA (un solo proceso): sin carreras dentro del servidor. */
function mutate<T>(fn: (s: State) => T): T {
  const state = load();
  const out = fn(state);
  save(state);
  return out;
}

const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const nowIso = () => new Date().toISOString();
const round2 = (n: number) => Math.round(n * 100) / 100;

/* ───────────────────────────── Interruptores del servidor ───────────────────────────── */

const flag = (name: string, dflt: boolean): boolean => {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return dflt;
  return v === 'true' || v === '1';
};
/** Vigilante de alertas por precio objetivo (A). Activado por defecto: sólo actúa sobre alertas que el propio usuario ha creado. */
export const alertCenterEnabled = (): boolean => flag('PRICE_ALERT_CENTER_ENABLED', true);
/** Avisos B (bajadas de productos visitados): APAGADO hasta resolver la base jurídica. Controla el registro de visitas Y los avisos. */
export const dropVisitsEnabled = (): boolean => flag('PRICE_DROP_VISITS_ENABLED', false);

/* ───────────────────────────── Precio vigente de un producto ───────────────────────────── */

export interface CurrentPrice {
  product: any;
  price: number;
  total: number | null;
  asOf: string | null;
}

/** Precio REGISTRADO de la oferta principal (sin envío) y su total con envío si consta. null si no hay precio válido o no hay stock. */
export function currentPriceOf(productId: string): CurrentPrice | null {
  const product = findCatalogProduct(productId) as any;
  if (!product) return null;
  const price = Number(product.price);
  if (!(price > 0) || product.inStock === false) return null;
  const main = getComparableOffers(product).offers.find((o) => o.origin === 'implicit');
  return { product, price, total: main?.totalPrice ?? null, asOf: captureDateOf(product) };
}

/** ¿Alcanza el precio la alerta? Con envío incluido exige un total conocido (si el envío no consta, no se dispara). */
export function alertValue(alert: Pick<PriceAlert, 'includeShipping'>, cur: CurrentPrice): number | null {
  return alert.includeShipping ? cur.total : cur.price;
}

/* ───────────────────────────── Preferencias ───────────────────────────── */

export function getPrefs(userId: string): AlertPrefs {
  const p = load().prefs[userId];
  return {
    targets: { inApp: p?.targets?.inApp ?? true, email: p?.targets?.email ?? true },
    drops: { inApp: p?.drops?.inApp ?? true, email: p?.drops?.email ?? true },
    updatedAt: p?.updatedAt,
  };
}

/** Preferencias independientes para avisos internos y correos, por tipo. Se respetan de inmediato (se leen en cada envío). */
export function setPrefs(userId: string, patch: Partial<{ targets: Partial<AlertPrefs['targets']>; drops: Partial<AlertPrefs['drops']> }>): AlertPrefs {
  return mutate((s) => {
    const cur = {
      targets: { inApp: s.prefs[userId]?.targets?.inApp ?? true, email: s.prefs[userId]?.targets?.email ?? true },
      drops: { inApp: s.prefs[userId]?.drops?.inApp ?? true, email: s.prefs[userId]?.drops?.email ?? true },
    };
    for (const k of ['targets', 'drops'] as const) {
      for (const ch of ['inApp', 'email'] as const) {
        const v = patch[k]?.[ch];
        if (typeof v === 'boolean') cur[k][ch] = v;
      }
    }
    s.prefs[userId] = { ...cur, updatedAt: nowIso() };
    return s.prefs[userId];
  });
}

/* ───────────────────────────── Alertas por precio objetivo (A) ───────────────────────────── */

export class AlertError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function listAlerts(userId: string): PriceAlert[] {
  return load().alerts.filter((a) => a.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createAlert(userId: string, input: { productId: string; targetPrice: number; includeShipping?: boolean }): PriceAlert {
  const target = round2(Number(input.targetPrice));
  if (!(target > 0) || target > 1_000_000) throw new AlertError('precio_invalido', 'El precio objetivo debe ser un importe positivo.');
  const product = findCatalogProduct(String(input.productId ?? '')) as any;
  if (!product) throw new AlertError('producto_no_encontrado', 'No se encuentra el producto.');
  return mutate((s) => {
    const mine = s.alerts.filter((a) => a.userId === userId);
    if (mine.length >= MAX_ALERTS_PER_USER) throw new AlertError('limite_de_alertas', `Has alcanzado el máximo de ${MAX_ALERTS_PER_USER} alertas.`);
    const dup = mine.find((a) => a.productId === product.id && a.status === 'watching');
    const stamp = nowIso();
    if (dup) {
      // Una sola alerta vigilando por producto: crear de nuevo la actualiza.
      dup.targetPrice = target;
      dup.includeShipping = Boolean(input.includeShipping);
      dup.active = true;
      dup.updatedAt = stamp;
      return dup;
    }
    const alert: PriceAlert = {
      id: newId('al'), userId, productId: product.id, productTitle: String(product.title).slice(0, 160), productImage: String(product.image ?? ''),
      targetPrice: target, includeShipping: Boolean(input.includeShipping), active: true, status: 'watching', createdAt: stamp, updatedAt: stamp,
    };
    s.alerts.push(alert);
    return alert;
  });
}

export function updateAlert(userId: string, id: string, patch: { targetPrice?: number; includeShipping?: boolean; active?: boolean }): PriceAlert {
  return mutate((s) => {
    const alert = s.alerts.find((a) => a.id === id && a.userId === userId); // propietario
    if (!alert) throw new AlertError('no_encontrada', 'Alerta no encontrada.');
    if (patch.targetPrice !== undefined) {
      const t = round2(Number(patch.targetPrice));
      if (!(t > 0) || t > 1_000_000) throw new AlertError('precio_invalido', 'El precio objetivo debe ser un importe positivo.');
      if (t !== alert.targetPrice) { alert.targetPrice = t; alert.status = 'watching'; delete alert.metAt; delete alert.metPrice; } // cambiar el objetivo la rearma
    }
    if (typeof patch.includeShipping === 'boolean' && patch.includeShipping !== alert.includeShipping) { alert.includeShipping = patch.includeShipping; alert.status = 'watching'; delete alert.metAt; delete alert.metPrice; }
    if (typeof patch.active === 'boolean') alert.active = patch.active;
    alert.updatedAt = nowIso();
    return alert;
  });
}

export function deleteAlert(userId: string, id: string): boolean {
  return mutate((s) => {
    const before = s.alerts.length;
    s.alerts = s.alerts.filter((a) => !(a.id === id && a.userId === userId));
    return s.alerts.length < before;
  });
}

/* ───────────────────────────── Notificaciones ───────────────────────────── */

export function listNotifications(userId: string): AlertNotification[] {
  return load().notifications.filter((n) => n.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function unreadCount(userId: string): number {
  return load().notifications.filter((n) => n.userId === userId && !n.readAt).length;
}

/** Marca como leídas las indicadas (o todas con `ids = 'all'`). Sólo afecta a las del propio usuario. */
export function markRead(userId: string, ids: string[] | 'all'): number {
  return mutate((s) => {
    let n = 0;
    const stamp = nowIso();
    for (const x of s.notifications) {
      if (x.userId !== userId || x.readAt) continue;
      if (ids === 'all' || ids.includes(x.id)) { x.readAt = stamp; n++; }
    }
    return n;
  });
}

/** Añade una notificación salvo que ya exista otra con la misma clave (misma bajada/objetivo: no se repite). Devuelve null si era duplicada. */
function pushNotification(s: State, n: Omit<AlertNotification, 'id' | 'createdAt' | 'email'>): AlertNotification | null {
  if (s.notifications.some((x) => x.userId === n.userId && x.dedupeKey === n.dedupeKey)) return null;
  const full: AlertNotification = { ...n, id: newId('nt'), createdAt: nowIso(), email: { status: 'skipped' } };
  s.notifications.push(full);
  const mine = s.notifications.filter((x) => x.userId === n.userId);
  if (mine.length > MAX_NOTIFICATIONS_PER_USER) {
    const drop = new Set(mine.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, mine.length - MAX_NOTIFICATIONS_PER_USER).map((x) => x.id));
    s.notifications = s.notifications.filter((x) => !drop.has(x.id));
  }
  return full;
}

/* ───────────────────────────── Visitas (B): sólo con el interruptor activo ───────────────────────────── */

/** Registra que un usuario identificado visitó una ficha. NO hace nada si los avisos B están apagados (no se trata ningún dato). */
export function recordVisit(userId: string, productId: string, title: string): boolean {
  if (!dropVisitsEnabled()) return false;
  if (!userId || !productId) return false;
  mutate((s) => {
    const mine = (s.visits[userId] ??= {});
    mine[productId] = { productId, title: String(title).slice(0, 160), lastVisitAt: nowIso(), notifiedKey: mine[productId]?.notifiedKey };
    const keys = Object.keys(mine);
    if (keys.length > MAX_VISITS_PER_USER) {
      keys.sort((a, b) => mine[a].lastVisitAt.localeCompare(mine[b].lastVisitAt)).slice(0, keys.length - MAX_VISITS_PER_USER).forEach((k) => delete mine[k]);
    }
  });
  return true;
}

/** Borra todo lo registrado de visitas de un usuario (derecho de supresión / al desactivar). */
export function clearVisits(userId: string): void {
  mutate((s) => { delete s.visits[userId]; });
}

/** Elimina TODOS los datos del centro de alertas de un usuario (al borrar su cuenta, o a petición). */
export function purgeUserData(userId: string): void {
  mutate((s) => {
    s.alerts = s.alerts.filter((a) => a.userId !== userId);
    s.notifications = s.notifications.filter((n) => n.userId !== userId);
    delete s.prefs[userId];
    delete s.visits[userId];
  });
}

/* ───────────────────────────── Correo ───────────────────────────── */

const esc = (v: string) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const eur = (n: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);
const origin = () => String(process.env.PUBLIC_SITE_URL ?? '').trim().replace(/\/$/, '') || 'https://treidilor.com';

export function buildEmail(n: AlertNotification, slug: string): { subject: string; html: string; text: string } {
  const url = `${origin()}/producto/${encodeURIComponent(slug)}`;
  const manage = `${origin()}/alertas-precio`;
  const asOf = n.priceAsOf ? ` (precio registrado el ${formatDateEs(n.priceAsOf)})` : '';
  if (n.kind === 'target_met') {
    const subject = `Tu alerta de precio: ${n.title.slice(0, 70)} ya cuesta ${eur(n.newPrice)}`;
    const lines = [
      `${n.title}`,
      `Precio detectado: ${eur(n.newPrice)}${n.includeShipping ? ' (gastos de envío incluidos)' : ''}${asOf}`,
      `Tu precio objetivo: ${eur(n.targetPrice ?? 0)}`,
      `Ver la ficha: ${url}`,
      `El precio final lo confirma la tienda. Gestiona o desactiva tus alertas: ${manage}`,
      `Recibes este aviso porque creaste esta alerta de precio en Treidilor.`,
    ];
    return {
      subject,
      text: lines.join('\n'),
      html: `<p><strong>${esc(n.title)}</strong></p><p>Precio detectado: <strong>${eur(n.newPrice)}</strong>${n.includeShipping ? ' (gastos de envío incluidos)' : ''}${esc(asOf)}<br>Tu precio objetivo: ${eur(n.targetPrice ?? 0)}</p><p><a href="${url}">Ver la ficha del producto</a></p><p style="color:#666;font-size:12px">El precio final lo confirma la tienda. <a href="${manage}">Gestiona o desactiva tus alertas</a>. Recibes este aviso porque creaste esta alerta de precio en Treidilor.</p>`,
    };
  }
  const subject = `Ha bajado de precio: ${n.title.slice(0, 70)}`;
  const lines = [
    `${n.title}`,
    `Antes: ${eur(n.oldPrice ?? 0)} · Ahora: ${eur(n.newPrice)}${n.pct ? ` (-${n.pct}%)` : ''}${asOf}`,
    `Ver la ficha: ${url}`,
    `Puedes desactivar estos avisos en: ${manage}`,
  ];
  return {
    subject,
    text: lines.join('\n'),
    html: `<p><strong>${esc(n.title)}</strong></p><p>Antes: <s>${eur(n.oldPrice ?? 0)}</s> · Ahora: <strong>${eur(n.newPrice)}</strong>${n.pct ? ` (-${n.pct}%)` : ''}${esc(asOf)}</p><p><a href="${url}">Ver la ficha del producto</a></p><p style="color:#666;font-size:12px"><a href="${manage}">Desactivar estos avisos</a>.</p>`,
  };
}

type Mailer = (p: { to: string; subject: string; html: string; text?: string }) => Promise<boolean>;

/* ───────────────────────────── Vigilante ───────────────────────────── */

let running = false;

export interface EvaluateOptions { now?: Date; mailer?: Mailer; sendEmails?: boolean }

/**
 * Una pasada del vigilante: comprueba las alertas activas (A) y, si está habilitado, las bajadas de productos visitados (B). Idempotente: una
 * misma bajada/objetivo no genera dos notificaciones ni dos correos. Nunca lanza: los errores se registran en la ejecución.
 */
export async function evaluateAlerts(opts: EvaluateOptions = {}): Promise<RunRecord> {
  const started = Date.now();
  const run: RunRecord = { at: nowIso(), durationMs: 0, alertsChecked: 0, targetsMet: 0, dropsFound: 0, emailsSent: 0, emailsFailed: 0, errors: [] };
  if (running) { run.errors.push('ya_en_ejecucion'); return run; }
  running = true;
  const mailer = opts.mailer ?? sendGenericMailSmtp;
  const sendEmails = opts.sendEmails !== false;
  const now = opts.now ?? new Date();
  try {
    const pendingEmails: AlertNotification[] = [];
    mutate((s) => {
      /* A) Alertas por precio objetivo */
      for (const alert of s.alerts) {
        if (!alert.active || alert.status !== 'watching') continue;
        try {
          const cur = currentPriceOf(alert.productId);
          alert.lastCheckedAt = now.toISOString();
          run.alertsChecked++;
          if (!cur) continue;
          const value = alertValue(alert, cur);
          if (value === null || value > alert.targetPrice + 0.0001) continue;
          alert.status = 'met';
          alert.metAt = now.toISOString();
          alert.metPrice = round2(value);
          run.targetsMet++;
          const prefs = s.prefs[alert.userId]?.targets ?? DEFAULT_PREFS.targets;
          const note = pushNotification(s, {
            userId: alert.userId, kind: 'target_met', alertId: alert.id, productId: alert.productId,
            title: String(cur.product.title).slice(0, 160), image: String(cur.product.image ?? ''), newPrice: round2(value), targetPrice: alert.targetPrice,
            includeShipping: alert.includeShipping, priceAsOf: cur.asOf ?? undefined, dedupeKey: `target:${alert.id}:${alert.targetPrice}:${alert.includeShipping ? 's' : 'n'}`,
          });
          if (note) {
            // «Preferencia interna desactivada» = la notificación existe en el historial pero ya nace leída (no enciende la campana).
            if (!prefs.inApp) note.readAt = now.toISOString();
            if (prefs.email) pendingEmails.push(note); else note.email = { status: 'disabled' };
          }
        } catch (e) { run.errors.push(`alerta ${alert.id}: ${(e as Error).message}`.slice(0, 200)); }
      }

      /* B) Bajadas de productos visitados (apagado por defecto) */
      if (dropVisitsEnabled()) {
        for (const [userId, visits] of Object.entries(s.visits)) {
          for (const v of Object.values(visits)) {
            try {
              const product = findCatalogProduct(v.productId) as any;
              if (!product) continue;
              const signal = (product.extra?.priceSignal ?? null) as PriceSignal | null;
              const lastVerified = product.extra?.refresh?.lastVerifiedAt as string | undefined;
              const active = signal
                ? activeSignal(signal, { now, offerKey: signal.offerKey, currentPrice: Number(product.price) || null, stale: lastVerified ? freshnessOf(lastVerified, DEFAULT_MAX_AGE_HOURS) === 'stale' : true })
                : null;
              if (!active || !(active.previousPrice > active.price) || active.currency.toUpperCase() !== 'EUR') continue;
              if (Date.parse(active.detectedAt) <= Date.parse(v.lastVisitAt)) continue; // la bajada debe ser POSTERIOR a la visita
              const key = `drop:${product.id}:${active.detectedAt}:${active.price}`;
              if (v.notifiedKey === key) continue;
              const prefs = s.prefs[userId]?.drops ?? DEFAULT_PREFS.drops;
              const pct = Math.round(((active.previousPrice - active.price) / active.previousPrice) * 1000) / 10;
              const note = pushNotification(s, {
                userId, kind: 'price_drop', productId: product.id, title: String(product.title).slice(0, 160), image: String(product.image ?? ''),
                oldPrice: round2(active.previousPrice), newPrice: round2(active.price), pct, priceAsOf: active.detectedAt.slice(0, 10), dedupeKey: key,
              });
              v.notifiedKey = key;
              run.dropsFound++;
              if (note) {
                if (!prefs.inApp) note.readAt = now.toISOString();
                if (prefs.email) pendingEmails.push(note); else note.email = { status: 'disabled' };
              }
            } catch (e) { run.errors.push(`visita ${v.productId}: ${(e as Error).message}`.slice(0, 200)); }
          }
        }
      }
    });

    /* Envío de correos fuera de la sección crítica: nunca bloquea la escritura; cada resultado se guarda después. */
    const results = new Map<string, AlertNotification['email']>();
    const sentToday = new Map<string, number>();
    const state = load();
    const dayAgo = now.getTime() - 24 * 3_600_000;
    for (const n of state.notifications) if (n.email.status === 'sent' && Date.parse(n.email.at ?? '') > dayAgo) sentToday.set(n.userId, (sentToday.get(n.userId) ?? 0) + 1);
    let sentThisRun = 0;
    for (const n of pendingEmails) {
      if (!sendEmails) { results.set(n.id, { status: 'skipped', reason: 'envio_desactivado' }); continue; }
      if (sentThisRun >= MAX_EMAILS_PER_RUN) { results.set(n.id, { status: 'skipped', reason: 'tope_por_ejecucion' }); continue; }
      if ((sentToday.get(n.userId) ?? 0) >= MAX_EMAILS_PER_USER_PER_DAY) { results.set(n.id, { status: 'skipped', reason: 'tope_diario_usuario' }); continue; }
      const user = findRadarUserById(n.userId);
      if (!user || !user.verified || !user.email) { results.set(n.id, { status: 'skipped', reason: 'sin_email_verificado' }); continue; }
      // Preferencia leída JUSTO antes de enviar: una desactivación reciente se respeta de inmediato.
      const prefs = getPrefs(n.userId);
      if (!(n.kind === 'target_met' ? prefs.targets.email : prefs.drops.email)) { results.set(n.id, { status: 'disabled' }); continue; }
      try {
        const product = findCatalogProduct(n.productId) as any;
        const mail = buildEmail(n, product ? productKey(product) : n.productId);
        const ok = await mailer({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text });
        if (ok) { sentThisRun++; run.emailsSent++; sentToday.set(n.userId, (sentToday.get(n.userId) ?? 0) + 1); results.set(n.id, { status: 'sent', at: nowIso() }); }
        else { run.emailsFailed++; results.set(n.id, { status: 'failed', at: nowIso(), reason: 'smtp_no_disponible_o_rechazado' }); }
      } catch (e) { run.emailsFailed++; results.set(n.id, { status: 'failed', at: nowIso(), reason: (e as Error).message.slice(0, 120) }); }
    }
    mutate((s) => {
      for (const n of s.notifications) { const r = results.get(n.id); if (r) n.email = r; }
      run.durationMs = Date.now() - started;
      s.runs.push(run);
      if (s.runs.length > MAX_RUNS) s.runs = s.runs.slice(-MAX_RUNS);
    });
  } catch (e) {
    run.errors.push(`fallo_general: ${(e as Error).message}`.slice(0, 200));
    run.durationMs = Date.now() - started;
    try { mutate((s) => { s.runs.push(run); s.runs = s.runs.slice(-MAX_RUNS); }); } catch { /* sin almacén: sólo consola */ }
    console.error('[AlertasPrecio] Ejecución fallida:', e);
  } finally {
    running = false;
  }
  return run;
}

export function listRuns(limit = 20): RunRecord[] {
  return load().runs.slice(-limit).reverse();
}

/* ───────────────────────────── Programador ───────────────────────────── */

const TICK_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 90 * 1000;
let started = false;

/** Programador en el propio proceso (mismo patrón que priceAlerts.ts: setInterval + unref, sin cron externo). */
export function startPriceAlertCenterScheduler(): void {
  if (started || !alertCenterEnabled()) return;
  started = true;
  const tick = () => { void evaluateAlerts().then((r) => { if (r.targetsMet || r.dropsFound || r.errors.length) console.log('[AlertasPrecio]', JSON.stringify(r)); }); };
  setTimeout(tick, INITIAL_DELAY_MS).unref?.();
  setInterval(tick, TICK_MS).unref?.();
}
