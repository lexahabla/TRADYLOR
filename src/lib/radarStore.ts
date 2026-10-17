import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataFile } from './paths';
import {
  DEFAULT_PROJECT,
  type PendingExit,
  type ProjectFolder,
  type RadarData,
  type Reminder,
  type SavedProduct,
} from '../types/radar';

/**
 * ==============================================================================
 * TRADYLOR — STORE DE DATOS "MI RADAR" (nube)
 * ==============================================================================
 * radar-data.json en el directorio de datos (volumen en producción). Un objeto
 * por usuario (clave = id de radarAuth). El cliente mantiene siempre su copia
 * en LocalStorage (Offline-First); al autenticarse hace sync y aquí se hace el
 * merge conservando lo más reciente de cada producto.
 * ==============================================================================
 */

const DATA_FILE = dataFile('radar-data.json');

type RadarDataFile = Record<string, RadarData>;

function uuid(): string {
  return randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function emptyRadar(): RadarData {
  return {
    projects: [{ ...DEFAULT_PROJECT, products: [] }],
    pendingExits: [],
    reminders: [],
  };
}

function readAll(): RadarDataFile {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as RadarDataFile) : {};
  } catch (error) {
    console.error('[RadarStore] Error leyendo radar-data.json:', error);
    return {};
  }
}

function writeAll(data: RadarDataFile): void {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, DATA_FILE);
}

/** Radar del usuario (vacío con "General" si no existe aún). */
export function getRadar(userId: string): RadarData {
  const all = readAll();
  const stored = all[userId];
  if (!stored || !Array.isArray(stored.projects) || stored.projects.length === 0) {
    return emptyRadar();
  }
  return {
    projects: stored.projects.map((p) => ({ ...p, products: Array.isArray(p.products) ? p.products : [] })),
    pendingExits: Array.isArray(stored.pendingExits) ? stored.pendingExits : [],
    reminders: Array.isArray(stored.reminders) ? stored.reminders : [],
    removedProducts: cleanTombstones(stored.removedProducts, Date.now()),
    removedProjects: cleanTombstones(stored.removedProjects, Date.now()),
  };
}

/* ------------------------------------------------- marcas de tiempo y bajas */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Las bajas de productos se olvidan a los 180 días (o al pasar de 500). */
const PRODUCT_TOMBSTONE_TTL_MS = 180 * DAY_MS;
const PRODUCT_TOMBSTONE_MAX = 500;
/** Las bajas de listas duran más: los ids de lista no se reutilizan. */
const PROJECT_TOMBSTONE_TTL_MS = 730 * DAY_MS;
const PROJECT_TOMBSTONE_MAX = 200;

function toStamp(value: unknown): number {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : 0;
}

/** Última vez que se tocó un producto: alta o cambio de lista. Manda en los conflictos. */
function touchedAt(product: SavedProduct): number {
  return Math.max(toStamp(product.dateAdded), toStamp(product.movedAt));
}

/** Normaliza un mapa de bajas {id → epoch ms}; el futuro se recorta a "ahora" (reloj desajustado). */
function cleanTombstones(input: unknown, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [rawId, rawAt] of Object.entries(input as Record<string, unknown>)) {
    const id = String(rawId).slice(0, 200);
    const at = Math.min(Number(rawAt), now);
    if (!id || !Number.isFinite(at) || at <= 0) continue;
    out[id] = Math.max(out[id] ?? 0, Math.floor(at));
  }
  return out;
}

/** Une dos mapas de bajas (gana la más reciente) y descarta las caducadas o sobrantes. */
function mergeTombstones(
  a: Record<string, number>,
  b: Record<string, number>,
  now: number,
  ttlMs: number,
  max: number,
): Record<string, number> {
  const merged: Record<string, number> = { ...a };
  for (const [id, at] of Object.entries(b)) merged[id] = Math.max(merged[id] ?? 0, at);
  return Object.fromEntries(
    Object.entries(merged)
      .filter(([, at]) => now - at <= ttlMs)
      .sort((x, y) => y[1] - x[1])
      .slice(0, max),
  );
}

/* ------------------------------------------------------------------ merge */

