import type { APIRoute } from 'astro';
import { updateProductAlert } from '../../../lib/radarStore';
import { getRadarSessionUser } from '../../../lib/radarAuth';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * PUT /api/radar/alert — configura la alerta de bajada de precio de un
 * producto del radar (y los avisos de stock). Body:
 *   { productId, targetPrice?, notifyPriceDrop?, notifyStock? }
 */
export const PUT: APIRoute = async ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'Inicia sesión para activar alertas.' }, 401);
  try {
    const body = await request.json();
    const productId = String(body.productId ?? '').trim();
    if (!productId) return json({ success: false, message: 'Falta el identificador del producto.' }, 400);
    const radar = updateProductAlert(user.id, productId, {
      targetPrice: body.targetPrice === undefined || body.targetPrice === null || body.targetPrice === ''
        ? undefined
        : Number(body.targetPrice),
      notifyPriceDrop: typeof body.notifyPriceDrop === 'boolean' ? body.notifyPriceDrop : undefined,
      notifyStock: typeof body.notifyStock === 'boolean' ? body.notifyStock : undefined,
      clear: body.clear === true,
    });
    if (!radar) return json({ success: false, message: 'El producto no está en tu radar.' }, 404);
    return json({ success: true, radar }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Petición inválida.';
    return json({ success: false, message }, 400);
  }
};
