import { findCatalogProduct } from './catalog';
import { sendGenericMailSmtp } from './mailer';
import { findRadarUserById } from './radarAuth';
import { claimDueReminders, deferReminder, finishReminder } from './radarStore';
import type { Reminder } from '../types/radar';

/**
 * ==============================================================================
 * TRADYLOR — AVISOS DIFERIDOS DE MI RADAR
 * ==============================================================================
 * El usuario crea un aviso sobre un producto de su radar con fecha y hora;
 * este dispatcher envía el correo cuando toca. Corre dentro del proceso SSR
 * (setInterval + unref, el mismo truco que analytics.ts): no hay cron externo.
 *
 * - El reclamo (status → 'sending') se escribe en disco ANTES de enviar, así un
 *   tick solapado o un redeploy a mitad de envío no duplica correos.
 * - Sin SMTP se intenta N8N_REMINDER_WEBHOOK_URL; si tampoco hay, se reintenta.
 * ==============================================================================
 */

const TICK_MS = 60_000;
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 10 * 60 * 1000;

let started = false;
let running = false;

function siteOrigin(): string {
  const raw = process.env.PUBLIC_SITE_URL ?? import.meta.env.PUBLIC_SITE_URL ?? 'https://tradylor.com';
  return String(raw).trim().replace(/\/$/, '') || 'https://tradylor.com';
}

function webhookUrl(): string {
  return String(process.env.N8N_REMINDER_WEBHOOK_URL ?? import.meta.env.N8N_REMINDER_WEBHOOK_URL ?? '').trim();
}

const escapeHtml = (value: string): string =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function formatWhen(remindAt: number): string {
  try {
    return new Intl.DateTimeFormat('es-ES', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'Europe/Madrid',
    }).format(new Date(remindAt));
  } catch {
    return new Date(remindAt).toISOString();
  }
}

/** Plantilla del correo (tema Tradylor, mismo tono que el de verificación). */
export function buildReminderHtml(
  reminder: Reminder,
  name: string,
  imageUrl?: string,
): string {
  const origin = siteOrigin();
  const productUrl = `${origin}/p/${encodeURIComponent(reminder.productId)}`;
  const radarUrl = `${origin}/mi-radar`;
  const note = reminder.reasonNote?.trim();

  const media = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(reminder.title)}" style="width:100%;height:100%;object-fit:contain;border-radius:8px" />`
    : `<span style="font-size:.72rem;color:#6b7280;line-height:76px">Sin imagen</span>`;

  return `
    <div style="max-width:560px;margin:0 auto;font-family:Inter,Arial,sans-serif;background:#0d1422;color:#f3f4f6;padding:2rem;border-radius:16px">
      <p style="margin:0 0 .35rem;font-size:.72rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#60a5fa">Mi Radar · Tradylor</p>
      <h1 style="font-size:1.35rem;margin:0 0 .75rem;line-height:1.3">⏰ Llegó la hora de tu aviso de compra</h1>
      <p style="color:#9ca3af;font-size:.9rem;line-height:1.6;margin:0 0 1.25rem">
        Hola ${escapeHtml(name || 'de nuevo')}, pediste que te recordáramos este producto el
        <strong style="color:#f3f4f6">${escapeHtml(formatWhen(reminder.remindAt))}</strong>.
      </p>

      <div style="display:flex;gap:1rem;align-items:center;background:rgba(17,24,39,.7);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:1rem;margin:0 0 1.25rem">
        <div style="flex:0 0 84px;width:84px;height:84px;background:#f8fafc;border-radius:10px;padding:4px;text-align:center">
          ${media}
        </div>
        <div style="min-width:0">
          <p style="margin:0 0 .35rem;font-size:.95rem;font-weight:700;color:#f3f4f6;line-height:1.35">${escapeHtml(reminder.title)}</p>
          <p style="margin:0 0 .25rem;font-size:.78rem;color:#9ca3af">Motivo: <strong style="color:#fbbf24">${escapeHtml(reminder.reason)}</strong></p>
          ${note ? `<p style="margin:0;font-size:.78rem;color:#9ca3af;font-style:italic">“${escapeHtml(note)}”</p>` : ''}
        </div>
      </div>

      <p style="color:#9ca3af;font-size:.88rem;line-height:1.6;margin:0 0 1.25rem">
        Revisa la ficha con el análisis, el historial de precio y las alternativas antes de decidir.
        Y si ya lo tienes claro, puedes retomar la compra desde tu radar.
      </p>

      <p style="margin:0 0 .75rem">
        <a href="${productUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;font-weight:700;padding:.8rem 1.35rem;border-radius:11px;font-size:.88rem;margin-right:.5rem">Ver el producto</a>
        <a href="${radarUrl}" style="display:inline-block;background:rgba(255,255,255,.06);color:#e5e7eb;text-decoration:none;font-weight:700;padding:.8rem 1.35rem;border-radius:11px;font-size:.88rem;border:1px solid rgba(255,255,255,.14)">Abrir Mi Radar</a>
      </p>

      <p style="color:#6b7280;font-size:.72rem;margin:1.5rem 0 0;line-height:1.5">
        Este aviso lo creaste tú en Mi Radar (Tradylor). Para eliminarlo entra en tu panel y cancela el aviso.
      </p>
    </div>
  `;
}

