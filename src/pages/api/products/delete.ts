import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { bulkDeleteProducts, deleteAllProducts } from '../../../lib/curation';
import { readProductsFromFile } from '../../../lib/productStore';

export const prerender = false;

/**
 * POST /api/products/delete
 * Elimina productos del catálogo.
 * - Body: { product_ids: string[] } → elimina solo los IDs indicados
 * - Body: { deleteAll: true } → vacía el catálogo completo (purga)
 *
 * Protegido con sesión administrativa.
 */
async function handleDelete(request: Request): Promise<Response> {
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

  // Modo: vaciar catálogo completo
  if (body?.deleteAll === true) {
    try {
      const { deletedCount } = deleteAllProducts();
      const remaining = readProductsFromFile().length;
      return new Response(
        JSON.stringify({
          success: true,
          deleted: deletedCount,
          deletedIds: [],
          missing: 0,
          missingIds: [],
          remaining,
          message: `Catálogo vaciado: ${deletedCount} producto(s) eliminados.`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
    } catch (error: any) {
      return new Response(
        JSON.stringify({ success: false, message: error?.message || 'Error al vaciar el catálogo.' }),
        { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }
  }

  // Modo: eliminar IDs seleccionados
  const ids = Array.isArray(body?.product_ids)
    ? body.product_ids.map((v: unknown) => String(v || '').trim()).filter(Boolean)
    : [];

  if (!ids.length) {
    return new Response(
      JSON.stringify({ success: false, message: 'Se requiere al menos un ID en "product_ids".' }),
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
      JSON.stringify({ success: false, message: error?.message || 'Error al eliminar productos.' }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }
}

export const POST: APIRoute = async ({ request }) => handleDelete(request);
export const DELETE: APIRoute = async ({ request }) => handleDelete(request);