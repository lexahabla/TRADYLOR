/**
 * ==============================================================================
 * TRADYLOR - API ADMIN: PIPELINE DE AUTOMATIZACIÓN
 * ==============================================================================
 * GET  /api/admin/pipeline
 *   -> Métricas de transparencia derivadas de products.json + pipeline-metrics.json
 *      { approved, rejected, pending, avg_audit_score, by_reason,
 *        duplicates_discarded, duplicate_groups, duplicate_products, last_run,
 *        ai_enriched, ai_failed, ai_pending, job }
 *
 * POST /api/admin/pipeline
 *   -> { mode: 'reprocess', ids?: string[], scope?: 'ids'|'all', dryRun?: boolean,
 *        enrich?: boolean, provider?: 'openai'|'anthropic'|'groq', model?: string,
 *        confirm?: boolean, background?: boolean }
 *      Re-ejecuta las 4 etapas sobre productos existentes del catálogo.
 *      Para escribir sobre TODO el catálogo hacen falta `scope:'all'` + `confirm:true`.
 *      Con `background:true` la tarea se lanza en SEGUNDO PLANO (devuelve al
 *      instante) y el avance se consulta con GET (clave `job`): es la única
 *      forma viable de reprocesar el catálogo entero con IA (una petición
 *      síncrona moría por timeout del proxy a mitad).
 *   -> { mode: 'dedupe', dryRun?: boolean }
 *      Detecta (y opcionalmente purga) los duplicados reales del catálogo.
 *      Sin `dryRun:false` es una SIMULACIÓN: no se escribe nada.
 *   -> { mode: 'cancel' }
 *      Detiene el reproceso en segundo plano que esté en marcha.
 *
 * Protegido por sesión de administrador (requireAdminAuth).
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { readProductsFromFile } from '../../../../lib/productStore';
import { readPipelineMetrics } from '../../../../lib/pipeline/metrics';
import { reprocessCatalog } from '../../../../lib/pipeline';
import {
  cancelPipelineJob,
  getPipelineJob,
  startPipelineJob,
} from '../../../../lib/pipeline/job';
import { findDuplicateGroups, purgeDuplicateProducts } from '../../../../lib/curation';

export const prerender = false;

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

/** Respuesta JSON de error con el código indicado. */
function errorResponse(message: string, status = 400): Response {
  return new Response(JSON.stringify({ success: false, message }), { status, headers: jsonHeaders });
}

