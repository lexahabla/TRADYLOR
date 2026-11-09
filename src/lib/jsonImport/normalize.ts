/**
 * ==============================================================================
 * TREIDILOR — IMPORTACIÓN JSON · NORMALIZACIÓN Y VALIDACIÓN
 * ==============================================================================
 * Convierte cada registro del JSON (formato Treidilor anidado, formato plano de
 * herramientas externas o JSON estructurado de ScraperAPI-Amazon) en un
 * `CanonicalRecord` o lo rechaza con motivos concretos. Funciones puras: sin
 * ficheros, red ni IA. NO inventa datos: lo que la fuente no aporta queda
 * desconocido (`null` / `'unknown'`).
 * ==============================================================================
 */

import { canonicalProductUrl } from '../curation';
import { extractAsinFromUrl } from '../../utils/amazon';
import type { CanonicalRecord, Condition, ImportDefaults, OfferShipping, Availability } from './types';
import { readImportMeta } from './apifyAmazon';

type Any = Record<string, unknown>;

export const MAX_RECORDS = 5000;
export const MAX_BODY_CHARS = 10_000_000;
const MAX_DEPTH = 20;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/* ───────────────────────── Saneado de entrada ───────────────────────── */

/** Copia profunda sin claves peligrosas y con profundidad acotada. */
export function sanitizeJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new Error('El JSON supera la profundidad máxima permitida (20 niveles).');
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Any = {};
    for (const [key, val] of Object.entries(value as Any)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = sanitizeJson(val, depth + 1);
    }
    return out;
  }
  return value;
}

/** Texto plano: sin etiquetas HTML, espacios colapsados y longitud acotada. */
export function cleanText(value: unknown, max = 500): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function first(obj: Any, ...keys: string[]): unknown {
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return undefined;
}

function asObject(value: unknown): Any {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Any) : {};
}

/* ───────────────────────── Valores concretos ───────────────────────── */

const CURRENCY_SYMBOLS: Record<string, string> = { '€': 'EUR', '£': 'GBP', '$': 'USD' };

export function normalizeCurrency(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (/^[A-Za-z]{3}$/.test(raw)) return raw.toUpperCase();
  return CURRENCY_SYMBOLS[raw] ?? '';
}

/** Interpreta «1.299,99 €», «€29.99», 29.99… Devuelve NaN si no hay número. */
export function parsePrice(value: unknown): { value: number; currency: string } {
  if (typeof value === 'number') return { value: Number.isFinite(value) ? value : NaN, currency: '' };
  if (value && typeof value === 'object') {
    const o = value as Any;
    const inner = first(o, 'value', 'amount', 'price');
    const parsed = parsePrice(inner);
    return { value: parsed.value, currency: normalizeCurrency(first(o, 'currency', 'currencyCode')) || parsed.currency };
  }
  const text = String(value ?? '').trim();
  if (!text) return { value: NaN, currency: '' };
  let currency = '';
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) if (text.includes(symbol)) currency = code;
  const codeMatch = text.match(/\b([A-Z]{3})\b/);
  if (!currency && codeMatch) currency = normalizeCurrency(codeMatch[1]);
  const digits = text.replace(/[^0-9.,]/g, '');
  if (!/\d/.test(digits)) return { value: NaN, currency };
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // El último separador es el decimal.
    normalized = lastComma > lastDot ? digits.replace(/\./g, '').replace(',', '.') : digits.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const decimals = digits.length - lastComma - 1;
    normalized = decimals <= 2 ? digits.replace(',', '.') : digits.replace(/,/g, '');
  } else if (lastDot >= 0) {
    const decimals = digits.length - lastDot - 1;
    normalized = decimals <= 2 ? digits : digits.replace(/\./g, '');
  } else {
    normalized = digits;
  }
  return { value: Number(normalized), currency };
}

export function normalizeCondition(value: unknown): Condition {
  const t = String(value ?? '').toLowerCase();
  if (!t.trim()) return 'unknown';
  if (/refurb|reacondicion|renewed|renovad|reconditioned/.test(t)) return 'refurbished';
  // «Abierto, sin usar» / «Open box»: condición propia (ni nuevo ni usado). Antes «open box» contaba como usado y el texto en español como desconocido.
  if (/open[- ]?box|abiert[oa]|caja abierta|opened/.test(t)) return 'open_box';
  if (/\bused\b|usad|segunda mano|pre-?owned|second.?hand|like new|open box/.test(t)) return 'used';
  if (/\bnew\b|nuevo|neuf|neu\b/.test(t)) return 'new';
  return 'unknown';
}

