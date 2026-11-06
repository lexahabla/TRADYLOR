/**
 * ==============================================================================
 * TREIDILOR - API ADMIN: IMPORTACIÓN DE PRODUCTOS MEDIANTE JSON (Etapa A)
 * ==============================================================================
 * POST /api/admin/json-import
 *   {
 *     "batchId": "ab12cd34ef",          // id del lote (6-64: letras, números, _ -)
 *     "records": [ {...}, {...} ],       // 1-100 registros por petición
 *     "defaults": { "platform", "currency", "sellerName", "condition", "category" },
 *     "indexOffset": 0,                  // posición global del primer registro
 *     "dryRun": false,                   // true = simula sin escribir nada
 *     "target": { "categoryId", "subcategoryId" }  // opcional: destino de las fichas NUEVAS (validado)
 *   }
 *
 * El cliente trocea el JSON en bloques de hasta 100 registros y los envía en
 * serie (progreso + reintentos seguros: cada bloque es idempotente).
 * Respuesta: { success, results[], summary, changed, backup? }
 *
 * Independiente de la importación por API (AliExpress/eBay) y del flujo Amazon.
 * Autenticación: sesión de admin O Bearer TRADYLOR_API_TOKEN.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { isValidApiToken, unauthorizedApiResponse } from '../../../../lib/apiAuth';
import { isBuildCatalogJobRunning } from '../../../../lib/buildCatalog/job';
import { isPipelineJobRunning } from '../../../../lib/pipeline/job';
import { MAX_CHUNK_RECORDS, processChunk, readBatchReport, safeBatchId, summarize } from '../../../../lib/jsonImport/service';
import { cleanText, normalizeCurrency, sanitizeJson } from '../../../../lib/jsonImport/normalize';
import { resolveImportTarget } from '../../../../lib/jsonImport/categoryResolver';
import type { ImportDefaults } from '../../../../lib/jsonImport/types';

export const prerender = false;

const MAX_BODY_CHARS = 3_000_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

function authorized(request: Request): boolean {
  return !(requireAdminAuth(request) && !isValidApiToken(request));
}

function readDefaults(value: unknown): ImportDefaults {
  const d = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    platform: cleanText(d.platform, 60).toLowerCase() || undefined,
    currency: normalizeCurrency(d.currency) || undefined,
    sellerName: cleanText(d.sellerName, 120) || undefined,
    condition: cleanText(d.condition, 40) || undefined,
    category: cleanText(d.category, 120) || undefined,
    capturedAt: cleanText(d.capturedAt, 40) || undefined,
  };
}

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return unauthorizedApiResponse();

  let text = '';
  try {
    text = await request.text();
  } catch {
    return json({ success: false, message: 'No se pudo leer la petición.' }, 400);
  }
  if (text.length > MAX_BODY_CHARS) {
    return json({ success: false, message: 'El bloque supera el tamaño máximo permitido (3 MB).' }, 413);
  }

  let body: Record<string, unknown>;
  try {
    body = sanitizeJson(JSON.parse(text)) as Record<string, unknown>;
  } catch (error) {
    return json({ success: false, message: `JSON inválido: ${(error as Error).message}` }, 400);
  }

  const batchId = safeBatchId(body.batchId);
  if (!batchId) return json({ success: false, message: 'batchId obligatorio (6-64 caracteres: letras, números, _ y -).' }, 400);
  const records = body.records;
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_CHUNK_RECORDS) {
    return json({ success: false, message: `Envía entre 1 y ${MAX_CHUNK_RECORDS} registros por petición.` }, 400);
  }
  // Destino opcional de las fichas NUEVAS: se valida contra categories.json (existe y la subcategoría es de esa categoría).
  const resolved = resolveImportTarget(body.target);
  if (resolved.error) return json({ success: false, message: resolved.error }, 400);
  const dryRun = body.dryRun === true;
  const indexOffset = Number.isInteger(body.indexOffset) && (body.indexOffset as number) >= 0 ? (body.indexOffset as number) : 0;

  // No se escribe el catálogo mientras otro proceso masivo lo está reescribiendo.
  if (!dryRun && (isBuildCatalogJobRunning() || isPipelineJobRunning())) {
    return json(
      { success: false, busy: true, message: 'Hay un proceso masivo del catálogo en curso (Construir Catálogo o reproceso). Espera a que termine y reintenta.' },
      409,
    );
  }

  try {
    const out = processChunk({ batchId, records, defaults: readDefaults(body.defaults), dryRun, indexOffset, target: resolved.target });
    return json({ success: true, dryRun, changed: out.changed, backup: out.backup, results: out.results, summary: summarize(out.results), target: resolved.target });
  } catch (error) {
    console.error('[API admin/json-import] Error:', error);
    return json({ success: false, message: (error as Error)?.message || 'Error inesperado al importar.' }, 500);
  }
};

/** GET ?batchId=… → informe guardado del lote. */
export const GET: APIRoute = async ({ request, url }) => {
  if (!authorized(request)) return unauthorizedApiResponse();
  const batchId = safeBatchId(url.searchParams.get('batchId'));
  if (!batchId) return json({ success: false, message: 'batchId inválido.' }, 400);
  const report = readBatchReport(batchId);
  if (!report) return json({ success: false, message: 'No hay informe para ese lote.' }, 404);
  return json({ success: true, report, summary: summarize(report.results) });
};
