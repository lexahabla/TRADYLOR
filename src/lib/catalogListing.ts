/**
 * ==============================================================================
 * TREIDILOR — LISTADO PÚBLICO DEL CATÁLOGO: BÚSQUEDA, FILTROS Y URL
 * ==============================================================================
 * Una sola función pura que, dada la lista de productos publicados y los
 * parámetros de la URL, devuelve el listado filtrado, las facetas con sus
 * recuentos REALES, los chips de filtros activos y los tramos de precio.
 *
 *  - Búsqueda (?q=): SOLO título, marca y categoría, sin tildes ni mayúsculas
 *    (misma normalización que /api/search). Todas las palabras deben aparecer.
 *  - Filtros (OR dentro de un grupo, AND entre grupos): categoría, marca,
 *    precio, gangas y atributos estructurados (f_<atributo>=valor).
 *  - Estado en la URL: ?q&category&brand&min&max&deal&f_*&sort&page. La URL es
 *    la única fuente de verdad (enlaces compartibles, botón Atrás, recarga).
 *  - Sin datos no hay opción: un atributo ausente no genera filtro ni
 *    coincide; los recuentos son de productos únicos y nunca inventados.
 * ==============================================================================
 */

import { applyFilters, buildFacets, type FacetContext, type FacetGroup, type FacetProduct, type Selections } from './catalogFacets';
import { getCategories, getCategoryById, normalizeKey, type Category } from './categories';

type AnyRecord = Record<string, any>;

/** Atributos que se aceptan como filtro en la URL (f_<clave>). */
export const FILTER_ATTR_KEYS = [
  'conectividad', 'cancelacion-ruido', 'autonomia', 'color', 'almacenamiento', 'ram', 'pantalla', 'peso', 'bateria', 'potencia', 'estado',
];

export interface ListingParams {
  q: string;
  /** Slugs de categoría (raíz o subcategoría). */
  category: string[];
  brand: string[];
  attrs: Record<string, string[]>;
  min?: number;
  max?: number;
  deal: boolean;
  /** Orden EXPLÍCITO de la URL ('' si no viene). */
  sort: string;
  page: number;
}

const uniq = (list: string[]): string[] => [...new Set(list)];

