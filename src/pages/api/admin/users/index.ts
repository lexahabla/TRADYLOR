import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../../lib/adminAuth';
import { createUser, listUsers, UserError } from '../../../../lib/userStore';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const GET: APIRoute = ({ request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  if (session.role !== 'admin') return json({ success: false, message: 'Requiere rol de administrador.' }, 403);
  return json({ success: true, users: listUsers() }, 200);
};

export const POST: APIRoute = async ({ request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticacion requerida.' }, 401);

  try {
    const body = await request.json();
    const user = createUser(
      {
        username: String(body.username ?? ''),
        password: String(body.password ?? ''),
        name: String(body.name ?? ''),
        email: String(body.email ?? ''),
        phone: String(body.phone ?? ''),
        role: body.role === 'admin' ? 'admin' : 'user',
      },
      session,
    );
    return json({ success: true, user }, 201);
  } catch (error) {
    if (error instanceof UserError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'Peticion invalida.' }, 400);
  }
};
