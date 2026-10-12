import type { APIRoute } from 'astro';
import {
  createRadarSession,
  getGoogleOAuthConfig,
  loginRadarUser,
  RadarAuthError,
  toPublicRadarUser,
} from '../../../../lib/radarAuth';

export const prerender = false;

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const user = loginRadarUser(String(body.email ?? ''), String(body.password ?? ''));
    return json(
      { success: true, user: toPublicRadarUser(user), googleEnabled: Boolean(getGoogleOAuthConfig()) },
      200,
      { 'Set-Cookie': createRadarSession(user) },
    );
  } catch (error) {
    if (error instanceof RadarAuthError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};
