/**
 * ==============================================================================
 * TRADYLOR - API PÚBLICA v1: CONSTRUCCIÓN AUTOMÁTICA DEL CATÁLOGO MULTI-COMERCIANTE
 * ==============================================================================
 * POST /api/v1/products/build-catalog
 *
 * Autenticación: header Authorization: Bearer <TRADYLOR_API_TOKEN>
 *
 * Proceso completo de un solo clic:
 *   1. Ingesión paralela de todas las redes conectadas (eBay, AliExpress, etc.)
 *   2. Normalización canónica (CanonicalAffiliateProduct)
 *   3. Filtro de calidad estricto (imagen, título, precio > 0, sin guiones)
 *   4. Deduplicación cross-merchant (mismo producto en varias redes → una entidad)
 *   5. Autoclasificación dinámica (crea categorías/subcategorías si no existen)
 *   6. Detección ofertas estrella (class="hsr", top 10-15 por descuento/margen)
 *   7. Ordenación inteligente (popularidad, ventas, score conversión)
 *   8. Upsert masivo en products.json + reporte JSON detallado
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { unifiedSearch, getConnector } from '../../../../lib/networks';
import { getConnectedNetworkIds } from '../../../../lib/networks/credentials';
import { getCategories, suggestCategoryStrict, slugifyCategory } from '../../../../lib/categories';
import { readProductsFromFile, writeProductsToFile, slugify, type Product } from '../../../../lib/productStore';
import { isValidApiToken, unauthorizedApiResponse } from '../../../../lib/apiAuth';
import { canonicalToUnified } from '../../../../lib/networks/connectors/base';
import type { CanonicalAffiliateProduct, UnifiedProduct, NetworkConnector } from '../../../../lib/networks/types';

export const prerender = false;

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };

// ─── Configuración del proceso ──────────────────────────────────────────────
const BUILD_CONFIG = {
  // Palabras clave de barrido amplio para cada red (mismo que usa AliExpressConnector)
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

  // Límites por red para no saturar APIs
  PER_NETWORK_LIMIT: 50,

  // Umbrales de calidad
  MIN_PRICE: 1,
  MIN_TITLE_LENGTH: 5,
  REQUIRE_IMAGE: true,

  // Ofertas estrella (HS = High Selling / Hot Selection)
  HSR_COUNT: 12,                    // 10-15 productos
  HSR_MIN_DISCOUNT: 15,             // % descuento mínimo
  HSR_MIN_COMMISSION: 3,            // % comisión mínima

  // Cross-merchant matching
  TITLE_SIMILARITY_THRESHOLD: 0.75, // Jaccard similarity para considerar mismo producto
  MAX_CROSS_MERCHANT_GROUPS: 100,   // Límite grupos de deduplicación
} as const;

// ─── Interfaces internas ────────────────────────────────────────────────────

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
  categoriesCreated: number;
  subcategoriesCreated: number;
  hsrDetected: number;
  upserted: number;
  updated: number;
  errors: string[];
}

interface CanonicalWithMeta extends CanonicalAffiliateProduct {
  _network: string;
  _sourceUnified: UnifiedProduct;
}

// ─── Utilidades ─────────────────────────────────────────────────────────────

function cleanTitleKey(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  const tokensA = new Set(cleanTitleKey(a).split(' ').filter((t) => t.length > 2));
  const tokensB = new Set(cleanTitleKey(b).split(' ').filter((t) => t.length > 2));
  if (!tokensA.size || !tokensB.size) return 0;
  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection += 1;
  return intersection / (tokensA.size + tokensB.size - intersection);
}

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

// ─── Paso 1: Ingesión multi-comerciante (paralelo) ──────────────────────────

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

  // Para cada red conectada, buscar con sus palabras clave
  const allCanonical: CanonicalWithMeta[] = [];

  for (const networkId of connected) {
    try {
      const connector = getConnector(networkId) as NetworkConnector | null;
      if (!connector || typeof connector.searchCanonical !== 'function') {
        // Fallback: usar unifiedSearch que ya existe
        const results = await unifiedSearch({
          limit: BUILD_CONFIG.PER_NETWORK_LIMIT,
          sortBy: 'popularity',
        });
        const networkProducts = results.byNetwork.find((r) => r.network === networkId)?.products ?? [];
        for (const up of networkProducts) {
          // Convertir UnifiedProduct → CanonicalAffiliateProduct aproximado
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
            mainImage: up.image,
            extraImages: up.gallery?.filter((g) => g !== up.image) ?? [],
            syncedAt: new Date().toISOString(),
            _network: networkId,
            _sourceUnified: up,
          };
          allCanonical.push(canonical);
        }
        byNetwork[networkId] = networkProducts.length;
        continue;
      }

      // Usar searchCanonical del conector nativo
      let networkCanonical: CanonicalAffiliateProduct[] = [];
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
            networkCanonical.push(product);
          }
        } catch (e) {
          errors.push(`${networkId}:${keyword} → ${e instanceof Error ? e.message : 'error'}`);
        }
      }

      for (const canonical of networkCanonical) {
        allCanonical.push({
          ...canonical,
          _network: networkId,
          _sourceUnified: canonicalToUnified(canonical),
        });
      }
      byNetwork[networkId] = networkCanonical.length;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Error desconocido';
      errors.push(`${networkId}: ${msg}`);
      byNetwork[networkId] = 0;
    }
  }

  return { canonicalProducts: allCanonical, byNetwork, networksQueried, errors };
}

// ─── Paso 2: Filtro de calidad estricto ────────────────────────────────────

function qualityFilter(products: CanonicalWithMeta[]): CanonicalWithMeta[] {
  return products.filter((p) => {
    if (!isValidTitle(p.title)) return false;
    if (!isValidPrice(p.price)) return false;
    if (BUILD_CONFIG.REQUIRE_IMAGE && !hasValidImage(p.mainImage)) return false;
    // Descartar campos con guiones que deterioran la UI
    if (p.description?.trim() === '—' || p.description?.trim() === '-') p.description = '';
    if (p.brand?.trim() === '—' || p.brand?.trim() === '-') p.brand = undefined;
    if (p.merchantName?.trim() === '—' || p.merchantName?.trim() === '-') p.merchantName = p._network;
    return true;
  });
}

// ─── Paso 3: Deduplicación cross-merchant ──────────────────────────────────

interface CrossMerchantGroup {
  canonical: CanonicalWithMeta;
  variants: CanonicalWithMeta[]; // mismo producto en otras redes
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
}

function deduplicateCrossMerchant(products: CanonicalWithMeta[]): CrossMerchantGroup[] {
  const groups: CrossMerchantGroup[] = [];
  const used = new Set<number>();

  for (let i = 0; i < products.length; i++) {
    if (used.has(i)) continue;
    const base = products[i];
    const variants: CanonicalWithMeta[] = [];
    const allNetworks = new Set<string>([base._network]);
    const allAffiliateUrls: Record<string, string> = { [base._network]: base.affiliateUrl };
    const allDirectUrls: Record<string, string> = { [base._network]: base.directUrl };
    const allMerchantNames: Record<string, string> = { [base._network]: base.merchantName };
    const allExtraImages = [...base.extraImages];

    let bestPrice = base.price;
    let bestOriginalPrice = base.originalPrice;
    let bestCommissionRate = base.commissionRate;
    let bestCommissionAmount = base.estimatedCommission;
    let bestRating = base.rating;
    let bestSales = base.sales ?? 0;

    // Buscar coincidencias en el resto
    for (let j = i + 1; j < products.length; j++) {
      if (used.has(j)) continue;
      const candidate = products[j];

      // Criterio 1: sourceId idéntico (ASIN, Item ID)
      if (base.externalId && candidate.externalId && base.externalId === candidate.externalId) {
        // Mismo ID externo → mismo producto
      }
      // Criterio 2: alta similitud de título (≥ threshold)
      else if (titleSimilarity(base.title, candidate.title) >= BUILD_CONFIG.TITLE_SIMILARITY_THRESHOLD) {
        // Título muy similar → probable mismo producto
      }
      // Criterio 3: marca + modelo en título
      else if (
        base.brand &&
        candidate.brand &&
        base.brand.toLowerCase() === candidate.brand.toLowerCase() &&
        titleSimilarity(base.title, candidate.title) >= 0.6
      ) {
        // Misma marca + título parecido
      } else {
        continue;
      }

      // Agrupar
      variants.push(candidate);
      used.add(j);
      allNetworks.add(candidate._network);
      allAffiliateUrls[candidate._network] = candidate.affiliateUrl;
      allDirectUrls[candidate._network] = candidate.directUrl;
      allMerchantNames[candidate._network] = candidate.merchantName;
      allExtraImages.push(...candidate.extraImages);

      // Mejorar métricas con la mejor variante
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
      allExtraImages: [...new Set(allExtraImages)].slice(0, 10),
    });

    if (groups.length >= BUILD_CONFIG.MAX_CROSS_MERCHANT_GROUPS) break;
  }

  return groups;
}

// ─── Paso 4: Autoclasificación estricta (SOLO 8 categorías raíz fijas) ────────

async function autoCategorize(groups: CrossMerchantGroup[]): Promise<{
  categoriesCreated: number;
  subcategoriesCreated: number;
  categorizedGroups: Array<CrossMerchantGroup & { category: string; subcategory?: string }>;
}> {
  const existingCategories = getCategories();
  const rootCategories = existingCategories.filter((c) => !c.parentId);
  // NO se crean categorías automáticamente: categoriesCreated = 0, subcategoriesCreated = 0
  const categorizedGroups: Array<CrossMerchantGroup & { category: string; subcategory?: string }> = [];

  for (const group of groups) {
    // Usar suggestCategoryStrict: matching obligatorio contra las 8 categorías raíz
    const text = `${group.canonical.title} ${group.canonical.description} ${group.canonical.category}`;
    const matchedCategory = suggestCategoryStrict(text);

    let categoryName: string;
    let categoryId: string | undefined;

    if (matchedCategory) {
      categoryName = matchedCategory.name;
      categoryId = matchedCategory.id;
    } else {
      // Fallback: si no hay match, asignar a "Informática y Oficina" por defecto
      const fallback = rootCategories.find((c) => c.id === 'informatica-oficina');
      categoryName = fallback?.name ?? 'Informática y Oficina';
      categoryId = fallback?.id;
    }

    // Subcategoría: SOLO usar subcategorías YA EXISTENTES en el catálogo
    // NO se crean subcategorías automáticamente
    let subcategoryName: string | undefined;
    let subcategoryId: string | undefined;

    if (group.canonical.subCategory) {
      const parentCat = existingCategories.find((c) => c.id === categoryId) ?? rootCategories[0];
      if (parentCat) {
        const subSlug = `${parentCat.id}--${slugifyCategory(group.canonical.subCategory)}`;
        const existingSub = existingCategories.find((c) => c.slug === subSlug);
        if (existingSub) {
          subcategoryName = existingSub.name;
          subcategoryId = existingSub.id;
        }
      }
    }

    categorizedGroups.push({ ...group, category: categoryName, subcategory: subcategoryName, _categoryId: categoryId, _subcategoryId: subcategoryId });
  }

  return { categoriesCreated: 0, subcategoriesCreated: 0, categorizedGroups };
}

// ─── Paso 5: Detección ofertas estrella (HS = High Selling / Hot Selection) ─

function detectHSR(groups: Array<CrossMerchantGroup & { category: string; subcategory?: string }>): Array<CrossMerchantGroup & { category: string; subcategory?: string; isHSR: boolean; hsrScore: number }> {
  // Score HS = combinación de descuento, comisión, rating, ventas
  const scored = groups.map((group) => {
    const discount = group.bestOriginalPrice > group.bestPrice
      ? calculateDiscountPercentage(group.bestOriginalPrice, group.bestPrice)
      : 0;

    const commissionScore = Math.min(100, (group.bestCommissionRate / 20) * 100); // 20% = 100 pts
    const discountScore = Math.min(100, (discount / 50) * 100); // 50% descuento = 100 pts
    const ratingScore = (group.bestRating / 5) * 100;
    const salesScore = Math.min(100, Math.log10(1 + group.bestSales) * 20); // log scale

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

  // Ordenar por hsrScore descendente y tomar top N
  scored.sort((a, b) => b.hsrScore - a.hsrScore);
  const hsrCount = Math.min(BUILD_CONFIG.HSR_COUNT, scored.filter((g) => g.isHSR).length);
  scored.slice(0, hsrCount).forEach((g) => { g.isHSR = true; });

  return scored;
}

// ─── Paso 6: Ordenación inteligente ────────────────────────────────────────

function smartSort(groups: Array<CrossMerchantGroup & { category: string; subcategory?: string; isHSR: boolean; hsrScore: number }>): typeof groups {
  // Primero HS, luego por score de conversión (popularidad × comisión / precio)
  return groups.sort((a, b) => {
    if (a.isHSR !== b.isHSR) return a.isHSR ? -1 : 1;
    // Score de conversión: (ventas * comisión) / precio
    const scoreA = (a.bestSales * a.bestCommissionAmount) / Math.max(a.bestPrice, 1);
    const scoreB = (b.bestSales * b.bestCommissionAmount) / Math.max(b.bestPrice, 1);
    return scoreB - scoreA;
  });
}

// ─── Paso 7: Upsert masivo en products.json ────────────────────────────────

function upsertProducts(
  groups: Array<CrossMerchantGroup & { category: string; subcategory?: string; isHSR: boolean; hsrScore: number }>
): { upserted: number; updated: number; products: Product[] } {
  const existingProducts = readProductsFromFile();
  let upserted = 0;
  let updated = 0;

  for (const group of groups) {
    const canonical = group.canonical;
    const baseId = slugify(canonical.title);

    // Buscar duplicado existente en products.json
    let existingIndex = existingProducts.findIndex((p) => p.id === baseId);
    if (existingIndex === -1) {
      // Buscar por URL canónica
      existingIndex = existingProducts.findIndex((p) =>
        canonical.affiliateUrl && p.affiliateUrl &&
        p.affiliateUrl.split('?')[0] === canonical.affiliateUrl.split('?')[0]
      );
    }

    const discountPct = calculateDiscountPercentage(group.bestOriginalPrice, group.bestPrice);
    const hsrBadge = group.isHSR ? 'Oferta Estrella' : undefined;

    // Construir producto para products.json
    const categoryId = (group as any)._categoryId ?? getCategories().find((c) => c.name === group.category)?.id;
    const subcategoryId = (group as any)._subcategoryId ?? (group.subcategory
      ? getCategories().find((c) => c.name === group.subcategory && c.parentId)?.id
      : undefined);

    const product: Product = {
      id: baseId,
      title: canonical.title,
      description: canonical.description || `${canonical.brand ?? canonical.merchantName} · ${canonical.category}`,
      price: group.bestPrice,
      originalPrice: group.bestOriginalPrice > group.bestPrice ? group.bestOriginalPrice : undefined,
      image: canonical.mainImage,
      gallery: [...new Set([canonical.mainImage, ...group.allExtraImages])].filter(Boolean).slice(0, 10),
      category: group.category,
      subcategory_id: subcategoryId,
      merchant: group.allMerchantNames[group.allNetworks[0]] ?? canonical.merchantName,
      affiliateUrl: group.allAffiliateUrls[group.allNetworks[0]] ?? canonical.affiliateUrl,
      buyNowUrl: group.allDirectUrls[group.allNetworks[0]] ?? canonical.directUrl,
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
      shippingInfo: canonical.shippingInfo,
      shippingDays: canonical.shippingDays,
      freeShipping: canonical.extra?.['Envío gratis'] === true,
      sourceId: canonical.externalId,
      category_id: categoryId,
      conversion_score: group.hsrScore,
      commissionEstimate: group.bestCommissionAmount,
      sales30d: group.bestSales,
      // Cross-merchant data en extra
      extra: {
        ...canonical.extra,
        crossMerchant: {
          networks: group.allNetworks,
          affiliateUrls: group.allAffiliateUrls,
          directUrls: group.allDirectUrls,
          merchantNames: group.allMerchantNames,
          variantsCount: group.variants.length + 1,
          hsr: group.isHSR,
          hsrScore: group.hsrScore,
        },
      },
    };

    if (existingIndex >= 0) {
      existingProducts[existingIndex] = { ...existingProducts[existingIndex], ...product };
      updated++;
    } else {
      existingProducts.unshift(product);
      upserted++;
    }
  }

  writeProductsToFile(existingProducts);
  return { upserted, updated, products: existingProducts };
}

// ─── Endpoint principal ────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  if (!isValidApiToken(request)) return unauthorizedApiResponse();

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
    categoriesCreated: 0,
    subcategoriesCreated: 0,
    hsrDetected: 0,
    upserted: 0,
    updated: 0,
    errors: [],
  };

  try {
    // 1. Ingesión multi-comerciante
    const { canonicalProducts, byNetwork, networksQueried, errors: ingestErrors } = await ingestAllNetworks();
    report.networksQueried = networksQueried;
    report.productsByNetwork = byNetwork;
    report.rawTotal = canonicalProducts.length;
    report.errors.push(...ingestErrors);

    // 2. Filtro de calidad
    const qualityProducts = qualityFilter(canonicalProducts);
    report.afterQualityFilter = qualityProducts.length;

    // 3. Deduplicación cross-merchant
    const groups = deduplicateCrossMerchant(qualityProducts);
    report.crossMerchantGroups = groups.length;
    report.duplicatesResolved = qualityProducts.length - groups.length;

    // 4. Autoclasificación
    const { categoriesCreated, subcategoriesCreated, categorizedGroups } = await autoCategorize(groups);
    report.categoriesCreated = categoriesCreated;
    report.subcategoriesCreated = subcategoriesCreated;

    // 5. Detección ofertas estrella (HS)
    const withHSR = detectHSR(categorizedGroups);
    report.hsrDetected = withHSR.filter((g) => g.isHSR).length;

    // 6. Ordenación inteligente
    const sortedGroups = smartSort(withHSR);

    // 7. Upsert masivo
    const { upserted, updated } = upsertProducts(sortedGroups);
    report.upserted = upserted;
    report.updated = updated;

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