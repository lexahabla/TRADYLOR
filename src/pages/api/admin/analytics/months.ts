import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { getMesesAnalitica } from '../../../../lib/analyticsMonths';

export const prerender = false;

/**
 * GET /api/admin/analytics/months
 *
 * Histórico mensual de analítica (meses cerrados + mes en curso).
 * Requiere sesión de admin.
 */
export const GET: APIRoute = async ({ request }) => {
  const denied = requireAdminAuth(request);
  if (denied) return denied;

  const resumen = getMesesAnalitica();
  return new Response(JSON.stringify(resumen), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
};