function mergeProducts(incoming: SavedProduct[], existing: SavedProduct[]): SavedProduct[] {
  const byId = new Map<string, SavedProduct>();
  for (const product of existing) byId.set(product.id, product);
  for (const product of incoming) {
    const current = byId.get(product.id);
    if (!current) {
      byId.set(product.id, product);
      continue;
    }
    // Conserva lo más reciente; la nota del cliente gana si el cloud no tiene.
    const incomingNewer = String(product.dateAdded) >= String(current.dateAdded);
    byId.set(product.id, {
      ...current,
      ...product,
      dateAdded: incomingNewer ? product.dateAdded : current.dateAdded,
      userNote: product.userNote ?? current.userNote,
    });
  }
  return [...byId.values()].sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)));
}

const REMINDER_STATUSES = new Set(['scheduled', 'sending', 'sent', 'cancelled']);

/** Normaliza un aviso recibido del cliente (nunca confiar en el payload). */
function sanitizeReminder(input: Reminder): Reminder {
  const status = REMINDER_STATUSES.has(String(input.status)) ? input.status : 'scheduled';
  return {
    id: String(input.id ?? '').slice(0, 64),
    productId: String(input.productId ?? '').slice(0, 200),
    title: String(input.title ?? '').slice(0, 200),
    remindAt: Math.max(0, Number(input.remindAt) || 0),
    reason: String(input.reason ?? '').slice(0, 80),
    reasonNote: String(input.reasonNote ?? '').trim().slice(0, 300) || undefined,
    status,
    createdAt: Math.max(0, Number(input.createdAt) || Date.now()),
    sentAt: Number(input.sentAt) || undefined,
    attempts: Number(input.attempts) || 0,
    lastError: input.lastError ? String(input.lastError).slice(0, 300) : undefined,
  };
}

/**
 * Merge de avisos por id. Reglas:
 *  - un aviso ya enviado/cancelado/en curso NUNCA vuelve a 'scheduled'
 *    (evita reenvíos tras un push tardío del cliente);
 *  - mientras esté 'scheduled', la fecha que manda es la del cliente
 *    (así se puede reprogramar desde cualquier dispositivo).
 */
function mergeReminders(incoming: Reminder[], existing: Reminder[]): Reminder[] {
  const byId = new Map<string, Reminder>();
  for (const reminder of existing) byId.set(reminder.id, reminder);

  for (const raw of incoming) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
    const reminder = sanitizeReminder(raw);
    const current = byId.get(reminder.id);
    if (!current) {
      byId.set(reminder.id, reminder);
      continue;
    }
    const locked = current.status === 'sent' || current.status === 'cancelled' || current.status === 'sending';
    const status = locked && reminder.status === 'scheduled' ? current.status : reminder.status;
    byId.set(reminder.id, {
      ...current,
      ...reminder,
      status,
      remindAt: status === 'scheduled' ? reminder.remindAt || current.remindAt : current.remindAt,
      sentAt: current.sentAt ?? reminder.sentAt,
      attempts: Math.max(current.attempts ?? 0, reminder.attempts ?? 0),
      lastError: reminder.lastError ?? current.lastError,
    });
  }

  return [...byId.values()]
    .filter((r) => r.id && r.productId)
    .sort((a, b) => a.remindAt - b.remindAt)
    .slice(0, 50);
}

/** Une los campos de las dos copias de un mismo producto (la del cliente manda; la nota se conserva). */
function mergeProductFields(current: SavedProduct, incoming: SavedProduct): SavedProduct {
  const incomingNewer = String(incoming.dateAdded) >= String(current.dateAdded);
  return {
    ...current,
    ...incoming,
    dateAdded: incomingNewer ? incoming.dateAdded : current.dateAdded,
    userNote: incoming.userNote ?? current.userNote,
  };
}

function clampPrice(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(Math.min(n, 1_000_000) * 100) / 100;
}