async function notifyFallbackWebhook(email: string, reminder: Reminder, name: string, html: string): Promise<boolean> {
  const webhook = webhookUrl();
  if (!webhook) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: email,
        name,
        subject: `⏰ Aviso de compra: ${reminder.title}`,
        html,
        product: 'tradylor-mi-radar-reminder',
        reminderId: reminder.id,
        remindAt: new Date(reminder.remindAt).toISOString(),
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    return true;
  } catch (error) {
    console.error('[Reminders] Webhook n8n falló:', error);
    return false;
  }
}

async function sendOne(entry: { userId: string; reminder: Reminder }): Promise<void> {
  const { userId, reminder } = entry;
  const user = findRadarUserById(userId);

  if (!user?.email) {
    finishReminder(userId, reminder.id, { status: 'cancelled', lastError: 'Usuario sin email.' });
    return;
  }

  const name = user.name || user.email.split('@')[0] || '';
  const product = findCatalogProduct(reminder.productId);
  const imageUrl = product?.image ? String(product.image) : undefined;
  const html = buildReminderHtml(reminder, name, imageUrl);
  const subject = `⏰ Aviso de compra: ${reminder.title}`;
  const text = `${reminder.title} — ${reminder.reason}. ${reminder.reasonNote ?? ''}`.trim();

  let ok = await sendGenericMailSmtp({ to: user.email, subject, html, text });
  if (!ok) ok = await notifyFallbackWebhook(user.email, reminder, name, html);

  const attempts = reminder.attempts ?? 1;
  if (ok) {
    finishReminder(userId, reminder.id, { status: 'sent', sentAt: Date.now(), lastError: undefined });
    console.log(`[Reminders] Aviso enviado (${reminder.id}) → ${user.email}`);
    return;
  }

  if (attempts >= MAX_ATTEMPTS) {
    finishReminder(userId, reminder.id, {
      status: 'cancelled',
      lastError: 'Sin medio de envío (SMTP/webhook) tras varios intentos.',
    });
    console.error(`[Reminders] Aviso ${reminder.id} cancelado tras ${attempts} intentos fallidos.`);
    return;
  }

  // Sin medio de envío todavía: se reprograma 10 minutos más tarde.
  deferReminder(userId, reminder.id, Date.now() + RETRY_DELAY_MS);
  finishReminder(userId, reminder.id, { status: 'scheduled', lastError: 'Envío fallido: sin SMTP ni webhook configurados.' });
  console.warn(`[Reminders] Aviso ${reminder.id} reprogramado (intento ${attempts}).`);
}

/** Barrido único: procesa todos los avisos vencidos. Devuelve cuántos había. */
export async function dispatchDueReminders(): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const due = claimDueReminders();
    for (const entry of due) {
      try {
        await sendOne(entry);
      } catch (error) {
        console.error('[Reminders] Error procesando aviso:', error);
        deferReminder(entry.userId, entry.reminder.id, Date.now() + RETRY_DELAY_MS);
        finishReminder(entry.userId, entry.reminder.id, { status: 'scheduled', lastError: 'Error inesperado.' });
      }
    }
    return due.length;
  } finally {
    running = false;
  }
}

/** Arranca el dispatcher (una sola vez por proceso). */
export function startReminderScheduler(): void {
  if (started) return;
  started = true;
  const tick = () => {
    void dispatchDueReminders().catch((error) => console.error('[Reminders] Tick falló:', error));
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  tick();
}
