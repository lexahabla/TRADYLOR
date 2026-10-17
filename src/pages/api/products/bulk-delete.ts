import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { bulkDeleteProducts } from '../../../lib/curation';
import { readProductsFromFile } from '../../../lib/productStore';

export const prerender = false;

/**
 * POST /api/products/bulk-delete
 * Eliminación masiva (bulk delete) del catálogo: recibe `{ ids: string[] }`,
 * filtra products.json, deja tombstone por cada ID borrado y devuelve el
 * detalle de borrados/ausentes más el recuento restante.
 *
 * DELETE /api/products/bulk-delete (mismo cuerpo) también soportado.
 *
 * Protegido con sesión administrativa (a diferencia del DELETE legado de
 * /api/products/add, que quedó público por accidente y no debe replicarse).
 */
async function handleBulkDelete(request: Request): Promise<Response> {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ success: false, message: 'Cuerpo JSON inválido: se esperaba { ids: [...] }.' }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  const ids = Array.isArray(body?.ids)
    ? body.ids.map((v: unknown) => String(v || '').trim()).filter(Boolean)
    : [];
  if (!ids.length) {
    return new Response(
      JSON.stringify({ success: false, message: 'Se requiere al menos un ID en "ids".' }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  try {
    const { deleted, missing } = bulkDeleteProducts(ids);
    const remaining = readProductsFromFile().length;
    return new Response(
      JSON.stringify({
        success: deleted.length > 0,
        deleted: deleted.length,
        deletedIds: deleted,
        missing: missing.length,
        missingIds: missing,
        remaining,
        message: deleted.length
          ? `${deleted.length} producto(s) eliminados del catálogo.${missing.length ? ` ${missing.length} no existían.` : ''}`
          : 'Ninguno de los IDs indicados existe en el catálogo.',
      }),
      { status: deleted.length ? 200 : 404, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, message: error?.message || 'Error al eliminar en masa.' }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }
}

export const POST: APIRoute = async ({ request }) => handleBulkDelete(request);
export const DELETE: APIRoute = async ({ request }) => handleBulkDelete(request);
