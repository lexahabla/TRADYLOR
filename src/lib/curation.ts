/**
 * ==============================================================================
 * TRADYLOR — CURATION ENGINE (Backend)
 * ==============================================================================
 * Módulo puro (sin I/O de red) con la lógica de curación avanzada del catálogo:
 *  - Detección de duplicados por jerarquía (sourceId → URL canónica → título).
 *  - Score de conversión / rentabilidad interna (0-100).
 *  - Eliminación masiva con tombstones (bulk delete).
 *  - Extracción de tags técnicos normalizados (matriz de atributos).
 *  - Similaridad de títulos para sugerir alternativas (cross-matching).
 * ==============================================================================
 */

import {
  readProductsFromFile,
  writeProductsToFile,
  type Product,
} from './productStore';
import { addDeletedId, clearDeletedIds } from './deletedProducts';
import { getProductNetwork } from './productNetwork';

// ─── Parámetros de tracking/afiliación que se ignoran al comparar URLs ───────
const TRACKING_PARAMS = new Set([
  // Amazon
  'tag', 'linkcode', 'linkid', 'ascsubtag', 'asc_campaign', 'asc_source', 'asc_refurl',
  'pf_rd_p', 'pf_rd_r', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'th', 'psc', 'crid', 'dib',
  'dib_tag', 'keywords', 'qid', 's', 'sprefix', 'cv_ct_pvb', 'content-id', 'camp',
  'creative', 'creativeASIN', 'subscriptionId', 'amzn', 'mgb', 'gmerchant', 'gproduct',
  'gad_source', 'gclid', 'gbraid', 'wbraid',
  // AliExpress
  'aff_fcid', 'aff_fsk', 'aff_platform', 'aff_trace_key', 'algorithm', 'apt',
  'channel', 'cvosrc', 'pcnt', 'ping', 'scm', 'sku', 'sparkmnt', 'terminal_id',
  'utm_pid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'pvid', 'spm', 'pp', 'ap', 'exe', 'exp', 'gp', 'irgwc', 'mall_affr', 'aff_request_id',
  'scene', 'search_p4p_id', 'sort', 'SearchId', 'sk', 'u_id', 'yaml', 'yos',
  'tripped', 'trace', 'ws_ab_test', 'btsid', 'bucket', 'rn', 'rn_id',
  // Genéricos de tracking
  'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'vero_id', 'vero_conv', 'oly_enc_id',
  'oly_anon_id', 'fbclid', 'igshid', 'igsh', 'yclid', 'msclkid', 'twclid',
  'trk', 'trkcampaign', 'sr_share', 'share_id', 'mkt_tok', 'mkcid', 'mkeid',
  'spm_aenc', 'spm_sj', 'spm_uid', 'nl_pid', 'nl_k', 'ncid', 'cmpid', 'cid',
  'wt.mc_id', 'wt.mc_c', 'srsltid', 'ved', 'ei', 'u_aemd', 'u_sig', 'u_it',
]);

/**
 * URL canónica del producto: mismo host+path, sin esquema, sin `www`, sin
 * parámetros de afiliación/tracking y sin barra final. Dos enlaces de afiliado
 * distintos del mismo producto producen la MISMA clave.
 */
