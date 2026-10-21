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
 * Ejecuta el PIPELINE de 4 etapas (ingest → audit → categorize → publish) y
 * conserva el contrato retrocompatible (success/imported/failed/results[].ok/
 * message/product/updated) añadiendo las claves nuevas del pipeline (stage,
 * duplicate, duplicate_reason, audit_status, audit_score, pipeline).
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { isValidApiToken, unauthorizedApiResponse } from '../../../../lib/apiAuth';
import { slugifyProduct } from '../../../../lib/catalogStore';
import { runProductPipeline } from '../../../../lib/pipeline';
import { readProductsFromFile } from '../../../../lib/productStore';

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

  const results = [];
  for (const item of items) {
    const requestedId = item?.id ?? null;
    const requestedTitle = item?.title ?? null;

    // `updated` conserva su semántica histórica: el producto ya existía antes.
    const existedBefore = readProductsFromFile().some(
      (product) => product.id === (requestedId || slugifyProduct(String(requestedTitle || ''))),
    );

    const result = await runProductPipeline(item ?? {});

    results.push({
      id: result.product?.id ?? requestedId,
      title: result.product?.title ?? requestedTitle,
      ok: result.ok,
      message: result.message ?? (result.ok ? 'Producto procesado por el pipeline.' : 'No se pudo procesar.'),
      updated: existedBefore,
      // Claves nuevas del pipeline (aditivas; ninguna elimina las anteriores).
      stage: result.stage,
      duplicate: result.duplicate ?? false,
      duplicate_reason: result.duplicate_reason,
      audit_status: result.audit_status,
      audit_score: result.audit_score,
      pipeline: result.pipeline,
    });
  }

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
