/**
 * ==============================================================================
 * TRADYLOR — ENDPOINT DE SALIDA / TRANSICIÓN DE COMPRA DELEGADA
 * ==============================================================================
 *
 * GET /api/redirect?id=<slug|id>&src=<origen>
 *
 * FUNCIONAMIENTO:
 *  1. Resuelve el producto por slug canónico o id legado.
 *  2. Registra el clic de salida (analítica interna + webhook opcional de n8n).
 *  3. Devuelve HTTP 302 hacia la URL de compra directa (buildPurchaseUrl):
 *     deep link de cesta de Amazon cuando se detecta ASIN, buyNowUrl del
 *     producto si existe o, en su defecto, el affiliateUrl real.
 *
 * CRO / SEGURIDAD:
 *  ✓ El enlace de afiliado NUNCA se expone en el HTML ni en el JS del cliente:
 *    sólo viaja en la cabecera Location de la respuesta del servidor.
 *  ✓ 302 (temporal) permite rotar affiliateUrl sin problemas de caché.
 *  ✓ Cache-Control: no-store + X-Robots-Tag: noindex evitan que proxies o
 *    rastreadores archiven la URL de destino.
 *  ✓ El botón de la pantalla puente muestra la animación de conexión
 *    ("Conectando con el almacén oficial…") y luego navega a esta ruta.
 * ==============================================================================
 */
export const prerender = false;

import type { APIRoute } from 'astro';
import { findCatalogProduct, productKey } from '../../lib/catalog';
import { trackEvent } from '../../lib/analytics';
import { buildPurchaseUrl } from '../../lib/purchaseUrl';

function redirectHeaders(location: string): Headers {
  return new Headers({
    Location: location,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
}

/** Payload de telemetría hacia n8n (mismo contrato JSON que el catálogo). */
function buildClickPayload(
  product: NonNullable<ReturnType<typeof findCatalogProduct>>,
  source: string,
  purchaseUrl: string,
) {
  return {
    event: 'delegated_checkout_exit',
    id: product.id,
    slug: productKey(product),
    title: product.title,
    category: product.category,
    referencePrice: product.price,
    specs: product.specs ?? {},
    analystVerdict: product.verdict ?? '',
    pros: product.pros,
    cons: product.cons,
    fulfillmentProvider: product.fulfillmentProvider ?? product.merchant,
    affiliateDeepLink: product.affiliateUrl,
    purchaseUrl,
    source: source || 'direct',
    clickedAt: new Date().toISOString(),
  };
}

async function forwardClickToWebhook(webhookUrl: string, payload: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    console.warn('[Redirect] No se pudo notificar al webhook de n8n:', error);
  } finally {
    clearTimeout(timer);
  }
}

export const GET: APIRoute = async ({ url }) => {
  const key = url.searchParams.get('id') ?? url.searchParams.get('slug');
  const source = (url.searchParams.get('src') ?? '').slice(0, 60);
  const network = (url.searchParams.get('network') ?? '').trim().toLowerCase();

  const product = findCatalogProduct(key);

  // Producto desconocido o sin enlace de afiliado → retorno limpio al inicio.
  if (!product || !product.affiliateUrl) {
    return new Response(null, { status: 302, headers: redirectHeaders('/') });
  }

  // Comparativa multitienda: salida a OTRA red detectada automáticamente por
  // «Construir Catálogo» (extra.crossMerchant.affiliateUrls). Sin match válido,
  // se usa el comportamiento normal (comprar en la tienda principal).
  const crossMerchantUrls = (product as { extra?: { crossMerchant?: { affiliateUrls?: Record<string, string> } } })
    .extra?.crossMerchant?.affiliateUrls;
  const crossMerchantUrl = network && crossMerchantUrls ? crossMerchantUrls[network] : undefined;

  const destination = crossMerchantUrl || buildPurchaseUrl(product) || product.affiliateUrl;

  // 1. Registro del clic de salida (cola en memoria, se persiste en segundo plano).
  trackEvent({
    type: 'outbound_click',
    productId: product.id,
    path: source ? `/${source}` : undefined,
    source: 'redirect',
  });

  // 2. Telemetría opcional hacia n8n (fire-and-forget, no bloquea la salida).
  const webhookUrl = process.env.N8N_CLICK_WEBHOOK_URL ?? import.meta.env.N8N_CLICK_WEBHOOK_URL;
  if (typeof webhookUrl === 'string' && webhookUrl.startsWith('http')) {
    void forwardClickToWebhook(webhookUrl, buildClickPayload(product, source, destination));
  }

  // 3. Redirección 302 hacia la tienda de destino (compra directa).
  return new Response(null, { status: 302, headers: redirectHeaders(destination) });
};
