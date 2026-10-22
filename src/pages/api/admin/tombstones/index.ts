/**
 * ==============================================================================
 * TRADYLOR - API ADMIN: TOMBSTONES DEL CATÁLOGO
 * ==============================================================================
 * GET    /api/admin/tombstones
 *   -> { count, ids }   Tombstones actuales (ids que el build/import no pueden
 *                         volver a publicar porque fueron borrados a mano).
 *
 * DELETE /api/admin/tombstones
 *   -> { cleared }      Limpia los tombstones (conserva los ids integrados).
 *                         Útil para deshacer un "Vaciar Catálogo": sin esto,
 *                         los productos borrados quedaban bloqueados para
 *                         siempre y el catálogo no podía volver a crecer.
 *
 * Protegido por sesión de administrador (requireAdminAuth).
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { clearDeletedIds, readDeletedIds } from '../../../../lib/deletedProducts';

export const prerender = false;

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

export const GET: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const ids = readDeletedIds();
  return new Response(JSON.stringify({ success: true, count: ids.length, ids }), {
    status: 200,
    headers: jsonHeaders,
  });
};

export const DELETE: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const cleared = clearDeletedIds();
    return new Response(
      JSON.stringify({
        success: true,
        cleared,
        message: cleared
          ? `${cleared} tombstone(s) limpiados: el catálogo puede volver a publicar esos productos.`
          : 'No había tombstones que limpiar.',
      }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, message: error?.message || 'Error al limpiar los tombstones.' }),
      { status: 500, headers: jsonHeaders },
    );
  }
};
