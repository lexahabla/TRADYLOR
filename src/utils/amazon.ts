/**
 * ==============================================================================
 * TRADYLOR — HELPERS DE AMAZON
 * ==============================================================================
 * Utilidades para construir enlaces de salida hacia Amazon España a partir de
 * un ASIN (cesta de compra con el tag de afiliado asociado).
 *
 * La tag se toma de la variable de entorno pública PUBLIC_AMAZON_ASSOCIATE_TAG
 * (declarada en Easy Panel / .env). Se mantienen dos fallbacks por seguridad:
 *   1. AMAZON_ASSOCIATE_TAG (tag de servidor, si existe).
 *   2. El tag legado del proyecto (tradylor-21).
 * ==============================================================================
 */

const FALLBACK_ASSOCIATE_TAG = 'tradylor-21';

/** Formato canónico de ASIN: 10 caracteres alfanuméricos en mayúsculas. */
const ASIN_RE = /^[A-Z0-9]{10}$/;

/** Devuelve la tag de afiliado de Amazon (env pública con fallbacks). */
export function getAmazonAssociateTag(): string {
  const fromPublic =
    typeof import.meta !== 'undefined' && import.meta.env
      ? import.meta.env.PUBLIC_AMAZON_ASSOCIATE_TAG
      : undefined;
  const fromServer =
    typeof process !== 'undefined' && process.env
      ? process.env.AMAZON_ASSOCIATE_TAG
      : undefined;

  for (const candidate of [fromPublic, fromServer]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return FALLBACK_ASSOCIATE_TAG;
}

/**
 * Normaliza un ASIN recibido de cualquier origen:
 * quita espacios, guiones y convierte a mayúsculas.
 */
export function sanitizeAsin(asin: string): string {
  return String(asin ?? '')
    .trim()
    .replace(/[\s-]+/g, '')
    .toUpperCase();
}

/**
 * Devuelve true si el valor ya normalizado tiene forma de ASIN válido.
 */
export function isValidAsin(asin: string): boolean {
  return ASIN_RE.test(sanitizeAsin(asin));
}

/**
 * Construye la URL directa a la cesta de compra de Amazon España
 * (https://www.amazon.es/gp/aws/cart/add.html) para un ASIN concreto.
 *
 * @param asin  Código ASIN del producto (se sanitiza automáticamente).
 * @param tag   Tag de afiliado opcional; por defecto PUBLIC_AMAZON_ASSOCIATE_TAG.
 * @returns     URL lista para usar en el CTA de salida. Cadena vacía si el ASIN no es válido.
 */
export function getAmazonAddToCartUrl(asin: string, tag?: string): string {
  const clean = sanitizeAsin(asin);
  if (!ASIN_RE.test(clean)) return '';

  const associateTag =
    typeof tag === 'string' && tag.trim() ? tag.trim() : getAmazonAssociateTag();

  const params = new URLSearchParams({
    'ASIN.1': clean,
    'Quantity.1': '1',
    AssociateTag: associateTag,
  });

  return `https://www.amazon.es/gp/aws/cart/add.html?${params.toString()}`;
}

/**
 * Enlace de producto de Amazon con tag de afiliado (/dp/ASIN?tag=…).
 * Es la vía "clic → Comprar ahora → misma tramitación de pago Chewbacca"
 * que SÍ acredita comisión (las URLs /checkout/p no la acreditan).
 */
export function getAmazonProductUrl(asin: string, tag?: string): string {
  const clean = sanitizeAsin(asin);
  if (!ASIN_RE.test(clean)) return '';

  const associateTag =
    typeof tag === 'string' && tag.trim() ? tag.trim() : getAmazonAssociateTag();

  const params = new URLSearchParams({ tag: associateTag });
  return `https://www.amazon.es/dp/${clean}?${params.toString()}`;
}

/**
 * Añade el parámetro `tag` a una URL de Amazon que no lo lleve
 * (best effort: en rutas de producto/cesta acredita comisión; en rutas
 * /checkout/p Amazon lo ignora, pero no altera la navegación).
 */
export function appendAmazonTag(url: string, tag?: string): string {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/i.test(parsed.hostname)) return url;
    if (parsed.searchParams.has('tag')) return parsed.toString();
    const associateTag =
      typeof tag === 'string' && tag.trim() ? tag.trim() : getAmazonAssociateTag();
    parsed.searchParams.set('tag', associateTag);
    return parsed.toString();
  } catch {
    return url;
  }
}

const AMAZON_ASIN_IN_PATH_RE = /\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?#]|$)/i;
const ASIN_QUERY_RE = /[?&]asin=([A-Z0-9]{10})(?:[&#]|$)/i;

/**
 * Extrae el ASIN de una URL de Amazon (…/dp/B0…, …/gp/product/B0…, ?asin=B0…)
 * o de cualquier otra URL que lo contenga en el path. Devuelve '' si no hay ASIN.
 */
export function extractAsinFromUrl(url: string): string {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  const path = (() => {
    try {
      return new URL(raw).pathname + new URL(raw).search;
    } catch {
      return raw;
    }
  })();
  const match = AMAZON_ASIN_IN_PATH_RE.exec(path) || ASIN_QUERY_RE.exec(path);
  return match ? match[1].toUpperCase() : '';
}

