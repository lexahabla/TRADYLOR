import type { APIRoute } from 'astro';
import { removeProduct } from '../../../lib/radarStore';
import { getRadarSessionUser } from '../../../lib/radarAuth';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * POST /api/radar/remove — quita un producto del radar del usuario con sesión
 * (anota la baja con tombstone, igual que el push completo).
 * Body: { productId }.
 */
export const POST: APIRoute = async ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'Inicia sesión para gestionar tu radar.' }, 401);
  try {
    const body = await request.json();
    const productId = String(body.productId ?? '').trim();
    if (!productId) return json({ success: false, message: 'Falta el identificador del producto.' }, 400);
    const radar = removeProduct(user.id, productId);
    return json({ success: true, radar }, 200);
  } catch {
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};
