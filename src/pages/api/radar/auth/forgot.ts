import type { APIRoute } from 'astro';
import { requestPasswordReset, RadarAuthError } from '../../../../lib/radarAuth';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const email = String(body.email ?? '').trim();
    if (!email) return json({ success: false, message: 'Indica tu email.' }, 400);
    const origin = new URL(request.url).origin;
    const result = requestPasswordReset(email, origin);
    return json({
      success: true,
      message: 'Si existe una cuenta con ese email, recibirás un enlace de recuperación.',
      // Sólo en local: facilita probar el flujo sin SMTP.
      devResetUrl: result.devResetUrl,
    }, 200);
  } catch (error) {
    if (error instanceof RadarAuthError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};
