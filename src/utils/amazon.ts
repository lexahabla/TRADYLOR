/**
 * ==============================================================================
 * TREIDILOR — HELPERS DE AMAZON
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
 * Enlace de salida de Amazon España para un ASIN: la PÁGINA DEL PRODUCTO con el tag de afiliado (/dp/ASIN?tag=…).
 *
 * Histórico: este helper construía la URL de la CESTA (/gp/aws/cart/add.html) y por eso conserva su nombre; el enlace de afiliado debe
 * llevar a la ficha del producto, así que ahora devuelve lo mismo que getAmazonProductUrl. Los enlaces de cesta ya guardados en
 * fichas existentes se convierten con amazonCartToProductUrl.
 *
 * @param asin  Código ASIN del producto (se sanitiza automáticamente).
 * @param tag   Tag de afiliado opcional; por defecto PUBLIC_AMAZON_ASSOCIATE_TAG.
 * @returns     URL de la ficha del producto. Cadena vacía si el ASIN no es válido.
 */
export function getAmazonAddToCartUrl(asin: string, tag?: string): string {
  return getAmazonProductUrl(asin, tag);
}

/**
 * Convierte un enlace de CESTA de Amazon (…/gp/aws/cart/add.html?ASIN.1=…&AssociateTag=…) en el de la FICHA del producto
 * (https://<mismo dominio>/dp/<ASIN>?tag=<mismo tag>). Cualquier otra URL (no Amazon, otra ruta, sin ASIN válido) se devuelve igual.
 */
export function amazonCartToProductUrl(url: string): string {
  try {
    const parsed = new URL(String(url ?? '').trim());
    if (!/(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/i.test(parsed.hostname)) return url;
    if (!/\/gp\/aws\/cart\/add\.html$/i.test(parsed.pathname)) return url;
    const asin = sanitizeAsin(parsed.searchParams.get('ASIN.1') ?? parsed.searchParams.get('ASIN') ?? '');
    if (!ASIN_RE.test(asin)) return url;
    const tag = (parsed.searchParams.get('AssociateTag') ?? parsed.searchParams.get('tag') ?? '').trim() || getAmazonAssociateTag();
    return `${parsed.protocol}//${parsed.hostname}/dp/${asin}?${new URLSearchParams({ tag }).toString()}`;
  } catch {
    return url;
  }
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

/**
 * Extrae el ASIN de una URL de Amazon O valida un ASIN recibido directamente.
 * Devuelve el ASIN normalizado (10 caracteres alfanuméricos, mayúsculas) o
 * lanza un error descriptivo si no se puede obtener uno válido.
 *
 * @param input  URL completa de Amazon o un ASIN directo (10 chars).
 * @returns      ASIN normalizado y validado.
 */
export function extractOrValidateAsin(input: string): string {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('No se proporcionó una URL ni un ASIN de Amazon.');
  if (isValidAsin(trimmed)) return sanitizeAsin(trimmed);
  const extracted = extractAsinFromUrl(trimmed);
  if (extracted) return extracted;
  throw new Error(`No se pudo extraer un ASIN válido de: ${trimmed}`);
}

