/**
 * ==============================================================================
 * TREIDILOR — IMPORTACIÓN JSON · MOTOR (identidad, ofertas y aplicación)
 * ==============================================================================
 * Núcleo PURO (sin ficheros): recibe el catálogo en memoria y registros JSON, y
 * devuelve el catálogo resultante + un resultado por registro. Reglas:
 *
 *  - Una FICHA del catálogo = una variante vendible. Sus ofertas son la oferta
 *    implícita (campos planos: network/sourceId/price/affiliateUrl…, tal y como
 *    la crean hoy la API y el flujo Amazon) + `extra.offers[]` (ofertas
 *    adicionales de otros comerciantes/vendedores). Así la MISMA oferta que
 *    llega por API y por JSON se reconoce sin duplicarla ni migrar datos.
 *  - Identidad de producto: oferta conocida → GTIN válido → marca+MPN → (título
 *    parecido sólo genera REVISIÓN, nunca fusión). Estados distintos (nuevo,
 *    usado, reacondicionado) y variantes con atributos distintos no se fusionan.
 *  - Nunca se pisa lo enriquecido/editado: la fusión usa `mergeReimport`
 *    (campos de curación y `lockedFields` intactos).
 *  - Lo desconocido (null/'unknown') nunca borra ni sustituye un dato conocido.
 * ==============================================================================
 */

import { cleanTitleKey, canonicalProductUrl, extractSourceId } from '../curation';
import { normalizeBrand, normalizeSourceId, offerKey as baseOfferKey } from '../offerIdentity';
import { mergeReimport, readLockedFields } from '../reimportMerge';
import { contradictionOfOffer, resolveSeller, sameSeller, sellerRejection, type ResolvedSeller } from '../comparableOffers';
import { isMerchantOrPlaceholderBrand, resolveBrand } from '../brandResolve';
import { slugify, type Product } from '../productStore';
import { normalizeCondition, normalizeRecord } from './normalize';
import {
  computeOfferKey,
  fold,
  getOffers,
  implicitOffer,
  platformIdKey,
  productCondition,
  sellerKey,
  shortHash,
  storedOffers,
  type P,
} from '../catalogOffers';

export { computeOfferKey, getOffers, implicitOffer };
import {
  EMPTY_ENTITIES,
  type PriceReading,
  type CanonicalRecord,
  type Condition,
  type OfferShipping,
  type ImportDefaults,
  type ImportTarget,
  type RecordResult,
  type ReviewCandidate,
  type StoredOffer,
} from './types';

type Any = Record<string, unknown>;

const PRICE_EPSILON = 0.005;
const VARIANT_KEYS = ['color', 'size', 'capacity', 'pack'] as const;
const MAX_STORED_OFFERS = 50;

/* ───────────────────────── Índice del catálogo ───────────────────────── */

function productIdentifiers(p: P): { gtin?: string; mpn?: string } {
  const ids = (p.extra?.identifiers ?? {}) as Any;
  return { gtin: ids.gtin ? String(ids.gtin) : undefined, mpn: ids.mpn ? String(ids.mpn) : undefined };
}

function productVariant(p: P): Partial<Record<(typeof VARIANT_KEYS)[number], string>> {
  const attrs = (p.extra?.variantAttributes ?? {}) as Any;
  const out: Partial<Record<(typeof VARIANT_KEYS)[number], string>> = {};
  for (const key of VARIANT_KEYS) if (attrs[key]) out[key] = String(attrs[key]);
  return out;
}

class Index {
  byOfferKey = new Map<string, string>();
  byPlatformId = new Map<string, Set<string>>();
  byUrl = new Map<string, string>();
  byGtin = new Map<string, Set<string>>();
  byBrandMpn = new Map<string, Set<string>>();
  byBrand = new Map<string, Set<string>>();
  byTitle = new Map<string, Set<string>>();
  byId = new Map<string, P>();

  private add(map: Map<string, Set<string>>, key: string, id: string) {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(id);
  }

  register(p: P) {
    this.byId.set(p.id, p);
    for (const offer of getOffers(p)) {
      if (offer.offerKey && !this.byOfferKey.has(offer.offerKey)) this.byOfferKey.set(offer.offerKey, p.id);
      this.add(this.byPlatformId, platformIdKey(offer.platform, offer.externalId), p.id);
      if (offer.canonicalUrl && !this.byUrl.has(offer.canonicalUrl)) this.byUrl.set(offer.canonicalUrl, p.id);
    }
    const buyNow = canonicalProductUrl(p.buyNowUrl);
    if (buyNow && !this.byUrl.has(buyNow)) this.byUrl.set(buyNow, p.id);
    const ids = productIdentifiers(p);
    this.add(this.byGtin, ids.gtin ?? '', p.id);
    const brandKey = normalizeBrand(p.brand).key;
    if (brandKey && ids.mpn) this.add(this.byBrandMpn, `${brandKey}|${fold(ids.mpn)}`, p.id);
    this.add(this.byBrand, brandKey, p.id);
    this.add(this.byTitle, cleanTitleKey(p.title), p.id);
  }
}

/* ───────────────────────── Compatibilidad de variante ───────────────────────── */

type Compat = 'compatible' | 'different_condition' | 'conflict';

function compatibility(p: P, rec: CanonicalRecord): Compat {
  const pc = productCondition(p);
  const rc = rec.variant.condition;
  if (pc !== 'unknown' && rc !== 'unknown' && pc !== rc) return 'different_condition';
  const attrs = productVariant(p);
  for (const key of VARIANT_KEYS) {
    const left = fold(attrs[key]);
    const right = fold(rec.variant[key]);
    if (left && right && left !== right) return 'conflict';
  }
  return 'compatible';
}

