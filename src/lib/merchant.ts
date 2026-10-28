/**
 * ==============================================================================
 * TRADYLOR — DETECCIÓN DE COMERCIO DESDE UNA URL
 * ==============================================================================
 * Heurística compartida (mapea el dominio de un enlace a un nombre de
 * comercio legible). Antes vivía duplicada dentro de `/api/products/add.ts` y
 * `/api/admin/add-product.ts`; se extrae aquí para que el enriquecimiento
 * masivo (`/api/admin/enrich-bulk.ts`) pueda rellenar `merchant`/
 * `fulfillmentProvider` cuando falten, SIN tocar esos dos endpoints (su
 * comportamiento ya probado se deja intacto).
 * ==============================================================================
 */

/** Deduce el nombre del comercio a partir de la URL del producto. */
export function detectMerchantFromHost(urlStr: string | null | undefined): string {
  const raw = String(urlStr ?? '').trim();
  if (!raw) return '';
  try {
    const { hostname } = new URL(raw);
    const host = hostname.toLowerCase();

    if (host.includes('amazon.') || host === 'amzn.to' || host === 'a.co' || host === 'amzn.eu' || host === 'amzn.asia') return 'Amazon';
    if (host.includes('pccomponentes.')) return 'PcComponentes';
    if (host.includes('elcorteingles.')) return 'El Corte Inglés';
    if (host.includes('mediamarkt.')) return 'MediaMarkt';
    if (host.includes('aliexpress.')) return 'AliExpress';
    if (host.includes('ebay.')) return 'eBay';
    if (host.includes('etsy.')) return 'Etsy';
    if (host.includes('fnac.')) return 'Fnac';
    if (host.includes('carrefour.')) return 'Carrefour';
    if (host.includes('apple.')) return 'Apple';

    const parts = host.replace(/^www\./, '').split('.');
    return parts[0] ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1) : '';
  } catch {
    return '';
  }
}

/** Distribuidor (envío/pago/garantía) por defecto cuando no se declara uno propio. */
export function defaultFulfillmentFor(merchant: string): string {
  return merchant === 'Amazon' ? 'Amazon Logistics' : merchant;
}
