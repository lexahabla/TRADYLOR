/**
 * ==============================================================================
 * TRADYLOR - API ADMIN: PIPELINE DE AUTOMATIZACIÓN
 * ==============================================================================
 * GET  /api/admin/pipeline
 *   -> Métricas de transparencia derivadas de products.json + pipeline-metrics.json
 *      { approved, rejected, pending, avg_audit_score, by_reason,
 *        duplicates_discarded, last_run }
 *
 * POST /api/admin/pipeline
 *   -> { mode: 'reprocess', ids?: string[], dryRun?: boolean }
 *      Re-ejecuta las 4 etapas sobre productos existentes del catálogo.
 *
 * Protegido por sesión de administrador (requireAdminAuth).
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { readProductsFromFile } from '../../../../lib/productStore';
import { readPipelineMetrics } from '../../../../lib/pipeline/metrics';
import { reprocessCatalog } from '../../../../lib/pipeline';

export const prerender = false;

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

/** Métricas de transparencia: estado de auditoría + contadores del pipeline. */
function buildMetrics() {
  const products = readProductsFromFile();
  const counters = readPipelineMetrics();

  let approved = 0;
  let rejected = 0;
  let pending = 0;
  let scoreSum = 0;
  let scored = 0;
  const byReason: Record<string, number> = {};

  for (const product of products) {
    const status = String(product.audit_status || 'pending');
    if (status === 'approved') approved += 1;
    else if (status === 'rejected') rejected += 1;
    else pending += 1;

    const score = Number(product.audit_score);
    if (Number.isFinite(score)) {
      scoreSum += score;
      scored += 1;
    }

    for (const reason of product.audit_reasons || []) {
      const key = String(reason || '').trim();
      if (!key) continue;
      byReason[key] = (byReason[key] || 0) + 1;
    }
  }

  return {
    approved,
    rejected,
    pending,
    avg_audit_score: scored ? Math.round((scoreSum / scored) * 10) / 10 : 0,
    by_reason: byReason,
    duplicates_discarded: counters.duplicatesDiscarded,
    last_run: counters.lastRun || null,
    runs: counters.runs,
    productsProcessed: counters.productsProcessed,
  };
}

export const GET: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  return new Response(JSON.stringify({ success: true, ...buildMetrics() }), {
    status: 200,
    headers: jsonHeaders,
  });
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const ids = Array.isArray(body?.ids)
    ? body.ids.map((value: unknown) => String(value || '').trim()).filter(Boolean)
    : undefined;

  try {
    const { total, results } = await reprocessCatalog(ids, {
      dryRun: body?.dryRun === true,
      enrich: body?.enrich !== false,
    });

    const okCount = results.filter((result) => result.ok).length;
    return new Response(
      JSON.stringify({
        success: true,
        mode: body?.mode || 'reprocess',
        total,
        processed: okCount,
        failed: results.length - okCount,
        results: results.map((result) => ({
          id: result.product?.id ?? null,
          title: result.product?.title ?? null,
          ok: result.ok,
          stage: result.stage,
          duplicate: result.duplicate ?? false,
          duplicate_reason: result.duplicate_reason,
          audit_status: result.audit_status,
          audit_score: result.audit_score,
          message: result.message,
        })),
      }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, message: error?.message || 'Error al reprocesar el catálogo.' }),
      { status: 500, headers: jsonHeaders },
    );
  }
};
