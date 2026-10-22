/**
 * ==============================================================================
 * TRADYLOR - ESTRATEGIA DE CONTENIDO Y AFILIACIÃ“N
 * ==============================================================================
 *
 * 1. PROPÃ“SITO DEL PORTAL:
 *    Tradylor actÃºa como un motor de curaciÃ³n y recomendaciÃ³n imparcial de productos
 *    de alta conversiÃ³n. Filtramos el ruido publicitario del mercado mediante
 *    evaluaciones tÃ©cnicas, anÃ¡lisis de valor por euro y comparativas directas.
 *    Monetizamos a travÃ©s de enlaces de afiliaciÃ³n regulados (Amazon Associates,
 *    Awin, CJ Affiliate, etc.) garantizando una experiencia de usuario transparente.
 *
 * 2. DIRECTRICES EDITORIALES Y DE CONVERSIÃ“N (CRO):
 *    - Fichas estructuradas: Pros, Contras y Veredicto claro antes del pliegue (above-the-fold).
 *    - IntenciÃ³n de bÃºsqueda transaccional: ArtÃ­culos "Los mejores X de [aÃ±o]" y comparativas "A vs B".
 *    - Enlaces salientes 100% seguros y transparentes segÃºn directrices de Google:
 *      target="_blank" rel="nofollow noopener sponsored"
 *    - Cumplimiento estricto con normativas de la FTC y legislaciÃ³n europea sobre
 *      declaraciÃ³n de afiliaciÃ³n y transparencia publicitaria.
 * ==============================================================================
 */

import type { Product as ProductSchema } from '../content/config';

// â”€â”€â”€ Flat Product Interface (backward-compatible with products.json) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export interface Product {
  id: string;
  slug?: string;
  title: string;
  description: string;
  price: number;
  originalPrice?: number;
  image: string;
  /** GalerÃ­a de imÃ¡genes del producto (la primera suele ser la principal). */
  gallery?: string[];
  category: string;
  merchant: string;
  affiliateUrl: string;
  buyNowUrl?: string;
  /** Red de afiliados a la que pertenece el producto (amazon, aliexpress, ebay.). */
  network?: string;
  /** Datos extra del catálogo multi-red (incluye `crossMerchant.networks`). */
  extra?: Record<string, unknown>;
  /** Código ASIN de Amazon (se autodetecta al pegar el enlace de afiliado). */
  asin?: string;
  pros: string[];
  cons: string[];
  badge?: string;
  rating?: number;
  reviewsCount?: number;
  verdict?: string;
  specs?: Record<string, string>;
  /** Texto de ficha técnica (consulta en la página del producto). */
  techSheet?: string;
  fulfillmentProvider?: string;
  /** Texto de envío mostrado en checkout y ficha (ej: "Envío en 15 días"). */
  shippingInfo?: string;
  /** Días estimados de envío (entero; se usa para filtros y estimaciones). */
  shippingDays?: number;
  /** Envío gratis confirmado en la ficha del comerciante. */
  freeShipping?: boolean;
  /** Histórico de precio (1 punto por día; se completa con cada visita). */
  priceHistory?: { date: string; price: number }[];

  // â”€â”€â”€ New structured fields (optional for backward compat) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  awardBadge?: string;
  productType?: 'Laptop' | 'Tablet' | 'Smartphone' | 'Smartwatch' | 'Auriculares' | 'Monitor' | 'ElectrodomÃ©stico' | 'Otros';
  brand?: string;
  model?: string;
  pricing?: {
    currentPrice: number;
    originalPrice?: number;
    discountPercentage?: number;
    priceLastChecked: string;
    freeShipping: boolean;
    stockStatus: 'En stock' | 'Pocas unidades' | 'Agotado';
  };
  conversionHooks?: {
    idealFor?: string;
    notRecommendedFor?: string;
    returnPolicyDays: number;
    rating: number;
    totalReviewsCount: number;
    satisfactionScore?: {
      positivePercentage: number;
      negativePercentage: number;
    };
  };
  investigation?: {
    hoursInvestigated: number;
    modelsCompared: number;
    hiddenDrawbacks: string[];
    pros: string[];
    cons: string[];
  };
  affiliate?: {
    primaryStore: string;
    primaryUrl: string;
    buyNowUrl?: string;
    alternativeStore?: string;
    alternativeUrl?: string;
  };
  alternatives?: {
    cheaperOptionId?: string;
    premiumOptionId?: string;
    similarOptionId?: string;
    cheaperOptionIds?: string[];
    similarOptionIds?: string[];
  };

  // ─── Curación avanzada (opcionales; retrocompatibles con products.json) ────
  /** ID externo del producto (ASIN / Item ID de AliExpress). */
  sourceId?: string;
  /** ID de la categoría padre (catálogo jerárquico). */
  category_id?: string;
  /** ID de la subcategoría (categoría-hija con parentId). */
  subcategory_id?: string;
  /** Estado del enriquecimiento con IA: pending | completed | error. */
  ia_status?: string;
  /** Estado del enlace de afiliación: active | pending | broken. */
  link_status?: string;
  /** Tags técnicos normalizados (matriz de atributos). */
  normalized_tags?: string[];
  /** Alternativas vinculadas (cross-matching bidireccional). */
  alternative_product_ids?: string[];
  /** Puntuación de conversión/rentabilidad 0-100. */
  conversion_score?: number;
  /** Comisión estimada de la red de afiliados (%). */
  commissionEstimate?: number;
  /** Ventas estimadas en los últimos 30 días. */
  sales30d?: number;

  /** Estado de auditoría del producto: approved | rejected | pending. */
  audit_status?: 'approved' | 'rejected' | 'pending';
  /** Puntuación de auditoría 0-100 (Etapa 2 del pipeline). */
  audit_score?: number;
  /** Motivos de rechazo de la auditoría (códigos; Etapa 2 del pipeline). */
  audit_reasons?: string[];
  /** Versión del pipeline que lastró por última vez el producto. */
  pipeline_version?: number;
  /** Timestamp ISO de la última ejecución del pipeline sobre el producto. */
  pipeline_run_at?: string;
  /** `true` si la IA de texto enriquecido la ficha (Etapa 3 del pipeline). */
  ai_enriched?: boolean;
  /** Motivo por el que la IA de texto no pudo enriquecer la ficha. */
  ai_error?: string;
  /** Métricas del vendedor y calidad de reseñas. */
  metrics?: {
    sellerRating?: number;
    sellerReviews?: number;
    qualityScore?: number;
    verified?: boolean;
    priceStability?: 'stable' | 'rising' | 'falling' | 'volatile';
  };
}

