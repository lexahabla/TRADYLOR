/**
 * ==============================================================================
 * TREIDILOR — INDICADOR DE SATISFACCIÓN (lógica compartida tarjeta ↔ comparativa)
 * ==============================================================================
 * Antes vivía dentro de ProductCard.astro. Ahora la tarjeta y la comparativa de modelos usan ESTA función, así que dan siempre el mismo
 * porcentaje para el mismo producto.
 *
 * Es un indicador ORIENTATIVO de Treidilor (no un porcentaje de compradores satisfechos): pondera los factores con datos disponibles
 *   0,40 pros y contras de la ficha · 0,25 valoración (estrellas y nº de opiniones) · 0,20 precio frente al precio de referencia
 *   · 0,15 volumen de opiniones (escala logarítmica; el nº de opiniones NO demuestra ventas)
 * y renormaliza los pesos presentes. Sin ningún factor usa `conversionHooks.satisfactionScore.positivePercentage` o 85.
 *
 * Novedad: la valoración y el recuento que entran son los SUSTENTADOS (`ratingSupport`): los valores por defecto del alta (4,8 ★/100,
 * eBay 4,5 ★/15, los 100 de AliExpress) ya no influyen.
 * ==============================================================================
 */

import { ratingSupport } from './commercialClaims';

type Any = Record<string, any>;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export const SATISFACTION_NOTE =
  'Indicador orientativo de Treidilor, calculado con pros y contras, valoración y precio. No es un porcentaje de compradores satisfechos ni mide ventas.';

export function satisfactionPercent(product: Any | null | undefined): number {
  const pros = Array.isArray(product?.pros) ? product!.pros.length : 0;
  const cons = Array.isArray(product?.cons) ? product!.cons.length : 0;
  const factors: Array<{ weight: number; score: number }> = [];

  if (pros + cons > 0) factors.push({ weight: 0.4, score: pros / (pros + cons) });

  const support = ratingSupport(product ?? {});
  const rating = support.rating ?? 0;
  const reviews = support.count ?? 0;
  if (rating > 0 || reviews > 0) {
    const stars = rating > 0 ? clamp01(rating / 5) : 0.75;
    const reviewScore = reviews > 0 ? clamp01(Math.log10(reviews + 1) / 4) : 0.5;
    factors.push({ weight: 0.25, score: stars * 0.7 + reviewScore * 0.3 });
  }

  const price = Number(product?.price) || 0;
  const original = Number(product?.originalPrice) || 0;
  if (price > 0) {
    const discountRatio = original > price ? clamp01((original - price) / original) : 0;
    factors.push({ weight: 0.2, score: 0.6 + discountRatio * 0.4 });
  }

  if (reviews > 0) factors.push({ weight: 0.15, score: clamp01(Math.log10(reviews + 1) / 4) });

  const total = factors.reduce((acc, f) => acc + f.weight, 0);
  if (total > 0) return Math.round((factors.reduce((acc, f) => acc + f.weight * f.score, 0) / total) * 100);
  return Math.round(product?.conversionHooks?.satisfactionScore?.positivePercentage ?? 85);
}
