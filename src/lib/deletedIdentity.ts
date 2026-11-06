/**
 * ==============================================================================
 * TREIDILOR — ELIMINADOS: IDENTIDAD DE FICHA Y DE OFERTA (lógica)
 * ==============================================================================
 * Eliminar una FICHA COMPLETA y eliminar una OFERTA son cosas distintas:
 *
 *  - Ficha completa → `recordProductDeletion`: tombstone por id (existente) + la
 *    IDENTIDAD de la ficha (claves de oferta, ids externos, URLs canónicas, GTIN
 *    y variante). Impide que el mismo producto vuelva con otro id o por otro
 *    canal (API, JSON, auto-curación, Construir Catálogo…).
 *  - Una oferta → `deleteOffer`: sólo se quita esa oferta de `extra.offers` y se
 *    recuerda su clave. NO bloquea la ficha ni las demás ofertas.
 *
 * Fiabilidad (nunca por título): sólo coinciden claves de oferta (red + id
 * [+ vendedor]), ids externos FUERTES (ASIN, AliExpress, eBay) o de la misma
 * plataforma, URLs canónicas con identificador de producto y GTIN válido con
 * variante compatible. Estado (nuevo/usado) o atributos distintos = otra
 * variante: no se bloquea.
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths';
import {
  addDeletedId,
  addDeletedIdentity,
  addDeletedOffer,
  removeDeletedId,
  readDeletedIds,
  readDeletedIdentities,
  readDeletedOffers,
  type DeletedIdentity,
  type DeletedIdentityRecord,
} from './deletedProducts';
import { canonicalProductUrl, extractSourceId } from './curation';
import { fold, getOffers, productCondition, storedOffers, type P } from './catalogOffers';
import { normalizeSourceId } from './offerIdentity';
import { updateCatalog, type Product } from './productStore';

const VARIANT_KEYS = ['color', 'size', 'capacity', 'pack'] as const;

/** ASIN, ids de AliExpress (AE-/numéricos largos) y eBay: únicos aunque no se conozca la plataforma. */
export function isStrongSourceId(raw: string | null | undefined): boolean {
  const id = normalizeSourceId(raw);
  if (!id) return false;
  if (/^B[0-9A-Z]{9}$/.test(id)) return true; // ASIN
  if (/^\d{9,}$/.test(id)) return true; // AliExpress / eBay
  return false;
}

/** URL con identificador de producto (no una portada ni una categoría genérica). */
export function reliableCanonicalUrl(url: string | null | undefined): string {
  const canonical = canonicalProductUrl(url);
  if (!canonical) return '';
  if (/amazon\.[a-z.]+\/dp\/b000000000/i.test(canonical)) return ''; // marcador de posición
  const [pathAndHost, query] = canonical.split('?');
  const segments = pathAndHost.split('/').slice(1).filter(Boolean);
  const lastSegmentLong = segments.length > 0 && segments[segments.length - 1].length >= 3;
  return segments.length >= 2 || (segments.length === 1 && lastSegmentLong) || Boolean(query) ? canonical : '';
}

function variantOf(p: P): DeletedIdentity['variant'] {
  const attrs = ((p.extra ?? {}) as Record<string, unknown>).variantAttributes as Record<string, unknown> | undefined;
  const variant: DeletedIdentity['variant'] = {};
  const condition = productCondition(p);
  if (condition !== 'unknown') variant.condition = condition;
  for (const key of VARIANT_KEYS) if (attrs?.[key]) variant[key] = fold(attrs[key]);
  return variant;
}

/** Identidad fiable de una ficha completa (todas sus ofertas incluidas). */
export function identityOfProduct(product: Product): DeletedIdentity {
  const p = product as P;
  const offerKeys = new Set<string>();
  const sourceIds = new Set<string>();
  const urls = new Set<string>();
  const platforms = new Set<string>();
  for (const offer of getOffers(p)) {
    if (offer.offerKey) offerKeys.add(offer.offerKey);
    const id = normalizeSourceId(offer.externalId);
    if (id) sourceIds.add(id);
    if (offer.platform) platforms.add(offer.platform);
    const u1 = reliableCanonicalUrl(offer.url);
    const u2 = reliableCanonicalUrl(offer.affiliateUrl);
    if (u1) urls.add(u1);
    if (u2) urls.add(u2);
  }
  for (const raw of [p.sourceId, p.asin]) {
    const id = normalizeSourceId(raw);
    if (id) sourceIds.add(id);
  }
  for (const raw of [p.affiliateUrl, p.buyNowUrl]) {
    const u = reliableCanonicalUrl(raw);
    if (u) urls.add(u);
  }
  const gtin = String(((p.extra ?? {}) as Record<string, unknown>).identifiers && (((p.extra ?? {}) as Record<string, unknown>).identifiers as Record<string, unknown>).gtin || '').trim();
  return {
    offerKeys: [...offerKeys],
    sourceIds: [...sourceIds],
    urls: [...urls],
    gtins: gtin ? [gtin] : [],
    platforms: [...platforms],
    variant: variantOf(p),
  };
}