function tokens(title: string): Set<string> {
  return new Set(cleanTitleKey(title).split(' ').filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  a.forEach((t) => {
    if (b.has(t)) inter += 1;
  });
  return inter / (a.size + b.size - inter);
}

/* ───────────────────────── Resolución ───────────────────────── */

type Resolution =
  | { kind: 'offer'; product: P; offer: StoredOffer }
  | { kind: 'link'; product: P; reason: string }
  /** `existing`: la revisión protege una ficha/oferta EXISTENTE (con «Sólo productos nuevos» se omite como «ya existe»). */
  | { kind: 'review'; reasons: string[]; candidates: ReviewCandidate[]; existing?: boolean }
  | { kind: 'create' };

function candidatesOf(index: Index, ids: Iterable<string>, reason: string): ReviewCandidate[] {
  const out: ReviewCandidate[] = [];
  for (const id of ids) {
    const p = index.byId.get(id);
    if (p) out.push({ productId: id, title: String(p.title).slice(0, 120), reason });
    if (out.length >= 3) break;
  }
  return out;
}

function resolveByIdentifier(index: Index, rec: CanonicalRecord, ids: Set<string> | undefined, label: string): Resolution | null {
  if (!ids || !ids.size) return null;
  const compatible: string[] = [];
  const conflicts: string[] = [];
  for (const id of ids) {
    const p = index.byId.get(id);
    if (!p) continue;
    const c = compatibility(p, rec);
    if (c === 'compatible') compatible.push(id);
    else if (c === 'conflict') conflicts.push(id);
  }
  if (compatible.length === 1) return { kind: 'link', product: index.byId.get(compatible[0])!, reason: label };
  if (compatible.length > 1) {
    return { kind: 'review', reasons: [`${label}_varias_fichas`], candidates: candidatesOf(index, compatible, `${label}_varias_fichas`) };
  }
  if (conflicts.length) {
    return { kind: 'review', reasons: [`${label}_atributos_en_conflicto`], candidates: candidatesOf(index, conflicts, `${label}_atributos_en_conflicto`) };
  }
  return null; // sólo había estados distintos → es otra variante, no es coincidencia
}

/* ───────────────────────── Seguridad de identidad (etapa 1.5) ─────────────────────────
 * Un identificador fuerte (anuncio de plataforma, GTIN, marca+MPN) identifica el ANUNCIO, no demuestra que el registro sea la misma
 * variante, cantidad, condición, moneda ni producto. Ante diferencia, falta de información o contradicción, NO se vincula, NO se
 * actualiza y NO se crea una ficha nueva: el registro va a REVISIÓN con su motivo. Nunca se une por título, marca+modelo ni specs. */

type VariantKey = (typeof VARIANT_KEYS)[number];
type GuardMode = 'offer' | 'link';

/** Plataformas donde un anuncio pertenece a UN solo vendedor: el mismo anuncio con otro vendedor es una contradicción, no una oferta nueva. */
const SINGLE_SELLER_PLATFORMS = new Set(['aliexpress', 'ebay']);

const listingOf = (o: { platform: string; externalId?: string }): string => platformIdKey(o.platform, o.externalId);

/** Vendedor (validado) de un registro entrante. Un nombre malformado/logístico no cuenta; un id sí identifica. */
function sellerOfRecord(rec: CanonicalRecord): ResolvedSeller {
  const o = rec.offer;
  const reason = sellerRejection(o.sellerName, [o.platform]);
  const id = o.sellerId && String(o.sellerId).trim() ? String(o.sellerId).trim() : undefined;
  if (reason === null) return { name: String(o.sellerName).trim(), id, source: 'oferta', known: true, rejected: [] };
  if (id) return { id, source: 'oferta', known: true, rejected: [] };
  return { source: 'ninguna', known: false, rejected: [] };
}

/** Vendedor (validado) de una oferta EXISTENTE: la implícita usa la jerarquía offerSeller → Tienda → fulfillmentProvider. */
function sellerOfExisting(p: P, offer: StoredOffer): ResolvedSeller {
  if (offer.implicit) return resolveSeller(p);
  const reason = sellerRejection(offer.sellerName, [offer.platform, String(p.network ?? ''), String(p.merchant ?? '')]);
  const id = offer.sellerId && String(offer.sellerId).trim() ? String(offer.sellerId).trim() : undefined;
  if (reason === null) return { name: String(offer.sellerName).trim(), id, source: 'oferta', known: true, rejected: [] };
  if (id) return { id, source: 'oferta', known: true, rejected: [] };
  return { source: 'ninguna', known: false, rejected: [] };
}

/** Descarta del registro los nombres de vendedor malformados o puramente logísticos (con aviso). No toca nada más. */
function sanitizeSeller(rec: CanonicalRecord): CanonicalRecord {
  const name = rec.offer.sellerName;
  if (name === undefined || name === null) return rec;
  const reason = sellerRejection(name, [rec.offer.platform]);
  if (reason === 'malformado' || reason === 'logistica') {
    return { ...rec, offer: { ...rec.offer, sellerName: undefined }, warnings: [...rec.warnings, `vendedor_descartado:${reason}`] };
  }
  return rec;
}

interface RefAttrs {
  condition: Condition;
  variant: Partial<Record<VariantKey, string>>;
  currency: string;
}

/** Atributos de la oferta/ficha contra la que se compara el registro entrante. Las ofertas antiguas sin variante cuentan como «desconocida». */
function refOf(p: P, offer: StoredOffer | null): RefAttrs {
  if (!offer || offer.implicit) return { condition: productCondition(p), variant: productVariant(p), currency: String(p.currency || 'EUR').toUpperCase() };
  const variant: Partial<Record<VariantKey, string>> = {};
  const raw = (offer.variant ?? {}) as Record<string, string | undefined>;
  for (const key of VARIANT_KEYS) if (raw[key]) variant[key] = String(raw[key]);
  if (offer.quantity && !variant.pack) variant.pack = String(offer.quantity);
  return { condition: offer.condition ?? 'unknown', variant, currency: String(offer.currency || 'EUR').toUpperCase() };
}

const MODEL_WORDS = new Set(['pro', 'plus', 'max', 'ultra', 'mini', 'lite', 'air', 'xl', 'fe', 'se', 'promax']);

/** Palabras/cifras que distinguen un modelo de otro (14, 15, f920, pro…). Los años no cuentan. */
function modelTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const t of cleanTitleKey(title).split(' ')) {
    if (!t || /^(19|20)\d\d$/.test(t)) continue;
    if (/\d/.test(t) || MODEL_WORDS.has(t)) out.add(t);
  }
  return out;
}

/** Contradicción EVIDENTE entre dos títulos: cada uno lleva elementos distintivos que el otro no tiene. Sólo VETA (nunca une). */
function titleModelConflict(a: string, b: string): boolean {
  const x = modelTokens(a);
  const y = modelTokens(b);
  if (!x.size || !y.size) return false;
  let onlyX = false;
  let onlyY = false;
  x.forEach((t) => { if (!y.has(t)) onlyX = true; });
  y.forEach((t) => { if (!x.has(t)) onlyY = true; });
  return onlyX && onlyY;
}

