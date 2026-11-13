/**
 * ==============================================================================
 * TREIDILOR — API DE AUTOMATIZACIÓN (etapa 2.2): clientes, tokens, alcances, límites y auditoría
 * ==============================================================================
 * Para que los agentes (n8n) lean datos SIN recibir nunca `TRADYLOR_API_TOKEN`.
 *
 *  · DESACTIVADA por defecto: sólo existe con `AUTOMATION_API_ENABLED=true` (sin ella todas las rutas responden 404).
 *  · Un cliente por integración, con token PROPIO `tai_<id>_<secreto>` (el secreto se muestra una sola vez; en disco sólo su huella
 *    HMAC/SHA-256 con sal). Caducidad obligatoria (máx. 90 días) y revocación inmediata. El token general NO sirve aquí y estos tokens
 *    no sirven en ninguna otra API.
 *  · Alcances mínimos y CERRADOS: hoy sólo `catalog:read`. No existe ningún alcance de escritura: no hay endpoint que lo acepte.
 *  · Límites: peticiones por minuto y por día, por cliente; bloqueo temporal por IP tras intentos fallidos.
 *  · Auditoría de sólo añadir (`automation-audit.jsonl`): quién, qué, resultado. Nunca registra tokens ni IP en claro.
 *  · Almacenamiento: `automation-clients.json` en el volumen (escritura atómica + .bak). Un archivo ilegible NO se sobrescribe y
 *    la autenticación falla cerrada.
 * ==============================================================================
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { dataFile } from './paths';
import { createRateLimiter, type RateLimiter } from './rateLimit';
import { resolveClientIp } from './clientIp';

export const AUTOMATION_SCOPES = ['catalog:read'] as const;
export type AutomationScope = (typeof AUTOMATION_SCOPES)[number];

export const MAX_CLIENTS = 20;
export const DEFAULT_TTL_DAYS = 30;
export const MAX_TTL_DAYS = 90;
export const DEFAULT_RATE_PER_MINUTE = 30;
export const MAX_RATE_PER_MINUTE = 120;
export const DEFAULT_DAILY_QUOTA = 2000;
export const MAX_DAILY_QUOTA = 20000;
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;
const TOKEN_RE = /^tai_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

export interface AutomationClient {
  id: string;
  name: string;
  scopes: AutomationScope[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  ratePerMinute: number;
  dailyQuota: number;
  salt: string;
  secretHash: string;
}

/** Vista pública de un cliente (sin sal ni huella). */
export type PublicClient = Omit<AutomationClient, 'salt' | 'secretHash'> & { status: 'activo' | 'revocado' | 'caducado' };

interface StoreDoc {
  schemaVersion: 1;
  clients: AutomationClient[];
}
type Read = { status: 'ok'; doc: StoreDoc } | { status: 'corrupt'; error: string };

export function automationEnabled(): boolean {
  return process.env.AUTOMATION_API_ENABLED === 'true';
}

const storePath = () => dataFile('automation-clients.json');
const auditPath = () => dataFile('automation-audit.jsonl');

/* ───────────────────────── Almacén ───────────────────────── */

function validClient(c: any): c is AutomationClient {
  return (
    c && typeof c === 'object' &&
    /^[0-9a-f]{16}$/.test(String(c.id)) &&
    typeof c.name === 'string' && c.name.length >= 1 && c.name.length <= 80 &&
    Array.isArray(c.scopes) && c.scopes.every((s: unknown) => (AUTOMATION_SCOPES as readonly string[]).includes(String(s))) &&
    !Number.isNaN(Date.parse(c.createdAt)) && !Number.isNaN(Date.parse(c.expiresAt)) &&
    (c.revokedAt === null || !Number.isNaN(Date.parse(c.revokedAt))) &&
    Number.isInteger(c.ratePerMinute) && c.ratePerMinute >= 1 && c.ratePerMinute <= MAX_RATE_PER_MINUTE &&
    Number.isInteger(c.dailyQuota) && c.dailyQuota >= 1 && c.dailyQuota <= MAX_DAILY_QUOTA &&
    /^[0-9a-f]{32}$/.test(String(c.salt)) && /^[0-9a-f]{64}$/.test(String(c.secretHash))
  );
}

