/**
 * ==============================================================================
 * TRADYLOR — ANALITICA REAL DE PRODUCTOS
 * ==============================================================================
 * Registro y persistencia de visitas y eventos de interaccion (clics y
 * conversiones) por producto, con escritura en segundo plano:
 *
 *   - trackProductVisit(): la llama el middleware en cada ficha de producto.
 *   - trackEvent():        la llaman los endpoints (/api/analytics/event y
 *                          /api/redirect) y cualquier beacon de cliente.
 *
 * Modelo no bloqueante: registrar un evento SÓLO actualiza una cola en
 * memoria (O(1), sin I/O); la persistencia en analytics.json se hace de
 * forma diferida (debounce ~750 ms), atomica (tmp + rename) y con el timer
 * "unref" para no mantener vivo el proceso. El formato del fichero sigue
 * siendo un array de eventos (maximo 10.000) compatible con el historial
 * existente.
 * ==============================================================================
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { DATA_DIR, dataFile } from './paths';

/** Tipos de evento admitidos (compatibles con los beacons de Layout.astro). */
export type TipoEvento =
  | 'page_view'
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
  createdAt: string;
}

const ANALYTICS_PATH = dataFile('analytics.json');
const MAX_EVENTS = 10_000;
const FLUSH_DELAY_MS = 750;

let cache: AnalyticsEvent[] | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let flushing = false;

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
): void {
  try {
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
export function trackProductVisit(productId: string, pathname: string): void {
  trackEvent({ type: 'page_view', productId, path: pathname, source: 'middleware' });
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
