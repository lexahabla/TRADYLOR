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
import { enrichProductText, hasTextCredentials, type EnrichedText } from '../ai';
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

/** Infiere el nombre de subcategoría hija a partir del mapa de keywords de config. */
function inferSubcategoryName(
  rootId: string,
  haystack: string,
  config: PipelineConfig,
): string | undefined {
  const text = haystack.toLowerCase();
  let best: { name: string; matches: number } | null = null;
  for (const [name, keywords] of Object.entries(config.subcategoryKeywords)) {
    const matches = keywords.reduce(
      (count, keyword) => (keyword && text.includes(keyword.toLowerCase()) ? count + 1 : count),
      0,
    );
    if (matches > 0 && (!best || matches > best.matches)) best = { name, matches };
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
  if (categoryId) {
    const curated = getCategoryById(categoryId);
    if (curated) {
      if (curated.parentId) {
        root = getCategoryById(curated.parentId) ?? undefined;
        categoryId = curated.parentId;
        subcategoryId = curated.id;
      } else {
        root = curated;
        subcategoryId = product.subcategory_id;
      }
      return { category: root, categoryId, subcategoryId };
    }
  }

  if (suggestion) {
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

  if (!categoryId) {
    root = root ?? undefined;
  }

  // Subcategoría hija: se infiere y crea si la categoría raíz aún no la tiene.
  if (categoryId && !subcategoryId) {
    const inferred = inferSubcategoryName(categoryId, haystack, config);
    if (inferred) {
      const sub = getOrCreateSubcategory(categoryId, inferred);
      subcategoryId = sub.id;
      root = root ?? getCategoryById(categoryId) ?? undefined;
    }
  }

  return { category: root, categoryId, subcategoryId };
}

/**
 * Ejecuta la Etapa 3 (async: puede llamar a la IA de texto).
 * Estampa category_id, subcategory_id, normalized_tags, conversion_score,
 * ia_status y link_status.
 */
export async function runStageCategorize(
  product: PipelineProduct,
  config: PipelineConfig,
  options: { enrich?: boolean } = {},
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
  if (options.enrich !== false && hasTextCredentials()) {
    try {
      const ai = await enrichProductText({
        title: next.title,
        description: next.description,
        category: next.category,
        url: next.affiliateUrl,
        price: next.price,
        originalPrice: next.originalPrice,
      });
      enriched = overlayText(local, ai);
    } catch {
      // Sin IA disponible: se mantiene la ficha local (no destructivo).
    }
  }

  if (enriched.title?.trim()) next.title = enriched.title.trim();
  if (enriched.description?.trim()) next.description = enriched.description;
  if (enriched.pros.length) next.pros = enriched.pros;
  if (enriched.cons.length) next.cons = enriched.cons;
  if (enriched.verdict) next.verdict = enriched.verdict;
  if (enriched.techSheet?.trim() && !next.techSheet) next.techSheet = enriched.techSheet;
  if (enriched.specs && Object.keys(enriched.specs).length) {
    next.specs = { ...(next.specs ?? {}), ...enriched.specs };
  }
  if (!next.category && enriched.category) next.category = enriched.category;

  next.normalized_tags = extractNormalizedTags(next);
  next.conversion_score = computeConversionScore(next);
  const status = computeEditorialStatus(next);
  next.ia_status = status.ia_status;
  next.link_status = status.link_status;

  return { ok: true, stage: 'categorize', product: next };
}
