/**
 * ==============================================================================
 * TRADYLOR - MOTOR DEL ÍNDICE DE OPORTUNIDAD (Curation Engine)
 * ==============================================================================
 * Puntúa cada producto del catálogo de 0 a 100 cruzando cuatro señales:
 *
 *   1. COMISIÓN ESTIMADA (40%)
 *      Comisión % implícita según la red de origen (merchant) × precio.
 *   2. MARGEN / AGRESIVIDAD DE PRECIO (25%)
 *      Descuento real frente al precio original tachado.
 *   3. POPULARIDAD (25%)
 *      Valoración media y volumen de opiniones (escala logarítmica).
 *   4. CALIDAD EDITORIAL (10%)
 *      Completitud de la ficha: descripción, veredicto, pros y contras.
 *
 * Todo queda desglosado en `breakdown` para que el panel muestre el "por qué"
 * de cada puntuación y la selección sea auditable.
 * ==============================================================================
 */

import { getCatalogProducts } from './catalog';
import type { Product } from '../data/products';

/** Tasas de comisión estimadas por red de origen (ordenadas, primera coincidencia gana). */
const NETWORK_COMMISSION_RATES: Array<{ match: RegExp; rate: number }> = [
  { match: /amazon/i, rate: 3 },
  { match: /aliexpress/i, rate: 7 },
  { match: /ebay/i, rate: 3.5 },
  { match: /awin/i, rate: 6 },
  { match: /cj\b/i, rate: 5.5 },
  { match: /admitad/i, rate: 6 },
  { match: /tradedoubler|metapic/i, rate: 6.5 },
  { match: /kwanko/i, rate: 6 },
  { match: /etsy/i, rate: 4 },
  { match: /webgains/i, rate: 6 },
  { match: /partnerize/i, rate: 5.5 },
  { match: /rakuten/i, rate: 4.5 },
];

const DEFAULT_COMMISSION_RATE = 5;

export function getNetworkCommissionRate(merchant: string): number {
  const found = NETWORK_COMMISSION_RATES.find((entry) => entry.match.test(merchant));
  return found ? found.rate : DEFAULT_COMMISSION_RATE;
}

export interface OpportunityBreakdown {
  commission: number;   // 0-40
  priceMargin: number;  // 0-25
  popularity: number;   // 0-25
  editorial: number;    // 0-10
}

export interface ScoredProduct {
  product: Product;
  score: number;
  tier: 'top' | 'alta' | 'media' | 'baja';
  breakdown: OpportunityBreakdown;
  signals: {
    commissionRate: number;
    commissionAmount: number;
    discountPercent: number | null;
    rating: number | null;
    reviewsCount: number | null;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Calcula el Índice de Oportunidad (0-100) de un producto. */
export function scoreProduct(product: Product): ScoredProduct {
  // 1. Comisión estimada (40%): tasa implícita de la red ponderada por precio.
  const commissionRate = getNetworkCommissionRate(product.merchant);
  const commissionAmount = round1(product.price * (commissionRate / 100));
  const commissionScore = 40 * (commissionRate / 10) * (0.6 + 0.4 * clamp(product.price / 300, 0, 1));

  // 2. Margen de precio (25%): descuento real; tope comercial en 50%.
  const discountPercent = product.originalPrice && product.originalPrice > product.price
    ? Math.round(((product.originalPrice - product.price) / product.originalPrice) * 100)
    : null;
  const priceScore = discountPercent != null ? 25 * clamp(discountPercent / 50, 0, 1) : 5;

  // 3. Popularidad (25%): rating (60%) + volumen de reseñas logarítmico (40%).
  const rating = product.rating ?? null;
  const reviewsCount = product.reviewsCount ?? null;
  const ratingScore = rating != null ? clamp((rating / 5) * 15, 0, 15) : 6;
  const reviewsScore = reviewsCount != null
    ? clamp((Math.log10(Math.max(reviewsCount, 1)) / Math.log10(10000)) * 10, 0, 10)
    : 4;
  const popularityScore = ratingScore + reviewsScore;

  // 4. Calidad editorial (10%): ficha completa convierte mejor.
  let editorialScore = 0;
  if (product.description && product.description.length > 60) editorialScore += 3;
  if (product.verdict) editorialScore += 3;
  if (product.pros.length > 0) editorialScore += 2;
  if (product.cons.length > 0) editorialScore += 2;

  const score = Math.round(clamp(commissionScore + priceScore + popularityScore + editorialScore, 0, 100));

  return {
    product,
    score,
    tier: score >= 75 ? 'top' : score >= 55 ? 'alta' : score >= 35 ? 'media' : 'baja',
    breakdown: {
      commission: round1(commissionScore),
      priceMargin: round1(priceScore),
      popularity: round1(popularityScore),
      editorial: round1(editorialScore),
    },
    signals: {
      commissionRate,
      commissionAmount,
      discountPercent,
      rating,
      reviewsCount,
    },
  };
}

/** Catálogo completo puntuado y ordenado por Índice de Oportunidad descendente. */
export function getScoredCatalog(): ScoredProduct[] {
  return getCatalogProducts()
    .map(scoreProduct)
    .sort((a, b) => b.score - a.score);
}
