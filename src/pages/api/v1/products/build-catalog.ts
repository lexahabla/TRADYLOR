/**
 * ==============================================================================
 * TRADYLOR - API PÚBLICA v1: CONSTRUCCIÓN AUTOMÁTICA DEL CATÁLOGO MULTI-COMERCIANTE
 * ==============================================================================
 * POST /api/v1/products/build-catalog
 *
 * Autenticación: header Authorization: Bearer <TRADYLOR_API_TOKEN>
 * Query opcional: ?dryRun=1  → no persiste, solo reporta
 *
 * Proceso:
 *   1. Ingesión PARALELA de todas las redes conectadas
 *   2. Normalización canónica + filtro calidad + upgrade imágenes a resolución original
 *   3. Deduplicación cross-merchant (reutiliza lógica de curation.ts + stageIngest.ts)
 *   4. Categorización SOLO en categorías existentes (roots + subs con keywords)
 *   5. Detección ofertas estrella (HSR)
 *   6. Ordenación inteligente
 *   7. Stamping campos pipeline (audit_status, audit_score, ia_status, link_status,
 *      normalized_tags, conversion_score, pipeline_version, pipeline_run_at)
 *   8. Upsert atómico en products.json + reporte JSON detallado
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { unifiedSearch, getConnector } from '../../../../lib/networks';
import { getConnectedNetworkIds } from '../../../../lib/networks/credentials';
import { getCategories, suggestCategoryStrict, slugifyCategory } from '../../../../lib/categories';
import { readProductsFromFile, writeProductsToFile, slugify, type Product } from '../../../../lib/productStore';
import { isValidApiToken, unauthorizedApiResponse } from '../../../../lib/apiAuth';
import { canonicalToUnified } from '../../../../lib/networks/connectors/base';
import type { NetworkConnector } from '../../../../lib/networks/connectors/base';
import type { CanonicalAffiliateProduct, UnifiedProduct } from '../../../../lib/networks/types';
import { toHiResImageUrl, upgradeProductImages, MAX_PRODUCT_IMAGES } from '../../../../lib/imageQuality';
import { cleanTitleKey, canonicalProductUrl, extractSourceId, titleSimilarity } from '../../../../lib/curation';
import { readDeletedIds } from '../../../../lib/deletedProducts';
import { slugifyProduct, upsertCatalogProduct } from '../../../../lib/catalogStore';
import { findIngestDuplicate } from '../../../../lib/pipeline/stageIngest';
import { runStageAudit } from '../../../../lib/pipeline/stageAudit';
import { getPipelineConfig } from '../../../../lib/pipeline/config';
import { computeEditorialStatus, extractNormalizedTags, computeConversionScore, computeBadge } from '../../../../lib/curation';
import { isSecondHand } from '../../../../utils/aliCatalogFilters';
import { incrementMetric, touchMetrics } from '../../../../lib/pipeline/metrics';
import { enrichProductText, generateProductImage, hasTextCredentials, hasImageCredentials, overlayEnrichedText } from '../../../../lib/ai';
import { enrichProductLocally } from '../../../../lib/localEnrich';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../../../../lib/paths';

export const prerender = false;

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };

// ─── Configuración del proceso ──────────────────────────────────────────────
const BUILD_CONFIG = {
  CATALOG_KEYWORDS: [
    'auriculares bluetooth',
    'robot aspirador',
    'smartwatch',
    'cargador usb c',
    'teclado mecanico',
    'camara seguridad wifi',
    'lampara led escritorio',
    'mochila viaje',
    'monitor 4k',
    'disco duro ssd',
    'bateria externa',
    'altavoz bluetooth',
    'camara deportiva',
    'drone camara',
    'patinete electrico',
  ],

  // Sin límite por red: ingerir todo lo disponible
  PER_NETWORK_LIMIT: 1000,

  MIN_PRICE: 1,
  MIN_TITLE_LENGTH: 5,
  REQUIRE_IMAGE: true,

  HSR_COUNT: 12,
  HSR_MIN_DISCOUNT: 15,
  HSR_MIN_COMMISSION: 3,

  TITLE_SIMILARITY_THRESHOLD: 0.75,
  // Sin límite duro; se reporta truncated si hay muchos
  MAX_CROSS_MERCHANT_GROUPS: 2000,

  // Categorías que se consideran "purgadas" o sin valor comercial
  EXCLUDED_CATEGORIES: [
    'recambios para electrodomésticos',
    'recambios electrodomesticos',
    'repuestos electrodomésticos',
    'repuestos electrodomesticos',
  ],
} as const;

// ─── Interfaces internas ────────────────────────────────────────────────────
interface CategoryBreakdown {
  category: string;
  categoryId: string;
  subcategories: Record<string, { name: string; id: string; count: number }>;
  total: number;
}

interface BuildReport {
  success: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  networksQueried: string[];
  productsByNetwork: Record<string, number>;
  rawTotal: number;
  afterQualityFilter: number;
  crossMerchantGroups: number;
  duplicatesResolved: number;
  uncategorized: number;
  hsrDetected: number;
  upserted: number;
  updated: number;
  truncated: number;
  aiEnrichedText: number;
  aiEnrichedImages: number;
  wouldUpsert?: number;
  wouldUpdate?: number;
  errors: string[];
  // Nuevo: desglose detallado por categorías
  categoryBreakdown: CategoryBreakdown[];
  // Productos filtrados por motivo
  filteredByReason: Record<string, number>;
}

interface CanonicalWithMeta extends CanonicalAffiliateProduct {
  _network: string;
  _sourceUnified: UnifiedProduct;
}

interface CrossMerchantGroup {
  canonical: CanonicalWithMeta;
  variants: CanonicalWithMeta[];
  bestPrice: number;
  bestOriginalPrice: number;
  bestCommissionRate: number;
  bestCommissionAmount: number;
  bestRating: number;
  bestSales: number;
  allNetworks: string[];
  allAffiliateUrls: Record<string, string>;
  allDirectUrls: Record<string, string>;
  allMerchantNames: Record<string, string>;
  allExtraImages: string[];
  /** Precio actual de CADA red del grupo (automático; alimenta la comparativa multitienda de la ficha). */
  allPrices: Record<string, number>;
  /** Precio original (antes de descuento) de cada red, cuando la red lo declara. */
  allOriginalPrices: Record<string, number>;
  /** Divisa declarada por cada red (normalmente EUR). */
  allCurrencies: Record<string, string>;
}