export function readStore(): Read {
  const file = storePath();
  if (!fs.existsSync(file)) return { status: 'ok', doc: { schemaVersion: 1, clients: [] } };
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || doc.schemaVersion !== 1 || !Array.isArray(doc.clients)) return { status: 'corrupt', error: 'esquema no reconocido' };
    if (!doc.clients.every(validClient)) return { status: 'corrupt', error: 'cliente no válido' };
    return { status: 'ok', doc };
  } catch (e) {
    return { status: 'corrupt', error: e instanceof Error ? e.message.slice(0, 120) : 'ilegible' };
  }
}

function writeStore(doc: StoreDoc): void {
  const file = storePath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.renameSync(tmp, file);
}

const hashSecret = (salt: string, secret: string) => crypto.createHash('sha256').update(salt).update(':').update(secret).digest('hex');

function statusOf(c: AutomationClient, now = Date.now()): PublicClient['status'] {
  if (c.revokedAt) return 'revocado';
  return Date.parse(c.expiresAt) <= now ? 'caducado' : 'activo';
}
const publicView = (c: AutomationClient): PublicClient => {
  const { salt: _s, secretHash: _h, ...rest } = c;
  return { ...rest, status: statusOf(c) };
};

export type Fail = { ok: false; status: number; code: string; message: string };
const fail = (status: number, code: string, message: string): Fail => ({ ok: false, status, code, message });

export interface CreateInput {
  name?: unknown;
  scopes?: unknown;
  ttlDays?: unknown;
  ratePerMinute?: unknown;
  dailyQuota?: unknown;
}

/** Crea un cliente. Devuelve el token EN CLARO una sola vez. */
export function createClient(input: CreateInput, now = new Date()): { ok: true; client: PublicClient; token: string } | Fail {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001f<>]/.test(name)) return fail(400, 'nombre_no_valido', 'El nombre debe tener entre 1 y 80 caracteres, sin símbolos de marcado.');
  const scopes = Array.isArray(input.scopes) ? [...new Set(input.scopes.map(String))] : [];
  if (!scopes.length) return fail(400, 'alcances_obligatorios', 'Indica al menos un alcance.');
  const unknown = scopes.filter((s) => !(AUTOMATION_SCOPES as readonly string[]).includes(s));
  if (unknown.length) return fail(400, 'alcance_no_existe', `Alcance(s) inexistente(s): ${unknown.join(', ')}. Alcances disponibles: ${AUTOMATION_SCOPES.join(', ')}.`);
  const ttl = input.ttlDays === undefined ? DEFAULT_TTL_DAYS : Number(input.ttlDays);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_DAYS) return fail(400, 'caducidad_no_valida', `La caducidad debe ser de 1 a ${MAX_TTL_DAYS} días.`);
  const rate = input.ratePerMinute === undefined ? DEFAULT_RATE_PER_MINUTE : Number(input.ratePerMinute);
  if (!Number.isInteger(rate) || rate < 1 || rate > MAX_RATE_PER_MINUTE) return fail(400, 'limite_no_valido', `El límite por minuto debe ser de 1 a ${MAX_RATE_PER_MINUTE}.`);
  const quota = input.dailyQuota === undefined ? DEFAULT_DAILY_QUOTA : Number(input.dailyQuota);
  if (!Number.isInteger(quota) || quota < 1 || quota > MAX_DAILY_QUOTA) return fail(400, 'cuota_no_valida', `La cuota diaria debe ser de 1 a ${MAX_DAILY_QUOTA}.`);

  const read = readStore();
  if (read.status !== 'ok') return fail(423, 'almacen_ilegible', 'El archivo de clientes está dañado y no se sobrescribe. Revísalo antes de crear clientes.');
  if (read.doc.clients.filter((c) => statusOf(c) === 'activo').length >= MAX_CLIENTS) return fail(409, 'limite_clientes', `Máximo ${MAX_CLIENTS} clientes activos. Revoca alguno.`);

  const id = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const client: AutomationClient = {
    id,
    name,
    scopes: scopes as AutomationScope[],
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 86400000).toISOString(),
    revokedAt: null,
    ratePerMinute: rate,
    dailyQuota: quota,
    salt,
    secretHash: hashSecret(salt, secret),
  };
  writeStore({ schemaVersion: 1, clients: [...read.doc.clients, client] });
  audit({ event: 'cliente_creado', clientId: id, detail: `scopes=${scopes.join(',')} ttl=${ttl}d` });
  return { ok: true, client: publicView(client), token: `tai_${id}_${secret}` };
}