/** Elimina una FICHA COMPLETA: tombstone por id + identidad para los demás canales. */
export function recordProductDeletion(product: Product, source: DeletedIdentityRecord['source'] = 'deletion'): void {
  addDeletedId(product.id);
  addDeletedIdentity({ id: product.id, deletedAt: new Date().toISOString(), identity: identityOfProduct(product), source });
}

/* ───────────────────────── Coincidencia con eliminados ───────────────────────── */

export interface DeletedCandidate {
  id?: string | null;
  platform?: string | null;
  offerKey?: string | null;
  sourceId?: string | null;
  urls?: Array<string | null | undefined>;
  gtin?: string | null;
  variant?: Partial<DeletedIdentity['variant']>;
}

export interface DeletedMatch {
  deletedId: string;
  by: 'id' | 'offerKey' | 'sourceId' | 'url' | 'gtin';
}

/** ¿Este candidato es (por identidad fiable) algo que se eliminó como ficha completa? */
export interface DeletedSnapshot {
  ids: string[];
  records: DeletedIdentityRecord[];
  offers: string[];
}

/** Lee una vez lo eliminado (para comprobar muchos candidatos sin releer los ficheros). */
export function loadDeletedSnapshot(): DeletedSnapshot {
  return {
    ids: readDeletedIds(),
    records: readDeletedIdentities(),
    offers: readDeletedOffers().map((o) => o.offerKey),
  };
}

export function matchDeletedProduct(
  candidate: DeletedCandidate,
  opts: { includeGtin?: boolean; snapshot?: DeletedSnapshot } = {},
): DeletedMatch | null {
  const snapshot = opts.snapshot ?? loadDeletedSnapshot();
  const id = String(candidate.id ?? '').trim();
  if (id && snapshot.ids.includes(id)) return { deletedId: id, by: 'id' };

  const records = snapshot.records;
  if (!records.length) return null;
  const platform = fold(candidate.platform).replace(/ /g, '');
  // Sin id externo explícito se deduce de las URLs (ASIN, /item/<id>.html de AliExpress, /itm/<id> de eBay), como
  // hace el resto del catálogo: así una alta manual con la URL del producto eliminado también se reconoce.
  const sourceId =
    normalizeSourceId(candidate.sourceId) ||
    normalizeSourceId(extractSourceId({ affiliateUrl: (candidate.urls ?? []).filter(Boolean).join(' ') } as never));
  const strong = isStrongSourceId(sourceId);
  const urls = (candidate.urls ?? []).map((u) => reliableCanonicalUrl(u)).filter(Boolean);

  for (const record of records) {
    const identity = record.identity;
    if (candidate.offerKey && identity.offerKeys.includes(candidate.offerKey)) return { deletedId: record.id, by: 'offerKey' };
    if (sourceId && identity.sourceIds.some((s) => s.toLowerCase() === sourceId.toLowerCase())) {
      const samePlatform = platform !== '' && identity.platforms.includes(platform);
      if (strong || samePlatform) return { deletedId: record.id, by: 'sourceId' };
    }
    if (urls.some((u) => identity.urls.includes(u))) return { deletedId: record.id, by: 'url' };
    if (opts.includeGtin !== false && candidate.gtin && identity.gtins.includes(candidate.gtin)) {
      // El GTIN identifica una variante exacta: otro estado u otros atributos = otra variante.
      const dv = identity.variant;
      const cv = candidate.variant ?? {};
      const stateDiffers = dv.condition && cv.condition && cv.condition !== 'unknown' && dv.condition !== cv.condition;
      const attrDiffers = VARIANT_KEYS.some((k) => dv[k] && cv[k] && fold(cv[k]) !== dv[k]);
      if (!stateDiffers && !attrDiffers) return { deletedId: record.id, by: 'gtin' };
    }
  }
  return null;
}

/** ¿Esta oferta concreta se eliminó por separado? */
export function matchDeletedOffer(offerKey: string | null | undefined, snapshot?: DeletedSnapshot): boolean {
  const key = String(offerKey ?? '').trim();
  if (!key) return false;
  return (snapshot?.offers ?? readDeletedOffers().map((o) => o.offerKey)).includes(key);
}

/* ───────────────────────── Eliminar una OFERTA (no la ficha) ───────────────────────── */

export type DeleteOfferResult =
  | { ok: true; productId: string; offerKey: string; remaining: number }
  | { ok: false; reason: 'ficha_no_encontrada' | 'oferta_no_encontrada' | 'oferta_principal_de_la_ficha' };

/**
 * Quita UNA oferta adicional (`extra.offers`) de una ficha y recuerda su clave. La
 * oferta principal (campos planos) no se puede quitar sin eliminar la ficha.
 */
