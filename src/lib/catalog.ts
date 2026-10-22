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

import { products as staticProducts, type Product } from '../data/products';
import { validateProducts, validateSingleProduct } from './validateProducts';
import { dataFile } from './paths';
import { readJsonArrayFile } from './jsonStore';
import { readDeletedIds } from './deletedProducts';

const DATA_FILE_PATH = dataFile('products.json');

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
    // Auditoría "Test & Proof": un producto RECHAZADO no se publica en la web
    // pública (sigue en el catálogo y en el panel con sus motivos, para que el
    // curador lo arregle). Antes se publicaban igual y tylos llegaron a la
    // portada ("Besos y abrazos mochila negra").
    if (String((entry as Product).audit_status || '').trim() === 'rejected') continue;

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

  return merged;
}

/**
 * Clave de ruta canónica de un producto: slug si existe (contrato n8n), id si no.
 * Se usa en /producto/[slug], /checkout/[id] y /api/redirect?id=.
 */
export function productKey(product: Product): string {
  return product.slug ?? product.id;
}

/**
 * Resuelve un producto por slug, id o slug del id.
 * Mantiene compatibles las URLs antiguas (/producto/sony-wh-1000xm5) y las
 * nuevas basadas en slug (/producto/auriculares-wireless-pro).
 */
export function findCatalogProduct(key?: string | null): Product | undefined {
  const needle = (key ?? '').trim().toLowerCase();
  if (!needle) return undefined;

  const products = getCatalogProducts();

  return (
    products.find((p) => p.id.toLowerCase() === needle) ??
    products.find((p) => (p.slug ?? '').toLowerCase() === needle)
  );
}