/** Contradicciones entre el producto existente y el registro (marca, GTIN, MPN y, al vincular otra oferta, el título). */
function productContradictions(p: P, rec: CanonicalRecord, mode: GuardMode): string[] {
  const out: string[] = [];
  const existingBrand = resolveBrand(p as never);
  const incomingBrand = rec.product.brand ?? '';
  if (existingBrand && incomingBrand && !isMerchantOrPlaceholderBrand(incomingBrand, p.merchant)) {
    const left = normalizeBrand(existingBrand).key;
    const right = normalizeBrand(incomingBrand).key;
    if (left && right && left !== right) out.push(`marca_contradictoria:${existingBrand}≠${incomingBrand}`);
  }
  const ids = productIdentifiers(p);
  if (ids.gtin && rec.product.gtin && ids.gtin !== rec.product.gtin) out.push('gtin_contradictorio');
  if (ids.mpn && rec.product.mpn && fold(ids.mpn) !== fold(rec.product.mpn)) out.push('mpn_contradictorio');
  if (mode === 'link' && titleModelConflict(String(p.title ?? ''), rec.product.title)) out.push('titulo_incompatible_con_el_producto_existente');
  return out;
}

/**
 * Comprobaciones de seguridad antes de actualizar una oferta existente (`offer`) o vincular una nueva (`link`). Devuelve los motivos de
 * bloqueo (vacío = seguro). Moneda y diferencias CONOCIDAS bloquean siempre; la información insuficiente bloquea al vincular y, al
 * actualizar, sólo cuando el registro declara una cantidad/pack que la oferta no confirma.
 */
function guard(p: P, offer: StoredOffer | null, rec: CanonicalRecord, mode: GuardMode): string[] {
  const ref = refOf(p, offer);
  const reasons: string[] = [];
  const currency = String(rec.offer.currency || 'EUR').toUpperCase();
  if (currency !== ref.currency) reasons.push(`moneda_distinta:${ref.currency}≠${currency}`);
  const ec = ref.condition;
  const ic = rec.variant.condition;
  if (ec !== 'unknown' && ic !== 'unknown' && ec !== ic) reasons.push(`condicion_distinta:${ec}≠${ic}`);
  else if (mode === 'link' && (ec === 'unknown') !== (ic === 'unknown')) reasons.push('condicion_no_verificable');
  // Al actualizar: un registro SIN condición no puede confirmar la de una ficha que sí la tiene, y uno que declara una condición distinta de «nuevo»
  // (usado, reacondicionado, abierto…) tampoco puede sobrescribir el precio de una ficha sin condición conocida.
  else if (mode === 'offer' && ((ec !== 'unknown' && ic === 'unknown') || (ec === 'unknown' && ic !== 'unknown' && ic !== 'new'))) reasons.push('condicion_no_verificable');
  for (const key of VARIANT_KEYS) {
    const left = fold(ref.variant[key]);
    const right = fold(rec.variant[key]);
    const label = key === 'pack' ? 'cantidad' : 'variante';
    if (left && right && left !== right) reasons.push(`${label}_distinta:${key}`);
    else if (Boolean(left) !== Boolean(right)) {
      if (mode === 'link' || (key === 'pack' && right && !left)) reasons.push(`${label}_no_verificable:${key}`);
    }
  }
  reasons.push(...productContradictions(p, rec, mode));
  return reasons;
}

/** Revisión que protege una ficha existente (no crea, no vincula, no actualiza). */
function reviewExisting(index: Index, reasons: string[], ids: Iterable<string>): Resolution {
  return { kind: 'review', reasons, candidates: candidatesOf(index, ids, reasons[0].split(':')[0]), existing: true };
}

/** Un vínculo por identificador fuerte (GTIN, marca+MPN) también pasa por las comprobaciones de seguridad. */
function secured(index: Index, res: Resolution, rec: CanonicalRecord): Resolution {
  if (res.kind !== 'link') return res;
  const blocked = guard(res.product, null, rec, 'link');
  return blocked.length ? reviewExisting(index, blocked, [res.product.id]) : res;
}

