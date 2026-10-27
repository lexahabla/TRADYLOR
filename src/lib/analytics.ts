/**
 * ==============================================================================
 * TRADYLOR — ANALITICA REAL
 * ==============================================================================
 * Registro y persistencia de visitas y eventos de interacción con contexto de
 * sesión (sessionId / visitorId / referrer / duración), con escritura en
 * segundo plano:
 *
 *   - trackProductVisit(): la llama el middleware en cada ficha de producto.
 *   - trackEvent():        la llaman los endpoints (/api/analytics/event y
 *                          /api/redirect) y los beacons de cliente.
 *
 * Modelo no bloqueante: registrar un evento SÓLO actualiza una cola en
 * memoria (O(1), sin I/O); la persistencia en analytics.json se hace de
 * forma diferida (debounce ~750 ms), atómica (tmp + rename) y con el timer
 * "unref" para no mantener vivo el proceso.
 *
 * La IP nunca se guarda: se usa SÓLO en el momento del registro para
 * descartar las IPs de trabajo definidas en ANALYTICS_IGNORE_IPS (por
 * defecto el ordenador de desarrollo).
 * ==============================================================================
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { DATA_DIR, dataFile } from './paths';
import { readJsonArrayFile, writeJsonArrayFile } from './jsonStore';

/** Tipos de evento admitidos (compatibles con los beacons de Layout.astro). */
export type TipoEvento =
  | 'page_view'
  | 'page_duration'
  | 'product_click'
  | 'cart_add'
  | 'outbound_click'
  | 'purchase'
  | 'contact_click';

export interface AnalyticsEvent {
  type: TipoEvento;
  /** id de producto en el catálogo (en las fichas coincide con el slug de URL). */
  productId?: string;
  path?: string;
  /** Quién registró el evento (informativo). */
  source?: 'middleware' | 'api' | 'redirect' | 'cliente';
  /** Identificador de sesión de navegador (sessionStorage). */
  sessionId?: string;
  /** Identificador persistente de navegador (localStorage). */
  visitorId?: string;
  /** Referente que trajo la visita (document.referrer). */
  referrer?: string;
  /** Red de afiliación en las salidas (.exit-cta): amazon, aliexpress, awin… */
  network?: string;
  /** Milisegundos de permanencia en la página (evento page_duration). */
  durationMs?: number;
  /** Importe del pedido cuando el beacon de compra lo incluye. */
  amount?: number;
  createdAt: string;
}

const ANALYTICS_PATH = dataFile('analytics.json');
const IGNORED_IPS_PATH = dataFile('analytics-ignored-ips.json');
const MAX_EVENTS = 10_000;
const FLUSH_DELAY_MS = 750;

/** IPs que no se contabilizan (ordenador de desarrollo) si no se configura nada más. */
const DEFAULT_IGNORED_IPS = ['26.95.41.235'];

let cache: AnalyticsEvent[] | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let flushing = false;
const flushListeners: Array<() => void> = [];

/**
 * IPs excluidas añadidas desde el panel (persistidas en disco, sobreviven a
 * un redeploy porque viven en el volumen de datos). Se cachean en memoria
 * para que comprobar una IP en `trackEvent` siga siendo O(1) sin tocar el
 * disco en el camino caliente; `addIgnoredIp`/`removeIgnoredIp` actualizan
 * el caché a la vez que escriben el fichero.
 */
let ignoredIpsFileCache: string[] | null = null;

function loadIgnoredIpsFile(): string[] {
  if (ignoredIpsFileCache) return ignoredIpsFileCache;
  const raw = readJsonArrayFile<unknown>(IGNORED_IPS_PATH);
  ignoredIpsFileCache = raw.filter((ip): ip is string => typeof ip === 'string' && ip.trim() !== '');
  return ignoredIpsFileCache;
}

