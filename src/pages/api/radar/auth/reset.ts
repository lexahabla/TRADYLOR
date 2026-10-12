import type { APIRoute } from 'astro';
import { resetPassword, RadarAuthError } from '../../../../lib/radarAuth';

export const prerender = false;

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const user = resetPassword(String(body.token ?? ''), String(body.password ?? ''));
    return json({ success: true, user, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' }, 200);
  } catch (error) {
    if (error instanceof RadarAuthError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};