function resolve(index: Index, rec: CanonicalRecord): Resolution {
  const o = rec.offer;
  const key = computeOfferKey(o);
  const listing = listingOf(o);
  const holders = listing ? index.byPlatformId.get(listing) : undefined;
  const incoming = sellerOfRecord(rec);
  // «Vendedor: Amazon» (el nombre de la propia plataforma) es una declaración EXPLÍCITA de que vende la plataforma; no es «desconocido».
  const declaredPlatformSeller = sellerRejection(o.sellerName, [o.platform]) === 'plataforma';

  // 0) El anuncio ya está en VARIAS fichas (p. ej. los repetidos): no se crea otra, no se elige una al azar, no se actualiza ninguna.
  if (holders && holders.size > 1) return reviewExisting(index, ['anuncio_en_varias_fichas'], holders);

  // 1) Misma oferta (red + id [+ vendedor]) o misma URL canónica.
  const byKey = key ? index.byOfferKey.get(key) : undefined;
  const byUrl = o.canonicalUrl ? index.byUrl.get(o.canonicalUrl) : undefined;
  const hitId = byKey ?? byUrl;
  if (hitId) {
    const p = index.byId.get(hitId)!;
    const mySeller = sellerKey(o.platform, o.sellerId, o.sellerName);
    // La URL sólo identifica la oferta si el vendedor es el mismo (otro vendedor del mismo anuncio = otra oferta).
    const offer = getOffers(p).find(
      (x) => x.offerKey === key || (o.canonicalUrl && x.canonicalUrl === o.canonicalUrl && sellerKey(x.platform, x.sellerId, x.sellerName) === mySeller),
    );
    if (offer) {
      // Sin vendedor fiable y con varias ofertas de ese anuncio no se puede saber a cuál corresponde.
      if (!incoming.known && !declaredPlatformSeller && listing && getOffers(p).filter((x) => listingOf(x) === listing).length >= 2) {
        return reviewExisting(index, ['vendedor_no_confirmado_varias_ofertas'], [p.id]);
      }
      const blocked = guard(p, offer, rec, 'offer');
      return blocked.length ? reviewExisting(index, blocked, [p.id]) : { kind: 'offer', product: p, offer };
    }
  }

  // 1b) Mismo anuncio/ASIN de la plataforma en UNA ficha.
  if (holders && holders.size === 1) {
    const p = index.byId.get([...holders][0])!;
    const same = getOffers(p).filter((x) => listingOf(x) === listing);
    if (incoming.known) {
      // Mismo vendedor que una oferta existente (aunque llegara por otra vía: API/JSON) = la MISMA oferta: no se duplica.
      const match = same.find((x) => sameSeller(incoming, sellerOfExisting(p, x)));
      if (match) {
        const blocked = guard(p, match, rec, 'offer');
        return blocked.length ? reviewExisting(index, blocked, [p.id]) : { kind: 'offer', product: p, offer: match };
      }
      // En plataformas de un solo vendedor por anuncio, otro vendedor es una CONTRADICCIÓN de identidad, no una oferta nueva.
      const knownOthers = same.filter((x) => sellerOfExisting(p, x).known);
      if (SINGLE_SELLER_PLATFORMS.has(fold(o.platform).replace(/ /g, '')) && knownOthers.length) {
        const known = sellerOfExisting(p, knownOthers[0]);
        return reviewExisting(index, [`anuncio_con_vendedor_distinto:${known.name ?? known.id}≠${incoming.name ?? incoming.id}`], [p.id]);
      }
      const blocked = guard(p, null, rec, 'link');
      if (blocked.length) return reviewExisting(index, blocked, [p.id]);
      return { kind: 'link', product: p, reason: 'mismo_anuncio_otro_vendedor' };
    }
    if (declaredPlatformSeller) {
      // Vende la plataforma: coincide con la oferta SIN vendedor nombrado (si existe) o es otra oferta (la de la plataforma).
      const unnamed = same.find((x) => !sellerOfExisting(p, x).known);
      const blocked = guard(p, unnamed ?? null, rec, unnamed ? 'offer' : 'link');
      if (blocked.length) return reviewExisting(index, blocked, [p.id]);
      return unnamed ? { kind: 'offer', product: p, offer: unnamed } : { kind: 'link', product: p, reason: 'mismo_anuncio_otro_vendedor' };
    }
    // Sin vendedor fiable en el registro y con ofertas ya registradas de ese anuncio: no se asume que coincide con ninguna.
    if (same.length) return reviewExisting(index, ['vendedor_no_confirmado'], [p.id]);
  }

  // 2) GTIN válido.
  const byGtin = rec.product.gtin ? resolveByIdentifier(index, rec, index.byGtin.get(rec.product.gtin), 'gtin') : null;
  if (byGtin) return secured(index, byGtin, rec);

  // 3) Marca + referencia del fabricante.
  const brandKey = normalizeBrand(rec.product.brand).key;
  if (brandKey && rec.product.mpn) {
    const byMpn = resolveByIdentifier(index, rec, index.byBrandMpn.get(`${brandKey}|${fold(rec.product.mpn)}`), 'marca_mpn');
    if (byMpn) return secured(index, byMpn, rec);
  }

  // 4) Parecido débil (título): NUNCA fusiona; sólo deja la coincidencia para revisión.
  const titleKey = cleanTitleKey(rec.product.title);
  const weak = new Set<string>();
  index.byTitle.get(titleKey)?.forEach((id) => weak.add(id));
  const mine = tokens(rec.product.title);
  if (brandKey) {
    index.byBrand.get(brandKey)?.forEach((id) => {
      const p = index.byId.get(id);
      if (p && jaccard(mine, tokens(p.title)) >= 0.9) weak.add(id);
    });
  } else {
    // Sin marca en el registro no se puede acotar por fabricante: se comparan los títulos de las fichas SIN marca conocida.
    index.byId.forEach((p, id) => {
      if (!normalizeBrand(resolveBrand(p as never)).key && jaccard(mine, tokens(p.title)) >= 0.9) weak.add(id);
    });
  }
  const weakPlausible = [...weak].filter((id) => {
    const p = index.byId.get(id)!;
    return compatibility(p, rec) !== 'different_condition';
  });
  if (weakPlausible.length) {
    // Identidad al CREAR: si el título se parece pero los identificadores del fabricante se contradicen, se dice expresamente (sigue sin crearse ni unirse).
    const contradictory = weakPlausible.flatMap((id) => productContradictions(index.byId.get(id)!, rec, 'offer').filter((r) => /^(gtin|mpn)_contradictori/.test(r)));
    return { kind: 'review', reasons: contradictory.length ? ['titulo_parecido_con_identificadores_contradictorios', ...new Set(contradictory)] : ['titulo_parecido_sin_identificador_fuerte'], candidates: candidatesOf(index, weakPlausible, 'titulo_parecido') };
  }
  return { kind: 'create' };
}

/* ───────────────────────── Construcción / actualización ───────────────────────── */

const CONDITION_LABEL: Record<Condition, string | undefined> = {
  new: 'Nuevo',
  used: 'Usado',
  refurbished: 'Reacondicionado',
  open_box: 'Abierto, sin usar',
  unknown: undefined,
};

/** Envío CONOCIDO de la oferta (sólo valores declarados) con la fecha de captura que lo respalda, si es fiable (no inferida). */
function shippingSnapshot(o: CanonicalRecord['offer']): OfferShipping | undefined {
  const s = o.shipping;
  const out: OfferShipping = { cost: s.cost, free: s.free, days: s.days };
  if (s.text) out.text = s.text;
  if (s.cost === null && s.free === null && s.days === null && !s.text) return undefined;
  if (!o.capturedAtInferred && o.capturedAt) out.asOf = o.capturedAt;
  return out;
}

function storedFrom(rec: CanonicalRecord, batchId: string, nowIso: string): StoredOffer {
  const key = computeOfferKey(rec.offer);
  // Sólo se guardan atributos CONOCIDOS que la fuente declaró (nada inventado). Las ofertas ya guardadas no se completan.
  const variant: NonNullable<StoredOffer['variant']> = {};
  for (const k of VARIANT_KEYS) if (rec.variant[k]) variant[k] = rec.variant[k];
  return {
    ...rec.offer,
    shipping: shippingSnapshot(rec.offer) ?? rec.offer.shipping,
    ...(Object.keys(variant).length ? { variant } : {}),
    ...(rec.variant.pack ? { quantity: rec.variant.pack } : {}),
    offerId: shortHash(key, 10),
    offerKey: key,
    receivedAt: nowIso, // recepción por Treidilor (no es verificación)
    verifiedAt: '', // sólo la fijará el servicio de actualización cuando verifique la oferta contra la fuente
    source: { channel: 'json', batchId, adapter: 'json-import' },
    status: 'active',
  };
}

function platformLabel(platform: string): string {
  return platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : 'Comercio';
}

