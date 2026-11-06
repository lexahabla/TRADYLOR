/**
 * ==============================================================================
 * TREIDILOR — OBSERVACIONES DE OFERTA Y SEÑAL PÚBLICA DE BAJADA (puro)
 * ==============================================================================
 * Una OBSERVACIÓN es una lectura verificada de una fuente para una oferta y un
 * contexto concreto (moneda, destino, vendedor, variante, estado, cantidad).
 *
 *  - `null` significa DESCONOCIDO; `0` es un valor real (envío gratis, 0 días).
 *  - Reintentos del mismo ciclo (`runId`) y lecturas idénticas del mismo día NO
 *    añaden filas: sólo renuevan `verifiedAt`.
 *  - La señal pública de bajada exige una lectura anterior COMPARABLE (mismo
 *    contexto) y un precio estrictamente menor. Una primera lectura, un
 *    descuento comercial declarado o una lectura sin cambio no la generan.
 *
 * Se guarda en `product.extra.observations` / `extra.priceSignal` (estructura
 * existente: el esquema ya deja pasar `extra`).
 * ==============================================================================
 */

export interface OfferContext {
  currency: string;
  /** País/zona de destino de la consulta (p. ej. 'ES'). */
  destination: string;
  merchantId?: string | null;
  variantId?: string | null;
  condition?: string | null;
  quantity?: number | null;
  /** Criterio de envío usado en el precio total ('standard', 'free-only', ...). */
  shippingCriterion?: string | null;
}

export interface OfferObservation {
  /** Cuándo se obtuvo la lectura (fecha de captura, NO de entrega). */
  capturedAt: string;
  /** Última vez que una lectura idéntica volvió a confirmarse. */
  verifiedAt: string;
  price: number;
  originalPrice: number | null;
  inStock: boolean | null;
  /** null = desconocido; 0 = gratis. */
  shippingCost: number | null;
  /** Ventana de entrega en días desde la captura; null = desconocido. */
  deliveryMinDays: number | null;
  deliveryMaxDays: number | null;
  context: OfferContext;
  contextKey: string;
  /** Fuente e identificador con los que repetir la consulta. */
  source: { type: string; id: string };
  /** Ciclo de actualización que la produjo (idempotencia ante reintentos). */
  runId: string;
}

export interface PriceSignal {
  offerKey: string;
  contextKey: string;
  previousPrice: number;
  price: number;
  currency: string;
  detectedAt: string;
  expiresAt: string;
  shippingCriterion: string;
}

/** Antigüedad máxima (h) para tratar una lectura como oferta vigente (a aprobar). */
export const DEFAULT_MAX_AGE_HOURS = 72;
/** Vigencia propuesta de la señal pública (a aprobar por Axel). */
export const SIGNAL_TTL_DAYS = 7;
/** Máximo de observaciones conservadas por producto. */
export const MAX_OBSERVATIONS = 200;
const EPSILON = 0.005;

