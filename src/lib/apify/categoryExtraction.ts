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
  /** Categorías de Temu en DOS FASES: 1) descubrir identificadores; 2) fichas españolas por /es/-g-<id>.html en una sola ejecución. */
  twoPhase?: boolean;
  phase?: 'discovery' | 'detail_starting' | 'detail';
  /** Ejecuciones de Apify reservadas / realmente lanzadas por este trabajo (cuotas diarias). */
  runsReserved?: number;
  runsStarted?: number;
  /** Presupuesto máximo explícito de TODO el trabajo (USD), si se indicó. */
  budgetUsd?: number;
  discovery?: DiscoveryInfo;
  /** El coste ya se volvió a consultar tras el margen de consolidación de Apify (el uso puede tardar en cerrarse). */
  costSettled?: boolean;
  /** Fase 2: nº de URL /es/-g-<id> enviadas al actor en su única ejecución. */
  detailUrlsSent?: number;
}

export interface DiscoveryInfo {
  /** Identificadores únicos descubiertos (sólo ids: no se guarda ningún precio ni dato comercial de la fase 1). */
  ids: string[];
  fetched: number;
  duplicatesRemoved: number;
  invalidIds: number;
  costUsd?: number;
  runId?: string;
  /** El coste de la fase 1 ya se consolidó (el uso de Apify puede cerrarse tarde). */
  costSettled?: boolean;
  /** Descubrimiento reutilizado de un intento anterior (no se repitió ni se volvió a cobrar). */
  reused?: boolean;
  reusedFromJob?: string;
}

export interface PhasesSummary {
  discovered: number;
  duplicatesRemoved: number;
  obtained: number;
  /** Descubiertos pero sin ficha española devuelta por el actor. */
  unavailable: number;
  /** Fichas españolas devueltas como agotadas (se conservan como tales). */
  outOfStock: number;
  missing: Array<{ id: string; reason: string; code?: string }>;
  /** Límite solicitado y filas que listó la categoría (para explicar la diferencia hasta lo pedido). */
  requested?: number;
  discoveryRows?: number;
  /** Ausentes que el origen declara inexistentes/retirados en el mercado español, y ausentes por error del origen. */
  notInSpain?: number;
  sourceErrors?: number;
  /** Los motivos de los ausentes proceden del diagnóstico del propio actor (SOURCE_SUMMARY). */
  explained?: boolean;
  discoveryCostUsd?: number;
  detailCostUsd?: number;
  reusedDiscovery?: boolean;
}

export interface ResultSummary {
  fetched: number;
  adapted: number;
  actorErrors: number;
  withReview: number;
  partial: boolean;
  warnings: string[];
  /** Monedas de los registros adaptados (p. ej. { EUR: 10 }): se muestran ANTES de importar. */
  currencies?: Record<string, number>;
  /** Se pidió el mercado español (/es/) pero el actor respondió con otro (p. ej. USD de EE. UU.). */
  marketMismatch?: boolean;
  /** Sólo en categorías de Temu por dos fases. */
  phases?: PhasesSummary;
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
  // Los parámetros de seguimiento (_x_sessn_id, refer_page_*, opt_level…) no aportan nada al actor: se envía la URL limpia.
  if (!/[?&]goods_id=/.test(url.search)) url.search = '';
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
export function buildTemuInput(url: string | string[], limit: number, getDetails?: boolean): Record<string, unknown> {
  const urls = (Array.isArray(url) ? url : [url]).map((u) => ({ url: u }));
  return { startUrls: urls, maxItems: limit, getProductDetails: getDetails ?? process.env.APIFY_TEMU_GET_DETAILS !== 'false', extractReviews: false };
}

/** URL individual española de un producto de Temu (el actor respeta /es/ en las fichas individuales). */
export const temuEsProductUrl = (id: string): string => `https://www.temu.com/es/-g-${id}.html`;

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

/** Tope de la fase «Descubriendo productos» (sin detalle: arranque + listado por producto, con margen). */
export function maxTemuDiscoveryChargeFor(limit: number, cap = extractionConfig().maxCostUsd): number {
  return Math.min(cap, Math.max(0.05, Math.round((TEMU_START_USD + limit * 0.006) * 1.5 * 1000) / 1000));
}

/** Presupuesto máximo explícito del trabajo: entre 0,05 USD y el tope del servidor. */
export function validateBudget(raw: unknown, cap = extractionConfig().maxCostUsd): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0.05 || n > cap) throw new ExtractionError(`El presupuesto máximo debe estar entre 0,05 y ${cap} USD.`);
  return Math.round(n * 1000) / 1000;
}

