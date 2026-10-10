import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { resetAnalitica } from '../../../../lib/analyticsMonths';

export const prerender = false;

/**
 * POST /api/admin/analytics/reset
 *
 * Vacía la medición por completo: eventos en bruto + histórico mensual.
 * Requiere sesión de admin.
 */
export const POST: APIRoute = async ({ request }) => {
  const denied = requireAdminAuth(request);
  if (denied) return denied;

  await resetAnalitica();
  return new Response(
    JSON.stringify({ success: true, resetAt: new Date().toISOString() }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  );
};
