/**
 * ==============================================================================
 * TREIDILOR — SERVICIO ÚNICO DE ACTUALIZACIÓN DE OFERTAS
 * ==============================================================================
 * Un solo servicio para ofertas importadas por API, URL/ASIN o JSON, usado por
 * el botón manual del panel (`/api/admin/offers/refresh`) y por el programador
 * (apagado por defecto). Misma validación, misma cola y mismo bloqueo.
 *
 * Garantías:
 *  - Una sola ejecución a la vez (no hay solape manual/programado).
 *  - Reintentos con espera progresiva; un fallo conserva el último valor válido
 *    con su fecha y NUNCA se interpreta como stock cero ni envío gratis.
 *  - Distingue `lastAttemptAt` (último intento) de `lastVerifiedAt` (última
 *    verificación correcta).
 *  - Cada lectura válida se guarda como observación fechada sin duplicarse al
 *    reintentar (ver offerObservations.ts) y alimenta `priceHistory`.
 *  - Las diferencias se aplican según la autoridad de cada campo; los campos
 *    editoriales/bloqueados no se tocan y los cambios de identidad van a
 *    `extra.reviewQueue` para revisión humana.
 *  - Un JSON sin ASIN/URL/API reconsultable queda `no_source`: se conserva su
 *    última fecha confirmada y se marca pendiente de nueva importación.
 * ==============================================================================
 */

import type { Product } from './productStore';
import { detectNetworkId } from './productNetwork';
import { brandIsMerchant, normalizeBrand, normalizeSourceId, offerKey, sameSourceId } from './offerIdentity';
import {
  appendObservation,
  contextKey,
  DEFAULT_MAX_AGE_HOURS,
  evaluateDrop,
  freshnessOf,
  isValidPrice,
  nextSignal,
  type OfferContext,
  type OfferObservation,
  type PriceSignal,
} from './offerObservations';
import { mergePoint } from './priceHistory';
import { readLockedFields } from './reimportMerge';

type AnyRecord = Record<string, unknown>;

/* ───────────────────────────── ADAPTADORES ───────────────────────────── */

export interface RefreshReading {
  price?: number | null;
  originalPrice?: number | null;
  currency?: string | null;
  /** null/undefined = la fuente no lo informó (NO es «agotado»). */
  inStock?: boolean | null;
  /** null = desconocido; 0 = gratis. */
  shippingCost?: number | null;
  deliveryMinDays?: number | null;
  deliveryMaxDays?: number | null;
  rating?: number | null;
  reviewsCount?: number | null;
  image?: string | null;
  gallery?: string[] | null;
  specs?: Record<string, string> | null;
  identity?: { title?: string; brand?: string; sourceId?: string };
}

export class RefreshError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = true) {
    super(message);
    this.name = 'RefreshError';
    this.retryable = retryable;
  }
}

export interface SourceRef {
  type: string;
  id: string;
}

export interface SourceAdapter {
  id: string;
  networks: string[];
  /** Fuente e identificador con los que repetir la consulta, o null si no hay. */
  resolveSource(product: Product): SourceRef | null;
  fetch(product: Product, source: SourceRef): Promise<RefreshReading>;
}

const ASIN_RE = /^[A-Z0-9]{10}$/;

