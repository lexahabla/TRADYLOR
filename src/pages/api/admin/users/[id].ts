import type { APIRoute } from 'astro';
import { createAdminSession, getSessionUser } from '../../../../lib/adminAuth';
import { deleteUser, findUserById, updateUser, UserError, verifyPassword } from '../../../../lib/userStore';

export const prerender = false;

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

export const PATCH: APIRoute = async ({ params, request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticacion requerida.' }, 401);

  const id = params.id ?? '';
  try {
    const body = await request.json();
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.email !== undefined) patch.email = body.email;
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.role !== undefined) patch.role = body.role;
    if (body.password !== undefined && body.password !== '') patch.password = body.password;

    // Cambio de contraseña propio: exige la contraseña actual
    if (id === session.id && patch.password) {
      const self = findUserById(session.id);
      const current = String(body.currentPassword ?? '');
      if (!self || !current || !verifyPassword(self, current)) {
        return json({ success: false, message: 'La contraseña actual no es correcta.' }, 403);
      }
    }

    const user = updateUser(id, patch, session);

    // Cambio de contraseña propio: la cookie actual queda invalidada → se renueva.
    let cookie: string | undefined;
    if (id === session.id && patch.password) {
      const refreshed = findUserById(id);
      if (refreshed) cookie = createAdminSession(refreshed);
    }

    return json(
      { success: true, user },
      200,
      cookie ? { 'Set-Cookie': cookie } : {},
    );
  } catch (error) {
    if (error instanceof UserError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'Peticion invalida.' }, 400);
  }
};

export const DELETE: APIRoute = ({ params, request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticacion requerida.' }, 401);

  try {
    deleteUser(params.id ?? '', session);
    return json({ success: true }, 200);
  } catch (error) {
    if (error instanceof UserError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'Peticion invalida.' }, 400);
  }
};