/** Normaliza los campos sensibles de un producto antes de persistirlo (sync o alta puntual). */
function sanitizeRadarProduct(product: SavedProduct): SavedProduct {
  const clean: SavedProduct = {
    ...product,
    id: String(product.id ?? '').slice(0, 200),
    title: String(product.title ?? '').slice(0, 300),
    price: String(product.price ?? '').slice(0, 40),
    image: String(product.image ?? '').slice(0, 1000),
    buyUrl: String(product.buyUrl ?? '').slice(0, 1000),
    store: product.store === 'aliexpress' ? 'aliexpress' : 'amazon',
  };
  const initial = clampPrice(product.initialPrice);
  const target = clampPrice(product.targetPrice);
  const lastPrice = clampPrice(product.priceAlert?.lastPrice);
  if (initial !== undefined) clean.initialPrice = initial;
  if (target !== undefined) clean.targetPrice = target;
  if (product.priceAlert) {
    clean.priceAlert = {
      status: product.priceAlert.status === 'triggered' ? 'triggered' : 'armed',
      triggeredAt: product.priceAlert.triggeredAt ? String(product.priceAlert.triggeredAt).slice(0, 40) : undefined,
      lastPrice,
      lastCheckedAt: product.priceAlert.lastCheckedAt
        ? String(product.priceAlert.lastCheckedAt).slice(0, 40)
        : undefined,
      lastInStock: typeof product.priceAlert.lastInStock === 'boolean' ? product.priceAlert.lastInStock : undefined,
    };
  }
  return clean;
}

/**
 * Sync LocalStorage → nube. Fusión por unión con marcas de tiempo:
 *  - Altas: lo que sólo existe en un lado se conserva (otro dispositivo, otra sesión).
 *  - Mover: si un producto aparece en dos listas, queda en la del cambio más reciente
 *    (`movedAt` o `dateAdded`); a igualdad gana la copia del cliente que sincroniza.
 *  - Quitar / eliminar lista: se anota una baja con su fecha. Un producto sólo se
 *    descarta si la baja es igual o posterior a su último cambio, así que volver a
 *    guardarlo más tarde lo recupera. Sin esto la unión resucitaba todo lo borrado.
 */
