/**
 * ==============================================================================
 * TREIDILOR — CAPA DE LECTURA DE OFERTAS COMPARABLES (Etapa 1, sólo lectura)
 * ==============================================================================
 * `getComparableOffers(product)` devuelve las ofertas comerciales YA EXISTENTES de un mismo producto, listas para un futuro
 * comparador. Es una función PURA: no escribe, no consulta red y no muta la ficha ni el catálogo. No reescribe claves ni campos.
 *
 * Qué lee (reutiliza `getOffers` de catalogOffers.ts):
 *   - la oferta IMPLÍCITA (campos planos de la ficha) y las EXPLÍCITAS (`extra.offers`);
 *   - NO lee `extra.crossMerchant`: lo genera «Construir Catálogo» agrupando por similitud de título, que no es una identidad
 *     comercial fiable (se informa en `legacyCrossMerchantIgnored`).
 *
 * Identidad comercial = plataforma + identificador de anuncio + vendedor (y variante, cantidad, condición y moneda compatibles):
 *   - Vendedor: `extra.offerSeller` → `extra.Tienda` → `fulfillmentProvider`, validados (ni plataforma, ni proveedor logístico,
 *     ni valores malformados como «[object Object]»). Sin vendedor fiable: «Vendedor no indicado» (también en Amazon).
 *   - Varias fichas del MISMO anuncio y vendedor cuentan UNA vez (`collapsedProductIds`); no se fusionan ni se tocan.
 *   - Nunca se une por título, marca+modelo ni características parecidas.
 *   - Cualquier duda (variante, cantidad, condición, moneda o anuncio presente en varias fichas con otro vendedor) NO vincula:
 *     la oferta queda en `needsReview`, `otherVersions` o `excluded`, con su motivo.
 * ==============================================================================
 */

import { fold, getOffers, platformIdKey, storedOffers, type P } from './catalogOffers';
import {
  captureDateOf,
  isFallbackShippingText,
  parseEbayShippingCost,
  ratingSupport,
  readCondition,
  verifiedDiscountOf,
  type ReadCondition,
  type VerifiedDiscount,
} from './commercialClaims';
import { isPlaceholderUrl } from './productStore';
import { normalizeSourceId } from './offerIdentity';
import type { Condition, OfferShipping, StoredOffer } from './jsonImport/types';

type Any = Record<string, any>;

/** Texto fijo cuando no hay un vendedor fiable. */
export const SELLER_UNKNOWN_LABEL = 'Vendedor no indicado';
/** Texto fijo para pago, devolución, gastos de envío y plazos sin dato confirmado. */
export const NOT_INDICATED_LABEL = 'No indicado';

/* ───────────────────────────── Validación del vendedor ───────────────────────────── */

export type SellerRejection = 'vacio' | 'plataforma' | 'logistica' | 'malformado';
export type SellerSource = 'offerSeller' | 'Tienda' | 'fulfillmentProvider' | 'oferta' | 'ninguna';

export interface ResolvedSeller {
  name?: string;
  id?: string;
  /** De dónde sale el vendedor. `ninguna` = sin vendedor fiable. */
  source: SellerSource;
  /** true sólo si hay un NOMBRE de vendedor válido. */
  known: boolean;
  /** Valores descartados y por qué (diagnóstico). */
  rejected: Array<{ source: SellerSource; value: string; reason: SellerRejection }>;
}

/** Plataformas (y variantes habituales) que NO son un vendedor. */
const PLATFORM_NAMES = new Set([
  'aliexpress', 'ali express', 'aliexpress com', 'amazon', 'amazon es', 'amazon com', 'amazon eu', 'amazon spain', 'amazon espana',
  'ebay', 'ebay es', 'temu', 'etsy', 'awin', 'cj', 'cj affiliate', 'admitad', 'tradedoubler', 'kwanko', 'walmart', 'pccomponentes',
  'mediamarkt', 'fnac', 'el corte ingles',
]);
/** Proveedores EXCLUSIVAMENTE logísticos (no venden: transportan o gestionan el envío). */
const LOGISTICS_NAMES = new Set([
  'amazon logistics', 'logistica de amazon', 'logistics amazon', 'fulfilled by amazon', 'fulfillment by amazon', 'fba',
  'envios de amazon', 'dhl', 'dhl express', 'ups', 'fedex', 'seur', 'correos', 'correos express', 'gls', 'mrw', 'ctt', 'ctt express',
  'cainiao', 'cainiao shipping', 'aliexpress standard shipping', 'aliexpress shipping', 'standard shipping', 'envio estandar',
  'envio estandar gratuito', 'yanwen', 'yun express', '4px', 'sf express', 'tnt', 'usps', 'royal mail',
]);
const MALFORMED_TOKENS = new Set(['object object', 'undefined', 'null', 'nan', 'na', 'n a', 'none', 'unknown', 'desconocido', 'false', 'true']);

