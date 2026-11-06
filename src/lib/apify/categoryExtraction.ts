/**
 * ==============================================================================
 * TREIDILOR — EXTRACCIÓN DE UNA CATEGORÍA DE AMAZON CON APIFY (actor junglee/Amazon-crawler)
 * ==============================================================================
 * Esquema de ENTRADA consultado en el build público del actor (`GET /v2/acts/junglee~amazon-crawler/builds/default`,
 * 6-nov-2026); sólo se usan parámetros que existen en él:
 *   categoryOrProductUrls [{url}]      (obligatorio)
 *   maxItemsPerStartUrl   integer ≥ 0  (límite de resultados; NUNCA se envía 0)
 *   maxSearchPagesPerStartUrl integer ≥ 1 (límite de páginas de búsqueda; se detiene con el primero de los dos límites)
 *   scrapeSellers boolean              (vendedor de la oferta principal)
 *   maxOffers integer                  (0: no se piden ofertas adicionales)
 *   language                           enum del actor (cs, da, de, en, es, fr…): «es» por defecto (amazon.es lo admite);
 *                                      APIFY_LANGUAGE lo sustituye. No altera el dominio, el mercado ni la moneda (EUR).
 *   proxyCountry                       sólo si se define APIFY_PROXY_COUNTRY (por defecto el actor elige según el dominio)
 * NO se envían `countryCode` ni `zipCode`: el actor cobra el evento «deliveryLocation» (0,06 USD por resultado).
 *
 * Ejecución (API de Apify v2, token sólo en el servidor, cabecera Authorization):
 *   POST /v2/actors/{actor}/runs?timeout=…&maxTotalChargeUsd=…   → crea la ejecución y devuelve enseguida (no se espera)
 *   GET  /v2/actor-runs/{runId}                                  → estado (se consulta desde la interfaz, sin espera)
 *   POST /v2/actor-runs/{runId}/abort                            → cancelar: DETIENE la ejecución en Apify
 *   GET  /v2/datasets/{datasetId}/items?limit=…                  → resultados
 *
 * Límites y coste (precio por evento del actor, nivel FREE): resultado 0,005 USD + vendedor 0,0025 USD por producto.
 * El servidor limita el número de productos, las páginas, la duración (`timeout`) y el gasto (`maxTotalChargeUsd`) y
 * rechaza más de MAX ejecuciones al día. Obtener datos NO escribe en el catálogo.
 * ==============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, dataFile } from '../paths';
import { readJsonArrayFile, writeJsonArrayFile } from '../jsonStore';
import { adaptApifyAmazonItem, isApifyAmazonItem } from '../jsonImport/apifyAmazon';
import { adaptApifyTemuItem, isApifyTemuItem } from '../jsonImport/apifyTemu';
import { resolveCatalogCategory } from '../jsonImport/categoryResolver';

/**
 * Base de la API de Apify. `APIFY_API_BASE` sólo se admite apuntando a la máquina local (pruebas con un Apify simulado);
 * cualquier otro valor se ignora para que el token nunca viaje a un destino ajeno por una variable mal puesta.
 */
const API = (() => {
  const override = (process.env.APIFY_API_BASE ?? '').trim().replace(/\/$/, '');
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/v2$/.test(override) ? override : 'https://api.apify.com/v2';
})();
export const DEFAULT_LIMIT = 10;
const PRICE_PER_PRODUCT_USD = 0.005 + 0.0025; // resultado + vendedor (nivel FREE, el más caro)
const ACTIVE = new Set<JobStatus>(['starting', 'running', 'aborting']);
const TERMINAL = new Set<JobStatus>(['succeeded', 'failed', 'aborted', 'timed_out']);

export type ExtractionSource = 'amazon' | 'temu';
export type UrlKind = 'category' | 'product';

export type JobStatus = 'starting' | 'running' | 'aborting' | 'succeeded' | 'failed' | 'aborted' | 'timed_out';

export interface ExtractionJob {
  id: string;
  /** Origen de la extracción (los trabajos antiguos no lo traen: son de Amazon). */
  source?: ExtractionSource;
  urlKind?: UrlKind;
  url: string;
  limit: number;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  datasetId?: string;
  /** Productos ya generados por el actor (mientras corre, del dataset; al final, los leídos). */
  itemsSoFar?: number;
  costUsd?: number;
  maxCostUsd: number;
  cancelRequested?: boolean;
  /** Mensaje de error ya saneado (sin token ni cuerpo del proveedor). */
  error?: string;
  /** El resultado se leyó y está guardado. */
  resultReady?: boolean;
  finishedAt?: string;
  /** Resumen del resultado (sin los registros). */
  summary?: ResultSummary;
}

