/**
 * ==============================================================================
 * TRADYLOR - FILTROS Y ORDENACIÓN DEL CATÁLOGO ALIEXPRESS (PANEL ADMIN)
 * ==============================================================================
 * Módulo tipado del bloque `#aliFilters` («2. Catálogo AliExpress (caché)»).
 *
 * ARQUITECTURA
 * ------------
 *   UI (3 capas)  ──lee/escribe──▶  ProductFilterParams  ──▶  filter/query
 *   presets 1 clic ───────────────▶  (estado reactivo)     (puro, sin DOM)
 *
 *   1. `ProductFilterParams` es el CONTRATO único entre la interfaz y la capa
 *      de consulta. Es exactamente el objeto que se pasaría a un WHERE si el
 *      catálogo viviera en SQL (ver «Equivalencia SQL» más abajo).
 *   2. `filterAliCatalog()` / `queryAliCatalog()` son funciones PURAS:
 *      filtran → ordenan → paginan, SIEMPRE en ese orden (los filtros aplican
 *      antes de paginar). No tocan el DOM, por eso son reutilizables desde el
 *      servidor o desde cualquier test.
 *   3. `mountAliFilters()` monta la UI, mantiene el estado y notifica cambios
 *      vía `host.onChange()`. Devuelve un controller (`AliFiltersController`).
 *
 * DATOS
 * -----
 *   El panel no usa SQL: el catálogo vive en un snapshot JSON del volumen
 *   (`aliexpress-catalog.json`) que se descarga entero al navegador. Aquí la
 *   "query" se ejecuta en memoria sobre `UnifiedProduct[]`, con el mismo
 *   contrato que tendría una consulta server-side.
 *
 *   Equivalencia SQL (misma semántica):
 *     WHERE  titulo/descripcion ILIKE '%'||q||'%'
 *        AND categoria_l1 = :catL1 AND categoria_l2 = :catL2
 *        AND estado_importacion = :estado
 *        AND precio_venta BETWEEN :priceMin AND :priceMax
 *        AND (comision_estimada >= :eur OR comision_pct >= :pct)
 *        AND ventas_30d >= :salesMin AND valoracion_score >= :ratingMin
 *        AND envio_gratis IS TRUE ... AND total_imagenes >= :imagesMin
 *     ORDER BY <sortBy> <sortDir>          -- nulos siempre al final
 *       sortBy ∈ ventas | visitas | comision_eur | comision_pct | valoracion |
 *                descuento | precio | nombre | fecha (fecha_alta = `firstSeenAt`)
 *     LIMIT :limit OFFSET :offset
 * ==============================================================================
 */

import type { UnifiedProduct } from '../lib/networks/types';

/**
 * Puente público hacia el script principal del panel (`upayp1b4.astro`, que es
 * `is:inline` y por tanto no puede hacer `import`). El módulo se empaqueta como
 * ES module y se ejecuta antes de `DOMContentLoaded`.
 */
declare global {
  interface Window {
    tradylorAliFilters?: {
      filterAliCatalog: typeof filterAliCatalog;
      mountAliFilters: typeof mountAliFilters;
      queryAliCatalog: typeof queryAliCatalog;
    };
  }
}

/* ────────────────────────────── TIPOS ────────────────────────────────────── */

/** Estado de un producto del catálogo AliExpress dentro de Tradylor. */
export type AliImportState = 'PENDING' | 'IMPORTED' | 'DISCARDED';

/** Filtro de estado: todos o un estado concreto. */
export type AliEstadoFilter = AliImportState | 'ALL';

export type AliSortDir = 'asc' | 'desc';

/** Claves de ordenación del desplegable «Ordenar por». */
export type AliSortKey =
  | 'ventas'
  | 'visitas'
  | 'comision_eur'
  | 'comision_pct'
  | 'valoracion'
  | 'descuento'
  | 'precio'
  | 'nombre'
  /** Fecha de alta en la caché (`firstSeenAt`): desc = más recientes primero. */
  | 'fecha';

/** Unidad del filtro de comisión mínima (€ de comisión estimada o % de tasa). */
export type AliCommissionUnit = 'eur' | 'pct';

/**
 * Parámetros de filtrado/ordenación del catálogo.
 *
 * Todos los campos son opcionales: `undefined`/ausente = «sin restricción».
 * Los booleanos se interpretan como `true` únicamente (false = sin filtro).
 */
export interface ProductFilterParams {
  /** Texto libre → `titulo` + `descripcion` + categoría + tienda. */
  q?: string;
  /** Categoría nivel 1 (`categoria_l1`). */
  catL1?: string;
  /** Subcategoría nivel 2 (`categoria_l2`). Depende de `catL1` (cascada). */
  catL2?: string;
  /** Estado de importación en Tradylor. Por defecto `ALL` (oculta descartados). */
  estado?: AliEstadoFilter;
  /** Tienda / merchant (`extra.Tienda`). */
  shop?: string;
  /** Red / comerciante de origen (id de red conectada, p. ej. `aliexpress`). */
  network?: string;
  /** Precio de venta mínimo en €. */
  priceMin?: number;
  /** Precio de venta máximo en €. */
  priceMax?: number;
  /** Comisión estimada mínima en € (`comision_estimada`). */
  commissionEurMin?: number;
  /** Comisión mínima en % (`comision_pct`). Si `commissionEurMin` también existe, se aplica en OR. */
  commissionPctMin?: number;
  /** Ventas / alcance mínimos en los últimos 30 días (`ventas_30d`). */
  salesMin?: number;
  /** Valoración mínima sobre 5 (`valoracion_score`). */
  ratingMin?: number;
  /** Descuento mínimo en %. */
  discountMin?: number;
  /** Número mínimo de imágenes (`total_imagenes`). */
  imagesMin?: number;
  /** Sólo productos con envío gratis (`envio_gratis`). */
  freeShippingOnly?: boolean;
  /** Sólo AliExpress Choice / Almacén local (`es_choice`). */
  choiceOnly?: boolean;
  /** Sólo productos con comisión Hot > 0 % (`comision_hot_pct`). */
  hotCommissionOnly?: boolean;
  /** Sólo productos con stock (`en_stock`). Lo usan los presets. */
  inStockOnly?: boolean;
  /** Sólo productos de segunda mano o reacondicionados. */
  secondHandOnly?: boolean;
  /** Campo de ordenación. */
  sortBy?: AliSortKey;
  /** Dirección del orden. */
  sortDir?: AliSortDir;
}

