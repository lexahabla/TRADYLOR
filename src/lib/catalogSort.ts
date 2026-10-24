import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths';

const SORT_FILE = path.join(DATA_DIR, 'catalog-sort.json');

export const ALLOWED_CATALOG_SORTS = [
  'precio_desc',
  'precio_asc',
  'valoracion',
  'ventas',
  'publicados',
  'score',
  'nombre',
  'categoria',
  'comercio',
  'descuento',
  'default',
] as const;

export type CatalogSortOption = (typeof ALLOWED_CATALOG_SORTS)[number];

/**
 * Criterios de orden "exacto" (agrupación o tal cual se guardan) que deben librarse
 * del motor de Diversidad (`catalogDiversity.ts`). Aplicar diversidad encima de ellos
 * anularía el propio criterio elegido: p. ej. "Categoría" existe justamente para
 * agrupar, y la diversidad dispersa a propósito los consecutivos de la misma categoría.
 * Score/Ventas/Valoración/Descuento SÍ se diversifican (son rankings, no agrupaciones).
 *
 * Usada en `src/pages/index.astro` (tienda pública) y `src/pages/upayp1b4.astro`
 * (tabla de productos del panel). El `<script is:inline>` del panel no puede importar
 * este módulo: su copia local debe mantenerse en sync manualmente con esta lista.
 */
export const DIVERSITY_EXEMPT_SORTS: string[] = [
  'precio_desc',
  'precio_asc',
  'publicados',
  'nombre',
  'categoria',
  'comercio',
  'default',
];

export function getGlobalCatalogSort(): CatalogSortOption {
  try {
    if (fs.existsSync(SORT_FILE)) {
      const content = fs.readFileSync(SORT_FILE, 'utf-8');
      const data = JSON.parse(content);
      if (data && typeof data.sort === 'string') {
        const trimmed = data.sort.trim().toLowerCase();
        if (ALLOWED_CATALOG_SORTS.includes(trimmed as CatalogSortOption)) {
          return trimmed as CatalogSortOption;
        }
      }
    }
  } catch {
    // Fallback silencioso
  }
  return 'score';
}

export function setGlobalCatalogSort(sort: string): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const trimmed = sort.trim().toLowerCase();
    const cleanSort = ALLOWED_CATALOG_SORTS.includes(trimmed as CatalogSortOption)
      ? trimmed
      : 'score';
    fs.writeFileSync(
      SORT_FILE,
      JSON.stringify({ sort: cleanSort, updatedAt: new Date().toISOString() }, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.error('[catalogSort] Error al guardar ordenación global del catálogo:', err);
  }
}

// ─── Puntuaciones y cálculos para la ordenación pública ───────────────────────
export const scoreOfProduct = (p: any): number => {
  const convScore = Number(p.conversion_score);
  if (Number.isFinite(convScore) && convScore > 0) return convScore;
  const ratingScore = (p.rating ?? 0) / 5;
  const reviewScore = Math.min(Math.log10((p.reviewsCount ?? 0) + 1) / 4, 1);
  const discountScore =
    p.originalPrice && p.originalPrice > p.price
      ? (p.originalPrice - p.price) / p.originalPrice
      : 0;
  return (ratingScore * 0.6 + reviewScore * 0.3 + discountScore * 0.1) * 100;
};

export const salesOfProduct = (p: any): number => {
  const s30 = Number(p.sales30d);
  if (Number.isFinite(s30) && s30 > 0) return s30;
  const pop = Number(p.popularity);
  if (Number.isFinite(pop) && pop > 0) return pop;
  if (p.extra && typeof p.extra === 'object') {
    const rawSales = (p.extra as Record<string, unknown>)['Ventas (30 días)'];
    const numSales = Number(rawSales);
    if (Number.isFinite(numSales) && numSales > 0) return numSales;
  }
  return Number(p.reviewsCount ?? 0);
};

export const ratingOfProduct = (p: any): number => {
  const r = Number(p.rating ?? 0);
  const rc = Number(p.reviewsCount ?? 0);
  return r * 100000 + rc;
};

export const discountPctOfProduct = (p: any): number => {
  const orig = Number(p.originalPrice) || 0;
  const curr = Number(p.price) || 0;
  if (orig <= 0 || curr <= 0 || orig <= curr) return 0;
  return Math.round(((orig - curr) / orig) * 100);
};

/**
 * Ordena una lista de productos según cualquiera de los 11 criterios soportados
 */
export function sortCatalogProducts<T = any>(products: T[], sortKey: string): T[] {
  const list = [...products];
  const normalized =
    sortKey === 'precio-desc'
      ? 'precio_desc'
      : sortKey === 'precio-asc'
        ? 'precio_asc'
        : sortKey;

  switch (normalized) {
    case 'precio_desc':
      return list.sort((a: any, b: any) => (Number(b.price) || 0) - (Number(a.price) || 0));

    case 'precio_asc':
      return list.sort((a: any, b: any) => (Number(a.price) || 0) - (Number(b.price) || 0));

    case 'valoracion':
      return list.sort((a: any, b: any) => ratingOfProduct(b) - ratingOfProduct(a));

    case 'ventas':
      return list.sort((a: any, b: any) => salesOfProduct(b) - salesOfProduct(a));

    case 'publicados': {
      const isPub = (p: any) =>
        p.ia_status === 'completed' &&
        p.link_status === 'active' &&
        Boolean(p.category_id || p.category)
          ? 1
          : Boolean(p.category_id || p.category)
            ? 0.5
            : 0;
      return list.sort(
        (a: any, b: any) => isPub(b) - isPub(a) || scoreOfProduct(b) - scoreOfProduct(a)
      );
    }

    case 'score':
      return list.sort((a: any, b: any) => scoreOfProduct(b) - scoreOfProduct(a));

    case 'nombre':
      return list.sort((a: any, b: any) =>
        String(a.title || '').localeCompare(String(b.title || ''), 'es')
      );

    case 'categoria':
      return list.sort((a: any, b: any) =>
        String(a.category || '').localeCompare(String(b.category || ''), 'es')
      );

    case 'comercio':
      return list.sort((a: any, b: any) =>
        String(a.merchant || a.network_label || '').localeCompare(
          String(b.merchant || b.network_label || ''),
          'es'
        )
      );

    case 'descuento':
      return list.sort(
        (a: any, b: any) => discountPctOfProduct(b) - discountPctOfProduct(a)
      );

    case 'default':
      return list;

    default:
      return list.sort((a: any, b: any) => scoreOfProduct(b) - scoreOfProduct(a));
  }
}
