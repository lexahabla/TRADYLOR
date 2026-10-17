import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import {
  detectDuplicates,
  enrichProductsForAdmin,
  recalcConversionScores,
  computeConversionScore,
} from '../../../lib/curation';
import { readProductsFromFile, writeProductsToFile } from '../../../lib/productStore';

export const prerender = false;

/**
 * GET /api/products/curation
 * Devuelve el catálogo enriquecido con los campos de curación:
 * conversion_score, is_duplicate (+ jerarquía de motivos) e ia_status/link_status.
 */
export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const products = readProductsFromFile();
    const enriched = enrichProductsForAdmin(products);
    const duplicates = detectDuplicates(products);
    return new Response(
      JSON.stringify({
        success: true,
        total: enriched.length,
        duplicateCount: duplicates.size,
        products: enriched,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, message: error?.message || 'Error al calcular la curación.' }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }
};

/**
 * POST /api/products/curation
 * Acciones:
 *  - { action: 'recalc' }  → recalcula y PERSISTE conversion_score en products.json.
 *  - { action: 'score', ids: [...] } → score calculado (sin persistir) de unos IDs.
 *  - { action: 'set-status', ids, ia_status?, link_status? } → actualiza estados editoriales.
 */
export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ success: false, message: 'Cuerpo JSON inválido.' }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  try {
    const action = String(body?.action || '').trim();

    if (action === 'recalc') {
      const { updated, total } = recalcConversionScores();
      return new Response(
        JSON.stringify({ success: true, updated, total, message: `Score recalculado: ${updated}/${total} producto(s) actualizados.` }),
        { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    if (action === 'score') {
      const ids = new Set(Array.isArray(body?.ids) ? body.ids.map((v: unknown) => String(v)) : []);
      const products = readProductsFromFile().filter((p) => ids.has(p.id));
      return new Response(
        JSON.stringify({
          success: true,
          scores: products.map((p) => ({ id: p.id, conversion_score: computeConversionScore(p) })),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    if (action === 'set-status') {
      const ids = new Set(Array.isArray(body?.ids) ? body.ids.map((v: unknown) => String(v)) : []);
      const iaStatus = body?.ia_status !== undefined ? String(body.ia_status).trim() : undefined;
      const linkStatus = body?.link_status !== undefined ? String(body.link_status).trim() : undefined;
      if (!ids.size || (!iaStatus && !linkStatus)) {
        return new Response(
          JSON.stringify({ success: false, message: 'Se requieren "ids" y al menos un estado (ia_status / link_status).' }),
          { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        );
      }
      const products = readProductsFromFile();
      let updated = 0;
      for (const p of products) {
        if (!ids.has(p.id)) continue;
        if (iaStatus) p.ia_status = iaStatus;
        if (linkStatus) p.link_status = linkStatus;
        updated++;
      }
      if (updated) writeProductsToFile(products);
      return new Response(
        JSON.stringify({ success: true, updated, message: `${updated} producto(s) actualizados.` }),
        { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, message: `Acción desconocida "${action}". Usa: recalc | score | set-status.` }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, message: error?.message || 'Error en el endpoint de curación.' }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }
};
