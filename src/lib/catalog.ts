/**
 * ==============================================================================
 * TRADYLOR — CATALOG LOADER
 * ==============================================================================
 *
 * Loads products from:
 *   1. src/data/products.json  (dynamic, API-sourced or admin-managed)
 *   2. src/data/products.ts    (static, curated editorial entries)
 *
 * All products are validated against the Zod schema at load time.
 * Invalid entries are logged and skipped (graceful degradation).
 * ==============================================================================
 */

import fs from 'node:fs';
import { products as staticProducts, type Product } from '../data/products';
import { validateProducts, validateSingleProduct } from './validateProducts';
import { dataFile } from './paths';
import { readJsonArrayFile } from './jsonStore';
import { readDeletedIds, DELETED_FILE_PATH } from './deletedProducts';

const DATA_FILE_PATH = dataFile('products.json');

/**
 * Caché en memoria del catálogo normalizado, invalidada por la fecha de
 * modificación de `products.json` + `deleted-product-ids.json`.
 *
 * `getCatalogProducts()` se llama decenas de veces por petición (home, ficha,
 * búsqueda, marketing insights, y sobre todo el dashboard de Tráfico y Ventas,
 * que la invoca una vez por cada producto de su "top 5/10" y por cada mes en
 * curso). Sin caché, cada llamada releía products.json del disco Y
 * revalidaba con Zod TODO el catálogo desde cero — con un catálogo grande
 * esto bloqueaba el event loop de Node varios segundos y hacía que ese
 * dashboard (y el resto del sitio, por ser un único proceso) tardara mucho
 * en cargar o pareciera "caído". Al no cambiar los ficheros entre peticiones
 * normales, se reutiliza el resultado tal cual (misma salida, cero coste).
 */
let catalogCache: { products: Product[]; key: string } | null = null;

function statMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/** Nested objects that must be merged field-by-field instead of replaced. */
const NESTED_KEYS = [
  'pricing',
  'conversionHooks',
  'investigation',
  'affiliate',
  'alternatives',
] as const;

/** A value is "unset" when it would degrade the curated data. */
function isUnset(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * Merges a live (products.json) product over a curated (products.ts) one.
 * JSON wins for live fields (price, availability, pros/cons), but curated
 * structured fields such as satisfactionScore, brand and productType survive
 * when the JSON entry does not define them.
 */
function mergeProducts(base: Product, overlay: Product): Product {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    if (isUnset(value)) continue;

    if ((NESTED_KEYS as readonly string[]).includes(key) && value && typeof value === 'object') {
      const baseNested = (base as unknown as Record<string, unknown>)[key];
      merged[key] = baseNested && typeof baseNested === 'object'
        ? { ...baseNested, ...value }
        : value;
      continue;
    }

    merged[key] = value;
  }

  return merged as unknown as Product;
}

export function getCatalogProducts(): Product[] {
  // Caché por mtime: si ninguno de los dos ficheros cambió desde la última
  // llamada, se devuelve el resultado ya calculado (ver comentario arriba).
  const cacheKey = `${statMtime(DATA_FILE_PATH)}:${statMtime(DELETED_FILE_PATH)}`;
  if (catalogCache && catalogCache.key === cacheKey) return [...catalogCache.products];

  // Lectura tolerante: si el JSON está a medio escribir, `readJsonArrayFile`
  // reintenta y devuelve la última versión válida (antes devolvía `[]` y la
  // web se quedaba sin catálogo).
  const rawJson = readJsonArrayFile<unknown>(DATA_FILE_PATH);

  const mergedRaw: unknown[] = [];
  const liveIds = new Set<string>();

  const deletedIds = new Set(readDeletedIds());

  for (const entry of rawJson) {
    if (!entry || typeof entry !== 'object') continue;
    const probe = validateSingleProduct(entry);
    if (!probe) continue;
    // Respetar tombstones: un producto borrado desde el admin no debe reaparecer.
    if (deletedIds.has(probe.id)) continue;
    // Auditoría "Test & Proof": los productos rechazados SÍ se publican en la
    // web pública (el propietario lo pidió para poder ver todos sus productos
    // asignados a categorías). El filtro de rechazo queda desactivado.
    // if (String((entry as Product).audit_status || '').trim() === 'rejected') continue;

    const live = entry as Product;
    const curated = staticProducts.find((sp) => sp.id === probe.id);

    mergedRaw.push(curated ? mergeProducts(curated, live) : live);
    liveIds.add(probe.id);
  }

  const curatedOnly = staticProducts.filter((sp) => !liveIds.has(sp.id) && !deletedIds.has(sp.id));

  // Normalizes merged entries (flat -> schema -> flat) before handing them
  // to the components, so structured trust metrics are available everywhere.
  const merged = [...validateProducts(mergedRaw), ...curatedOnly];

  console.log(
    `[Catalog] Loaded ${merged.length} products (${mergedRaw.length} live + ${curatedOnly.length} curated)`
  );

  catalogCache = { products: merged, key: cacheKey };
  return [...merged];
}

/**
 * Clave de ruta canónica de un producto: slug si existe (contrato n8n), id si no.
 * Se usa en /producto/[slug], /checkout/[id] y /api/redirect?id=.
 */
/**
 * Invalida el caché en memoria del catálogo (`catalogCache`). Se debe llamar
 * después de cualquier escritura en `products.json` (alta, edición, borrado,
 * importación JSON de Amazon, etc.) para que `getCatalogProducts()` devuelva
 * los datos frescos en la próxima petición en lugar del snapshot en memoria.
 */
export function invalidateCatalogCache(): void {
  catalogCache = null;
}

export function productKey(product: Product): string {
  return (product.slug && product.slug.trim()) || product.id;
}

/**
 * Resuelve un producto por slug, id o slug del id.
 * Mantiene compatibles las URLs antiguas (/producto/sony-wh-1000xm5) y las
 * nuevas basadas en slug (/producto/auriculares-wireless-pro).
 */
export function findCatalogProduct(key?: string | null): Product | undefined {
  const raw = (key ?? '').trim();
  if (!raw) return undefined;
  const needle = raw.toLowerCase();
  let decodedNeedle = needle;
  try {
    decodedNeedle = decodeURIComponent(needle);
  } catch {}

  const products = getCatalogProducts();

  const found = (
    products.find((p) => (p.slug ?? '').toLowerCase() === needle) ??
    products.find((p) => p.id.toLowerCase() === needle) ??
    products.find((p) => (p.slug ?? '').toLowerCase() === decodedNeedle) ??
    products.find((p) => p.id.toLowerCase() === decodedNeedle)
  );
  if (found) return found;

  // Fallback: búsqueda tolerante directa en products.json para que los productos
  // en borrador o pendientes de auditoría puedan visualizarse individualmente
  // desde el panel de administración.
  try {
    const rawJson = readJsonArrayFile<any>(DATA_FILE_PATH);
    const rawMatch = rawJson.find((p) => {
      if (!p || typeof p !== 'object') return false;
      const pid = String(p.id ?? '').toLowerCase();
      const pslug = String(p.slug ?? '').toLowerCase();
      return pslug === needle || pid === needle || pslug === decodedNeedle || pid === decodedNeedle;
    });
    if (rawMatch) {
      const probe = validateSingleProduct(rawMatch);
      return (probe ?? rawMatch) as Product;
    }
  } catch (err) {
    console.warn('[Catalog] Error en fallback de findCatalogProduct:', err);
  }

  return undefined;
}