export function syncRadar(userId: string, incoming: Partial<RadarData>): RadarData {
  const all = readAll();
  const current = all[userId] ?? emptyRadar();
  const now = Date.now();

  const removedProducts = mergeTombstones(
    cleanTombstones(incoming.removedProducts, now),
    cleanTombstones(current.removedProducts, now),
    now,
    PRODUCT_TOMBSTONE_TTL_MS,
    PRODUCT_TOMBSTONE_MAX,
  );
  const removedProjects = mergeTombstones(
    cleanTombstones(incoming.removedProjects, now),
    cleanTombstones(current.removedProjects, now),
    now,
    PROJECT_TOMBSTONE_TTL_MS,
    PROJECT_TOMBSTONE_MAX,
  );

  // --- Listas: nombre y descripción del cliente; las que sólo viven en la nube se conservan.
  const incomingProjects = (Array.isArray(incoming.projects) ? incoming.projects : []).filter(
    (project) => project && typeof project.id === 'string' && project.id,
  );
  const order: string[] = [];
  const meta = new Map<string, { name: string; description?: string }>();
  for (const project of incomingProjects) {
    const existing = current.projects.find((p) => p.id === project.id);
    if (!meta.has(project.id)) order.push(project.id);
    meta.set(project.id, {
      name: String(project.name ?? existing?.name ?? 'Lista').slice(0, 60),
      description: String(project.description ?? existing?.description ?? '').slice(0, 200) || undefined,
    });
  }
  for (const project of current.projects) {
    if (meta.has(project.id)) continue;
    order.push(project.id);
    meta.set(project.id, { name: project.name, description: project.description });
  }
  // Las listas dadas de baja desaparecen (General nunca se borra).
  const liveIds = order.filter((id) => id === DEFAULT_PROJECT.id || !(id in removedProjects));
  if (!liveIds.includes(DEFAULT_PROJECT.id)) {
    liveIds.unshift(DEFAULT_PROJECT.id);
    meta.set(DEFAULT_PROJECT.id, { name: DEFAULT_PROJECT.name, description: DEFAULT_PROJECT.description });
  }
  const live = new Set(liveIds);
  /** Un producto en una lista que ya no existe pasa a General. */
  const folderOf = (id: string): string => (live.has(id) ? id : DEFAULT_PROJECT.id);

  // --- Productos: la copia más reciente de cada lado, y entre ambos lados la del último cambio.
  type Entry = { folderId: string; product: SavedProduct; touched: number };
  const bestByProduct = (projects: ProjectFolder[]): Map<string, Entry> => {
    const best = new Map<string, Entry>();
    for (const project of projects) {
      for (const product of Array.isArray(project.products) ? project.products : []) {
        if (!product || typeof product.id !== 'string' || !product.id) continue;
        const entry: Entry = { folderId: folderOf(project.id), product, touched: touchedAt(product) };
        const previous = best.get(product.id);
        if (!previous || entry.touched > previous.touched) best.set(product.id, entry);
      }
    }
    return best;
  };
  const fromClient = bestByProduct(incomingProjects);
  const fromCloud = bestByProduct(current.projects);

  const placed = new Map<string, SavedProduct[]>(liveIds.map((id) => [id, []]));
  for (const id of new Set([...fromClient.keys(), ...fromCloud.keys()])) {
    const client = fromClient.get(id);
    const cloud = fromCloud.get(id);
    let folderId: string;
    let product: SavedProduct;
    if (client && cloud) {
      const winner = client.touched >= cloud.touched ? client : cloud;
      product = sanitizeRadarProduct(mergeProductFields(cloud.product, client.product));
      if (winner.product.movedAt) product.movedAt = winner.product.movedAt;
      else delete product.movedAt;
      folderId = winner.folderId;
    } else {
      const only = (client ?? cloud) as Entry;
      product = sanitizeRadarProduct(only.product);
      folderId = only.folderId;
    }
    const removedAt = removedProducts[id];
    if (removedAt !== undefined && removedAt >= touchedAt(product)) continue;
    placed.get(folderId)?.push(product);
  }

  const projects: ProjectFolder[] = liveIds.map((id) => ({
    id,
    name: meta.get(id)?.name ?? 'Lista',
    description: meta.get(id)?.description,
    products: (placed.get(id) ?? []).sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded))),
  }));

  const exitsById = new Map<string, PendingExit>();
  for (const exit of current.pendingExits) exitsById.set(exit.productId, exit);
  const incomingExits = Array.isArray(incoming.pendingExits) ? incoming.pendingExits : [];
  for (const exit of incomingExits) {
    if (!exit || typeof exit.productId !== 'string' || !exit.productId) continue;
    const existing = exitsById.get(exit.productId);
    const status = existing && existing.status !== 'pending' && exit.status === 'pending'
      ? existing.status // no regresar a pending una salida ya resuelta
      : (exit.status ?? 'pending');
    exitsById.set(exit.productId, {
      productId: exit.productId,
      title: String(exit.title ?? existing?.title ?? '').slice(0, 200),
      timestamp: Math.max(Number(exit.timestamp) || 0, existing?.timestamp ?? 0) || Date.now(),
      status,
    });
  }

  // Avisos: si el cliente no manda ninguno (versión vieja / LocalStorage
  // normalizado), se conservan los de la nube; nunca se borran en bloque.
  const incomingReminders = Array.isArray(incoming.reminders) ? incoming.reminders : [];
  const reminders = incomingReminders.length > 0 || current.reminders?.length
    ? mergeReminders(incomingReminders, current.reminders ?? [])
    : [];

  const merged: RadarData = {
    projects,
    pendingExits: [...exitsById.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50),
    reminders,
    removedProducts,
    removedProjects,
  };
  all[userId] = merged;
  writeAll(all);
  return merged;
}

/* ------------------------------------------------- operaciones puntuales */

/** Añade/actualiza un producto en una carpeta (por defecto General). */
export function addProduct(userId: string, product: SavedProduct, projectId = DEFAULT_PROJECT.id): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  const clean = sanitizeRadarProduct(product);
  let project = radar.projects.find((p) => p.id === projectId);
  if (!project) {
    project = { id: projectId, name: 'General', products: [] };
    radar.projects.push(project);
  }
  project.products = mergeProducts([clean], project.products);
  // Evita duplicados en otras carpetas.
  for (const other of radar.projects) {
    if (other.id === project.id) continue;
    other.products = other.products.filter((p) => p.id !== clean.id);
  }
  all[userId] = radar;
  writeAll(all);
  return radar;
}

