/**
 * ==============================================================================
 * TREIDILOR — AFIRMACIONES DE TEXTO GENERADO (capa de LECTURA, no escribe nada)
 * ==============================================================================
 * Las ventajas, desventajas, veredicto y descripción pueden venir de una IA que inventa cifras. Antes de mostrarlas en la ficha se descarta
 * (por frase o por elemento) lo que NO se puede respaldar con los datos de la ficha:
 *   R1  recuentos de reseñas/opiniones y «basada en N …» (el recuento real, si existe, se muestra aparte con su procedencia);
 *   R2  porcentajes de descuento/ahorro (sólo vale el descuento verificado, que la ficha ya muestra por su cuenta);
 *   R3  porcentajes de satisfacción/recomendación;
 *   R4  referencias a análisis, pruebas o laboratorios propios (no existen);
 *   R5  datos internos (comisión, afiliado);
 *   R6  rendimiento con cifras (horas, dB, W, mAh…) que NO aparecen en el título ni en las especificaciones.
 * Se respeta la edición manual: si `extra.fieldSources.<campo>` es «manual», el texto no se toca. El producto original no se muta.
 * ==============================================================================
 */

type Any = Record<string, any>;

export const CLAIM_RULES = {
  reviews: /\b\d[\d.,]*\s*(rese[nñ]as|opiniones|valoraciones|reviews|ratings|compradores|clientes|usuarios)\b|basad[ao]s?\s+en\s+\d|valoraci[oó]n media/i,
  discount: /descuento\s+(notable|significativo|importante|considerable|sustancial)|rebajado\s+respecto|(descuento|ahorro|rebaja|oferta|reducci[oó]n)[^.]{0,60}\d+(?:[.,]\d+)?\s*%|\d+(?:[.,]\d+)?\s*%[^.]{0,40}(descuento|ahorro|rebaja|menos que|respecto al precio|frente al precio)/i,
  satisfaction: /\d+(?:[.,]\d+)?\s*%\s*(de\s+)?(los\s+)?(satisf|compradores|clientes|usuarios|recomiend)/i,
  ownAnalysis: /nuestr[oa]s?\s+(an[aá]lisis|pruebas?|tests?|laboratorio|equipo de pruebas)|hemos\s+(probado|testado|analizado)|laboratorio|pruebas independientes|an[aá]lisis independiente/i,
  internal: /comisi[oó]n|afiliad|\bepn\b|\bcpa\b/i,
} as const;

const PERFORMANCE = /(\d+(?:[.,]\d+)?)\s*(h\b|horas?|db\b|w\b|wh\b|mah|km\/h|hz|lm\b|fps|mp\b|minutos)/gi;

const norm = (t: unknown) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function evidenceText(product: Any): string {
  const specs = product?.specs && typeof product.specs === 'object' ? Object.entries(product.specs).map(([k, v]) => `${k} ${v}`).join(' ') : '';
  return norm(`${product?.title ?? ''} ${product?.brand ?? ''} ${specs}`);
}

/** ¿Por qué regla se descarta este texto? (null = se conserva). Exportado para pruebas y documentación. */
export function claimProblem(text: string, evidence: string, opts: { checkPerformance?: boolean } = {}): string | null {
  const t = String(text ?? '');
  if (CLAIM_RULES.reviews.test(t)) return 'recuento_resenas_sin_respaldo';
  if (CLAIM_RULES.discount.test(t)) return 'descuento_no_verificado';
  if (CLAIM_RULES.satisfaction.test(t)) return 'porcentaje_satisfaccion_inventado';
  if (CLAIM_RULES.ownAnalysis.test(t)) return 'analisis_inexistente';
  if (CLAIM_RULES.internal.test(t)) return 'dato_interno';
  if (opts.checkPerformance) {
    for (const m of t.matchAll(PERFORMANCE)) {
      const num = m[1].replace(',', '.');
      const bare = num.replace(/\.0+$/, '');
      const ev = evidence;
      if (!(ev.includes(num) || ev.includes(bare) || ev.includes(num.replace('.', ',')))) return 'rendimiento_sin_evidencia';
    }
  }
  return null;
}

const isManual = (product: Any, field: string) => String(product?.extra?.fieldSources?.[field] ?? '').includes('manual');

function sentences(text: string): string[] {
  return String(text ?? '').split(/(?<=[.!?])\s+/).filter(Boolean);
}

/** Texto largo: descarta SOLO las frases problemáticas. */
export function cleanProse(text: string, evidence: string, opts: { checkPerformance?: boolean } = {}): string {
  return sentences(text).filter((s) => !claimProblem(s, evidence, opts)).join(' ').trim();
}

export interface PublicText {
  pros: string[];
  cons: string[];
  verdict: string;
  description: string;
  /** Qué se descartó y por qué (no se publica; sirve para auditar). */
  removed: Array<{ field: string; text: string; reason: string }>;
}

export function publicText(product: Any): PublicText {
  const evidence = evidenceText(product);
  const removed: PublicText['removed'] = [];
  const items = (field: 'pros' | 'cons') => {
    const list: string[] = Array.isArray(product?.[field]) ? product[field] : [];
    if (isManual(product, field)) return list;
    return list.filter((it) => {
      const reason = claimProblem(it, evidence, { checkPerformance: true });
      if (reason) removed.push({ field, text: it, reason });
      return !reason;
    });
  };
  const prose = (field: 'verdict' | 'description', performance: boolean) => {
    const text = String(product?.[field] ?? '');
    if (!text || isManual(product, field)) return text;
    const kept = cleanProse(text, evidence, { checkPerformance: performance });
    if (kept !== text.trim()) {
      for (const s of sentences(text)) {
        const reason = claimProblem(s, evidence, { checkPerformance: performance });
        if (reason) removed.push({ field, text: s, reason });
      }
    }
    return kept;
  };
  return { pros: items('pros'), cons: items('cons'), verdict: prose('verdict', true), description: prose('description', false), removed };
}

/** Copia del producto con los textos públicos saneados (no muta el original). */
export function withPublicText<T extends Any>(product: T): T {
  const t = publicText(product);
  return { ...product, pros: t.pros, cons: t.cons, verdict: t.verdict, description: t.description };
}