export function revokeClient(id: string, now = new Date()): { ok: true; client: PublicClient } | Fail {
  const read = readStore();
  if (read.status !== 'ok') return fail(423, 'almacen_ilegible', 'El archivo de clientes está dañado y no se sobrescribe.');
  const c = read.doc.clients.find((x) => x.id === id);
  if (!c) return fail(404, 'cliente_no_existe', 'Cliente inexistente.');
  if (!c.revokedAt) {
    c.revokedAt = now.toISOString();
    writeStore(read.doc);
    audit({ event: 'cliente_revocado', clientId: id });
  }
  return { ok: true, client: publicView(c) };
}

export function listClients(): { status: 'ok'; clients: PublicClient[] } | { status: 'corrupt'; error: string } {
  const read = readStore();
  return read.status === 'ok' ? { status: 'ok', clients: read.doc.clients.map(publicView) } : read;
}

/* ───────────────────────── Auditoría ───────────────────────── */

export interface AuditEntry {
  event: string;
  clientId?: string | null;
  scope?: string;
  method?: string;
  path?: string;
  query?: string;
  status?: number;
  reason?: string;
  items?: number;
  ip?: string;
  detail?: string;
}

const ipHash = (ip: string) => crypto.createHash('sha256').update(`tai-ip:${ip}`).digest('hex').slice(0, 12);

/** Añade una línea al registro de auditoría. Nunca lanza (la auditoría no puede tumbar la petición) ni registra tokens ni IP en claro. */
export function audit(entry: AuditEntry): void {
  try {
    const { ip, ...rest } = entry;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...rest, ...(ip ? { ip: ipHash(ip) } : {}) });
    const file = auditPath();
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > AUDIT_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* rotación opcional */
    }
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    /* sin auditoría disponible: no se interrumpe el servicio */
  }
}

/**
 * Denegaciones (401/403/429): con tope por minuto para que una inundación de peticiones sin token no llene la auditoría ni expulse el historial
 * legítimo (rota a 2 MiB con una sola copia). Pasado el tope se cuentan y, al cambiar de ventana, se escribe UNA línea `denegados_suprimidos`.
 * Las peticiones correctas y las altas/revocaciones se registran siempre.
 */
const DENIAL_AUDIT_PER_MINUTE = 10;
const denialWindow = { start: 0, written: 0, suppressed: 0 };
function auditDenial(entry: AuditEntry, now = Date.now()): void {
  if (now - denialWindow.start >= 60000) {
    if (denialWindow.suppressed > 0) audit({ event: 'denegados_suprimidos', detail: `n=${denialWindow.suppressed}` });
    denialWindow.start = now;
    denialWindow.written = 0;
    denialWindow.suppressed = 0;
  }
  if (denialWindow.written >= DENIAL_AUDIT_PER_MINUTE) {
    denialWindow.suppressed += 1;
    return;
  }
  denialWindow.written += 1;
  audit(entry);
}

export function readAudit(limit = 100): Array<Record<string, unknown>> {
  try {
    const lines = fs.readFileSync(auditPath(), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.min(Math.max(limit, 1), 500)).map((l) => JSON.parse(l)).reverse();
  } catch {
    return [];
  }
}

/* ───────────────────────── Autenticación y límites ───────────────────────── */

const perClient = new Map<string, RateLimiter>();
const daily = new Map<string, number>();
const failures = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILS_PER_MINUTE = 20;

export function resetAutomationLimits(): void {
  perClient.clear();
  daily.clear();
  failures.clear();
  denialWindow.start = 0;
  denialWindow.written = 0;
  denialWindow.suppressed = 0;
}

const blockedIp = (ip: string, now: number) => {
  const f = failures.get(ip);
  return Boolean(f && f.resetAt > now && f.count >= MAX_FAILS_PER_MINUTE);
};
function noteFailure(ip: string, now: number): void {
  if (failures.size > 5000) failures.clear();
  const f = failures.get(ip);
  if (!f || f.resetAt <= now) failures.set(ip, { count: 1, resetAt: now + 60000 });
  else f.count += 1;
}

/** IP del cliente (modo estricto: no se confía en la cabecera de proxy salvo con `TRUSTED_PROXY_HOPS`; ver `clientIp.ts`). */
export function clientIpOf(request: Request): string {
  return resolveClientIp(request, 'strict').ip;
}

export type AuthResult = { ok: true; client: AutomationClient } | (Fail & { retryAfter?: number; clientId?: string | null; reason: string });