// ─── Utilidades ─────────────────────────────────────────────────────────────

function hasValidImage(image: string): boolean {
  if (!image || !image.trim()) return false;
  const trimmed = image.trim();
  if (trimmed === '—' || trimmed === '-' || trimmed === '') return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return trimmed.startsWith('/images/') || trimmed.startsWith('http');
  }
}

function isValidTitle(title: string): boolean {
  const t = title?.trim() ?? '';
  if (!t || t.length < BUILD_CONFIG.MIN_TITLE_LENGTH) return false;
  if (t === '—' || t === '-' || t === 'Sin título') return false;
  return true;
}

function isValidPrice(price: number): boolean {
  return Number.isFinite(price) && price >= BUILD_CONFIG.MIN_PRICE;
}

function calculateDiscountPercentage(originalPrice: number, price: number): number {
  if (!originalPrice || originalPrice <= price) return 0;
  return Math.round(((originalPrice - price) / originalPrice) * 10000) / 100;
}

function calculateCommissionEstimate(price: number, commissionRate: number): number {
  if (!price || !commissionRate) return 0;
  return Math.round(price * (commissionRate / 100) * 100) / 100;
}

function cleanMerchant(name: string | undefined): string {
  if (!name || name.trim() === '—' || name.trim() === '-') return '';
  return name.trim();
}

// Upgrade imágenes a resolución original: fusiona TODAS las fuentes (imagen
// principal + extra + galería) sin perder ninguna — ver `upgradeProductImages`
// en lib/imageQuality.ts (antes había una copia local con un bug: calculaba
// `extraImages` de un parámetro que algunos llamantes no rellenaban, así que
// esas imágenes nunca llegaban a la galería final).
const upgradeImages = upgradeProductImages;