/** Amazon vía ScraperAPI (consume créditos: sólo se invoca al ejecutar un refresco). */
export const amazonAdapter: SourceAdapter = {
  id: 'amazon-scraperapi',
  networks: ['amazon'],
  resolveSource(product) {
    const candidates = [product.asin, product.sourceId];
    for (const candidate of candidates) {
      const id = normalizeSourceId(candidate);
      if (ASIN_RE.test(id)) return { type: 'asin', id };
    }
    return null;
  },
  async fetch(_product, source) {
    const mod = await import('./amazonImport');
    let raw: AnyRecord;
    try {
      // Un único intento interno: los reintentos los gobierna el servicio.
      raw = (await mod.scrapeAmazonProduct(source.id, { maxRetries: 1 })) as unknown as AnyRecord;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fatal = /SCRAPER_API_KEY|clave de API inválida|cuota|Page Not Found|no encontró el producto/i.test(message);
      throw new RefreshError(message, !fatal);
    }
    const n = mod.normalizeScrapedAmazonData(raw as never, source.id);
    const availabilityKnown = raw.availability != null || raw.inStock != null;
    return {
      price: n.price ?? null,
      originalPrice: n.originalPrice ?? null,
      currency: n.currency,
      inStock: availabilityKnown ? n.inStock : null,
      shippingCost: null, // ScraperAPI no lo entrega de forma fiable: desconocido
      rating: n.rating ?? null,
      reviewsCount: n.reviewsCount ?? null,
      image: n.image || null,
      gallery: n.gallery?.length ? n.gallery : null,
      specs: n.specs ?? null,
      identity: { title: n.title, brand: n.brand, sourceId: n.asin },
    };
  },
};

/** Redes sin re-consulta implementada: se informa, no se inventa. */
export const DEFAULT_ADAPTERS: SourceAdapter[] = [amazonAdapter];

/* ───────────────────────────── ESTADO / CONFIG ───────────────────────────── */

export interface SourceSchedule {
  enabled: boolean;
  everyHours: number;
  batchSize: number;
  /** Pasado este tiempo sin verificar, la lectura deja de contar como vigente. */
  maxAgeHours: number;
}

export const DEFAULT_SCHEDULE: Record<string, SourceSchedule> = {
  amazon: { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: DEFAULT_MAX_AGE_HOURS },
};

export interface OfferResult {
  id: string;
  title: string;
  network: string;
  status: 'updated' | 'verified' | 'error' | 'no_source' | 'review' | 'skipped';
  message: string;
  priceBefore?: number;
  priceAfter?: number;
  attempts: number;
  changes: string[];
  dropSignal?: boolean;
}

export interface RefreshReport {
  runId: string;
  mode: 'manual' | 'scheduled';
  startedAt: string;
  finishedAt?: string;
  total: number;
  updated: number;
  verified: number;
  errors: number;
  noSource: number;
  review: number;
  observations: number;
  alertsSent: number;
  results: OfferResult[];
}

export interface RefreshStore {
  read(): Product[];
  write(products: Product[]): boolean;
  afterWrite?(): void;
}

export interface RefreshOptions {
  ids?: string[];
  all?: boolean;
  /** Sólo productos con la verificación vencida según la frecuencia de su fuente. */
  onlyDue?: boolean;
  limit?: number;
  mode?: 'manual' | 'scheduled';
  adapters?: SourceAdapter[];
  schedule?: Record<string, SourceSchedule>;
  store?: RefreshStore;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
  betweenMs?: number;
  destination?: string;
  evaluateAlerts?: boolean;
  alertRunner?: () => Promise<number>;
  dryRun?: boolean;
  runId?: string;
}

let activeRun: Promise<RefreshReport> | null = null;
let lastReport: RefreshReport | null = null;
let liveReport: RefreshReport | null = null;

export function getRefreshStatus(): { running: boolean; live: RefreshReport | null; last: RefreshReport | null } {
  return { running: activeRun !== null, live: liveReport, last: lastReport };
}