/**
 * Comprueba la API desactivada → 404; token → 401; alcance → 403; límites → 429. Registra el resultado en la auditoría.
 * El bloqueo temporal por IP sólo afecta a quien NO presenta un token válido: un cliente con token válido nunca queda bloqueado por los fallos
 * de otros (aunque falseen su IP). Sus límites son los de su propio token (por minuto y por día).
 */
export function authenticate(request: Request, scope: AutomationScope, now = Date.now()): AuthResult {
  const ip = clientIpOf(request);
  const result = (status: number, code: string, message: string, reason: string, clientId: string | null, retryAfter?: number): AuthResult => {
    auditDenial({ event: status === 429 ? 'limite' : 'denegado', clientId, scope, method: request.method, path: new URL(request.url).pathname, status, reason, ip }, now);
    return { ok: false, status, code, message, reason, clientId, ...(retryAfter ? { retryAfter } : {}) };
  };
  /** Fallo de AUTENTICACIÓN (token ausente, inválido, revocado o caducado): cuenta contra la IP y, superado el umbral, responde 429. */
  const unauthenticated = (reason: string, clientId: string | null = null): AuthResult => {
    if (blockedIp(ip, now)) return result(429, 'demasiados_intentos', 'Demasiados intentos fallidos. Espera un minuto.', 'ip_bloqueada', clientId, 60);
    noteFailure(ip, now);
    return result(401, 'no_autorizado', 'Token ausente o inválido.', reason, clientId);
  };

  const header = request.headers.get('authorization') ?? '';
  const m = header.match(/^Bearer\s+(\S+)$/i);
  const parsed = m ? TOKEN_RE.exec(m[1]) : null;
  const read = readStore();
  if (!parsed || read.status !== 'ok') {
    if (read.status !== 'ok') return unauthenticated('almacen_ilegible');
    // Trabajo equivalente para no revelar por tiempo si el formato era válido.
    hashSecret('0'.repeat(32), m?.[1] ?? '');
    return unauthenticated(m ? 'formato_invalido' : 'sin_token');
  }
  const [, id, secret] = parsed;
  const client = read.doc.clients.find((c) => c.id === id);
  const expected = Buffer.from(client?.secretHash ?? '0'.repeat(64), 'hex');
  const given = Buffer.from(hashSecret(client?.salt ?? '0'.repeat(32), secret), 'hex');
  if (!client || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return unauthenticated('token_incorrecto');
  if (client.revokedAt) return unauthenticated('revocado', client.id);
  if (Date.parse(client.expiresAt) <= now) return unauthenticated('caducado', client.id);
  // A partir de aquí el token es AUTÉNTICO y está vigente: ni el bloqueo por IP ni los fallos de otros le afectan.
  if (!client.scopes.includes(scope)) return result(403, 'alcance_insuficiente', `El token no tiene el alcance «${scope}».`, 'alcance', client.id);

  let limiter = perClient.get(client.id);
  if (!limiter) {
    limiter = createRateLimiter(client.ratePerMinute, 60000);
    perClient.set(client.id, limiter);
  }
  if (!limiter.hit(client.id)) return result(429, 'limite_por_minuto', 'Límite de peticiones por minuto superado.', 'limite_minuto', client.id, 60);
  const day = `${client.id}:${new Date(now).toISOString().slice(0, 10)}`;
  const used = (daily.get(day) ?? 0) + 1;
  if (daily.size > 500) daily.clear();
  daily.set(day, used);
  if (used > client.dailyQuota) return result(429, 'cuota_diaria', 'Cuota diaria superada.', 'limite_dia', client.id, 3600);
  return { ok: true, client };
}

/* ───────────────────────── Respuestas ───────────────────────── */

export const automationHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function automationJson(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...automationHeaders, ...extra } });
}

/** Respuesta de error de `authenticate` (el 401 lleva `WWW-Authenticate`; el 429, `Retry-After`). Mensajes genéricos. */
export function authFailureResponse(r: Extract<AuthResult, { ok: false }>): Response {
  const extra: Record<string, string> = {};
  if (r.status === 401) extra['WWW-Authenticate'] = 'Bearer realm="treidilor-automation"';
  if (r.retryAfter) extra['Retry-After'] = String(r.retryAfter);
  return automationJson(r.status, { success: false, code: r.code, message: r.message }, extra);
}

/** Respuesta común cuando la API está desactivada: indistinguible de una ruta inexistente. */
export const disabledResponse = (): Response => new Response(JSON.stringify({ success: false, code: 'no_encontrado' }), { status: 404, headers: automationHeaders });
