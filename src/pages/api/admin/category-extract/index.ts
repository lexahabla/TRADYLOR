/**
 * ==============================================================================
 * TREIDILOR - API ADMIN: EXTRACCIÓN DE UNA CATEGORÍA DE AMAZON (Apify · junglee/Amazon-crawler)
 * ==============================================================================
 * GET  /api/admin/category-extract            → configuración, límites y extracción activa/última (para retomar tras recargar)
 * GET  /api/admin/category-extract?id=<id>    → estado (consulta a Apify sin esperar); al terminar incluye `records`
 * GET  /api/admin/category-extract?id=<id>&raw=1 → elementos crudos del dataset de Apify (diagnóstico; solo lectura)
 * POST /api/admin/category-extract            { source:"amazon"|"temu", url, limit } → inicia (idempotente si ya hay una igual en curso)
 * POST /api/admin/category-extract            { action:"cancel", id } → aborta la ejecución en Apify
 *
 * Obtener datos NO escribe en el catálogo: devuelve registros adaptados al modelo del importador JSON que la interfaz
 * pone en el cuadro «JSON a importar» para simular o importar con el motor existente. Sin IA.
 * Autenticación: sesión de admin O Bearer TRADYLOR_API_TOKEN. El token de Apify (APIFY_TOKEN) sólo existe en el servidor.
 * ==============================================================================
 */
import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { isValidApiToken, unauthorizedApiResponse } from '../../../../lib/apiAuth';
import {
  ExtractionError,
  activeJob,
  cancelExtraction,
  extractionConfig,
  getJob,
  latestJob,
  readRawItems,
  refreshExtraction,
  startExtraction,
} from '../../../../lib/apify/categoryExtraction';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const authorized = (request: Request) => !(requireAdminAuth(request) && !isValidApiToken(request));

function failure(error: unknown) {
  if (error instanceof ExtractionError) return json({ success: false, message: error.message, job: error.job }, error.status);
  return json({ success: false, message: 'Error interno en la extracción.' }, 500);
}

export const GET: APIRoute = async ({ request, url }) => {
  if (!authorized(request)) return unauthorizedApiResponse();
  const id = url.searchParams.get('id');
  try {
    if (id) {
      if (!/^[a-f0-9-]{36}$/i.test(id)) return json({ success: false, message: 'Identificador no válido.' }, 400);
      if (url.searchParams.get('raw') === '1') {
        const raw = await readRawItems(id);
        if (!raw) return json({ success: false, message: 'No hay dataset de esa extracción.' }, 404);
        return json({ success: true, items: raw });
      }
      const out = await refreshExtraction(id);
      if (!out) return json({ success: false, message: 'No existe esa extracción.' }, 404);
      return json({ success: true, job: out.job, records: out.records });
    }
    const c = extractionConfig();
    return json({
      success: true,
      configured: c.configured,
      defaultLimit: c.defaultLimit,
      maxLimit: c.maxLimit,
      sources: { amazon: { configured: c.configured }, temu: { configured: c.configured, actor: 'hypebridge/temu-scraper' } },
      active: activeJob() ?? null,
      latest: latestJob() ?? null,
    });
  } catch (error) {
    return failure(error);
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return unauthorizedApiResponse();
  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text.length > 20_000) return json({ success: false, message: 'Petición demasiado grande.' }, 413);
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return json({ success: false, message: 'El cuerpo no es un JSON válido.' }, 400);
  }
  try {
    if (body.action === 'cancel') {
      const id = String(body.id ?? '');
      if (!/^[a-f0-9-]{36}$/i.test(id) || !getJob(id)) return json({ success: false, message: 'No existe esa extracción.' }, 404);
      const job = await cancelExtraction(id);
      return json({ success: true, job });
    }
    const { job, reused } = await startExtraction(body.url, body.limit, body.source);
    return json({ success: true, job, reused }, reused ? 200 : 201);
  } catch (error) {
    return failure(error);
  }
};