export function removeProduct(userId: string, productId: string): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  const now = Date.now();
  // La baja debe ser igual o posterior al último cambio del producto para que la sync la respete.
  const touched = Math.max(
    0,
    ...radar.projects.flatMap((project) => project.products.filter((p) => p.id === productId).map(touchedAt)),
  );
  for (const project of radar.projects) {
    project.products = project.products.filter((p) => p.id !== productId);
  }
  radar.removedProducts = mergeTombstones(
    cleanTombstones(radar.removedProducts, now),
    { [productId.slice(0, 200)]: Math.min(Math.max(now, touched + 1), now + DAY_MS) },
    now,
    PRODUCT_TOMBSTONE_TTL_MS,
    PRODUCT_TOMBSTONE_MAX,
  );
  all[userId] = radar;
  writeAll(all);
  return radar;
}

export interface ProductAlertPatch {
  targetPrice?: number;
  notifyPriceDrop?: boolean;
  notifyStock?: boolean;
  /** true → elimina la alerta (precio objetivo y avisos). */
  clear?: boolean;
}

/**
 * Configura la alerta de precio de un producto del radar (precio objetivo +
 * avisos). Al fijar objetivo por primera vez se captura `initialPrice` como
 * base de comparación; cambiar el objetivo rearma la alerta si estaba
 * disparada. Devuelve el radar actualizado, o null si el producto no existe.
 */
export function updateProductAlert(userId: string, productId: string, patch: ProductAlertPatch): RadarData | null {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  let target: SavedProduct | null = null;
  for (const project of radar.projects) {
    const found = project.products.find((p) => p.id === productId);
    if (found) {
      target = found;
      break;
    }
  }
  if (!target) return null;

  if (patch.clear) {
    delete target.targetPrice;
    delete target.priceAlert;
    target.notifyPriceDrop = false;
    target.notifyStock = false;
    all[userId] = radar;
    writeAll(all);
    return radar;
  }

  if (patch.targetPrice !== undefined) {
    const value = Number(patch.targetPrice);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('El precio objetivo no es válido.');
    }
    const rounded = Math.round(value * 100) / 100;
    if (target.targetPrice !== rounded) {
      target.targetPrice = rounded;
      // Rearma si estaba disparada con otro objetivo.
      if (target.priceAlert?.status === 'triggered') {
        target.priceAlert = { status: 'armed' };
      }
    }
    if (target.initialPrice === undefined) {
      target.initialPrice =
        typeof target.priceValue === 'number' && Number.isFinite(target.priceValue)
          ? target.priceValue
          : rounded;
    }
    target.notifyPriceDrop = patch.notifyPriceDrop !== false;
    if (!target.priceAlert) target.priceAlert = { status: 'armed' };
  }
  if (patch.targetPrice === undefined) {
    if (patch.notifyPriceDrop !== undefined) target.notifyPriceDrop = patch.notifyPriceDrop;
  }
  if (patch.notifyStock !== undefined) target.notifyStock = patch.notifyStock;

  all[userId] = radar;
  writeAll(all);
  return radar;
}

/* --------------------------------------------- vigilancia de precios (worker) */

export interface PriceWatchItem {
  userId: string;
  product: SavedProduct;
}

/**
 * Recorre todos los radares y devuelve los productos vigilados: con precio
 * objetivo activo (sin disparar aún) o con aviso de stock. Usa el fichero en
 * crudo para no normalizar todo el dataset en cada tick.
 */
export function collectPriceWatchItems(): PriceWatchItem[] {
  const all = readAll();
  const items: PriceWatchItem[] = [];
  for (const [userId, radar] of Object.entries(all)) {
    if (!radar || !Array.isArray(radar.projects)) continue;
    for (const project of radar.projects) {
      for (const product of Array.isArray(project.products) ? project.products : []) {
        if (!product || typeof product.id !== 'string' || !product.id) continue;
        const hasPriceAlert =
          typeof product.targetPrice === 'number' &&
          product.targetPrice > 0 &&
          product.notifyPriceDrop !== false &&
          product.priceAlert?.status !== 'triggered';
        const hasStockAlert = product.notifyStock === true;
        if (hasPriceAlert || hasStockAlert) items.push({ userId, product });
      }
    }
  }
  return items;
}

