import type { APIRoute } from 'astro';
import { RadarAuthError, resendVerificationEmail } from '../../../../lib/radarAuth';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** Reenvía el email de activación a cuentas pendientes de verificar. */
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const email = String(body.email ?? '').trim();
    if (!email) return json({ success: false, message: 'Indica tu email.' }, 400);
    const origin = new URL(request.url).origin;
    const result = await resendVerificationEmail(email, origin);
    return json({
      success: true,
      message: 'Si existe una cuenta pendiente de activar, recibirás un nuevo correo de activación.',
      // Sólo en local: facilita probar el flujo sin SMTP.
      devVerifyUrl: result.devVerifyUrl,
    });
  } catch (error) {
    if (error instanceof RadarAuthError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};
