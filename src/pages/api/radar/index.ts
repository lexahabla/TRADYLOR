import type { APIRoute } from 'astro';
import { getRadarSessionUser } from '../../../lib/radarAuth';
import { getRadar, syncRadar } from '../../../lib/radarStore';
import type { RadarData } from '../../../types/radar';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** GET: radar completo del usuario autenticado. */
export const GET: APIRoute = ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  return json({ success: true, radar: getRadar(user.id) }, 200);
};

/**
 * POST: sync LocalStorage → nube (merge por id de producto, conserva lo más
 * reciente). El cliente envía su RadarData completo; el server lo fusiona.
 */
export const POST: APIRoute = async ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  try {
    const body = (await request.json()) as Partial<RadarData>;
    const radar = syncRadar(user.id, {
      projects: Array.isArray(body.projects) ? body.projects : [],
      pendingExits: Array.isArray(body.pendingExits) ? body.pendingExits : [],
      reminders: Array.isArray(body.reminders) ? body.reminders : [],
      // Bajas (quitar producto / eliminar lista): sin ellas la fusión por unión las deshacía.
      removedProducts: body.removedProducts,
      removedProjects: body.removedProjects,
    });
    return json({ success: true, radar }, 200);
  } catch {
    return json({ success: false, message: 'Payload inválido.' }, 400);
  }
};
