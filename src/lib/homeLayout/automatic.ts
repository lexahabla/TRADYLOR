/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · MOTOR DE LA MODALIDAD AUTOMÁTICA (etapa 5, función PURA)
 * ==============================================================================
 * Selecciona productos del catálogo según las reglas de un bloque automático (`AutomaticRules`). No escribe nada, no consulta la red, no
 * modifica los productos y no copia datos: devuelve ids ordenados. Una sola pasada de filtrado y una ordenación sobre las fuentes que ya están
 * en memoria (`ReferenceSources`), así que el coste es O(n log n) y se mide con 2.000 productos.
 *
 * Reglas aplicadas (en este orden; cada paso se cuenta para poder EXPLICAR un resultado vacío):
 *   1. catálogo: se parte de los productos existentes con título; los retirados (tombstones) y los inexistentes nunca entran.
 *   2. categoría / subcategoría: por `category_id` / `subcategory_id` y, si el producto no los tiene, por el nombre de su categoría (misma
 *      convención que el listado público). Elegir una categoría principal incluye sus subcategorías.
 *   3. comercio o plataforma: igualdad con la plataforma detectada del producto.
 *   4. «solo con precio»: descarta los productos sin precio utilizable.
 *   5. orden: precio ascendente/descendente (los productos sin precio van al final) o «recientes».
 *   6. límite: `rules.limit`, acotado por `MAX_AUTO_ITEMS`.
 * Determinismo: todos los órdenes desempatan por id, así que las mismas reglas sobre los mismos datos dan SIEMPRE la misma lista.
 *
 * «Más recientes» sólo se ejecuta si TODOS los candidatos tienen una fecha de alta fiable (`ProductInfo.addedAt`: la graba la importación
 * JSON al crear la ficha). Si falta en alguno NO se ejecuta, no se inventan fechas ni se sustituyen por fechas de modificación: el resultado
 * es `no_ejecutable` con el recuento de productos con y sin fecha.
 * ==============================================================================
 */

import { normalizeKey } from '../categories';
import { findCategory, type CategoryInfo, type ProductInfo, type ReferenceSources } from './sources';
import type { AutomaticRules } from './types';

/** Tope de productos que devuelve una selección (coherente con `MAX_ITEMS` del modelo). */
export const MAX_AUTO_ITEMS = 24;

export type AutoStatus = 'ok' | 'vacio' | 'no_ejecutable' | 'reglas_invalidas';
export type AutoReason =
  | 'catalogo_vacio'
  | 'categoria_sin_productos'
  | 'comercio_sin_productos'
  | 'sin_productos_con_precio'
  | 'recientes_sin_fecha_fiable'
  | 'categoria_no_existe'
  | 'subcategoria_no_valida'
  | 'comercio_no_valido';

export interface AutoStats {
  /** Productos existentes con título (tras descartar retirados). */
  catalog: number;
  afterCategory: number;
  afterMerchant: number;
  afterPrice: number;
  /** Sólo con «recientes»: candidatos con y sin fecha de alta fiable. */
  withDate?: number;
  withoutDate?: number;
}

export interface AutoResult {
  status: AutoStatus;
  /** Ids seleccionados, en orden (vacío si el estado no es `ok`). */
  ids: string[];
  reason?: AutoReason;
  /** Explicación en español para el administrador (siempre presente salvo en `ok`). */
  message?: string;
  stats: AutoStats;
}

const cmpId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** ¿Pertenece el producto a la categoría `c`? Por ids y, sin ellos, por nombre de categoría. */
function belongsTo(p: ProductInfo, c: CategoryInfo, src: Pick<ReferenceSources, 'categories'>, nameKeys: Set<string>): boolean {
  if (p.categoryId === c.id || p.subcategoryId === c.id) return true;
  if (p.subcategoryId) {
    const sub = src.categories.get(p.subcategoryId);
    if (sub?.parentId === c.id) return true;
  }
  if (p.categoryId) {
    const cat = src.categories.get(p.categoryId);
    if (cat?.parentId === c.id) return true;
  }
  // Sin identificadores: el nombre libre de la categoría del producto (misma convención que el listado público).
  if (!p.categoryId && !p.subcategoryId) return nameKeys.has(normalizeKey(p.category));
  return false;
}

function nameKeysOf(c: CategoryInfo, src: Pick<ReferenceSources, 'categories'>): Set<string> {
  const keys = new Set<string>([normalizeKey(c.name), normalizeKey(c.slug)]);
  if (!c.parentId) for (const x of src.categories.values()) if (x.parentId === c.id) keys.add(normalizeKey(x.name)).add(normalizeKey(x.slug));
  keys.delete('');
  return keys;
}