/** Clasifica un posible nombre de vendedor: devuelve el motivo de rechazo o null si es un vendedor válido. */
export function sellerRejection(raw: unknown, platformHints: string[] = []): SellerRejection | null {
  if (raw === null || raw === undefined) return 'vacio';
  if (typeof raw !== 'string' && typeof raw !== 'number') return 'malformado';
  const text = String(raw).trim();
  if (!text) return 'vacio';
  if (/\[object\b/i.test(text) || /^[{[]/.test(text) || /[\u0000-\u001f]/.test(text) || text.length > 120) return 'malformado';
  if (/^[-—–?*.\s]+$/.test(text) || /^\d+$/.test(text)) return 'malformado';
  const key = fold(text);
  if (!key) return 'malformado';
  if (MALFORMED_TOKENS.has(key)) return 'malformado';
  if (PLATFORM_NAMES.has(key) || platformHints.some((p) => p && fold(p) === key)) return 'plataforma';
  if (LOGISTICS_NAMES.has(key) || /\b(?:amazon|aliexpress)\b.*\b(?:logistics|shipping)\b/.test(key)) return 'logistica';
  return null;
}

/** Vendedor de una FICHA con la jerarquía aprobada: offerSeller → Tienda → fulfillmentProvider. */
export function resolveSeller(product: P): ResolvedSeller {
  const extra = (product.extra ?? {}) as Any;
  const hints = [String(product.network ?? ''), String(product.merchant ?? '')];
  const rejected: ResolvedSeller['rejected'] = [];
  const tryName = (source: SellerSource, value: unknown, id?: unknown): ResolvedSeller | null => {
    const reason = sellerRejection(value, hints);
    if (reason === null) {
      const cleanId = id !== undefined && id !== null && String(id).trim() && typeof id !== 'object' ? String(id).trim() : undefined;
      return { name: String(value).trim(), id: cleanId, source, known: true, rejected };
    }
    // Un valor ausente no se registra como rechazo; los demás sí (diagnóstico).
    if (reason !== 'vacio') rejected.push({ source, value: typeof value === 'object' ? JSON.stringify(value) : String(value), reason });
    return null;
  };
  const os = extra.offerSeller;
  if (os && typeof os === 'object' && !Array.isArray(os)) {
    const hit = tryName('offerSeller', os.name, os.id);
    if (hit) return hit;
  } else if (os !== undefined && os !== null) {
    rejected.push({ source: 'offerSeller', value: String(os), reason: 'malformado' });
  }
  const t = tryName('Tienda', extra.Tienda);
  if (t) return t;
  const f = tryName('fulfillmentProvider', product.fulfillmentProvider);
  if (f) return f;
  return { source: 'ninguna', known: false, rejected };
}

/** Vendedor de una oferta EXPLÍCITA (`extra.offers`): el nombre y el id guardados por el importador, validados. */
function sellerOfOffer(offer: StoredOffer, product: P): ResolvedSeller {
  const rejected: ResolvedSeller['rejected'] = [];
  const reason = sellerRejection(offer.sellerName, [offer.platform, String(product.network ?? ''), String(product.merchant ?? '')]);
  const id = offer.sellerId && typeof offer.sellerId === 'string' && offer.sellerId.trim() ? offer.sellerId.trim() : undefined;
  if (reason === null) return { name: String(offer.sellerName).trim(), id, source: 'oferta', known: true, rejected };
  if (reason !== 'vacio') rejected.push({ source: 'oferta', value: String(offer.sellerName), reason });
  return { source: 'ninguna', known: false, rejected };
}

/** ¿Es el mismo vendedor? Sólo si lo demuestran ids iguales (ambos con id) o nombres iguales. Sin evidencia: no. */
export function sameSeller(a: ResolvedSeller, b: ResolvedSeller): boolean {
  if (!a.known || !b.known) return false;
  if (a.id && b.id) return fold(a.id) === fold(b.id);
  return fold(a.name) !== '' && fold(a.name) === fold(b.name);
}

/* ───────────────────────────── Tipos de resultado ───────────────────────────── */

/** Envío de una oferta: lo declarado a FECHA DE CAPTURA (`asOf`), nunca «vigente» ni «verificado hoy». */
export type ComparableShipping = OfferShipping & {
  confirmed: boolean;
  /** De dónde sale el dato de envío. */
  source?: 'campos_planos' | 'specs_ebay';
  /** Fecha de captura del proveedor (`Sincronizado`/lectura JSON); null si no consta. Aplica a coste, gratis y plazo. */
  asOf?: string | null;
  /** true si coste y «gratis» se contradicen: se deja el envío como desconocido. */
  conflict?: boolean;
};

export interface ComparableRating {
  value: number;
  origin: 'producto' | 'vendedor';
  label: string;
  count?: number;
  countLabel?: string;
  asOf?: string | null;
}

export interface ComparableOffer {
  /** Id de oferta EXISTENTE (no se reescribe): sirve de parámetro para la futura salida por oferta. */
  offerId: string;
  /** Clave EXISTENTE de la oferta (sin reescribir). */
  offerKey: string;
  /** Identidad comercial derivada (sólo lectura): plataforma + anuncio + vendedor. */
  identityKey: string;
  productId: string;
  origin: 'implicit' | 'explicit';
  platform: string;
  listingId: string;
  seller: ResolvedSeller;
  /** Nombre del vendedor o «Vendedor no indicado». */
  sellerLabel: string;
  url: string;
  affiliateUrl?: string;
  canonicalUrl: string;
  price: number;
  originalPrice?: number;
  currency: string;
  /** true si la moneda no constaba en la ficha y se asume EUR (como ya hace la oferta implícita). */
  currencyAssumed: boolean;
  availability: StoredOffer['availability'];
  /** Incluye `open_box` («Abierto, sin usar»), distinta de «nueva» y de «usada». */
  condition: ReadCondition;
  variant: Record<string, string>;
  quantity?: string;
  shipping: ComparableShipping;
  /** Descuento: sólo `verified` con una observación real que lo demuestre; `originalPrice` es un dato DECLARADO por el comercio. */
  discount?: VerifiedDiscount;
  /** Valoración con su procedencia (producto o vendedor); ausente si no consta o es un valor por defecto. Nunca un recuento inventado. */
  rating?: ComparableRating;
  /** Precio + envío SÓLO si el envío es conocido (0 si es gratis confirmado); null si no se puede afirmar. */
  totalPrice: number | null;
  /** Pago, devolución y plazo de entrega: no hay campos fiables → siempre «No indicado». */
  payment: null;
  returns: null;
  delivery: null;
  capturedAt: string;
  receivedAt: string;
  verifiedAt: string;
  /** true sólo con verificación contra la fuente (nunca por haber recibido un JSON). */
  verified: boolean;
  /** Otras fichas del MISMO anuncio y vendedor, contadas como la misma oferta. */
  collapsedProductIds: string[];
}

export type ExclusionReason =
  | 'sin_precio'
  | 'sin_enlace'
  | 'agotada'
  | 'moneda_incompatible'
  | 'oferta_inactiva'
  | 'sin_identidad_de_anuncio'
  | 'identificadores_contradictorios'
  | 'duplicada_misma_identidad';

export type ReviewReason =
  | 'condicion_no_verificable'
  | 'variante_no_verificable'
  | 'cantidad_no_verificable'
  | 'anuncio_en_varias_fichas'
  | 'mismo_anuncio_sin_vendedor_con_datos_distintos';

export type VersionReason = 'condicion_distinta' | 'variante_distinta' | 'cantidad_distinta';

export interface ExcludedOffer {
  reason: ExclusionReason;
  detail?: string;
  offerId?: string;
  identityKey?: string;
}
export interface ReviewItem {
  reason: ReviewReason;
  detail?: string;
  offerId?: string;
  identityKey?: string;
  productId?: string;
}
export interface OtherVersion {
  reason: VersionReason;
  offer: ComparableOffer;
}

export interface ComparableOffersResult {
  productId: string;
  /** none = 0 ofertas válidas · single = 1 · multiple = 2 o más identidades comerciales comparables. */
  state: 'none' | 'single' | 'multiple';
  /** Ofertas comparables, una por identidad comercial, de menor a mayor precio. */
  offers: ComparableOffer[];
  verifiedCount: number;
  /** Comparativa con 2 o más ofertas VERIFICADAS. */
  comparisonReady: boolean;
  /** La más barata por total con envío, sólo si hay 2+ ofertas y TODOS los totales son conocidos; si no, null. */
  cheapest: ComparableOffer | null;
  excluded: ExcludedOffer[];
  /** Ofertas de otra variante, cantidad o condición (conocidas): no se mezclan con las anteriores. */
  otherVersions: OtherVersion[];
  /** Casos ambiguos: NO se vinculan automáticamente. */
  needsReview: ReviewItem[];
  /** Redes de `extra.crossMerchant` ignoradas (identidad no fiable). */
  legacyCrossMerchantIgnored: string[];
}

export interface ComparableOffersOptions {
  /**
   * Catálogo completo (opcional): permite contar UNA vez las fichas que repiten el mismo anuncio y vendedor y detectar anuncios
   * presentes en varias fichas con otro vendedor. Sin él sólo se usa la propia ficha. Nunca se modifica.
   */
  catalog?: P[];
}

/* ───────────────────────────── Utilidades ───────────────────────────── */

const VARIANT_KEYS = ['color', 'size', 'capacity', 'pack'] as const;

function variantOfProduct(p: P): Record<string, string> {
  const attrs = (((p.extra ?? {}) as Any).variantAttributes ?? {}) as Any;
  const out: Record<string, string> = {};
  for (const key of VARIANT_KEYS) if (attrs[key] !== undefined && attrs[key] !== null && String(attrs[key]).trim()) out[key] = String(attrs[key]).trim();
  return out;
}

/** Variante/cantidad que una oferta EXPLÍCITA declare (campos opcionales; hoy el importador no los guarda). */
function variantOfOffer(offer: Any): Record<string, string> {
  const raw = (offer.variant && typeof offer.variant === 'object' ? offer.variant : {}) as Any;
  const out: Record<string, string> = {};
  for (const key of VARIANT_KEYS) if (raw[key] !== undefined && raw[key] !== null && String(raw[key]).trim()) out[key] = String(raw[key]).trim();
  if (offer.quantity !== undefined && offer.quantity !== null && String(offer.quantity).trim() && !out.pack) out.pack = String(offer.quantity).trim();
  return out;
}

function listingIdOf(offer: { platform: string; externalId?: string; canonicalUrl?: string }): string {
  const byId = platformIdKey(offer.platform, offer.externalId);
  if (byId) return byId;
  return offer.canonicalUrl ? `${fold(offer.platform).replace(/ /g, '')}:url:${offer.canonicalUrl}` : '';
}

function identityKeyOf(listingId: string, seller: ResolvedSeller): string {
  if (!listingId) return '';
  const who = seller.known ? `v:${seller.id ? `id:${fold(seller.id)}` : `n:${fold(seller.name)}`}` : 'v:sin-vendedor';
  return `${listingId}|${who}`;
}

/** Identificador de anuncio que lleva la URL (ASIN de Amazon o id de artículo de AliExpress); '' si no se reconoce. */
function idFromUrl(platform: string, url: string): string {
  const u = String(url || '');
  if (/amazon/i.test(platform)) return (u.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})(?:[/?#]|$)/i)?.[1] ?? '').toUpperCase();
  if (/aliexpress/i.test(platform)) return u.match(/\/item\/(?:[^/?#]+\/)*(\d{8,})(?:\.html)?(?:[/?#]|$)/i)?.[1] ?? '';
  // eBay y Temu: el id sólo se extrae de la URL de SU propio dominio y con una estructura inequívoca. Una URL malformada, de otro dominio o
  // sin id reconocible devuelve '' (= «no se puede saber»): la ausencia nunca se interpreta como contradicción.
  if (/ebay|temu/i.test(platform)) {
    let host = '';
    let path = '';
    try {
      const parsed = new URL(u);
      if (!/^https?:$/.test(parsed.protocol)) return '';
      host = parsed.hostname.toLowerCase();
      path = parsed.pathname;
    } catch {
      return '';
    }
    // eBay: /itm/<id> o /itm/<slug>/<id> (9-14 dígitos, como en `extractSourceId`).
    if (/ebay/i.test(platform)) return /(^|\.)ebay\.[a-z.]+$/.test(host) ? (path.match(/^\/itm\/(?:[^/]+\/)?(\d{9,14})\/?$/)?.[1] ?? '') : '';
    // Temu: …-g-<goodsId>.html (la misma estructura que usa el adaptador de Temu).
    return /(^|\.)temu\.com$/.test(host) ? (path.match(/-g-(\d{6,20})\.html$/)?.[1] ?? '') : '';
  }
  return '';
}

/** Identificadores de la FICHA (asin, sourceId, ID externo…) que se contradicen entre sí. Devuelve el detalle o ''. */
function contradictionOfProduct(p: P): string {
  const extra = (p.extra ?? {}) as Any;
  const values = new Map<string, string>();
  const add = (label: string, raw: unknown) => {
    const id = normalizeSourceId(raw === undefined || raw === null ? '' : String(raw));
    if (id) values.set(label, id.toLowerCase());
  };
  add('asin', p.asin);
  add('sourceId', p.sourceId);
  add('ID externo', extra['ID externo']);
  add('identifiers.asin', extra.identifiers?.asin);
  const distinct = new Set(values.values());
  return distinct.size > 1 ? [...values.entries()].map(([k, v]) => `${k}=${v}`).join(' · ') : '';
}

/** ¿El id declarado de una oferta choca con el id que lleva su propia URL? */
export function contradictionOfOffer(o: { platform: string; externalId?: string; url?: string; canonicalUrl?: string }): string {
  const declared = normalizeSourceId(o.externalId);
  const fromUrl = normalizeSourceId(idFromUrl(o.platform, o.url || o.canonicalUrl || ''));
  return declared && fromUrl && declared.toLowerCase() !== fromUrl.toLowerCase() ? `id=${declared} ≠ url=${fromUrl}` : '';
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function shippingOf(shipping: OfferShipping | undefined): ComparableOffer['shipping'] {
  const cost = finite(shipping?.cost) ? shipping!.cost : null;
  const free = shipping?.free === true ? true : null; // `false` no confirma nada: se trata como desconocido
  const days = finite(shipping?.days) ? shipping!.days : null;
  const text = shipping?.text ? String(shipping.text) : undefined;
  const asOf = shipping?.asOf ? String(shipping.asOf) : null;
  return { cost, free, days, ...(text ? { text } : {}), ...(asOf ? { asOf } : {}), confirmed: cost !== null || free === true };
}

/**
 * Envío de la oferta PRINCIPAL (campos planos) con los datos comerciales ya almacenados:
 *  - eBay guarda el coste en `specs['Coste de envío']` («Gratis» o «4.49 EUR»): sólo se interpreta si es inequívoco; si contradice un
 *    `freeShipping=true` el envío queda desconocido. `freeShipping=false` es el valor por defecto y no prueba un coste positivo.
 *  - El texto «Envío estándar eBay (3-5 días)» es el fallback del código, no información del proveedor: se descarta.
 *  - Todo va acompañado de la fecha de captura (`asOf`); los días son «estimados en la fecha de captura», no una promesa desde hoy.
 */
function implicitShipping(product: P, base: OfferShipping | undefined): ComparableOffer['shipping'] {
  const flat = shippingOf(base);
  let cost = flat.cost;
  let free = flat.free;
  let source: NonNullable<ComparableOffer['shipping']['source']> = 'campos_planos';
  let conflict = false;
  const spec = parseEbayShippingCost(product);
  if (spec) {
    if (spec.kind === 'paid' && free === true) {
      conflict = true;
      cost = null;
      free = null;
    } else if (spec.kind === 'free') {
      cost = 0;
      free = true;
      source = 'specs_ebay';
    } else {
      cost = spec.amount;
      free = null;
      source = 'specs_ebay';
    }
  }
  const text = flat.text && !isFallbackShippingText(flat.text) ? flat.text : undefined;
  return {
    cost,
    free,
    days: flat.days,
    ...(text ? { text } : {}),
    confirmed: cost !== null || free === true,
    source,
    asOf: flat.asOf ?? captureDateOf(product),
    ...(conflict ? { conflict } : {}),
  };
}

function ratingOf(product: P): ComparableRating | undefined {
  const s = ratingSupport(product);
  if (s.rating === null) return undefined;
  const seller = s.origin === 'vendedor';
  return {
    value: s.rating,
    origin: s.origin,
    label: seller ? 'Valoración del vendedor' : 'Valoración del producto',
    ...(s.count !== null ? { count: s.count, countLabel: seller ? 'valoraciones del vendedor' : 'valoraciones' } : {}),
    asOf: captureDateOf(product),
  };
}

function totalOf(price: number, shipping: ComparableOffer['shipping']): number | null {
  if (shipping.cost !== null) return Math.round((price + shipping.cost) * 100) / 100;
  if (shipping.free === true) return price;
  return null;
}

type Candidate = { offer: ComparableOffer; stored: StoredOffer };

function buildOffer(
  product: P,
  stored: StoredOffer,
  seller: ResolvedSeller,
  origin: ComparableOffer['origin'],
  currencyAssumed: boolean,
  variant: Record<string, string>,
): ComparableOffer {
  const listingId = listingIdOf(stored);
  const shipping = origin === 'implicit' ? implicitShipping(product, stored.shipping) : shippingOf(stored.shipping);
  const verifiedAt = String(stored.verifiedAt || '');
  return {
    offerId: stored.offerId,
    offerKey: stored.offerKey,
    identityKey: identityKeyOf(listingId, seller),
    productId: product.id,
    origin,
    platform: stored.platform,
    listingId,
    seller,
    sellerLabel: seller.known && seller.name ? seller.name : SELLER_UNKNOWN_LABEL,
    url: String(stored.url || ''),
    ...(origin === 'implicit' ? (product.affiliateUrl ? { affiliateUrl: String(product.affiliateUrl) } : {}) : stored.affiliateUrl ? { affiliateUrl: stored.affiliateUrl } : {}),
    canonicalUrl: String(stored.canonicalUrl || ''),
    price: stored.price,
    ...(finite(stored.originalPrice) && stored.originalPrice > stored.price ? { originalPrice: stored.originalPrice } : {}),
    currency: String(stored.currency || 'EUR').toUpperCase(),
    currencyAssumed,
    availability: stored.availability,
    condition: origin === 'implicit' ? readCondition(product) : stored.condition,
    variant,
    ...(variant.pack ? { quantity: variant.pack } : {}),
    shipping,
    discount: origin === 'implicit' ? verifiedDiscountOf(product) : { verified: false, pct: null, reason: 'oferta_adicional_sin_observacion_verificada' },
    ...(origin === 'implicit' && ratingOf(product) ? { rating: ratingOf(product) } : {}),
    totalPrice: totalOf(stored.price, shipping),
    payment: null,
    returns: null,
    delivery: null,
    capturedAt: String(stored.capturedAt || ''),
    receivedAt: String(stored.receivedAt || ''),
    verifiedAt,
    verified: verifiedAt !== '',
    collapsedProductIds: [],
  };
}

/** Motivo por el que la ficha no tiene oferta implícita utilizable. */
function whyNoImplicit(p: P): ExcludedOffer {
  if (!(Number(p.price) > 0)) return { reason: 'sin_precio' };
  return { reason: 'sin_identidad_de_anuncio', detail: 'sin plataforma o sin identificador/URL canónica del anuncio' };
}

interface Compat {
  verdict: 'compatible' | 'version' | 'review';
  version?: VersionReason;
  review?: ReviewReason;
  detail?: string;
}

/** Compara una oferta con la FICHA de referencia: iguales/ambas desconocidas → compatible; distintas conocidas → otra versión; una sola conocida → revisión. */
function compareWithReference(
  ref: { condition: ReadCondition; variant: Record<string, string> },
  cand: { condition: ReadCondition; variant: Record<string, string> },
): Compat {
  if (ref.condition !== 'unknown' && cand.condition !== 'unknown' && ref.condition !== cand.condition) {
    return { verdict: 'version', version: 'condicion_distinta', detail: `${ref.condition} ≠ ${cand.condition}` };
  }
  for (const key of VARIANT_KEYS) {
    const l = fold(ref.variant[key]);
    const r = fold(cand.variant[key]);
    if (l && r && l !== r) {
      return { verdict: 'version', version: key === 'pack' ? 'cantidad_distinta' : 'variante_distinta', detail: `${key}: ${ref.variant[key]} ≠ ${cand.variant[key]}` };
    }
  }
  const conditionOneSided = (ref.condition === 'unknown') !== (cand.condition === 'unknown');
  if (conditionOneSided) return { verdict: 'review', review: 'condicion_no_verificable', detail: `ficha: ${ref.condition} · oferta: ${cand.condition}` };
  for (const key of VARIANT_KEYS) {
    const l = fold(ref.variant[key]);
    const r = fold(cand.variant[key]);
    if (Boolean(l) !== Boolean(r)) {
      return { verdict: 'review', review: key === 'pack' ? 'cantidad_no_verificable' : 'variante_no_verificable', detail: `${key}: ${ref.variant[key] ?? '—'} · oferta: ${cand.variant[key] ?? '—'}` };
    }
  }
  return { verdict: 'compatible' };
}

/* ───────────────────────────── Función principal ───────────────────────────── */

export function getComparableOffers(product: P, options: ComparableOffersOptions = {}): ComparableOffersResult {
  const excluded: ExcludedOffer[] = [];
  const otherVersions: OtherVersion[] = [];
  const needsReview: ReviewItem[] = [];
  const refCondition = readCondition(product);
  const refVariant = variantOfProduct(product);
  const refCurrencyAssumed = !String(product.currency ?? '').trim();
  const refCurrency = String(product.currency || 'EUR').toUpperCase();

  const crossRaw = ((product.extra ?? {}) as Any).crossMerchant;
  const legacyCrossMerchantIgnored = Array.isArray(crossRaw?.networks) ? crossRaw.networks.map(String) : [];

  // 1) Candidatas: implícita + explícitas (sin copiar ni mutar nada).
  const all = getOffers(product);
  const implicit = all.find((o) => o.implicit === true);
  const explicit = storedOffers(product);
  if (!implicit) excluded.push(whyNoImplicit(product));

  const accepted: ComparableOffer[] = [];

  const consider = (stored: StoredOffer, origin: ComparableOffer['origin']) => {
    const seller = origin === 'implicit' ? resolveSeller(product) : sellerOfOffer(stored, product);
    const currencyAssumed = origin === 'implicit' ? refCurrencyAssumed : !String(stored.currency ?? '').trim();
    const variant = origin === 'implicit' ? refVariant : variantOfOffer(stored as Any);
    const offer = buildOffer(product, stored, seller, origin, currencyAssumed, variant);
    const tag = { offerId: offer.offerId, identityKey: offer.identityKey };

    if (origin === 'explicit' && (stored as Any).status !== undefined && (stored as Any).status !== 'active') {
      excluded.push({ reason: 'oferta_inactiva', detail: String((stored as Any).status), ...tag });
      return;
    }
    if (!(finite(offer.price) && offer.price > 0)) {
      excluded.push({ reason: 'sin_precio', ...tag });
      return;
    }
    const contradiction = origin === 'implicit' ? contradictionOfProduct(product) || contradictionOfOffer(stored) : contradictionOfOffer(stored);
    if (contradiction) {
      excluded.push({ reason: 'identificadores_contradictorios', detail: contradiction, ...tag });
      return;
    }
    if (!offer.identityKey) {
      excluded.push({ reason: 'sin_identidad_de_anuncio', ...tag });
      return;
    }
    if (!offer.url || !offer.url.trim() || isPlaceholderUrl(offer.url)) {
      excluded.push({ reason: 'sin_enlace', ...tag });
      return;
    }
    if (offer.availability === 'out_of_stock') {
      excluded.push({ reason: 'agotada', ...tag });
      return;
    }
    if (offer.currency !== 'EUR' || offer.currency !== refCurrency) {
      excluded.push({ reason: 'moneda_incompatible', detail: `${offer.currency} (ficha: ${refCurrency})`, ...tag });
      return;
    }
    if (origin === 'explicit') {
      const compat = compareWithReference({ condition: refCondition, variant: refVariant }, { condition: offer.condition, variant });
      if (compat.verdict === 'version') {
        otherVersions.push({ reason: compat.version!, offer });
        return;
      }
      if (compat.verdict === 'review') {
        needsReview.push({ reason: compat.review!, detail: compat.detail, ...tag });
        return;
      }
    }
    // Deduplicación comercial dentro de la ficha: una oferta por (anuncio, vendedor).
    const twin = accepted.find((a) => a.listingId === offer.listingId && (sameSeller(a.seller, offer.seller) || (!a.seller.known && !offer.seller.known)));
    if (twin) {
      const bothUnknown = !twin.seller.known && !offer.seller.known;
      if (bothUnknown && (twin.price !== offer.price || twin.currency !== offer.currency)) {
        needsReview.push({ reason: 'mismo_anuncio_sin_vendedor_con_datos_distintos', detail: `${twin.price} ≠ ${offer.price}`, ...tag });
      } else {
        excluded.push({ reason: 'duplicada_misma_identidad', detail: `igual que ${twin.offerId}`, ...tag });
      }
      return;
    }
    accepted.push(offer);
  };

  if (implicit) consider(implicit, 'implicit');
  for (const stored of explicit) consider(stored, 'explicit');

  // 2) Otras fichas del MISMO anuncio (sólo lectura del catálogo, nunca se modifican ni se fusionan).
  if (options.catalog && implicit) {
    const listing = listingIdOf(implicit);
    const own = accepted.find((a) => a.origin === 'implicit');
    if (listing) {
      for (const other of options.catalog) {
        if (!other || other.id === product.id) continue;
        const otherImplicit = getOffers(other).find((o) => o.implicit === true);
        if (!otherImplicit || listingIdOf(otherImplicit) !== listing) continue;
        const otherSeller = resolveSeller(other);
        const mySeller = own?.seller ?? resolveSeller(product);
        const sameIdentity = sameSeller(mySeller, otherSeller) || (!mySeller.known && !otherSeller.known);
        const compat = compareWithReference(
          { condition: refCondition, variant: refVariant },
          { condition: readCondition(other), variant: variantOfProduct(other) },
        );
        const sameCurrency = String(other.currency || 'EUR').toUpperCase() === refCurrency;
        const samePrice = Number(other.price) === Number(product.price);
        const unknownBoth = !mySeller.known && !otherSeller.known;
        if (own && sameIdentity && sameCurrency && compat.verdict === 'compatible' && (!unknownBoth || samePrice)) {
          own.collapsedProductIds.push(other.id);
        } else {
          needsReview.push({
            reason: 'anuncio_en_varias_fichas',
            productId: other.id,
            identityKey: own?.identityKey,
            detail: !sameIdentity ? 'otro vendedor' : !sameCurrency ? 'otra moneda' : compat.verdict !== 'compatible' ? (compat.detail ?? 'versión no verificable') : 'datos distintos sin vendedor',
          });
        }
      }
    }
  }

  accepted.sort((a, b) => a.price - b.price || a.identityKey.localeCompare(b.identityKey));
  const verifiedCount = accepted.filter((o) => o.verified).length;
  const allTotalsKnown = accepted.length >= 2 && accepted.every((o) => o.totalPrice !== null);
  let cheapest: ComparableOffer | null = null;
  if (allTotalsKnown) {
    const min = Math.min(...accepted.map((o) => o.totalPrice as number));
    const best = accepted.filter((o) => o.totalPrice === min);
    cheapest = best.length === 1 ? best[0] : null; // un empate no se presenta como «la más barata»
  }

  return {
    productId: product.id,
    state: accepted.length === 0 ? 'none' : accepted.length === 1 ? 'single' : 'multiple',
    offers: accepted,
    verifiedCount,
    comparisonReady: accepted.length >= 2 && verifiedCount >= 2,
    cheapest,
    excluded,
    otherVersions,
    needsReview,
    legacyCrossMerchantIgnored,
  };
}

/* ───────────────────────────── Identidades comerciales del catálogo ───────────────────────────── */

export interface CommercialIdentityGroup {
  identityKey: string;
  productIds: string[];
}

/** Identidad comercial (anuncio + vendedor) de la oferta principal de una ficha, o '' si no se puede establecer. */
export function commercialIdentityOf(product: P): string {
  const implicit = getOffers(product).find((o) => o.implicit === true);
  if (!implicit) return '';
  return identityKeyOf(listingIdOf(implicit), resolveSeller(product));
}

/**
 * Agrupa las fichas del catálogo por identidad comercial (sólo lectura). Las fichas que repiten el mismo anuncio y vendedor
 * forman UNA identidad: es lo que debe contarse como una sola oferta. No modifica nada.
 */
export function groupByCommercialIdentity(catalog: P[]): CommercialIdentityGroup[] {
  const groups = new Map<string, string[]>();
  for (const product of catalog) {
    const key = commercialIdentityOf(product);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(product.id);
  }
  return [...groups.entries()].map(([identityKey, productIds]) => ({ identityKey, productIds }));
}

