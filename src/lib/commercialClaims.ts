/**
 * ==============================================================================
 * TREIDILOR — AFIRMACIONES COMERCIALES: QUÉ SE PUEDE DECIR CON EVIDENCIA
 * ==============================================================================
 * Funciones PURAS de sólo lectura (no escriben, no consultan red ni disco) que usan la ficha, el checkout y la capa de lectura de ofertas
 * para decidir qué datos comerciales pueden mostrarse como datos y cuáles son valores por defecto del código, inferencias o datos sin
 * verificar. Distinguen entre:
 *   observado     · lectura real contra la tienda (verificación: `lastPriceSync`, `extra.refresh.lastVerifiedAt`, `extra.observations`)
 *   declarado     · dato del proveedor/JSON a fecha de captura (`extra.Sincronizado`, `extra.priceReading.capturedAt`): no es «hoy»
 *   inferencia    · deducción nuestra (p. ej. «≤ 3 días ⇒ gratis»): NO se presenta como dato
 *   por defecto   · constante del código sin fuente (30 días de devolución, 100 opiniones, «Envío estándar eBay (3-5 días)»…): se oculta
 *   no disponible · «No indicado»
 * No altera ningún valor almacenado: sólo decide qué se presenta.
 * ==============================================================================
 */

import { normalizeCondition } from './jsonImport/normalize';
import type { Condition } from './jsonImport/types';

type Any = Record<string, any>;

export const NOT_INDICATED = 'No indicado';
export const NOT_VERIFIED = 'No verificado';

const fold = (v: unknown): string =>
  String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/* ───────────────────────────── Fechas ───────────────────────────── */

/** dd/mm/aaaa (hora de Madrid) o '' si la fecha no es válida. */
export function formatDateEs(iso: unknown): string {
  const ms = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid' }).format(new Date(ms));
}

const validIso = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

/**
 * Fecha en que el PROVEEDOR/JSON dio el dato (captura), nunca una verificación: `extra.Sincronizado` (catálogos de red) o la captura fiable de
 * la última lectura recibida por JSON. Una captura inferida (= recepción) no es fiable y no cuenta. null si no consta.
 */
export function captureDateOf(product: Any): string | null {
  const extra = (product?.extra ?? {}) as Any;
  const sync = validIso(extra.Sincronizado);
  if (sync) return sync;
  const reading = extra.priceReading as Any | undefined;
  if (reading && reading.capturedAtInferred !== true) return validIso(reading.capturedAt);
  return null;
}

/** Fecha de la última VERIFICACIÓN real contra la tienda (servicio de actualización). null si nunca se verificó. */
export function verifiedAtOf(product: Any): string | null {
  const extra = (product?.extra ?? {}) as Any;
  return validIso(extra?.refresh?.lastVerifiedAt) ?? validIso(product?.lastPriceSync);
}

/* ───────────────────────────── Envío ───────────────────────────── */

/** Texto de envío que el código de eBay escribe cuando la fuente NO da plazo (no es información del proveedor). */
export const EBAY_FALLBACK_SHIPPING_TEXT = 'Envío estándar eBay (3-5 días)';

export function isFallbackShippingText(text: unknown): boolean {
  return fold(text) === fold(EBAY_FALLBACK_SHIPPING_TEXT);
}

export type EbayShippingCost = { kind: 'free' } | { kind: 'paid'; amount: number };

/**
 * Coste de envío de eBay guardado en `specs['Coste de envío']` por el adaptador («Gratis» o «4.49 EUR»). Sólo textos INEQUÍVOCOS y sólo en
 * fichas de eBay; cualquier otra cosa (otra moneda, 0 EUR, texto libre) es ambiguo y devuelve null.
 */
export function parseEbayShippingCost(product: Any): EbayShippingCost | null {
  if (fold(product?.network) !== 'ebay') return null;
  const raw = (product?.specs ?? {})['Coste de envío'];
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (/^gratis$/i.test(text)) return { kind: 'free' };
  const m = text.match(/^(\d{1,4}(?:[.,]\d{1,2})?)\s*EUR$/i);
  if (!m) return null;
  const amount = Number(m[1].replace(',', '.'));
  return Number.isFinite(amount) && amount > 0 ? { kind: 'paid', amount: Math.round(amount * 100) / 100 } : null;
}

/* ───────────────────────────── Valoraciones ───────────────────────────── */

export interface RatingSupport {
  /** Valoración (0-5) sustentada, o null si no consta o es un valor por defecto. */
  rating: number | null;
  /** Nº de opiniones sustentado, o null si no se puede afirmar. */
  count: number | null;
  /** «vendedor» en eBay (la valoración es del vendedor, no del producto). */
  origin: 'producto' | 'vendedor';
  /** Motivo por el que se ocultó algo (diagnóstico). */
  hidden?: string;
}