/**
 * Normaliza una IP para compararla de forma fiable: recorta espacios y quita
 * el prefijo IPv4-mapped-IPv6 (`::ffff:1.2.3.4` -> `1.2.3.4`) que algunos
 * proxys anteponen y que antes hacía fallar la comparación exacta.
 */
export function normalizeIp(ip: string | undefined | null): string | undefined {
  if (!ip) return undefined;
  let value = ip.trim();
  if (value.toLowerCase().startsWith('::ffff:')) value = value.slice(7);
  return value || undefined;
}

/** IPs ignoradas de la variable de entorno y de las añadidas desde el panel, sin duplicados. */
export function getIgnoredIpSources(): { env: string[]; file: string[] } {
  const raw = process.env.ANALYTICS_IGNORE_IPS ?? '';
  const env = raw
    .split(',')
    .map((ip) => normalizeIp(ip))
    .filter((ip): ip is string => Boolean(ip));
  const file = loadIgnoredIpsFile()
    .map((ip) => normalizeIp(ip))
    .filter((ip): ip is string => Boolean(ip));
  return { env, file };
}

/** Lista combinada (env + panel) de IPs que no se contabilizan en la medición. */
export function getIgnoredIps(): string[] {
  const { env, file } = getIgnoredIpSources();
  const combined = Array.from(new Set([...env, ...file]));
  return combined.length ? combined : DEFAULT_IGNORED_IPS;
}

/** Añade una IP a la lista persistida (panel de administración). Idempotente. */
export function addIgnoredIp(ip: string): string[] {
  const normalized = normalizeIp(ip);
  const current = loadIgnoredIpsFile();
  if (!normalized || current.includes(normalized)) return current;
  const updated = [...current, normalized];
  ignoredIpsFileCache = updated;
  writeJsonArrayFile(IGNORED_IPS_PATH, updated);
  return updated;
}

/** Quita una IP de la lista persistida (no afecta a las fijadas por variable de entorno). */
export function removeIgnoredIp(ip: string): string[] {
  const normalized = normalizeIp(ip);
  const updated = loadIgnoredIpsFile().filter((existing) => existing !== normalized);
  ignoredIpsFileCache = updated;
  writeJsonArrayFile(IGNORED_IPS_PATH, updated);
  return updated;
}

/** Extrae la IP del cliente (proxy reverso primero), ya normalizada. */
export function clientIpFrom(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(
    request.headers.get('x-real-ip')?.trim() || request.headers.get('cf-connecting-ip')?.trim() || undefined,
  );
}

/** ¿Hay que descartar esta IP (ordenador de desarrollo / red interna)? */
export function isIgnoredIp(ip: string | undefined): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  return getIgnoredIps().includes(normalized);
}

/** Registra un callback que se ejecuta tras cada persistencia (p.ej. agregados mensuales). */
export function onAnalyticsFlush(listener: () => void): void {
  flushListeners.push(listener);
}

/** Carga (una sola vez) el historial de analytics.json en memoria. */
function load(): AnalyticsEvent[] {
  if (cache) return cache;
  try {
    if (fs.existsSync(ANALYTICS_PATH)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(ANALYTICS_PATH, 'utf-8'));
      if (Array.isArray(parsed)) {
        cache = parsed.filter(
          (event): event is AnalyticsEvent =>
            Boolean(event) && typeof (event as AnalyticsEvent).type === 'string',
        );
      }
    }
  } catch (error) {
    console.warn('[Analytics] No se pudo leer analytics.json, se empieza de cero:', error);
  }
  cache ??= [];
  return cache;
}

/**
 * Registra un evento en la cola en memoria y programa su persistencia.
 * Nunca lanza y no realiza E/S en el camino caliente: es seguro llamarlo
 * desde middleware o endpoints sin bloquear la respuesta.
 */
