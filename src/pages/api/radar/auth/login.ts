import type { APIRoute } from 'astro';
import {
  getGoogleOAuthConfig,
  loginRadarUser,
  RadarAuthError,
  radarSessionCookieOptions,
  radarSessionValue,
  SESSION_COOKIE_NAME,
  toPublicRadarUser,
} from '../../../../lib/radarAuth';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * POST /api/radar/auth/login — { email, password, rememberMe }.
 *
 * La duración de la sesión depende de `rememberMe`:
 *  - true  → cookie persistente con maxAge de 30 días (2592000 s).
 *  - false → sin maxAge ni expires: Session Cookie nativa que el navegador
 *            destruye al cerrar la ventana o el perfil (incluido incógnito).
 * Seguridad OWASP: httpOnly, sameSite=lax, path=/ y secure en producción.
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  try {
    const body = await request.json();
    const user = loginRadarUser(String(body.email ?? ''), String(body.password ?? ''));
    const rememberMe = (body as { rememberMe?: unknown }).rememberMe === true;
    cookies.set(SESSION_COOKIE_NAME, radarSessionValue(user), radarSessionCookieOptions(rememberMe));
    return json(
      {
        success: true,
        user: toPublicRadarUser(user),
        googleEnabled: Boolean(getGoogleOAuthConfig()),
      },
      200,
    );
  } catch (error) {
    if (error instanceof RadarAuthError) {
      return json({ success: false, message: error.message, code: error.code }, error.status);
    }
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};