export interface ResultSummary {
  fetched: number;
  adapted: number;
  actorErrors: number;
  withReview: number;
  partial: boolean;
  warnings: string[];
}

export class ExtractionError extends Error {
  status: number;
  job?: ExtractionJob;
  constructor(message: string, status = 400, job?: ExtractionJob) {
    super(message);
    this.status = status;
    this.job = job;
  }
}

/* ───────────────────────── Configuración ───────────────────────── */

const int = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

export function extractionConfig() {
  const maxLimit = int(process.env.APIFY_MAX_ITEMS, 50, 1, 100);
  return {
    configured: Boolean((process.env.APIFY_TOKEN ?? '').trim()),
    actor: (process.env.APIFY_AMAZON_ACTOR ?? 'junglee~amazon-crawler').trim().replace('/', '~'),
    temuActor: (process.env.APIFY_TEMU_ACTOR ?? 'hypebridge~temu-scraper').trim().replace('/', '~'),
    defaultLimit: Math.min(DEFAULT_LIMIT, maxLimit),
    maxLimit,
    timeoutSecs: int(process.env.APIFY_RUN_TIMEOUT_SECS, 900, 60, 3600),
    maxRunsPerDay: int(process.env.APIFY_MAX_RUNS_PER_DAY, 20, 1, 500),
    maxCostUsd: Math.max(0.05, Number(process.env.APIFY_MAX_COST_USD) || 2),
  };
}

const token = (): string => (process.env.APIFY_TOKEN ?? '').trim();

/* ───────────────────────── Validación de entrada ───────────────────────── */

const AMAZON_HOST = /^(www\.)?amazon\.(es|com|co\.uk|de|fr|it|nl|ie|pt|se|pl|ca|com\.mx|com\.br|com\.tr|sa|ae|in|co\.jp|com\.au|sg)$/i;

/** URL de categoría/búsqueda/más vendidos de Amazon (no de un producto). Devuelve la URL normalizada o lanza ExtractionError. */
export function validateCategoryUrl(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new ExtractionError('Indica la URL de la categoría de Amazon.');
  if (text.length > 2000) throw new ExtractionError('La URL es demasiado larga (máx. 2.000 caracteres).');
  let url: URL;
  try { url = new URL(text); } catch { throw new ExtractionError('La URL no es válida. Debe empezar por https://www.amazon.es/…'); }
  if (url.protocol !== 'https:') throw new ExtractionError('Sólo se admiten URL https.');
  if (url.username || url.password) throw new ExtractionError('La URL no puede incluir credenciales.');
  if (!AMAZON_HOST.test(url.hostname)) throw new ExtractionError('Sólo se admiten URL de Amazon (amazon.es, amazon.com, amazon.de…).');
  const p = url.pathname.toLowerCase();
  if (/\/(dp|gp\/product|gp\/aw\/d)\//.test(p) || /\/dp\/[a-z0-9]{10}/.test(p)) {
    throw new ExtractionError('Esa es la URL de un producto. Para un producto usa el campo «ASIN o URL de Amazon» (Obtener JSON).');
  }
  const looksLikeListing = p === '/s' || /^\/(-\/[a-z-]+\/)?(b|gp\/browse\.html|gp\/bestsellers|bestsellers|zgbs|gp\/new-releases|gp\/movers-and-shakers|gp\/most-wished-for|s)(\/|$)/.test(p) || /[?&](node|rh|k|bbn)=/.test(url.search);
  if (!looksLikeListing) throw new ExtractionError('La URL no parece de una categoría, búsqueda o lista de más vendidos de Amazon.');
  url.hash = '';
  return url.toString();
}

/** Límite de productos: entero entre 1 y el máximo del servidor. Nunca 0 (en el actor, 0 podría significar «sin límite»). */
export function validateLimit(raw: unknown, max = extractionConfig().maxLimit): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new ExtractionError('El máximo de productos debe ser un entero de 1 en adelante.');
  if (n > max) throw new ExtractionError(`El máximo de productos permitido es ${max}.`);
  return n;
}