export function trackEvent(
  event: Omit<AnalyticsEvent, 'createdAt'> & { createdAt?: string },
  options: { ip?: string } = {},
): void {
  try {
    if (isIgnoredIp(options.ip)) return; // IP de desarrollo: no se contabiliza
    const events = load();
    events.push({ ...event, createdAt: event.createdAt ?? new Date().toISOString() });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    dirty = true;
    scheduleFlush();
  } catch (error) {
    console.warn('[Analytics] Evento descartado:', error);
  }
}

/** Visita a una ficha de producto (la llama el middleware de Astro). */
export function trackProductVisit(productId: string, pathname: string, ip?: string): void {
  trackEvent({ type: 'page_view', productId, path: pathname, source: 'middleware' }, { ip });
}

/** Copia en memoria de todos los eventos (para el panel admin). */
export function getAnalyticsEvents(): AnalyticsEvent[] {
  return [...load()];
}

/** Métricas agregadas por producto (visitas y conversiones). */
export interface ProductoMetricas {
  productId: string;
  visitas: number;
  cartAdds: number;
  outboundClicks: number;
  purchases: number;
  contactClicks: number;
  ultimoEvento: string;
}

export function getProductAnalytics(): ProductoMetricas[] {
  const byProduct = new Map<string, ProductoMetricas>();
  for (const event of load()) {
    if (!event.productId) continue;
    let metrics = byProduct.get(event.productId);
    if (!metrics) {
      metrics = {
        productId: event.productId,
        visitas: 0,
        cartAdds: 0,
        outboundClicks: 0,
        purchases: 0,
        contactClicks: 0,
        ultimoEvento: event.createdAt,
      };
      byProduct.set(event.productId, metrics);
    }
    if (event.type === 'page_view') metrics.visitas += 1;
    else if (event.type === 'cart_add') metrics.cartAdds += 1;
    else if (event.type === 'outbound_click') metrics.outboundClicks += 1;
    else if (event.type === 'purchase') metrics.purchases += 1;
    else if (event.type === 'contact_click') metrics.contactClicks += 1;
    if (event.createdAt > metrics.ultimoEvento) metrics.ultimoEvento = event.createdAt;
  }
  return [...byProduct.values()].sort((a, b) => b.visitas - a.visitas);
}

/** Vacia por completo la medición (eventos en memoria y en disco). */
export function resetAnalytics(): void {
  cache = [];
  dirty = false;
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  try {
    fs.writeFileSync(ANALYTICS_PATH, JSON.stringify([], null, 2), 'utf-8');
  } catch (error) {
    console.warn('[Analytics] No se pudo vaciar analytics.json:', error);
  }
}

function scheduleFlush(): void {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void flushAnalytics();
  }, FLUSH_DELAY_MS);
  // No retener el proceso de Node sólo por la persistencia pendiente.
  pendingTimer.unref?.();
}

/** Persiste la cola en analytics.json de forma atómica (expuesto para tests). */
export async function flushAnalytics(): Promise<void> {
  if (!dirty || flushing) return;
  flushing = true;
  try {
    const snapshot = JSON.stringify(load(), null, 2);
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmpPath = `${ANALYTICS_PATH}.tmp`;
    await fsp.writeFile(tmpPath, snapshot, 'utf-8');
    await fsp.rename(tmpPath, ANALYTICS_PATH);
    dirty = false;
    for (const listener of flushListeners) {
      try {
        listener();
      } catch (error) {
        console.warn('[Analytics] Listener de persistencia falló:', error);
      }
    }
  } catch (error) {
    console.warn('[Analytics] No se pudo persistir analytics.json:', error);
  } finally {
    flushing = false;
    if (dirty) scheduleFlush();
  }
}

// Último recurso al cerrar el proceso: vuelca lo pendiente de forma síncrona.
process.on('exit', () => {
  if (!dirty) return;
  try {
    fs.writeFileSync(ANALYTICS_PATH, JSON.stringify(load(), null, 2), 'utf-8');
    dirty = false;
  } catch {
    // Mejor perder eventos que tumbar el cierre del proceso.
  }
});
