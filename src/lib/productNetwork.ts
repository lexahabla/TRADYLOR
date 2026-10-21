import type { Product } from './productStore';

/**
 * Detección de la RED DE AFILIADOS (Amazon, eBay, AliExpress, Etsy…) a la que
 * pertenece un producto del catálogo.
 *
 * El modelo `Product` no guarda la red de forma explícita (los productos
 * llegan del catálogo multi-red, del panel, de n8n o del pipeline), así que se
 * deduce por este orden de señales:
 *
 *  1. `network` explícito en el propio producto.
 *  2. `extra.crossMerchant.networks` (catálogo construido con «Construir Catálogo»).
 *  3. Dominio del enlace de afiliado (amazon.es, aliexpress.com, ebay.es…).
 *  4. Marcadores de red en la query del enlace (awc=, cjdata=, asc=…).
 *  5. ASIN de Amazon.
 *  6. Nombre del comerciante, si ya es el de una red conocida.
 *
 * Es una función pura: no escribe nada en disco (sólo se usa para pintar).
 */

/** Etiquetas legibles de las redes soportadas (ids de src/lib/networks/registry.ts). */
export const NETWORK_LABELS: Record<string, string> = {
  amazon: 'Amazon',
  aliexpress: 'AliExpress',
  ebay: 'eBay',
  etsy: 'Etsy',
  awin: 'Awin',
  cj: 'CJ',
  admitad: 'Admitad',
  tradedoubler: 'Tradedoubler',
  kwanko: 'Kwanko',
  generic: 'Genérica',
};

/** Dominios que identifican la red a la que apunta un enlace de afiliado. */
const HOST_NETWORKS: Array<{ re: RegExp; id: string }> = [
  { re: /(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/i, id: 'amazon' },
  { re: /(^|\.)amzn\.[a-z]{2,4}$/i, id: 'amazon' },
  { re: /(^|\.)a\.co$/i, id: 'amazon' },
  { re: /(^|\.)aliexpress\.[a-z]{2,4}$/i, id: 'aliexpress' },
  { re: /(^|\.)ebay\.[a-z]{2,4}$/i, id: 'ebay' },
  { re: /(^|\.)etsy\.[a-z]{2,4}$/i, id: 'etsy' },
];

/** Parámetros típicos de los deeplinks de cada red (el host es el del comercio). */
const QUERY_NETWORKS: Array<{ re: RegExp; id: string }> = [
  { re: /[?&](awc|aw_deep_link|awin_deep_link)=/i, id: 'awin' },
  { re: /[?&]cjdata=/i, id: 'cj' },
  { re: /[?&]asc=/i, id: 'tradedoubler' },
  { re: /[?&]kwanko_/i, id: 'kwanko' },
  { re: /[?&]admitad_/i, id: 'admitad' },
];

/** Nombres de comerciante que ya son en realidad el nombre de una red. */
const MERCHANT_ALIASES: Record<string, string> = {
  amazon: 'amazon',
  'amazon.es': 'amazon',
  'amazon.com': 'amazon',
  'amazon associates': 'amazon',
  aliexpress: 'aliexpress',
  'aliexpress official': 'aliexpress',
  ebay: 'ebay',
  'ebay official': 'ebay',
  etsy: 'etsy',
  awin: 'awin',
  cj: 'cj',
  admitad: 'admitad',
  tradedoubler: 'tradedoubler',
  kwanko: 'kwanko',
};

/** Deduce el id de red a partir de una URL de afiliado ('' si no se reconoce). */
export function networkFromUrl(url: string | null | undefined): string {
  const raw = String(url ?? '').trim();
  if (!raw) return '';

  let host = '';
  let query = '';
  try {
    const parsed = new URL(raw);
    host = parsed.hostname.toLowerCase();
    query = parsed.search.toLowerCase();
  } catch {
    const hostMatch = raw.match(/^(?:https?:\/\/)?([^/?#]+)/i);
    host = (hostMatch?.[1] ?? '').toLowerCase();
    query = (raw.match(/\?(.*)$/)?.[1] ?? '').toLowerCase();
  }

  for (const { re, id } of HOST_NETWORKS) {
    if (re.test(host)) return id;
  }
  for (const { re, id } of QUERY_NETWORKS) {
    if (re.test(query)) return id;
  }
  return '';
}

/** Id de red del producto ('' si no se puede determinar). */
export function detectNetworkId(product: Partial<Product> | null | undefined): string {
  if (!product) return '';

  const explicit = String(product.network ?? '').trim().toLowerCase();
  if (explicit) return explicit;

  // Catálogo multi-red: «Construir Catálogo» guarda las redes del grupo.
  const crossNetworks = (product as { extra?: { crossMerchant?: { networks?: unknown } } }).extra?.crossMerchant?.networks;
  if (Array.isArray(crossNetworks) && crossNetworks.length > 0) {
    const first = String(crossNetworks[0] ?? '').trim().toLowerCase();
    if (first) return first;
  }

  for (const url of [product.affiliateUrl, product.buyNowUrl]) {
    const id = networkFromUrl(url);
    if (id) return id;
  }

  if (String(product.asin ?? '').trim()) return 'amazon';

  const merchantKey = String(product.merchant ?? '').trim().toLowerCase();
  if (MERCHANT_ALIASES[merchantKey]) return MERCHANT_ALIASES[merchantKey];

  return '';
}

/** Etiqueta legible de un id de red ('' si el id está vacío). */
export function networkLabel(id: string | null | undefined): string {
  const key = String(id ?? '').trim().toLowerCase();
  if (!key) return '';
  if (NETWORK_LABELS[key]) return NETWORK_LABELS[key];
  // Red personalizada creada desde el panel: se muestra capitalizada.
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Red del producto (id + etiqueta) lista para pintar. */
export function getProductNetwork(product: Partial<Product> | null | undefined): { id: string; label: string } {
  const id = detectNetworkId(product);
  return { id, label: networkLabel(id) };
}