/** Entrada del actor con el límite TRANSMITIDO a Apify (no se recorta después). */
export function buildActorInput(url: string, limit: number): Record<string, unknown> {
  const input: Record<string, unknown> = {
    categoryOrProductUrls: [{ url }],
    maxItemsPerStartUrl: limit,
    // 1 página de búsqueda de Amazon da ~16-48 productos; con margen y tope para no recorrer la categoría entera.
    maxSearchPagesPerStartUrl: Math.min(10, Math.ceil(limit / 10) + 1),
    scrapeSellers: true,
    maxOffers: 0,
  };
  const proxy = (process.env.APIFY_PROXY_COUNTRY ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(proxy)) input.proxyCountry = proxy;
  // Idioma de la página: valores del enum del actor (`es` = español). Un idioma que el dominio no admita lo ignora el actor.
  const lang = (process.env.APIFY_LANGUAGE ?? '').trim();
  input.language = /^[a-zA-Z_]{2,7}$/.test(lang) ? lang : 'es';
  return input;
}

export function maxChargeFor(limit: number, cap = extractionConfig().maxCostUsd): number {
  return Math.min(cap, Math.max(0.05, Math.round(limit * PRICE_PER_PRODUCT_USD * 2 * 1000) / 1000));
}

/* ───────────────────────── Temu (actor hypebridge/temu-scraper) ───────────────────────── */

const TEMU_HOST = /^([a-z0-9-]+\.)*temu\.com$/i;
/** Superficies que el actor NO admite (documentado en su README): se rechazan antes de lanzar nada. */
const TEMU_UNSUPPORTED: Array<[RegExp, string]> = [
  [/search_result\.html|[?&](search_key|query)=/i, 'Las búsquedas de Temu no están admitidas por el extractor. Usa la URL de una categoría o de un producto.'],
  [/mall\.html|[?&]mall_id=/i, 'Las páginas de tienda/comerciante de Temu no están admitidas por el extractor.'],
];
/** Colecciones y canales (sólo se evalúan si la URL no es de producto ni de categoría: un título de producto puede contener «flash»). */
const TEMU_CHANNEL = /channel|best-?sellers?|lightning|flash-?deal|deals?\.html|local-?warehouse|1-day|collection|\/(us\/)?(bestsellers|lightning-deals)/i;
const TEMU_CHANNEL_MSG = 'Las colecciones y canales de Temu (más vendidos, ofertas relámpago, almacén local…) no están admitidos por el extractor. Usa la URL de una categoría o de un producto.';

/** URL de PRODUCTO o CATEGORÍA de Temu. Devuelve la URL normalizada y su tipo, o lanza ExtractionError con el motivo. */
export function validateTemuUrl(raw: unknown): { url: string; kind: UrlKind } {
  const textValue = typeof raw === 'string' ? raw.trim() : '';
  if (!textValue) throw new ExtractionError('Indica la URL de un producto o de una categoría de Temu.');
  if (textValue.length > 2000) throw new ExtractionError('La URL es demasiado larga (máx. 2.000 caracteres).');
  let url: URL;
  try { url = new URL(textValue); } catch { throw new ExtractionError('La URL no es válida. Debe empezar por https://www.temu.com/…'); }
  if (url.protocol !== 'https:') throw new ExtractionError('Sólo se admiten URL https.');
  if (url.username || url.password) throw new ExtractionError('La URL no puede incluir credenciales.');
  if (!TEMU_HOST.test(url.hostname)) throw new ExtractionError('Sólo se admiten URL de Temu (www.temu.com).');
  const full = url.pathname + url.search;
  for (const [re, message] of TEMU_UNSUPPORTED) if (re.test(full)) throw new ExtractionError(message);
  const path = url.pathname.toLowerCase();
  if (path === '/' || /^\/[a-z]{2}(-[a-z]{2})?\/?$/.test(path)) {
    throw new ExtractionError('La portada de Temu no está admitida aquí (es un flujo de recomendaciones, no una categoría). Usa la URL de una categoría o de un producto.');
  }
  url.hash = '';
  const kind: UrlKind | null = /(^|[-/])g-\d{6,20}\.html$/.test(path) || /[?&]goods_id=\d{6,20}/.test(url.search) ? 'product' : /(^|[-/])o\d+-\d+\.html$/.test(path) ? 'category' : null;
  if (kind) {
    // Sin prefijo de mercado el actor usa el de EE. UU. y devuelve USD (verificado en una ejecución real): se rechaza ANTES de gastar.
    if (!/^\/es(-[a-z]{2})?\//.test(path)) {
      throw new ExtractionError('La URL de Temu no indica el mercado español: el actor usaría el de EE. UU. y devolvería precios en USD. Usa la URL con /es/, por ejemplo https://www.temu.com/es/category-o3-248.html (ábrela desde Temu España).');
    }
    return { url: url.toString(), kind };
  }
  if (TEMU_CHANNEL.test(full)) throw new ExtractionError(TEMU_CHANNEL_MSG);
  throw new ExtractionError('Tipo de URL de Temu no admitido. Solo se admiten productos (…-g-<id>.html) y categorías (…-o3-<id>.html).');
}

