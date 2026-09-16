import type { APIRoute } from 'astro';
import { recordAnalyticsEvent } from '../../../lib/adminDashboard';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const allowedTypes = ['page_view', 'product_click', 'cart_add', 'outbound_click'] as const;
    if (!allowedTypes.includes(body.type)) {
      return new Response(JSON.stringify({ success: false, message: 'Tipo de evento no válido.' }), { status: 400 });
    }
    recordAnalyticsEvent({
      type: body.type,
      productId: typeof body.productId === 'string' ? body.productId.slice(0, 160) : undefined,
      path: typeof body.path === 'string' ? body.path.slice(0, 300) : undefined,
      createdAt: new Date().toISOString(),
    });
    return new Response(JSON.stringify({ success: true }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  } catch {
    return new Response(JSON.stringify({ success: false, message: 'Petición inválida.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
};