/** Métricas de transparencia: estado de auditoría + contadores del pipeline. */
function buildMetrics() {
  const products = readProductsFromFile();
  const counters = readPipelineMetrics();

  let approved = 0;
  let rejected = 0;
  let pending = 0;
  let scoreSum = 0;
  let scored = 0;
  let aiEnriched = 0;
  let aiFailed = 0;
  let aiPending = 0;
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

    // Estado del enriquecimiento con IA (Etapa 3). Antes esto no se guardaba y
    // el fallo era silencioso: media parte del catálogo se quedaba con la
    // plantilla local sin que nadie lo notase.
    if (product.ai_error) aiFailed += 1;
    else if (product.ai_enriched === true) aiEnriched += 1;
    else aiPending += 1;

    for (const reason of product.audit_reasons || []) {
      const key = String(reason || '').trim();
      if (!key) continue;
      byReason[key] = (byReason[key] || 0) + 1;
    }
  }

  // Duplicados REALES que siguen en el catálogo (mismo sourceId o URL canónica).
  const duplicateGroups = findDuplicateGroups(products);
  const duplicateProducts = duplicateGroups.reduce((sum, group) => sum + group.duplicateIds.length, 0);

  return {
    approved,
    rejected,
    pending,
    avg_audit_score: scored ? Math.round((scoreSum / scored) * 10) / 10 : 0,
    by_reason: byReason,
    duplicates_discarded: counters.duplicatesDiscarded,
    duplicate_groups: duplicateGroups.length,
    duplicate_products: duplicateProducts,
    last_run: counters.lastRun || null,
    runs: counters.runs,
    productsProcessed: counters.productsProcessed,
    ai_enriched: aiEnriched,
    ai_failed: aiFailed,
    ai_pending: aiPending,
    job: getPipelineJob(),
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

  // El cuerpo SIEMPRE tiene que ser JSON válido: si no, se rechaza (antes un
  // cuerpo inválido se traducía en `{}` y reprocesaba el catálogo entero).
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Cuerpo JSON inválido: se esperaba { mode: "reprocess" | "dedupe", ... }.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('Cuerpo JSON inválido: se esperaba un objeto.');
  }

  const mode = String(body.mode || 'reprocess').trim();

  // ── Modo parada del reproceso en segundo plano ────────────────────────────
  if (mode === 'cancel') {
    const result = cancelPipelineJob();
    return new Response(
      JSON.stringify({ success: result.ok, mode: 'cancel', message: result.message, job: getPipelineJob() }),
      { status: result.ok ? 200 : 409, headers: jsonHeaders },
    );
  }

  // ── Modo purga de duplicados ───────────────────────────────────────────────
  if (mode === 'dedupe') {
    const dryRun = body.dryRun !== false; // por defecto SIMULACIÓN (no escribe)
    const result = purgeDuplicateProducts({ dryRun });
    return new Response(
      JSON.stringify({
        success: true,
        mode: 'dedupe',
        dryRun: result.dryRun,
        groups: result.details.length,
        removed: result.removed.length,
        removedIds: result.removed,
        details: result.details,
        total: result.total,
        remaining: result.remaining,
        message: result.dryRun
          ? `Simulación: ${result.removed.length} producto(s) duplicado(s) de ${result.details.length} grupo(s) se eliminarían.`
          : `${result.removed.length} producto(s) duplicado(s) eliminados de ${result.details.length} grupo(s).`,
      }),
      { status: 200, headers: jsonHeaders },
    );
  }

  if (mode !== 'reprocess') {
    return errorResponse(`Modo desconocido: "${mode}". Usa "reprocess", "dedupe" o "cancel".`);
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.map((value: unknown) => String(value || '').trim()).filter(Boolean)
    : undefined;
  const dryRun = body.dryRun === true;
  const scope = String(body.scope || (ids && ids.length ? 'ids' : 'all')).trim();

  if (scope !== 'ids' && scope !== 'all') {
    return errorResponse(`Ámbito desconocido: "${scope}". Usa "ids" o "all".`);
  }
  if (scope === 'ids' && !ids?.length) {
    return errorResponse('Ámbito "ids" sin lista de IDs: se esperaba { ids: [...] }.');
  }
  // Escribir sobre TODO el catálogo exige confirmación explícita.
  if (scope === 'all' && !dryRun && body.confirm !== true) {
    return errorResponse(
      'Para reprocesar y escribir TODO el catálogo hay que enviar { scope: "all", confirm: true }.',
    );
  }

  try {
    // Proveedor de IA opcional para esta tanda (p. ej. 'openai' cuando el
    // proveedor por defecto ha agotado su límite de peticiones).
    const providerRaw = String(body.provider || '').trim().toLowerCase();
    const provider = providerRaw === 'openai' || providerRaw === 'anthropic' || providerRaw === 'groq'
      ? providerRaw
      : undefined;

    // Modelo opcional para esta tanda: los límites de peticiones de Groq son
    // POR MODELO (TPD), así que agotar uno no agota el resto.
    const model = String(body.model || '').trim() || undefined;

    // ── Segundo plano ────────────────────────────────────────────────────────
    // Reprocesar el catálogo entero con IA tarda minutos: dentro de la petición
    // HTTP el proxy la cortaba a mitad. Con `background:true` la tarea sigue
    // en el servidor y el panel consulta el avance con GET (clave `job`).
    if (body.background === true) {
      const started = startPipelineJob({ ids, scope, dryRun, enrich: body.enrich !== false, provider, model });
      if (!started.ok) {
        return errorResponse(started.message || 'No se pudo lanzar el reproceso en segundo plano.', 409);
      }
      return new Response(
        JSON.stringify({
          success: true,
          mode: 'reprocess',
          background: true,
          scope,
          dryRun,
          provider: provider ?? null,
          model: model ?? null,
          total: started.state?.total ?? 0,
          job: started.state,
          message: 'Reproceso lanzado en segundo plano. El avance se consulta con GET /api/admin/pipeline.',
        }),
        { status: 202, headers: jsonHeaders },
      );
    }

    const { total, results } = await reprocessCatalog(ids, {
      dryRun,
      enrich: body.enrich !== false,
      provider,
      model,
    });

    const okCount = results.filter((result) => result.ok).length;
    const aiEnrichedCount = results.filter((result) => result.ai_enriched === true).length;
    const aiFailedCount = results.filter((result) => Boolean(result.ai_error)).length;
    return new Response(
      JSON.stringify({
        success: true,
        mode: 'reprocess',
        scope,
        dryRun,
        total,
        processed: okCount,
        failed: results.length - okCount,
        ai_enriched: aiEnrichedCount,
        ai_failed: aiFailedCount,
        results: results.map((result) => ({
          id: result.product?.id ?? null,
          title: result.product?.title ?? null,
          ok: result.ok,
          stage: result.stage,
          duplicate: result.duplicate ?? false,
          duplicate_reason: result.duplicate_reason,
          audit_status: result.audit_status,
          audit_score: result.audit_score,
          audit_reasons: result.product?.audit_reasons ?? [],
          ai_enriched: result.ai_enriched ?? false,
          ai_error: result.ai_error ?? null,
          message: result.message,
        })),
      }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (error: any) {
    return errorResponse(error?.message || 'Error al reprocesar el catálogo.', 500);
  }
};