/**
 * Entrada del actor de Temu (esquema real: startUrls, maxItems, getProductDetails, extractReviews). El límite viaja como
 * `maxItems` (no se recorta después). `getProductDetails: true` abre la ficha de cada producto (variantes, atributos e
 * imágenes completas; coste adicional). Las opiniones no se piden: no se usan.
 */
export function buildTemuInput(url: string, limit: number): Record<string, unknown> {
  return { startUrls: [{ url }], maxItems: limit, getProductDetails: process.env.APIFY_TEMU_GET_DETAILS !== 'false', extractReviews: false };
}

// Precio por evento (nivel FREE): arranque 0,03 USD por GB de memoria; 0,006 por producto de listado y 0,016 por producto con
// detalle. MEDIDO en producción (7-nov-2026): 10 productos con detalle = 0,19 USD y 3 = 0,078 USD (0,03 + 0,016 × n): el evento
// de detalle sustituye al de listado. El tope por ejecución sigue calculándose con listado+detalle (margen).
const TEMU_START_USD = 0.03;
const TEMU_PER_PRODUCT_USD = 0.006 + 0.016;
const TEMU_MEASURED_PER_PRODUCT_USD = 0.016;
/** El actor declara 4 GB por defecto (4 eventos de arranque); se pide el mínimo que declara (1 GB) para pagar 1. */
export const TEMU_MEMORY_MB = 1024;

export function maxTemuChargeFor(limit: number, cap = extractionConfig().maxCostUsd): number {
  return Math.min(cap, Math.max(0.1, Math.round((TEMU_START_USD + limit * TEMU_PER_PRODUCT_USD) * 1.5 * 1000) / 1000));
}

/** Estimación del coste en USD con detalle activado (arranque + 0,016 por producto, medido). */
export function estimateTemuCost(limit: number): number {
  return Math.round((TEMU_START_USD + limit * TEMU_MEASURED_PER_PRODUCT_USD) * 1000) / 1000;
}

/* ───────────────────────── Cliente de Apify ───────────────────────── */

/** Mensaje seguro para el usuario a partir de un error HTTP de Apify (sin token ni cuerpo). */
function apifyHttpError(status: number): string {
  if (status === 401 || status === 403) return 'Apify rechazó el token (revisa APIFY_TOKEN y sus permisos).';
  if (status === 402) return 'Apify: saldo o límite de uso insuficiente para lanzar la ejecución.';
  if (status === 404) return 'Apify: no se encontró el actor o la ejecución.';
  if (status === 429) return 'Apify: demasiadas peticiones; inténtalo de nuevo en un momento.';
  return `Apify respondió con el estado ${status}.`;
}

