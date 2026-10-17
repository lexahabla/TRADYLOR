import type { APIRoute } from 'astro';
import {
  consumeMagicToken,
  getGoogleOAuthConfig,
  RadarAuthError,
  radarSessionCookieOptions,
  radarSessionValue,
  SESSION_COOKIE_NAME,
  toPublicRadarUser,
} from '../../../../../lib/radarAuth';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * POST /api/radar/auth/magic/verify — { token }.
 * Consume el enlace mágico (un solo uso, 15 min) y crea la sesión persistente.
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  try {
    const body = await request.json();
    const user = consumeMagicToken(String(body.token ?? ''));
    cookies.set(SESSION_COOKIE_NAME, radarSessionValue(user), radarSessionCookieOptions(true));
    return json({
      success: true,
      user: toPublicRadarUser(user),
      googleEnabled: Boolean(getGoogleOAuthConfig()),
    });
  } catch (error) {
    if (error instanceof RadarAuthError) {
      return json({ success: false, message: error.message, code: error.code }, error.status);
    }
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};