export function normalizeAvailability(value: unknown): Availability {
  if (value === true) return 'in_stock';
  if (value === false) return 'out_of_stock';
  const t = String(value ?? '').toLowerCase();
  if (!t.trim()) return 'unknown';
  if (/out.?of.?stock|sold.?out|agotad|no disponible|unavailable|sin stock|discontinued/.test(t)) return 'out_of_stock';
  if (/in.?stock|en stock|disponible|available|instock|limited.?availability/.test(t)) return 'in_stock';
  return 'unknown';
}

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : parsePrice(value).value;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeShipping(raw: unknown, flat: Any): OfferShipping {
  const s = asObject(raw);
  const cost = numberOrNull(first(s, 'cost', 'price', 'amount') ?? first(flat, 'shippingCost', 'shipping_cost'));
  const freeRaw = first(s, 'free', 'isFree') ?? first(flat, 'freeShipping', 'free_shipping');
  // Sólo se confirma «gratis» si la fuente lo afirma o el coste es 0.
  const free = typeof freeRaw === 'boolean' ? freeRaw : cost === 0 ? true : null;
  const days = numberOrNull(first(s, 'days', 'deliveryDays') ?? first(flat, 'shippingDays', 'deliveryDays'));
  const text = cleanText(first(s, 'text', 'info') ?? first(flat, 'shippingInfo'), 160) || undefined;
  return { cost, free, days: days === null ? null : Math.round(days), text };
}

/** ISBN-13 / EAN-13 / UPC-A / EAN-8: sólo con dígito de control válido. */
export function validGtin(value: unknown): string {
  const digits = String(value ?? '').replace(/[\s-]/g, '');
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return '';
  const body = digits.slice(0, -1).split('').reverse();
  const sum = body.reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[digits.length - 1]) ? digits : '';
}

function httpUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

/** Plataforma deducida del dominio (dato de la propia URL, no inventado). */
export function platformFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const known of ['amazon', 'aliexpress', 'ebay', 'temu', 'etsy']) if (host.includes(known)) return known;
    const parts = host.split('.');
    return (parts.length > 1 ? parts[parts.length - 2] : parts[0]) || '';
  } catch {
    return '';
  }
}

function imageList(...candidates: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (v: unknown) => {
    const item = typeof v === 'object' && v ? first(v as Any, 'url', 'src', 'link', 'large', 'hi_res') : v;
    const url = httpUrl(item);
    if (!url || !url.startsWith('https://')) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };
  for (const c of candidates) {
    if (Array.isArray(c)) c.forEach(add);
    else if (c !== undefined) add(c);
  }
  return out.slice(0, 20);
}

function specsFrom(value: unknown): Record<string, string> | undefined {
  const o = asObject(value);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    const key = cleanText(k, 80);
    const val = cleanText(v, 300);
    if (key && val) out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/* ───────────────────────── Envoltorio del JSON ───────────────────────── */

/** Extrae la lista de registros y los valores por defecto del JSON recibido. */
export function extractRecords(parsed: unknown): { records: unknown[]; defaults: ImportDefaults } {
  if (Array.isArray(parsed)) return { records: parsed, defaults: {} };
  const root = asObject(parsed);
  const list = ['products', 'items', 'records', 'results', 'data'].map((k) => root[k]).find(Array.isArray) as unknown[] | undefined;
  if (list) {
    const d = asObject(root.defaults);
    return {
      records: list,
      defaults: {
        platform: cleanText(d.platform, 60).toLowerCase() || undefined,
        currency: normalizeCurrency(d.currency) || undefined,
        sellerName: cleanText(d.sellerName, 120) || undefined,
        condition: cleanText(d.condition, 40) || undefined,
        category: cleanText(d.category, 120) || undefined,
        capturedAt: cleanText(d.capturedAt, 40) || undefined,
      },
    };
  }
  return { records: Object.keys(root).length ? [root] : [], defaults: {} };
}

/* ───────────────────────── Normalización de un registro ───────────────────────── */

export interface NormalizeOutcome {
  record?: CanonicalRecord;
  errors: string[];
}

/** Tolerancia de reloj: una fecha de captura más de 1 h en el futuro se considera no fiable. */
export const FUTURE_TOLERANCE_MS = 60 * 60 * 1000;

export type CaptureDate = { iso: string; problem?: 'ausente' | 'invalida' | 'futura' };

/**
 * FECHA DE OBSERVACIÓN (captura) de una lectura: el instante en que la FUENTE obtuvo el precio. Sale del propio registro
 * (`capturedAt`, `extractedAt`, `scrapedAt`, `timestamp`, `date`; también epoch en segundos o milisegundos) o, si el
 * envoltorio la trae, de `defaults.capturedAt`. NUNCA se confunde con la verificación del precio.
 *   · ausente   → no hay fecha de la fuente (se tratará como recibida ahora y marcada «inferida»);
 *   · inválida  → no es una fecha interpretable: se ignora (igual que ausente) y se avisa;
 *   · futura    → más de 1 h por delante del reloj del servidor: se ignora y se avisa (si se aceptara, una fecha futura
 *                 haría que TODAS las lecturas legítimas posteriores se descartaran como «anteriores»).
 */
export function parseCaptureDate(value: unknown, nowMs: number): CaptureDate {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return { iso: '', problem: 'ausente' };
  let ms: number;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{9,13}$/.test(value.trim()))) {
    const n = Number(value);
    ms = n < 1e11 ? n * 1000 : n; // segundos o milisegundos
  } else {
    ms = Date.parse(String(value).trim());
  }
  if (!Number.isFinite(ms) || ms < Date.parse('2000-01-01')) return { iso: '', problem: 'invalida' };
  if (ms > nowMs + FUTURE_TOLERANCE_MS) return { iso: '', problem: 'futura' };
  return { iso: new Date(ms).toISOString() };
}