function buildProduct(rec: CanonicalRecord, id: string, batchId: string, nowIso: string, target?: ImportTarget, sourceCategory?: string): P {
  const o = rec.offer;
  const isAmazon = o.platform === 'amazon';
  const asin = isAmazon && o.externalId && /^[A-Z0-9]{10}$/i.test(o.externalId) ? o.externalId.toUpperCase() : undefined;
  const sourceId = o.platform === 'aliexpress' && o.externalId && /^\d+$/.test(o.externalId) ? `AE-${o.externalId}` : o.externalId;
  const variantAttributes: Any = {};
  for (const key of VARIANT_KEYS) if (rec.variant[key]) variantAttributes[key] = rec.variant[key];
  const identifiers: Any = {};
  if (rec.product.gtin) identifiers.gtin = rec.product.gtin;
  if (rec.product.mpn) identifiers.mpn = rec.product.mpn;
  if (asin) identifiers.asin = asin;
  // La lectura de la oferta principal se guarda APARTE de la verificación (`lastPriceSync` / `refresh.lastVerifiedAt`).
  const reading: PriceReading = {
    capturedAt: o.capturedAt,
    capturedAtInferred: o.capturedAtInferred === true,
    receivedAt: nowIso,
    source: { channel: 'json', batchId, adapter: 'json-import' },
    // Envío de la oferta principal (coste, gratis, plazo) con su fecha de referencia: los campos planos no guardan el coste.
    ...(shippingSnapshot(o) ? { shipping: shippingSnapshot(o) } : {}),
  };
  const extra: Any = { importMeta: { channel: 'json', batchId, importedAt: nowIso }, priceReading: reading };
  // Trazabilidad: la categoría que traía la fuente se conserva aunque el destino elegido en el panel la sustituya.
  if (target && sourceCategory && sourceCategory !== target.category) extra.importMeta.sourceCategory = sourceCategory;
  // Enlace de ORIGEN (dónde se vio la oferta), siempre separado del de afiliado: sin `affiliateUrl` real la ficha queda `link_status: pending`.
  if (o.url) extra.sourceUrl = o.url;
  // Vendedor de la oferta principal (si no es la propia plataforma): permite reconocerla al reimportar sin duplicarla.
  if (sellerKey(o.platform, o.sellerId, o.sellerName)) extra.offerSeller = { ...(o.sellerId ? { id: o.sellerId } : {}), ...(o.sellerName ? { name: o.sellerName } : {}) };
  if (Object.keys(identifiers).length) extra.identifiers = identifiers;
  if (Object.keys(variantAttributes).length) extra.variantAttributes = variantAttributes;

  const product: Any = {
    id,
    title: rec.product.title,
    description: rec.product.description ?? '',
    price: o.price,
    originalPrice: o.originalPrice,
    image: rec.product.images[0],
    gallery: rec.product.images.length > 1 ? rec.product.images : undefined,
    // Sin categoría = vacía: es la convención del panel (preset “Sin Categoria”) y de keepUncategorized.
    category: rec.product.category as string,
    merchant: platformLabel(o.platform),
    network: o.platform,
    currency: o.currency,
    inStock: o.availability === 'in_stock' ? true : o.availability === 'out_of_stock' ? false : undefined,
    affiliateUrl: o.affiliateUrl || o.url,
    asin,
    sourceId,
    brand: rec.product.brand,
    condition: CONDITION_LABEL[rec.variant.condition],
    specs: rec.product.specs,
    rating: rec.product.rating,
    reviewsCount: rec.product.reviewsCount,
    pros: [],
    cons: [],
    link_status: o.affiliateUrl ? 'active' : 'pending',
    ia_status: 'pending',
    shippingInfo: o.shipping.text,
    shippingDays: o.shipping.days ?? undefined,
    freeShipping: o.shipping.free === true ? true : undefined,
    // NO se escribe `lastPriceSync`: es la fecha de VERIFICACIÓN contra la tienda (la ficha pública muestra «✓ Precio
    // verificado» y el checkout «Precio verificado el…» cuando existe). Recibir un JSON no verifica nada.
    extra,
  };
  // Destino elegido en el panel (ya validado): ids jerárquicos como los del resto del catálogo.
  if (target) {
    product.category_id = target.categoryId;
    if (target.subcategoryId) product.subcategory_id = target.subcategoryId;
  }
  for (const key of Object.keys(product)) if (product[key] === undefined) delete product[key];
  return product as unknown as P;
}

/** Datos de producto que se COMPLETAN (nunca se sustituyen) al vincular/actualizar. */
function fillProductData(p: P, rec: CanonicalRecord): P {
  const locked = new Set(readLockedFields(p as never));
  const next: Any = { ...(p as unknown as Any) };
  const extra: Any = { ...(p.extra ?? {}) };
  if (!String(p.brand ?? '').trim() && rec.product.brand && !locked.has('brand')) next.brand = rec.product.brand;
  const ids = { ...((extra.identifiers ?? {}) as Any) };
  if (!ids.gtin && rec.product.gtin) ids.gtin = rec.product.gtin;
  if (!ids.mpn && rec.product.mpn) ids.mpn = rec.product.mpn;
  if (Object.keys(ids).length) extra.identifiers = ids;
  const gallery = Array.isArray(p.gallery) ? [...p.gallery] : p.image ? [p.image] : [];
  const seen = new Set(gallery);
  for (const url of rec.product.images) if (!seen.has(url) && gallery.length < 20) gallery.push(url);
  if (gallery.length > (Array.isArray(p.gallery) ? p.gallery.length : p.image ? 1 : 0)) next.gallery = gallery;
  if (rec.product.specs && !locked.has('specs')) {
    const specs = { ...(p.specs ?? {}) } as Record<string, string>;
    let added = false;
    for (const [k, v] of Object.entries(rec.product.specs)) {
      if (!(k in specs)) {
        specs[k] = v;
        added = true;
      }
    }
    if (added) next.specs = specs;
  }
  if (p.extra || Object.keys(extra).length) next.extra = extra;
  return next as unknown as P;
}

const sameNumber = (a?: number | null, b?: number | null) =>
  (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < PRICE_EPSILON);

interface OfferPatch {
  changed: string[];
  next: StoredOffer;
}