async function apify(pathAndQuery: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  const key = token();
  if (!key) throw new ExtractionError('Falta la variable APIFY_TOKEN en el servidor.', 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(API + pathAndQuery, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${key}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    if (!response.ok) throw new ExtractionError(apifyHttpError(response.status), response.status === 429 ? 429 : 502);
    return await response.json();
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError('No se pudo contactar con Apify (red o tiempo de espera agotado).', 502);
  } finally {
    clearTimeout(timer);
  }
}

/* ───────────────────────── Persistencia de ejecuciones ───────────────────────── */

const JOBS_FILE = () => dataFile('category-extractions.json');
const RESULTS_DIR = () => path.join(DATA_DIR, 'category-extractions');
const KEEP_JOBS = 30;
const KEEP_RESULTS = 10;

const readJobs = (): ExtractionJob[] => readJsonArrayFile<ExtractionJob>(JOBS_FILE());
const writeJobs = (jobs: ExtractionJob[]) => writeJsonArrayFile(JOBS_FILE(), jobs.slice(-KEEP_JOBS));

/** Sección crítica SÍNCRONA (sin await): leer → modificar → escribir. Evita carreras entre peticiones del mismo proceso. */
function updateJobs<T>(fn: (jobs: ExtractionJob[]) => T): T {
  const jobs = readJobs();
  const result = fn(jobs);
  writeJobs(jobs);
  return result;
}

const patchJob = (id: string, patch: Partial<ExtractionJob>): ExtractionJob | undefined =>
  updateJobs((jobs) => {
    const job = jobs.find((j) => j.id === id);
    if (!job) return undefined;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return { ...job };
  });

export function getJob(id: string): ExtractionJob | undefined {
  return readJobs().find((j) => j.id === id);
}

export function activeJob(): ExtractionJob | undefined {
  return [...readJobs()].reverse().find((j) => ACTIVE.has(j.status));
}

export function latestJob(): ExtractionJob | undefined {
  return readJobs().slice(-1)[0];
}

interface StoredResult { records: unknown[]; summary: ResultSummary }

function resultFile(id: string): string {
  return path.join(RESULTS_DIR(), `${id.replace(/[^a-z0-9-]/gi, '')}.json`);
}

function saveResult(id: string, data: StoredResult): void {
  fs.mkdirSync(RESULTS_DIR(), { recursive: true });
  const file = resultFile(id);
  fs.writeFileSync(file + '.tmp', JSON.stringify(data));
  fs.renameSync(file + '.tmp', file);
  const files = fs.readdirSync(RESULTS_DIR()).filter((f) => f.endsWith('.json')).map((f) => ({ f, t: fs.statSync(path.join(RESULTS_DIR(), f)).mtimeMs })).sort((a, b) => a.t - b.t);
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_RESULTS))) fs.rmSync(path.join(RESULTS_DIR(), old.f), { force: true });
}

export function readResult(id: string): StoredResult | undefined {
  try { return JSON.parse(fs.readFileSync(resultFile(id), 'utf8')) as StoredResult; } catch { return undefined; }
}

/* ───────────────────────── Operaciones ───────────────────────── */

const todayKey = () => new Date().toISOString().slice(0, 10);

/**
 * Inicia una extracción. Idempotente: si ya hay una en curso para la MISMA URL y límite devuelve esa (doble clic,
 * recarga, reintento); si hay otra distinta se rechaza (409). No hay reintentos automáticos: cada ejecución cuesta.
 */
