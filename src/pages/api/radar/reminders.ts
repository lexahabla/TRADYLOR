import type { APIRoute } from 'astro';
import { getRadarSessionUser } from '../../../lib/radarAuth';
import { cancelReminder, getRadar, setReminder } from '../../../lib/radarStore';
import {
  REMINDER_MAX_HORIZON_MS,
  REMINDER_MAX_PER_USER,
  REMINDER_REASONS,
} from '../../../types/radar';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** Rate limit mínimo en memoria (no hay ninguno en el repo): 10 avisos/hora por IP. */
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 10;
const hits = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip') || 'unknown';
}

function allow(key: string): boolean {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_MAX;
}

/**
 * GET: radar completo del usuario (la UI lo usa para pintar los avisos).
 */
export const GET: APIRoute = ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  return json({ success: true, radar: getRadar(user.id) }, 200);
};

/**
 * POST: crea (o reprograma) el aviso de compra de un producto del radar.
 * El correo se envía en la fecha y hora elegidas por el dispatcher del SSR.
 */
export const POST: APIRoute = async ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  if (!allow(clientKey(request))) {
    return json({ success: false, message: 'Demasiados avisos creados. Inténtalo más tarde.' }, 429);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ success: false, message: 'Payload inválido.' }, 400);
  }

  const productId = String(body.productId ?? '').trim();
  const title = String(body.title ?? '').trim();
  const remindAt = Number(body.remindAt);
  const reason = String(body.reason ?? '').trim();
  const reasonNote = String(body.reasonNote ?? '').trim();

  if (!productId || !title) {
    return json({ success: false, message: 'Producto y título requeridos.' }, 400);
  }
  if (!Number.isFinite(remindAt)) {
    return json({ success: false, message: 'Fecha y hora requeridas.' }, 400);
  }
  const now = Date.now();
  if (remindAt < now + 60_000) {
    return json({ success: false, message: 'La fecha debe ser al menos un minuto en el futuro.' }, 400);
  }
  if (remindAt > now + REMINDER_MAX_HORIZON_MS) {
    return json({ success: false, message: 'No se pueden programar avisos con más de un año de antelación.' }, 400);
  }
  if (!REMINDER_REASONS.includes(reason)) {
    return json({ success: false, message: 'Motivo no válido.' }, 400);
  }

  const radar = getRadar(user.id);
  const active = (radar.reminders ?? []).filter((r) => r.status !== 'cancelled' && r.status !== 'sent');
  const sameProduct = active.some((r) => r.productId === productId);
  if (!sameProduct && active.length >= REMINDER_MAX_PER_USER) {
    return json({ success: false, message: `Máximo ${REMINDER_MAX_PER_USER} avisos activos.` }, 429);
  }

  const updated = setReminder(user.id, { productId, title, remindAt, reason, reasonNote: reasonNote || undefined });
  return json({ success: true, radar: updated }, 201);
};

/** DELETE: cancela un aviso (?id=). */
export const DELETE: APIRoute = ({ request, url }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'Autenticacion requerida.' }, 401);
  const id = url.searchParams.get('id')?.trim();
  if (!id) return json({ success: false, message: 'id requerido.' }, 400);
  return json({ success: true, radar: cancelReminder(user.id, id) }, 200);
};
