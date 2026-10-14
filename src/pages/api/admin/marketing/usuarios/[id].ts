import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../../../lib/adminAuth';
import { deleteRadarUser } from '../../../../../lib/radarAuth';
import { deleteRadar } from '../../../../../lib/radarStore';

export const prerender = false;

export const DELETE: APIRoute = async ({ params, request }) => {
  const session = getSessionUser(request);
  if (!session) {
    return new Response(JSON.stringify({ success: false, message: 'Autenticacion requerida.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  if (session.role !== 'admin') {
    return new Response(JSON.stringify({ success: false, message: 'Requiere rol de administrador.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  const id = params.id ?? '';
  const removed = deleteRadarUser(id);
  if (removed) deleteRadar(id);
  return new Response(JSON.stringify({ success: removed, message: removed ? 'Usuario eliminado.' : 'Usuario no encontrado.' }), { status: removed ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
};
