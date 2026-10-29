import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { importAmazonProduct, type ImportAmazonOptions } from '../../../../lib/amazonImport';

export const prerender = false;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * POST /api/admin/amazon/import
 *
 * Ejecuta el pipeline completo de ingestión de un producto de Amazon:
 *   1. Extrae/valida el ASIN (URL completa o ASIN directo, 10 chars).
 *   2. Llama a ScraperAPI estructurada (country_code=es, SCRAPER_API_KEY).
 *   3. Normaliza campos crudos al modelo interno.
 *   4. Enriquece por IA (texto editorial con esquema estructurado).
 *   5. Upsert por ASIN (clave primaria única) en products.json — evita duplicados.
 *
 * Requiere sesión de admin (cookie tradylor_admin_session).
 *
 * Body JSON:
 * {
 *   "asinOrUrl": "https://www.amazon.es/dp/B01EXDG2MO" | "B01EXDG2MO",
 *   "options": {
 *     "textProvider": "openai" | "anthropic" | "groq" | "gemini" | ...,
 *     "imageProvider": "openai" | "flux",
 *     "save": true,                 // false = solo vista previa, no guarda
 *     "enrichImage": true,          // futuro: generación de imagen con IA
 *     "imageOnlyIfMissing": true    // no sustituir imagen real por IA
 *   }
 * }
 *
 * Respuesta: { success, asin, product, updated, saved, message, warnings }
 */

const parseBody = async (request: Request): Promise<{ asinOrUrl?: string; options?: ImportAmazonOptions } | null> => {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') return null;
    return {
      asinOrUrl: typeof body.asinOrUrl === 'string' ? body.asinOrUrl : undefined,
      options: body.options && typeof body.options === 'object' ? body.options : undefined,
    };
  } catch {
    return null;
  }
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const parsed = await parseBody(request);
  if (!parsed || !parsed.asinOrUrl) {
    return jsonResponse(
      { success: false, message: 'El campo "asinOrUrl" es obligatorio (URL de Amazon o ASIN directo de 10 caracteres).' },
      400,
    );
  }

  const { asinOrUrl, options } = parsed;

  try {
    const result = await importAmazonProduct(asinOrUrl, options ?? {});
    const status = result.success ? 200 : 422;
    return jsonResponse(result, status);
  } catch (error: any) {
    console.error('[API admin/amazon/import] Error no controlado:', error);
    return jsonResponse(
      { success: false, message: error?.message || 'Error inesperado al importar el producto de Amazon.' },
      500,
    );
  }
};
