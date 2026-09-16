/**
 * ==============================================================================
 * TRADYLOR - API PÚBLICA v1: IMPORTACIÓN DESATENDIDA (n8n)
 * ==============================================================================
 * POST /api/v1/products/import
 *   { "title": "...", "affiliateUrl": "...", "price": 99.99, ... }
 *   o bien un lote: { "products": [ {...}, {...} ] }
 *
 * Autenticación: header  Authorization: Bearer <TRADYLOR_API_TOKEN>
 *
 * Permite que un flujo de n8n (consulta periódica a redes + algoritmo de
 * selección por rentabilidad/comisión/tendencia) autoinyecte los mejores
 * productos en products.json sin intervención manual. El link cloaking se
 * aplica automáticamente en el frontend vía /out/[id].
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { upsertCatalogProduct } from '../../../../lib/catalogStore';
import { isValidApiToken, unauthorizedApiResponse } from '../../../../lib/apiAuth';

export const prerender = false;

const jsonHeaders = { 'Content-Type': 'application/json' };

export const POST: APIRoute = async ({ request }) => {
  if (!isValidApiToken(request)) return unauthorizedApiResponse();

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ success: false, message: 'Petición JSON inválida.' }), { status: 400, headers: jsonHeaders });
  }

  const items: any[] = Array.isArray(body.products) ? body.products : [body];
  if (items.length === 0 || items.length > 50) {
    return new Response(
      JSON.stringify({ success: false, message: 'Envía entre 1 y 50 productos por petición.' }),
      { status: 400, headers: jsonHeaders },
    );
  }

  const results = items.map((item) => ({
    id: item?.id ?? null,
    title: item?.title ?? null,
    ...upsertCatalogProduct(item ?? {}),
  }));

  const okCount = results.filter((r) => r.ok).length;
  return new Response(
    JSON.stringify({
      success: okCount > 0,
      imported: okCount,
      failed: results.length - okCount,
      results,
    }),
    { status: okCount > 0 ? 200 : 400, headers: jsonHeaders },
  );
};