export function deleteOffer(productId: string, offerKey: string): DeleteOfferResult {
  const { result } = updateCatalog<DeleteOfferResult>((products) => {
    const index = products.findIndex((p) => p.id === productId);
    if (index < 0) return { changed: false, result: { ok: false, reason: 'ficha_no_encontrada' } };
    const product = products[index] as P;
    const stored = storedOffers(product);
    const target = stored.find((o) => o.offerKey === offerKey);
    if (!target) {
      const implicit = getOffers(product).find((o) => o.implicit && o.offerKey === offerKey);
      return { changed: false, result: { ok: false, reason: implicit ? 'oferta_principal_de_la_ficha' : 'oferta_no_encontrada' } };
    }
    const remaining = stored.filter((o) => o.offerKey !== offerKey);
    const extra = { ...(product.extra ?? {}) } as Record<string, unknown>;
    if (remaining.length) extra.offers = remaining;
    else delete extra.offers;
    products[index] = { ...product, extra } as Product;
    addDeletedOffer({ offerKey, productId, url: target.url, deletedAt: new Date().toISOString() });
    return { changed: true, result: { ok: true, productId, offerKey, remaining: remaining.length } };
  });
  return result;
}

/* ───────────────────────── Eliminaciones antiguas (sólo id) ───────────────────────── */

export interface BackfillReport {
  alreadyIdentified: string[];
  recovered: string[];
  unrecoverable: string[];
  scanned: string[];
}

function backupFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/^products.*\.json$/i.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(DATA_DIR, 'import-backups'), 0);
  walk(path.join(DATA_DIR, 'backups'), 0);
  return out;
}

/**
 * Las eliminaciones ANTIGUAS sólo guardaron el id. Si todavía existe una copia de
 * seguridad que contenga la ficha, se reconstruye su identidad. Las demás se
 * quedan protegidas únicamente por id (no se puede inventar una identidad).
 */
export function backfillDeletedIdentities(options: { apply?: boolean } = {}): BackfillReport {
  const builtin = new Set(['sony-wh-1000xm5', 'apple-macbook-air-m3', 'kindle-paperwhite-signature', 'roborock-q-revo']);
  const known = new Set(readDeletedIdentities().map((r) => r.id));
  const pending = new Set(readDeletedIds().filter((id) => !builtin.has(id) && !known.has(id)));
  const report: BackfillReport = { alreadyIdentified: [...known], recovered: [], unrecoverable: [], scanned: [] };
  if (!pending.size) return report;
  for (const file of backupFiles()) {
    report.scanned.push(file);
    let list: unknown;
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const item of list as Product[]) {
      if (!item || typeof item !== 'object' || !pending.has(item.id)) continue;
      pending.delete(item.id);
      report.recovered.push(item.id);
      if (options.apply) {
        addDeletedIdentity({ id: item.id, deletedAt: new Date().toISOString(), identity: identityOfProduct(item), source: 'backup' });
      }
    }
  }
  report.unrecoverable = [...pending];
  return report;
}

/**
 * Recuperación EXPLÍCITA: cuando el administrador guarda desde el panel una ficha que
 * equivale a algo eliminado (misma oferta, id externo fuerte o URL de producto) se
 * olvida esa eliminación (id + identidad), igual que ya ocurría con el mismo id.
 * Devuelve los ids eliminados que se han olvidado.
 */
export function forgetDeletedMatching(product: Product): string[] {
  const mine = identityOfProduct(product);
  const forgotten: string[] = [];
  for (const record of readDeletedIdentities()) {
    const id = record.identity;
    const same =
      mine.offerKeys.some((k) => id.offerKeys.includes(k)) ||
      mine.urls.some((u) => id.urls.includes(u)) ||
      mine.sourceIds.some((s) => isStrongSourceId(s) && id.sourceIds.some((d) => d.toLowerCase() === s.toLowerCase()));
    if (same) {
      removeDeletedId(record.id);
      forgotten.push(record.id);
    }
  }
  return forgotten;
}

const BY_TEXT: Record<DeletedMatch['by'], string> = {
  id: 'el mismo identificador',
  offerKey: 'la misma oferta',
  sourceId: 'el mismo identificador externo (ASIN/anuncio)',
  url: 'la misma URL de producto',
  gtin: 'el mismo GTIN y variante',
};

/**
 * Texto de bloqueo para altas e importaciones ORDINARIAS (panel, API, JSON…): una ficha eliminada NO se
 * vuelve a crear. Olvidar una eliminación exige una acción explícita de restauración; hoy sólo existe la
 * limpieza global de eliminados (DELETE /api/admin/tombstones) y el panel no tiene un botón de
 * restauración individual, así que el bloqueo se mantiene.
 */
export function deletionBlockMessage(match: DeletedMatch): string {
  return `Producto eliminado anteriormente (coincide por ${BY_TEXT[match.by]}). No se vuelve a crear con importaciones ni altas ordinarias: restaurarlo requiere una acción explícita y el panel aún no tiene un botón de restauración individual.`;
}
