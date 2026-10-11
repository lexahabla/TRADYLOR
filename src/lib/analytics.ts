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
const MAX_EVENTS = 10_000;
const FLUSH_DELAY_MS = 750;

/** IPs que no se contabilizan (ordenador de desarrollo). */
const DEFAULT_IGNORED_IPS = ['26.95.41.235'];

let cache: AnalyticsEvent[] | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let flushing = false;
const flushListeners: Array<() => void> = [];

/** IPs ignoradas: variable ANALYTICS_IGNORE_IPS (coma) o la lista por defecto. */
export function getIgnoredIps(): string[] {
  const raw = process.env.ANALYTICS_IGNORE_IPS ?? '';
  const list = raw
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_IGNORED_IPS;
}

/** Extrae la IP del cliente (proxy reverso primero). */
export function clientIpFrom(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip')?.trim() || request.headers.get('cf-connecting-ip')?.trim() || undefined;
}

/** ¿Hay que descartar esta IP (ordenador de desarrollo / red interna)? */
export function isIgnoredIp(ip: string | undefined): boolean {
  if (!ip) return false;
  return getIgnoredIps().includes(ip);
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
