import type { APIRoute } from 'astro';
import { getRadarSessionUser } from '../../../lib/radarAuth';
import { createProject, deleteProject } from '../../../lib/radarStore';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** POST: crea una carpeta/lista. */
export const POST: APIRoute = async ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  try {
    const body = await request.json();
    const radar = createProject(user.id, String(body.name ?? ''), String(body.description ?? ''));
    return json({ success: true, radar }, 200);
  } catch {
    return json({ success: false, message: 'Payload inválido.' }, 400);
  }
};

/** DELETE: borra una carpeta (?id=…); los productos vuelven a General. */
export const DELETE: APIRoute = ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!id) return json({ success: false, message: 'id requerido.' }, 400);
  const radar = deleteProject(user.id, id);
  return json({ success: true, radar }, 200);
};
