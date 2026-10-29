import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { importAmazonProductFromRawJson, type ImportAmazonOptions } from '../../../../lib/amazonImport';

export const prerender = false;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const parseBody = async (request: Request): Promise<{
  asin?: string;
  raw?: unknown;
  options?: ImportAmazonOptions;
} | null> => {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') return null;
    return {
      asin: typeof body.asin === 'string' ? body.asin : undefined,
      raw: body.raw,
      options: body.options && typeof body.options === 'object' ? body.options : undefined,
    };
  } catch {
    return null;
  }
};

/**
 * POST /api/admin/amazon/import-json
 *
 * Importa un producto de Amazon a partir de un JSON crudo de ScraperAPI que el
 * cliente ya obtuvo externamente (evita que el servidor de Tradylor llame a
 * ScraperAPI y se saltee bloqueos IP / anti-bot de Amazon).
 *
 * Requiere sesión de admin (cookie tradylor_admin_session).
 *
 * Body JSON:
 * {
 *   "asin": "B01EXDG2MO",                      // obligatorio (10 caracteres)
 *   "raw": { ...datos crudos de ScraperAPI... }, // obligatorio
 *   "options": {
 *     "textProvider": "openai" | "anthropic" | ...,
 *     "imageProvider": "openai" | "flux",
 *     "save": true,                 // false = solo vista previa, no guarda
 *     "imageOnlyIfMissing": true    // no sustituir imagen real por IA
 *   }
 * }
 *
 * Respuesta: { success, asin, product, updated, saved, message, warnings }
 */
export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const parsed = await parseBody(request);
  if (!parsed || !parsed.asin) {
    return jsonResponse(
      { success: false, message: 'El campo "asin" es obligatorio (10 caracteres alfanuméricos).' },
      400,
    );
  }
  if (!parsed.raw || typeof parsed.raw !== 'object') {
    return jsonResponse(
      { success: false, message: 'El campo "raw" es obligatorio (objeto JSON crudo de ScraperAPI).' },
      400,
    );
  }

  try {
    const result = await importAmazonProductFromRawJson(
      parsed.asin,
      parsed.raw as any,
      parsed.options ?? {},
    );
    const status = result.success ? 200 : 422;
    return jsonResponse(result, status);
  } catch (error: any) {
    console.error('[API admin/amazon/import-json] Error no controlado:', error);
    return jsonResponse(
      { success: false, message: error?.message || 'Error inesperado al importar el JSON de Amazon.' },
      500,
    );
  }
};
