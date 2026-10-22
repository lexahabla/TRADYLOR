/**
 * ==============================================================================
 * TRADYLOR - PIPELINE · ETAPA 2: AUDITORÍA "TEST & PROOF"
 * ==============================================================================
 * Score 0-100 con 3 bloques (pesos y umbrales en config.ts, overridables por env):
 *   - Procedencia del vendedor (0-50): marketplace/red de confianza o marca de
 *     confianza. Si el dato NO viene en la fuente, el bloque no penaliza.
 *   - Reseñas (0-30): valoración + volumen (escala log). Si la fuente no trae
 *     reseñas, el bloque no penaliza.
 *   - Descuento verificado (0-20): oferta contrastada con el histórico de
 *     precio. Si la fuente no trae oferta ni histórico, el bloque no penaliza.
 *
 * `audit_reasons` contiene SÓLO defectos (no la ausencia de dato):
 *   - `rating-insuficiente` / `pocas-resenas`: el dato existe y no cumple.
 *   - `sin-descuento-verificado`: hay oferta pero el descuento no alcanza el
 *     mínimo exigido.
 *   - `precio-por-encima-del-historico`: el precio actual supera el máximo
 *     histórico ⇒ la oferta no es real.
 *   - `vendedor-no-verificado`: el vendedor existe pero no es de confianza.
 *   - `sin-datos-suficientes`: no hay evidencia suficiente para aprobar.
 *
 * Estados: `approved` (sin defectos y con evidencia), `rejected` (con defectos),
 * `pending` (sin datos para juzgar).
 * ==============================================================================
 */

import { detectNetworkId } from '../productNetwork';
import type { PipelineConfig } from './config';
import type { PipelineProduct, StageResult } from './types';

const REASON_RATING = 'rating-insuficiente';
const REASON_REVIEWS = 'pocas-resenas';
const REASON_DISCOUNT = 'sin-descuento-verificado';
const REASON_VENDOR = 'vendedor-no-verificado';
const REASON_NO_DATA = 'sin-datos-suficientes';
const REASON_PRICE_HISTORY = 'precio-por-encima-del-historico';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Resultado de un bloque de la auditoría. */
interface AuditBlock {
  /** Puntos conseguidos (0..weight). */
  points: number;
  /** Peso del bloque (0 cuando el bloque no es evaluable). */
  weight: number;
  /** `true` si la fuente traía datos para evaluar el bloque. */
  applicable: boolean;
  /** Defecto detectado (sólo si el dato existe y no cumple). */
  reason?: string;
}

/**
 * Bloque de procedencia (0-50): ¿de quién es el producto?
 * - Marketplace/red de confianza (eBay, AliExpress, Amazon…) ⇒ compra protegida.
 * - Marca de confianza (PCComponentes, MediaMarkt…) ⇒ vendedor de referencia.
 * - Sin datos de procedencia ⇒ bloque no evaluable (no penaliza).
 */
function provenanceBlock(product: PipelineProduct, config: PipelineConfig): AuditBlock {
  const network = String(detectNetworkId(product) || '').trim().toLowerCase();
  const merchant = String(product.merchant || '').trim().toLowerCase();

  const trustedNetwork = Boolean(network) && config.trustedNetworks.some((item) => network === item || network.includes(item));
  const trustedBrand = Boolean(merchant) && config.trustedMerchants.some((item) => merchant.includes(item));

  if (trustedNetwork || trustedBrand) {
    return { points: config.weightProvenance, weight: config.weightProvenance, applicable: true };
  }

  // Sin red ni comerciante: la fuente no aporta el dato (no es un defecto).
  if (!network && !merchant) {
    return { points: 0, weight: 0, applicable: false };
  }

  return { points: 0, weight: config.weightProvenance, applicable: true, reason: REASON_VENDOR };
}

/**
 * Bloque de reseñas (0-30): valoración (mitad) + volumen en escala log (mitad).
 * Si cumple los umbrales mínimos se lleva el bloque completo.
 */
