import type { APIRoute } from 'astro';
import { RadarAuthError, verifyRadarUser } from '../../../../lib/radarAuth';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** Activa la cuenta desde el enlace del email de bienvenida (?verify=…). */
export const GET: APIRoute = ({ request }) => {
  const token = new URL(request.url).searchParams.get('verify') ?? '';
  if (!token) return json({ success: false, message: 'Falta el token de activación.' }, 400);
  try {
    verifyRadarUser(token);
    return json({ success: true });
  } catch (error) {
    if (error instanceof RadarAuthError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'No se pudo activar la cuenta.' }, 500);
  }
};
