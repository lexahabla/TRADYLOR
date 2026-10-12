import type { APIRoute } from 'astro';
import { randomBytes } from 'node:crypto';
import {
  buildGoogleAuthUrl,
  createOAuthStateCookie,
  getGoogleOAuthConfig,
} from '../../../../../lib/radarAuth';

export const prerender = false;

/**
 * Arranque del OAuth de Google: redirige a Google con un state aleatorio
 * (CSRF) guardado en cookie. Requiere GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET;
 * sin ellas responde 501 para que el botón del modal lo muestre como
 * "próximamente".
 */
export const GET: APIRoute = ({ request, redirect }) => {
  const config = getGoogleOAuthConfig();
  if (!config) {
    return new Response(
      JSON.stringify({ success: false, message: 'Google OAuth no está configurado todavía.' }),
      { status: 501, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }

  const state = randomBytes(16).toString('hex');
  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/radar/auth/google/callback`;
  const response = redirect(buildGoogleAuthUrl(config, redirectUri, state));
  response.headers.append('Set-Cookie', createOAuthStateCookie(state));
  return response;
};
