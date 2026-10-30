import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { importAmazonProduct, type ImportAmazonOptions } from '../../../../lib/amazonImport';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const parseBody = async (request: Request): Promise<{
  asins?: string[];
  countryCode?: string;
  options?: ImportAmazonOptions;
  delayMs?: number;
} | null> => {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') return null;
    const asins = Array.isArray(body.asins)
      ? body.asins.filter((v) => typeof v === 'string').map((v) => String(v).trim()).filter(Boolean)
      : undefined;
    return {
      asins,
      countryCode: typeof body.countryCode === 'string' ? body.countryCode : undefined,
      options: body.options && typeof body.options === 'object' ? body.options : undefined,
      delayMs: typeof body.delayMs === 'number' && body.delayMs > 0 ? body.delayMs : 3000,
    };
  } catch {
    return null;
  }
};

/**
 * POST /api/admin/amazon/import-batch
 *
 * Importa MÚLTIPLES productos de Amazon en lote, uno tras otro, con un
 * delay configurable entre peticiones para no saturar ScraperAPI y reducir
 * bloqueos/captcha de Amazon. Muchos ASINs fallan individualmente por
 * bloqueo IP, cuota agotada o pagina de captcha; este endpoint reintenta
 * cada ASIN de forma aislada y devuelve el resultado detallado de cada uno.
 *
 * Requiere sesión de admin (cookie tradylor_admin_session) O Bearer token.
 *
 * Body JSON:
 * {
 *   "asins": ["B01EXDG2MO", "B08XYZ1234", "https://www.amazon.es/dp/B09ABCD567"], // obligatorio (mín 1)
 *   "countryCode": "es",                                 // opcional, por defecto 'es'
 *   "options": {
 *     "textProvider": "groq",                            // opcional
 *     "imageProvider": "openai",                         // opcional
 *     "save": true                                       // opcional, true por defecto
 *   },
 *   "delayMs": 3000                                      // opcional, ms entre peticiones (default 3000)
 * }
 *
 * Respuesta:
 * {
 *   total: number,
 *   ok: number,
 *   failed: number,
 *   results: [
 *     { asin, success, product?, updated?, saved?, message, warnings? }
 *   ]
 * }
 */
export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const parsed = await parseBody(request);
  if (!parsed || !parsed.asins || parsed.asins.length === 0) {
    return jsonResponse(
      { success: false, message: 'El campo "asins" es obligatorio y debe ser un array con al menos un ASIN o URL de Amazon.' },
      400,
    );
  }

  const { asins, countryCode, options, delayMs } = parsed;
  const results: Array<{ asin: string; success: boolean; message: string; product?: any; updated?: boolean; saved?: boolean; warnings?: string[] }> = [];

  let ok = 0;
  let failed = 0;

  for (let i = 0; i < asins.length; i++) {
    const asinOrUrl = asins[i];
    try {
      const result = await importAmazonProduct(asinOrUrl, {
        ...(options ?? {}),
        countryCode: countryCode ?? (options as any)?.countryCode ?? undefined,
      });

      if (result.success) {
        ok++;
        results.push({
          asin: result.asin,
          success: true,
          message: result.message,
          product: result.product,
          updated: result.updated,
          saved: result.saved,
          warnings: result.warnings,
        });
      } else {
        failed++;
        results.push({
          asin: result.asin || asinOrUrl,
          success: false,
          message: result.message,
          warnings: result.warnings,
        });
      }
    } catch (error: any) {
      failed++;
      results.push({
        asin: asinOrUrl,
        success: false,
        message: error?.message || 'Error inesperado al importar.',
      });
    }

    // Delay entre peticiones (excepto después de la última)
    if (i < asins.length - 1) {
      await sleepMs(delayMs);
    }
  }

  return jsonResponse(
    {
      success: failed === 0,
      total: asins.length,
      ok,
      failed,
      results,
    },
    failed === 0 ? 200 : 207, // 207 Multi-Status si hubo fallos parciales
  );
};