/** Actualiza el estado observado por el worker (último precio/stock, disparo). */
export function markPriceCheck(
  userId: string,
  productId: string,
  check: {
    lastPrice?: number;
    lastInStock?: boolean;
    triggered?: boolean;
  },
): void {
  const all = readAll();
  const radar = all[userId];
  if (!radar || !Array.isArray(radar.projects)) return;
  const nowIso = new Date().toISOString();
  for (const project of radar.projects) {
    const product = project.products.find((p) => p.id === productId);
    if (!product) continue;
    const alert = product.priceAlert ?? { status: 'armed' as const };
    if (check.lastPrice !== undefined) alert.lastPrice = check.lastPrice;
    if (check.lastInStock !== undefined) alert.lastInStock = check.lastInStock;
    alert.lastCheckedAt = nowIso;
    if (check.triggered) {
      alert.status = 'triggered';
      alert.triggeredAt = nowIso;
    }
    product.priceAlert = alert;
    all[userId] = radar;
    writeAll(all);
    return;
  }
}

/** Crea una carpeta nueva; id = slug corto aleatorio. */
export function createProject(userId: string, name: string, description?: string): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  const cleanName = String(name ?? '').trim().slice(0, 60);
  if (!cleanName) return radar;
  const id = `${cleanName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 30) || 'lista'}-${randomBytes(3).toString('hex')}`;
  radar.projects.push({
    id,
    name: cleanName,
    description: String(description ?? '').trim().slice(0, 200) || undefined,
    products: [],
  });
  all[userId] = radar;
  writeAll(all);
  return radar;
}

export function deleteProject(userId: string, projectId: string): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  if (projectId === DEFAULT_PROJECT.id) return radar; // General no se borra
  const removed = radar.projects.find((p) => p.id === projectId);
  radar.projects = radar.projects.filter((p) => p.id !== projectId);
  // Los productos huérfanos vuelven a General (con la fecha del cambio, para que la sync lo respete).
  const general = radar.projects.find((p) => p.id === DEFAULT_PROJECT.id);
  if (removed && general) {
    const movedAt = new Date().toISOString();
    general.products = mergeProducts(
      removed.products.map((product) => ({ ...product, movedAt })),
      general.products,
    );
  }
  const now = Date.now();
  radar.removedProjects = mergeTombstones(
    cleanTombstones(radar.removedProjects, now),
    { [projectId.slice(0, 200)]: now },
    now,
    PROJECT_TOMBSTONE_TTL_MS,
    PROJECT_TOMBSTONE_MAX,
  );
  all[userId] = radar;
  writeAll(all);
  return radar;
}

/** Registra una salida directa (.exit-cta) para el Return Flow. */
export function trackExit(userId: string, productId: string, title: string): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  radar.pendingExits = [
    { productId, title: String(title ?? '').slice(0, 200), timestamp: Date.now(), status: 'pending' },
    ...radar.pendingExits.filter((e) => e.productId !== productId),
  ].slice(0, 50);
  all[userId] = radar;
  writeAll(all);
  return radar;
}

/** Resuelve una salida del Return Flow (comprada / descartada). */
export function resolveExit(userId: string, productId: string, status: 'purchased' | 'dismissed'): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  radar.pendingExits = radar.pendingExits.map((e) =>
    e.productId === productId ? { ...e, status } : e,
  );
  all[userId] = radar;
  writeAll(all);
  return radar;
}

/* --------------------------------------------------------- avisos/reminders */

export interface ReminderInput {
  productId: string;
  title: string;
  remindAt: number;
  reason: string;
  reasonNote?: string;
}

/**
 * Crea el aviso de un producto. Un solo aviso activo por producto: si ya
 * existe uno 'scheduled', se reprograma en el sitio (no se duplica).
 */
