/**
 * ==============================================================================
 * TRADYLOR - PIPELINE · ETAPA 1: INGESTA, LIMPIEZA Y DUPLICADOS
 * ==============================================================================
 * Normaliza el contrato de n8n al modelo interno, valida los campos obligatorios
 * y aplica la detección jerárquica de duplicados reutilizando (sin modificar):
 *   - extractSourceId     (curation.ts)
 *   - canonicalProductUrl (curation.ts)
 *   - cleanTitleKey       (curation.ts)
 *
 * Un duplicado NO se persiste: se devuelve `{ ok:false, duplicate:true }`.
 * ==============================================================================
 */

import { fromN8nContract, slugifyProduct } from '../catalogStore';
import { readDeletedIds } from '../deletedProducts';
import { readProductsFromFile, type Product } from '../productStore';
import { canonicalProductUrl, cleanTitleKey, extractSourceId } from '../curation';
import { extractAsinFromUrl, getAmazonAddToCartUrl } from '../../utils/amazon';
import type { PipelineInput, PipelineProduct, StageResult } from './types';

const DEFAULT_IMAGE =
  'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=800&auto=format&fit=crop';

type DuplicateReason = 'sourceId' | 'canonicalUrl' | 'cleanTitle';

interface DuplicateHit {
  reason: DuplicateReason;
  duplicateOf: string;
}

/**
 * Detección jerárquica (la más fuerte gana):
 *  1. `sourceId` idéntico (ASIN / Item ID de AliExpress).
 *  2. URL canónica idéntica (sin parámetros de afiliación/tracking).
 *  3. Título limpio exacto dentro de la MISMA categoría/subcategoría.
 */
export function findIngestDuplicate(
  products: Product[],
  candidate: Product,
  ignoreId?: string,
): DuplicateHit | undefined {
  const ignored = new Set(
    [candidate.id, ignoreId]
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );

  const sourceId = extractSourceId(candidate);
  const canonical = canonicalProductUrl(candidate.affiliateUrl) || canonicalProductUrl(candidate.buyNowUrl);
  const titleKey = cleanTitleKey(candidate.title);
  const scope = `${String(candidate.category || '').trim().toLowerCase()}|${String(candidate.subcategory_id || '').trim().toLowerCase()}`;

  let titleHit: DuplicateHit | undefined;

  for (const item of products) {
    if (ignored.has(item.id)) continue;

    // 1) sourceId idéntico.
    if (sourceId && extractSourceId(item) === sourceId) {
      return { reason: 'sourceId', duplicateOf: item.id };
    }

    // 2) URL canónica idéntica.
    if (canonical) {
      const itemCanonical = canonicalProductUrl(item.affiliateUrl) || canonicalProductUrl(item.buyNowUrl);
      if (itemCanonical && itemCanonical === canonical) {
        return { reason: 'canonicalUrl', duplicateOf: item.id };
      }
    }

    // 3) Título limpio exacto en la misma categoría/subcategoría.
    if (titleKey && titleKey === cleanTitleKey(item.title)) {
      const itemScope = `${String(item.category || '').trim().toLowerCase()}|${String(item.subcategory_id || '').trim().toLowerCase()}`;
      if (itemScope === scope && !titleHit) {
        titleHit = { reason: 'cleanTitle', duplicateOf: item.id };
      }
    }
  }

  return titleHit;
}

/**
 * Ejecuta la Etapa 1. Construye el `PipelineProduct` normalizado (con los
 * valores por defecto del catálogo) y valida duplicados/tombstones.
 */