/** Aplica la lectura nueva sobre la oferta existente. Los desconocidos NO sobrescriben. */
function patchOffer(existing: StoredOffer, rec: CanonicalRecord, batchId: string, nowIso: string): OfferPatch | { stale: true } {
  const incoming = rec.offer;
  // Se descarta por antigüedad sólo con fechas FIABLES (de la fuente): una captura inferida (= recepción) no dice
  // cuándo se observó el precio, así que ni puede declarar «anterior» a otra lectura ni serlo. Referencias: la captura
  // de la lectura guardada y, en la oferta principal, la última VERIFICACIÓN real del refresco.
  if (!incoming.capturedAtInferred) {
    const incomingMs = Date.parse(incoming.capturedAt);
    const references: string[] = [];
    if (existing.capturedAt && !existing.capturedAtInferred) references.push(existing.capturedAt);
    if (existing.implicit && existing.verifiedAt) references.push(existing.verifiedAt);
    if (references.some((date) => Number.isFinite(Date.parse(date)) && incomingMs < Date.parse(date))) return { stale: true };
  }
  const changed: string[] = [];
  const next: StoredOffer = { ...existing, shipping: { ...existing.shipping } };
  if (!sameNumber(existing.price, incoming.price)) { next.price = incoming.price; changed.push('precio'); }
  if (existing.currency !== incoming.currency) { next.currency = incoming.currency; changed.push('moneda'); }
  // El precio anterior sólo se conserva si sigue siendo coherente con el precio nuevo.
  const keepOriginal = incoming.originalPrice ?? (existing.originalPrice && existing.originalPrice > next.price ? existing.originalPrice : undefined);
  if (!sameNumber(existing.originalPrice, keepOriginal)) { next.originalPrice = keepOriginal; changed.push('precio_anterior'); }
  if (incoming.availability !== 'unknown' && incoming.availability !== existing.availability) {
    next.availability = incoming.availability;
    changed.push('disponibilidad');
  }
  const s = incoming.shipping;
  if (s.cost !== null && !sameNumber(existing.shipping.cost, s.cost)) { next.shipping.cost = s.cost; changed.push('envio_coste'); }
  if (s.free !== null && existing.shipping.free !== s.free) { next.shipping.free = s.free; changed.push('envio_gratis'); }
  if (s.days !== null && existing.shipping.days !== s.days) { next.shipping.days = s.days; changed.push('envio_plazo'); }
  if (s.text && s.text !== existing.shipping.text) { next.shipping.text = s.text; changed.push('envio_texto'); }
  if (changed.some((c) => c.startsWith('envio_')) && !incoming.capturedAtInferred && incoming.capturedAt) next.shipping.asOf = incoming.capturedAt;
  // El vendedor de la oferta implícita no es representable en los campos planos: no cuenta como cambio.
  if (!existing.implicit && !existing.sellerName && incoming.sellerName) { next.sellerName = incoming.sellerName; changed.push('vendedor'); }
  if (!existing.affiliateUrl && incoming.affiliateUrl && !existing.implicit) { next.affiliateUrl = incoming.affiliateUrl; changed.push('enlace_afiliado'); }
  if (changed.length) {
    next.capturedAt = incoming.capturedAt;
    next.capturedAtInferred = incoming.capturedAtInferred;
    next.receivedAt = nowIso;
    next.source = { channel: 'json', batchId, adapter: 'json-import' };
  }
  return { changed, next };
}

/** Traslada los cambios de la oferta implícita a los campos planos (respetando bloqueos). */
function applyToFlat(p: P, patch: OfferPatch, rec: CanonicalRecord, batchId: string, nowIso: string): { product: P; blocked: string[] } {
  const o = patch.next;
  const flat: Any = { ...(p as unknown as Any) };
  if (patch.changed.includes('precio')) flat.price = o.price;
  if (patch.changed.includes('moneda')) flat.currency = o.currency;
  if (patch.changed.includes('precio_anterior')) flat.originalPrice = o.originalPrice;
  if (patch.changed.includes('disponibilidad')) flat.inStock = o.availability === 'in_stock';
  if (patch.changed.includes('envio_gratis') && o.shipping.free === true) flat.freeShipping = true;
  if (patch.changed.includes('envio_plazo') && o.shipping.days !== null) flat.shippingDays = o.shipping.days;
  if (patch.changed.includes('envio_texto')) flat.shippingInfo = o.shipping.text;
  // `lastPriceSync` NUNCA se escribe aquí: un JSON recibido no demuestra que el precio se haya verificado.
  const merged = mergeReimport(p as unknown as Any, flat) as unknown as P;
  const m = merged as unknown as Any;
  const old = p as unknown as Any;
  const mExtra: Any = { ...((m.extra ?? {}) as Any) };
  const oldExtra = (old.extra ?? {}) as Any;
  const previous = oldExtra.priceReading as PriceReading | undefined;

  // Lectura recibida de la oferta principal: captura (con su procedencia y si es inferida) y recepción.
  const reading: PriceReading = {
    capturedAt: rec.offer.capturedAt,
    capturedAtInferred: rec.offer.capturedAtInferred === true,
    receivedAt: nowIso,
    source: { channel: 'json', batchId, adapter: 'json-import' },
    ...(previous?.verifiedBefore?.length ? { verifiedBefore: previous.verifiedBefore } : {}),
    ...(previous?.shipping ? { shipping: previous.shipping } : {}),
  };
  // Envío de la oferta principal: sólo se actualiza si el envío cambió (coste, gratis, plazo o texto) y con lo que declara el registro.
  if (patch.changed.some((c) => c.startsWith('envio_'))) {
    const snap = shippingSnapshot(rec.offer);
    if (snap) {
      const prev = (previous?.shipping ?? {}) as Any;
      const merged: Any = { ...prev };
      if (snap.cost !== null) merged.cost = snap.cost;
      if (snap.free !== null) merged.free = snap.free;
      if (snap.days !== null) merged.days = snap.days;
      if (snap.text) merged.text = snap.text;
      if (snap.asOf) merged.asOf = snap.asOf;
      reading.shipping = merged as never;
    }
  }

  // Si el PRECIO (o la moneda) cambió de verdad, la verificación anterior corresponde a un precio que ya no es el actual:
  // se retira de los campos públicos (la ficha deja de mostrar «Precio verificado» y las alertas no se apoyan en ella) y
  // se CONSERVA como histórico con el precio al que se refería. Un reimportado sin cambios o con campos bloqueados no
  // toca nada.
  const priceChanged = m.price !== old.price || m.currency !== old.currency;
  if (priceChanged) {
    const refreshMeta = (oldExtra.refresh ?? {}) as Any;
    const verifiedAt = String(refreshMeta.lastVerifiedAt || old.lastPriceSync || '');
    if (verifiedAt) {
      const history = [
        ...(reading.verifiedBefore ?? []),
        { verifiedAt, price: Number(old.price), currency: String(old.currency || 'EUR'), supersededAt: nowIso, supersededBy: batchId },
      ];
      reading.verifiedBefore = history.slice(-10);
    }
    delete m.lastPriceSync;
    if (oldExtra.refresh) {
      const { lastVerifiedAt: _gone, ...restRefresh } = refreshMeta;
      mExtra.refresh = restRefresh;
    }
  }
  mExtra.priceReading = reading;
  m.extra = mExtra;
  // Los campos bloqueados por edición manual se detectan comparando con lo pedido.
  const blocked = ['price', 'currency', 'originalPrice', 'inStock']
    .filter((k) => flat[k] !== (p as unknown as Any)[k] && (merged as unknown as Any)[k] !== flat[k]);
  return { product: merged, blocked };
}