export async function startExtraction(rawUrl: unknown, rawLimit: unknown, rawSource: unknown = 'amazon'): Promise<{ job: ExtractionJob; reused: boolean }> {
  const config = extractionConfig();
  if (rawSource !== undefined && rawSource !== 'amazon' && rawSource !== 'temu') throw new ExtractionError('Origen no válido: usa Amazon o Temu.');
  const source: ExtractionSource = rawSource === 'temu' ? 'temu' : 'amazon';
  if (!config.configured) throw new ExtractionError('La extracción de categorías no está configurada: falta APIFY_TOKEN en el servidor.', 503);
  let url: string;
  let urlKind: UrlKind = 'category';
  if (source === 'temu') {
    const checked = validateTemuUrl(rawUrl);
    url = checked.url;
    urlKind = checked.kind;
  } else {
    url = validateCategoryUrl(rawUrl);
  }
  // Una URL de producto de Temu devuelve UN producto: el límite efectivo es 1 (se valida igualmente lo que llegó).
  const requested = validateLimit(rawLimit ?? config.defaultLimit, config.maxLimit);
  const limit = source === 'temu' && urlKind === 'product' ? 1 : requested;
  const maxCostUsd = source === 'temu' ? maxTemuChargeFor(limit, config.maxCostUsd) : maxChargeFor(limit, config.maxCostUsd);

  // Reserva SÍNCRONA antes de llamar a Apify: una segunda petición simultánea ve la ejecución «starting».
  const reservation = updateJobs((jobs) => {
    const active = [...jobs].reverse().find((j) => ACTIVE.has(j.status));
    if (active) return { kind: 'active' as const, job: { ...active } };
    const today = jobs.filter((j) => j.createdAt.slice(0, 10) === todayKey()).length;
    if (today >= config.maxRunsPerDay) return { kind: 'quota' as const };
    const now = new Date().toISOString();
    const job: ExtractionJob = { id: crypto.randomUUID(), source, urlKind, url, limit, status: 'starting', createdAt: now, updatedAt: now, maxCostUsd };
    jobs.push(job);
    return { kind: 'new' as const, job: { ...job } };
  });

  if (reservation.kind === 'quota') throw new ExtractionError(`Se alcanzó el máximo de ${config.maxRunsPerDay} extracciones al día.`, 429);
  if (reservation.kind === 'active') {
    if (reservation.job.url === url && reservation.job.limit === limit && (reservation.job.source ?? 'amazon') === source) return { job: reservation.job, reused: true };
    throw new ExtractionError('Ya hay una extracción en curso. Espera a que termine o cancélala antes de lanzar otra.', 409, reservation.job);
  }

  const job = reservation.job;
  try {
    const temu = source === 'temu';
    const query = `?timeout=${config.timeoutSecs}&maxTotalChargeUsd=${maxCostUsd}${temu ? `&memory=${TEMU_MEMORY_MB}` : ''}`;
    const data = await apify(`/actors/${encodeURIComponent(temu ? config.temuActor : config.actor)}/runs${query}`, { method: 'POST', body: temu ? buildTemuInput(url, limit) : buildActorInput(url, limit) });
    const run = data?.data ?? {};
    if (!run.id) throw new ExtractionError('Apify no devolvió el identificador de la ejecución.', 502);
    const patched = patchJob(job.id, { runId: String(run.id), datasetId: run.defaultDatasetId ? String(run.defaultDatasetId) : undefined, status: 'running' });
    // Si se pidió cancelar mientras se creaba la ejecución, se aborta en cuanto existe.
    if (patched?.cancelRequested) await cancelExtraction(job.id).catch(() => undefined);
    return { job: getJob(job.id) ?? job, reused: false };
  } catch (error) {
    const message = error instanceof ExtractionError ? error.message : 'No se pudo iniciar la extracción.';
    // Un fallo de red al crear PUEDE haber creado la ejecución: se avisa; no se reintenta solo (evita duplicarla).
    const network = error instanceof ExtractionError && error.status === 502 && /contactar/.test(error.message);
    const failed = patchJob(job.id, { status: 'failed', finishedAt: new Date().toISOString(), error: network ? `${message} Si el fallo fue de red, comprueba en la consola de Apify que no se haya creado una ejecución.` : message });
    throw new ExtractionError(failed?.error ?? message, error instanceof ExtractionError ? error.status : 500, failed);
  }
}

const STATUS_MAP: Record<string, JobStatus> = {
  READY: 'running', RUNNING: 'running', 'TIMING-OUT': 'running', ABORTING: 'aborting',
  SUCCEEDED: 'succeeded', FAILED: 'failed', ABORTED: 'aborted', 'TIMED-OUT': 'timed_out',
};

const fetching = new Set<string>();

/** Consulta el estado en Apify y, al terminar, lee y adapta los resultados (sin esperar: `waitForFinish` = 0). */
export async function refreshExtraction(id: string): Promise<{ job: ExtractionJob; records?: unknown[] } | undefined> {
  let job = getJob(id);
  if (!job) return undefined;
  if (ACTIVE.has(job.status) && job.runId) {
    try {
      const data = await apify(`/actor-runs/${encodeURIComponent(job.runId)}`);
      const run = data?.data ?? {};
      const status = STATUS_MAP[String(run.status)] ?? job.status;
      const patch: Partial<ExtractionJob> = { status };
      if (typeof run.usageTotalUsd === 'number') patch.costUsd = Math.round(run.usageTotalUsd * 10000) / 10000;
      if (run.defaultDatasetId) patch.datasetId = String(run.defaultDatasetId);
      if (TERMINAL.has(status)) patch.finishedAt = typeof run.finishedAt === 'string' ? run.finishedAt : new Date().toISOString();
      if (status === 'failed') patch.error = 'La ejecución de Apify terminó con error.' + (run.statusMessage ? ` ${String(run.statusMessage).replace(/[\r\n]+/g, ' ').slice(0, 160)}` : '');
      if (status === 'timed_out') patch.error = 'La ejecución superó el tiempo máximo y Apify la detuvo.';
      job = patchJob(id, patch) ?? job;
      if (ACTIVE.has(status) && job.datasetId) {
        const meta = await apify(`/datasets/${encodeURIComponent(job.datasetId)}`).catch(() => undefined);
        const count = meta?.data?.itemCount;
        if (typeof count === 'number') job = patchJob(id, { itemsSoFar: count }) ?? job;
      }
    } catch (error) {
      // Un fallo puntual al consultar NO cambia el estado de la ejecución (se reintenta en la siguiente consulta).
      return { job: { ...job, error: error instanceof ExtractionError ? error.message : job.error } };
    }
  }
  if (TERMINAL.has(job.status) && job.datasetId && !job.resultReady && !fetching.has(id)) {
    fetching.add(id);
    try {
      job = (await collectResult(job)) ?? job;
    } finally {
      fetching.delete(id);
    }
  }
  if (job.resultReady) {
    const stored = readResult(id);
    return { job, records: stored?.records };
  }
  return { job };
}

