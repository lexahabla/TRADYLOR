/**
 * ==============================================================================
 * TRADYLOR — HELPERS MULTIMRED DE ENLACES DE AFILIADO
 * ==============================================================================
 * getAffiliateUrl(network, payload) normaliza la URL de salida para cada red
 * soportada, aplicando los parámetros de tracking correspondientes:
 *
 *   - amazon:    ASIN o URL de producto (/dp/, /gp/product/…) → URL directa a
 *                la cesta de Amazon España con la tag de afiliado
 *                (ver src/utils/amazon.ts).
 *   - aliexpress, awin, impact, ebay: el payload es ya un enlace de la red;
 *                se devuelve tal cual, añadiendo los parámetros utm propios
 *                de Tradylor si no los trae (no altera el tracking propio de
 *                la red, que viaja en otros parámetros).
 *
 * Este helper es la fuente única de verdad para los componentes de salida
 * (ProductCard modo directo, AffiliateLink) y cualquier CTA .exit-cta.
 * ==============================================================================
 */

import { getAmazonAddToCartUrl, isValidAsin, sanitizeAsin, getAmazonAssociateTag } from './amazon';

export type AffiliateNetwork = 'amazon' | 'aliexpress' | 'awin' | 'impact' | 'ebay';

export const AFFILIATE_NETWORKS: readonly AffiliateNetwork[] = [
  'amazon',
  'aliexpress',
  'awin',
  'impact',
  'ebay',
];

/** Nombres legibles para etiquetas de CTA. */
export const NETWORK_LABELS: Record<AffiliateNetwork, string> = {
  amazon: 'Amazon',
  aliexpress: 'AliExpress',
  awin: 'Awin',
  impact: 'Impact',
  ebay: 'eBay',
};

/** Patrón de ASIN dentro de una URL de producto de Amazon. */
const AMAZON_ASIN_IN_URL = /\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?#]|$)/i;

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Añade los parámetros utm de Tradylor a un enlace de red (sin pisar utm
 * existentes ni tocar los parámetros propios de la red de afiliación).
 */
function withTrackingParams(rawUrl: string, network: AffiliateNetwork): string {
  const url = parseHttpUrl(rawUrl);
  if (!url) return rawUrl;
  if (!url.searchParams.has('utm_source')) {
    url.searchParams.set('utm_source', 'tradylor');
    url.searchParams.set('utm_medium', 'affiliate');
    url.searchParams.set('utm_campaign', network);
  }
  return url.toString();
}

/** Trata un payload de Amazon: ASIN directo o URL de producto → cesta con tag. */
function resolveAmazon(payload: string): string {
  // ASIN suelto (p. ej. "B0CGXB4C91").
  if (isValidAsin(payload)) return getAmazonAddToCartUrl(sanitizeAsin(payload));

  // URL de Amazon: extraer el ASIN del path y reconstruir la cesta.
  const url = parseHttpUrl(payload);
  if (url) {
    const match = AMAZON_ASIN_IN_URL.exec(url.pathname);
    if (match) {
      const tag = url.searchParams.get('tag')?.trim() || getAmazonAssociateTag();
      return getAmazonAddToCartUrl(match[1], tag);
    }
    // URL de Amazon sin ASIN reconocible (listas, search…): se respeta tal cual.
    return url.toString();
  }

  return '';
}

/**
 * Devuelve la URL de salida final para la red indicada.
 *
 * @param network Red de afiliación ('amazon' por defecto).
 * @param payload ASIN (amazon) o enlace base de la red (resto).
 * @returns       URL lista para el CTA. Cadena vacía si no hay payload válido.
 */
export function getAffiliateUrl(network: string, payload: string): string {
  const net = (String(network ?? '').trim().toLowerCase() || 'amazon') as AffiliateNetwork;
  const raw = String(payload ?? '').trim();
  if (!raw) return '';

  switch (net) {
    case 'amazon':
      return resolveAmazon(raw);

    case 'aliexpress':
    case 'awin':
    case 'impact':
    case 'ebay':
      return withTrackingParams(raw, net);

    default:
      // Red desconocida: si es una URL válida, se envía con tracking genérico.
      return withTrackingParams(raw, 'amazon');
  }
}