/**
 * Qué valoración y qué recuento pueden mostrarse como datos reales.
 *  - Pareja 4,8 ★ / 100 opiniones (no Amazon, sin ScraperAPI): valores por defecto del alta (`/api/products/add`) → se ocultan ambos.
 *  - eBay 4,5 ★ / 15: valor por defecto antiguo → se ocultan ambos.
 *  - AliExpress: el conector nunca da recuento (el alta inventa 100) → el recuento sólo se muestra si lo declaró un registro JSON.
 *  - eBay: valoración y recuento son del VENDEDOR.
 */
export function ratingSupport(product: Any): RatingSupport {
  const network = fold(product?.network);
  const origin: RatingSupport['origin'] = network === 'ebay' ? 'vendedor' : 'producto';
  const r = Number(product?.rating);
  const rating = Number.isFinite(r) && r > 0 && r <= 5 ? r : null;
  const n = Number(product?.reviewsCount);
  const reviews = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  if (rating === null) return { rating: null, count: null, origin };
  const scraper = Boolean(product?.extra?.scraperApiSource);
  if (network === 'ebay' && rating === 4.5 && reviews === 15) return { rating: null, count: null, origin, hidden: 'valor_por_defecto_antiguo_de_ebay' };
  if (rating === 4.8 && reviews === 100 && !scraper && network !== 'amazon') return { rating: null, count: null, origin, hidden: 'valor_por_defecto_del_alta' };
  let count = reviews;
  if (network === 'aliexpress' && product?.extra?.importMeta?.channel !== 'json') count = null;
  return { rating, count, origin, ...(reviews !== null && count === null ? { hidden: 'recuento_por_defecto_del_alta' } : {}) };
}

/* ───────────────────────────── Descuento ───────────────────────────── */

export interface VerifiedDiscount {
  verified: boolean;
  /** Porcentaje sobre el precio anterior VERIFICADO; null si no se puede demostrar. */
  pct: number | null;
  previousPrice?: number;
  /** Fecha de la lectura que lo demuestra. */
  asOf?: string;
  /** Por qué no se verifica (diagnóstico). */
  reason?: string;
}

/**
 * Un descuento sólo es «verificado» si la ÚLTIMA observación guardada (lectura real contra la tienda, con fecha de verificación y en EUR)
 * trae un precio anterior mayor y su precio coincide con el publicado. `originalPrice > price` por sí solo es un dato DECLARADO por el comercio.
 */
export function verifiedDiscountOf(product: Any): VerifiedDiscount {
  const observations: Any[] = Array.isArray(product?.extra?.observations) ? product.extra.observations : [];
  const last = observations[observations.length - 1];
  if (!last) return { verified: false, pct: null, reason: 'sin_observaciones_verificadas' };
  const verifiedAt = validIso(last.verifiedAt);
  if (!verifiedAt) return { verified: false, pct: null, reason: 'observacion_sin_fecha_de_verificacion' };
  if (String(last.context?.currency ?? 'EUR').toUpperCase() !== 'EUR') return { verified: false, pct: null, reason: 'observacion_en_otra_moneda' };
  const price = Number(product?.price);
  const lastPrice = Number(last.price);
  const previous = Number(last.originalPrice);
  if (!(price > 0) || !(lastPrice > 0) || Math.abs(lastPrice - price) > 0.005) return { verified: false, pct: null, reason: 'la_observacion_no_corresponde_al_precio_publicado' };
  if (!(previous > price)) return { verified: false, pct: null, reason: 'la_observacion_no_trae_precio_anterior_mayor' };
  return { verified: true, pct: Math.round(((previous - price) / previous) * 1000) / 10, previousPrice: previous, asOf: verifiedAt };
}

/**
 * Descuento que SE PUEDE MOSTRAR (insignia «-N %», precio tachado, «Ahorras X €»): sólo el verificado. El `originalPrice` almacenado es un dato
 * declarado por el comercio y no se borra, pero sin verificación no se presenta como descuento. Devuelve null si no está acreditado.
 */
export function shownDiscount(product: Any): { pct: number; previousPrice: number; asOf: string } | null {
  const d = verifiedDiscountOf(product);
  if (!d.verified || d.pct === null || d.previousPrice === undefined) return null;
  const pct = Math.round(d.pct);
  return pct > 0 ? { pct, previousPrice: d.previousPrice, asOf: d.asOf ?? '' } : null;
}

/* ───────────────────────────── Condición ───────────────────────────── */

export type ReadCondition = Condition | 'open_box';

const OPEN_BOX = /abierto,?\s*sin\s*usar|open\s*box|caja\s*abierta/i;

/**
 * Condición de la ficha para la LECTURA. «Abierto, sin usar» / «Open box» es una condición propia: ni «Nuevo» ni «Usado». El resto se
 * normaliza como siempre. No modifica el normalizador del importador.
 */
export function readCondition(product: Any): ReadCondition {
  const label = String(product?.condition ?? '').trim();
  if (OPEN_BOX.test(label)) return 'open_box';
  return normalizeCondition(label);
}
