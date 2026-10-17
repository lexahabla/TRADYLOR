import type { APIRoute } from 'astro';
import { requestMagicLogin, RadarAuthError } from '../../../../lib/radarAuth';
import { magicLinkRequestsPerIp } from '../../../../lib/rateLimit';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * Pide un enlace mágico (login sin contraseña). La respuesta es idéntica
 * exista o no la cuenta; el correo sólo se envía si la cuenta existe.
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!magicLinkRequestsPerIp.hit(ip)) {
      return json({ success: false, message: 'Demasiadas solicitudes. Inténtalo en unos minutos.' }, 429);
    }
    const body = await request.json();
    const email = String(body.email ?? '').trim();
    if (!email) return json({ success: false, message: 'Indica tu email.' }, 400);
    const origin = new URL(request.url).origin;
    const result = await requestMagicLogin(email, origin);
    return json({
      success: true,
      message: 'Si existe una cuenta con ese email, recibirás un enlace para entrar sin contraseña.',
      devMagicUrl: result.devMagicUrl,
    });
  } catch (error) {
    if (error instanceof RadarAuthError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};
