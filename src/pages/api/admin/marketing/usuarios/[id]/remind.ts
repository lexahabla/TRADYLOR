import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../../../../lib/adminAuth';
import { findRadarUserById, toPublicRadarUser } from '../../../../../../lib/radarAuth';
import { getRadar } from '../../../../../../lib/radarStore';
import { hasEmailChannel, sendCartRecoveryEmail } from '../../../../../../lib/marketingEmail';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/**
 * POST /api/admin/marketing/usuarios/[id]/remind
 * Envía AHORA el aviso de carrito abandonado a un usuario (manual del panel).
 */
export const POST: APIRoute = async ({ request, params }) => {
  const session = getSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  if (session.role !== 'admin') return json({ success: false, message: 'Requiere rol de administrador.' }, 403);

  const id = String(params.id ?? '').trim();
  const user = id ? findRadarUserById(id) : null;
  if (!user) return json({ success: false, message: 'Usuario no encontrado.' }, 404);

  const radar = getRadar(user.id);
  const pending = (radar.pendingExits ?? []).filter((exit) => exit.status === 'pending');
  if (pending.length === 0) {
    return json({ success: false, message: 'Este usuario no tiene productos pendientes en el carrito.' }, 409);
  }

  if (!hasEmailChannel()) {
    return json({
      success: false,
      message: 'Sin canal de email configurado: define SMTP o N8N_CART_WEBHOOK_URL en el entorno.',
    }, 503);
  }

  const sent = await sendCartRecoveryEmail(toPublicRadarUser(user), pending);
  if (!sent) {
    return json({ success: false, message: 'El envio ha fallado: revisa la configuracion de email.' }, 502);
  }

  const updated = findRadarUserById(id);
  return json({
    success: true,
    cartReminder: updated?.cartReminder ?? null,
    pendingCount: pending.length,
  }, 200);
};
