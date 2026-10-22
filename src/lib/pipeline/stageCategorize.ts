/**
 * ==============================================================================
 * TRADYLOR - PIPELINE · ETAPA 3: CATEGORIZACIÓN ON-THE-FLY + ENRIQUECIMIENTO
 * ==============================================================================
 * - Autasocia categoría raíz + subcategoría (creándola si no existe, con un
 *   helper nuevo e idempotente; NO se modifica categories.ts).
 * - Enriquece el texto: base SIEMPRE local (gratis) + overlay opcional de IA
 *   cuando hay credenciales (patrón `pick()` no destructivo).
 * - Estampa normalized_tags, conversion_score y los estados editoriales.
 * ==============================================================================
 */

import { enrichProductLocally } from '../localEnrich';
import { enrichProductText, hasTextCredentials, textProvider, type EnrichedText } from '../ai';
import {
  createCategory,
  getCategories,
  getCategoryById,
  slugifyCategory,
  suggestCategory,
  type Category,
} from '../categories';
import {
  computeConversionScore,
  computeEditorialStatus,
  extractNormalizedTags,
} from '../curation';
import type { PipelineConfig } from './config';
import type { PipelineProduct, StageResult } from './types';

/** Construye el haystack textual del producto para autasociar la categoría. */
function buildHaystack(product: PipelineProduct): string {
  return [
    product.title,
    product.description,
    Object.entries(product.specs || {}).map(([key, value]) => `${key} ${value}`).join(' '),
    product.brand || '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Infiere el nombre de la subcategoría hija a partir del mapa de keywords de config.
 * Sólo se consideran las subcategorías **candidatas de esa categoría raíz**
 * (`config.rootSubcategories`): así no se crean taxonomías absurdas como
 * "Informática y Oficina > Altavoces".
 *
 * El título pesa el doble que el resto del texto: "Power Bank 30000mAh" tiene
 * que ir a "Power Banks" y no a "Cargadores" sólo porque la descripción
 * mencione un cargador.
 */
function inferSubcategoryName(
  rootId: string,
  title: string,
  haystack: string,
  config: PipelineConfig,
): string | undefined {
  const titleText = title.toLowerCase();
  const text = haystack.toLowerCase();
  const candidates = config.rootSubcategories[rootId] ?? Object.keys(config.subcategoryKeywords);
  let best: { name: string; score: number } | null = null;
  for (const name of candidates) {
    const keywords = config.subcategoryKeywords[name] ?? [];
    let score = 0;
    for (const keyword of keywords) {
      const key = keyword.toLowerCase();
      if (!key) continue;
      if (titleText.includes(key)) score += 2;
      else if (text.includes(key)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { name, score };
  }
  return best?.name;
}

/**
 * Helper nuevo e idempotente: devuelve la subcategoría hija (`${parentId}--slug`),
 * creada con `createCategory()` si no existe. Respeta la regla de un solo nivel.
 */
function getOrCreateSubcategory(parentId: string, name: string): { id: string; created: boolean } {
  const slug = `${parentId}--${slugifyCategory(name)}`;
  const existing =
    getCategoryById(slug) ??
    getCategories().find(
      (category) => category.parentId === parentId && slugifyCategory(category.name) === slugifyCategory(name),
    );
  if (existing) return { id: existing.id, created: false };

  const result = createCategory({ name, parentId, keywords: [] });
  return { id: result.category?.id ?? slug, created: result.ok };
}

/** Overlay no destructivo: la IA mejora lo local sin borrar datos con campos vacíos. */
function overlayText(local: EnrichedText, ai: EnrichedText): EnrichedText {
  const pick = (aiValue: any, localValue: any) => {
    if (typeof aiValue === 'string') return aiValue.trim() ? aiValue : localValue;
    if (Array.isArray(aiValue)) return aiValue.length ? aiValue : localValue;
    return aiValue ?? localValue;
  };
  return {
    ...local,
    ...ai,
    title: pick(ai.title, local.title),
    description: pick(ai.description, local.description),
    verdict: pick(ai.verdict, local.verdict),
    category: pick(ai.category, local.category),
    specs: { ...(local.specs ?? {}), ...(ai.specs ?? {}) },
    pros: pick(ai.pros, local.pros),
    cons: pick(ai.cons, local.cons),
    pricing: ai.pricing ?? local.pricing,
  };
}

/** Resuelve la categoría raíz y la subcategoría hija del producto. */
function resolveCategories(
  product: PipelineProduct,
  haystack: string,
  config: PipelineConfig,
): { category: Category | undefined; categoryId?: string; subcategoryId?: string } {
  const suggestion = suggestCategory(haystack);

  let categoryId = product.category_id;
  let subcategoryId = product.subcategory_id;
  let root: Category | undefined;

  // Curaduría manual: si el producto ya tiene categoría asignada en el panel se
  // RESPETA (el pipeline nunca pisa una asignación manual ni la descoloca de su
  // subcategoría). Sólo se autasocian los productos que aún no tienen categoría.
  const curated = categoryId ? getCategoryById(categoryId) : undefined;
  if (curated) {
    if (curated.parentId) {
      // Ya está dentro de una subcategoría: se mantiene tal cual.
      root = getCategoryById(curated.parentId) ?? undefined;
      categoryId = curated.parentId;
      subcategoryId = curated.id;
      return { category: root, categoryId, subcategoryId };
    }
    // Es una categoría raíz: se respeta, pero si falta la subcategoría se infiere
    // más abajo. Antes el retorno temprano dejaba la ficha sin subcategoría y
    // fuera del preset "⭐ Listos para Publicar" (0 de 25 en producción).
    root = curated;
    subcategoryId = product.subcategory_id;
  } else if (suggestion) {
    const suggested = suggestion.category;
    if (suggested.parentId) {
      root = getCategoryById(suggested.parentId) ?? undefined;
      categoryId = suggested.parentId;
      subcategoryId = suggested.id;
    } else {
      root = suggested;
      categoryId = suggested.id;
      subcategoryId = product.subcategory_id;
    }
  }

  // Subcategoría hija: se infiere y crea si la categoría raíz aún no la tiene.
  if (categoryId && !subcategoryId) {
    const inferred = inferSubcategoryName(categoryId, product.title || '', haystack, config);
    if (inferred) {
      const sub = getOrCreateSubcategory(categoryId, inferred);
      subcategoryId = sub.id;
      root = root ?? getCategoryById(categoryId) ?? undefined;
    }
  }

  return { category: root, categoryId, subcategoryId };
}

/**
 * La ficha está "completa" si ya tiene descripción, veredicto, ficha técnica o
 * especificaciones: en ese caso se marca como `ia_status='completed'` (mismo
 * criterio que usa el preset "⭐ Listos para Publicar" del panel).
 */
function hasCompletedSheet(product: PipelineProduct): boolean {
  if ((product.verdict || '').trim()) return true;
  if ((product.techSheet || '').trim()) return true;
  if ((product.description || '').trim().length >= 60) return true;
  if (product.specs && Object.keys(product.specs).length > 0) return true;
  return false;
}

/**
 * Ejecuta la Etapa 3 (async: puede llamar a la IA de texto).
 * Estampa category_id, subcategory_id, normalized_tags, conversion_score,
 * ia_status y link_status.
 */
export async function runStageCategorize(
  product: PipelineProduct,
  config: PipelineConfig,
  options: { enrich?: boolean; provider?: 'openai' | 'anthropic' | 'groq'; model?: string } = {},
): Promise<StageResult> {
  const haystack = buildHaystack(product);
  const { category: root, categoryId, subcategoryId } = resolveCategories(product, haystack, config);

  let next: PipelineProduct = {
    ...product,
    category_id: categoryId,
    subcategory_id: subcategoryId,
    category: root?.name || product.category || 'Tecnología',
  };

  // Enriquecimiento: base local siempre + overlay de IA opcional.
  const local = enrichProductLocally({
    title: next.title,
    description: next.description,
    category: next.category,
    brand: next.brand,
    merchant: next.merchant,
    price: next.price,
    originalPrice: next.originalPrice,
    rating: next.rating,
    reviewsCount: next.reviewsCount,
    url: next.affiliateUrl,
    specs: next.specs,
    pros: next.pros,
    cons: next.cons,
  });

  let enriched = local;
  // Resultado del enriquecimiento con IA: se estampa en el producto para que el
  // operador vea qué fichas se quedaron con la plantilla local (antes el fallo
  // era silencioso y media parte del catálogo quedaba sin enriquecer).
  let aiEnriched = false;
  let aiError: string | undefined;

  if (options.enrich === false) {
    // El operador desactivó el enriquecimiento: no es un fallo, no se marca error.
  } else if (!hasTextCredentials(options.provider)) {
    aiError = `Sin credenciales de IA para el proveedor "${options.provider ?? textProvider()}"`;
    console.warn(`[Pipeline] ${aiError}: "${next.title}"`);
  } else {
    try {
      const ai = await enrichProductText(
        {
          title: next.title,
          description: next.description,
          category: next.category,
          url: next.affiliateUrl,
          price: next.price,
          originalPrice: next.originalPrice,
        },
        options.provider || options.model
          ? { provider: options.provider, model: options.model }
          : {},
      );
      enriched = overlayText(local, ai);
      aiEnriched = true;
    } catch (error) {
      // Sin IA disponible: se mantiene la ficha local (no destructivo), pero se
      // deja rastro: en producción el fallo era silencioso (límite de peticiones
      // de Groq) y media parte del catálogo se quedaba sin enriquecer.
      aiError = error instanceof Error ? error.message : String(error);
      console.warn(`[Pipeline] Sin enriquecimiento de IA para "${next.title}":`, error);
    }
  }

  if (enriched.title?.trim()) next.title = enriched.title.trim();
  // Si la IA NO pudo enriquecer (sin cuota, sin clave, error del proveedor…) NO se
  // pisa una ficha que ya tenía texto de IA: se conserva el contenido anterior.
  // Antes, un simple re-proceso sin cuota degradaba las fichas buenas y las
  // dejaba con la plantilla local, perdiendo la redacción editorial.
  const preservePreviousText = !aiEnriched && product.ai_enriched === true;
  if (!preservePreviousText) {
    if (enriched.description?.trim()) next.description = enriched.description;
    if (enriched.pros.length) next.pros = enriched.pros;
    if (enriched.cons.length) next.cons = enriched.cons;
    if (enriched.verdict) next.verdict = enriched.verdict;
    if (enriched.techSheet?.trim() && !next.techSheet) next.techSheet = enriched.techSheet;
    if (enriched.specs && Object.keys(enriched.specs).length) {
      next.specs = { ...(next.specs ?? {}), ...enriched.specs };
    }
  }
  if (!next.category && enriched.category) next.category = enriched.category;

  next.normalized_tags = extractNormalizedTags(next);
  next.conversion_score = computeConversionScore(next);

  // Estado editorial: la ficha se marca como 'completed' cuando el
  // enriquecimiento ya la ha completado (aunque trajera un 'pending'
  // heredado), y el enlace queda 'active' si tiene URL de afiliado.
  const status = computeEditorialStatus(next);
  next.ia_status = status.ia_status === 'completed' || hasCompletedSheet(next) ? 'completed' : status.ia_status;
  next.link_status = status.link_status;

  // Rastro del enriquecimiento con IA (visible en el panel y en la API).
  next.ai_enriched = aiEnriched;
  if (aiError) next.ai_error = aiError.slice(0, 200);
  else delete next.ai_error;

  return { ok: true, stage: 'categorize', product: next, ai_enriched: aiEnriched, ai_error: aiError };
}
