/**
 * Categoría del catálogo para un texto (migas de pan + título) sin IA: cuenta las palabras clave de las categorías RAÍZ
 * existentes. Sólo se asigna si UNA categoría gana con claridad; con empate o sin aciertos NO se inventa nada y el
 * registro sigue el comportamiento aprobado (`sin_categoria` → revisión).
 */
import { getCategories, type Category } from '../categories';
import type { ImportTarget } from './types';

export interface CategoryGuess {
  name?: string;
  ambiguous?: boolean;
}

export function resolveCategoryIn(text: string, roots: Category[]): CategoryGuess {
  const haystack = ` ${text.toLowerCase()} `;
  const scored = roots
    .map((category) => ({
      category,
      matches: new Set((category.keywords ?? []).filter((k) => typeof k === 'string' && k.trim().length >= 3 && haystack.includes(k.toLowerCase()))).size,
    }))
    .filter((s) => s.matches > 0)
    .sort((a, b) => b.matches - a.matches);
  if (!scored.length) return {};
  if (scored.length > 1 && scored[0].matches === scored[1].matches) return { ambiguous: true };
  return { name: scored[0].category.name };
}

export function resolveCatalogCategory(text: string): CategoryGuess {
  return resolveCategoryIn(text, getCategories().filter((c) => !c.parentId));
}

/**
 * Valida el destino elegido en el panel contra el catálogo real (categories.json): la categoría debe existir y ser
 * RAÍZ, y la subcategoría debe pertenecer a ESA categoría. Sin destino (vacío/ausente) devuelve `target: undefined` y
 * rigen las reglas habituales. Nunca crea ni infiere categorías.
 */
export function resolveImportTarget(raw: unknown, categories: Category[] = getCategories()): { target?: ImportTarget; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'El destino de categoría no es válido.' };
  const o = raw as Record<string, unknown>;
  const categoryId = typeof o.categoryId === 'string' ? o.categoryId.trim() : '';
  const subcategoryId = typeof o.subcategoryId === 'string' ? o.subcategoryId.trim() : '';
  if (!categoryId && !subcategoryId) return {};
  if (!categoryId) return { error: 'Elige la categoría de destino antes de la subcategoría.' };
  const root = categories.find((c) => c.id === categoryId);
  if (!root || root.parentId) return { error: 'La categoría de destino no existe en el catálogo.' };
  if (!subcategoryId) return { target: { category: root.name, categoryId: root.id } };
  const sub = categories.find((c) => c.id === subcategoryId);
  if (!sub || !sub.parentId) return { error: 'La subcategoría de destino no existe en el catálogo.' };
  if (sub.parentId !== root.id) return { error: `La subcategoría «${sub.name}» no pertenece a la categoría «${root.name}».` };
  return { target: { category: root.name, categoryId: root.id, subcategoryId: sub.id, subcategoryName: sub.name } };
}
