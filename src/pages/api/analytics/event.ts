/**
 * TRADYLOR — Endpoint de analítica (beacons de cliente).
 * Acepta POST con acciones del usuario (visitas, duración, compras, clics de
 * contacto, añadidos al carrito, salidas a tienda...) y las registra en la
 * cola de src/lib/analytics.ts, que persiste en segundo plano sin bloquear.
 *
 * La IP del cliente no se guarda: se usa únicamente para descartar las IPs de
 * trabajo (ANALYTICS_IGNORE_IPS, p.ej. el ordenador de desarrollo).
 */
import type { APIRoute } from 'astro';
import { clientIpFrom, trackEvent, type TipoEvento } from '../../../lib/analytics';

export const prerender = false;

const ALLOWED_TYPES: readonly TipoEvento[] = [
  'page_view',
  'page_duration',
  'product_click',
  'cart_add',
  'outbound_click',
  'purchase',
  'contact_click',
];

const MAX_BODY_BYTES = 8_192;

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

    const texto = (value: unknown, max: number) =>
      typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

    const durationMs =
      typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs)
        ? Math.min(Math.max(Math.round(payload.durationMs), 0), 6 * 60 * 60 * 1000)
        : undefined;
    const amount =
      typeof payload.amount === 'number' && Number.isFinite(payload.amount) && payload.amount > 0
        ? Math.round(payload.amount * 100) / 100
        : undefined;

    // Cola en memoria + persistencia diferida: respuesta inmediata.
    trackEvent(
      {
        type: payload.type as TipoEvento,
        productId: texto(payload.productId, 160),
        path: texto(payload.path, 300),
        sessionId: texto(payload.sessionId, 64),
        visitorId: texto(payload.visitorId, 64),
        referrer: texto(payload.referrer, 300),
        durationMs,
        amount,
        source: 'api',
      },
      { ip: clientIpFrom(request) },
    );

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
