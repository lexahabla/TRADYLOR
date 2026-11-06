/**
 * Categoría del catálogo para un texto (migas de pan + título) sin IA: cuenta las palabras clave de las categorías RAÍZ
 * existentes. Sólo se asigna si UNA categoría gana con claridad; con empate o sin aciertos NO se inventa nada y el
 * registro sigue el comportamiento aprobado (`sin_categoria` → revisión).
 */
import { getCategories, type Category } from '../categories';

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
