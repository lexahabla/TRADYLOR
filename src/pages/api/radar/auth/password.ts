import type { APIRoute } from 'astro';
import {
  RadarAuthError,
  changeRadarPassword,
  createRadarSession,
  getRadarSessionUser,
} from '../../../../lib/radarAuth';
import { radarPasswordAttempts } from '../../../../lib/rateLimit';

export const prerender = false;

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

/**
 * POST /api/radar/auth/password  { currentPassword, newPassword }
 * Cambia la contraseña del usuario autenticado (sólo cuentas con email; las de
 * Google no tienen contraseña). Exige la actual y limita los intentos. Al cambiar
 * el hash se invalidan todas las demás sesiones: la actual recibe cookie nueva.
 */
export const POST: APIRoute = async ({ request }) => {
  const session = getRadarSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticación requerida.' }, 401);

  if (!radarPasswordAttempts.hit(session.id)) {
    return json({ success: false, message: 'Demasiados intentos. Inténtalo de nuevo en una hora.' }, 429);
  }

  try {
    const body = await request.json();
    const updated = changeRadarPassword(
      session.id,
      String(body.currentPassword ?? ''),
      String(body.newPassword ?? ''),
    );
    radarPasswordAttempts.reset(session.id);
    return json({ success: true }, 200, { 'Set-Cookie': createRadarSession(updated) });
  } catch (error) {
    if (error instanceof RadarAuthError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};
