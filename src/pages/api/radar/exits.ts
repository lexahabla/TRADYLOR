import type { APIRoute } from 'astro';
import { getRadarSessionUser } from '../../../lib/radarAuth';
import { trackExit, resolveExit } from '../../../lib/radarStore';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * POST: registra una salida directa (.exit-cta) para el Return Flow.
 * Sólo usuarios autenticados (los anónimos usan LocalStorage del cliente).
 */
export const POST: APIRoute = async ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  try {
    const body = await request.json();
    const productId = String(body.productId ?? '').trim();
    if (!productId) return json({ success: false, message: 'productId requerido.' }, 400);
    const radar = trackExit(user.id, productId, String(body.title ?? ''));
    return json({ success: true, radar });
  } catch {
    return json({ success: false, message: 'Payload inválido.' }, 400);
  }
};

/** PATCH: resuelve una salida (purchased | dismissed). */
export const PATCH: APIRoute = async ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  try {
    const body = await request.json();
    const productId = String(body.productId ?? '').trim();
    const status = String(body.status ?? '');
    if (!productId || (status !== 'purchased' && status !== 'dismissed')) {
      return json({ success: false, message: 'productId y status válidos requeridos.' }, 400);
    }
    const radar = resolveExit(user.id, productId, status);
    return json({ success: true, radar });
  } catch {
    return json({ success: false, message: 'Payload inválido.' }, 400);
  }
};
