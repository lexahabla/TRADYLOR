import type { APIRoute } from 'astro';
import { addProduct, getRadar } from '../../../lib/radarStore';
import { getRadarSessionUser } from '../../../lib/radarAuth';
import type { SavedProduct } from '../../../types/radar';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * POST /api/radar/add — alta puntual de un producto en el radar del usuario
 * con sesión. Alternativa ligera al push completo de POST /api/radar (mismo
 * contrato de respuesta: { success, radar }).
 */
export const POST: APIRoute = async ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'Inicia sesión para guardar en la nube.' }, 401);
  try {
    const body = (await request.json()) as Partial<SavedProduct>;
    const id = String(body.id ?? '').trim();
    if (!id) return json({ success: false, message: 'Falta el identificador del producto.' }, 400);
    const projectId = String((body as { projectId?: string }).projectId ?? 'general').trim() || 'general';
    const radar = addProduct(
      user.id,
      {
        id: id.slice(0, 200),
        title: String(body.title ?? '').slice(0, 300),
        price: String(body.price ?? '').slice(0, 40),
        priceValue: typeof body.priceValue === 'number' && Number.isFinite(body.priceValue) ? body.priceValue : undefined,
        image: String(body.image ?? '').slice(0, 1000),
        buyUrl: String(body.buyUrl ?? '').slice(0, 1000),
        store: body.store === 'aliexpress' ? 'aliexpress' : 'amazon',
        dateAdded: body.dateAdded || new Date().toISOString(),
      },
      projectId,
    );
    return json({ success: true, radar }, 201);
  } catch {
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};

/** GET sin efecto útil: devuelve el radar actual (útil para comprobar estado). */
export const GET: APIRoute = async ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'No autenticado.' }, 401);
  return json({ success: true, radar: getRadar(user.id) }, 200);
};