/** Lee los parámetros del listado de una URL. Tolera valores basura (se ignoran). */
export function parseListingParams(search: URLSearchParams): ListingParams {
  const num = (key: string): number | undefined => {
    const raw = (search.get(key) ?? '').trim().replace(',', '.');
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const attrs: Record<string, string[]> = {};
  for (const key of FILTER_ATTR_KEYS) {
    const values = search.getAll(`f_${key}`).map((v) => v.trim().toLowerCase()).filter(Boolean);
    if (values.length) attrs[key] = uniq(values);
  }
  const min = num('min');
  const max = num('max');
  const page = parseInt(search.get('page') ?? '1', 10);
  return {
    q: (search.get('q') ?? '').trim(),
    category: uniq(search.getAll('category').map((v) => v.trim().toLowerCase()).filter(Boolean)),
    brand: uniq(search.getAll('brand').map((v) => v.trim().toLowerCase()).filter(Boolean)),
    attrs,
    min: min !== undefined && max !== undefined && min > max ? max : min,
    max: min !== undefined && max !== undefined && min > max ? min : max,
    deal: search.get('deal') === '1',
    sort: (search.get('sort') ?? '').trim().toLowerCase(),
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/** ¿Hay algún filtro activo (sin contar búsqueda, orden ni página)? */
export function hasActiveFilters(p: ListingParams): boolean {
  return p.category.length > 0 || p.brand.length > 0 || Object.keys(p.attrs).length > 0 || p.min !== undefined || p.max !== undefined || p.deal;
}

/** URL del listado para unos parámetros. El orden sólo viaja si venía explícito. */
export function listingHref(p: ListingParams, extra: { page?: number; sort?: string; base?: string } = {}): string {
  const out = new URLSearchParams();
  if (p.q) out.set('q', p.q);
  for (const c of p.category) out.append('category', c);
  for (const b of p.brand) out.append('brand', b);
  for (const [key, values] of Object.entries(p.attrs)) for (const v of values) out.append(`f_${key}`, v);
  if (p.min !== undefined) out.set('min', String(p.min));
  if (p.max !== undefined) out.set('max', String(p.max));
  if (p.deal) out.set('deal', '1');
  const sort = extra.sort ?? p.sort;
  if (sort) out.set('sort', sort);
  const page = extra.page ?? 1;
  if (page > 1) out.set('page', String(page));
  const qs = out.toString();
  return `${extra.base ?? '/'}${qs ? `?${qs}` : ''}#catalogo`;
}

/* ───────────────────────────── BÚSQUEDA ───────────────────────────── */

/** Minúsculas sin tildes (igual que `normalize` de /api/search). */
export const foldText = (value: unknown): string =>
  String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Coincidencia por título, marca y categoría (nunca descripción). Todas las palabras deben aparecer. */
export function matchesSearch(product: FacetProduct, query: string, categoryNames: string[] = []): boolean {
  const terms = foldText(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = [foldText(product.title), foldText(product.brand), ...categoryNames.map(foldText), foldText(product.category)].join(' | ');
  return terms.every((term) => haystack.includes(term));
}

/* ───────────────────────────── CATEGORÍAS ───────────────────────────── */

export interface CategoryResolver {
  /** Slugs de categoría de la ficha (su categoría raíz y, si la tiene, su subcategoría). Vacío = sin clasificar. */
  idsOf: (product: FacetProduct) => string[];
  label: (slug: string) => string;
  isRoot: (slug: string) => boolean;
}

const tokensOf = (text: string): string[] => normalizeKey(text).split(' ').filter((t) => t.length > 2);

/**
 * Categoría CANÓNICA de una ficha. El texto libre de `category` está fragmentado («Sonido», «Audio & Sonido», «Portátiles»…):
 * manda `category_id`/`subcategory_id`; sin ellos, el nombre debe coincidir con una categoría del catálogo, y como último recurso
 * con UNA sola categoría raíz cuyas palabras estén contenidas en él. Si no es posible, la ficha queda sin clasificar (no se inventa).
 */
export function makeCategoryResolver(categories: Category[] = getCategories()): CategoryResolver {
  const bySlugOrId = new Map<string, Category>();
  for (const c of categories) {
    bySlugOrId.set(c.id, c);
    bySlugOrId.set(c.slug, c);
  }
  const roots = categories.filter((c) => !c.parentId);
  const expand = (c: Category | undefined, out: string[]) => {
    if (!c) return;
    const parent = c.parentId ? bySlugOrId.get(c.parentId) : undefined;
    if (parent) out.push(parent.slug);
    out.push(c.slug);
  };
  const byName = (name: string): Category | undefined => {
    const key = normalizeKey(name);
    if (!key) return undefined;
    return categories.find((c) => normalizeKey(c.name) === key || normalizeKey(c.slug) === key);
  };
  const fuzzyRoot = (name: string): Category | undefined => {
    const own = new Set(tokensOf(name));
    if (!own.size) return undefined;
    const hits = roots.filter((r) => {
      const rt = tokensOf(r.name);
      return rt.length > 0 && rt.every((t) => own.has(t));
    });
    return hits.length === 1 ? hits[0] : undefined;
  };
  const cache = new WeakMap<object, string[]>();
  const idsOf = (product: FacetProduct): string[] => {
    const hit = cache.get(product);
    if (hit) return hit;
    const out: string[] = [];
    const sub = product.subcategory_id ? bySlugOrId.get(String(product.subcategory_id)) : undefined;
    const cat = product.category_id ? bySlugOrId.get(String(product.category_id)) : undefined;
    expand(sub, out);
    expand(cat, out);
    if (!out.length) {
      const named = byName(String(product.category ?? '')) ?? fuzzyRoot(String(product.category ?? ''));
      expand(named, out);
    }
    const result = [...new Set(out)];
    cache.set(product, result);
    return result;
  };
  return {
    idsOf,
    label: (slug) => bySlugOrId.get(slug)?.name ?? getCategoryById(slug)?.name ?? slug,
    isRoot: (slug) => !bySlugOrId.get(slug)?.parentId,
  };
}

/* ───────────────────────────── LISTADO ───────────────────────────── */

export interface ListingChip {
  key: string;
  label: string;
  /** URL del listado SIN este filtro. */
  href: string;
}

export interface PriceRange {
  label: string;
  min?: number;
  max?: number;
  count: number;
}

export interface Listing<T> {
  /** Resultados de la búsqueda y de todos los filtros. */
  filtered: T[];
  /** Resultados de la sola búsqueda (base de las facetas). */
  searched: T[];
  groups: FacetGroup[];
  /** Gangas disponibles con el resto de filtros aplicados (descuento mínimo con precio anterior verificado). */
  deals: number;
  price: { min: number; max: number; ranges: PriceRange[] } | null;
  chips: ListingChip[];
}

const PRESET_BREAKS = [10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000];
const eur = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2).replace('.', ',')} €`;

function priceRangesFor(prices: number[]): PriceRange[] {
  if (prices.length < 4) return [];
  const sorted = [...prices].sort((a, b) => a - b);
  const quantile = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  const picked = new Set<number>();
  for (const q of [0.25, 0.5, 0.75]) {
    const target = quantile(q);
    const candidate = PRESET_BREAKS.filter((b) => b > lo && b < hi).sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    if (candidate !== undefined) picked.add(candidate);
  }
  const breaks = [...picked].sort((a, b) => a - b);
  if (!breaks.length) return [];
  const ranges: PriceRange[] = [];
  const countIn = (min?: number, max?: number) => prices.filter((p) => (min === undefined || p > min) && (max === undefined || p <= max)).length;
  ranges.push({ label: `hasta ${eur(breaks[0])}`, max: breaks[0], count: countIn(undefined, breaks[0]) });
  for (let i = 0; i < breaks.length - 1; i++) {
    ranges.push({ label: `${eur(breaks[i])} hasta ${eur(breaks[i + 1])}`, min: breaks[i], max: breaks[i + 1], count: countIn(breaks[i], breaks[i + 1]) });
  }
  const last = breaks[breaks.length - 1];
  ranges.push({ label: `desde ${eur(last)}`, min: last, count: countIn(last) });
  return ranges.filter((r) => r.count > 0);
}

/** Calcula el listado, las facetas y los chips para unos parámetros de URL. */
export function buildListing<T extends FacetProduct>(
  products: T[],
  params: ListingParams,
  opts: { now?: Date; resolver?: CategoryResolver } = {},
): Listing<T> {
  const resolver = opts.resolver ?? makeCategoryResolver();
  const ctx: FacetContext = {
    now: opts.now,
    // El público ve el precio publicado: una lectura antigua no excluye la ficha de un filtro de precio.
    maxAgeHours: Number.POSITIVE_INFINITY,
    categoryIdsOf: resolver.idsOf,
    categoryLabel: resolver.label,
  };

  const searched = params.q ? products.filter((p) => matchesSearch(p, params.q, resolver.idsOf(p).map(resolver.label))) : products;
  const selections: Selections = {
    brand: params.brand.length ? params.brand : undefined,
    attrs: Object.keys(params.attrs).length ? params.attrs : undefined,
    minPrice: params.min,
    maxPrice: params.max,
    category: params.category.length ? params.category : undefined,
    deal: params.deal || undefined,
  };

  // Atributos pertinentes: los de la categoría única elegida o, sin ella, los de la categoría raíz dominante (≥ 60 %) del resultado.
  let categoryKey: string | undefined;
  const selectedRoots = params.category.filter((c) => resolver.isRoot(c));
  if (selectedRoots.length === 1) categoryKey = resolver.label(selectedRoots[0]);
  else if (!params.category.length && searched.length) {
    const counts = new Map<string, number>();
    for (const p of searched) for (const id of resolver.idsOf(p)) if (resolver.isRoot(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] / searched.length >= 0.6) categoryKey = resolver.label(top[0]);
  }

  const facets = buildFacets(searched, selections, { ...ctx, categoryKey });
  const filtered = applyFilters(searched, selections, ctx);

  // Los selectores de categoría muestran sólo raíces (más las subcategorías ya elegidas).
  const groups = facets.groups.map((g) =>
    g.key === 'category' ? { ...g, options: g.options.filter((o) => resolver.isRoot(String(o.value)) || o.selected) } : g,
  );

  // Precio: límites y tramos con el resto de filtros aplicados (menos el propio precio) para no mostrar tramos vacíos.
  const withoutPrice = applyFilters(searched, { ...selections, minPrice: undefined, maxPrice: undefined }, ctx);
  const prices = withoutPrice.map((p) => Number(p.price)).filter((n) => Number.isFinite(n) && n > 0);
  const price = prices.length
    ? { min: Math.floor(Math.min(...prices)), max: Math.ceil(Math.max(...prices)), ranges: priceRangesFor(prices) }
    : null;

  // Chips de filtros activos, cada uno con el enlace que lo retira.
  const chips: ListingChip[] = [];
  const without = (patch: Partial<ListingParams>): string => listingHref({ ...params, ...patch });
  for (const slug of params.category) {
    chips.push({ key: `category:${slug}`, label: resolver.label(slug), href: without({ category: params.category.filter((c) => c !== slug) }) });
  }
  const brandLabels = new Map<string, string>();
  for (const g of groups) if (g.key === 'brand') for (const o of g.options) brandLabels.set(String(o.value), o.label);
  for (const b of params.brand) {
    chips.push({ key: `brand:${b}`, label: brandLabels.get(b) ?? b, href: without({ brand: params.brand.filter((x) => x !== b) }) });
  }
  const attrLabel = (key: string, value: string): string => {
    const group = groups.find((g) => g.key === key);
    const option = group?.options.find((o) => String(o.value).toLowerCase() === value);
    return option ? `${group!.label}: ${option.label}` : `${key}: ${value}`;
  };
  for (const [key, values] of Object.entries(params.attrs)) {
    for (const v of values) {
      const rest = values.filter((x) => x !== v);
      const attrs = { ...params.attrs };
      if (rest.length) attrs[key] = rest;
      else delete attrs[key];
      chips.push({ key: `attr:${key}:${v}`, label: attrLabel(key, v), href: without({ attrs }) });
    }
  }
  if (params.min !== undefined || params.max !== undefined) {
    const label =
      params.min !== undefined && params.max !== undefined ? `${eur(params.min)} – ${eur(params.max)}` : params.max !== undefined ? `Hasta ${eur(params.max)}` : `Desde ${eur(params.min!)}`;
    chips.push({ key: 'price', label, href: without({ min: undefined, max: undefined }) });
  }
  if (params.deal) chips.push({ key: 'deal', label: 'Gangas', href: without({ deal: false }) });

  return { filtered, searched, groups, deals: facets.deals, price, chips };
}

/** Atajo para pruebas y API: ¿qué opciones ofrece cada grupo? (valores y recuentos reales). */
export function summarizeGroups(groups: FacetGroup[]): AnyRecord[] {
  return groups.map((g) => ({ key: g.key, label: g.label, options: g.options.map((o) => ({ value: o.value, label: o.label, count: o.count, selected: o.selected })) }));
}
