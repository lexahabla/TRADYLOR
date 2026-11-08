/**
 * ==============================================================================
 * TREIDILOR — MARCA REAL DEL FABRICANTE (nunca el nombre de una tienda)
 * ==============================================================================
 * Regla única de validación para TODAS las vías de ingesta (importación JSON,
 * API v1, conectores de red, alta manual, scraping) y para la lectura del
 * catálogo:
 *
 *  1. Si la marca guardada es un fabricante válido, se conserva.
 *  2. Si es el nombre de un comercio o de una red («AliExpress», «ebay»,
 *     «Amazon», «[object Object]»…), NO es una marca: se descarta.
 *  3. Entonces se busca la marca del fabricante en las especificaciones
 *     estructuradas del producto (Marca, Brand, Fabricante, Manufacturer…).
 *  4. Si no hay dato fiable, la ficha queda SIN marca. Nunca se deduce del
 *     título ni se inventa.
 *
 * Función pura y sin dependencias de disco.
 * ==============================================================================
 */

import { normalizeBrand } from './offerIdentity';

type AnyRecord = Record<string, any>;

/** Nombres de comercios/redes que NO son fabricantes (clave normalizada). */
const MERCHANT_BRAND_KEYS = new Set([
  'aliexpress', 'aliexpresscom', 'ali express', 'amazon', 'amazones', 'amazoncom', 'amazon es', 'ebay', 'temu', 'etsy', 'awin', 'cj',
  'cjaffiliate', 'admitad', 'tradedoubler', 'kwanko', 'walmart', 'pccomponentes', 'mediamarkt', 'elcorteingles', 'fnac', 'vendedor',
  'tienda', 'store', 'shop', 'marketplace', 'generico', 'generic', 'sinmarca', 'sin marca', 'nobrand', 'no brand', 'unbranded', 'otros',
  'objectobject', 'null', 'undefined',
]);

/** Claves de especificación que contienen la marca del fabricante (normalizadas: sin tildes, minúsculas). */
const SPEC_BRAND_KEYS = [
  'marca', 'brand', 'brand name', 'brandname', 'nombre de la marca', 'marca del producto', 'fabricante', 'manufacturer', 'marca fabricante',
];

const foldKey = (value: string): string =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** ¿Este texto es el nombre de una tienda, una red o un marcador vacío (no un fabricante)? */
export function isMerchantOrPlaceholderBrand(raw: unknown, merchant?: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'object') return true; // «[object Object]»
  const text = String(raw).trim();
  if (!text || /^[-—–?*.]+$/.test(text)) return true;
  const folded = foldKey(text);
  if (!folded) return true;
  if (MERCHANT_BRAND_KEYS.has(folded) || MERCHANT_BRAND_KEYS.has(folded.replace(/ /g, ''))) return true;
  const own = normalizeBrand(text).key;
  const shop = normalizeBrand(typeof merchant === 'string' ? merchant : undefined).key;
  return own !== '' && shop !== '' && own === shop;
}

/** Marca declarada en las especificaciones (nunca deducida del título). Cadena vacía si no hay. */
export function brandFromSpecs(specs: unknown, merchant?: unknown): string {
  if (!specs || typeof specs !== 'object' || Array.isArray(specs)) return '';
  for (const [name, value] of Object.entries(specs as AnyRecord)) {
    if (!SPEC_BRAND_KEYS.includes(foldKey(String(name)))) continue;
    if (value === null || value === undefined || typeof value === 'object') continue;
    const text = String(value).trim();
    if (!text || text.length > 60) continue;
    if (isMerchantOrPlaceholderBrand(text, merchant)) continue;
    const cleaned = normalizeBrand(text).display;
    if (cleaned && !isMerchantOrPlaceholderBrand(cleaned, merchant)) return cleaned;
  }
  return '';
}

/**
 * Marca real del fabricante para una ficha, o '' si no hay dato fiable.
 * Conserva una marca válida; sustituye la que es una tienda por la de las especificaciones.
 */
export function resolveBrand(product: AnyRecord): string {
  const current = typeof product.brand === 'string' ? product.brand : '';
  if (current && !isMerchantOrPlaceholderBrand(current, product.merchant)) return normalizeBrand(current).display || current.trim();
  return brandFromSpecs(product.specs, product.merchant);
}

/**
 * Devuelve la ficha con la marca corregida (misma referencia si no cambia nada).
 * Respeta los campos bloqueados por el usuario (`extra.lockedFields` con «brand»).
 */
export function withResolvedBrand<T extends AnyRecord>(product: T): T {
  if (!product || typeof product !== 'object') return product;
  const locked: unknown = product.extra?.lockedFields;
  if (Array.isArray(locked) && locked.includes('brand')) return product;
  const resolved = resolveBrand(product);
  const current = typeof product.brand === 'string' ? product.brand : undefined;
  if (resolved === (current ?? '')) return product;
  if (!resolved && current === undefined) return product;
  const next: AnyRecord = { ...product };
  if (resolved) next.brand = resolved;
  else delete next.brand;
  return next as T;
}