async function collectResult(job: ExtractionJob): Promise<ExtractionJob | undefined> {
  const warnings: string[] = [];
  let items: unknown[] = [];
  try {
    // Se pide limit+1 sólo para DETECTAR que el actor devolvió de más (el límite ya viaja en la entrada del actor).
    const data = await apify(`/datasets/${encodeURIComponent(job.datasetId as string)}/items?format=json&limit=${job.limit + 1}`);
    items = Array.isArray(data) ? data : [];
  } catch (error) {
    return patchJob(job.id, { error: error instanceof ExtractionError ? error.message : 'No se pudieron leer los resultados.' });
  }
  if (items.length > job.limit) {
    warnings.push(`el_actor_devolvio_mas_de_${job.limit}_productos:se_conservan_los_primeros_${job.limit}`);
    items = items.slice(0, job.limit);
  }
  // APROXIMACIÓN: el dataset de Amazon no trae la hora de observación de cada producto; se usa el fin de la ejecución,
  // que es posterior a la lectura real de cada página (puede diferir de ella en minutos). No es la hora exacta de captura.
  const capturedAt = job.finishedAt;
  const ctx = { capturedAt, runId: job.runId, resolveCategory: resolveCatalogCategory };
  const temu = job.source === 'temu';
  const records = items.map((item) => (temu ? (isApifyTemuItem(item) ? adaptApifyTemuItem(item, ctx) : item) : isApifyAmazonItem(item) ? adaptApifyAmazonItem(item, ctx) : item));
  // Un resultado vacío NO prueba que la categoría esté vacía (el actor avisa de que Temu a veces no la sirve).
  if (temu && !items.length && job.status === 'succeeded') warnings.push('sin_resultados_no_prueba_que_la_categoria_este_vacia');
  const metas = records.map((r) => ((r as any)?.__import ?? { errors: [], review: [] }) as { errors: string[]; review: string[] });
  const partial = job.status !== 'succeeded' || items.length < job.limit;
  const summary: ResultSummary = {
    fetched: items.length,
    adapted: records.length,
    actorErrors: metas.filter((m) => m.errors.length).length,
    withReview: metas.filter((m) => m.review.length).length,
    partial,
    warnings,
  };
  saveResult(job.id, { records, summary });
  return patchJob(job.id, { resultReady: true, itemsSoFar: items.length, summary });
}

/**
 * Elementos CRUDOS del dataset de Apify de una extracción (sin adaptar), para diagnóstico y para conservar muestras reales.
 * Es una lectura (no lanza ni cobra ejecuciones) y está limitada al tamaño de la extracción; el dataset sólo existe en Apify
 * durante su periodo de retención.
 */
export async function readRawItems(id: string): Promise<unknown[] | undefined> {
  const job = getJob(id);
  if (!job?.datasetId) return undefined;
  const data = await apify(`/datasets/${encodeURIComponent(job.datasetId)}/items?format=json&limit=${job.limit + 1}`);
  return Array.isArray(data) ? data.slice(0, job.limit) : [];
}

/** Cancela: aborta la ejecución EN APIFY (deja de generar y de cobrar) y conserva los resultados parciales. */
export async function cancelExtraction(id: string): Promise<ExtractionJob> {
  const job = getJob(id);
  if (!job) throw new ExtractionError('No existe esa extracción.', 404);
  if (!ACTIVE.has(job.status)) return job;
  if (!job.runId) {
    // Todavía se está creando la ejecución: se abortará en cuanto exista.
    return patchJob(id, { cancelRequested: true }) ?? job;
  }
  await apify(`/actor-runs/${encodeURIComponent(job.runId)}/abort`, { method: 'POST' });
  return patchJob(id, { status: 'aborting', cancelRequested: true }) ?? job;
}

export const isActive = (job?: ExtractionJob): boolean => Boolean(job && ACTIVE.has(job.status));