async function defaultStore(): Promise<RefreshStore> {
  const store = await import('./productStore');
  return {
    read: () => store.readProductsFromFile(),
    write: (products) => store.writeProductsToFile(products),
    afterWrite: () => {
      void import('./catalog').then((m) => m.invalidateCatalogCache()).catch(() => undefined);
    },
  };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ───────────────────────────── LECTURA DE ESTADO ───────────────────────────── */

export interface RefreshMeta {
  lastAttemptAt?: string;
  lastVerifiedAt?: string;
  status?: 'ok' | 'error' | 'no_source';
  failures?: number;
  lastError?: string;
  source?: SourceRef;
  lastRunId?: string;
}

export function readRefreshMeta(product: Pick<Product, 'extra'>): RefreshMeta {
  const meta = (product.extra as AnyRecord | undefined)?.refresh;
  return meta && typeof meta === 'object' ? (meta as RefreshMeta) : {};
}

export function readObservations(product: Pick<Product, 'extra'>): OfferObservation[] {
  const list = (product.extra as AnyRecord | undefined)?.observations;
  return Array.isArray(list) ? (list as OfferObservation[]) : [];
}

export function readSignal(product: Pick<Product, 'extra'>): PriceSignal | null {
  const signal = (product.extra as AnyRecord | undefined)?.priceSignal;
  return signal && typeof signal === 'object' ? (signal as PriceSignal) : null;
}

/** ¿Toca verificar esta oferta según la frecuencia de su fuente y sus fallos previos? */
export function isDue(product: Product, schedule: SourceSchedule, now: Date): boolean {
  const meta = readRefreshMeta(product);
  const everyMs = schedule.everyHours * 3_600_000;
  const verified = meta.lastVerifiedAt ? Date.parse(meta.lastVerifiedAt) : 0;
  if (verified && now.getTime() - verified < everyMs) return false;
  // Espera progresiva tras fallos: 30 min · 2^fallos, sin superar la frecuencia.
  const attempt = meta.lastAttemptAt ? Date.parse(meta.lastAttemptAt) : 0;
  const failures = meta.failures ?? 0;
  if (attempt && failures > 0) {
    const wait = Math.min(everyMs, 30 * 60_000 * 2 ** Math.min(failures, 8));
    if (now.getTime() - attempt < wait) return false;
  }
  return true;
}

/* ───────────────────────────── EJECUCIÓN ───────────────────────────── */

function setOrDelete(target: AnyRecord, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

interface Patch {
  fields: AnyRecord;
  extra: AnyRecord;
}

async function refreshOne(
  product: Product,
  adapter: SourceAdapter | undefined,
  ctx: {
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
    maxAttempts: number;
    baseDelayMs: number;
    destination: string;
    runId: string;
  },
): Promise<{ result: OfferResult; patch: Patch | null; appended: boolean }> {
  const network = detectNetworkId(product) || 'desconocida';
  const base: OfferResult = {
    id: product.id,
    title: product.title_short || product.title,
    network,
    status: 'skipped',
    message: '',
    attempts: 0,
    changes: [],
    priceBefore: Number(product.price) || undefined,
  };
  const startedAt = ctx.now().toISOString();
  const meta = readRefreshMeta(product);
  const patchFor = (m: RefreshMeta): Patch => ({ fields: {}, extra: { refresh: { ...meta, ...m } } });

  // Sin fuente reconsultable: se conserva la última fecha confirmada.
  const source = adapter?.resolveSource(product) ?? null;
  if (!adapter || !source) {
    const reason = adapter
      ? 'No hay ASIN/URL reconsultable: pendiente de una nueva importación.'
      : `La red «${network}» no tiene re-consulta implementada: pendiente de nueva importación o feed.`;
    return {
      result: { ...base, status: 'no_source', message: reason },
      patch: patchFor({ status: 'no_source', lastAttemptAt: startedAt, lastError: reason }),
      appended: false,
    };
  }

  // Reintentos con espera progresiva.
  let reading: RefreshReading | null = null;
  let lastError = '';
  let attempts = 0;
  for (let attempt = 1; attempt <= ctx.maxAttempts; attempt++) {
    attempts = attempt;
    try {
      const candidate = await adapter.fetch(product, source);
      if (!isValidPrice(candidate.price)) {
        // Respuesta incompleta: no es un precio válido ni «stock cero».
        throw new RefreshError('La fuente respondió sin un precio válido.', true);
      }
      reading = candidate;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const retryable = error instanceof RefreshError ? error.retryable : true;
      if (!retryable || attempt === ctx.maxAttempts) break;
      await ctx.sleep(ctx.baseDelayMs * 2 ** (attempt - 1));
    }
  }

  if (!reading) {
    const failures = (meta.failures ?? 0) + 1;
    return {
      result: {
        ...base,
        status: 'error',
        attempts,
        message: `${lastError} Se conserva el último valor válido${meta.lastVerifiedAt ? ` (verificado ${meta.lastVerifiedAt.slice(0, 10)})` : ''}.`,
      },
      patch: patchFor({ status: 'error', lastAttemptAt: startedAt, failures, lastError: lastError.slice(0, 300), source }),
      appended: false,
    };
  }

  const finishedAt = ctx.now().toISOString();
  const newPrice = Math.round((reading.price as number) * 100) / 100;
  const currency = String(reading.currency || product.currency || 'EUR').toUpperCase();
  const patch = patchFor({
    status: 'ok',
    lastAttemptAt: startedAt,
    lastVerifiedAt: finishedAt,
    failures: 0,
    lastError: undefined,
    source,
    lastRunId: ctx.runId,
  });
  const changes: string[] = [];
  const reviewItems: AnyRecord[] = [];
  const locked = new Set(readLockedFields(product as unknown as AnyRecord));

  // Identidad: un cambio de moneda, marca o id va a revisión, no se aplica.
  const identity = reading.identity ?? {};
  if (product.currency && currency !== String(product.currency).toUpperCase()) {
    reviewItems.push({ field: 'currency', old: product.currency, new: currency });
  }
  if (identity.sourceId && !sameSourceId(identity.sourceId, source.id)) {
    reviewItems.push({ field: 'sourceId', old: source.id, new: identity.sourceId });
  }
  const incomingBrand = normalizeBrand(identity.brand);
  const currentBrand = normalizeBrand(product.brand);
  if (
    incomingBrand.key &&
    currentBrand.key &&
    incomingBrand.key !== currentBrand.key &&
    !brandIsMerchant(identity.brand, product.merchant)
  ) {
    reviewItems.push({ field: 'brand', old: product.brand, new: identity.brand });
  }
  if (reviewItems.length) {
    patch.extra.reviewQueue = [
      ...(((product.extra as AnyRecord | undefined)?.reviewQueue as AnyRecord[] | undefined) ?? []),
      ...reviewItems.map((item) => ({ ...item, detectedAt: finishedAt, runId: ctx.runId })),
    ].slice(-50);
  }
  const currencyMismatch = reviewItems.some((item) => item.field === 'currency');

  // Observación fechada (no se registra si la moneda no es comparable).
  const merchantId = (product.extra as AnyRecord | undefined)?.['ID tienda'];
  const context: OfferContext = {
    currency,
    destination: ctx.destination,
    merchantId: merchantId != null ? String(merchantId) : null,
    variantId: null,
    condition: product.condition ?? null,
    quantity: null,
    shippingCriterion: 'standard',
  };
  const observation: OfferObservation = {
    capturedAt: finishedAt,
    verifiedAt: finishedAt,
    price: newPrice,
    originalPrice: isValidPrice(reading.originalPrice) && reading.originalPrice > newPrice ? Math.round(reading.originalPrice * 100) / 100 : null,
    inStock: typeof reading.inStock === 'boolean' ? reading.inStock : null,
    shippingCost: typeof reading.shippingCost === 'number' && reading.shippingCost >= 0 ? reading.shippingCost : null,
    deliveryMinDays: typeof reading.deliveryMinDays === 'number' ? reading.deliveryMinDays : null,
    deliveryMaxDays: typeof reading.deliveryMaxDays === 'number' ? reading.deliveryMaxDays : null,
    context,
    contextKey: contextKey(context),
    source,
    runId: ctx.runId,
  };

  let appended = false;
  const key = offerKey({ network, externalId: source.id, merchantId: context.merchantId });
  if (!currencyMismatch) {
    const appendResult = appendObservation(readObservations(product), observation);
    patch.extra.observations = appendResult.list;
    appended = appendResult.outcome === 'appended';
    const evaluated = appendResult.outcome === 'appended' ? evaluateDrop(key, appendResult.previous, observation, ctx.now()) : null;
    const signal = nextSignal(readSignal(product), evaluated, key, observation);
    patch.extra.priceSignal = signal ?? null; // null = retirar la señal
    if (evaluated) changes.push(`bajada ${evaluated.previousPrice.toFixed(2)} → ${evaluated.price.toFixed(2)} ${evaluated.currency}`);

    // Hechos del proveedor (autoridad: la fuente).
    const oldPrice = Number(product.price) || 0;
    if (Math.abs(newPrice - oldPrice) > 0.004) {
      patch.fields.price = newPrice;
      changes.push(`precio ${oldPrice.toFixed(2)} → ${newPrice.toFixed(2)}`);
    }
    if (observation.originalPrice != null && observation.originalPrice !== product.originalPrice) {
      patch.fields.originalPrice = observation.originalPrice;
    }
    if (typeof reading.inStock === 'boolean' && reading.inStock !== product.inStock) {
      patch.fields.inStock = reading.inStock;
      changes.push(reading.inStock ? 'vuelve a estar disponible' : 'no disponible');
    }
    if (observation.shippingCost === 0 && !locked.has('freeShipping')) patch.fields.freeShipping = true;
    else if (observation.shippingCost != null && observation.shippingCost > 0 && !locked.has('freeShipping')) patch.fields.freeShipping = false;
    if (observation.deliveryMaxDays != null && !locked.has('shippingDays')) patch.fields.shippingDays = observation.deliveryMaxDays;
    if (reading.rating != null && reading.rating > 0 && !locked.has('rating')) patch.fields.rating = reading.rating;
    if (reading.reviewsCount != null && reading.reviewsCount > 0 && !locked.has('reviewsCount')) patch.fields.reviewsCount = reading.reviewsCount;
    if (reading.gallery?.length && !locked.has('gallery')) patch.fields.gallery = reading.gallery;
    if (reading.image && !product.image && !locked.has('image')) patch.fields.image = reading.image;
    if (reading.specs && Object.keys(reading.specs).length && !locked.has('specs')) {
      patch.fields.specs = { ...(reading.specs ?? {}), ...(product.specs ?? {}) };
    }
    patch.fields.lastPriceSync = finishedAt;
    // Histórico: sólo lecturas confirmadas, un punto por día sin duplicar.
    patch.fields.priceHistory = mergePoint(product.priceHistory, { date: finishedAt.slice(0, 10), price: newPrice });
  }

  const status: OfferResult['status'] = currencyMismatch ? 'review' : changes.length ? 'updated' : 'verified';
  return {
    result: {
      ...base,
      status,
      attempts,
      priceAfter: newPrice,
      changes: [...changes, ...reviewItems.map((item) => `revisión: ${String(item.field)}`)],
      dropSignal: changes.some((c) => c.startsWith('bajada')),
      message:
        status === 'review'
          ? 'Cambio de identidad/moneda: derivado a revisión, sin aplicar.'
          : status === 'updated'
            ? `Actualizado: ${changes.join('; ')}.`
            : 'Verificado sin cambios.',
    },
    patch,
    appended,
  };
}

function applyPatch(product: Product, patch: Patch): Product {
  const next: AnyRecord = { ...(product as unknown as AnyRecord), ...patch.fields };
  const extra: AnyRecord = { ...((product.extra as AnyRecord | undefined) ?? {}) };
  for (const [key, value] of Object.entries(patch.extra)) {
    if (key === 'refresh' && value && typeof value === 'object') {
      const cleaned: AnyRecord = { ...(value as AnyRecord) };
      for (const k of Object.keys(cleaned)) if (cleaned[k] === undefined) delete cleaned[k];
      extra.refresh = cleaned;
    } else setOrDelete(extra, key, value === null ? undefined : value);
  }
  next.extra = extra;
  return next as unknown as Product;
}

function adapterFor(product: Product, adapters: SourceAdapter[]): SourceAdapter | undefined {
  const network = detectNetworkId(product);
  return adapters.find((adapter) => adapter.networks.includes(network));
}

/**
 * Ejecuta una actualización. Si ya hay una en curso devuelve `null` (no solapa).
 */
export async function refreshOffers(options: RefreshOptions = {}): Promise<RefreshReport | null> {
  if (activeRun) return null;
  const run = runRefresh(options);
  activeRun = run;
  try {
    return await run;
  } finally {
    activeRun = null;
    liveReport = null;
  }
}

async function runRefresh(options: RefreshOptions): Promise<RefreshReport> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const store = options.store ?? (await defaultStore());
  const adapters = options.adapters ?? DEFAULT_ADAPTERS;
  const schedule = options.schedule ?? DEFAULT_SCHEDULE;
  const runId = options.runId ?? `run-${now().toISOString()}-${Math.random().toString(36).slice(2, 7)}`;

  const snapshot = store.read();
  let targets: Product[];
  if (options.ids?.length) {
    const wanted = new Set(options.ids);
    targets = snapshot.filter((p) => wanted.has(p.id));
  } else if (options.all || options.onlyDue) {
    targets = [...snapshot];
  } else {
    targets = [];
  }
  if (options.onlyDue) {
    targets = targets.filter((p) => {
      const adapter = adapterFor(p, adapters);
      if (!adapter) return false; // sin conector no se reintenta en bucle
      const cfg = schedule[detectNetworkId(p)] ?? { enabled: false, everyHours: 24, batchSize: 10, maxAgeHours: 72 };
      return cfg.enabled && isDue(p, cfg, now());
    });
    targets.sort((a, b) => (readRefreshMeta(a).lastVerifiedAt ?? '').localeCompare(readRefreshMeta(b).lastVerifiedAt ?? ''));
  }
  if (options.limit && options.limit > 0) targets = targets.slice(0, options.limit);

  const report: RefreshReport = {
    runId,
    mode: options.mode ?? 'manual',
    startedAt: now().toISOString(),
    total: targets.length,
    updated: 0,
    verified: 0,
    errors: 0,
    noSource: 0,
    review: 0,
    observations: 0,
    alertsSent: 0,
    results: [],
  };
  liveReport = report;

  const patches = new Map<string, Patch>();
  for (let i = 0; i < targets.length; i++) {
    const product = targets[i];
    const { result, patch, appended } = await refreshOne(product, adapterFor(product, adapters), {
      now,
      sleep,
      maxAttempts: options.maxAttempts ?? 3,
      baseDelayMs: options.baseDelayMs ?? 2000,
      destination: options.destination ?? 'ES',
      runId,
    });
    report.results.push(result);
    if (patch) patches.set(product.id, patch);
    if (appended) report.observations++;
    if (result.status === 'updated') report.updated++;
    else if (result.status === 'verified') report.verified++;
    else if (result.status === 'error') report.errors++;
    else if (result.status === 'no_source') report.noSource++;
    else if (result.status === 'review') report.review++;
    if (i < targets.length - 1 && (options.betweenMs ?? 0) > 0) await sleep(options.betweenMs as number);
  }

  // Persistencia: se relee el catálogo y sólo se aplican los parches de este ciclo.
  if (!options.dryRun && patches.size) {
    const fresh = store.read();
    const merged = fresh.map((product) => {
      const patch = patches.get(product.id);
      return patch ? applyPatch(product, patch) : product;
    });
    if (store.write(merged)) store.afterWrite?.();
    else report.results.push({ id: '-', title: 'Escritura', network: '-', status: 'error', message: 'No se pudo escribir products.json.', attempts: 0, changes: [] });
  }

  // Alertas personales: tras guardar observaciones válidas, una sola evaluación.
  if (!options.dryRun && report.observations > 0 && options.evaluateAlerts !== false) {
    try {
      const runner = options.alertRunner ?? (await import('./priceAlerts')).runPriceAlertCheck;
      report.alertsSent = await runner();
    } catch {
      /* las alertas no deben romper el refresco */
    }
  }

  report.finishedAt = now().toISOString();
  lastReport = report;
  return report;
}

/** Resumen de cobertura/frescura para el panel. */
export function summarizeCoverage(
  products: Product[],
  adapters: SourceAdapter[] = DEFAULT_ADAPTERS,
  schedule: Record<string, SourceSchedule> = DEFAULT_SCHEDULE,
  now: Date = new Date(),
) {
  const bySource: Record<string, { total: number; refreshable: number; fresh: number; stale: number; unverified: number; noSource: number }> = {};
  for (const product of products) {
    const network = detectNetworkId(product) || 'desconocida';
    const entry = (bySource[network] ??= { total: 0, refreshable: 0, fresh: 0, stale: 0, unverified: 0, noSource: 0 });
    entry.total++;
    const adapter = adapterFor(product, adapters);
    if (!adapter || !adapter.resolveSource(product)) {
      entry.noSource++;
      continue;
    }
    entry.refreshable++;
    const maxAge = schedule[network]?.maxAgeHours ?? 72;
    entry[freshnessOf(readRefreshMeta(product).lastVerifiedAt, maxAge, now)]++;
  }
  return bySource;
}

/* ───────────────────────────── PROGRAMADOR ───────────────────────────── */

const TICK_MS = 30 * 60_000;
const INITIAL_DELAY_MS = 90_000;
let schedulerStarted = false;

export async function readScheduleConfig(): Promise<Record<string, SourceSchedule>> {
  try {
    const fs = await import('node:fs');
    const { dataFile } = await import('./paths');
    const file = dataFile('offer-refresh.json');
    if (!fs.existsSync(file)) return DEFAULT_SCHEDULE;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { sources?: Record<string, Partial<SourceSchedule>> };
    const merged: Record<string, SourceSchedule> = { ...DEFAULT_SCHEDULE };
    for (const [network, cfg] of Object.entries(parsed.sources ?? {})) {
      merged[network] = { ...(merged[network] ?? { enabled: false, everyHours: 24, batchSize: 10, maxAgeHours: 72 }), ...cfg };
    }
    return merged;
  } catch {
    return DEFAULT_SCHEDULE;
  }
}

/**
 * Guarda la frecuencia/estado de una fuente en `offer-refresh.json` (escritura
 * atómica). Valida: `everyHours` entero 1–720; `enabled` booleano.
 */
export async function writeScheduleConfig(
  network: string,
  patch: { enabled?: boolean; everyHours?: number },
): Promise<Record<string, SourceSchedule>> {
  const key = String(network || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,30}$/.test(key)) throw new Error('Fuente no válida.');
  const current = await readScheduleConfig();
  const next: SourceSchedule = { ...(current[key] ?? { enabled: false, everyHours: 24, batchSize: 10, maxAgeHours: DEFAULT_MAX_AGE_HOURS }) };
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
  if (patch.everyHours !== undefined) {
    const hours = Math.round(Number(patch.everyHours));
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) throw new Error('La frecuencia debe estar entre 1 y 720 horas.');
    next.everyHours = hours;
    next.maxAgeHours = Math.max(DEFAULT_MAX_AGE_HOURS, hours * 3);
  }
  const merged = { ...current, [key]: next };
  const fs = await import('node:fs');
  const { dataFile } = await import('./paths');
  const file = dataFile('offer-refresh.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ sources: merged }, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  return merged;
}

/**
 * Arranca el programador. APAGADO por defecto: sólo actúa con
 * `OFFER_REFRESH_ENABLED=true` en el entorno (activación en producción =
 * decisión y autorización aparte). Reutiliza el patrón setInterval+unref de
 * priceAlerts.ts y comparte el bloqueo con el botón manual.
 */
export function startOfferRefreshScheduler(): void {
  if (schedulerStarted) return;
  if (String(process.env.OFFER_REFRESH_ENABLED ?? '').trim().toLowerCase() !== 'true') return;
  schedulerStarted = true;
  const tick = async () => {
    try {
      const schedule = await readScheduleConfig();
      const batch = Math.max(1, ...Object.values(schedule).filter((s) => s.enabled).map((s) => s.batchSize));
      await refreshOffers({ onlyDue: true, limit: batch, mode: 'scheduled', schedule, betweenMs: 3000 });
    } catch (error) {
      console.error('[OfferRefresh] Tick falló:', error);
    }
  };
  setTimeout(() => void tick(), INITIAL_DELAY_MS).unref?.();
  setInterval(() => void tick(), TICK_MS).unref?.();
}
