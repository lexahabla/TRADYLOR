/** Utilidades HTTP del centro de alertas de precio: sesión de cuenta (infraestructura compartida) y protección básica contra peticiones cruzadas. */
import { getRadarSessionUser } from './radarAuth';

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Usuario autenticado o respuesta 401. Los datos de alertas son privados: nada se sirve sin sesión. */
export function requireUser(request: Request): { userId: string; email: string } | Response {
  const user = getRadarSessionUser(request);
  if (!user) return json({ error: 'auth_required', message: 'Inicia sesión para usar las alertas de precio.' }, 401);
  return { userId: user.id, email: user.email };
}

/** En peticiones que modifican datos, si el navegador envía Origin debe ser el propio sitio. */
export function sameOrigin(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return true;
  const origin = request.headers.get('origin');
  if (!origin) return true; // clientes sin Origin (la cookie ya es SameSite)
  try {
    return new URL(origin).host === new URL(request.url).host || origin.replace(/\/$/, '') === (process.env.PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
  } catch {
    return false;
  }
}

export async function readJson(request: Request): Promise<Record<string, any> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, any>) : null;
  } catch {
    return null;
  }
}
