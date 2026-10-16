/**
 * ==============================================================================
 * TRADYLOR — EMAIL DE MARKETING (CARRITO ABANDONADO + CUMPLEAÑOS)
 * ==============================================================================
 * - Config del panel de Marketing (plataforma + triggers) en
 *   marketing-email-config.json (volumen de datos, fuera de git).
 * - Aviso de carrito abandonado: manual desde el panel o automático cada 24 h
 *   por usuario mientras el producto siga pendiente (máx. 3 envíos por carrito).
 * - Felicitación de cumpleaños: una vez al año por usuario si el trigger está
 *   activo y el perfil tiene birthDate.
 *
 * Canal de envío: SMTP (lib/mailer) con fallback al webhook n8n
 * (N8N_CART_WEBHOOK_URL). Sin ninguno de los dos, la UI muestra un error claro
 * y el scheduler no envía (no reintenta a ciegas).
 * ==============================================================================
 */

import fs from 'node:fs';
import { dataFile } from './paths';
import { getSmtpConfig, sendGenericMailSmtp } from './mailer';
import { getAllRadarUsers, markBirthdayGreetingSent, markCartReminderSent } from './radarAuth';
import { getRadar } from './radarStore';
import { findCatalogProduct, productKey } from './catalog';
import type { PublicRadarUser } from './radarAuth';
import type { PendingExit } from '../types/radar';

export type EmailPlatform = 'mailchimp' | 'brevo' | 'resend';

export interface MarketingEmailConfig {
  /** Plataforma elegida en el panel (sincronización de segmentos vía API). */
  platform: EmailPlatform | null;
  triggers: {
    /** Bienvenida: ya lo gestionan los emails de verificación de cuenta. */
    welcome: boolean;
    /** Aviso de carrito abandonado cada 24 h. */
    cartRecovery: boolean;
    /** Felicitación de cumpleaños (una vez al año). */
    birthday: boolean;
  };
  updatedAt?: string;
}

export interface EmailPlatformStatus {
  platform: EmailPlatform | null;
  /** true si existe la variable de entorno de API key de la plataforma. */
  envConfigured: boolean;
  envKey: string;
}

const CONFIG_FILE = 'marketing-email-config.json';
const CART_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CART_REMINDER_MAX_COUNT = 3;
const TICK_MS = 10 * 60 * 1000;

const PLATFORM_ENV_KEYS: Record<EmailPlatform, string> = {
  mailchimp: 'MAILCHIMP_API_KEY',
  brevo: 'BREVO_API_KEY',
  resend: 'RESEND_API_KEY',
};

const escapeHtml = (value: string): string =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function siteOrigin(): string {
  const raw = process.env.PUBLIC_SITE_URL ?? import.meta.env.PUBLIC_SITE_URL ?? 'https://tradylor.com';
  return String(raw).trim().replace(/\/$/, '') || 'https://tradylor.com';
}

function cartWebhookUrl(): string {
  return String(process.env.N8N_CART_WEBHOOK_URL ?? import.meta.env.N8N_CART_WEBHOOK_URL ?? '').trim();
}

