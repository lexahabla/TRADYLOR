/**
 * TRADYLOR — Endpoint de analítica (beacons de cliente).
 * Acepta POST con acciones del usuario (compras, clics de contacto, añadidos
 * al carrito, salidas a tienda...) y las registra en la cola de
 * src/lib/analytics.ts, que persiste en segundo plano sin bloquear.
 */
import type { APIRoute } from 'astro';
import { trackEvent, type TipoEvento } from '../../../lib/analytics';

export const prerender = false;

const ALLOWED_TYPES: readonly TipoEvento[] = [
  'page_view',
  'product_click',
  'cart_add',
  'outbound_click',
  'purchase',
  'contact_click',
];

const MAX_BODY_BYTES = 4_096;

export const POST: APIRoute = async ({ request }) => {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return json({ success: false, message: 'Se esperaba application/json.' }, 415);
  }

  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > MAX_BODY_BYTES) {
    return json({ success: false, message: 'Cuerpo demasiado grande.' }, 413);
  }

  try {
    const body: unknown = await request.json();
    const payload = (body ?? {}) as Record<string, unknown>;

    if (
      typeof payload.type !== 'string' ||
      !ALLOWED_TYPES.includes(payload.type as TipoEvento)
    ) {
      return json({ success: false, message: 'Tipo de evento no válido.' }, 400);
    }

    const productId =
      typeof payload.productId === 'string' && payload.productId.trim()
        ? payload.productId.trim().slice(0, 160)
        : undefined;
    const path =
      typeof payload.path === 'string' && payload.path.trim()
        ? payload.path.slice(0, 300)
        : undefined;

    // Cola en memoria + persistencia diferida: respuesta inmediata.
    trackEvent({ type: payload.type as TipoEvento, productId, path, source: 'api' });

    return json({ success: true }, 202);
  } catch {
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
