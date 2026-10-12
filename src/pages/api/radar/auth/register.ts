import type { APIRoute } from 'astro';
import {
  createRadarSession,
  findRadarUserById,
  getGoogleOAuthConfig,
  getRadarSessionUser,
  isGmailEmail,
  registerRadarUser,
  RadarAuthError,
  sendVerificationEmail,
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
    const email = String(body.email ?? '').trim().toLowerCase();
    const user = registerRadarUser({
      email,
      password: String(body.password ?? ''),
      name: String(body.name ?? ''),
      verified: isGmailEmail(email),
    });
    const full = findRadarUserById(user.id);
    if (!full) return json({ success: false, message: 'No se pudo crear la cuenta.' }, 500);

    // Email no gmail: cuenta pendiente de activar. No se crea sesión; se envía
    // el email de bienvenida con el botón de activación.
    if (!user.verified) {
      const origin = new URL(request.url).origin;
      const result = sendVerificationEmail(full, origin);
      return json(
        { success: true, verificationPending: true, devVerifyUrl: result.devVerifyUrl },
        201,
      );
    }

    return json(
      { success: true, user, googleEnabled: Boolean(getGoogleOAuthConfig()) },
      201,
      { 'Set-Cookie': createRadarSession(full) },
    );
  } catch (error) {
    if (error instanceof RadarAuthError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};

// GET devuelve el estado de sesión (alias cómodo del cliente).
export const GET: APIRoute = ({ request }) => {
  const user = getRadarSessionUser(request);
  return json({ authenticated: Boolean(user), user, googleEnabled: Boolean(getGoogleOAuthConfig()) });
};