/* ───────────────────────── Aplicación del lote ───────────────────────── */

export interface DeletedChecks {
  /** ¿Es (por identidad fiable) una ficha eliminada? `includeGtin` sólo al CREAR una ficha. */
  product(candidate: {
    id?: string;
    platform?: string;
    offerKey?: string;
    sourceId?: string;
    urls?: string[];
    gtin?: string;
    variant?: Record<string, string | undefined>;
  }, includeGtin: boolean): { deletedId: string; by: string } | null;
  /** ¿Se eliminó esta oferta concreta? */
  offer(offerKey: string): boolean;
}

export interface EngineOptions {
  batchId: string;
  nowIso: string;
  /** Ids eliminados desde el panel (no se resucitan). */
  deletedIds: Set<string>;
  /** Memoria de eliminados por identidad y por oferta (opcional; sin ella sólo rige el id). */
  deleted?: DeletedChecks;
  /** Índice global del primer registro de este bloque. */
  indexOffset?: number;
  /** Destino (ya validado) de las fichas NUEVAS; no afecta a fichas existentes. Sin él rigen las reglas habituales. */
  target?: ImportTarget;
  /**
   * Sólo productos NUEVOS: todo registro que ya existe en el catálogo (misma oferta o mismo anuncio con otro vendedor, también dentro del
   * propio lote) se OMITE: no se actualiza, no se vincula ni se vuelve a incluir. Sin esta opción, reimportar actualiza/vincula ofertas.
   */
  onlyNew?: boolean;
}

export interface EngineOutput {
  products: P[];
  changed: boolean;
  results: RecordResult[];
}

function result(index: number, outcome: RecordResult['outcome'], extra: Partial<RecordResult> = {}): RecordResult {
  return { index, outcome, reasons: [], warnings: [], entities: EMPTY_ENTITIES(), ...extra };
}