export function canonicalProductUrl(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const params = new URLSearchParams(url.search);
    for (const key of [...params.keys()]) {
      const lower = key.toLowerCase();
      if (TRACKING_PARAMS.has(lower) || lower.startsWith('utm_') || lower.startsWith('pk_') || lower.startsWith('mtm_')) {
        params.delete(key);
      }
    }
    const query = params.toString();
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`;
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

/** Clave limpia de título para comparación (minúsculas, sin acentos ni puntuación). */
export function cleanTitleKey(title: string | null | undefined): string {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extrae el ASIN (Amazon) o el Item ID (AliExpress) del enlace/título.
 * Acepta cualquier objeto con esos campos (p. ej. el producto canónico de una
 * red, que no es un `Product` del store pero sí trae `externalId`/enlace).
 */
export function extractSourceId(
  product: Pick<Product, 'sourceId' | 'asin' | 'affiliateUrl' | 'buyNowUrl'>
): string {
  if (String(product.sourceId || '').trim()) return String(product.sourceId).trim();
  if (String(product.asin || '').trim()) return String(product.asin).trim();
  const haystack = `${product.affiliateUrl || ''} ${product.buyNowUrl || ''}`;
  const asin = haystack.match(/\b(B[0-9A-Z]{9}|[0-9]{9}[0-9A-Z])\b/);
  if (asin) return asin[1];
  const ali = haystack.match(/\/(?:item|goods)\/(?:.*?\/)?(?:ae01|item)?(?:_)?(\d{6,20})\.html/i)
    ?? haystack.match(/[?&](?:itemId|productId|productIds)=(\d{6,20})/i);
  if (ali) return `AE-${ali[1]}`;
  return '';
}

export type DuplicateReason = 'sourceId' | 'canonicalUrl' | 'cleanTitle';

export interface DuplicateFlag {
  is_duplicate: boolean;
  duplicate_reason?: DuplicateReason;
  duplicate_group?: string;
  duplicate_of?: string;
  possible_duplicate?: boolean;
}

/**
 * Jerarquía de detección de duplicados (la más fuerte gana):
 *  1. sourceId idéntico (ASIN / Item ID de AliExpress).
 *  2. URL canónica idéntica (sin parámetros de afiliación/tracking).
 *  3. Título limpio idéntico dentro de la MISMA categoría/subcategoría
 *     (marcado como POSIBLE duplicado).
 */
export function detectDuplicates(products: Product[]): Map<string, DuplicateFlag> {
  const flags = new Map<string, DuplicateFlag>();
  const firstOfGroup = new Map<string, string>();

  const register = (id: string, key: string, reason: DuplicateReason, possible: boolean) => {
    const existing = firstOfGroup.get(key);
    if (existing === undefined) {
      firstOfGroup.set(key, id);
      return;
    }
    const base: DuplicateFlag = {
      is_duplicate: true,
      duplicate_reason: reason,
      duplicate_group: key,
      duplicate_of: existing,
    };
    if (possible) base.possible_duplicate = true;
    // Conserva el motivo más fuerte ya asignado a este producto.
    const current = flags.get(id);
    if (!current || reasonRank(reason) < reasonRank(current.duplicate_reason)) {
      flags.set(id, base);
    }
  };

  const reasonRank = (reason?: DuplicateReason): number => {
    if (reason === 'sourceId') return 0;
    if (reason === 'canonicalUrl') return 1;
    return 2;
  };

  // 1) sourceId
  const bySource = new Map<string, string>();
  for (const product of products) {
    const source = extractSourceId(product);
    if (!source) continue;
    const previous = bySource.get(source);
    if (previous === undefined) {
      bySource.set(source, product.id);
    } else {
      // OJO: `register()` NO marcaba el producto actual cuando la clave era
      // nueva en `firstOfGroup` (el primer miembro del grupo nunca pasaba por
      // `register`), así que la mitad de los duplicados se quedaban sin marcar.
      // Aquí se marcan los DOS miembros del grupo.
      const current = flags.get(product.id);
      if (!current || reasonRank('sourceId') < reasonRank(current.duplicate_reason)) {
        flags.set(product.id, {
          is_duplicate: true,
          duplicate_reason: 'sourceId',
          duplicate_group: `src:${source}`,
          duplicate_of: previous,
        });
      }
      if (!flags.has(previous)) {
        flags.set(previous, { is_duplicate: true, duplicate_reason: 'sourceId', duplicate_group: `src:${source}`, duplicate_of: product.id });
      }
    }
  }

  // 2) URL canónica
  const byUrl = new Map<string, string>();
  for (const product of products) {
    const canonical = canonicalProductUrl(product.affiliateUrl) || canonicalProductUrl(product.buyNowUrl);
    if (!canonical) continue;
    const previous = byUrl.get(canonical);
    if (previous === undefined) {
      byUrl.set(canonical, product.id);
    } else if (!flags.has(product.id) || flags.get(product.id)?.duplicate_reason !== 'sourceId') {
      const current = flags.get(product.id);
      if (!current || reasonRank('canonicalUrl') < reasonRank(current.duplicate_reason)) {
        flags.set(product.id, {
          is_duplicate: true,
          duplicate_reason: 'canonicalUrl',
          duplicate_group: `url:${canonical}`,
          duplicate_of: previous,
        });
      }
      if (!flags.has(previous)) {
        flags.set(previous, { is_duplicate: true, duplicate_reason: 'canonicalUrl', duplicate_group: `url:${canonical}`, duplicate_of: product.id });
      }
    }
  }

  // 3) Título limpio dentro de la misma categoría/subcategoría (posible duplicado)
  const byTitle = new Map<string, string>();
  for (const product of products) {
    const titleKey = cleanTitleKey(product.title);
    if (!titleKey || titleKey.length < 8) continue;
    const scope = `${String(product.category || '').trim().toLowerCase()}|${String(product.subcategory_id || '').trim().toLowerCase()}`;
    const key = `title:${scope}:${titleKey}`;
    const previous = byTitle.get(key);
    if (previous === undefined) {
      byTitle.set(key, product.id);
    } else if (!flags.has(product.id)) {
      register(product.id, key, 'cleanTitle', true);
      if (!flags.has(previous)) {
        flags.set(previous, {
          is_duplicate: true,
          duplicate_reason: 'cleanTitle',
          duplicate_group: key,
          duplicate_of: product.id,
          possible_duplicate: true,
        });
      }
    }
  }

  return flags;
}

/**
 * Score de conversión potencial (0-100):
 *   Score = min(100, round(((comision_estimada * ventas_30d) / max(precio,1)) * factor_valoracion * ESCALA))
 * - comision_estimada: `commissionEstimate` o 5% del precio (media de afiliación).
 * - ventas_30d: `sales30d` o 1 (sin datos de ventas el score queda bajo a propósito).
 * - factor_valoracion: (rating/5) con leve boost por volumen de opiniones (≤1.25).
 * - ESCALA=5 traduce la ratio a la escala 0-100 (ratio 20 → 100 pts).
 */
export const CONVERSION_SCORE_SCALE = 100;

export function computeConversionScore(product: Product): number {
  const price = Math.max(Number(product.price) || 0, 1);
  const storedCommission = Number(product.commissionEstimate);
  const commissionRate = Number(product.commissionRate);
  // Comisión como porcentaje efectivo: prioriza commissionEstimate (monto fijo
  // → se divide por price para obtener %), luego commissionRate, luego 5%.
  let commissionRateEffective: number;
  if (Number.isFinite(storedCommission) && storedCommission > 0) {
    commissionRateEffective = (storedCommission / price) * 100;
  } else if (Number.isFinite(commissionRate) && commissionRate > 0) {
    commissionRateEffective = commissionRate;
  } else {
    commissionRateEffective = 5;
  }
  // Ventas: usar sales30d real si existe; si no, estimar desde reviewsCount
  // (heurística: ~1 de cada 100 compradores deja review, y asumimos ~30 días).
  const storedSales = Number(product.sales30d);
  let sales: number;
  if (Number.isFinite(storedSales) && storedSales > 0) {
    sales = storedSales;
  } else {
    const reviews = Number(product.reviewsCount);
    sales = Number.isFinite(reviews) && reviews > 0 ? Math.max(1, Math.floor(reviews * 3)) : 1;
  }
  const rating = Number(product.rating);
  const validRating = Number.isFinite(rating) && rating > 0 ? Math.min(5, rating) : 3.5;
  const reviews = Number(product.reviewsCount);
  const reviewBoost = Number.isFinite(reviews) && reviews > 0
    ? Math.min(1.25, 1 + Math.log10(1 + reviews) * 0.05)
    : 1;
  const factorValoracion = (validRating / 5) * reviewBoost;
  // Fórmula: tasa de comisión × ventas × factor de valoración × escala.
  // Ya no dividimos commission por price (evita que el precio cancele el score).
  const raw = (commissionRateEffective / 100) * sales * factorValoracion;
  return Math.max(0, Math.min(100, Math.round(raw * CONVERSION_SCORE_SCALE)));
}

/** Nivel visual del score: high (>75) / mid (40-75) / low (<40). */
export function conversionScoreLevel(score: number): 'high' | 'mid' | 'low' {
  if (score > 75) return 'high';
  if (score >= 40) return 'mid';
  return 'low';
}

/** Defaults de estado editorial calculados (sin persistir) para el panel. */
export function computeEditorialStatus(product: Product): { ia_status: string; link_status: string } {
  const ia = String(product.ia_status || '').trim()
    || ((product.description || '').trim().length >= 60 ? 'completed' : 'pending');
  // El enlace está ACTIVO si el producto tiene URL de afiliado (mismo criterio
  // que `add-product.ts` y `massCatalogPipeline.ts`). Antes el 'pending'
  // heredado de las importaciones antiguas (o precargado por el build) dejaba
  // el catálogo entero fuera del preset "⭐ Listos para Publicar". Sólo se
  // respeta 'broken' (enlace marcado como roto a mano).
  const rawLink = String(product.link_status || '').trim().toLowerCase();
  const link = rawLink === 'broken'
    ? 'broken'
    : ((product.affiliateUrl || '').trim() ? 'active' : 'pending');
  return { ia_status: ia, link_status: link };
}

let cachedEnrichedResult: {
  productsRef: Product[];
  result: Array<Product & DuplicateFlag & { ia_status: string; link_status: string; conversion_score: number; network: string; network_label: string }>;
} | null = null;

export function invalidateEnrichProductsCache(): void {
  cachedEnrichedResult = null;
}

/**
 * Enriquece una copia de los productos con los campos de curación que usa el
 * panel admin: conversion_score, is_duplicate (+motivo), ia_status y link_status.
 */
export function enrichProductsForAdmin(products: Product[]): Array<Product & DuplicateFlag & { ia_status: string; link_status: string; conversion_score: number; network: string; network_label: string }> {
  if (cachedEnrichedResult && cachedEnrichedResult.productsRef === products) {
    return cachedEnrichedResult.result;
  }

  const duplicates = detectDuplicates(products);
  const result = products.map((product) => {
    const status = computeEditorialStatus(product);
    const flag = duplicates.get(product.id);
    const score = Number.isFinite(Number(product.conversion_score)) && Number(product.conversion_score) > 0
      ? Number(product.conversion_score)
      : computeConversionScore(product);
    // Red de afiliados a la que pertenece el producto (Amazon, eBay, AliExpress…).
    // Es derivado: no se persiste, se recalcula en cada respuesta del panel.
    const network = getProductNetwork(product);
    return {
      ...product,
      ...status,
      conversion_score: score,
      network: network.id,
      network_label: network.label,
      is_duplicate: Boolean(flag?.is_duplicate),
      duplicate_reason: flag?.duplicate_reason,
      duplicate_group: flag?.duplicate_group,
      duplicate_of: flag?.duplicate_of,
      possible_duplicate: flag?.possible_duplicate,
    };
  });

  cachedEnrichedResult = { productsRef: products, result };
  return result;
}

/** Recalcula y PERSISTE conversion_score en products.json. */
export function recalcConversionScores(): { updated: number; total: number } {
  const products = readProductsFromFile();
  let updated = 0;
  for (const product of products) {
    const score = computeConversionScore(product);
    if (product.conversion_score !== score) {
      product.conversion_score = score;
      updated += 1;
    }
  }
  if (updated > 0) writeProductsToFile(products);
  return { updated, total: products.length };
}

/**
 * Eliminación masiva: filtra los IDs indicados de products.json y deja tombstone
 * para que el catálogo público tampoco los muestre. Devuelve borrados y ausentes.
 */
export function bulkDeleteProducts(ids: string[]): { deleted: string[]; missing: string[] } {
  const wanted = new Set(ids.map((id) => String(id || '').trim()).filter(Boolean));
  const products = readProductsFromFile();
  const existing = new Set(products.map((p) => p.id));
  const missing = [...wanted].filter((id) => !existing.has(id));
  const remaining = products.filter((p) => !wanted.has(p.id));
  const deleted = products.filter((p) => wanted.has(p.id)).map((p) => p.id);
  if (deleted.length) {
    writeProductsToFile(remaining);
    for (const id of deleted) addDeletedId(id);
  }
  return { deleted, missing };
}

/**
 * Vacía completamente el catálogo (products.json) para resincronizar desde
 * cero (uso previsto del botón «Vaciar Catálogo»). A diferencia del borrado
 * individual/masivo (`bulkDeleteProducts`), NO deja tombstones de los ids
 * vaciados —y limpia los que ya hubiera— porque dejarlos bloqueados
 * impediría que el siguiente «Construir Catálogo» recuperase justo esos
 * productos, contradiciendo el propio "resincronizar desde cero". Los ids
 * integrados (`BUILTIN_DELETED`) se conservan siempre. Devuelve el número de
 * productos eliminados.
 */
export function deleteAllProducts(): { deletedCount: number } {
  const products = readProductsFromFile();
  const deletedCount = products.length;
  if (deletedCount > 0) {
    writeProductsToFile([]);
  }
  clearDeletedIds();
  return { deletedCount };
}

// ─── Purga de duplicados reales ───────────────────────────────────────────────

export interface DuplicateGroup {
  /** Clave del grupo (`src:…`, `url:…` o `title:…`). */
  group: string;
  /** Motivo por el que se agruparon los productos. */
  reason: DuplicateReason;
  /** ID del producto que se conserva (el más completo). */
  keepId: string;
  /** IDs de los productos que son copias y se pueden purgar. */
  duplicateIds: string[];
}

/**
 * Agrupa los duplicados REALES del catálogo (mismo `sourceId` o misma URL
 * canónica). Los coincidencias sólo por título limpio se ignoran: son sólo
 * "posibles duplicados" (dos productos con el mismo título genérico pueden ser
 * artículos distintos) y no se purgan.
 */
export function findDuplicateGroups(products: Product[]): DuplicateGroup[] {
  const flags = detectDuplicates(products);
  const byGroup = new Map<string, string[]>();

  for (const product of products) {
    const flag = flags.get(product.id);
    if (!flag?.is_duplicate || !flag.duplicate_group) continue;
    if (flag.duplicate_reason !== 'sourceId' && flag.duplicate_reason !== 'canonicalUrl') continue;
    const list = byGroup.get(flag.duplicate_group) ?? [];
    list.push(product.id);
    byGroup.set(flag.duplicate_group, list);
  }

  const groups: DuplicateGroup[] = [];
  for (const [group, ids] of byGroup) {
    if (ids.length < 2) continue;
    const flag = flags.get(ids[1]);
    groups.push({
      group,
      reason: flag?.duplicate_reason ?? 'sourceId',
      keepId: ids[0],
      duplicateIds: ids.slice(1),
    });
  }
  return groups;
}

/**
 * Rango del id a la hora de elegir la ficha conservada: los ids "bonitos"
 * (sin sufijo numérico) son los que están publicados en la web y en los
 * enlaces de afiliado, así que se conservan antes que sus copias "-2".
 */
function canonicalIdRank(id: string): number {
  const match = /^(.*)-(\d+)$/.exec(String(id || ''));
  return match ? Number(match[2]) : 1;
}

/** Puntúa la completitud de una ficha para elegir cuál de las copias se conserva. */
function completenessScore(product: Product): number {
  let score = 0;
  if (String(product.category_id || '').trim()) score += 4;
  if (String(product.subcategory_id || '').trim()) score += 3;
  score += Math.min(String(product.description || '').trim().length / 120, 3);
  if (String(product.verdict || '').trim()) score += 2;
  if (String(product.techSheet || '').trim()) score += 2;
  if (product.specs && Object.keys(product.specs).length > 0) score += 2;
  if (Array.isArray(product.gallery) && product.gallery.length > 1) score += 1;
  if (Number(product.audit_score) > 0) score += 1;
  if (Number(product.conversion_score) > 0) score += 1;
  return score;
}

export interface PurgeDuplicatesResult {
  /** Grupos de duplicados detectados. */
  groups: DuplicateGroup[];
  /** IDs que se han eliminado (o que se eliminarían en modo simulación). */
  removed: string[];
  /** Detalle de cada purga: grupo, motivo y ficha conservada. */
  details: Array<{ group: string; reason: DuplicateReason; keepId: string; removedIds: string[] }>;
  /** Productos en el catálogo antes de la purga. */
  total: number;
  /** Productos que quedan en el catálogo. */
  remaining: number;
  /** `true` si no se ha escrito nada (simulación). */
  dryRun: boolean;
}

/**
 * Purga los duplicados reales del catálogo: conserva la ficha más completa de
 * cada grupo y elimina el resto (dejando tombstone, como el borrado masivo).
 * En modo simulación (`dryRun`) no se escribe nada.
 */
export function purgeDuplicateProducts(options: { dryRun?: boolean } = {}): PurgeDuplicatesResult {
  const dryRun = options.dryRun !== false;
  const products = readProductsFromFile();
  const groups = findDuplicateGroups(products);

  const byId = new Map(products.map((product) => [product.id, product]));
  const removed = new Set<string>();
  const details: Array<{ group: string; reason: DuplicateReason; keepId: string; removedIds: string[] }> = [];

  for (const group of groups) {
    // Se conserva la ficha más completa (curada, con categoría o ficha técnica).
    // A igualdad, el id canónico (sin sufijo "-2"): sus URLs públicas siguen
    // siendo válidas y no se rompen los enlaces ya indexados.
    const candidates = [group.keepId, ...group.duplicateIds]
      .map((id) => byId.get(id))
      .filter((product): product is Product => Boolean(product));
    if (candidates.length < 2) continue;

    const keep = [...candidates].sort((a, b) => {
      const byCompleteness = completenessScore(b) - completenessScore(a);
      if (byCompleteness !== 0) return byCompleteness;
      return canonicalIdRank(a.id) - canonicalIdRank(b.id);
    })[0];
    const removedIds = candidates
      .filter((product) => product.id !== keep.id)
      .map((product) => product.id)
      .filter((id) => !removed.has(id));
    if (!removedIds.length) continue;

    for (const id of removedIds) removed.add(id);
    details.push({ group: group.group, reason: group.reason, keepId: keep.id, removedIds });
  }

  const removedIds = [...removed];
  if (!dryRun && removedIds.length) {
    bulkDeleteProducts(removedIds);
  }

  return {
    groups,
    removed: removedIds,
    details,
    total: products.length,
    remaining: products.length - removedIds.length,
    dryRun,
  };
}

// ─── Tags técnicos normalizados (matriz de atributos) ────────────────────────

const TAG_PATTERNS: Array<{ re: RegExp; tag: string | ((m: RegExpMatchArray) => string) }> = [
  { re: /\busb[\s-]?3\.?2\b/i, tag: 'USB 3.2' },
  { re: /\busb[\s-]?3\.?1\b/i, tag: 'USB 3.1' },
  { re: /\busb[\s-]?3\.?0\b/i, tag: 'USB 3.0' },
  { re: /\busb[\s-]?2\.?0\b/i, tag: 'USB 2.0' },
  { re: /\busb[\s-]?type[\s-]?c\b|\btype[\s-]?c\b|\busb-c\b/i, tag: 'USB Type-C' },
  { re: /\bmicro[\s-]?usb\b/i, tag: 'Micro-USB' },
  { re: /\blightning\b/i, tag: 'Conector Lightning' },
  { re: /\bsata\s*(iii?)?\b|\bsata[\s-]?6gbps\b/i, tag: 'SATA' },
  { re: /sata\s*2\.?5|2\.5["″]?/i, tag: 'SATA 2.5"' },
  { re: /\bnvme\b/i, tag: 'NVMe' },
  { re: /\bm\.?2\b/i, tag: 'M.2' },
  { re: /\bssd\b/i, tag: 'SSD' },
  { re: /\bhdd\b|disco duro/i, tag: 'HDD' },
  { re: /\bbluetooth\s*5\.?[34]\b/i, tag: (m) => `Bluetooth ${m[0].replace(/[^0-9.]/g, '')}` },
  { re: /\bbluetooth\s*5\.?[012]\b/i, tag: (m) => `Bluetooth ${m[0].replace(/[^0-9.]/g, '')}` },
  { re: /\bbluetooth\b/i, tag: 'Bluetooth' },
  { re: /\bwi-?fi\s*6e?\b/i, tag: (m) => /e/i.test(m[0]) ? 'Wi-Fi 6E' : 'Wi-Fi 6' },
  { re: /\bwi-?fi\s*5\b|\b802\.11ac\b/i, tag: 'Wi-Fi 5' },
  { re: /\bwi-?fi\b/i, tag: 'Wi-Fi' },
  { re: /\bplug\s*&?\s*play\b|plug and play/i, tag: 'Plug & Play' },
  { re: /sin alimentaci[óo]n externa|bus.?powered|alimentaci[óo]n por usb/i, tag: 'Sin Alimentación Externa' },
  { re: /\bip6[78]\b/i, tag: (m) => m[0].toUpperCase() },
  { re: /\bip5[45]\b/i, tag: (m) => m[0].toUpperCase() },
  { re: /\bnoise cancelling|cancelaci[óo]n de ruido|anc\b/i, tag: 'Cancelación de Ruido' },
  { re: /\binal[áa]mbric[oa]\b|\bwireless\b/i, tag: 'Inalámbrico' },
  { re: /\bbater[íi]a\b|acumulador/i, tag: 'Batería Integrada' },
  { re: /\b4k\b|uhd\b/i, tag: '4K UHD' },
  { re: /\bfull hd\b|1080p\b/i, tag: 'Full HD 1080p' },
  { re: /\brecarga r[áa]pida|\bfast charging\b|\bquick charge\b/i, tag: 'Recarga Rápida' },
  { re: /\brgb\b/i, tag: 'RGB' },
  { re: /\bajustable\b|regulable/i, tag: 'Ajustable' },
  { re: /\bplegable\b|foldable/i, tag: 'Plegable' },
  { re: /\bcompatible con (alexa|google (home|assistant))\b/i, tag: (m) => `Compatible con ${/alexa/i.test(m[0]) ? 'Alexa' : 'Google Assistant'}` },
];

/** Extrae tags técnicos estándar desde título + specs + ficha (heurística local, instantánea y offline). */
export function extractNormalizedTags(product: Product): string[] {
  const parts = [
    product.title || '',
    product.techSheet || '',
    product.description || '',
    ...Object.entries(product.specs || {}).map(([k, v]) => `${k}: ${v}`),
  ].join(' · ');
  const tags = new Set<string>();
  for (const { re, tag } of TAG_PATTERNS) {
    const match = parts.match(re);
    if (match) tags.add(typeof tag === 'function' ? tag(match) : tag);
  }
  // Capacidades / pesos / potencias citados en specs (valores cortos y estandarizables).
  for (const value of Object.values(product.specs || {})) {
    const text = String(value).trim();
    if (/^\d{2,4}\s?(gb|tb|mb)\b/i.test(text)) tags.add(text.toUpperCase().replace(/\s+/g, ''));
    if (/^\d{2,3}\s?(w|watts?)\b/i.test(text)) tags.add(`${text.replace(/[^0-9]/g, '')}W`);
  }
  return [...tags].slice(0, 24);
}

/** Aplica tags normalizados a los productos indicados y persiste. */
export function normalizeTagsForProducts(ids: string[]): { updated: number; products: Product[] } {
  const wanted = new Set(ids.map((id) => String(id || '').trim()).filter(Boolean));
  const products = readProductsFromFile();
  let updated = 0;
  for (const product of products) {
    if (!wanted.has(product.id)) continue;
    product.normalized_tags = extractNormalizedTags(product);
    updated += 1;
  }
  if (updated > 0) writeProductsToFile(products);
  return { updated, products };
}

// ─── Cross-matching de alternativas ──────────────────────────────────────────

/** Similitud de Jaccard sobre tokens de título (0-1). */
export function titleSimilarity(a: string, b: string): number {
  const tokensA = new Set(cleanTitleKey(a).split(' ').filter((t) => t.length > 2));
  const tokensB = new Set(cleanTitleKey(b).split(' ').filter((t) => t.length > 2));
  if (!tokensA.size || !tokensB.size) return 0;
  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection += 1;
  return intersection / (tokensA.size + tokensB.size - intersection);
}

/** Sugiere alternativas por coincidencia de título/categoría (top N). */
export function suggestAlternatives(products: Product[], productId: string, limit = 8): Array<{ product: Product; score: number }> {
  const base = products.find((p) => p.id === productId);
  if (!base) return [];
  return products
    .filter((p) => p.id !== productId)
    .map((p) => {
      const sameCategory = String(p.category || '').trim().toLowerCase() === String(base.category || '').trim().toLowerCase();
      const score = Math.min(1, titleSimilarity(base.title, p.title) + (sameCategory ? 0.25 : 0));
      return { product: p, score };
    })
    .filter((item) => item.score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Claves de rol en plural + singular (para leer cualquier formato guardado). */
export function roleIdsOf(product: Product): {
  premium: string[];
  cheaper: string[];
  similar: string[];
} {
  const alts = product.alternatives || {};
  const list = (values: Array<string | undefined>): string[] =>
    [...new Set(values.filter((value): value is string => Boolean(value)))];
  return {
    premium: list([alts.premiumOptionId]),
    cheaper: list([...(alts.cheaperOptionIds || []), alts.cheaperOptionId]),
    similar: list([...(alts.similarOptionIds || []), alts.similarOptionId]),
  };
}

/**
 * Asignación AUTOMÁTICA de los 3 roles sobre un conjunto de candidatas.
 *
 *  - ⭐ Opción Principal / Mejor Valorada: la candidata mejor valorada (empate →
 *    la más cara, que es la que mejor encaja como «principal»).
 *  - 💰 Alternativa Económica: las candidatas más baratas que la base; se
 *    preseleccionan todas las que estén dentro del 8 % del precio mínimo
 *    (puede haber MÁS de una; en el panel se puede cambiar la elección).
 *  - 🎯 Competidor directo: las candidatas con mayor similitud de título
 *    (≥ 0.45 y dentro del 80 % de la mejor), máximo 3.
 */
export function autoAlternativeRoles(
  base: Product,
  candidates: Product[],
): { premiumOptionId?: string; cheaperOptionIds: string[]; similarOptionIds: string[] } {
  const pool = candidates.filter((p) => p.id && p.id !== base.id);
  if (!pool.length) return { cheaperOptionIds: [], similarOptionIds: [] };

  const ratingOf = (p: Product): number => (Number.isFinite(Number(p.rating)) ? Number(p.rating) : 0);
  const priceOf = (p: Product): number => (Number(p.price) > 0 ? Number(p.price) : 0);

  const premium = [...pool].sort(
    (a, b) => ratingOf(b) - ratingOf(a) || priceOf(b) - priceOf(a) || a.title.localeCompare(b.title, 'es'),
  )[0];

  const basePrice = priceOf(base);
  const cheaper = basePrice > 0 ? pool.filter((p) => priceOf(p) > 0 && priceOf(p) < basePrice) : [];
  cheaper.sort((a, b) => priceOf(a) - priceOf(b));
  const cheapest = cheaper.length ? priceOf(cheaper[0]) : 0;
  const cheaperOptionIds = cheaper
    .filter((p) => priceOf(p) <= cheapest * 1.08)
    .slice(0, 3)
    .map((p) => p.id);

  const scored = pool
    .map((p) => ({ p, score: titleSimilarity(base.title, p.title) }))
    .filter((item) => item.score >= 0.45)
    .sort((a, b) => b.score - a.score);
  const top = scored.length ? scored[0].score : 0;
  const similarOptionIds = scored
    .filter((item) => item.score >= Math.max(0.45, top * 0.8))
    .slice(0, 3)
    .map((item) => item.p.id);

  return {
    premiumOptionId: premium?.id,
    cheaperOptionIds,
    similarOptionIds,
  };
}

/**
 * Vincula alternativas de forma BIDIRECCIONAL: el array alternative_product_ids
 * se actualiza en el producto base y en cada alternativa. Los slots de rol
 * (premium / económica / similar) se escriben en `alternatives` del producto base.
 *
 * `cheaperOptionIds` / `similarOptionIds` admiten VARIOS ids; los campos
 * singulares (`cheaperOptionId` / `similarOptionId`) quedan sincronizados con
 * el primero de cada lista para la PDP y los datos antiguos.
 */
export function linkAlternatives(input: {
  productId: string;
  alternativeProductIds: string[];
  premiumOptionId?: string | null;
  cheaperOptionId?: string | null;
  similarOptionId?: string | null;
  cheaperOptionIds?: Array<string | null | undefined>;
  similarOptionIds?: Array<string | null | undefined>;
}): { ok: boolean; message: string; product?: Product } {
  const products = readProductsFromFile();
  const base = products.find((p) => p.id === input.productId);
  if (!base) return { ok: false, message: `No existe el producto "${input.productId}".` };

  const ids = [
    ...(Array.isArray(input.cheaperOptionIds) ? input.cheaperOptionIds : []),
    ...(Array.isArray(input.similarOptionIds) ? input.similarOptionIds : []),
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  for (const value of [input.cheaperOptionId, input.similarOptionId, input.premiumOptionId]) {
    const id = String(value ?? '').trim();
    if (id) ids.push(id);
  }

  const linked = [...new Set(input.alternativeProductIds.map((id) => String(id || '').trim()).filter(Boolean))]
    .filter((id) => id !== base.id && products.some((p) => p.id === id));
  // Los ids de rol siempre forman parte de la lista de alternativas.
  for (const id of ids) {
    if (id !== base.id && products.some((p) => p.id === id) && !linked.includes(id)) linked.push(id);
  }

  base.alternative_product_ids = linked;

  const cheaperIds = [
    ...new Set(
      [
        ...(Array.isArray(input.cheaperOptionIds) ? input.cheaperOptionIds : []),
        input.cheaperOptionId,
      ]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean),
    ),
  ].filter((id) => linked.includes(id));
  const similarIds = [
    ...new Set(
      [
        ...(Array.isArray(input.similarOptionIds) ? input.similarOptionIds : []),
        input.similarOptionId,
      ]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean),
    ),
  ].filter((id) => linked.includes(id));
  const premiumId = String(input.premiumOptionId ?? '').trim() || undefined;
  const resolvedPremium = premiumId && linked.includes(premiumId) ? premiumId : undefined;

  base.alternatives = {
    ...base.alternatives,
    premiumOptionId: resolvedPremium,
    cheaperOptionId: cheaperIds[0],
    similarOptionId: similarIds[0],
    cheaperOptionIds: cheaperIds,
    similarOptionIds: similarIds,
  };

  // Sincronía bidireccional del array en cada alternativa.
  for (const product of products) {
    if (!linked.includes(product.id)) continue;
    const peers = new Set([...(product.alternative_product_ids || []), base.id]);
    product.alternative_product_ids = [...peers].filter((id) => id !== product.id);
  }
  // Limpieza inversa: productos que referencian al base pero ya no están en la lista.
  for (const product of products) {
    if (product.id === base.id || linked.includes(product.id)) continue;
    if (Array.isArray(product.alternative_product_ids) && product.alternative_product_ids.includes(base.id)) {
      product.alternative_product_ids = product.alternative_product_ids.filter((id) => id !== base.id);
    }
  }

  writeProductsToFile(products);
  return { ok: true, message: `${linked.length} alternativa(s) vinculada(s) a "${base.title}".`, product: base };
}

/**
 * Auto-vinculación de alternativas al dar de alta un producto:
 *  - Si el producto YA tiene vínculos no se toca nada (nunca se pisa la curación manual).
 *  - Si no tiene ninguno, se sugieren las coincidencias (título/categoría) y se
 *    guardan con los 3 roles rellenados automáticamente (premium / económica /
 *    competidor directo).
 *
 * Devuelve el nº de alternativas vinculadas para poder avisar en el panel.
 */
export function autoLinkAlternatives(productId: string): { ok: boolean; linked: number; rolesAssigned: boolean } {
  const products = readProductsFromFile();
  const base = products.find((p) => p.id === productId);
  if (!base) return { ok: false, linked: 0, rolesAssigned: false };
  if (Array.isArray(base.alternative_product_ids) && base.alternative_product_ids.length) {
    return { ok: true, linked: base.alternative_product_ids.length, rolesAssigned: false };
  }
  // Umbral ALTO a propósito: sólo se auto-vinculan productos que de verdad
  // parecen la misma familia (título muy parecido, o categoría + parecido
  // medio); el resto queda para la selección manual en el panel.
  const suggestions = suggestAlternatives(products, productId, 12)
    .filter(({ product: p, score }) => titleSimilarity(base.title, p.title) >= 0.45 || score >= 0.6)
    .slice(0, 6)
    .map((item) => item.product);
  if (!suggestions.length) return { ok: true, linked: 0, rolesAssigned: false };
  const roles = autoAlternativeRoles(base, suggestions);
  const result = linkAlternatives({
    productId,
    alternativeProductIds: suggestions.map((p) => p.id),
    premiumOptionId: roles.premiumOptionId ?? null,
    cheaperOptionIds: roles.cheaperOptionIds,
    similarOptionIds: roles.similarOptionIds,
  });
  return { ok: result.ok, linked: result.ok ? suggestions.length : 0, rolesAssigned: result.ok };
}

/**
 * Garantiza que un producto tenga alternativas VINCULADAS y los 3 ROLES
 * rellenos. Es lo que usa el panel al abrir el modal «Vincular Alternativas»:
 * los productos antiguos (creados antes de esta lógica) reciben aquí su
 * selección automática, que luego se puede cambiar a mano.
 */
export function ensureAlternativeRoles(productId: string): {
  ok: boolean;
  linkedIds: string[];
  roles: { premiumOptionId?: string; cheaperOptionIds: string[]; similarOptionIds: string[] };
  auto: boolean;
  message?: string;
} {
  const products = readProductsFromFile();
  const base = products.find((p) => p.id === productId);
  if (!base) {
    return { ok: false, linkedIds: [], roles: { cheaperOptionIds: [], similarOptionIds: [] }, auto: false, message: `Producto "${productId}" no encontrado.` };
  }

  const stored = roleIdsOf(base);
  const hasLinks = Array.isArray(base.alternative_product_ids) && base.alternative_product_ids.length > 0;
  const hasRoles = Boolean(stored.premium.length || stored.cheaper.length || stored.similar.length);

  // 1) Sin vínculos → auto-vincula con sugerencias + roles.
  if (!hasLinks) {
    const auto = autoLinkAlternatives(productId);
    if (auto.ok) {
      const fresh = readProductsFromFile().find((p) => p.id === productId) || base;
      const roles = roleIdsOf(fresh);
      return {
        ok: true,
        linkedIds: fresh.alternative_product_ids || [],
        roles: {
          premiumOptionId: roles.premium[0],
          cheaperOptionIds: roles.cheaper,
          similarOptionIds: roles.similar,
        },
        auto: auto.rolesAssigned,
      };
    }
    return { ok: false, linkedIds: [], roles: { cheaperOptionIds: [], similarOptionIds: [] }, auto: false, message: 'No se pudieron generar las alternativas.' };
  }

  // 2) Con vínculos pero sin roles → calcula los roles sobre ESAS alternativas.
  if (!hasRoles) {
    const candidates = products.filter((p) => (base.alternative_product_ids || []).includes(p.id));
    const roles = autoAlternativeRoles(base, candidates);
    const result = linkAlternatives({
      productId,
      alternativeProductIds: base.alternative_product_ids || [],
      premiumOptionId: roles.premiumOptionId ?? null,
      cheaperOptionIds: roles.cheaperOptionIds,
      similarOptionIds: roles.similarOptionIds,
    });
    const fresh = result.product || base;
    return {
      ok: result.ok,
      linkedIds: fresh.alternative_product_ids || [],
      roles: {
        premiumOptionId: roles.premiumOptionId,
        cheaperOptionIds: roles.cheaperOptionIds,
        similarOptionIds: roles.similarOptionIds,
      },
      auto: result.ok,
      message: result.ok ? undefined : result.message,
    };
  }

  return {
    ok: true,
    linkedIds: base.alternative_product_ids || [],
    roles: {
      premiumOptionId: stored.premium[0],
      cheaperOptionIds: stored.cheaper,
      similarOptionIds: stored.similar,
    },
    auto: false,
  };
}

/**
 * Determina si dos productos son del mismo tipo o naturaleza para comparativas
 * y alternativas válidas (ej: monitor vs monitor, disco duro vs disco duro).
 * NUNCA permite comparar tipos incompatibles (ej: monitor vs disco duro).
 */
export function areSameProductType(base: Product, candidate: Product): boolean {
  if (base.id === candidate.id) return false;

  // 1) Si ambos tienen subcategoría asignada:
  if (base.subcategory_id && candidate.subcategory_id) {
    return base.subcategory_id === candidate.subcategory_id;
  }
  // Si uno tiene subcategoría y el otro tiene una subcategoría distinta, no son comparables:
  if (base.subcategory_id && candidate.subcategory_id && base.subcategory_id !== candidate.subcategory_id) {
    return false;
  }

  // 2) Categoría principal normalizada
  const catA = String(base.category || '').toLowerCase().trim();
  const catB = String(candidate.category || '').toLowerCase().trim();
  const sameCategory =
    Boolean(catA && catB && catA === catB) ||
    Boolean(base.category_id && candidate.category_id && base.category_id === candidate.category_id);

  // Palabras clave de naturaleza / tipo de producto
  const extractNatureTokens = (title: string): string[] => {
    const t = String(title || '').toLowerCase();
    const tokenGroups: string[][] = [
      ['ssd', 'nvme', 'm.2', 'disco duro', 'hdd', 'tarjeta micro sd', 'microsd', 'pendrive', 'memoria usb', 'almacenamiento'],
      ['power bank', 'powerbank', 'bateria portatil', 'batería portátil'],
      ['auricular', 'auriculares', 'cascos', 'earbuds', 'headphone', 'headphones', 'tws', 'airpods'],
      ['smartwatch', 'reloj inteligente', 'smart band', 'pulsera actividad', 'apple watch', 'garmin'],
      ['aspirador', 'aspiradora', 'robot aspirador', 'conga', 'roomba', 'dyson'],
      ['freidora', 'air fryer', 'airfryer'],
      ['cafetera', 'espresso', 'nespresso', 'dolce gusto'],
      ['raton', 'ratón', 'mouse'],
      ['teclado', 'keyboard'],
      ['monitor', 'pantalla gaming', 'pantalla pc', 'display'],
      ['televisor', 'smart tv', 'tv'],
      ['portatil', 'portátil', 'laptop', 'notebook', 'ultrabook', 'macbook'],
      ['tablet', 'ipad', 'tableta'],
      ['smartphone', 'móvil', 'movil', 'telefono', 'teléfono', 'iphone'],
      ['altavoz', 'altavoces', 'speaker', 'soundbar', 'barra de sonido'],
      ['taladro', 'atornillador'],
      ['impresora', 'printer'],
      ['camara', 'cámara', 'action cam', 'gopro', 'dashcam'],
      ['proyector', 'projector'],
      ['consola', 'playstation', 'ps5', 'xbox', 'nintendo switch'],
      ['silla gaming', 'silla ergonomica', 'silla de oficina'],
    ];

    const matched: string[] = [];
    for (let i = 0; i < tokenGroups.length; i++) {
      const group = tokenGroups[i];
      if (group.some((tok) => t.includes(tok))) {
        matched.push(`group_${i}`);
      }
    }
    return matched;
  };

  const natureA = extractNatureTokens(base.title);
  const natureB = extractNatureTokens(candidate.title);

  // Si ambos tienen grupo de naturaleza identificado:
  if (natureA.length > 0 && natureB.length > 0) {
    return natureA.some((group) => natureB.includes(group));
  }

  // Si uno tiene un tipo específico identificado (ej: monitor) y el otro NO pertenece a ese grupo:
  if (natureA.length > 0 || natureB.length > 0) {
    return false;
  }

  // Si ambos comparten categoría y la similitud léxica es alta:
  if (sameCategory) {
    return titleSimilarity(base.title, candidate.title) >= 0.40;
  }

  return false;
}

/**
 * Recorre todo el catálogo y asigna automáticamente productos alternativos en
 * la ficha de cada producto basándose en el mismo tipo/naturaleza de producto:
 *   - Más barato (cheaperOptionIds / cheaperOptionId)
 *   - Mejor valorado (premiumOptionId)
 *   - Más vendido / mayor conversión (similarOptionIds / similarOptionId)
 *
 * Si no existen otros productos del mismo tipo dentro del catálogo actual,
 * deja el apartado de alternativas vacío.
 */
export function linkCatalogAlternativesAuto(): {
  success: boolean;
  total: number;
  updated: number;
  emptyCount: number;
} {
  const products = readProductsFromFile();
  if (!products.length) return { success: true, total: 0, updated: 0, emptyCount: 0 };

  let updated = 0;
  let emptyCount = 0;

  for (const base of products) {
    // Buscar candidatos del mismo tipo de producto:
    const candidates = products.filter((p) => areSameProductType(base, p));

    if (!candidates.length) {
      base.alternative_product_ids = [];
      base.alternatives = {
        premiumOptionId: undefined,
        cheaperOptionId: undefined,
        similarOptionId: undefined,
        cheaperOptionIds: [],
        similarOptionIds: [],
      };
      emptyCount++;
      continue;
    }

    // 1. Más barato
    const basePrice = Number(base.price) || 0;
    const cheaperPool = basePrice > 0
      ? candidates.filter((p) => Number(p.price) > 0 && Number(p.price) < basePrice)
      : [];
    cheaperPool.sort((a, b) => Number(a.price) - Number(b.price));
    const cheaperCand = cheaperPool.length
      ? cheaperPool[0]
      : [...candidates].sort((a, b) => Number(a.price) - Number(b.price))[0];

    // 2. Mejor valorado
    const ratingOf = (p: Product) => (Number.isFinite(Number(p.rating)) ? Number(p.rating) : 0);
    const reviewsOf = (p: Product) => (Number.isFinite(Number(p.reviewsCount)) ? Number(p.reviewsCount) : 0);
    const bestRatedPool = [...candidates].sort(
      (a, b) => ratingOf(b) - ratingOf(a) || reviewsOf(b) - reviewsOf(a) || Number(b.price) - Number(a.price)
    );
    const bestRatedCand = bestRatedPool[0];

    // 3. Más vendido (ventas 30d, reseñas o conversion_score)
    const salesOf = (p: Product) =>
      Number(p.sales30d) || Number(p.reviewsCount) || Number(p.conversion_score) || 0;
    const topSellerPool = [...candidates].sort((a, b) => salesOf(b) - salesOf(a));
    const topSellerCand =
      topSellerPool.find((p) => p.id !== cheaperCand?.id && p.id !== bestRatedCand?.id) ||
      topSellerPool[0];

    const selectedIds = [
      ...new Set([cheaperCand?.id, bestRatedCand?.id, topSellerCand?.id].filter(Boolean) as string[]),
    ];

    base.alternative_product_ids = selectedIds;
    base.alternatives = {
      cheaperOptionId: cheaperCand?.id,
      cheaperOptionIds: cheaperCand ? [cheaperCand.id] : [],
      premiumOptionId: bestRatedCand?.id,
      similarOptionId: topSellerCand?.id,
      similarOptionIds: topSellerCand ? [topSellerCand.id] : [],
    };
    updated++;
  }

  writeProductsToFile(products);
  return { success: true, total: products.length, updated, emptyCount };
}

/**
 * ==============================================================================
 * ASIGNACIÓN AUTOMÁTICA DE ETIQUETA DESTACADA (badge)
 * ==============================================================================
 * Selecciona y asigna la etiqueta destacada del producto basándose en los datos
 * técnicos disponibles y en el análisis realizado por la IA.
 *
 * Prioridad (de mayor a menor):
 *  1. «Oferta Estrella» — descuento ≥ 15 %, comisión ≥ 3 %, rating ≥ 4 y
 *     hsrScore/conversion_score elevado (producto estrella editorial).
 *  2. «Más Vendido» — sales30d elevado o conversion_score ≥ 75.
 *  3. «Mejor Valorado» — rating ≥ 4.5 con reviewsCount ≥ 20.
 *  4. «Envío Gratis» — freeShipping === true y shippingDays ≤ 3.
 *  5. «Oferta X%» — descuento detectado (IA o precios) ≥ 10 %.
 *  6. «Novedad» — sin datos suficientes para otras etiquetas, pero con ficha IA
 *     completada (ia_status === 'completed').
 *
 * Devuelve `undefined` si no cumple ningún criterio (el producto no lleva
 * badge destacada).
 * ==============================================================================
 */
export function computeBadge(product: Product): string | undefined {
  const p = product as Product & { hsrScore?: number; conversion_score?: number };

  const price = Number(p.price) || 0;
  const originalPrice = Number(p.originalPrice) || 0;
  const discountPct = originalPrice > price
    ? Math.round(((originalPrice - price) / originalPrice) * 100)
    : 0;
  const commissionRate = Number(p.commissionEstimate != null && price > 0
    ? (p.commissionEstimate / price) * 100
    : 0);
  const rating = Number(p.rating) || 0;
  const reviewsCount = Number(p.reviewsCount) || 0;
  const sales30d = Number(p.sales30d) || 0;
  const conversionScore = Number(p.conversion_score) || 0;
  const hsrScore = Number(p.hsrScore) || 0;
  const freeShipping = p.freeShipping === true;
  const shippingDays = Number(p.shippingDays);
  const iaCompleted = p.ia_status === 'completed';

  // 1. Oferta Estrella: descuento + comisión + rating + score elevado
  const isHSR = discountPct >= 15
    && commissionRate >= 3
    && rating >= 4
    && (hsrScore >= 50 || conversionScore >= 75);
  if (isHSR) return 'Oferta Estrella';

  // 2. Más Vendido: volumen de ventas o rentabilidad muy alta
  if (sales30d >= 50 || conversionScore >= 80) return 'Más Vendido';

  // 3. Mejor Valorado: rating alto con respaldo de opiniones
  if (rating >= 4.5 && reviewsCount >= 20) return 'Mejor Valorado';

  // 4. Envío Gratis rápido
  if (freeShipping && (shippingDays == null || shippingDays <= 3)) return 'Envío Gratis';

  // 5. Oferta con descuento detectado (IA o precios)
  if (discountPct >= 10) return `Oferta ${discountPct}%`;

  // 6. Novedad: ficha IA completada sin otra etiqueta más específica
  if (iaCompleted) return 'Novedad';

  return undefined;
}
