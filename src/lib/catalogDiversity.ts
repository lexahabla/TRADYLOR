/**
 * ==============================================================================
 * TRADYLOR — CATALOG DIVERSITY & ALTERNATION ENGINE
 * ==============================================================================
 * Regla de Alternancia y Diversidad:
 * 1. Al renderizar la lista u ordenación, el sistema debe alternar los tipos de
 *    productos para no repetir nunca el mismo producto (o modelo idéntico) en la
 *    misma línea/fila (mínimo de distancia rowSize, ej: 4 columnas en grid).
 * 2. Si la variedad del catálogo lo permite, distribuye el contenido para
 *    evitar duplicidades dentro de una misma página (pageSize, ej: 40 en web, 50 en admin).
 * 3. Mantiene al máximo el orden de clasificación primario (Score, Ventas, Valoración).
 * ==============================================================================
 */

export interface DiversityOptions {
  /** Número de productos por fila/línea visible (por defecto 4 en rejilla desktop). */
  rowSize?: number;
  /** Número de productos por página (por defecto 40 en web, 50 en admin). */
  pageSize?: number;
}

/**
 * Obtiene una clave que identifica el modelo exacto del producto para detectar
 * duplicidades idénticas (mismo ASIN, mismo Item ID, mismo duplicate_group o título normalizado).
 */
export function getProductModelKey(product: any): string {
  if (!product) return '';
  if (product.duplicate_group) return `dg:${product.duplicate_group}`;
  if (product.sourceId) return `src:${String(product.sourceId).trim().toLowerCase()}`;
  if (product.asin) return `asin:${String(product.asin).trim().toLowerCase()}`;

  // Comprobar ASIN o Item ID en las URLs
  const urlHaystack = `${product.affiliateUrl || ''} ${product.buyNowUrl || ''}`;
  const asinMatch = urlHaystack.match(/\b(B[0-9A-Z]{9}|[0-9]{9}[0-9A-Z])\b/i);
  if (asinMatch) return `asin:${asinMatch[1].toUpperCase()}`;

  const aliMatch =
    urlHaystack.match(/\/(?:item|goods)\/(?:.*?\/)?(?:ae01|item)?(?:_)?(\d{6,20})\.html/i) ||
    urlHaystack.match(/[?&](?:itemId|productId|productIds)=(\d{6,20})/i);
  if (aliMatch) return `ali:${aliMatch[1]}`;

  // Clave de texto normalizada basada en los términos distintivos del título
  const rawTitle = String(product.title_short || product.title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const stopWords = new Set([
    'de', 'la', 'el', 'en', 'con', 'para', 'y', 'a', 'o', 'un', 'una', 'unos', 'unas',
    'por', 'del', 'al', 'los', 'las', 'the', 'and', 'for', 'with', 'in', 'on', 'at', 'to'
  ]);
  const tokens = rawTitle
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w))
    .slice(0, 4)
    .join(' ');

  return tokens ? `tok:${tokens}` : `id:${String(product.id || '')}`;
}

/**
 * Obtiene el tipo o categoría del producto para la alternancia de tipos en la fila.
 */
export function getProductTypeKey(product: any): string {
  if (!product) return 'otros';
  const raw = String(
    product.subcategory_id ||
    product.productType ||
    product.category ||
    product.category_id ||
    'otros'
  )
    .trim()
    .toLowerCase();
  return raw || 'otros';
}

/**
 * Aplica la regla de alternancia y diversidad sobre un listado de productos
 * previamente ordenado según el criterio de preferencia.
 */
export function applyCatalogDiversity<T = any>(
  products: T[],
  options?: DiversityOptions
): T[] {
  if (!Array.isArray(products) || products.length <= 1) {
    return products ? [...products] : [];
  }

  const rowSize = Math.max(1, options?.rowSize ?? 4);
  const pageSize = Math.max(rowSize, options?.pageSize ?? 40);

  const pool = [...products];
  const result: T[] = [];
  let currentPageModels = new Set<string>();

  while (pool.length > 0) {
    const nextIdx = result.length;
    // Al comenzar una nueva página, se limpia el conjunto de modelos vistos en la página
    if (nextIdx > 0 && nextIdx % pageSize === 0) {
      currentPageModels.clear();
    }

    const prevItem = result.length > 0 ? result[result.length - 1] : null;
    const prevType = prevItem ? getProductTypeKey(prevItem) : null;
    const prevModel = prevItem ? getProductModelKey(prevItem) : null;

    // Modelos presentes en la misma línea/fila actual (últimos rowSize - 1 elementos de la fila)
    const currentPositionInRow = nextIdx % rowSize;
    const recentWindowSize = currentPositionInRow > 0 ? currentPositionInRow : 0;
    const recentRowModels = new Set<string>();
    if (recentWindowSize > 0) {
      for (let k = result.length - recentWindowSize; k < result.length; k++) {
        if (k >= 0) recentRowModels.add(getProductModelKey(result[k]));
      }
    }

    let bestIndex = -1;

    // Prioridad 1:
    //  - No está en la misma línea/fila
    //  - No está repetido en la misma página (evitar duplicidades dentro de la página)
    //  - Tipo alternado respecto al producto inmediatamente anterior
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i];
      const mKey = getProductModelKey(item);
      const tKey = getProductTypeKey(item);
      if (!recentRowModels.has(mKey) && mKey !== prevModel && !currentPageModels.has(mKey) && tKey !== prevType) {
        bestIndex = i;
        break;
      }
    }

    // Prioridad 2:
    //  - No está en la misma línea/fila
    //  - No está repetido en la misma página
    if (bestIndex === -1) {
      for (let i = 0; i < pool.length; i++) {
        const item = pool[i];
        const mKey = getProductModelKey(item);
        if (!recentRowModels.has(mKey) && mKey !== prevModel && !currentPageModels.has(mKey)) {
          bestIndex = i;
          break;
        }
      }
    }

    // Prioridad 3:
    //  - No está en la misma línea/fila
    //  - Tipo alternado respecto al producto inmediatamente anterior
    if (bestIndex === -1) {
      for (let i = 0; i < pool.length; i++) {
        const item = pool[i];
        const mKey = getProductModelKey(item);
        const tKey = getProductTypeKey(item);
        if (!recentRowModels.has(mKey) && mKey !== prevModel && tKey !== prevType) {
          bestIndex = i;
          break;
        }
      }
    }

    // Prioridad 4:
    //  - No está en la misma línea/fila (estricto: no repetir en la misma línea/fila)
    if (bestIndex === -1) {
      for (let i = 0; i < pool.length; i++) {
        const item = pool[i];
        const mKey = getProductModelKey(item);
        if (!recentRowModels.has(mKey) && mKey !== prevModel) {
          bestIndex = i;
          break;
        }
      }
    }

    // Prioridad 5:
    //  - Distinto al anterior inmediato (si todos los restantes del pool coinciden con la fila)
    if (bestIndex === -1) {
      for (let i = 0; i < pool.length; i++) {
        const item = pool[i];
        const mKey = getProductModelKey(item);
        if (mKey !== prevModel) {
          bestIndex = i;
          break;
        }
      }
    }

    // Fallback absoluto: el siguiente disponible en el pool ordenado
    if (bestIndex === -1) {
      bestIndex = 0;
    }

    const [chosen] = pool.splice(bestIndex, 1);
    result.push(chosen);
    currentPageModels.add(getProductModelKey(chosen));
  }

  return result;
}
