/**
 * ==============================================================================
 * TRADYLOR — PRODUCT VALIDATION (Zod Runtime)
 * ==============================================================================
 *
 * Validates raw product data from JSON/TS against the Zod schema.
 * Applies defaults for missing fields and logs validation errors
 * without crashing the build (graceful degradation).
 *
 * Usage:
 *   import { validateProducts, validateSingleProduct } from '@/lib/validateProducts';
 *   const valid = validateProducts(rawArray);  // returns Product[]
 *   const one = validateSingleProduct(rawObj); // returns Product | null
 * ==============================================================================
 */

import { z } from 'zod';
import { productSchema, type Product } from '../content.config';
import { toStructuredProduct, type Product as FlatProduct } from '../data/products';

/**
 * Detects whether a raw product already follows the nested Zod shape
 * (pricing / affiliate / conversionHooks objects). Flat admin or
 * products.json entries return false and get expanded before parsing.
 */
function isStructuredShape(raw: unknown): raw is Product {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    !!r.pricing &&
    typeof r.pricing === 'object' &&
    !!r.affiliate &&
    typeof r.affiliate === 'object'
  );
}

/**
 * Normalizes unknown input into the nested schema shape.
 * Flat products are expanded via toStructuredProduct(); already-structured
 * products are passed through untouched.
 */
function toSchemaShape(raw: unknown): unknown {
  if (isStructuredShape(raw)) return raw;
  if (!raw || typeof raw !== 'object') return raw;
  return toStructuredProduct(raw as FlatProduct);
}

/**
 * Validates an array of raw product objects against the Zod schema.
 * Returns only valid products; logs warnings for invalid ones.
 */
export function validateProducts(rawProducts: unknown[]): FlatProduct[] {
  const validProducts: FlatProduct[] = [];
  const errors: string[] = [];

  for (let i = 0; i < rawProducts.length; i++) {
    const raw = rawProducts[i];
    const result = validateSingleProduct(raw);
    if (result) {
      validProducts.push(result);
    } else {
      errors.push(`Product at index ${i} failed validation`);
    }
  }

  if (errors.length > 0) {
    console.warn(`[ValidateProducts] ${errors.length} product(s) skipped:`);
    errors.forEach((e) => console.warn(`  - ${e}`));
  }

  return validProducts;
}

/**
 * Validates a single raw product object against the Zod schema.
 * Returns a normalized Product or null if validation fails.
 */
export function validateSingleProduct(raw: unknown): FlatProduct | null {
  try {
    const parsed = productSchema.parse(toSchemaShape(raw));
    return normalizeToProduct(parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      console.warn(`[ValidateProducts] Validation error: ${issues}`);
    } else {
      console.warn(`[ValidateProducts] Unexpected error:`, err);
    }
    return null;
  }
}

/**
 * Safely validates without throwing — returns { success, data, errors }.
 */
export function safeValidate(raw: unknown) {
  return productSchema.safeParse(raw);
}

/**
 * Converts a validated Product schema into the flat Product interface
 * used by existing components (ProductCard, ComparisonTable, etc.).
 */
function normalizeToProduct(schema: Product): FlatProduct {
  return {
    id: schema.id,
    slug: schema.slug,
    title: schema.title,
    description: schema.description ?? '',
    specs: schema.specs,
    fulfillmentProvider: schema.fulfillmentProvider,
    shippingInfo: schema.shippingInfo,
    shippingDays: schema.shippingDays,
    freeShipping: schema.freeShipping,
    price: schema.pricing.currentPrice,
    originalPrice: schema.pricing.originalPrice,
    image: schema.image,
    gallery: schema.gallery,
    category: schema.category,
    merchant: schema.affiliate.primaryStore,
    affiliateUrl: schema.affiliate.primaryUrl,
    buyNowUrl: schema.affiliate.buyNowUrl,
    asin: schema.affiliate.asin,
    pros: schema.investigation.pros,
    cons: schema.investigation.cons,
    badge: schema.badge ?? schema.awardBadge,
    techSheet: schema.techSheet,
    priceHistory: schema.priceHistory,
    rating: schema.conversionHooks.rating,
    reviewsCount: schema.conversionHooks.totalReviewsCount,
    verdict: schema.verdict,

    // Preserve structured fields for advanced rendering
    awardBadge: schema.awardBadge,
    productType: schema.productType,
    brand: schema.brand,
    condition: schema.condition,
    model: schema.model,
    pricing: {
      currentPrice: schema.pricing.currentPrice,
      originalPrice: schema.pricing.originalPrice,
      discountPercentage: schema.pricing.discountPercentage,
      priceLastChecked: schema.pricing.priceLastChecked,
      freeShipping: schema.pricing.freeShipping,
      stockStatus: schema.pricing.stockStatus,
    },
    conversionHooks: {
      idealFor: schema.conversionHooks.idealFor,
      notRecommendedFor: schema.conversionHooks.notRecommendedFor,
      returnPolicyDays: schema.conversionHooks.returnPolicyDays,
      rating: schema.conversionHooks.rating,
      totalReviewsCount: schema.conversionHooks.totalReviewsCount,
      satisfactionScore: {
        positivePercentage: schema.conversionHooks.satisfactionScore.positivePercentage,
        negativePercentage: schema.conversionHooks.satisfactionScore.negativePercentage,
      },
    },
    investigation: {
      hoursInvestigated: schema.investigation.hoursInvestigated,
      modelsCompared: schema.investigation.modelsCompared,
      hiddenDrawbacks: schema.investigation.hiddenDrawbacks,
      pros: schema.investigation.pros,
      cons: schema.investigation.cons,
    },
    affiliate: {
      primaryStore: schema.affiliate.primaryStore,
      primaryUrl: schema.affiliate.primaryUrl,
      buyNowUrl: schema.affiliate.buyNowUrl,
      alternativeStore: schema.affiliate.alternativeStore,
      alternativeUrl: schema.affiliate.alternativeUrl,
    },
    alternatives: schema.alternatives,
    sourceId: schema.sourceId,
    category_id: schema.category_id,
    subcategory_id: schema.subcategory_id,
    ia_status: schema.ia_status,
    link_status: schema.link_status,
    normalized_tags: schema.normalized_tags,
    alternative_product_ids: schema.alternative_product_ids,
    conversion_score: schema.conversion_score,
    audit_status: schema.audit_status,
    audit_score: schema.audit_score,
    audit_reasons: schema.audit_reasons,
    pipeline_version: schema.pipeline_version,
    pipeline_run_at: schema.pipeline_run_at,
    ai_enriched: schema.ai_enriched,
    ai_error: schema.ai_error,
    title_short: schema.title_short,
    network: schema.network,
    currency: schema.currency,
    commissionRate: schema.commissionRate,
    commissionEstimate: schema.commissionEstimate,
    inStock: schema.inStock,
    visits: schema.visits,
    extra: schema.extra,
  };
}