/** Estimación (NO medida) de las dos fases: descubrimiento sin detalle + fichas con detalle. */
export function estimateTemuTwoPhaseEstimate(limit: number): number {
  return Math.round((TEMU_START_USD + limit * 0.006 + TEMU_START_USD + limit * TEMU_MEASURED_PER_PRODUCT_USD) * 1000) / 1000;
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
const round4 = (n: number) => Math.round(n * 10000) / 10000;
/** Ejecuciones de Apify que cuenta un trabajo en la cuota diaria (los trabajos antiguos sin el campo cuentan 1). */
const runsCounted = (j: ExtractionJob): number =>
  j.runsReserved === undefined && j.runsStarted === undefined ? 1 : ACTIVE.has(j.status) ? Math.max(j.runsReserved ?? 1, j.runsStarted ?? 0) : j.runsStarted ?? j.runsReserved ?? 1;

/**
 * Inicia una extracción. Idempotente: si ya hay una en curso para la MISMA URL y límite devuelve esa (doble clic,
 * recarga, reintento); si hay otra distinta se rechaza (409). No hay reintentos automáticos: cada ejecución cuesta.
 *
 * Categorías de Temu → DOS FASES (el actor sirve algunas categorías en USD aunque la URL lleve /es/, pero respeta /es/ en las fichas
 * individuales): 1) «Descubriendo productos» (sin detalle; sólo se guardan los ids) y 2) «Obteniendo fichas de España»: una única
 * ejecución con una URL /es/-g-<id>.html por producto. Ambas fases cuentan en la cuota; un reintento tras un fallo de la fase 2
 * reutiliza los ids ya descubiertos (no repite ni cobra la fase 1).
 */
export async function startExtraction(rawUrl: unknown, rawLimit: unknown, rawSource: unknown = 'amazon', rawBudget?: unknown): Promise<{ job: ExtractionJob; reused: boolean }> {
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
  const twoPhase = source === 'temu' && urlKind === 'category';
  const budgetUsd = validateBudget(rawBudget, config.maxCostUsd);
  const maxCostUsd =
    budgetUsd ??
    (twoPhase
      ? Math.min(config.maxCostUsd, round4(maxTemuDiscoveryChargeFor(limit, config.maxCostUsd) + maxTemuChargeFor(limit, config.maxCostUsd)))
      : source === 'temu'
        ? maxTemuChargeFor(limit, config.maxCostUsd)
        : maxChargeFor(limit, config.maxCostUsd));

  // Reserva SÍNCRONA antes de llamar a Apify: una segunda petición simultánea ve la ejecución «starting».
  const reservation = updateJobs((jobs) => {
    const active = [...jobs].reverse().find((j) => ACTIVE.has(j.status));
    if (active) return { kind: 'active' as const, job: { ...active } };
    // Reintento tras un fallo/cancelación de la fase 2: los ids ya descubiertos se reutilizan (sin repetir la fase 1).
    const prev = twoPhase
      ? [...jobs].reverse().find((j) => j.twoPhase && j.source === 'temu' && j.url === url && j.limit === limit && j.discovery?.ids?.length && j.status !== 'succeeded' && !ACTIVE.has(j.status) && Date.now() - Date.parse(j.createdAt) < 86_400_000)
      : undefined;
    const needed = twoPhase ? (prev ? 1 : 2) : 1;
    const today = jobs.filter((j) => j.createdAt.slice(0, 10) === todayKey()).reduce((n, j) => n + runsCounted(j), 0);
    if (today + needed > config.maxRunsPerDay) return { kind: 'quota' as const, needed, today };
    const now = new Date().toISOString();
    const job: ExtractionJob = {
      id: crypto.randomUUID(), source, urlKind, url, limit, status: 'starting', createdAt: now, updatedAt: now, maxCostUsd,
      runsReserved: needed, runsStarted: 0,
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      ...(twoPhase ? { twoPhase: true, phase: prev ? ('detail_starting' as const) : ('discovery' as const) } : {}),
      ...(prev?.discovery ? { discovery: { ...prev.discovery, reused: true, reusedFromJob: prev.id, costUsd: 0 } } : {}),
    };
    jobs.push(job);
    return { kind: 'new' as const, job: { ...job } };
  });

  if (reservation.kind === 'quota') throw new ExtractionError(`Se alcanzó el máximo de ${config.maxRunsPerDay} ejecuciones de Apify al día (esta extracción necesita ${reservation.needed}; hoy hay ${reservation.today}).`, 429);
  if (reservation.kind === 'active') {
    if (reservation.job.url === url && reservation.job.limit === limit && (reservation.job.source ?? 'amazon') === source) return { job: reservation.job, reused: true };
    throw new ExtractionError('Ya hay una extracción en curso. Espera a que termine o cancélala antes de lanzar otra.', 409, reservation.job);
  }

  const job = reservation.job;
  try {
    if (twoPhase && job.phase === 'detail_starting') {
      await startDetailRun(job.id); // descubrimiento reutilizado
    } else if (twoPhase) {
      let cap = maxTemuDiscoveryChargeFor(limit, config.maxCostUsd);
      if (budgetUsd !== undefined) cap = Math.min(cap, budgetUsd);
      const query = `?timeout=${config.timeoutSecs}&maxTotalChargeUsd=${cap}&memory=${TEMU_MEMORY_MB}`;
      const data = await apify(`/actors/${encodeURIComponent(config.temuActor)}/runs${query}`, { method: 'POST', body: buildTemuInput(url, limit, false) });
      const run = data?.data ?? {};
      if (!run.id) throw new ExtractionError('Apify no devolvió el identificador de la ejecución.', 502);
      const patched = patchJob(job.id, { runId: String(run.id), datasetId: run.defaultDatasetId ? String(run.defaultDatasetId) : undefined, status: 'running', phase: 'discovery', runsStarted: 1 });
      if (patched?.cancelRequested) await cancelExtraction(job.id).catch(() => undefined);
    } else {
      const temu = source === 'temu';
      const query = `?timeout=${config.timeoutSecs}&maxTotalChargeUsd=${maxCostUsd}${temu ? `&memory=${TEMU_MEMORY_MB}` : ''}`;
      const data = await apify(`/actors/${encodeURIComponent(temu ? config.temuActor : config.actor)}/runs${query}`, { method: 'POST', body: temu ? buildTemuInput(url, limit) : buildActorInput(url, limit) });
      const run = data?.data ?? {};
      if (!run.id) throw new ExtractionError('Apify no devolvió el identificador de la ejecución.', 502);
      const patched = patchJob(job.id, { runId: String(run.id), datasetId: run.defaultDatasetId ? String(run.defaultDatasetId) : undefined, status: 'running', runsStarted: 1 });
      // Si se pidió cancelar mientras se creaba la ejecución, se aborta en cuanto existe.
      if (patched?.cancelRequested) await cancelExtraction(job.id).catch(() => undefined);
    }
    return { job: getJob(job.id) ?? job, reused: false };
  } catch (error) {
    const message = error instanceof ExtractionError ? error.message : 'No se pudo iniciar la extracción.';
    // Un fallo de red al crear PUEDE haber creado la ejecución: se avisa; no se reintenta solo (evita duplicarla).
    const network = error instanceof ExtractionError && error.status === 502 && /contactar/.test(error.message);
    const failed = patchJob(job.id, { status: 'failed', finishedAt: new Date().toISOString(), runsStarted: Math.max(1, getJob(job.id)?.runsStarted ?? 0), error: network ? `${message} Si el fallo fue de red, comprueba en la consola de Apify que no se haya creado una ejecución.` : message });
    throw new ExtractionError(failed?.error ?? message, error instanceof ExtractionError ? error.status : 500, failed);
  }
}

/** Fase 2: UNA ejecución con una URL española /es/-g-<id>.html por producto descubierto (maxItems = nº de ids). */
async function startDetailRun(jobId: string): Promise<ExtractionJob> {
  const config = extractionConfig();
  const job = getJob(jobId);
  if (!job?.discovery?.ids.length) throw new ExtractionError('No hay identificadores descubiertos para obtener las fichas.', 500);
  const ids = job.discovery.ids;
  let cap = maxTemuChargeFor(ids.length, config.maxCostUsd);
  if (job.budgetUsd !== undefined) cap = Math.min(cap, round4(job.budgetUsd - (job.discovery.costUsd ?? 0)));
  if (cap < 0.05) throw new ExtractionError('El presupuesto indicado no alcanza para la fase «Obteniendo fichas de España».', 400);
  const query = `?timeout=${config.timeoutSecs}&maxTotalChargeUsd=${cap}&memory=${TEMU_MEMORY_MB}`;
  const data = await apify(`/actors/${encodeURIComponent(config.temuActor)}/runs${query}`, { method: 'POST', body: buildTemuInput(ids.map(temuEsProductUrl), ids.length, true) });
  const run = data?.data ?? {};
  if (!run.id) throw new ExtractionError('Apify no devolvió el identificador de la ejecución de fichas.', 502);
  const patched = patchJob(jobId, { runId: String(run.id), datasetId: run.defaultDatasetId ? String(run.defaultDatasetId) : undefined, status: 'running', phase: 'detail', runsStarted: (getJob(jobId)?.runsStarted ?? 0) + 1, itemsSoFar: 0, detailUrlsSent: ids.length });
  if (patched?.cancelRequested) await cancelExtraction(jobId).catch(() => undefined);
  return getJob(jobId) ?? job;
}

function phasesOf(job: ExtractionJob, obtained: number, outOfStock: number, missing: Array<{ id: string; reason: string; code?: string }>, explained = false): PhasesSummary {
  const d = job.discovery;
  return {
    requested: job.limit,
    discoveryRows: d?.fetched,
    notInSpain: missing.filter((m) => m.code === 'GOODS_NOT_EXIST').length,
    sourceErrors: missing.filter((m) => m.code === 'SOURCE_ERROR').length,
    ...(explained ? { explained: true } : {}),
    discovered: d?.ids.length ?? 0,
    duplicatesRemoved: d?.duplicatesRemoved ?? 0,
    obtained,
    unavailable: missing.length,
    outOfStock,
    missing,
    discoveryCostUsd: d?.costUsd,
    detailCostUsd: typeof job.costUsd === 'number' ? round4(Math.max(0, job.costUsd - (d?.costUsd ?? 0))) : undefined,
    ...(d?.reused ? { reusedDiscovery: true } : {}),
  };
}

/** SOURCE_SUMMARY del actor (de sólo lectura): resultado por URL pedida. Mejor esfuerzo: devuelve undefined si no se puede leer. */
async function readSourceSummary(runId: string | undefined): Promise<any | undefined> {
  if (!runId) return undefined;
  try {
    const run = (await apify(`/actor-runs/${encodeURIComponent(runId)}`))?.data;
    if (!run?.defaultKeyValueStoreId) return undefined;
    return await apify(`/key-value-stores/${encodeURIComponent(String(run.defaultKeyValueStoreId))}/records/SOURCE_SUMMARY`);
  } catch {
    return undefined;
  }
}

/** Motivo concreto de cada id ausente según el diagnóstico del actor (si lo hay); si no, el motivo genérico. */
function explainMissingIds(ids: string[], summary: any, generic: string): Array<{ id: string; reason: string; code?: string }> {
  const samples: any[] = Array.isArray(summary?.samples) ? summary.samples : [];
  const byUrl = new Map<string, any>();
  for (const sample of samples) byUrl.set(String(sample?.requestedUrl ?? ''), sample);
  return ids.map((id) => {
    const sample = byUrl.get(temuEsProductUrl(id));
    if (!sample) return { id, reason: generic };
    const code = String(sample.code ?? '');
    const why = String(sample.reason ?? '').replace(/[\r\n]+/g, ' ').slice(0, 160);
    if (code === 'EMPTY_RESULT' && /GOODS_NOT_EXIST|delisted|does not exist/i.test(why)) {
      return { id, code: 'GOODS_NOT_EXIST', reason: 'No existe o está retirado en el mercado español (Temu: GOODS_NOT_EXIST, HTTP ' + (sample.status ?? '404') + ')' };
    }
    if (code === 'SOURCE_ERROR') return { id, code, reason: 'Error del origen: «' + why + '». Puede ser transitorio: no prueba que el producto no exista en España' };
    if (code === 'TARGET_BLOCKED') return { id, code, reason: 'Temu bloqueó la petición de esta ficha' };
    if (code === 'UNSUPPORTED_MARKET') return { id, code, reason: 'El actor no admite este mercado para esta ficha' };
    return { id, code: code || undefined, reason: (code ? code + ': ' : '') + (why || generic) };
  });
}

/** Termina el trabajo sin fichas (fase 1 vacía, fallida o cancelada): resultado vacío y explicado. */
function finishEmpty(job: ExtractionJob, status: JobStatus, error: string | undefined, warnings: string[] = []): ExtractionJob {
  const summary: ResultSummary = { fetched: 0, adapted: 0, actorErrors: 0, withReview: 0, partial: status !== 'succeeded', warnings, currencies: {}, marketMismatch: false, phases: phasesOf(job, 0, 0, []) };
  saveResult(job.id, { records: [], summary });
  return patchJob(job.id, { status, finishedAt: new Date().toISOString(), error, resultReady: true, itemsSoFar: 0, summary }) ?? job;
}

/** Fase 1 («Descubriendo productos») y transición a la fase 2. Seguro ante consultas simultáneas: sólo una arranca la fase 2. */
async function advanceTwoPhase(job: ExtractionJob): Promise<ExtractionJob> {
  const id = job.id;
  if (job.phase === 'detail_starting') {
    // Otra petición está lanzando la fase 2. Si se quedó colgada, se falla de forma explicada (los ids se conservan para reintentar).
    if (!job.runId && Date.now() - Date.parse(job.updatedAt) > 120_000) {
      return patchJob(id, { status: 'failed', finishedAt: new Date().toISOString(), error: 'No se pudo iniciar la fase «Obteniendo fichas de España». Los identificadores descubiertos se conservan: al reintentar no se repite el descubrimiento.' }) ?? job;
    }
    return job;
  }
  if (!job.runId) return job;
  try {
    const data = await apify(`/actor-runs/${encodeURIComponent(job.runId)}`);
    const run = data?.data ?? {};
    const status = STATUS_MAP[String(run.status)] ?? job.status;
    const usage = typeof run.usageTotalUsd === 'number' ? round4(run.usageTotalUsd) : undefined;
    if (ACTIVE.has(status)) {
      let current = patchJob(id, { status, ...(usage !== undefined ? { costUsd: usage } : {}) }) ?? job;
      if (current.datasetId) {
        const meta = await apify(`/datasets/${encodeURIComponent(current.datasetId)}`).catch(() => undefined);
        const count = meta?.data?.itemCount;
        if (typeof count === 'number') current = patchJob(id, { itemsSoFar: count }) ?? current;
      }
      return current;
    }
    if (status !== 'succeeded') {
      const why = status === 'timed_out' ? 'La fase «Descubriendo productos» superó el tiempo máximo y Apify la detuvo.' : status === 'aborted' ? 'Cancelado durante «Descubriendo productos»: no se obtuvieron fichas.' : 'La fase «Descubriendo productos» terminó con error en Apify.';
      return finishEmpty({ ...job, costUsd: usage ?? job.costUsd }, status, why);
    }
    // Descubrimiento terminado: sólo se leen los identificadores (ni precios ni datos comerciales).
    const items = await apify(`/datasets/${encodeURIComponent(job.datasetId as string)}/items?format=json&fields=goodsId&limit=${job.limit + 1}`);
    let list = Array.isArray(items) ? items : [];
    const warnings: string[] = [];
    if (list.length > job.limit) {
      warnings.push(`el_actor_devolvio_mas_de_${job.limit}_productos_en_el_descubrimiento:se_conservan_los_primeros_${job.limit}`);
      list = list.slice(0, job.limit);
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    let duplicates = 0;
    let invalid = 0;
    for (const it of list) {
      const gid = String((it as any)?.goodsId ?? '').trim();
      if (!/^[0-9]{6,20}$/.test(gid)) { invalid += 1; continue; }
      if (seen.has(gid)) { duplicates += 1; continue; }
      seen.add(gid);
      ids.push(gid);
    }
    const info: DiscoveryInfo = { ids, fetched: list.length, duplicatesRemoved: duplicates, invalidIds: invalid, costUsd: usage, runId: job.runId };
    if (!ids.length) {
      return finishEmpty({ ...job, discovery: info, costUsd: usage }, 'succeeded', undefined, [...warnings, 'sin_resultados_no_prueba_que_la_categoria_este_vacia']);
    }
    // Reclamo atómico de la fase 2 (una sola petición la lanza).
    const claim = updateJobs((jobs) => {
      const j = jobs.find((x) => x.id === id);
      if (!j || j.phase !== 'discovery') return 'lost' as const;
      j.discovery = info;
      j.costUsd = usage;
      j.updatedAt = new Date().toISOString();
      if (j.cancelRequested) return 'cancelled' as const;
      j.phase = 'detail_starting';
      j.runId = undefined;
      j.datasetId = undefined;
      j.itemsSoFar = 0;
      return 'ok' as const;
    });
    if (claim === 'lost') return getJob(id) ?? job;
    if (claim === 'cancelled') return finishEmpty({ ...(getJob(id) ?? job), discovery: info, costUsd: usage }, 'aborted', 'Cancelado tras «Descubriendo productos»: no se obtuvieron fichas.', warnings);
    try {
      return await startDetailRun(id);
    } catch (error) {
      const message = error instanceof ExtractionError ? error.message : 'No se pudo iniciar la fase de fichas.';
      return patchJob(id, { status: 'failed', finishedAt: new Date().toISOString(), runsStarted: Math.max(1, getJob(id)?.runsStarted ?? 0), error: `No se pudo iniciar «Obteniendo fichas de España»: ${message} Los identificadores descubiertos se conservan: al reintentar no se repite el descubrimiento.` }) ?? job;
    }
  } catch (error) {
    // Un fallo puntual al consultar NO cambia el estado (se reintenta en la siguiente consulta).
    return { ...job, error: error instanceof ExtractionError ? error.message : job.error };
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
  if (job.twoPhase && ACTIVE.has(job.status) && (job.phase === 'discovery' || job.phase === 'detail_starting')) {
    job = await advanceTwoPhase(job);
    if (job.resultReady) return { job, records: readResult(id)?.records };
    return { job };
  }
  if (ACTIVE.has(job.status) && job.runId) {
    try {
      const data = await apify(`/actor-runs/${encodeURIComponent(job.runId)}`);
      const run = data?.data ?? {};
      const status = STATUS_MAP[String(run.status)] ?? job.status;
      const patch: Partial<ExtractionJob> = { status };
      // En dos fases el coste del trabajo es el de la fase 1 más el de la ejecución actual.
      if (typeof run.usageTotalUsd === 'number') patch.costUsd = round4(run.usageTotalUsd + (job.discovery?.costUsd ?? 0));
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
  job = (await settleCost(job)) ?? job;
  job = (await explainMissing(job)) ?? job;
  if (job.resultReady) {
    const stored = readResult(id);
    return { job, records: stored?.records };
  }
  return { job };
}

/**
 * Apify puede tardar unos segundos en cerrar el uso de una ejecución: al terminar, el coste leído puede estar incompleto. Pasado un
 * margen se vuelve a consultar UNA vez (lectura, sin coste) y se marca como consolidado. En dos fases se suma la fase 1.
 */
/** Trabajos terminados antes de este diagnóstico: se explican los ausentes UNA vez con el SOURCE_SUMMARY del actor (lectura, gratis). */
async function explainMissing(job: ExtractionJob): Promise<ExtractionJob | undefined> {
  const p = job.summary?.phases;
  if (!job.twoPhase || !p || p.explained || !p.missing.length || !job.runId || !job.resultReady) return job;
  const diag = await readSourceSummary(job.runId);
  if (diag === undefined) return job; // se reintentará en la siguiente consulta
  const missing = explainMissingIds(p.missing.map((m) => m.id), diag, p.missing[0]?.reason ?? 'No disponible');
  const phases: PhasesSummary = { ...p, missing, requested: job.limit, discoveryRows: job.discovery?.fetched, notInSpain: missing.filter((m) => m.code === 'GOODS_NOT_EXIST').length, sourceErrors: missing.filter((m) => m.code === 'SOURCE_ERROR').length, explained: true };
  const summary: ResultSummary = { ...(job.summary as ResultSummary), phases };
  const stored = readResult(job.id);
  if (stored) saveResult(job.id, { ...stored, summary });
  return patchJob(job.id, { summary }) ?? job;
}

const SETTLE_AFTER_MS = 90_000;
async function settleCost(job: ExtractionJob): Promise<ExtractionJob | undefined> {
  const d = job.discovery;
  const needsDiscovery = Boolean(d && d.runId && !d.reused && !d.costSettled);
  if ((job.costSettled && !needsDiscovery) || !TERMINAL.has(job.status)) return job;
  if (!job.runId && !needsDiscovery) return job;
  const finished = Date.parse(job.finishedAt ?? '');
  if (!Number.isFinite(finished) || Date.now() - finished < SETTLE_AFTER_MS) return job;
  try {
    // Fase 1: su coste también puede haberse leído antes de que Apify lo cerrara (p. ej. sólo el arranque).
    let discoveryCost = d?.costUsd ?? 0;
    let discoverySettled = d?.costSettled;
    if (needsDiscovery && d) {
      const dd = await apify(`/actor-runs/${encodeURIComponent(d.runId as string)}`);
      const du = dd?.data?.usageTotalUsd;
      if (typeof du === 'number') { discoveryCost = round4(du); discoverySettled = true; }
    }
    const patchDiscovery: Partial<ExtractionJob> = d ? { discovery: { ...d, costUsd: discoveryCost, ...(discoverySettled ? { costSettled: true } : {}) } } : {};
    if (!job.runId || job.costSettled) {
      return patchJob(job.id, { ...patchDiscovery, costUsd: round4(discoveryCost + (job.costUsd ?? 0) - (d?.costUsd ?? 0)) }) ?? job;
    }
    const data = await apify(`/actor-runs/${encodeURIComponent(job.runId)}`);
    const usage = data?.data?.usageTotalUsd;
    const patch: Partial<ExtractionJob> = { ...patchDiscovery, costSettled: true };
    if (typeof usage === 'number') {
      patch.costUsd = round4(usage + discoveryCost);
      if (job.summary?.phases) {
        const phases = { ...job.summary.phases, detailCostUsd: round4(usage), discoveryCostUsd: discoveryCost };
        patch.summary = { ...job.summary, phases };
        const stored = readResult(job.id);
        if (stored) saveResult(job.id, { ...stored, summary: patch.summary });
      }
    }
    return patchJob(job.id, patch) ?? job;
  } catch {
    return job; // se reintentará en la siguiente consulta
  }
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
  // Dos fases: sólo se aceptan las fichas de los ids descubiertos (sin repetidos); lo que no llegó se explica, no se sustituye.
  const two = job.twoPhase === true && job.discovery !== undefined;
  let missing: Array<{ id: string; reason: string; code?: string }> = [];
  let explained = false;
  if (two) {
    const wanted = new Set(job.discovery!.ids);
    const seenIds = new Set<string>();
    const kept: unknown[] = [];
    let repeated = 0;
    let foreign = 0;
    for (const it of items) {
      const gid = String((it as any)?.goodsId ?? '');
      if (!wanted.has(gid)) { foreign += 1; continue; }
      if (seenIds.has(gid)) { repeated += 1; continue; }
      seenIds.add(gid);
      kept.push(it);
    }
    if (repeated) warnings.push(`fichas_repetidas_descartadas:${repeated}`);
    if (foreign) warnings.push(`fichas_de_ids_no_solicitados_descartadas:${foreign}`);
    items = kept;
    const reason = job.status === 'succeeded'
      ? 'El actor no devolvió la ficha española de este producto (no disponible en España, retirada o bloqueada)'
      : 'La ejecución se interrumpió antes de obtener la ficha de este producto';
    const absent = job.discovery!.ids.filter((x) => !seenIds.has(x));
    if (absent.length) {
      const diag = await readSourceSummary(job.runId);
      missing = explainMissingIds(absent, diag, reason);
      explained = diag !== undefined;
    }
  } else if (items.length > job.limit) {
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
  if (temu && !items.length && job.status === 'succeeded') warnings.push(two ? 'ninguna_ficha_espanola_obtenida_de_los_ids_descubiertos' : 'sin_resultados_no_prueba_que_la_categoria_este_vacia');
  const metas = records.map((r) => ((r as any)?.__import ?? { errors: [], review: [] }) as { errors: string[]; review: string[] });
  const partial = job.status !== 'succeeded' || (!two && items.length < job.limit);
  // Monedas realmente devueltas (nunca se convierten ni se etiquetan de nuevo) y coherencia del mercado pedido.
  const currencies: Record<string, number> = {};
  for (const r of records) {
    const code = String(((r as any)?.offer?.currency ?? '') || '?');
    currencies[code] = (currencies[code] ?? 0) + 1;
  }
  const marketOfUrl = (u: unknown): string => { try { const m = new URL(String(u)).pathname.toLowerCase().match(/^\/([a-z]{2})(?:-[a-z]{2})?\//); return m ? m[1] : ''; } catch { return ''; } };
  const marketMismatch = temu && marketOfUrl(job.url) === 'es' && items.some((it) => marketOfUrl((it as any)?.sourceUrl) !== 'es');
  if (marketMismatch) warnings.push('mercado_pedido_es_pero_el_actor_respondio_con_otro');
  const summary: ResultSummary = {
    currencies,
    marketMismatch,
    fetched: items.length,
    adapted: records.length,
    actorErrors: metas.filter((m) => m.errors.length).length,
    withReview: metas.filter((m) => m.review.length).length,
    partial,
    warnings,
    ...(two ? { phases: phasesOf(job, items.length, records.filter((r) => (r as any)?.offer?.availability === false).length, missing, explained || missing.length === 0) } : {}),
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

/**
 * Diagnóstico de sólo lectura (gratis): el SOURCE_SUMMARY que el actor deja en el almacén clave-valor de cada ejecución (resultado por
 * fuente, URL pedidas/canónicas, fallos) y los datos de la ejecución. Sirve para explicar por qué faltan fichas.
 */
export async function readDiagnostics(id: string): Promise<unknown | undefined> {
  const job = getJob(id);
  if (!job) return undefined;
  const runs: Array<{ phase: string; runId?: string }> = [];
  if (job.discovery?.runId && !job.discovery.reused) runs.push({ phase: 'discovery', runId: job.discovery.runId });
  if (job.runId) runs.push({ phase: job.twoPhase ? 'detail' : 'run', runId: job.runId });
  const out: unknown[] = [];
  for (const r of runs) {
    const info: Record<string, unknown> = { phase: r.phase, runId: r.runId };
    try {
      const run = (await apify(`/actor-runs/${encodeURIComponent(r.runId as string)}`))?.data ?? {};
      Object.assign(info, { status: run.status, usageTotalUsd: run.usageTotalUsd, startedAt: run.startedAt, finishedAt: run.finishedAt, statusMessage: typeof run.statusMessage === 'string' ? run.statusMessage.slice(0, 300) : undefined, options: run.options && { memoryMbytes: run.options.memoryMbytes, timeoutSecs: run.options.timeoutSecs, maxTotalChargeUsd: run.options.maxTotalChargeUsd }, usage: run.usageUsd, chargedEventCounts: run.chargedEventCounts });
      if (run.defaultKeyValueStoreId) {
        const summary = await apify(`/key-value-stores/${encodeURIComponent(String(run.defaultKeyValueStoreId))}/records/SOURCE_SUMMARY`).catch(() => undefined);
        if (summary !== undefined) info.sourceSummary = JSON.parse(JSON.stringify(summary, (_k, v) => (typeof v === 'string' ? v.slice(0, 400) : v)));
      }
    } catch (error) {
      info.error = error instanceof ExtractionError ? error.message : 'No se pudo leer la ejecución.';
    }
    out.push(info);
  }
  return out;
}

/** Cancela: aborta la ejecución EN APIFY (deja de generar y de cobrar) y conserva los resultados parciales. */
export async function cancelExtraction(id: string): Promise<ExtractionJob> {
  const job = getJob(id);
  if (!job) throw new ExtractionError('No existe esa extracción.', 404);
  if (!ACTIVE.has(job.status)) return job;
  if (!job.runId) {
    // Todavía se está creando la ejecución (o entre las dos fases): se abortará en cuanto exista y no se lanzará la fase 2.
    return patchJob(id, { cancelRequested: true }) ?? job;
  }
  await apify(`/actor-runs/${encodeURIComponent(job.runId)}/abort`, { method: 'POST' });
  return patchJob(id, { status: 'aborting', cancelRequested: true }) ?? job;
}

export const isActive = (job?: ExtractionJob): boolean => Boolean(job && ACTIVE.has(job.status));