export function runStageIngest(
  raw: PipelineInput,
  options: { ignoreId?: string } = {},
): StageResult {
  const data = fromN8nContract(raw as any);

  const title = String(data.title ?? '').trim();
  const affiliateUrl = String(data.affiliateUrl ?? '').trim();
  if (!title || !affiliateUrl) {
    return {
      ok: false,
      stage: 'ingest',
      message: 'Los campos "title" y "affiliateUrl" (o "affiliateDeepLink") son obligatorios.',
    };
  }

  const products = readProductsFromFile();
  const existing = products.find((p) => p.id === (data.id ? String(data.id) : slugifyProduct(title)));

  const asin = data.asin ? String(data.asin).trim().toUpperCase() : existing?.asin;
  const candidateId = String(data.id ?? '').trim() || slugifyProduct(title);

  const candidate: Product = {
    id: candidateId,
    title,
    description: String(data.description ?? '').trim(),
    price: Number(data.price) || 0,
    image: String(data.image ?? '').trim(),
    category: String(data.category ?? 'Tecnología').trim(),
    merchant: String(data.merchant ?? 'Comercio Externo').trim(),
    affiliateUrl,
    asin,
    sourceId: data.sourceId ? String(data.sourceId).trim() : undefined,
    buyNowUrl: data.buyNowUrl ? String(data.buyNowUrl).trim() : undefined,
    pros: [],
    cons: [],
  };

  // Tombstone: el administrador lo borró; no se revive por un import.
  if (readDeletedIds().includes(candidateId)) {
    return {
      ok: false,
      stage: 'ingest',
      message: 'Producto eliminado anteriormente. Recupéralo desde el panel admin.',
    };
  }

  const duplicate = findIngestDuplicate(products, candidate, options.ignoreId);
  if (duplicate) {
    return {
      ok: false,
      stage: 'ingest',
      duplicate: true,
      duplicate_reason: duplicate.reason,
      message: `Duplicado detectado (${duplicate.reason}) de «${duplicate.duplicateOf}»: no se persiste.`,
    };
  }

  const resolvedAsin = asin || extractAsinFromUrl(affiliateUrl);
  const product: PipelineProduct = {
    id: candidateId,
    slug: data.slug ?? existing?.slug,
    title,
    description: candidate.description,
    price: candidate.price,
    originalPrice: data.originalPrice != null ? Number(data.originalPrice) : undefined,
    image: candidate.image || DEFAULT_IMAGE,
    category: candidate.category,
    merchant: candidate.merchant,
    affiliateUrl,
    buyNowUrl:
      candidate.buyNowUrl ||
      (resolvedAsin && /^[A-Z0-9]{10}$/.test(resolvedAsin) ? getAmazonAddToCartUrl(resolvedAsin) : existing?.buyNowUrl),
    asin: resolvedAsin,
    pros: Array.isArray(data.pros) ? data.pros.filter(Boolean) : [],
    cons: Array.isArray(data.cons) ? data.cons.filter(Boolean) : [],
    badge: data.badge ? String(data.badge).trim() : undefined,
    rating: data.rating != null ? Number(data.rating) : undefined,
    reviewsCount: data.reviewsCount != null ? Number(data.reviewsCount) : undefined,
    verdict: data.verdict ? String(data.verdict).trim() : undefined,
    techSheet: data.techSheet ? String(data.techSheet).trim() : existing?.techSheet,
    specs: data.specs ?? existing?.specs,
    fulfillmentProvider: data.fulfillmentProvider ? String(data.fulfillmentProvider).trim() : existing?.fulfillmentProvider,
    shippingInfo: data.shippingInfo ? String(data.shippingInfo).trim() : existing?.shippingInfo,
    shippingDays:
      data.shippingDays != null && Number.isFinite(Number(data.shippingDays))
        ? Math.max(0, Math.round(Number(data.shippingDays)))
        : existing?.shippingDays,
    freeShipping:
      typeof data.freeShipping === 'boolean' ? data.freeShipping : existing?.freeShipping,
    priceHistory: existing?.priceHistory,
    // Curación: los campos jerárquicos/cross-matching sobreviven a los re-imports.
    sourceId: candidate.sourceId || existing?.sourceId || extractSourceId(candidate) || undefined,
    category_id: existing?.category_id,
    subcategory_id: existing?.subcategory_id,
    ia_status: existing?.ia_status,
    link_status: existing?.link_status,
    normalized_tags: existing?.normalized_tags,
    alternative_product_ids: existing?.alternative_product_ids,
    alternatives: existing?.alternatives,
    conversion_score: existing?.conversion_score,
    commissionEstimate: existing?.commissionEstimate,
    sales30d: existing?.sales30d,
    brand: data.brand ? String(data.brand).trim() : existing?.brand,
  };

  return { ok: true, stage: 'ingest', product };
}