export function contextKey(ctx: OfferContext): string {
  return [
    String(ctx.currency || '').toUpperCase(),
    String(ctx.destination || '').toUpperCase(),
    String(ctx.merchantId ?? '').toLowerCase(),
    String(ctx.variantId ?? '').toLowerCase(),
    String(ctx.condition ?? '').toLowerCase(),
    ctx.quantity ?? '',
    String(ctx.shippingCriterion ?? 'standard').toLowerCase(),
  ].join('|');
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function isValidPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export interface AppendResult {
  list: OfferObservation[];
  /** 'appended' = fila nueva; 'refreshed' = misma lectura reconfirmada; 'ignored' = reintento del mismo ciclo. */
  outcome: 'appended' | 'refreshed' | 'ignored';
  /** Última observación comparable ANTERIOR a esta (para evaluar bajadas). */
  previous?: OfferObservation;
}

const sameReading = (a: OfferObservation, b: OfferObservation): boolean =>
  a.price === b.price &&
  a.originalPrice === b.originalPrice &&
  a.inStock === b.inStock &&
  a.shippingCost === b.shippingCost &&
  a.deliveryMinDays === b.deliveryMinDays &&
  a.deliveryMaxDays === b.deliveryMaxDays;

export function appendObservation(list: OfferObservation[] | undefined, next: OfferObservation): AppendResult {
  const current = Array.isArray(list) ? [...list] : [];
  const normalized: OfferObservation = { ...next, price: round2(next.price) };

  // Último registro comparable (mismo contexto).
  let lastIndex = -1;
  for (let i = current.length - 1; i >= 0; i--) {
    if (current[i].contextKey === normalized.contextKey) {
      lastIndex = i;
      break;
    }
  }
  const last = lastIndex >= 0 ? current[lastIndex] : undefined;

  if (last && last.runId === normalized.runId) {
    return { list: current, outcome: 'ignored', previous: undefined };
  }

  if (last && sameReading(last, normalized) && last.capturedAt.slice(0, 10) === normalized.capturedAt.slice(0, 10)) {
    current[lastIndex] = { ...last, verifiedAt: normalized.verifiedAt };
    return { list: current, outcome: 'refreshed', previous: undefined };
  }

  current.push(normalized);
  return { list: current.slice(-MAX_OBSERVATIONS), outcome: 'appended', previous: last };
}

/**
 * Señal de bajada: sólo si hay lectura previa comparable y el precio baja de
 * verdad. Devuelve null en cualquier otro caso.
 */
export function evaluateDrop(
  key: string,
  previous: OfferObservation | undefined,
  next: OfferObservation,
  now: Date = new Date(),
): PriceSignal | null {
  if (!previous) return null; // primera lectura
  if (previous.contextKey !== next.contextKey) return null; // no comparable
  if (!isValidPrice(previous.price) || !isValidPrice(next.price)) return null;
  if (next.inStock === false || previous.inStock === false) return null;
  if (!(previous.price - next.price > EPSILON)) return null;
  const expires = new Date(now.getTime() + SIGNAL_TTL_DAYS * 86_400_000);
  return {
    offerKey: key,
    contextKey: next.contextKey,
    previousPrice: round2(previous.price),
    price: round2(next.price),
    currency: next.context.currency,
    detectedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    shippingCriterion: String(next.context.shippingCriterion ?? 'standard'),
  };
}

/**
 * ¿La señal sigue siendo pública? Se retira si caduca, si la oferta destacada
 * es otra, si el precio vigente subió por encima del de la señal, o si ya no
 * hay lectura vigente.
 */
export function activeSignal(
  signal: PriceSignal | null | undefined,
  opts: { now?: Date; offerKey: string; currentPrice: number | null | undefined; stale?: boolean },
): PriceSignal | null {
  if (!signal) return null;
  const now = opts.now ?? new Date();
  if (signal.offerKey !== opts.offerKey) return null;
  if (opts.stale) return null;
  if (Date.parse(signal.expiresAt) <= now.getTime()) return null;
  if (typeof opts.currentPrice === 'number' && opts.currentPrice > signal.price + EPSILON) return null;
  return signal;
}

/**
 * Señal resultante tras una nueva lectura: una nueva bajada la sustituye; una
 * subida o cambio de oferta la retira; una lectura sin cambio NO renueva la
 * vigencia.
 */
export function nextSignal(
  current: PriceSignal | null | undefined,
  evaluated: PriceSignal | null,
  key: string,
  next: OfferObservation,
): PriceSignal | null {
  if (evaluated) return evaluated;
  if (!current) return null;
  if (current.offerKey !== key) return null;
  if (current.contextKey === next.contextKey && next.price > current.price + EPSILON) return null;
  return current;
}

export type Freshness = 'fresh' | 'stale' | 'unverified';

export function freshnessOf(
  lastVerifiedAt: string | null | undefined,
  maxAgeHours: number,
  now: Date = new Date(),
): Freshness {
  if (!lastVerifiedAt) return 'unverified';
  const t = Date.parse(lastVerifiedAt);
  if (!Number.isFinite(t)) return 'unverified';
  return now.getTime() - t > maxAgeHours * 3_600_000 ? 'stale' : 'fresh';
}
