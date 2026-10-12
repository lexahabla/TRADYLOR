import type { APIRoute } from 'astro';
import {
  clearOAuthStateCookie,
  createRadarSession,
  exchangeGoogleCode,
  getGoogleOAuthConfig,
  RadarAuthError,
  readOAuthStateCookie,
  upsertGoogleUser,
} from '../../../../../lib/radarAuth';

export const prerender = false;

/**
 * Callback del OAuth de Google: valida el state (CSRF), intercambia el code
 * por el perfil, hace upsert de la cuenta y crea la sesión. Redirige a
 * /mi-radar (con ?auth=ok o ?auth_error=…).
 */
export const GET: APIRoute = async ({ request, redirect }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const origin = url.origin;
  const fail = (reason: string) => {
    const response = redirect(`/mi-radar?auth_error=${encodeURIComponent(reason)}`);
    response.headers.append('Set-Cookie', clearOAuthStateCookie());
    return response;
  };

  const config = getGoogleOAuthConfig();
  if (!config) return fail('Google OAuth no está configurado.');
  if (!code || !state) return fail('Faltan parámetros de Google.');
  const cookieState = readOAuthStateCookie(request);
  if (!cookieState || cookieState !== state) return fail('State inválido (intenta de nuevo).');

  try {
    const profile = await exchangeGoogleCode(config, code, `${origin}/api/radar/auth/google/callback`);
    const user = upsertGoogleUser({ email: profile.email, name: profile.name });
    const response = redirect('/mi-radar?auth=ok');
    response.headers.append('Set-Cookie', createRadarSession(user));
    response.headers.append('Set-Cookie', clearOAuthStateCookie());
    return response;
  } catch (error) {
    const message = error instanceof RadarAuthError ? error.message : 'Error desconocido con Google.';
    return fail(message);
  }
};