// Generar id único basado en slugifyProduct (consistente con pipeline/panel)
function generateProductId(title: string, existingIds: Set<string>): string {
  let base = slugifyProduct(title);
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

// ─── Paso 1: Ingesión multi-comerciante (PARALELO por red) ──────────────────

async function ingestAllNetworks(): Promise<{
  canonicalProducts: CanonicalWithMeta[];
  byNetwork: Record<string, number>;
  networksQueried: string[];
  errors: string[];
}> {
  const connected = getConnectedNetworkIds();
  const networksQueried = [...connected];
  const errors: string[] = [];
  const byNetwork: Record<string, number> = {};
  // Dedupe GLOBAL (no sólo por red): el mismo producto puede llegar desde dos
  // fuentes distintas (API nativa y catálogo sincronizado) y no debe entrar dos
  // veces en el catálogo.
  const seenGlobal = new Set<string>();

  const results = await Promise.allSettled(
    connected.map(async (networkId) => {
      try {
        const connector = getConnector(networkId) as NetworkConnector | null;
        if (!connector || typeof connector.searchCanonical !== 'function') {
          // Fallback: unifiedSearch CON query por keyword
          const allCanonical: CanonicalWithMeta[] = [];
          const seenInNetwork = new Set<string>();

          for (const keyword of BUILD_CONFIG.CATALOG_KEYWORDS) {
            if (allCanonical.length >= BUILD_CONFIG.PER_NETWORK_LIMIT) break;
            try {
              const results = await unifiedSearch({
                query: keyword,
                networks: [networkId],
                limit: 10,
                sortBy: 'popularity',
              });
              const networkProducts = results.byNetwork.find((r) => r.network === networkId)?.products ?? [];
              for (const up of networkProducts) {
                if (allCanonical.length >= BUILD_CONFIG.PER_NETWORK_LIMIT) break;
                // La clave más fuerte es el `sourceId` externo (ASIN / Item ID):
                // dos búsquedas del mismo producto traen la MISMA id aunque
                // cambien los parámetros del enlace. Con la URL canónica como
                // clave principal, el mismo producto entraba dos veces.
                const sourceId = extractSourceId({ sourceId: up.externalId, affiliateUrl: up.productUrl } as any);
                const dedupeKey = sourceId || canonicalProductUrl(up.productUrl) || cleanTitleKey(up.title);
                if (seenGlobal.has(dedupeKey) || seenInNetwork.has(dedupeKey)) continue;
                seenGlobal.add(dedupeKey);
                seenInNetwork.add(dedupeKey);

                const upgraded = upgradeImages({ mainImage: up.image, gallery: up.gallery });

                const canonical: CanonicalWithMeta = {
                  network: networkId,
                  externalId: up.externalId,
                  affiliateUrl: up.productUrl,
                  directUrl: up.productUrl,
                  title: up.title,
                  description: up.description,
                  price: up.price,
                  originalPrice: up.originalPrice ?? up.price,
                  currency: up.currency,
                  discountPercentage: up.originalPrice && up.originalPrice > up.price
                    ? calculateDiscountPercentage(up.originalPrice, up.price)
                    : 0,
                  inStock: up.inStock,
                  commissionRate: up.commissionRate ?? 0,
                  estimatedCommission: calculateCommissionEstimate(up.price, up.commissionRate ?? 0),
                  category: up.category,
                  brand: up.brand,
                  merchantName: up.extra?.Tienda as string ?? up.extra?.Distribuidor as string ?? networkId,
                  merchantId: up.extra?.['ID tienda'] as string ?? undefined,
                  rating: up.rating ?? 0,
                  reviewCount: up.reviewsCount ?? 0,
                  sales: up.popularity ?? up.extra?.['Ventas (30 días)'] as number ?? undefined,
                  mainImage: upgraded.mainImage || up.image,
                  extraImages: upgraded.extraImages,
                  syncedAt: new Date().toISOString(),
                  _network: networkId,
                  _sourceUnified: up,
                };
                allCanonical.push(canonical);
              }
            } catch (e) {
              errors.push(`${networkId}:${keyword} → ${e instanceof Error ? e.message : 'error'}`);
            }
          }
          byNetwork[networkId] = allCanonical.length;
          return { canonicalProducts: allCanonical, networkId, errors: [] };
        }

        // Usar searchCanonical del conector nativo
        let networkCanonical: CanonicalAffiliateProduct[] = [];
        const seenInNetwork = new Set<string>();

        for (const keyword of BUILD_CONFIG.CATALOG_KEYWORDS) {
          if (networkCanonical.length >= BUILD_CONFIG.PER_NETWORK_LIMIT) break;
          try {
            const batch = await connector.searchCanonical({
              query: keyword,
              limit: 10,
              sortBy: 'popularity',
            });
            for (const product of batch) {
              if (networkCanonical.length >= BUILD_CONFIG.PER_NETWORK_LIMIT) break;
              // `sourceId` primero (misma clave que el pipeline y que la Etapa 1).
              const sourceId = extractSourceId({ sourceId: product.externalId, affiliateUrl: product.affiliateUrl });
              const dedupeKey = sourceId || canonicalProductUrl(product.affiliateUrl) || cleanTitleKey(product.title);
              if (seenGlobal.has(dedupeKey) || seenInNetwork.has(dedupeKey)) continue;
              seenGlobal.add(dedupeKey);
              seenInNetwork.add(dedupeKey);
              networkCanonical.push(product);
            }
          } catch (e) {
            errors.push(`${networkId}:${keyword} → ${e instanceof Error ? e.message : 'error'}`);
          }
        }

        const upgradedCanonical = networkCanonical.map((canonical) => {
          const upgraded = upgradeImages({ mainImage: canonical.mainImage, extraImages: canonical.extraImages });
          return {
            ...canonical,
            mainImage: upgraded.mainImage || canonical.mainImage,
            extraImages: upgraded.extraImages,
            _network: networkId,
            _sourceUnified: canonicalToUnified(canonical),
          } as CanonicalWithMeta;
        });

        byNetwork[networkId] = upgradedCanonical.length;
        return { canonicalProducts: upgradedCanonical, networkId, errors: [] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Error desconocido';
        errors.push(`${networkId}: ${msg}`);
        byNetwork[networkId] = 0;
        return { canonicalProducts: [], networkId, errors: [msg] };
      }
    })
  );

  const allCanonical: CanonicalWithMeta[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      allCanonical.push(...result.value.canonicalProducts);
      errors.push(...result.value.errors);
    } else {
      errors.push(result.reason instanceof Error ? result.reason.message : 'Error desconocido en red');
    }
  }

  return { canonicalProducts: allCanonical, byNetwork, networksQueried, errors };
}

// ─── Paso 2: Filtro de calidad ─────────────────────────────────────────────
function qualityFilter(products: CanonicalWithMeta[], filterStats: Record<string, number>): CanonicalWithMeta[] {
  return products.filter((p) => {
    if (!isValidTitle(p.title)) {
      filterStats.invalid_title = (filterStats.invalid_title || 0) + 1;
      return false;
    }
    if (!isValidPrice(p.price)) {
      filterStats.invalid_price = (filterStats.invalid_price || 0) + 1;
      return false;
    }
    // Segunda mano / reacondicionados: nunca entran en el catálogo público
    // (mismo detector que el preset «Segunda Mano» del panel).
    const secondHand = (p as any)._sourceUnified
      ? isSecondHand((p as any)._sourceUnified)
      : /\b(segunda\s+mano|reacondicionad[oa]s?|refurbished|pre-owned|usad[oa]s?|open\s*box|km\s*0|ex-demo|seminuev[oa]s?)\b/i
          .test(`${p.title} ${p.description || ''} ${p.category || ''}`);
    if (secondHand) {
      filterStats.second_hand = (filterStats.second_hand || 0) + 1;
      return false;
    }
    // Sin stock: el conector lo marca explícitamente (nunca se asume true).
    if (p.inStock === false) {
      filterStats.out_of_stock = (filterStats.out_of_stock || 0) + 1;
      return false;
    }
    if (BUILD_CONFIG.REQUIRE_IMAGE && !hasValidImage(p.mainImage)) {
      filterStats.no_image = (filterStats.no_image || 0) + 1;
      return false;
    }
    // Filtrar categorías excluidas (purgadas sin valor comercial)
    const catLower = (p.category || '').toLowerCase().trim();
    if (catLower && BUILD_CONFIG.EXCLUDED_CATEGORIES.some((ex) => catLower.includes(ex))) {
      filterStats.excluded_category = (filterStats.excluded_category || 0) + 1;
      return false;
    }
    // Limpiar guiones
    if (p.description?.trim() === '—' || p.description?.trim() === '-') p.description = '';
    if (p.brand?.trim() === '—' || p.brand?.trim() === '-') p.brand = undefined;
    if (p.merchantName?.trim() === '—' || p.merchantName?.trim() === '-') p.merchantName = p._network;
    return true;
  });
}

// ─── Paso 3: Deduplicación cross-merchant (reutiliza curation.ts) ──────────
function deduplicateCrossMerchant(products: CanonicalWithMeta[]): CrossMerchantGroup[] {
  // 1) Agrupar por red nativa: detectDuplicates usa sourceId / URL canónica / título limpio
  // Pero aquí trabajamos cross-merchant, así que usamos lógica similar adaptada
  const groups: CrossMerchantGroup[] = [];
  const used = new Set<number>();

  for (let i = 0; i < products.length; i++) {
    if (used.has(i)) continue;
    const base = products[i];
    const variants: CanonicalWithMeta[] = [];
    const allNetworks = new Set<string>([base._network]);
    const allAffiliateUrls: Record<string, string> = { [base._network]: base.affiliateUrl };
    const allDirectUrls: Record<string, string> = { [base._network]: base.directUrl };
    const allMerchantNames: Record<string, string> = { [base._network]: cleanMerchant(base.merchantName) };
    const allExtraImages = [...base.extraImages];
    const allPrices: Record<string, number> = { [base._network]: base.price };
    const allOriginalPrices: Record<string, number> = {};
    if (base.originalPrice > base.price) allOriginalPrices[base._network] = base.originalPrice;
    const allCurrencies: Record<string, string> = base.currency ? { [base._network]: base.currency } : {};

    let bestPrice = base.price;
    let bestOriginalPrice = base.originalPrice;
    let bestCommissionRate = base.commissionRate;
    let bestCommissionAmount = base.estimatedCommission;
    let bestRating = base.rating;
    let bestSales = base.sales ?? 0;

    for (let j = i + 1; j < products.length; j++) {
      if (used.has(j)) continue;
      const candidate = products[j];

      let match = false;
      // Criterio 1: sourceId idéntico
      if (base.externalId && candidate.externalId && base.externalId === candidate.externalId) {
        match = true;
      }
      // Criterio 2: URL canónica idéntica
      else if (base.affiliateUrl && candidate.affiliateUrl) {
        if (canonicalProductUrl(base.affiliateUrl) === canonicalProductUrl(candidate.affiliateUrl)) {
          match = true;
        }
      }
      // Criterio 3: título limpio muy similar (Jaccard ≥ threshold)
      else if (titleSimilarity(base.title, candidate.title) >= BUILD_CONFIG.TITLE_SIMILARITY_THRESHOLD) {
        match = true;
      }
      // Criterio 4: misma marca + título parecido
      else if (
        base.brand &&
        candidate.brand &&
        base.brand.toLowerCase() === candidate.brand.toLowerCase() &&
        titleSimilarity(base.title, candidate.title) >= 0.6
      ) {
        match = true;
      }

      if (!match) continue;

      variants.push(candidate);
      used.add(j);
      allNetworks.add(candidate._network);
      allAffiliateUrls[candidate._network] = candidate.affiliateUrl;
      allDirectUrls[candidate._network] = candidate.directUrl;
      allMerchantNames[candidate._network] = cleanMerchant(candidate.merchantName);
      allExtraImages.push(...candidate.extraImages);
      allPrices[candidate._network] = candidate.price;
      if (candidate.originalPrice > candidate.price) allOriginalPrices[candidate._network] = candidate.originalPrice;
      if (candidate.currency) allCurrencies[candidate._network] = candidate.currency;

      if (candidate.price < bestPrice) bestPrice = candidate.price;
      if (candidate.originalPrice > bestOriginalPrice) bestOriginalPrice = candidate.originalPrice;
      if (candidate.commissionRate > bestCommissionRate) bestCommissionRate = candidate.commissionRate;
      if (candidate.estimatedCommission > bestCommissionAmount) bestCommissionAmount = candidate.estimatedCommission;
      if (candidate.rating > bestRating) bestRating = candidate.rating;
      if ((candidate.sales ?? 0) > bestSales) bestSales = candidate.sales ?? 0;
    }

    used.add(i);

    groups.push({
      canonical: base,
      variants,
      bestPrice,
      bestOriginalPrice,
      bestCommissionRate,
      bestCommissionAmount,
      bestRating,
      bestSales,
      allNetworks: [...allNetworks],
      allAffiliateUrls,
      allDirectUrls,
      allMerchantNames,
      allExtraImages: [...new Set(allExtraImages)].slice(0, MAX_PRODUCT_IMAGES),
      allPrices,
      allOriginalPrices,
      allCurrencies,
    });

    if (groups.length >= BUILD_CONFIG.MAX_CROSS_MERCHANT_GROUPS) break;
  }

  return groups;
}

// ─── Paso 4: Categorización SOLO en existentes (roots + subs por keywords) ──
async function autoCategorize(groups: CrossMerchantGroup[]): Promise<{
  uncategorized: number;
  categorizedGroups: Array<CrossMerchantGroup & { category: string; subcategory?: string; categoryId?: string; subcategoryId?: string }>;
  categoryBreakdown: CategoryBreakdown[];
}> {
  const existingCategories = getCategories();
  const rootCategories = existingCategories.filter((c) => !c.parentId);
  const categorizedGroups: Array<CrossMerchantGroup & { category: string; subcategory?: string; categoryId?: string; subcategoryId?: string }> = [];
  let uncategorized = 0;

  // Mapa para construir el breakdown: categoryId -> { categoryName, subcategories: Map<subId, {name, count}> }
  const breakdownMap = new Map<string, { category: string; categoryId: string; subcategories: Map<string, { name: string; id: string; count: number }> }>();

  for (const group of groups) {
    const text = `${group.canonical.title} ${group.canonical.description} ${group.canonical.category}`.toLowerCase();

    // 1) Buscar mejor root por suggestCategoryStrict (usa mandatory rules + keywords scoring)
    const matchedRoot = suggestCategoryStrict(text);

    let categoryName = '';
    let categoryId: string | undefined;
    let subcategoryName: string | undefined;
    let subcategoryId: string | undefined;

    if (matchedRoot) {
      categoryName = matchedRoot.name;
      categoryId = matchedRoot.id;

      // Inicializar en breakdown si no existe
      if (!breakdownMap.has(categoryId)) {
        breakdownMap.set(categoryId, { category: categoryName, categoryId, subcategories: new Map() });
      }

      // 2) Buscar mejor subcategoría existente bajo esta root por keywords
      const subs = existingCategories.filter((c) => c.parentId === categoryId);
      if (subs.length > 0) {
        let bestSub: { cat: typeof subs[0]; matches: number } | null = null;
        for (const sub of subs) {
          const matches = (sub.keywords ?? []).reduce(
            (count, kw) => (kw && text.includes(kw.toLowerCase()) ? count + 1 : count),
            0
          );
          if (matches > 0 && (!bestSub || matches > bestSub.matches)) {
            bestSub = { cat: sub, matches };
          }
        }
        if (bestSub) {
          subcategoryName = bestSub.cat.name;
          subcategoryId = bestSub.cat.id;
        }
      }

      // Si no hay subcategoría específica, usar "General" o la primera disponible
      const subKey = subcategoryId || 'general';
      const subName = subcategoryName || 'General';
      const catBreakdown = breakdownMap.get(categoryId)!;
      const existing = catBreakdown.subcategories.get(subKey) || { name: subName, id: subcategoryId || '', count: 0 };
      existing.count++;
      catBreakdown.subcategories.set(subKey, existing);
    }

    // 3) Si no hay match de root → sin categoría
    if (!categoryId) {
      uncategorized++;
      categoryName = '';
    }

    categorizedGroups.push({
      ...group,
      category: categoryName,
      subcategory: subcategoryName,
      categoryId,
      subcategoryId,
    });
  }

  // Convertir breakdownMap a array CategoryBreakdown[]
  const categoryBreakdown: CategoryBreakdown[] = [];
  for (const [catId, data] of breakdownMap.entries()) {
    const subcategories: Record<string, { name: string; id: string; count: number }> = {};
    let total = 0;
    for (const [subKey, subData] of data.subcategories.entries()) {
      subcategories[subKey] = subData;
      total += subData.count;
    }
    categoryBreakdown.push({
      category: data.category,
      categoryId: data.categoryId,
      subcategories,
      total,
    });
  }

  // Ordenar por total descendente
  categoryBreakdown.sort((a, b) => b.total - a.total);

  return { uncategorized, categorizedGroups, categoryBreakdown };
}

// ─── Paso 5: Detección ofertas estrella (HSR) ───────────────────────────────
function detectHSR(groups: Array<CrossMerchantGroup & { category: string; subcategory?: string; categoryId?: string; subcategoryId?: string }>): Array<CrossMerchantGroup & { category: string; subcategory?: string; categoryId?: string; subcategoryId?: string; isHSR: boolean; hsrScore: number }> {
  const scored = groups.map((group) => {
    const discount = group.bestOriginalPrice > group.bestPrice
      ? calculateDiscountPercentage(group.bestOriginalPrice, group.bestPrice)
      : 0;

    const commissionScore = Math.min(100, (group.bestCommissionRate / 20) * 100);
    const discountScore = Math.min(100, (discount / 50) * 100);
    const ratingScore = (group.bestRating / 5) * 100;
    const salesScore = Math.min(100, Math.log10(1 + group.bestSales) * 20);

    const hsrScore = Math.round(
      discountScore * 0.4 +
      commissionScore * 0.3 +
      ratingScore * 0.2 +
      salesScore * 0.1
    );

    const isHSR = discount >= BUILD_CONFIG.HSR_MIN_DISCOUNT &&
      group.bestCommissionRate >= BUILD_CONFIG.HSR_MIN_COMMISSION &&
      hsrScore >= 50;

    return { ...group, isHSR, hsrScore };
  });

  scored.sort((a, b) => b.hsrScore - a.hsrScore);
  const hsrCount = Math.min(BUILD_CONFIG.HSR_COUNT, scored.filter((g) => g.isHSR).length);
  scored.slice(0, hsrCount).forEach((g) => { g.isHSR = true; });

  return scored;
}

// ─── Paso 6: Ordenación inteligente ────────────────────────────────────────
function smartSort(groups: Array<CrossMerchantGroup & { category: string; subcategory?: string; categoryId?: string; subcategoryId?: string; isHSR: boolean; hsrScore: number }>): typeof groups {
  return groups.sort((a, b) => {
    if (a.isHSR !== b.isHSR) return a.isHSR ? -1 : 1;
    const scoreA = (a.bestSales * a.bestCommissionAmount) / Math.max(a.bestPrice, 1);
    const scoreB = (b.bestSales * b.bestCommissionAmount) / Math.max(b.bestPrice, 1);
    return scoreB - scoreA;
  });
}

// ─── Paso 7: Construcción de Product + stamping pipeline + upsert atómico ────
async function buildAndUpsertProducts(
  groups: Array<CrossMerchantGroup & { category: string; subcategory?: string; categoryId?: string; subcategoryId?: string; isHSR: boolean; hsrScore: number }>,
  dryRun: boolean,
  enrich = true
): Promise<{ upserted: number; updated: number; wouldUpsert: number; wouldUpdate: number; aiEnrichedText: number; aiEnrichedImages: number }> {
  const existingProducts = readProductsFromFile();
  const existingIds = new Set(existingProducts.map((p) => p.id));
  const deletedIds = new Set(readDeletedIds());

  let upserted = 0;
  let updated = 0;
  let wouldUpsert = 0;
  let wouldUpdate = 0;
  let aiEnrichedTextCount = 0;
  let aiEnrichedImagesCount = 0;

  const pipelineConfig = getPipelineConfig();

  for (const group of groups) {
    const canonical = group.canonical;
    const affiliateUrl = group.allAffiliateUrls[group.allNetworks[0]] || canonical.affiliateUrl;
    const merchantName = cleanMerchant(group.allMerchantNames[group.allNetworks[0]]) || canonical.merchantName;

    // Identidad del producto: el `sourceId` externo (ASIN / Item ID) es la clave
    // más fuerte; si no hay, se usa la URL canónica.
    const sourceId = String(canonical.externalId || '').trim()
      || extractSourceId({ sourceId: canonical.externalId, affiliateUrl } as any);
    const canonicalUrl = canonicalProductUrl(affiliateUrl);

    // ¿Este producto YA está en el catálogo? Si lo está, se ACTUALIZA (con su
    // id) en vez de crear una copia "-2" con el mismo sourceId.
    let existingIndex = -1;
    if (sourceId) {
      existingIndex = existingProducts.findIndex((p) => extractSourceId(p) === sourceId);
    }
    if (existingIndex === -1 && canonicalUrl) {
      existingIndex = existingProducts.findIndex(
        (p) => canonicalProductUrl(p.affiliateUrl) === canonicalUrl || canonicalProductUrl(p.buyNowUrl) === canonicalUrl,
      );
    }

    // Id destino: el del producto existente o, si es nuevo, uno generado.
    const baseId = existingIndex >= 0 ? existingProducts[existingIndex].id : generateProductId(canonical.title, existingIds);
    existingIds.add(baseId);

    // Saltar tombstones
    if (deletedIds.has(baseId)) {
      continue;
    }

    // Duplicado contra catálogo existente (reutiliza stageIngest).
    // El `sourceId` se pasa explícitamente: si no, `extractSourceId` no puede
    // compararlo con el del catálogo y el duplicado se escapaba.
    const duplicateHit = findIngestDuplicate(existingProducts, {
      ...canonical,
      id: baseId,
      sourceId,
      category: group.category || 'Tecnología',
      merchant: merchantName,
      affiliateUrl,
    } as any, baseId);

    if (duplicateHit && existingIndex === -1) {
      existingIndex = existingProducts.findIndex((p) => p.id === duplicateHit.duplicateOf);
    }

    const discountPct = calculateDiscountPercentage(group.bestOriginalPrice, group.bestPrice);
    const hsrBadge = group.isHSR ? 'Oferta Estrella' : undefined;

    const upgraded = upgradeImages({
      mainImage: canonical.mainImage,
      extraImages: canonical.extraImages,
      gallery: group.allExtraImages,
    });

    const product: Product = {
      id: baseId,
      title: canonical.title,
      description: canonical.description || `${canonical.brand ?? canonical.merchantName} · ${canonical.category}`,
      price: group.bestPrice,
      originalPrice: group.bestOriginalPrice > group.bestPrice ? group.bestOriginalPrice : undefined,
      image: upgraded.mainImage || canonical.mainImage || '',
      gallery: upgraded.gallery,
      category: group.category || '', // vacío si no encaja
      subcategory_id: group.subcategoryId,
      merchant: cleanMerchant(group.allMerchantNames[group.allNetworks[0]]) || canonical.merchantName,
      affiliateUrl: group.allAffiliateUrls[group.allNetworks[0]] || canonical.affiliateUrl,
      buyNowUrl: group.allDirectUrls[group.allNetworks[0]] || canonical.directUrl,
      asin: canonical.network === 'amazon' ? canonical.externalId : undefined,
      pros: [
        `Disponible en ${group.allNetworks.length} comerciante(s)`,
        ...(discountPct > 0 ? [`Descuento ${discountPct}%`] : []),
        ...(group.bestCommissionRate > 0 ? [`Comisión ${group.bestCommissionRate}%`] : []),
      ],
      cons: group.variants.length > 0 ? [`Comparar precios en ${group.allNetworks.join(', ')}`] : [],
      badge: hsrBadge,
      rating: group.bestRating > 0 ? group.bestRating : undefined,
      reviewsCount: canonical.reviewCount > 0 ? canonical.reviewCount : undefined,
      brand: canonical.brand,
      // Datos crudos de la red de origen: comisión, divisa, stock y
      // visitas/alcance (si la red los facilita). `allNetworks[0]` es la red
      // "ganadora" del grupo cross-merchant (mismo criterio que `merchant`
      // y `affiliateUrl` justo arriba).
      network: canonical.network || group.allNetworks[0],
      currency: canonical.currency || group.allCurrencies[group.allNetworks[0]],
      commissionRate: group.bestCommissionRate > 0 ? group.bestCommissionRate : undefined,
      inStock: canonical.inStock,
      visits: canonical._sourceUnified?.visits,
      // Estado físico: por diseño, «Construir Catálogo» descarta la segunda
      // mano antes de llegar aquí (ver `isSecondHand` en `qualityFilter`); se
      // conserva igualmente si la red lo declara explícitamente como "Nuevo".
      condition:
        (canonical.extra?.['Estado'] as string | undefined) ??
        (canonical.extra?.['Condición'] as string | undefined) ??
        (canonical.extra?.['Condition'] as string | undefined),
      // El envío viaja en la proyección unificada (el canónico no lo declara).
      shippingInfo: canonical._sourceUnified?.shippingInfo ?? canonical.extra?.['Texto de envío'] as string | undefined,
      shippingDays: canonical._sourceUnified?.shippingDays,
      freeShipping: canonical.extra?.['Envío gratis'] === true,
      sourceId: canonical.externalId,
      category_id: group.categoryId,
      // Pipeline fields
      audit_status: 'pending',
      audit_score: 0,
      audit_reasons: [],
      ia_status: 'pending',
      // El estado del enlace lo recalcula `computeEditorialStatus` (activo si el
      // producto trae URL de afiliado); el valor inicial evita dejar el campo
      // vacío en el objeto intermedio.
      link_status: group.allAffiliateUrls[0] || canonical.affiliateUrl ? 'active' : 'pending',
      normalized_tags: [],
      conversion_score: 0,
      pipeline_version: pipelineConfig.version,
      pipeline_run_at: new Date().toISOString(),
      commissionEstimate: group.bestCommissionAmount,
      sales30d: group.bestSales,
      extra: {
        ...canonical.extra,
        crossMerchant: {
          networks: group.allNetworks,
          affiliateUrls: group.allAffiliateUrls,
          directUrls: group.allDirectUrls,
          merchantNames: group.allMerchantNames,
          prices: group.allPrices,
          originalPrices: group.allOriginalPrices,
          currencies: group.allCurrencies,
          variantsCount: group.variants.length + 1,
          hsr: group.isHSR,
          hsrScore: group.hsrScore,
        },
      },
    };

    // `computeBadge` lee precio/rating/ventas/etc. del propio producto, así que
    // necesita que `product` ya exista: no se puede llamar dentro de su propio
    // literal (eso lanzaba "Cannot access 'product' before initialization" y
    // abortaba TODO el build en el primer producto no marcado como HSR).
    if (!product.badge) {
      product.badge = computeBadge(product as Product & { hsrScore?: number });
    }

    const existingProduct = existingIndex >= 0 ? existingProducts[existingIndex] : undefined;

    // ─── Curaduría: un resync NUNCA debe perder lo ya conseguido ────────────
    // Categoría: una vez asignada (a mano en el panel o por un
    // `autoCategorize` anterior) queda "pegajosa": sólo se recalcula
    // mientras el producto siga sin categoría. Sin esto, cada «Construir
    // Catálogo» podía reasignar (o vaciar) la categoría que el admin eligió
    // a mano.
    if (existingProduct?.category_id) {
      product.category = existingProduct.category || product.category;
      product.category_id = existingProduct.category_id;
      product.subcategory_id = existingProduct.subcategory_id ?? product.subcategory_id;
    }

    // Imágenes: la galería SIEMPRE se amplía con lo nuevo que traiga este
    // sync (nunca se descarta nada ya guardado) y la foto principal real
    // nunca se sustituye por otra, para no cambiarle la imagen a un producto
    // que el visitante ya puede haber visto.
    if (existingProduct) {
      const mergedGallery = new Set<string>([
        ...(existingProduct.image && existingProduct.image !== '—' ? [existingProduct.image] : []),
        ...(existingProduct.gallery ?? []),
        ...(product.gallery ?? []),
      ]);
      product.gallery = [...mergedGallery].slice(0, MAX_PRODUCT_IMAGES);
      if (existingProduct.image && existingProduct.image !== '—') {
        product.image = existingProduct.image;
      }
    }

    // Texto editorial: si la ficha YA se completó en un pase anterior, se
    // conserva tal cual (precio, comisión, enlaces, ventas y galería sí se
    // refrescan en cada sync; el texto curado/IA no se pisa con los datos
    // crudos de la red que trae `product` hasta aquí).
    const alreadyEnriched = Boolean(existingProduct?.ia_status === 'completed');
    if (alreadyEnriched && existingProduct) {
      product.title = existingProduct.title;
      product.description = existingProduct.description;
      product.pros = existingProduct.pros;
      product.cons = existingProduct.cons;
      product.verdict = existingProduct.verdict;
      product.techSheet = existingProduct.techSheet;
      product.specs = existingProduct.specs;
      product.ia_status = existingProduct.ia_status;
      if (existingProduct.badge) product.badge = existingProduct.badge;
    }

    // ─── Enriquecimiento con IA (texto + imagen) ────────────────────────────────
    // Misma calidad que "Enriquecer con IA (título + ficha + imagen)": base
    // SIEMPRE local (gratis, sin claves) y overlay de IA por encima cuando
    // hay credenciales, con fallback automático entre proveedores si el por
    // defecto falla (ver `enrichProductText`). Corre para productos NUEVOS o
    // que aún no se completaron; nunca para fichas ya enriquecidas (se
    // protegieron más arriba). Con `?enrich=0` se publica el catálogo sin
    // llamar a la IA (publicación rápida); se puede completar después por
    // lotes con el Pipeline.
    if (enrich && !alreadyEnriched) {
      const localText = enrichProductLocally({
        title: product.title,
        description: product.description,
        category: product.category,
        brand: product.brand,
        merchant: product.merchant,
        price: product.price,
        originalPrice: product.originalPrice,
        rating: product.rating,
        reviewsCount: product.reviewsCount,
        url: product.affiliateUrl,
        pros: product.pros,
        cons: product.cons,
      });

      let finalText = localText;
      if (hasTextCredentials()) {
        try {
          const aiText = await enrichProductText({
            title: product.title,
            description: product.description,
            category: product.category,
            url: product.affiliateUrl,
            price: product.price,
            originalPrice: product.originalPrice,
          });
          finalText = overlayEnrichedText(localText, aiText);
          aiEnrichedTextCount++;
        } catch (aiError) {
          console.warn(`[BuildCatalog] Sin enriquecimiento de IA para "${product.title}" (se usa ficha local):`, aiError);
        }
      }

      if (finalText.title?.trim()) product.title = finalText.title.trim();
      if (finalText.description?.trim()) product.description = finalText.description;
      if (finalText.pros.length) product.pros = finalText.pros;
      if (finalText.cons.length) product.cons = finalText.cons;
      if (finalText.verdict) product.verdict = finalText.verdict;
      if (finalText.techSheet?.trim()) product.techSheet = finalText.techSheet;
      if (finalText.specs && Object.keys(finalText.specs).length) product.specs = finalText.specs;
      if (!product.category && finalText.category) product.category = finalText.category;
      // Marca: la IA sólo la aporta si el producto no tenía ninguna (nunca
      // sobrescribe una marca ya curada/verificada).
      if (!product.brand && finalText.brand) product.brand = finalText.brand;
      // El precio SIEMPRE es el real de la red (`group.bestPrice` /
      // `bestOriginalPrice`): el par oferta/original que calcula el
      // enriquecimiento es sólo de respaldo para el alta manual sin precio
      // conocido y nunca debe sustituir un precio real ya capturado.
      product.ia_status = 'completed';

      // Imagen: sólo si falta (nunca sustituye una foto real del comercio).
      if ((!product.image || product.image === '—') && hasImageCredentials()) {
        try {
          const imageResult = await generateProductImage(product.title);
          product.image = imageResult.url;
          product.gallery = [imageResult.url, ...(product.gallery || [])].slice(0, MAX_PRODUCT_IMAGES);
          aiEnrichedImagesCount++;
        } catch (imgError) {
          console.warn(`[BuildCatalog] Error generando imagen para ${product.id}:`, imgError);
        }
      }
    }

    // Stamping pipeline: auditoría
    const auditResult = runStageAudit(product, pipelineConfig);
    if (auditResult.ok && auditResult.product) {
      product.audit_status = (auditResult.product as any).audit_status ?? 'pending';
      product.audit_score = (auditResult.product as any).audit_score ?? 0;
      product.audit_reasons = (auditResult.product as any).audit_reasons ?? [];
    }

    // Editorial status
    const editorial = computeEditorialStatus(product);
    product.ia_status = editorial.ia_status;
    product.link_status = editorial.link_status;

    // Tags normalizados
    product.normalized_tags = extractNormalizedTags(product);

    // Conversion score real (no hsrScore)
    product.conversion_score = computeConversionScore(product);

    if (existingIndex >= 0) {
      const prev = existingProducts[existingIndex];
      // Al actualizar NO se puede perder lo ya curado. La pasada actual puede
      // no encontrar categoría (viene `category: ''`) o no traer subcategoría,
      // y el producto puede haberse localizado por URL canónica o por duplicado
      // (en cuyo caso el id generado NO es el id real). Si se sobrescribiera,
      // el producto renombraría y dejaría de aparecer en las secciones que lo
      // referencian.
      existingProducts[existingIndex] = {
        ...prev,
        ...product,
        id: prev.id,
        category: product.category || prev.category || '',
        category_id: product.category_id ?? prev.category_id,
        subcategory_id: product.subcategory_id ?? prev.subcategory_id,
      };
      updated++;
      wouldUpdate++;
    } else {
      existingProducts.unshift(product);
      upserted++;
      wouldUpsert++;
      existingIds.add(baseId);
    }
  }

  if (!dryRun) {
    // Escritura atómica tmp+rename (patrón de metrics.ts)
    const DATA_FILE = path.join(DATA_DIR, 'products.json');
    const tmpFile = `${DATA_FILE}.tmp`;
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify(existingProducts, null, 2), 'utf-8');
    fs.renameSync(tmpFile, DATA_FILE);
  }

  return { upserted, updated, wouldUpsert, wouldUpdate, aiEnrichedText: aiEnrichedTextCount, aiEnrichedImages: aiEnrichedImagesCount };
}

