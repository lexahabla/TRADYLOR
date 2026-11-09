/** Utilidades HTTP del centro de alertas de precio: sesión de cuenta (infraestructura compartida) y protección básica contra peticiones cruzadas. */
import { getRadarSessionUser } from './radarAuth';

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** 403 con mensaje legible (el cliente lo muestra tal cual). */
export const forbiddenOrigin = (): Response =>
  json({ error: 'origen_no_permitido', message: 'No se pudo verificar el origen de la petición. Recarga la página e inténtalo de nuevo.' }, 403);

/** Usuario autenticado o respuesta 401. Los datos de alertas son privados: nada se sirve sin sesión. */
export function requireUser(request: Request): { userId: string; email: string } | Response {
  const user = getRadarSessionUser(request);
  if (!user) return json({ error: 'auth_required', message: 'Inicia sesión para usar las alertas de precio.' }, 401);
  return { userId: user.id, email: user.email };
}

const hostOf = (value: string | null | undefined): string => {
  const v = String(value ?? '').trim();
  if (!v) return '';
  try {
    return new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).host.toLowerCase();
  } catch {
    return '';
  }
};

/**
 * En peticiones que modifican datos, si el navegador envía Origin debe ser el propio sitio. Detrás del proxy de producción la URL interna de la
 * petición (`http://0.0.0.0:4321`) NO coincide con el Origin público (`https://treidilor.com`): se aceptan, además de esa URL, las cabeceras
 * Host / X-Forwarded-Host, el sitio público configurado y el dominio canónico. `Sec-Fetch-Site: same-origin` (navegadores modernos) también basta.
 */
export function sameOrigin(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return true;
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'same-origin') return true;
  const origin = request.headers.get('origin');
  if (!origin) return true; // clientes sin Origin (la cookie de sesión ya es SameSite=Lax)
  const originHost = hostOf(origin);
  if (!originHost) return false;
  const allowed = new Set(
    [
      hostOf(request.url),
      hostOf(request.headers.get('host')),
      hostOf((request.headers.get('x-forwarded-host') ?? '').split(',')[0]),
      hostOf(process.env.PUBLIC_SITE_URL),
      'treidilor.com',
      'www.treidilor.com',
    ].filter(Boolean),
  );
  return allowed.has(originHost);
}

export async function readJson(request: Request): Promise<Record<string, any> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, any>) : null;
  } catch {
    return null;
  }
}