/** Config por defecto: triggers de carrito y bienvenida activos, sin plataforma. */
export function getMarketingEmailConfig(): MarketingEmailConfig {
  try {
    const raw = fs.readFileSync(dataFile(CONFIG_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<MarketingEmailConfig>;
    return {
      platform: parsed.platform ?? null,
      triggers: {
        welcome: parsed.triggers?.welcome ?? true,
        cartRecovery: parsed.triggers?.cartRecovery ?? true,
        birthday: parsed.triggers?.birthday ?? false,
      },
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return { platform: null, triggers: { welcome: true, cartRecovery: true, birthday: false } };
  }
}

export function saveMarketingEmailConfig(patch: {
  platform?: EmailPlatform | null;
  triggers?: Partial<MarketingEmailConfig['triggers']>;
}): MarketingEmailConfig {
  const current = getMarketingEmailConfig();
  const next: MarketingEmailConfig = {
    platform: patch.platform !== undefined ? patch.platform : current.platform,
    triggers: {
      welcome: patch.triggers?.welcome ?? current.triggers.welcome,
      cartRecovery: patch.triggers?.cartRecovery ?? current.triggers.cartRecovery,
      birthday: patch.triggers?.birthday ?? current.triggers.birthday,
    },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(dataFile(CONFIG_FILE), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Estado de la plataforma elegida: ¿existe la API key en el entorno? */
export function emailPlatformStatus(platform?: EmailPlatform | null): EmailPlatformStatus {
  const chosen = platform !== undefined ? platform : getMarketingEmailConfig().platform;
  const key = chosen ? PLATFORM_ENV_KEYS[chosen] : null;
  return {
    platform: chosen,
    envConfigured: key ? Boolean(process.env[key]?.trim()) : false,
    envKey: key ?? '',
  };
}

/** true si hay canal de envío (SMTP o webhook de carrito). */
export function hasEmailChannel(): boolean {
  return Boolean(getSmtpConfig() || cartWebhookUrl());
}

async function notifyCartWebhook(payload: {
  to: string;
  name: string;
  subject: string;
  html: string;
  userId: string;
  kind: 'cart-recovery' | 'birthday';
}): Promise<boolean> {
  const webhook = cartWebhookUrl();
  if (!webhook) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, product: 'tradylor-marketing' }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    return true;
  } catch (error) {
    console.error('[MarketingEmail] Webhook n8n falló:', error);
    return false;
  }
}

const money = (value: number): string =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value);

const formatDate = (iso: string): string => {
  try {
    return new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeZone: 'Europe/Madrid' }).format(new Date(iso));
  } catch {
    return iso;
  }
};

function shell(title: string, greeting: string, body: string, buttons: string, footer: string): string {
  return `
    <div style="max-width:560px;margin:0 auto;font-family:Inter,Arial,sans-serif;background:#0d1422;color:#f3f4f6;padding:2rem;border-radius:16px">
      <p style="margin:0 0 .35rem;font-size:.72rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#60a5fa">Tradylor · Marketing</p>
      <h1 style="font-size:1.35rem;margin:0 0 .75rem;line-height:1.3">${title}</h1>
      <p style="color:#9ca3af;font-size:.9rem;line-height:1.6;margin:0 0 1.25rem">${greeting}</p>
      ${body}
      <p style="margin:0 0 .75rem">${buttons}</p>
      <p style="color:#6b7280;font-size:.72rem;margin:1.5rem 0 0;line-height:1.5">${footer}</p>
    </div>
  `;
}

/** Plantilla del aviso de carrito abandonado. */
export function buildCartRecoveryHtml(name: string, exits: PendingExit[]): string {
  const origin = siteOrigin();
  const rows = exits
    .map((exit) => {
      const product = findCatalogProduct(exit.productId);
      const productUrl = product ? `${origin}/p/${encodeURIComponent(productKey(product))}` : `${origin}/p/${encodeURIComponent(exit.productId)}`;
      // Salida al carrito/pasarela del comerciante: buildPurchaseUrl prioriza
      // buyNowUrl (checkout directo) y para Amazon genera la cesta con el tag.
      const merchantUrl = product
        ? `${origin}/api/redirect?id=${encodeURIComponent(productKey(product))}&src=cart-reminder`
        : productUrl;
      const image = product?.image || '';
      const price = product?.price;
      const merchant = product?.merchant || '';
      const money = typeof price === 'number' && price > 0
        ? `${price.toFixed(2)} €`
        : '';
      return `
        <div style="display:flex;gap:1rem;align-items:center;background:rgba(17,24,39,.7);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:.9rem 1rem;margin:0 0 .6rem">
          ${image ? `<img src="${escapeHtml(image)}" alt="" width="72" height="72" style="width:72px;height:72px;object-fit:cover;border-radius:10px;flex:0 0 auto;background:#fff" />` : ''}
          <div style="min-width:0;flex:1">
            <p style="margin:0 0 .25rem;font-size:.92rem;font-weight:700;color:#f3f4f6;line-height:1.35">${escapeHtml(exit.title)}</p>
            <p style="margin:0;font-size:.75rem;color:#9ca3af">${money ? `<span style="color:#6ee7b7;font-weight:700">${money}</span> · ` : ''}${merchant ? escapeHtml(merchant) + ' · ' : ''}Lo dejaste en la salida de compra el ${escapeHtml(formatDate(new Date(exit.timestamp).toISOString()))}</p>
          </div>
          <div style="margin-left:auto;flex:0 0 auto;display:flex;flex-direction:column;gap:.4rem;align-items:stretch">
            <a href="${merchantUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;font-weight:700;padding:.5rem .9rem;border-radius:10px;font-size:.78rem;text-align:center">Ir al carrito de la tienda</a>
            <a href="${productUrl}" style="display:inline-block;background:rgba(255,255,255,.06);color:#e5e7eb;text-decoration:none;font-weight:700;padding:.5rem .9rem;border-radius:10px;font-size:.78rem;border:1px solid rgba(255,255,255,.14);text-align:center">Ver en Tradylor</a>
          </div>
        </div>`;
    })
    .join('');

  return shell(
    '🛒 Te esperamos: productos en tu carrito',
    `Hola ${escapeHtml(name || 'de nuevo')}, tienes <strong style="color:#f3f4f6">${exits.length}</strong> producto${exits.length === 1 ? '' : 's'} sin terminar de comprar en Tradylor. Si sigues interesado, puedes retomarlo desde tu radar en cualquier momento:`,
    rows,
    `<a href="${origin}/mi-radar" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;font-weight:700;padding:.8rem 1.35rem;border-radius:11px;font-size:.88rem">Abrir Mi Radar</a>`,
    'Este aviso se envía automáticamente desde Tradylor mientras el producto siga pendiente en tu carrito.',
  );
}

/** Plantilla de la felicitación de cumpleaños. */
export function buildBirthdayHtml(name: string): string {
  const origin = siteOrigin();
  return shell(
    '🎂 ¡Feliz cumpleaños!',
    `Hola ${escapeHtml(name || 'de nuevo')}, todo el equipo de Tradylor te desea un día estupendo. De regalo, te dejamos tu radar con las ofertas y novedades de tus categorías favoritas, listas cuando quieras.`,
    '',
    `<a href="${origin}/mi-radar" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;font-weight:700;padding:.8rem 1.35rem;border-radius:11px;font-size:.88rem;margin-right:.5rem">Ver Mi Radar</a><a href="${origin}/catalogo" style="display:inline-block;background:rgba(255,255,255,.06);color:#e5e7eb;text-decoration:none;font-weight:700;padding:.8rem 1.35rem;border-radius:11px;font-size:.88rem;border:1px solid rgba(255,255,255,.14)">Explorar catálogo</a>`,
    'Si no deseas recibir estos mensajes, puedes desactivarlos desde tu perfil de Mi Radar.',
  );
}

async function deliver(user: PublicRadarUser, subject: string, html: string, text: string, kind: 'cart-recovery' | 'birthday'): Promise<boolean> {
  const name = user.name || user.email.split('@')[0] || '';
  let ok = await sendGenericMailSmtp({ to: user.email, subject, html, text });
  if (!ok) {
    ok = await notifyCartWebhook({ to: user.email, name, subject, html, userId: user.id, kind });
  }
  return ok;
}

/**
 * Envía el aviso de carrito a un usuario (manual desde el panel o automático).
 * Devuelve false si no hay canal de envío configurado.
 */
export async function sendCartRecoveryEmail(user: PublicRadarUser, exits: PendingExit[]): Promise<boolean> {
  if (!user.email || exits.length === 0) return false;
  const name = user.name || user.email.split('@')[0] || '';
  const html = buildCartRecoveryHtml(name, exits);
  const subject = `🛒 ${exits.length === 1 ? 'Tu producto' : 'Tus productos'} te esperan en el carrito`;
  const text = `Tienes ${exits.length} producto(s) sin comprar en Tradylor: ${exits.map((e) => e.title).join(' · ')}`;
  const ok = await deliver(user, subject, html, text, 'cart-recovery');
  if (ok) {
    markCartReminderSent(user.id);
    console.log(`[MarketingEmail] Aviso de carrito enviado → ${user.email} (${exits.length} producto/s)`);
  }
  return ok;
}

/** Envía la felicitación de cumpleaños y marca el año para no repetir. */
export async function sendBirthdayEmail(user: PublicRadarUser, year: number): Promise<boolean> {
  if (!user.email) return false;
  const name = user.name || user.email.split('@')[0] || '';
  const html = buildBirthdayHtml(name);
  const subject = '🎂 ¡Feliz cumpleaños desde Tradylor!';
  const ok = await deliver(user, subject, html, '¡Feliz cumpleaños! Te deseamos un día estupendo desde Tradylor.', 'birthday');
  if (ok) {
    markBirthdayGreetingSent(user.id, year);
    console.log(`[MarketingEmail] Cumpleaños enviado → ${user.email} (${year})`);
  }
  return ok;
}

/** Devuelve el cumpleaños (MM-DD) del perfil, si lo tiene. */
function birthdayKey(birthDate?: string): string | null {
  const raw = String(birthDate ?? '').trim();
  // Acepta "YYYY-MM-DD" o "MM-DD".
  const match = raw.match(/^(\d{4}-)?(\d{2}-\d{2})$/);
  return match ? match[2] : null;
}

/**
 * Barrido único del scheduler de Marketing: carrito abandonado (cada 24 h,
 * máx. 3 avisos) y cumpleaños (una vez al año). Sólo si los triggers están
 * activos y hay canal de envío.
 */
export async function dispatchMarketingTick(): Promise<{ cartSent: number; birthdaysSent: number }> {
  const result = { cartSent: 0, birthdaysSent: 0 };
  const config = getMarketingEmailConfig();
  if (!hasEmailChannel()) return result;

  for (const user of getAllRadarUsers()) {
    try {
      if (config.triggers.cartRecovery) {
        const radar = getRadar(user.id);
        const pending = (radar.pendingExits ?? []).filter((exit) => exit.status === 'pending');
        const lastSentAt = user.cartReminder?.sentAt ? Date.parse(user.cartReminder.sentAt) : 0;
        const count = user.cartReminder?.count ?? 0;
        const due =
          pending.length > 0 &&
          count < CART_REMINDER_MAX_COUNT &&
          Date.now() - lastSentAt >= CART_REMINDER_INTERVAL_MS;
        if (due && (await sendCartRecoveryEmail(user, pending))) {
          result.cartSent += 1;
        }
      }

      if (config.triggers.birthday) {
        const key = birthdayKey(user.birthDate);
        const today = new Date();
        const todayKey = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        if (key === todayKey && user.birthdayGreetingYear !== today.getFullYear()) {
          if (await sendBirthdayEmail(user, today.getFullYear())) {
            result.birthdaysSent += 1;
          }
        }
      }
    } catch (error) {
      console.error(`[MarketingEmail] Tick falló para ${user.email}:`, error);
    }
  }
  return result;
}

let started = false;
let running = false;

/** Arranca el scheduler de Marketing (una sola vez por proceso). */
export function startMarketingScheduler(): void {
  if (started) return;
  started = true;
  const tick = () => {
    if (running) return;
    running = true;
    void dispatchMarketingTick()
      .catch((error) => console.error('[MarketingEmail] Tick falló:', error))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  tick();
}