/** Resultado paginado de la consulta. */
export interface AliCatalogQuery {
  items: UnifiedProduct[];
  /** Total de productos que cumplen los filtros (antes de paginar). */
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  /** Equivalente SQL de `pageSize` (`LIMIT`). */
  limit: number;
  /** Posición del primer elemento devuelto (`OFFSET`). */
  offset: number;
}

/** Contexto opcional de la consulta. */
export interface AliQueryContext {
  /** externalId → estado de importación (para el filtro `estado`). */
  estadoIndex?: Map<string, AliImportState>;
}

/** Preset rápido de una capa (1 clic). */
export interface AliPreset {
  id: string;
  icon: string;
  label: string;
  params: ProductFilterParams;
}

/* ────────────────────────── ESTADO POR DEFECTO ───────────────────────────── */

/** Estado inicial de la barra de filtros (sin restricciones). */
export function defaultAliFilters(): ProductFilterParams {
  return {
    q: '',
    catL1: '',
    catL2: '',
    estado: 'ALL',
    shop: '',
    sortBy: 'ventas',
    sortDir: 'desc',
  };
}

/**
 * CAPA 1 — Presets rápidos.
 * Aplican un filtro completo sobre el estado inicial (conservan el orden salvo
 * «Limpiar», que restaura todo). Antes de escribirlos en la UI se eliminan las
 * condiciones sin datos en la caché (ver `sanitizePreset`), para que un preset
 * nunca devuelva 0 filas por ausencia de columna.
 */
export const ALI_PRESETS: AliPreset[] = [
  {
    id: 'top-ventas',
    icon: '🔥',
    label: 'Top Ventas',
    params: { salesMin: 200, ratingMin: 4.6, inStockOnly: true },
  },
  {
    id: 'alto-margen',
    icon: '💰',
    label: 'Alto Margen',
    params: { priceMin: 20, priceMax: 80, commissionEurMin: 1.5, commissionPctMin: 9, ratingMin: 4.5 },
  },
  {
    id: 'envio-express',
    icon: '⚡',
    label: 'Envío Exprés',
    params: { freeShippingOnly: true, choiceOnly: true, salesMin: 50 },
  },
  {
    id: 'segunda-mano',
    icon: '♻️',
    label: 'Segunda Mano',
    params: { secondHandOnly: true },
  },
  { id: 'clear', icon: '🗑️', label: 'Limpiar Filtros', params: {} },
];

/* ─────────────────────────── LECTURA DE CAMPOS ───────────────────────────── */

type ExtraValue = string | number | boolean | null | undefined;

/**
 * Campos opcionales que ciertas cachés/conectores añaden fuera del tipo base
 * `UnifiedProduct` (el panel ya los lee con esta misma forma al importar).
 */
type LooseProduct = UnifiedProduct & {
  shippingDays?: number | string | null;
  freeShipping?: boolean | null;
  technicalSpecs?: Record<string, unknown>;
};

function extra(product: UnifiedProduct, key: string): ExtraValue {
  return product.extra ? product.extra[key] : undefined;
}

/**
 * Convierte «12,50 €» / «4.6» / null en número o `null`.
 * El texto sin dígitos («N/A», «—», `true`) es `null`, NO 0: un 0 falso haría
 * pasar p. ej. «días de envío ≤ 3» a productos sin dato.
 */