export function normalizeRecord(rawInput: unknown, index: number, defaults: ImportDefaults = {}, nowIso = new Date().toISOString()): NormalizeOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw = asObject(rawInput);
  if (!Object.keys(raw).length) return { errors: ['registro_vacio'] };
  // Avisos / motivos de revisión / errores que dejó un adaptador de origen (p. ej. Apify Amazon) en `__import`.
  const imported = readImportMeta(raw);
  warnings.push(...imported.warnings);
  errors.push(...imported.errors);

  // Origen de cada bloque: anidado (product/variant/offer) o plano.
  const p = asObject(raw.product);
  const v = asObject(raw.variant);
  const o = asObject(raw.offer);
  const flat = raw;
  const get = (...keys: string[]) => first(o, ...keys) ?? first(flat, ...keys);
  const getP = (...keys: string[]) => first(p, ...keys) ?? first(flat, ...keys);

  const title = cleanText(getP('title', 'name', 'productName', 'product_title'), 300);
  if (title.length < 3) errors.push('falta_titulo');

  // Un ASIN explícito identifica una oferta de Amazon aunque la fuente no traiga plataforma ni URL.
  const asinRaw = cleanText(first(flat, 'asin') ?? first(p, 'asin') ?? first(o, 'asin'), 10).toUpperCase();
  const asinGiven = /^[A-Z0-9]{10}$/.test(asinRaw) ? asinRaw : '';
  let url = httpUrl(get('url', 'link', 'productUrl', 'product_url', 'offerUrl', 'canonicalUrl'));
  if (!url && asinGiven) {
    url = 'https://www.amazon.es/dp/' + asinGiven;
    warnings.push('url_construida_desde_asin');
  }
  const affiliateUrl = httpUrl(get('affiliateUrl', 'affiliate_url', 'affiliateLink')) || undefined;
  if (!url && !affiliateUrl) errors.push('falta_url_oferta');
  const offerUrl = url || affiliateUrl || '';

  // Precio y moneda (la moneda sale de la fuente o de los valores por defecto).
  const priceRaw = get('price', 'currentPrice', 'current_price', 'pricing', 'salePrice');
  const parsedPrice = parsePrice(priceRaw);
  if (!(parsedPrice.value > 0)) errors.push('precio_invalido');
  const currency = normalizeCurrency(get('currency', 'currencyCode')) || parsedPrice.currency || normalizeCurrency(defaults.currency);
  if (!currency) errors.push('falta_moneda');
  const origParsed = parsePrice(get('originalPrice', 'original_price', 'list_price', 'listPrice', 'wasPrice', 'oldPrice'));
  let originalPrice: number | undefined;
  if (Number.isFinite(origParsed.value)) {
    if (origParsed.value > parsedPrice.value) originalPrice = origParsed.value;
    else warnings.push('precio_anterior_descartado');
  }

  // Plataforma, vendedor e identificadores de oferta.
  let platform = cleanText(get('platform', 'marketplace', 'store', 'merchant', 'network'), 60).toLowerCase() || (defaults.platform ?? '');
  if (!platform && asinGiven) platform = 'amazon';
  if (!platform) {
    platform = platformFromUrl(offerUrl);
    if (platform) warnings.push('plataforma_deducida_de_url');
  }
  if (!platform) errors.push('falta_plataforma');
  const sellerName = cleanText(get('sellerName', 'seller', 'soldBy', 'vendor'), 120) || defaults.sellerName || undefined;
  const sellerId = cleanText(get('sellerId', 'seller_id', 'vendorId'), 80) || undefined;

  let asin = asinGiven;
  if (!asin && platform === 'amazon') asin = extractAsinFromUrl(offerUrl);
  const externalId = cleanText(get('externalId', 'external_id', 'offerId', 'listingId', 'itemId', 'goods_id', 'productId', 'sku'), 80) || asin || undefined;
  if (!externalId && !offerUrl) errors.push('falta_identificador_oferta');

  // Producto.
  const gtinRaw = getP('gtin', 'ean', 'upc', 'isbn', 'barcode');
  const gtin = validGtin(gtinRaw);
  if (gtinRaw && !gtin) warnings.push('gtin_invalido_descartado');
  const brand = cleanText(getP('brand', 'manufacturer'), 120) || undefined;
  const mpn = cleanText(getP('mpn', 'model', 'modelNumber', 'manufacturerPartNumber'), 80) || undefined;
  const description = cleanText(getP('description', 'summary', 'small_description'), 5000) || undefined;
  const images = imageList(getP('images', 'gallery'), getP('image', 'imageUrl', 'thumbnailImage', 'thumbnail'));
  const ratingRaw = Number(getP('rating', 'average_rating', 'stars'));
  const reviewsRaw = Number(getP('reviewsCount', 'reviews', 'total_reviews', 'ratingCount'));
  const category = cleanText(getP('category', 'categoryName'), 120) || defaults.category || undefined;

  // Variante.
  const vv = (k: string, ...alts: string[]) => cleanText(first(v, k, ...alts) ?? first(flat, k, ...alts), 80) || undefined;
  const condition = normalizeCondition(first(v, 'condition') ?? get('condition', 'itemCondition') ?? defaults.condition);

  if (errors.length) return { errors };

  const availability = normalizeAvailability(get('availability', 'inStock', 'in_stock', 'availability_status', 'stock'));
  const nowMs = Date.parse(nowIso);
  const fromRecord = parseCaptureDate(get('capturedAt', 'extractedAt', 'scrapedAt', 'timestamp', 'date'), nowMs);
  const fromDefaults = fromRecord.iso ? { iso: '' } : parseCaptureDate(defaults.capturedAt, nowMs);
  const captured = fromRecord.iso || fromDefaults.iso;
  if (!captured) {
    // Sin una fecha de la fuente utilizable: la captura se infiere (= recepción) y se explica por qué.
    if (fromRecord.problem === 'invalida') warnings.push('fecha_captura_invalida_descartada');
    else if (fromRecord.problem === 'futura') warnings.push('fecha_captura_futura_descartada');
    warnings.push('fecha_captura_inferida');
  }

  const record: CanonicalRecord = {
    index,
    product: {
      title,
      description,
      brand,
      mpn,
      gtin: gtin || undefined,
      category,
      images,
      specs: specsFrom(getP('specs', 'specifications', 'attributes', 'product_information')),
      rating: Number.isFinite(ratingRaw) && ratingRaw > 0 && ratingRaw <= 5 ? ratingRaw : undefined,
      reviewsCount: Number.isFinite(reviewsRaw) && reviewsRaw >= 0 ? Math.round(reviewsRaw) : undefined,
    },
    variant: {
      condition,
      color: vv('color', 'colour'),
      size: vv('size', 'talla'),
      capacity: vv('capacity', 'capacidad', 'storage'),
      pack: vv('pack', 'quantity', 'unitCount'),
    },
    offer: {
      platform,
      sellerId,
      sellerName,
      externalId,
      url: offerUrl,
      canonicalUrl: canonicalProductUrl(offerUrl),
      affiliateUrl,
      price: parsedPrice.value,
      currency,
      originalPrice,
      availability,
      shipping: normalizeShipping(o.shipping ?? flat.shipping, { ...flat, ...o }),
      condition,
      capturedAt: captured || nowIso,
      capturedAtInferred: captured ? undefined : true,
    },
    warnings,
    reviewReasons: imported.review.length ? imported.review : undefined,
  };
  return { record, errors: [] };
}
