/**
 * ==============================================================================
 * TRADYLOR - PIPELINE · ETAPA 2: AUDITORÍA "TEST & PROOF"
 * ==============================================================================
 * Score 0-100 con 3 bloques (umbrales en config.ts, overridables por env):
 *   - Descuento/histórico (0-40)
 *   - Fiabilidad del vendedor (0-30)
 *   - Reseñas (0-30)
 *
 * `audit_score >= minAuditScore` ⇒ `audit_status='approved'`; si no ⇒
 * `'rejected'` + `audit_reasons[]`.
 * ==============================================================================
 */

import type { PipelineConfig } from './config';
import type { PipelineProduct, StageResult } from './types';

const REASON_RATING = 'rating-insuficiente';
const REASON_REVIEWS = 'pocas-resenas';
const REASON_DISCOUNT = 'sin-descuento-verificado';
const REASON_VENDOR = 'vendedor-no-verificado';
const REASON_NO_DATA = 'sin-datos-suficientes';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Score del bloque de descuento verificado contra el histórico (0-40). */
function discountScore(product: PipelineProduct, config: PipelineConfig): number {
  const price = Number(product.price) || 0;
  const original = Number(product.originalPrice) || 0;
  if (price <= 0 || original <= price) return 0;

  const discountPercent = ((original - price) / original) * 100;
  if (discountPercent < config.minDiscountPercent) return 0;

  // Verificación contra el histórico: si hay puntos, el precio de oferta no debe
  // superar el máximo histórico (si lo supera, el "descuento" no es real).
  const history = Array.isArray(product.priceHistory) ? product.priceHistory : [];
  if (history.length) {
    const maxHistory = Math.max(...history.map((point) => Number(point?.price)).filter((value) => Number.isFinite(value)));
    if (Number.isFinite(maxHistory) && price > maxHistory) return 0;
  }

  return 40;
}

/** Score del bloque de vendedor/marketplace de confianza (0-30). */
function vendorScore(product: PipelineProduct, config: PipelineConfig): number {
  const haystack = `${product.merchant || ''} ${product.fulfillmentProvider || ''}`.toLowerCase();
  if (!haystack.trim()) return 0;
  const trusted = config.trustedMerchants.some((merchant) => haystack.includes(merchant));
  return trusted ? 30 : 0;
}

/** Score del bloque de reseñas (0-30): valoración (15) + volumen en escala log (15). */
function reviewScore(product: PipelineProduct, config: PipelineConfig): number {
  const rating = Number(product.rating);
  const reviews = Number(product.reviewsCount);
  const hasRating = Number.isFinite(rating) && rating > 0;
  const hasReviews = Number.isFinite(reviews) && reviews > 0;
  if (!hasRating && !hasReviews) return 0;

  const ratingPart = hasRating ? clamp((rating / 5) * 15, 0, 15) : 0;
  const reviewPart = hasReviews
    ? clamp((Math.log10(1 + reviews) / Math.log10(1 + 5000)) * 15, 0, 15)
    : 0;

  // Bonus cuando se cumplen los umbrales mínimos de calidad.
  const meetsThresholds = hasRating && rating >= config.minRating && hasReviews && reviews >= config.minReviewsCount;
  const base = ratingPart + reviewPart;
  return meetsThresholds ? Math.max(base, 30) : base;
}

/**
 * Ejecuta la Etapa 2 y estampa `audit_status`, `audit_score` y `audit_reasons`.
 * Nunca falla: un producto sin datos queda como `rejected` con motivos.
 */
export function runStageAudit(product: PipelineProduct, config: PipelineConfig): StageResult {
  const reasons: string[] = [];

  const discount = discountScore(product, config);
  if (discount === 0) reasons.push(REASON_DISCOUNT);

  const vendor = vendorScore(product, config);
  if (vendor === 0) reasons.push(REASON_VENDOR);

  const rating = Number(product.rating);
  const reviews = Number(product.reviewsCount);
  if ((!Number.isFinite(rating) || rating <= 0) && (!Number.isFinite(reviews) || reviews <= 0)) {
    reasons.push(REASON_NO_DATA);
  } else {
    if (!Number.isFinite(rating) || rating < config.minRating) reasons.push(REASON_RATING);
    if (!Number.isFinite(reviews) || reviews < config.minReviewsCount) reasons.push(REASON_REVIEWS);
  }

  const review = reviewScore(product, config);
  const score = clamp(Math.round(discount + vendor + review), 0, 100);

  const audited: PipelineProduct = {
    ...product,
    audit_score: score,
    audit_status: score >= config.minAuditScore ? 'approved' : 'rejected',
    audit_reasons: reasons,
  };

  return {
    ok: true,
    stage: 'audit',
    product: audited,
    audit_status: audited.audit_status,
    audit_score: score,
  };
}