export function setReminder(userId: string, input: ReminderInput): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  const reminders = Array.isArray(radar.reminders) ? radar.reminders : [];

  const productId = String(input.productId ?? '').slice(0, 200);
  const clean: Reminder = {
    id: `rem-${randomBytes(10).toString('hex')}`,
    productId,
    title: String(input.title ?? '').slice(0, 200),
    remindAt: Math.max(0, Number(input.remindAt) || 0),
    reason: String(input.reason ?? '').slice(0, 80),
    reasonNote: String(input.reasonNote ?? '').trim().slice(0, 300) || undefined,
    status: 'scheduled',
    createdAt: Date.now(),
    attempts: 0,
  };

  const existingIdx = reminders.findIndex((r) => r.productId === productId && r.status === 'scheduled');
  if (existingIdx >= 0) {
    reminders[existingIdx] = { ...reminders[existingIdx], ...clean, id: reminders[existingIdx].id, createdAt: reminders[existingIdx].createdAt };
  } else {
    reminders.unshift(clean);
  }

  radar.reminders = reminders
    .filter((r) => r.id && r.productId)
    .sort((a, b) => a.remindAt - b.remindAt)
    .slice(0, 50);
  all[userId] = radar;
  writeAll(all);
  return radar;
}

/** Cancela un aviso (no se borra el registro: deja de intentar enviarlo). */
export function cancelReminder(userId: string, reminderId: string): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  radar.reminders = (radar.reminders ?? []).map((r) =>
    r.id === reminderId ? { ...r, status: 'cancelled' } : r,
  );
  all[userId] = radar;
  writeAll(all);
  return radar;
}

/** Aviso activo ('scheduled') de un producto, si existe. */
export function getScheduledReminder(userId: string, productId: string): Reminder | null {
  const radar = getRadar(userId);
  return radar.reminders?.find((r) => r.productId === productId && r.status === 'scheduled') ?? null;
}

/**
 * Reclama (status → 'sending') todos los avisos vencidos de todos los usuarios
 * y los devuelve. El reclamo escribe en disco: si el proceso se reinicia a
 * medias, en el siguiente tick esos avisos vuelven a quedar como vencidos
 * únicamente si el envío no se completó (se marcan 'sent' al terminar).
 */
export function claimDueReminders(now = Date.now()): Array<{ userId: string; reminder: Reminder }> {
  const all = readAll();
  const claimed: Array<{ userId: string; reminder: Reminder }> = [];

  for (const [userId, radar] of Object.entries(all)) {
    const reminders = Array.isArray(radar.reminders) ? radar.reminders : [];
    let dirty = false;
    for (const reminder of reminders) {
      if (reminder.status === 'scheduled' && reminder.remindAt <= now) {
        reminder.status = 'sending';
        reminder.attempts = (reminder.attempts ?? 0) + 1;
        dirty = true;
        claimed.push({ userId, reminder: { ...reminder } });
      }
    }
    if (dirty) all[userId] = radar;
  }

  if (claimed.length > 0) writeAll(all);
  return claimed;
}

/** Marca el resultado de un envío (sent / failed con reintento). */
export function finishReminder(
  userId: string,
  reminderId: string,
  patch: Pick<Reminder, 'status'> & Partial<Pick<Reminder, 'sentAt' | 'lastError' | 'attempts'>>,
): void {
  const all = readAll();
  const radar = all[userId];
  if (!radar || !Array.isArray(radar.reminders)) return;
  radar.reminders = radar.reminders.map((r) => (r.id === reminderId ? { ...r, ...patch } : r));
  all[userId] = radar;
  writeAll(all);
}

/** Reprograma la fecha de un aviso (usado por el dispatcher al fallar el envío). */
export function deferReminder(userId: string, reminderId: string, remindAt: number): void {
  const all = readAll();
  const radar = all[userId];
  if (!radar || !Array.isArray(radar.reminders)) return;
  radar.reminders = radar.reminders.map((r) =>
    r.id === reminderId ? { ...r, remindAt: Math.max(0, Number(remindAt) || r.remindAt) } : r,
  );
  all[userId] = radar;
  writeAll(all);
}

/** Elimina todos los datos del radar asociados al usuario. */
export function deleteRadar(userId: string): void {
  const all = readAll();
  delete all[userId];
  writeAll(all);
}