function reviewsBlock(product: PipelineProduct, config: PipelineConfig): AuditBlock {
  const rating = Number(product.rating);
  const reviews = Number(product.reviewsCount);
  const hasRating = Number.isFinite(rating) && rating > 0;
  const hasReviews = Number.isFinite(reviews) && reviews > 0;

  // La fuente no trae reseñas: el bloque no penaliza.
  if (!hasRating && !hasReviews) {
    return { points: 0, weight: 0, applicable: false };
  }

  const weight = config.weightReviews;
  const half = weight / 2;
  const ratingPart = hasRating ? (Math.min(rating, 5) / 5) * half : 0;
  const reviewPart = hasReviews ? (Math.log10(1 + reviews) / Math.log10(1 + 5000)) * half : 0;

  let points = ratingPart + reviewPart;
  let reason: string | undefined;

  if (hasRating && rating < config.minRating) {
    reason = REASON_RATING;
  } else if (hasReviews && reviews < config.minReviewsCount) {
    reason = REASON_REVIEWS;
  }

  const meetsThresholds =
    hasRating && rating >= config.minRating && hasReviews && reviews >= config.minReviewsCount;
  if (meetsThresholds) points = weight;

  return { points: clamp(points, 0, weight), weight, applicable: true, reason };
}

/**
 * Bloque de descuento verificado (0-20).
 * - Oferta (originalPrice > price) con descuento ≥ mínimo y precio no por
 *   encima del máximo histórico ⇒ bloque completo.
 * - Oferta por debajo del mínimo ⇒ defecto `sin-descuento-verificado`.
 * - Precio actual por encima del máximo histórico ⇒ la oferta no es real.
 * - Sin oferta pero con histórico ⇒ el precio se puntúa frente a su propio
 *   mínimo (parcial).
 * - Sin oferta ni histórico ⇒ la fuente no aporta el dato (no penaliza).
 */
function discountBlock(product: PipelineProduct, config: PipelineConfig): AuditBlock {
  const weight = config.weightDiscount;
  const price = Number(product.price) || 0;
  const original = Number(product.originalPrice) || 0;

  const history = Array.isArray(product.priceHistory) ? product.priceHistory : [];
  const historyPrices = history
    .map((point) => Number(point?.price))
    .filter((value) => Number.isFinite(value) && value > 0);
  const maxHistory = historyPrices.length ? Math.max(...historyPrices) : 0;
  const minHistory = historyPrices.length ? Math.min(...historyPrices) : 0;

  // El precio actual supera cualquier precio histórico: la oferta no es real.
  if (maxHistory > 0 && price > maxHistory) {
    return { points: 0, weight, applicable: true, reason: REASON_PRICE_HISTORY };
  }

  if (price > 0 && original > price) {
    const discountPercent = ((original - price) / original) * 100;
    if (discountPercent >= config.minDiscountPercent) {
      return { points: weight, weight, applicable: true };
    }
    const ratio = clamp(discountPercent / Math.max(config.minDiscountPercent, 1), 0, 1);
    return {
      points: Math.round(weight * ratio * 0.5),
      weight,
      applicable: true,
      reason: REASON_DISCOUNT,
    };
  }

  // Sin oferta publicada: se contrasta el precio con su propio histórico.
  if (historyPrices.length) {
    if (minHistory > 0 && price <= minHistory) {
      return { points: Math.round(weight * 0.6), weight, applicable: true };
    }
    return { points: Math.round(weight * 0.3), weight, applicable: true };
  }

  return { points: 0, weight: 0, applicable: false };
}

/**
 * Ejecuta la Etapa 2 y estampa `audit_status`, `audit_score` y `audit_reasons`.
 * Nunca falla: un producto sin datos queda como `pending` con su motivo.
 */
export function runStageAudit(product: PipelineProduct, config: PipelineConfig): StageResult {
  const provenance = provenanceBlock(product, config);
  const reviews = reviewsBlock(product, config);
  const discount = discountBlock(product, config);

  const reasons: string[] = [];
  if (provenance.reason) reasons.push(provenance.reason);
  if (reviews.reason) reasons.push(reviews.reason);
  if (discount.reason) reasons.push(discount.reason);

  const blocks = [provenance, reviews, discount];
  const score = clamp(Math.round(blocks.reduce((sum, block) => sum + block.points, 0)), 0, 100);
  const hasEvidence = blocks.some((block) => block.applicable && block.points > 0);
  const provenanceVerified = provenance.points >= config.weightProvenance;

  let status: 'approved' | 'rejected' | 'pending';
  if (reasons.length > 0) {
    status = 'rejected';
  } else if (hasEvidence && (score >= config.minAuditScore || provenanceVerified)) {
    status = 'approved';
  } else {
    status = 'pending';
    reasons.push(REASON_NO_DATA);
  }

  const audited: PipelineProduct = {
    ...product,
    audit_score: score,
    audit_status: status,
    audit_reasons: reasons,
  };

  return {
    ok: true,
    stage: 'audit',
    product: audited,
    audit_status: audited.audit_status,
    audit_score: audited.audit_score,
  };
}