// ─── Endpoint principal ────────────────────────────────────────────────────
export const POST: APIRoute = async ({ request, url }) => {
  if (!isValidApiToken(request)) return unauthorizedApiResponse();

  const dryRun = url.searchParams.get('dryRun') === '1';
  // `?enrich=0` publica el catálogo sin llamar a la IA (muchos productos nuevos
  // = muchos minutos de llamadas y límites de peticiones del proveedor).
  const enrich = url.searchParams.get('enrich') !== '0';

  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const report: BuildReport = {
    success: false,
    startedAt,
    finishedAt: '',
    durationMs: 0,
    networksQueried: [],
    productsByNetwork: {},
    rawTotal: 0,
    afterQualityFilter: 0,
    crossMerchantGroups: 0,
    duplicatesResolved: 0,
    uncategorized: 0,
    hsrDetected: 0,
    upserted: 0,
    updated: 0,
    truncated: 0,
    aiEnrichedText: 0,
    aiEnrichedImages: 0,
    errors: [],
    categoryBreakdown: [],
    filteredByReason: {},
  };

  try {
    // 1. Ingesión paralela
    const { canonicalProducts, byNetwork, networksQueried, errors: ingestErrors } = await ingestAllNetworks();
    report.networksQueried = networksQueried;
    report.productsByNetwork = byNetwork;
    report.rawTotal = canonicalProducts.length;
    report.errors.push(...ingestErrors);

    // 2. Filtro calidad con estadísticas
    const filterStats: Record<string, number> = {};
    const qualityProducts = qualityFilter(canonicalProducts, filterStats);
    report.afterQualityFilter = qualityProducts.length;
    report.filteredByReason = filterStats;

    // 3. Deduplicación cross-merchant
    const groups = deduplicateCrossMerchant(qualityProducts);
    report.crossMerchantGroups = groups.length;
    report.duplicatesResolved = qualityProducts.length - groups.length;
    if (groups.length >= BUILD_CONFIG.MAX_CROSS_MERCHANT_GROUPS) {
      report.truncated = groups.length - BUILD_CONFIG.MAX_CROSS_MERCHANT_GROUPS;
    }

    // 4. Categorización (solo existentes) con breakdown
    const { uncategorized, categorizedGroups, categoryBreakdown } = await autoCategorize(groups);
    report.uncategorized = uncategorized;
    report.categoryBreakdown = categoryBreakdown;

    // 5. HSR
    const withHSR = detectHSR(categorizedGroups);
    report.hsrDetected = withHSR.filter((g) => g.isHSR).length;

    // 6. Ordenación
    const sortedGroups = smartSort(withHSR);

    // 7. Build + upsert con stamping pipeline
    const { upserted, updated, wouldUpsert, wouldUpdate, aiEnrichedText, aiEnrichedImages } = await buildAndUpsertProducts(sortedGroups, dryRun, enrich);
    report.upserted = upserted;
    report.updated = updated;
    report.aiEnrichedText = aiEnrichedText;
    report.aiEnrichedImages = aiEnrichedImages;
    // `wouldUpsert`/`wouldUpdate` son los mismos números que `upserted`/
    // `updated` (el código de escritura es idéntico en dry-run y en real):
    // en simulación sirven para saber qué se escribiría y en real deja el
    // reporte completo y coherente en los dos modos.
    report.wouldUpsert = wouldUpsert;
    report.wouldUpdate = wouldUpdate;

    // Métricas pipeline
    if (!dryRun) {
      try {
        incrementMetric('runs');
        incrementMetric('duplicatesDiscarded', report.duplicatesResolved);
        incrementMetric('productsProcessed', report.crossMerchantGroups);
        // Sin esto el panel «Pipeline» mostraría siempre la fecha de la
        // última ejecución del pipeline de importación, no la de este build.
        touchMetrics();
      } catch {
        // no romper si fallan métricas
      }
    }

    // Log resumen estructurado en consola
    console.log('[BuildCatalog] ===== BUILD SUMMARY REPORT =====');
    console.log(`[BuildCatalog] Total productos procesados: ${report.rawTotal}`);
    console.log(`[BuildCatalog] Tras filtro calidad: ${report.afterQualityFilter}`);
    console.log(`[BuildCatalog] Filtrados:`, filterStats);
    console.log(`[BuildCatalog] Grupos cross-merchant: ${report.crossMerchantGroups} (duplicados resueltos: ${report.duplicatesResolved})`);
    console.log(`[BuildCatalog] Sin categoría: ${report.uncategorized}`);
    console.log(`[BuildCatalog] Ofertas estrella (HSR): ${report.hsrDetected}`);
    console.log(`[BuildCatalog] Nuevos: ${report.upserted} · Actualizados: ${report.updated}`);
    console.log(`[BuildCatalog] IA - Texto: ${report.aiEnrichedText} · Imágenes: ${report.aiEnrichedImages}`);
    console.log('[BuildCatalog] --- Distribución por categorías ---');
    for (const cat of categoryBreakdown) {
      console.log(`[BuildCatalog]   ${cat.category} (${cat.total}):`);
      for (const [subKey, subData] of Object.entries(cat.subcategories)) {
        console.log(`[BuildCatalog]     - ${subData.name}: ${subData.count}`);
      }
    }
    console.log('[BuildCatalog] =================================');

    report.success = true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Error crítico en build-catalog';
    report.errors.push(msg);
    console.error('[BuildCatalog] Error:', error);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startTime;
  }

  return new Response(JSON.stringify(report), {
    status: report.success ? 200 : 500,
    headers: jsonHeaders,
  });
};