export function runAutomatic(rules: AutomaticRules, src: ReferenceSources): AutoResult {
  const stats: AutoStats = { catalog: 0, afterCategory: 0, afterMerchant: 0, afterPrice: 0 };
  const invalid = (reason: AutoReason, message: string): AutoResult => ({ status: 'reglas_invalidas', ids: [], reason, message, stats });

  // Reglas coherentes con el catálogo actual.
  let category: CategoryInfo | undefined;
  if (rules.categoryId) {
    category = findCategory(src, rules.categoryId);
    if (!category) return invalid('categoria_no_existe', 'La categoría de la regla ya no existe: elige otra.');
  }
  let sub: CategoryInfo | undefined;
  if (rules.subcategoryId) {
    sub = findCategory(src, rules.subcategoryId);
    if (!sub || !sub.parentId || (category && sub.parentId !== category.id)) {
      return invalid('subcategoria_no_valida', 'La subcategoría de la regla no existe o no pertenece a la categoría elegida.');
    }
  }
  const merchant = rules.merchant ? rules.merchant.trim().toLowerCase() : '';

  // 1. Catálogo existente (sin retirados ni fichas sin título).
  let list: ProductInfo[] = [];
  for (const p of src.products.values()) {
    if (!p.title || src.retiredIds.has(p.id)) continue;
    list.push(p);
  }
  stats.catalog = list.length;
  if (!list.length) return { status: 'vacio', ids: [], reason: 'catalogo_vacio', message: 'El catálogo no tiene productos disponibles.', stats };

  // 2. Categoría y subcategoría.
  const target = sub ?? category;
  if (target) {
    const keys = nameKeysOf(target, src);
    list = list.filter((p) => belongsTo(p, target, src, keys));
  }
  stats.afterCategory = list.length;
  if (!list.length) {
    return { status: 'vacio', ids: [], reason: 'categoria_sin_productos', message: `La ${sub ? 'subcategoría' : 'categoría'} «${target?.name}» no tiene productos en el catálogo.`, stats };
  }

  // 3. Comercio / plataforma.
  if (merchant) list = list.filter((p) => p.network === merchant);
  stats.afterMerchant = list.length;
  if (!list.length) {
    return { status: 'vacio', ids: [], reason: 'comercio_sin_productos', message: `No hay productos de «${merchant}»${target ? ` en «${target.name}»` : ''}.`, stats };
  }

  // 4. Sólo con precio.
  if (rules.onlyWithPrice) list = list.filter((p) => p.price !== null);
  stats.afterPrice = list.length;
  if (!list.length) {
    return { status: 'vacio', ids: [], reason: 'sin_productos_con_precio', message: 'Ninguno de los productos que cumplen las reglas tiene un precio utilizable.', stats };
  }

  // 5. Orden.
  const price = (p: ProductInfo) => p.price as number;
  if (rules.order === 'precio_asc' || rules.order === 'precio_desc') {
    const dir = rules.order === 'precio_asc' ? 1 : -1;
    list.sort((a, b) => {
      if (a.price === null || b.price === null) return a.price === b.price ? cmpId(a.id, b.id) : a.price === null ? 1 : -1;
      return price(a) === price(b) ? cmpId(a.id, b.id) : (price(a) - price(b)) * dir;
    });
  } else {
    // recientes: requiere fecha de alta fiable en TODOS los candidatos.
    const withDate = list.filter((p) => p.addedAt);
    stats.withDate = withDate.length;
    stats.withoutDate = list.length - withDate.length;
    if (stats.withoutDate > 0) {
      return {
        status: 'no_ejecutable',
        ids: [],
        reason: 'recientes_sin_fecha_fiable',
        message: `«Más recientes» no se ejecuta: ${stats.withoutDate} de ${list.length} productos no tienen fecha de alta fiable (sólo la graba la importación JSON al crear la ficha). Elige otro orden; no se inventan fechas.`,
        stats,
      };
    }
    list.sort((a, b) => {
      const x = Date.parse(a.addedAt as string);
      const y = Date.parse(b.addedAt as string);
      return x === y ? cmpId(a.id, b.id) : y - x;
    });
  }

  // 6. Límite.
  const limit = Math.max(1, Math.min(Number.isFinite(rules.limit) ? Math.floor(rules.limit) : MAX_AUTO_ITEMS, MAX_AUTO_ITEMS));
  return { status: 'ok', ids: list.slice(0, limit).map((p) => p.id), stats };
}
