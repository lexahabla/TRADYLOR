import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { runMassCatalogPipeline, processAdaptedProductsBatch, MassCatalogPipeline } from '../../../../lib/services/massCatalogPipeline';
import { createAdapter, type AdaptedProduct } from '../../../../lib/services/affiliateAdapter';
import { readRawAffiliateProducts, writeRawAffiliateProducts } from '../../../../lib/services/databaseSchema';
import { hasTextCredentials, textProvider } from '../../../../lib/ai';
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const prerender = false;

/**
 * POST /api/admin/auto-curate
 *
 * Pipeline masivo de auto-curación para el panel de administración.
 *
 * Body JSON:
 * {
 *   "mode": "full" | "batch" | "raw-reprocess",
 *   "network": "amazon" | "aliexpress" | "awin" | ...,
 *   "limit": 50,                    // opcional, 0 = todos
 *   "useAI": true,                  // usar IA para enriquecimiento
 *   "scrapePages": true,            // hacer scraping de páginas
 *   "autoLinkAlternatives": true,   // vincular alternativas
 *   "dryRun": false,                // solo simulación
 *   "productIds": ["raw-id-1", ...] // solo para mode="batch": IDs de raw_affiliate_products a procesar
 * }
 *
 * Respuesta:
 * {
 *   success: true,
 *   stats: PipelineStats,
 *   results: [...],
 *   message: "..."
 * }
 */
export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json().catch(() => ({})) as {
      mode?: 'full' | 'batch' | 'raw-reprocess';
      network?: string;
      limit?: number;
      useAI?: boolean;
      scrapePages?: boolean;
      autoLinkAlternatives?: boolean;
      dryRun?: boolean;
      productIds?: string[];
    };

    const mode = body.mode || 'full';
    const network = body.network || 'amazon';
    const limit = body.limit ?? 0;
    const useAI = body.useAI ?? hasTextCredentials();
    const scrapePages = body.scrapePages ?? true;
    const autoLinkAlternatives = body.autoLinkAlternatives ?? true;
    const dryRun = body.dryRun ?? false;
    const productIds = body.productIds || [];

    // Validaciones
    if (!['full', 'batch', 'raw-reprocess'].includes(mode)) {
      return jsonResponse({ success: false, message: 'Modo inválido: debe ser "full", "batch" o "raw-reprocess"' }, 400);
    }

    if (mode === 'batch' && (!productIds.length)) {
      return jsonResponse({ success: false, message: 'Modo "batch" requiere array "productIds" con IDs de raw_affiliate_products' }, 400);
    }

    // Verificar credenciales de IA si se solicita
    if (useAI && !hasTextCredentials()) {
      return jsonResponse({
        success: false,
        message: `IA solicitada pero falta ${textProvider() === 'anthropic' ? 'ANTHROPIC_API_KEY' : textProvider() === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY'}. Desactiva "useAI" o configura la clave.`
      }, 400);
    }

    let results: any;
    let stats: any;

    if (mode === 'full') {
      // Pipeline completo sobre catálogo sincronizado
      const pipeline = new MassCatalogPipeline({
        network,
        limit,
        useAI,
        scrapePages,
        autoLinkAlternatives,
        dryRun,
      });
      stats = await pipeline.run();
      results = { message: `Pipeline completado: ${stats.succeeded}/${stats.totalRaw} productos procesados` };
    } else if (mode === 'batch') {
      // Procesar lista específica de raw_affiliate_products
      const allRaw = readRawAffiliateProducts();
      const rawBatch = allRaw.filter(r => productIds.includes(r.id) && r.network === network);

      if (!rawBatch.length) {
        return jsonResponse({ success: false, message: 'No se encontraron raw products con esos IDs para la red indicada' }, 404);
      }

      // Convertir a AdaptedProduct[]
      const adaptedBatch: AdaptedProduct[] = rawBatch.map(raw => ({
        product: raw.rawPayload as unknown as AdaptedProduct['product'],
        rawPayload: raw,
        warnings: [],
      }));

      const batchResult = await processAdaptedProductsBatch(adaptedBatch, {
        useAI,
        autoLinkAlternatives,
        dryRun,
      });
      results = batchResult.results;
      stats = batchResult.stats;
    } else if (mode === 'raw-reprocess') {
      // Re-procesar TODOS los raw products de una red (incluyendo ya procesados)
      const pipeline = new MassCatalogPipeline({
        network,
        limit,
        skipProcessed: false, // Re-procesar todo
        useAI,
        scrapePages,
        autoLinkAlternatives,
        dryRun,
      });
      stats = await pipeline.run();
      results = { message: `Re-procesado completado: ${stats.succeeded}/${stats.totalRaw} productos` };
    }

    return jsonResponse({
      success: true,
      mode,
      network,
      stats,
      results,
      message: stats?.message || results?.message || 'Auto-curación completada',
    }, 200);
  } catch (error: any) {
    console.error('[API admin/auto-curate] Error:', error);
    return jsonResponse(
      { success: false, message: error?.message || 'Error inesperado en auto-curación' },
      500
    );
  }
};

/**
 * GET /api/admin/auto-curate
 *
 * Estado del pipeline y estadísticas
 */
export const GET: APIRoute = async ({ request, url }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const network = url.searchParams.get('network') || 'amazon';
    const rawProducts = readRawAffiliateProducts();
    const networkRaw = rawProducts.filter(r => r.network === network);

    const stats = {
      network,
      totalRaw: networkRaw.length,
      pending: networkRaw.filter(r => !r.processed).length,
      processed: networkRaw.filter(r => r.processed).length,
      failed: networkRaw.filter(r => r.processed && r.error).length,
      withProductId: networkRaw.filter(r => r.sourceProductId).length,
      aiAvailable: hasTextCredentials(),
      aiProvider: textProvider(),
      lastProcessed: networkRaw
        .filter(r => r.processedAt)
        .sort((a, b) => new Date(b.processedAt!).getTime() - new Date(a.processedAt!).getTime())[0]?.processedAt || null,
    };

    return jsonResponse({ success: true, stats }, 200);
  } catch (error: any) {
    return jsonResponse({ success: false, message: error?.message || 'Error obteniendo estado' }, 500);
  }
};

/**
 * DELETE /api/admin/auto-curate
 *
 * Limpia raw_affiliate_products procesados (opcionalmente solo fallidos)
 */
export const DELETE: APIRoute = async ({ request, url }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const network = url.searchParams.get('network') || 'amazon';
    const onlyFailed = url.searchParams.get('onlyFailed') === 'true';

    const allRaw = readRawAffiliateProducts();
    const networkRaw = allRaw.filter(r => r.network === network);

    let toDelete: string[] = [];
    if (onlyFailed) {
      toDelete = networkRaw.filter(r => r.processed && r.error).map(r => r.id);
    } else {
      toDelete = networkRaw.filter(r => r.processed).map(r => r.id);
    }

    if (!toDelete.length) {
      return jsonResponse({ success: true, message: 'Nada que limpiar', deleted: 0 }, 200);
    }

    const remaining = allRaw.filter(r => !toDelete.includes(r.id));
    writeRawAffiliateProducts(remaining);

    return jsonResponse({
      success: true,
      message: `${toDelete.length} raw products eliminados`,
      deleted: toDelete.length,
    }, 200);
  } catch (error: any) {
    return jsonResponse({ success: false, message: error?.message || 'Error limpiando raw products' }, 500);
  }
};