import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { invalidateCatalogCache } from '../../../../lib/catalog';

export const prerender = false;

/**
 * POST /api/admin/catalog/clear-cache
 *
 * Invalida el caché en memoria del catálogo de productos (catalogCache en
 * src/lib/catalog.ts). Útil después de importar o editar productos desde
 * otra página (p. ej. Amazon JSON) para forzar que el panel de administración
 * vea los datos frescos en la próxima recarga de la tabla.
 *
 * Autenticación: sesión de admin (cookie tradylor_admin_session).
 */
export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  invalidateCatalogCache();

  return new Response(
    JSON.stringify({ success: true, message: 'Caché del catálogo invalidado.' }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
};