export function runImport(catalog: Product[], rawRecords: unknown[], defaults: ImportDefaults, opts: EngineOptions): EngineOutput {
  const index = new Index();
  const original = catalog as P[];
  for (const p of original) index.register(p);
  const replaced = new Map<string, P>();
  const created: P[] = [];
  const results: RecordResult[] = [];
  const offset = opts.indexOffset ?? 0;
  // Anuncios ya aplicados en ESTE lote (clave de oferta → precio): un segundo registro con otro precio es contradictorio.
  const batchApplied = new Map<string, number>();

  const setProduct = (p: P) => {
    if (created.some((c) => c.id === p.id)) created[created.findIndex((c) => c.id === p.id)] = p;
    else replaced.set(p.id, p);
    index.register(p);
  };

  rawRecords.forEach((raw, i) => {
    const gi = offset + i;
    try {
      const norm = normalizeRecord(raw, gi, defaults, opts.nowIso);
      if (!norm.record) {
        results.push(result(gi, 'rejected', { reasons: norm.errors, title: titleOf(raw) }));
        return;
      }
      const rec = sanitizeSeller(norm.record);
      const base = { title: rec.product.title, warnings: rec.warnings };
      const offerKey = computeOfferKey(rec.offer);
      // Datos contradictorios en la propia fuente (título ≠ atributos…): no se aplica nada; se conserva para revisión.
      if (rec.reviewReasons?.length) {
        results.push(result(gi, 'review', { ...base, offerKey, reasons: rec.reviewReasons, record: rec }));
        return;
      }
      // El id declarado de la oferta no puede contradecir el que lleva su propia URL (ASIN, id de AliExpress).
      const contradiction = contradictionOfOffer({ platform: rec.offer.platform, externalId: rec.offer.externalId, url: rec.offer.url, canonicalUrl: rec.offer.canonicalUrl });
      if (contradiction) {
        results.push(result(gi, 'review', { ...base, offerKey, reasons: ['identificadores_contradictorios', contradiction], record: rec }));
        return;
      }
      const res = resolve(index, rec);

      if (res.kind === 'review') {
        // «Sólo productos nuevos»: si la revisión protege algo que YA existe, se omite como «ya existe» (no se escribe nada).
        if (opts.onlyNew && res.existing) {
          results.push(result(gi, 'unchanged', { ...base, productId: res.candidates[0]?.productId, offerKey, reasons: ['ya_existe_omitido', ...res.reasons] }));
          return;
        }
        results.push(result(gi, 'review', { ...base, offerKey, reasons: res.reasons, candidates: res.candidates, record: rec }));
        return;
      }

      // Eliminados: una oferta eliminada por separado no vuelve; una FICHA eliminada
      // tampoco con otro id ni por otro canal (por identidad fiable, nunca por título).
      // Si la oferta YA está en el catálogo (se recuperó a propósito) se deja actualizar.
      if (res.kind !== 'offer' && opts.deleted) {
        if (opts.deleted.offer(offerKey)) {
          results.push(result(gi, 'rejected', { ...base, offerKey, reasons: ['oferta_eliminada_anteriormente'] }));
          return;
        }
        const hit = opts.deleted.product(
          {
            platform: rec.offer.platform,
            offerKey,
            sourceId: rec.offer.externalId,
            urls: [rec.offer.url, rec.offer.affiliateUrl].filter(Boolean) as string[],
            gtin: rec.product.gtin,
            variant: { condition: rec.variant.condition, color: rec.variant.color, size: rec.variant.size, capacity: rec.variant.capacity, pack: rec.variant.pack },
          },
          res.kind === 'create',
        );
        if (hit) {
          results.push(result(gi, 'rejected', { ...base, offerKey, productId: hit.deletedId, reasons: ['producto_eliminado_anteriormente', `eliminado_por_${hit.by}`] }));
          return;
        }
      }

      // «Sólo nuevos»: lo que ya existe no se vuelve a incluir ni se toca.
      if (opts.onlyNew && (res.kind === 'offer' || res.kind === 'link')) {
        results.push(result(gi, 'unchanged', { ...base, productId: res.product.id, offerKey, reasons: ['ya_existe_omitido'] }));
        return;
      }

      // Mismo anuncio repetido en el lote con un precio contradictorio: no se actualiza en silencio; queda en revisión (se conserva el primero).
      if (offerKey && (res.kind === 'offer' || res.kind === 'link') && batchApplied.has(offerKey) && !sameNumber(batchApplied.get(offerKey), rec.offer.price)) {
        results.push(result(gi, 'review', { ...base, offerKey, reasons: [`anuncio_repetido_en_lote_con_precio_distinto:${batchApplied.get(offerKey)}≠${rec.offer.price}`], candidates: candidatesOf(index, [res.product.id], 'repetido_en_lote'), record: rec }));
        return;
      }

      if (res.kind === 'offer') {
        const patch = patchOffer(res.offer, rec, opts.batchId, opts.nowIso);
        if ('stale' in patch) {
          results.push(result(gi, 'unchanged', { ...base, productId: res.product.id, offerKey, reasons: ['lectura_anterior_descartada'] }));
          return;
        }
        const filled = fillProductData(res.product, rec);
        const dataChanged = JSON.stringify(filled) !== JSON.stringify(res.product);
        if (!patch.changed.length && !dataChanged) {
          results.push(result(gi, 'unchanged', { ...base, productId: res.product.id, offerKey }));
          return;
        }
        let nextProduct = filled;
        let blocked: string[] = [];
        if (res.offer.implicit) {
          if (patch.changed.length) {
            const applied = applyToFlat(filled, patch, rec, opts.batchId, opts.nowIso);
            nextProduct = applied.product;
            blocked = applied.blocked;
          }
        } else {
          const list = storedOffers(filled).map((x) => (x.offerKey === res.offer.offerKey ? patch.next : x));
          nextProduct = { ...filled, extra: { ...(filled.extra ?? {}), offers: list } } as P;
        }
        setProduct(nextProduct);
        if (offerKey) batchApplied.set(offerKey, rec.offer.price);
        const reasons = [...patch.changed, ...blocked.map((b) => `campo_bloqueado_${b}`)];
        if (!patch.changed.length) reasons.push('datos_de_producto_completados');
        results.push(
          result(gi, patch.changed.length ? 'updated' : 'unchanged', {
            ...base,
            productId: res.product.id,
            offerKey,
            reasons,
            entities: { productsCreated: 0, offersCreated: 0, offersUpdated: patch.changed.length ? 1 : 0 },
          }),
        );
        return;
      }

      if (res.kind === 'link') {
        const stored = storedOffers(res.product);
        if (stored.length >= MAX_STORED_OFFERS) {
          results.push(result(gi, 'rejected', { ...base, productId: res.product.id, offerKey, reasons: ['limite_de_ofertas_por_ficha'] }));
          return;
        }
        const offer = storedFrom(rec, opts.batchId, opts.nowIso);
        const filled = fillProductData(res.product, rec);
        const nextProduct = { ...filled, extra: { ...(filled.extra ?? {}), offers: [...stored, offer] } } as P;
        setProduct(nextProduct);
        if (offerKey) batchApplied.set(offerKey, rec.offer.price);
        results.push(
          result(gi, 'linked', {
            ...base,
            productId: res.product.id,
            offerKey,
            reasons: [res.reason],
            entities: { productsCreated: 0, offersCreated: 1, offersUpdated: 0 },
          }),
        );
        return;
      }

      // Crear ficha nueva. Sin categoría NO se publica sola: queda en revisión con sus
      // datos completos para resolverla después (no afecta a vincular ofertas).
      // El destino elegido en el panel manda sobre la categoría de la fuente, pero SOLO aquí (ficha nueva).
      const sourceCategory = rec.product.category;
      const createRec: CanonicalRecord = opts.target ? { ...rec, product: { ...rec.product, category: opts.target.category } } : rec;
      if (!createRec.product.category) {
        results.push(result(gi, 'review', { ...base, offerKey, reasons: ['sin_categoria'], record: rec }));
        return;
      }
      if (!rec.product.images.length) {
        results.push(result(gi, 'rejected', { ...base, offerKey, reasons: ['falta_imagen_para_crear_ficha'] }));
        return;
      }
      const asin = rec.offer.platform === 'amazon' && rec.offer.externalId && /^[A-Z0-9]{10}$/i.test(rec.offer.externalId) ? rec.offer.externalId.toLowerCase() : '';
      let id = asin ? `amazon-${asin}` : `${slugify(rec.product.title).slice(0, 40)}-${shortHash(offerKey || rec.offer.canonicalUrl)}`;
      if (opts.deletedIds.has(id)) {
        results.push(result(gi, 'rejected', { ...base, offerKey, productId: id, reasons: ['producto_eliminado_anteriormente'] }));
        return;
      }
      // Nunca se reemplaza una ficha existente por colisión de id.
      if (index.byId.has(id)) id = `${id}-${shortHash(`${offerKey}|${gi}|${opts.batchId}`, 4)}`;
      const product = buildProduct(createRec, id, opts.batchId, opts.nowIso, opts.target, sourceCategory);
      created.push(product);
      index.register(product);
      if (offerKey) batchApplied.set(offerKey, rec.offer.price);
      results.push(
        result(gi, 'created', {
          ...base,
          productId: id,
          offerKey,
          entities: { productsCreated: 1, offersCreated: 1, offersUpdated: 0 },
          ...(opts.target ? { categoryApplied: opts.target.subcategoryName ? `${opts.target.category} › ${opts.target.subcategoryName}` : opts.target.category } : {}),
        }),
      );
    } catch (error) {
      results.push(result(gi, 'error', { reasons: [`excepcion: ${(error as Error)?.message ?? String(error)}`.slice(0, 200)] }));
    }
  });

  const changed = created.length > 0 || replaced.size > 0;
  const merged = original.map((p) => replaced.get(p.id) ?? p);
  // Las fichas nuevas van al principio, como hace `upsertProduct` (la última creada, primera).
  return { products: changed ? [...[...created].reverse(), ...merged] : original, changed, results };
}

function titleOf(raw: unknown): string | undefined {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Any;
  const p = (o.product && typeof o.product === 'object' ? o.product : {}) as Any;
  const t = String(p.title ?? o.title ?? o.name ?? '').trim();
  return t ? t.slice(0, 120) : undefined;
}
