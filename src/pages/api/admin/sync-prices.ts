import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { readProductsFromFile } from '../../../lib/productStore';
import { isRefreshable, refreshOffers, type OfferResult } from '../../../lib/offerRefresh';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
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

function toLegacy(result: OfferResult, asin?: string): SyncPriceResult {
  const status: SyncPriceResult['status'] =
    result.status === 'updated'
      ? 'updated'
      : result.status === 'error'
        ? 'error'
        : result.status === 'no_source'
          ? 'skipped'
          : 'unchanged';
  return {
    id: result.id,
    title: result.title,
    network: result.network,
    asin,
    oldPrice: result.priceBefore ?? 0,
    newPrice: result.priceAfter,
    priceChanged: result.changes.some((change) => change.startsWith('precio')),
    status,
    message: result.message,
  };
}

/**
 * POST /api/admin/sync-prices
 *
 * Compatibilidad con el panel actual: delega en el servicio único de
 * actualización (lib/offerRefresh.ts), con la misma validación, cola, bloqueo
 * de solapes, observaciones fechadas e histórico que el programador.
 *
 * Body opcional:
 *   { "productIds": ["prod_1", "prod_2"] }   -> Sincroniza los seleccionados
 *   { "limit": 10 }                          -> Sincroniza los 10 con la verificación más antigua
 *
 * Consume créditos de la fuente (Amazon vía ScraperAPI).
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

  const requestedIds = Array.isArray(body?.productIds) ? (body.productIds as string[]) : [];
  let ids: string[];
  if (requestedIds.length > 0) {
    const wanted = new Set(requestedIds);
    ids = allProducts.filter((p) => wanted.has(p.id)).map((p) => p.id);
  } else {
    const limit = Math.min(Math.max(Number(body?.limit) || 10, 1), 30);
    const verifiedAt = (p: (typeof allProducts)[number]): number => {
      const iso = (p.extra as Record<string, any> | undefined)?.refresh?.lastVerifiedAt ?? p.lastPriceSync;
      return iso ? new Date(iso).getTime() : 0;
    };
    // SÓLO fichas que se pueden volver a consultar (Amazon con ASIN). Antes el lote tomaba los 10 con la verificación más antigua de
    // TODO el catálogo: las de otras redes (sin re-consulta) nunca se verifican, ocupaban siempre esos puestos y las de Amazon
    // con el precio mal no llegaban a actualizarse. Primero las NUNCA verificadas (las importadas) y después las más antiguas.
    const pool = allProducts.filter((p) => isRefreshable(p));
    if (!pool.length) {
      return json({ success: false, message: 'No hay productos de Amazon con ASIN que se puedan actualizar en el catálogo.' }, 404);
    }
    ids = [...pool].sort((a, b) => verifiedAt(a) - verifiedAt(b)).slice(0, limit).map((p) => p.id);
  }

  if (!ids.length) {
    return json({ success: false, message: 'No se encontraron productos para sincronizar.' }, 404);
  }

  const report = await refreshOffers({ ids, mode: 'manual', betweenMs: 1500 });
  if (!report) {
    return json({ success: false, message: 'Ya hay una actualización en curso. Inténtalo cuando termine.' }, 409);
  }

  const byId = new Map(allProducts.map((p) => [p.id, p]));
  const results = report.results.map((result) => toLegacy(result, byId.get(result.id)?.asin));

  return json({
    success: true,
    total: report.total,
    updated: results.filter((r) => r.status === 'updated').length,
    priceCorrected: results.filter((r) => r.priceChanged).length,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
    errors: results.filter((r) => r.status === 'error').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    results,
  });
};
