import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../../../lib/adminAuth';
import { getAudience360, parseAudienceFilters } from '../../../../../lib/marketingAudience';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** GET /api/admin/marketing/usuarios — audiencia 360 con filtros opcionales del segmentador. */
export const GET: APIRoute = ({ request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  if (session.role !== 'admin') return json({ success: false, message: 'Requiere rol de administrador.' }, 403);

  const url = new URL(request.url);
  const filters = parseAudienceFilters(url);
  const users = getAudience360(filters);
  return json({ success: true, total: users.length, filters, users }, 200);
};
