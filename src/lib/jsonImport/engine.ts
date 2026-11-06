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
  type ImportDefaults,
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
  | { kind: 'review'; reasons: string[]; candidates: ReviewCandidate[] }
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

function resolve(index: Index, rec: CanonicalRecord): Resolution {
  const o = rec.offer;
  const key = computeOfferKey(o);

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
    if (offer) return { kind: 'offer', product: p, offer };
  }

  // 1b) Mismo anuncio/ASIN de la plataforma con OTRO vendedor → misma ficha, oferta distinta.
  const samePlatformId = index.byPlatformId.get(platformIdKey(o.platform, o.externalId));
  if (samePlatformId && samePlatformId.size === 1) {
    const p = index.byId.get([...samePlatformId][0])!;
    if (compatibility(p, rec) === 'compatible') return { kind: 'link', product: p, reason: 'mismo_anuncio_otro_vendedor' };
  }

  // 2) GTIN válido.
  const byGtin = rec.product.gtin ? resolveByIdentifier(index, rec, index.byGtin.get(rec.product.gtin), 'gtin') : null;
  if (byGtin) return byGtin;

  // 3) Marca + referencia del fabricante.
  const brandKey = normalizeBrand(rec.product.brand).key;
  if (brandKey && rec.product.mpn) {
    const byMpn = resolveByIdentifier(index, rec, index.byBrandMpn.get(`${brandKey}|${fold(rec.product.mpn)}`), 'marca_mpn');
    if (byMpn) return byMpn;
  }

  // 4) Parecido débil (título): NUNCA fusiona; sólo deja la coincidencia para revisión.
  const titleKey = cleanTitleKey(rec.product.title);
  const weak = new Set<string>();
  index.byTitle.get(titleKey)?.forEach((id) => weak.add(id));
  if (brandKey) {
    const mine = tokens(rec.product.title);
    index.byBrand.get(brandKey)?.forEach((id) => {
      const p = index.byId.get(id);
      if (p && jaccard(mine, tokens(p.title)) >= 0.9) weak.add(id);
    });
  }
  const weakPlausible = [...weak].filter((id) => {
    const p = index.byId.get(id)!;
    return compatibility(p, rec) !== 'different_condition';
  });
  if (weakPlausible.length) {
    return { kind: 'review', reasons: ['titulo_parecido_sin_identificador_fuerte'], candidates: candidatesOf(index, weakPlausible, 'titulo_parecido') };
  }
  return { kind: 'create' };
}

/* ───────────────────────── Construcción / actualización ───────────────────────── */

const CONDITION_LABEL: Record<Condition, string | undefined> = {
  new: 'Nuevo',
  used: 'Usado',
  refurbished: 'Reacondicionado',
  unknown: undefined,
};

function storedFrom(rec: CanonicalRecord, batchId: string, nowIso: string): StoredOffer {
  const key = computeOfferKey(rec.offer);
  return {
    ...rec.offer,
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

function buildProduct(rec: CanonicalRecord, id: string, batchId: string, nowIso: string): P {
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
  };
  const extra: Any = { importMeta: { channel: 'json', batchId, importedAt: nowIso }, priceReading: reading };
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
  };

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
      const rec = norm.record;
      const base = { title: rec.product.title, warnings: rec.warnings };
      const offerKey = computeOfferKey(rec.offer);
      const res = resolve(index, rec);

      if (res.kind === 'review') {
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
      if (!rec.product.category) {
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
      const product = buildProduct(rec, id, opts.batchId, opts.nowIso);
      created.push(product);
      index.register(product);
      results.push(
        result(gi, 'created', {
          ...base,
          productId: id,
          offerKey,
          entities: { productsCreated: 1, offersCreated: 1, offersUpdated: 0 },
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