export function toNumber(value: ExtraValue | unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[^\d.,-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const parsed = Number(cleaned.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Categoría nivel 1 (con respaldo a `category` en cachés antiguas). */
export function categoryL1(product: UnifiedProduct): string {
  const value = extra(product, 'Categoría nivel 1');
  return value ? String(value) : product.category || '';
}

/** Categoría nivel 2 (con respaldo a `category`). */
export function categoryL2(product: UnifiedProduct): string {
  const value = extra(product, 'Categoría nivel 2');
  return value ? String(value) : product.category || '';
}

/** Ventas / alcance de los últimos 30 días. */
export function sales30d(product: UnifiedProduct): number | null {
  return toNumber(product.popularity) ?? toNumber(extra(product, 'Ventas (30 días)'));
}

/** Visitas del producto (AliExpress no siempre las facilita). */
export function visits(product: UnifiedProduct): number | null {
  return (
    toNumber(product.visits) ??
    toNumber(extra(product, 'Visitas')) ??
    toNumber(extra(product, 'Visitantes')) ??
    toNumber(extra(product, 'Visits'))
  );
}

/** Comisión estimada en € (la calcula el conector; si falta, la derivamos). */
export function commissionEur(product: UnifiedProduct): number | null {
  return (
    toNumber(product.commissionAmount) ??
    (toNumber(product.price) != null && toNumber(product.commissionRate) != null
      ? Math.round((toNumber(product.price) as number) * ((toNumber(product.commissionRate) as number) / 100) * 100) / 100
      : null)
  );
}

/** Comisión en %. */
export function commissionPct(product: UnifiedProduct): number | null {
  return toNumber(product.commissionRate) ?? toNumber(extra(product, 'Comisión (%)'));
}

/** Comisión Hot en % (> 0 ⇒ producto en campaña Hot). */
export function hotCommissionPct(product: UnifiedProduct): number | null {
  return toNumber(extra(product, 'Comisión hot (%)'));
}

/** Descuento en % (del extra o derivado de precio/precio original). */
export function discountPct(product: UnifiedProduct): number | null {
  const raw = toNumber(extra(product, 'Descuento'));
  if (raw != null) return raw;
  const price = toNumber(product.price);
  const original = toNumber(product.originalPrice);
  if (price != null && original != null && price > 0 && original > price) {
    return ((original - price) / original) * 100;
  }
  return null;
}

/**
 * Fecha de alta del producto en la caché (`firstSeenAt`) como marca de tiempo (ms),
 * o `null` si no hay fecha o es ilegible (cachés anteriores a la primera sincronización
 * con este campo). Los `null` se ordenan siempre al final, igual que el resto de claves.
 */
export function firstSeenTime(product: UnifiedProduct): number | null {
  const raw = product.firstSeenAt;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? null : time;
}

/** Días de envío declarados por la red. */
export function shippingDays(product: UnifiedProduct): number | null {
  return toNumber(extra(product, 'Días de envío')) ?? toNumber((product as LooseProduct).shippingDays);
}

/** `envio_gratis`: texto explícito o entrega rápida (≤ 3 días). */
export function hasFreeShipping(product: UnifiedProduct): boolean {
  const flag = (product as LooseProduct).freeShipping;
  if (typeof flag === 'boolean') return flag;
  const info = [product.shippingInfo, extra(product, 'Envío'), extra(product, 'Envío gratis')]
    .filter(Boolean)
    .join(' ');
  if (/gratis|free|sin coste/i.test(info)) return true;
  const days = shippingDays(product);
  return days != null && days <= 3;
}

/**
 * `es_choice`: Alias Express Choice / Almacén Local.
 * La API de afiliados no expone un flag booleano fiable, así que se mira
 * cualquier marca explícita en los extras (`Choice`, `Almacén local`,
 * `Plataforma`…). Si no hay ninguna marca en todo el catálogo la UI desactiva
 * el control (ver `computeAvailability`) en vez de devolver 0 filas.
 */
export function isChoice(product: UnifiedProduct): boolean {
  const flag = (product as unknown as { choice?: boolean; es_choice?: boolean }).choice
    ?? (product as unknown as { es_choice?: boolean }).es_choice;
  if (flag === true) return true;
  const haystack = [
    extra(product, 'Choice'),
    extra(product, 'Es Choice'),
    extra(product, 'Almacén local'),
    extra(product, 'Plataforma'),
    extra(product, 'Fulfillment'),
  ]
    .filter((value) => value != null && value !== '')
    .join(' ');
  return /choice|ali_?local|almac[eé]n local|local store/i.test(haystack);
}

/** Nº de imágenes disponibles (galería o extra «Imágenes» separado por « | »). */
export function imageCount(product: UnifiedProduct): number {
  if (Array.isArray(product.gallery) && product.gallery.length) return product.gallery.length;
  const raw = extra(product, 'Imágenes');
  if (raw) return String(raw).split('|').map((part) => part.trim()).filter(Boolean).length;
  return 0;
}

/**
 * Determina si un producto es de segunda mano, reacondicionado o usado
 * (soporta campos de condición de eBay/redes, technicalSpecs y texto).
 */
export function isSecondHand(product: UnifiedProduct): boolean {
  const cond = String(
    extra(product, 'Condition') ??
    extra(product, 'condition') ??
    extra(product, 'Estado') ??
    (product as unknown as { condition?: string }).condition ??
    (product as LooseProduct).technicalSpecs?.['Estado'] ??
    ''
  ).toLowerCase();

  if (cond) {
    if (/used|pre-owned|refurbished|reacondicionado|segunda mano|para desguace|for parts|open box|devoluci[oó]n|usado/i.test(cond)) {
      return true;
    }
  }

  const title = String(product.title || '').toLowerCase();
  const desc = String(product.description || '').toLowerCase();
  const text = `${title} ${desc}`;
  const secondHandPattern = /\b(segunda\s+mano|reacondicionad[oa]s?|refurbished|pre-owned|usad[oa]s?|open\s*box|km\s*0|ex-demo|seminuev[oa]s?)\b/i;

  return secondHandPattern.test(text);
}

/* ────────────────────────────── PRESETS ──────────────────────────────────── */

/** Columnas de las que hay datos reales en la caché cargada. */
export interface AliFilterAvailability {
  freeShipping: boolean;
  choice: boolean;
  hotCommission: boolean;
  secondHand: boolean;
}

export function computeAvailability(products: UnifiedProduct[]): AliFilterAvailability {
  return {
    freeShipping: products.some(hasFreeShipping),
    choice: products.some(isChoice),
    hotCommission: products.some((product) => (hotCommissionPct(product) ?? 0) > 0),
    secondHand: products.some(isSecondHand),
  };
}

/** Condiciones «booleanas» de la capa 3 que dependen de que la caché traiga la columna. */
const COLUMN_CONDITIONS: Array<{
  key: 'freeShippingOnly' | 'choiceOnly' | 'hotCommissionOnly' | 'secondHandOnly';
  column: keyof AliFilterAvailability;
  label: string;
}> = [
  { key: 'freeShippingOnly', column: 'freeShipping', label: 'envío gratis' },
  { key: 'choiceOnly', column: 'choice', label: 'Choice / Almacén local' },
  { key: 'hotCommissionOnly', column: 'hotCommission', label: 'comisión Hot' },
  { key: 'secondHandOnly', column: 'secondHand', label: 'segunda mano' },
];

/**
 * Quita de un preset las condiciones cuya columna no existe en la caché y
 * devuelve cuáles (`dropped`), para avisar al usuario de que el preset se ha
 * aplicado de forma parcial en lugar de dejarlo creer que filtró por ellas.
 */
function sanitizePreset(
  params: ProductFilterParams,
  availability: AliFilterAvailability,
): { params: ProductFilterParams; dropped: string[] } {
  const next: ProductFilterParams = { ...params };
  const dropped: string[] = [];
  for (const { key, column, label } of COLUMN_CONDITIONS) {
    if (next[key] && !availability[column]) {
      delete next[key];
      dropped.push(label);
    }
  }
  return { params: next, dropped };
}

/* ──────────────────────── CAPA DE CONSULTA (PURA) ────────────────────────── */

const SORTERS: Record<Exclude<AliSortKey, 'nombre'>, (product: UnifiedProduct) => number | null> = {
  ventas: sales30d,
  visitas: visits,
  comision_eur: commissionEur,
  comision_pct: commissionPct,
  valoracion: (product) => toNumber(product.rating),
  descuento: discountPct,
  precio: (product) => toNumber(product.price),
  fecha: firstSeenTime,
};

/**
 * Filtra y ordena el catálogo. No pagina: `queryAliCatalog` lo hace encima.
 * Reglas:
 *  - `estado = ALL` oculta los descartados con la ✕ de la tabla (el resto de
 *    estados sí los muestran, para poder recuperarlos).
 *  - `commissionEurMin` y `commissionPctMin` se combinan en OR (spec: «≥ 1,50 €
 *    o ≥ 9 %»).
 *  - Los valores `null`/`undefined`/'' se consideran «sin filtro».
 */
export function filterAliCatalog(
  products: UnifiedProduct[],
  params: ProductFilterParams,
  context: AliQueryContext = {},
): UnifiedProduct[] {
  const q = (params.q ?? '').trim().toLowerCase();
  const estadoIndex = context.estadoIndex;
  const estado = params.estado ?? 'ALL';

  const filtered = products.filter((product) => {
    // Estado de importación (PENDING / IMPORTED / DISCARDED)
    if (estado === 'ALL') {
      if (estadoIndex && estadoIndex.get(product.externalId) === 'DISCARDED') return false;
    } else {
      const state = estadoIndex?.get(product.externalId) ?? 'PENDING';
      if (state !== estado) return false;
    }

    if (params.catL1 && categoryL1(product) !== params.catL1) return false;
    if (params.catL2 && categoryL2(product) !== params.catL2) return false;
    if (params.shop && String(extra(product, 'Tienda') ?? '') !== params.shop) return false;
    if (params.network) {
      // El id de red (p. ej. `aliexpress`) se compara en minúsculas con el
      // `network` normalizado del conector (`aliexpress`, `amazon`, `AliExpress`…).
      const productNetwork = String(product.network ?? '').trim().toLowerCase();
      if (productNetwork !== params.network.trim().toLowerCase()) return false;
    }

    // Rango de precio
    const price = toNumber(product.price);
    if (params.priceMin != null && (price == null || price < params.priceMin)) return false;
    if (params.priceMax != null && (price == null || price > params.priceMax)) return false;

    // Comisión mínima (€ o %) — en OR si vienen ambas
    if (params.commissionEurMin != null || params.commissionPctMin != null) {
      const eur = commissionEur(product);
      const pct = commissionPct(product);
      const okEur = params.commissionEurMin == null || (eur != null && eur >= params.commissionEurMin);
      const okPct = params.commissionPctMin == null || (pct != null && pct >= params.commissionPctMin);
      const both = params.commissionEurMin != null && params.commissionPctMin != null;
      if (!(both ? okEur || okPct : okEur && okPct)) return false;
    }

    if (params.salesMin != null) {
      const sales = sales30d(product);
      if (sales == null || sales < params.salesMin) return false;
    }
    if (params.ratingMin != null) {
      const rating = toNumber(product.rating);
      if (rating == null || rating < params.ratingMin) return false;
    }
    if (params.discountMin != null) {
      const discount = discountPct(product);
      if (discount == null || discount < params.discountMin) return false;
    }
    if (params.imagesMin != null && imageCount(product) < params.imagesMin) return false;

    if (params.freeShippingOnly && !hasFreeShipping(product)) return false;
    if (params.choiceOnly && !isChoice(product)) return false;
    if (params.hotCommissionOnly && (hotCommissionPct(product) ?? 0) <= 0) return false;
    if (params.secondHandOnly && !isSecondHand(product)) return false;
    if (params.inStockOnly && product.inStock === false) return false;

    // Texto libre: título + descripción + categoría + tienda
    if (q) {
      const haystack = [
        product.title,
        product.description,
        product.category,
        categoryL1(product),
        categoryL2(product),
        extra(product, 'Tienda'),
      ]
        .filter((value) => value != null && value !== '')
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const dir = params.sortDir === 'asc' ? 1 : -1;
  const sortBy = params.sortBy ?? 'ventas';

  return filtered.sort((a, b) => {
    if (sortBy === 'nombre') return dir * String(a.title).localeCompare(String(b.title), 'es');
    const get = SORTERS[sortBy as Exclude<AliSortKey, 'nombre'>] ?? SORTERS.ventas;
    const av = get(a);
    const bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // los nulos siempre al final
    if (bv == null) return -1;
    return dir * (av - bv);
  });
}

/**
 * Consulta completa: filtra → ordena → pagina (siempre en ese orden).
 *
 * Paginación, dos formas equivalentes (si se pasa `offset`, manda la segunda):
 *  - `page` (1-based) + `pageSize`: `page` se recorta al rango válido para no
 *    devolver páginas vacías.
 *  - `limit` + `offset` (semántica SQL `LIMIT/OFFSET`): no se recorta; un
 *    `offset` pasado del total devuelve `items: []`.
 */
export function queryAliCatalog(
  products: UnifiedProduct[],
  params: ProductFilterParams,
  options: { page?: number; pageSize?: number; limit?: number; offset?: number } & AliQueryContext = {},
): AliCatalogQuery {
  const pageSize = Math.max(1, Math.floor(options.limit ?? options.pageSize ?? 50));
  const matched = filterAliCatalog(products, params, options);
  const pages = Math.max(1, Math.ceil(matched.length / pageSize));

  if (options.offset != null) {
    const offset = Math.max(0, Math.floor(options.offset));
    return {
      items: matched.slice(offset, offset + pageSize),
      total: matched.length,
      page: Math.floor(offset / pageSize) + 1,
      pages,
      pageSize,
      limit: pageSize,
      offset,
    };
  }

  const page = Math.min(Math.max(1, options.page ?? 1), pages);
  const start = (page - 1) * pageSize;
  return {
    items: matched.slice(start, start + pageSize),
    total: matched.length,
    page,
    pages,
    pageSize,
    limit: pageSize,
    offset: start,
  };
}

/* ──────────────────────── UI: MONTAJE Y ESTADO ───────────────────────────── */

/** Datos que el panel (script inline) aporta al módulo de filtros. */
export interface AliFilterHost {
  /** Catálogo completo tal y como está ahora en memoria. */
  getProducts(): UnifiedProduct[];
  /** Mapa externalId → estado de importación (lo calcula el panel). */
  getEstadoIndex(): Map<string, AliImportState>;
  /** Se llama cada vez que cambian filtros u orden: hay que repintar la tabla. */
  onChange(): void;
}

/** API que el panel usa tras montar la barra. */
export interface AliFiltersController {
  /** Parámetros actuales (copia inmutable). */
  getParams(): ProductFilterParams;
  /** Filtra + ordena con los parámetros actuales (sin paginar). */
  filter(products: UnifiedProduct[]): UnifiedProduct[];
  /** Vuelve a calcular facetas (categorías/tiendas) y disponibilidad. */
  refresh(): void;
  /** Aplica un preset o (`null`/`'clear'`) restablece todo. */
  applyPreset(id: string | null): void;
  /** Restablece la barra a su estado inicial. */
  reset(): void;
  /** ¿Hay filtros activos (para mostrar/ocultar el contador de chips)? */
  hasActiveFilters(): boolean;
}

type ElementsOf<T extends string> = Record<T, HTMLElement | null>;

function byId<T extends string>(...ids: T[]): ElementsOf<T> {
  const out = {} as ElementsOf<T>;
  for (const id of ids) out[id] = document.getElementById(id);
  return out;
}

/** Chip visible de un filtro activo (se puede quitar de uno en uno). */
interface AliChip {
  key: string;
  label: string;
  clear(params: ProductFilterParams): void;
}

const ESTADO_LABELS: Record<AliEstadoFilter, string> = {
  ALL: 'Todos',
  PENDING: 'No añadidos',
  IMPORTED: 'Añadidos al catálogo',
  DISCARDED: 'Descartados',
};

function fmtNum(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace('.', ',');
}

function buildChips(params: ProductFilterParams): AliChip[] {
  const chips: AliChip[] = [];
  if (params.q) chips.push({ key: 'q', label: `«${params.q}»`, clear: (p) => { p.q = ''; } });
  if (params.catL1) chips.push({ key: 'catL1', label: params.catL1, clear: (p) => { p.catL1 = ''; p.catL2 = ''; } });
  if (params.catL2) chips.push({ key: 'catL2', label: params.catL2, clear: (p) => { p.catL2 = ''; } });
  if (params.estado && params.estado !== 'ALL') {
    chips.push({ key: 'estado', label: ESTADO_LABELS[params.estado], clear: (p) => { p.estado = 'ALL'; } });
  }
  if (params.shop) chips.push({ key: 'shop', label: params.shop, clear: (p) => { p.shop = ''; } });
  if (params.network) chips.push({ key: 'network', label: params.network, clear: (p) => { p.network = ''; } });
  if (params.priceMin != null || params.priceMax != null) {
    const from = params.priceMin != null ? `${fmtNum(params.priceMin)} €` : '';
    const to = params.priceMax != null ? `${fmtNum(params.priceMax)} €` : '';
    chips.push({ key: 'price', label: `Precio ${from || '…'}–${to || '…'}`, clear: (p) => { delete p.priceMin; delete p.priceMax; } });
  }
  if (params.commissionEurMin != null || params.commissionPctMin != null) {
    const parts: string[] = [];
    if (params.commissionEurMin != null) parts.push(`≥ ${fmtNum(params.commissionEurMin)} €`);
    if (params.commissionPctMin != null) parts.push(`≥ ${fmtNum(params.commissionPctMin)} %`);
    chips.push({ key: 'commission', label: `Comisión ${parts.join(' o ')}`, clear: (p) => { delete p.commissionEurMin; delete p.commissionPctMin; } });
  }
  if (params.salesMin != null) chips.push({ key: 'sales', label: `Ventas ≥ ${fmtNum(params.salesMin)}`, clear: (p) => { delete p.salesMin; } });
  if (params.ratingMin != null) chips.push({ key: 'rating', label: `Valoración ≥ ${fmtNum(params.ratingMin)}★`, clear: (p) => { delete p.ratingMin; } });
  if (params.discountMin != null) chips.push({ key: 'discount', label: `Dto. ≥ ${fmtNum(params.discountMin)} %`, clear: (p) => { delete p.discountMin; } });
  if (params.imagesMin != null) chips.push({ key: 'images', label: `≥ ${fmtNum(params.imagesMin)} imágenes`, clear: (p) => { delete p.imagesMin; } });
  if (params.freeShippingOnly) chips.push({ key: 'free', label: 'Envío gratis', clear: (p) => { p.freeShippingOnly = false; } });
  if (params.choiceOnly) chips.push({ key: 'choice', label: 'Choice / Almacén local', clear: (p) => { p.choiceOnly = false; } });
  if (params.hotCommissionOnly) chips.push({ key: 'hot', label: 'Comisión Hot', clear: (p) => { p.hotCommissionOnly = false; } });
  if (params.secondHandOnly) chips.push({ key: 'secondHand', label: 'Segunda mano', clear: (p) => { p.secondHandOnly = false; } });
  if (params.inStockOnly) chips.push({ key: 'stock', label: 'En stock', clear: (p) => { p.inStockOnly = false; } });
  return chips;
}

/** Nº de condiciones de la capa 3 activas (para el badge de «Más filtros»). */
function advancedCount(params: ProductFilterParams): number {
  return [
    params.freeShippingOnly,
    params.choiceOnly,
    params.hotCommissionOnly,
    params.secondHandOnly,
    params.imagesMin != null,
    params.discountMin != null,
    params.shop,
    params.network,
  ].filter(Boolean).length;
}

let mounted: AliFiltersController | null = null;

/**
 * Monta la barra de filtros de 3 capas sobre `#aliFilters`.
 * Idempotente: si ya estaba montada, devuelve la instancia activa.
 */
export function mountAliFilters(host: AliFilterHost): AliFiltersController {
  if (mounted) return mounted;

  const el = byId(
    'affiliateFilters',
    'aliFilters',
    'aliFQ',
    'aliFCount',
    'aliFCat1',
    'aliFCat2',
    'aliFState',
    'aliFPriceMin',
    'aliFPriceMax',
    'aliFCommMin',
    'aliFCommUnit',
    'aliFSalesMin',
    'aliFRatingMin',
    'aliFSort',
    'aliFSortDir',
    'aliFMoreBtn',
    'aliFAdvBadge',
    'aliAdvanced',
    'aliFFreeShip',
    'aliFChoice',
    'aliFHot',
    'aliFSecondHand',
    'aliFImages',
    'aliFDiscMin',
    'aliFShop',
    'aliFNetwork',
    'aliFChips',
  );
  const root = el.affiliateFilters || el.aliFilters;
  if (!root) {
    const noop: AliFiltersController = {
      getParams: () => defaultAliFilters(),
      filter: (products) => products,
      refresh: () => {},
      applyPreset: () => {},
      reset: () => {},
      hasActiveFilters: () => false,
    };
    mounted = noop;
    return noop;
  }
  // Alias ya estrechado a no-nulo: las funciones declaradas más abajo (hoisted)
  // no heredan el narrowing de `root`, pero sí el tipo de este `const`.
  const rootEl: HTMLElement = root;

  let params: ProductFilterParams = defaultAliFilters();
  let activePreset: string | null = null;
  /** Aviso del preset activo cuando se aplicó sin alguna condición por falta de datos. */
  let presetNotice: string | null = null;
  let products: UnifiedProduct[] = [];
  let availability: AliFilterAvailability = { freeShipping: false, choice: false, hotCommission: false, secondHand: false };

  /* ── lectura de la UI → estado ─────────────────────────────────────────── */

  const numValue = (node: HTMLElement | null): number | undefined => {
    const raw = (node as HTMLInputElement | null)?.value;
    if (raw == null || String(raw).trim() === '') return undefined;
    const parsed = Number(String(raw).replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  function readFromDom(): void {
    const next = defaultAliFilters();

    const q = (el.aliFQ as HTMLInputElement | null)?.value ?? '';
    next.q = q.trim();

    next.catL1 = (el.aliFCat1 as HTMLSelectElement | null)?.value ?? '';
    next.catL2 = (el.aliFCat2 as HTMLSelectElement | null)?.value ?? '';

    const estado = (el.aliFState as HTMLSelectElement | null)?.value as AliEstadoFilter | undefined;
    next.estado = estado && ESTADO_LABELS[estado] ? estado : 'ALL';

    next.shop = (el.aliFShop as HTMLSelectElement | null)?.value ?? '';
    next.network = (el.aliFNetwork as HTMLSelectElement | null)?.value ?? '';

    next.priceMin = numValue(el.aliFPriceMin);
    next.priceMax = numValue(el.aliFPriceMax);

    // Comisión: el input escribe SÓLO la unidad seleccionada (la otra se limpia)
    const unit = (el.aliFCommUnit as HTMLSelectElement | null)?.value === 'pct' ? 'pct' : 'eur';
    const commission = numValue(el.aliFCommMin);
    if (commission != null) {
      if (unit === 'pct') next.commissionPctMin = commission;
      else next.commissionEurMin = commission;
    }

    next.salesMin = numValue(el.aliFSalesMin);
    next.ratingMin = numValue(el.aliFRatingMin);
    next.discountMin = numValue(el.aliFDiscMin);
    next.imagesMin = numValue(el.aliFImages);

    next.freeShippingOnly = Boolean((el.aliFFreeShip as HTMLInputElement | null)?.checked);
    next.choiceOnly = Boolean((el.aliFChoice as HTMLInputElement | null)?.checked);
    next.hotCommissionOnly = Boolean((el.aliFHot as HTMLInputElement | null)?.checked);
    next.secondHandOnly = Boolean((el.aliFSecondHand as HTMLInputElement | null)?.checked);

    // Orden (capa conservada del diseño original)
    next.sortBy = ((el.aliFSort as HTMLSelectElement | null)?.value ?? 'ventas') as AliSortKey;
    next.sortDir = (el.aliFSortDir as HTMLButtonElement | null)?.dataset.dir === 'asc' ? 'asc' : 'desc';

    params = next;
  }

  /* ── estado → UI ───────────────────────────────────────────────────────── */

  const setOptions = (select: HTMLSelectElement | null, values: string[], anyLabel: string, keep?: string, labels?: string[]): void => {
    if (!select) return;
    const fragment = document.createDocumentFragment();
    const any = document.createElement('option');
    any.value = '';
    any.textContent = anyLabel;
    fragment.appendChild(any);
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      const option = document.createElement('option');
      option.value = value;
      option.textContent = (labels && labels[i]) ? labels[i] : value;
      fragment.appendChild(option);
    }
    select.textContent = '';
    select.appendChild(fragment);
    select.value = keep && values.includes(keep) ? keep : '';
  };

  function populateFacets(): void {
    // Filtrar productos por comerciante/red si hay uno seleccionado, para que
    // las categorías y subcategorías que se ofrezcan sean solo las de ese
    // comerciante. Cuando no hay comerciante seleccionado ("Todas"), se
    // muestran todas las categorías precedidas del nombre del comerciante.
    const network = params.network || '';
    const productsForCats = network
      ? products.filter((p) => String(p.network ?? '').trim().toLowerCase() === network.trim().toLowerCase())
      : products;

    const l1Raw = [...new Set(productsForCats.map(categoryL1).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    const l1Labels = network
      ? l1Raw
      : l1Raw.map((c) => {
          const owner = productsForCats.find((p) => categoryL1(p) === c);
          const net = owner ? String(owner.network ?? '').trim() : '';
          return net ? `${net} › ${c}` : c;
        });
    setOptions(el.aliFCat1 as HTMLSelectElement | null, l1Raw, 'Todas', params.catL1, l1Labels);
    params.catL1 = (el.aliFCat1 as HTMLSelectElement | null)?.value || '';

    const l2Raw = params.catL1
      ? [...new Set(productsForCats.filter((p) => categoryL1(p) === params.catL1).map(categoryL2).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'))
      : [...new Set(productsForCats.map(categoryL2).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    const l2Labels = network
      ? l2Raw
      : l2Raw.map((c) => {
          const owner = productsForCats.find((p) => categoryL2(p) === c);
          const net = owner ? String(owner.network ?? '').trim() : '';
          return net ? `${net} › ${c}` : c;
        });
    setOptions(el.aliFCat2 as HTMLSelectElement | null, l2Raw, params.catL1 ? 'Todas' : '—', params.catL2, l2Labels);
    params.catL2 = (el.aliFCat2 as HTMLSelectElement | null)?.value || '';
    const l2Select = el.aliFCat2 as HTMLSelectElement | null;
    if (l2Select) {
      l2Select.disabled = l2.length === 0;
      l2Select.title = l2.length === 0 ? 'Esta categoría no tiene subcategorías en la caché' : '';
    }

    const shops = [...new Set(productsForCats.map((p) => extra(p, 'Tienda')).filter((v): v is string => Boolean(v)))].sort();
    setOptions(el.aliFShop as HTMLSelectElement | null, shops, 'Todas', params.shop);
    params.shop = (el.aliFShop as HTMLSelectElement | null)?.value || '';
  }

  function applyAvailability(): void {
    const map: Array<[HTMLInputElement | null, boolean, string]> = [
      [el.aliFFreeShip as HTMLInputElement | null, availability.freeShipping, 'Sin datos de envío en la caché'],
      [el.aliFChoice as HTMLInputElement | null, availability.choice, 'Sin productos marcados como Choice en la caché'],
      [el.aliFHot as HTMLInputElement | null, availability.hotCommission, 'Ningún producto con comisión Hot en la caché'],
      [el.aliFSecondHand as HTMLInputElement | null, availability.secondHand, 'Sin productos de segunda mano en la caché'],
    ];
    for (const [node, ok, hint] of map) {
      if (!node) continue;
      node.disabled = !ok;
      node.checked = ok ? node.checked : false;
      node.closest('label')?.toggleAttribute('data-no-data', !ok);
      node.closest('label')?.setAttribute('title', ok ? '' : hint);
    }
  }

  function writeToDom(): void {
    const setInput = (node: HTMLElement | null, value: string) => {
      const input = node as HTMLInputElement | null;
      if (input) input.value = value;
    };
    const setSelect = (node: HTMLElement | null, value: string) => {
      const select = node as HTMLSelectElement | null;
      if (!select) return;
      if (value && ![...select.options].some((option) => option.value === value)) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = `≥ ${fmtNum(Number(value))}`;
        select.appendChild(option);
      }
      select.value = value;
    };

    populateFacets();

    setInput(el.aliFQ, params.q ?? '');

    const estadoSelect = el.aliFState as HTMLSelectElement | null;
    if (estadoSelect) estadoSelect.value = params.estado ?? 'ALL';

    setInput(el.aliFPriceMin, params.priceMin != null ? String(params.priceMin) : '');
    setInput(el.aliFPriceMax, params.priceMax != null ? String(params.priceMax) : '');

    const unitSelect = el.aliFCommUnit as HTMLSelectElement | null;
    const usePct = params.commissionPctMin != null && params.commissionEurMin == null;
    if (unitSelect) unitSelect.value = usePct ? 'pct' : 'eur';
    setInput(el.aliFCommMin, (usePct ? params.commissionPctMin : params.commissionEurMin) != null
      ? String(usePct ? params.commissionPctMin : params.commissionEurMin)
      : '');

    setInput(el.aliFSalesMin, params.salesMin != null ? String(params.salesMin) : '');
    setSelect(el.aliFRatingMin, params.ratingMin != null ? String(params.ratingMin) : '');
    setInput(el.aliFDiscMin, params.discountMin != null ? String(params.discountMin) : '');
    setInput(el.aliFImages, params.imagesMin != null ? String(params.imagesMin) : '');

    applyAvailability();
    (el.aliFFreeShip as HTMLInputElement | null)!.checked = Boolean(params.freeShippingOnly);
    (el.aliFChoice as HTMLInputElement | null)!.checked = Boolean(params.choiceOnly);
    (el.aliFHot as HTMLInputElement | null)!.checked = Boolean(params.hotCommissionOnly);
    if (el.aliFSecondHand) (el.aliFSecondHand as HTMLInputElement).checked = Boolean(params.secondHandOnly);
    (el.aliFShop as HTMLSelectElement | null)!.value = params.shop ?? '';
    (el.aliFNetwork as HTMLSelectElement | null)!.value = params.network ?? '';

    const sortSelect = el.aliFSort as HTMLSelectElement | null;
    if (sortSelect) sortSelect.value = params.sortBy ?? 'ventas';
    const dirBtn = el.aliFSortDir as HTMLButtonElement | null;
    if (dirBtn) {
      dirBtn.dataset.dir = params.sortDir === 'asc' ? 'asc' : 'desc';
      dirBtn.textContent = params.sortDir === 'asc' ? '↑' : '↓';
      dirBtn.title = params.sortDir === 'asc'
        ? 'Orden actual: menor a mayor. Pulsa para invertir.'
        : 'Orden actual: mayor a menor. Pulsa para invertir.';
    }
  }

  function paintIndicators(): void {
    // Chips de filtros activos
    const chipsHost = el.aliFChips;
    if (chipsHost) {
      const chips = buildChips(params);
      chipsHost.textContent = '';
      chipsHost.hidden = chips.length === 0;
      for (const chip of chips) {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'ali-chip';
        node.dataset.chip = chip.key;
        const label = document.createElement('span');
        label.textContent = chip.label;
        const close = document.createElement('span');
        close.className = 'ali-chip-x';
        close.textContent = '×';
        close.setAttribute('aria-hidden', 'true');
        node.append(label, close);
        node.title = `Quitar filtro: ${chip.label}`;
        node.addEventListener('click', () => {
          chip.clear(params);
          activePreset = null;
          writeToDom();
          paintIndicators();
          host.onChange();
        });
        chipsHost.appendChild(node);
      }
    }

    // Contador de resultados
    const countNode = el.aliFCount;
    if (countNode) {
      const matched = filterAliCatalog(products, params, { estadoIndex: host.getEstadoIndex() }).length;
      countNode.textContent = `${matched}/${products.length}`;
      countNode.title = `${matched} de ${products.length} productos cumplen los filtros`;
      countNode.classList.toggle('is-filtered', hasActiveFilters());
    }

    // Preset activo (con marca ⚠ y tooltip si se aplicó de forma parcial)
    rootEl.querySelectorAll<HTMLButtonElement>('[data-ali-preset]').forEach((button) => {
      const isActive = button.dataset.aliPreset === activePreset;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
      const partial = isActive && presetNotice != null;
      button.toggleAttribute('data-partial', partial);
      if (partial && presetNotice) button.title = presetNotice;
      else button.removeAttribute('title');
    });

    // Badge de la capa 3
    const advCount = advancedCount(params);
    const badge = el.aliFAdvBadge;
    if (badge) {
      badge.hidden = advCount === 0;
      badge.textContent = String(advCount);
    }
  }

  /**
   * Un preset deja de estar activo en cuanto el usuario toca cualquier control:
   * los presets son «vistas guardadas», no una sesión que se acumule.
   */
  function hasActiveFilters(): boolean {
    return buildChips(params).length > 0;
  }

  /* ── listeners de la capa 2 y 3 ────────────────────────────────────────── */

  const onControlChange = () => {
    readFromDom();
    activePreset = null;
    paintIndicators();
    host.onChange();
  };

  // La L1 la gestiona su propio listener en cascada (más abajo): si también la
  // leyera onControlChange leería la L2 vieja antes de repueblarla.
  for (const id of [
    'aliFQ', 'aliFCat2', 'aliFState', 'aliFPriceMin', 'aliFPriceMax', 'aliFCommMin', 'aliFCommUnit',
    'aliFSalesMin', 'aliFRatingMin', 'aliFDiscMin', 'aliFImages', 'aliFFreeShip', 'aliFChoice',
    'aliFHot', 'aliFSecondHand', 'aliFShop', 'aliFNetwork', 'aliFSort',
  ] as const) {
    const node = el[id];
    if (!node) continue;
    // Los campos de texto/número filtran en cada tecla; selects y checkboxes, al cambiar
    const liveTyping = node.tagName === 'INPUT' && ['search', 'text', 'number'].includes((node as HTMLInputElement).type);
    node.addEventListener(liveTyping ? 'input' : 'change', onControlChange);
  }

  // Categoría L2 en cascada: al cambiar la L1 se repuebla la L2
  (el.aliFCat1 as HTMLSelectElement | null)?.addEventListener('change', () => {
    params.catL1 = (el.aliFCat1 as HTMLSelectElement | null)?.value || '';
    params.catL2 = '';
    const network = params.network || '';
    const productsForCats = network
      ? products.filter((p) => String(p.network ?? '').trim().toLowerCase() === network.trim().toLowerCase())
      : products;
    const l2Select = el.aliFCat2 as HTMLSelectElement | null;
    if (l2Select) {
      const l2 = params.catL1
        ? [...new Set(productsForCats.filter((p) => categoryL1(p) === params.catL1).map(categoryL2).filter(Boolean))].sort()
        : [];
      const l2Labels = network
        ? l2
        : l2.map((c) => {
            const owner = productsForCats.find((p) => categoryL2(p) === c);
            const net = owner ? String(owner.network ?? '').trim() : '';
            return net ? `${net} › ${c}` : c;
          });
      setOptions(l2Select, l2, 'Todas', '', l2Labels);
      l2Select.disabled = l2.length === 0;
    }
    activePreset = null;
    paintIndicators();
    host.onChange();
  });

  // Orden: invertir dirección (mayor→menor / menor→mayor)
  (el.aliFSortDir as HTMLButtonElement | null)?.addEventListener('click', () => {
    params.sortDir = (params.sortDir ?? 'desc') === 'desc' ? 'asc' : 'desc';
    const dirBtn = el.aliFSortDir as HTMLButtonElement | null;
    if (dirBtn) {
      dirBtn.dataset.dir = params.sortDir;
      dirBtn.textContent = params.sortDir === 'asc' ? '↑' : '↓';
      dirBtn.title = params.sortDir === 'asc'
        ? 'Orden actual: menor a mayor. Pulsa para invertir.'
        : 'Orden actual: mayor a menor. Pulsa para invertir.';
    }
    host.onChange();
  });

  // Capa 3: desplegable «Más filtros»
  const advancedPanel = el.aliAdvanced;
  (el.aliFMoreBtn as HTMLButtonElement | null)?.addEventListener('click', () => {
    if (!advancedPanel) return;
    const open = advancedPanel.hidden;
    advancedPanel.hidden = !open;
    (el.aliFMoreBtn as HTMLButtonElement | null)?.setAttribute('aria-expanded', String(open));
    (el.aliFMoreBtn as HTMLButtonElement | null)?.classList.toggle('is-open', open);
  });

  // Capa 1: presets de 1 clic
  rootEl.querySelectorAll<HTMLButtonElement>('[data-ali-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.aliPreset || null;
      controller.applyPreset(id);
    });
  });

  /* ── controller público ────────────────────────────────────────────────── */

  const controller: AliFiltersController = {
    getParams: () => ({ ...params }),

    filter: (list) => filterAliCatalog(list, params, { estadoIndex: host.getEstadoIndex() }),

    refresh: () => {
      products = host.getProducts();
      availability = computeAvailability(products);
      // Si la nueva caché ya no trae una columna, la condición se descarta
      // para no dejar la barra filtrando a cero filas sin motivo.
      if (!availability.freeShipping) params.freeShippingOnly = false;
      if (!availability.choice) params.choiceOnly = false;
      if (!availability.hotCommission) params.hotCommissionOnly = false;
      if (!availability.secondHand) params.secondHandOnly = false;
      writeToDom();
      paintIndicators();
    },

    applyPreset: (id) => {
      const preset = ALI_PRESETS.find((entry) => entry.id === id);
      if (!preset || preset.id === 'clear') {
        controller.reset();
        return;
      }
      const keepSort = { sortBy: params.sortBy, sortDir: params.sortDir };
      const { params: presetParams, dropped } = sanitizePreset(preset.params, availability);
      params = { ...defaultAliFilters(), ...presetParams, ...keepSort };
      activePreset = preset.id;
      presetNotice = dropped.length
        ? `Aplicado parcialmente: la caché no tiene datos de ${dropped.join(' ni ')}, así que esa condición se ha omitido.`
        : null;
      writeToDom();
      paintIndicators();
      host.onChange();
    },

    reset: () => {
      params = defaultAliFilters();
      activePreset = null;
      presetNotice = null;
      writeToDom();
      paintIndicators();
      host.onChange();
    },

    hasActiveFilters,
  };

  // Pintado inicial con la caché que ya esté en memoria (si la hay)
  products = host.getProducts();
  availability = computeAvailability(products);
  writeToDom();
  paintIndicators();

  mounted = controller;
  return controller;
}