// â”€â”€â”€ Type guard: checks if a Product has the new structured fields â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function hasStructuredFields(product: Product): boolean {
  return (
    product.pricing !== undefined &&
    product.conversionHooks !== undefined &&
    product.investigation !== undefined &&
    product.affiliate !== undefined
  );
}

// â”€â”€â”€ Migration helper: converts flat Product to structured Product â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function toStructuredProduct(flat: Product): ProductSchema {
  return {
    id: flat.id,
    slug: flat.slug,
    title: flat.title,
    description: flat.description ?? '',
    specs: flat.specs,
    fulfillmentProvider: flat.fulfillmentProvider,
    shippingInfo: flat.shippingInfo,
    shippingDays: flat.shippingDays,
    freeShipping: flat.freeShipping,
    category: flat.category ?? 'General',
    productType: (flat.productType as ProductSchema['productType']) ?? 'Otros',
    brand: flat.brand ?? '',
    model: flat.model ?? flat.title,
    awardBadge: flat.awardBadge ?? flat.badge,
    pricing: {
      currentPrice: flat.price,
      originalPrice: flat.originalPrice,
      discountPercentage: flat.originalPrice
        ? Math.round(((flat.originalPrice - flat.price) / flat.originalPrice) * 100)
        : undefined,
      priceLastChecked: new Date().toISOString().split('T')[0],
      freeShipping: false,
      stockStatus: 'En stock',
    },
    conversionHooks: {
      idealFor: flat.conversionHooks?.idealFor,
      notRecommendedFor: flat.conversionHooks?.notRecommendedFor,
      returnPolicyDays: flat.conversionHooks?.returnPolicyDays ?? 30,
      rating: flat.conversionHooks?.rating ?? flat.rating ?? 4.5,
      totalReviewsCount: flat.conversionHooks?.totalReviewsCount ?? flat.reviewsCount ?? 0,
      satisfactionScore: flat.conversionHooks?.satisfactionScore ?? {
        positivePercentage: 85,
        negativePercentage: 15,
      },
    },
    investigation: {
      hoursInvestigated: 10,
      modelsCompared: 5,
      hiddenDrawbacks: [],
      pros: flat.pros ?? [],
      cons: flat.cons ?? [],
    },
    affiliate: {
      primaryStore: flat.merchant ?? 'Amazon',
      primaryUrl: flat.affiliateUrl,
      buyNowUrl: flat.buyNowUrl,
      asin: flat.asin,
      alternativeStore: undefined,
      alternativeUrl: undefined,
    },
    alternatives: flat.alternatives,
    sourceId: flat.sourceId,
    category_id: flat.category_id,
    subcategory_id: flat.subcategory_id,
    ia_status: flat.ia_status,
    link_status: flat.link_status,
    normalized_tags: flat.normalized_tags,
    alternative_product_ids: flat.alternative_product_ids,
    conversion_score: flat.conversion_score,
    audit_status: flat.audit_status,
    audit_score: flat.audit_score,
    audit_reasons: flat.audit_reasons,
    pipeline_version: flat.pipeline_version,
    pipeline_run_at: flat.pipeline_run_at,
    ai_enriched: flat.ai_enriched,
    ai_error: flat.ai_error,
    image: flat.image,
    gallery: flat.gallery,
    badge: flat.badge,
    verdict: flat.verdict,
    techSheet: flat.techSheet,
    priceHistory: flat.priceHistory,
  };
}

// â”€â”€â”€ Static product data (curated editorial entries) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const products: Product[] = [];
