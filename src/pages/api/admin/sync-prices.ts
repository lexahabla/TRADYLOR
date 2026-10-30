import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { readProductsFromFile, writeProductsToFile, type Product } from '../../../lib/productStore';
import { recordPricePoint, flushPriceHistory } from '../../../lib/priceHistory';
import { scrapeAmazonProduct, normalizeScrapedAmazonData } from '../../../lib/amazonImport';
import { extractOrValidateAsin } from '../../../utils/amazon';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Extrae el ASIN de Amazon si el producto lo tiene (por sourceId o en sus enlaces). */
function getProductAsin(p: Product): string | null {
  if (p.sourceId && /^[A-Z0-9]{10}$/i.test(p.sourceId.trim())) {
    return p.sourceId.trim().toUpperCase();
  }
  const urlCandidate = p.buyNowUrl || p.affiliateUrl || '';
  if (urlCandidate) {
    const asin = extractOrValidateAsin(urlCandidate);
    if (asin) return asin.toUpperCase();
  }
  return null;
}

export interface SyncPriceResult {
  id: string;
  title: string;
  network?: string;
  asin?: string;
  oldPrice: number;
  newPrice?: number;
  priceChanged: boolean;
  status: 'updated' | 'unchanged' | 'skipped' | 'error';
  message?: string;
}

/**
 * POST /api/admin/sync-prices
 *
 * Sincroniza los precios actuales de los productos consultando la API en vivo
 * (Amazon mediante ScraperAPI). Actualiza `product.price`, `product.originalPrice`,
 * `product.lastPriceSync`, registra un punto en el histórico de precios (`priceHistory`)
 * y guarda los cambios en el volumen de datos de forma atómica.
 *
 * Body opcional:
 *   { "productIds": ["prod_1", "prod_2"] }   -> Sincroniza los seleccionados
 *   { "limit": 10 }                          -> Sincroniza los 10 con fecha más antigua
 */
export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const allProducts = readProductsFromFile();
  if (!allProducts.length) {
    return json({ success: false, message: 'No hay productos en el catálogo.' }, 400);
  }

  let targets: Product[] = [];
  const requestedIds = Array.isArray(body?.productIds) ? (body.productIds as string[]) : [];

  if (requestedIds.length > 0) {
    const idSet = new Set(requestedIds);
    targets = allProducts.filter((p) => idSet.has(p.id));
  } else {
    // Si no se pasan IDs específicos, tomar los que lleven más tiempo sin actualizar (o nunca sincronizados)
    const limit = Math.min(Math.max(Number(body?.limit) || 10, 1), 30);
    targets = [...allProducts]
      .sort((a, b) => {
        const timeA = a.lastPriceSync ? new Date(a.lastPriceSync).getTime() : 0;
        const timeB = b.lastPriceSync ? new Date(b.lastPriceSync).getTime() : 0;
        return timeA - timeB;
      })
      .slice(0, limit);
  }

  if (!targets.length) {
    return json({ success: false, message: 'No se encontraron productos para sincronizar.' }, 404);
  }

  const results: SyncPriceResult[] = [];
  let updatedCount = 0;
  let fileChanged = false;

  for (const product of targets) {
    const asin = getProductAsin(product);
    const oldPrice = Number(product.price) || 0;

    // Si es Amazon (tiene ASIN)
    if (asin) {
      try {
        const raw = await scrapeAmazonProduct(asin, { maxRetries: 2, retryDelayMs: 1500 });
        const normalized = normalizeScrapedAmazonData(raw);

        if (normalized.price && normalized.price > 0) {
          const newPrice = Math.round(normalized.price * 100) / 100;
          const priceChanged = Math.abs(newPrice - oldPrice) > 0.01;

          product.price = newPrice;
          if (normalized.originalPrice && normalized.originalPrice > newPrice) {
            product.originalPrice = Math.round(normalized.originalPrice * 100) / 100;
          }
          if (normalized.rating != null && normalized.rating > 0) {
            product.rating = normalized.rating;
          }
          if (normalized.reviewsCount != null && normalized.reviewsCount > 0) {
            product.reviewsCount = normalized.reviewsCount;
          }

          product.lastPriceSync = new Date().toISOString();
          recordPricePoint(product.id, newPrice);
          fileChanged = true;

          if (priceChanged) updatedCount++;

          results.push({
            id: product.id,
            title: product.title_short || product.title,
            network: 'Amazon',
            asin,
            oldPrice,
            newPrice,
            priceChanged,
            status: priceChanged ? 'updated' : 'unchanged',
            message: priceChanged
              ? `Precio actualizado: ${oldPrice.toFixed(2)} € -> ${newPrice.toFixed(2)} €`
              : `Precio sin cambios (${newPrice.toFixed(2)} €)`,
          });
        } else {
          // No devolvió precio válido (posible fuera de stock o variación no seleccionada)
          product.lastPriceSync = new Date().toISOString();
          fileChanged = true;
          results.push({
            id: product.id,
            title: product.title_short || product.title,
            network: 'Amazon',
            asin,
            oldPrice,
            priceChanged: false,
            status: 'unchanged',
            message: 'La tienda no reportó un precio disponible actualmente.',
          });
        }
      } catch (err: any) {
        results.push({
          id: product.id,
          title: product.title_short || product.title,
          network: 'Amazon',
          asin,
          oldPrice,
          priceChanged: false,
          status: 'error',
          message: err?.message || 'Error al conectar con la tienda.',
        });
      }
    } else {
      // Producto de otra red sin sincronizador directo
      results.push({
        id: product.id,
        title: product.title_short || product.title,
        network: product.merchant || product.network_label || 'Otro',
        oldPrice,
        priceChanged: false,
        status: 'skipped',
        message: 'Red sin conector en vivo automático (requiere actualización manual).',
      });
    }
  }

  if (fileChanged) {
    writeProductsToFile(allProducts);
    await flushPriceHistory();
  }

  return json({
    success: true,
    total: targets.length,
    updated: updatedCount,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
    errors: results.filter((r) => r.status === 'error').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
  });
};
