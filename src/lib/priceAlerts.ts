import { findCatalogProduct } from './catalog';
import { readAliCatalog } from './aliexpressCatalog';
import { sendGenericMailSmtp } from './mailer';
import { findRadarUserById } from './radarAuth';
import { collectPriceWatchItems, markPriceCheck } from './radarStore';
import type { SavedProduct } from '../types/radar';

/**
 * ==============================================================================
 * TRADYLOR — ALERTAS DE BAJADA DE PRECIO (Mi Radar)
 * ==============================================================================
 * Worker in-process (setInterval + unref, igual que reminders.ts): no hay cron
 * externo. Cada 6 h recorre los productos vigilados de todos los radares,
 * compara el precio actual con el registrado al guardar y con el precio
 * objetivo, y envía un email de bajada (un solo envío por producto; cambiar el
 * objetivo lo rearma).
 *
 * Fuentes de precio actual, en cascada:
 *  1. Catálogo interno (products.json, actualizado desde el panel admin).
 *  2. Caché del catálogo AliExpress (aliexpress-catalog.json) por id o título.
 * Sin fuente fiable no se toca la alerta (se reintenta en el próximo tick).
 * ==============================================================================
 */

const TICK_MS = 6 * 60 * 60 * 1000; // 6 horas
const INITIAL_DELAY_MS = 45 * 1000; // no pisar el arranque del SSR
/** Tope de correos por tick y proceso (freno de seguridad si algo va mal). */
const MAX_EMAILS_PER_TICK = 40;

let started = false;
let running = false;

function siteOrigin(): string {
  const raw = process.env.PUBLIC_SITE_URL ?? import.meta.env.PUBLIC_SITE_URL ?? 'https://tradylor.com';
  return String(raw).trim().replace(/\/$/, '') || 'https://tradylor.com';
}

const escapeHtml = (value: string): string =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function formatEur(value: number): string {
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value);
  } catch {
    return `${value.toFixed(2)} €`;
  }
}

const normalizeTitle = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

interface CurrentPrice {
  price: number;
  inStock?: boolean;
  image?: string;
}

/** Precio actual: catálogo interno → caché de AliExpress → null. */
function resolveCurrentPrice(product: SavedProduct): CurrentPrice | null {
  const catalog = findCatalogProduct(product.id);
  if (catalog && typeof catalog.price === 'number' && Number.isFinite(catalog.price)) {
    const stock = catalog.pricing?.stockStatus;
    return {
      price: catalog.price,
      inStock: stock ? stock !== 'out_of_stock' : undefined,
      image: catalog.image ? String(catalog.image) : undefined,
    };
  }
  if (product.store === 'aliexpress') {
    const snapshot = readAliCatalog();
    if (snapshot?.products?.length) {
      const idNeedle = product.id.trim().toLowerCase();
      let match = snapshot.products.find(
        (item) => item.externalId && item.externalId.trim().toLowerCase() === idNeedle,
      );
      if (!match) {
        const title = normalizeTitle(product.title);
        if (title.length >= 8) {
          match = snapshot.products.find((item) => {
            const candidate = normalizeTitle(item.title ?? '');
            return candidate === title || candidate.includes(title) || title.includes(candidate);
          });
        }
      }
      if (match && typeof match.price === 'number' && Number.isFinite(match.price)) {
        return { price: match.price, inStock: match.inStock, image: match.image || undefined };
      }
    }
  }
  return null;
}

function buildAlertEmail(input: {
  name: string;
  product: SavedProduct;
  currentPrice: number;
  initialPrice?: number;
  targetPrice?: number;
  image?: string;
  kind: 'drop' | 'stock';
}): { subject: string; html: string; text: string } {
  const origin = siteOrigin();
  const productUrl = `${origin}/p/${encodeURIComponent(input.product.id)}`;
  const radarUrl = `${origin}/mi-radar`;
  const initial = input.initialPrice;
  const savings =
    typeof initial === 'number' && initial > input.currentPrice
      ? Math.round(((initial - input.currentPrice) / initial) * 100)
      : null;

  const media = input.image
    ? `<img src="${escapeHtml(input.image)}" alt="${escapeHtml(input.product.title)}" style="width:100%;height:100%;object-fit:contain;border-radius:8px" />`
    : input.product.image
      ? `<img src="${escapeHtml(input.product.image)}" alt="${escapeHtml(input.product.title)}" style="width:100%;height:100%;object-fit:contain;border-radius:8px" />`
      : `<span style="font-size:.72rem;color:#6b7280;line-height:76px">Sin imagen</span>`;

  const headline =
    input.kind === 'drop' ? '📉 ¡Bajó el precio que vigilabas!' : '📦 ¡Vuelta a stock!';

  const priceLine =
    input.kind === 'drop'
      ? `
        <p style="margin:.15rem 0 0;font-size:1.35rem;font-weight:800;color:#34d399">${escapeHtml(formatEur(input.currentPrice))}</p>
        ${typeof initial === 'number' ? `<p style="margin:.2rem 0 0;font-size:.82rem;color:#9ca3af">Al guardarlo: <s>${escapeHtml(formatEur(initial))}</s>${savings !== null ? ` · ahorro <strong style="color:#34d399">${savings}%</strong>` : ''}</p>` : ''}
        ${typeof input.targetPrice === 'number' ? `<p style="margin:.2rem 0 0;font-size:.78rem;color:#9ca3af">Tu precio objetivo: ${escapeHtml(formatEur(input.targetPrice))}</p>` : ''}
      `
      : `<p style="margin:.15rem 0 0;font-size:.95rem;font-weight:700;color:#fbbf24">El producto vuelve a estar disponible.</p>`;

  const subject =
    input.kind === 'drop'
      ? `📉 Bajó de precio: ${input.product.title}`
      : `📦 En stock de nuevo: ${input.product.title}`;
  const text = `${input.product.title} ahora está a ${formatEur(input.currentPrice)}. ${productUrl}`;

  const html = `
    <div style="max-width:560px;margin:0 auto;font-family:Inter,Arial,sans-serif;background:#0d1422;color:#f3f4f6;padding:2rem;border-radius:16px">
      <p style="margin:0 0 .35rem;font-size:.72rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#60a5fa">Mi Radar · Tradylor</p>
      <h1 style="font-size:1.35rem;margin:0 0 .75rem;line-height:1.3">${headline}</h1>
      <p style="color:#9ca3af;font-size:.9rem;line-height:1.6;margin:0 0 1.25rem">
        Hola ${escapeHtml(name || 'de nuevo')}, este producto de tu Radar acaba de cambiar:
      </p>

      <div style="display:flex;gap:1rem;align-items:center;background:rgba(17,24,39,.7);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:1rem;margin:0 0 1.25rem">
        <div style="flex:0 0 84px;width:84px;height:84px;background:#f8fafc;border-radius:10px;padding:4px;text-align:center">
          ${media}
        </div>
        <div style="min-width:0">
          <p style="margin:0 0 .35rem;font-size:.95rem;font-weight:700;color:#f3f4f6;line-height:1.35">${escapeHtml(input.product.title)}</p>
          ${priceLine}
        </div>
      </div>

      <p style="margin:0 0 .75rem">
        <a href="${productUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;font-weight:700;padding:.8rem 1.35rem;border-radius:11px;font-size:.88rem;margin-right:.5rem">Ver el producto</a>
        <a href="${radarUrl}" style="display:inline-block;background:rgba(255,255,255,.06);color:#e5e7eb;text-decoration:none;font-weight:700;padding:.8rem 1.35rem;border-radius:11px;font-size:.88rem;border:1px solid rgba(255,255,255,.14)">Abrir Mi Radar</a>
      </p>

      <p style="color:#6b7280;font-size:.72rem;margin:1.5rem 0 0;line-height:1.5">
        0% Spam: sólo te avisamos cuando de verdad baja el precio (o vuelve a stock). Puedes cambiar el objetivo desde Mi Radar.
      </p>
    </div>
  `;

  return { subject, html, text };
}

async function notifyFallbackWebhook(email: string, subject: string, html: string, productId: string): Promise<boolean> {
  const webhook = String(
    process.env.N8N_PRICE_ALERT_WEBHOOK_URL ?? import.meta.env.N8N_PRICE_ALERT_WEBHOOK_URL ?? '',
  ).trim();
  if (!webhook) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: email, subject, html, product: 'tradylor-price-alert', productId }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    return true;
  } catch (error) {
    console.error('[PriceAlerts] Webhook n8n falló:', error);
    return false;
  }
}

/** Barrido único: compara precios y envía las alertas cumplidas. */
export async function runPriceAlertCheck(): Promise<number> {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    const items = collectPriceWatchItems();
    for (const { userId, product } of items) {
      if (sent >= MAX_EMAILS_PER_TICK) break;
      try {
        const current = resolveCurrentPrice(product);
        if (!current) continue; // sin fuente fiable: se mira en el próximo tick

        const target = typeof product.targetPrice === 'number' ? product.targetPrice : undefined;
        const priceDrop =
          product.notifyPriceDrop !== false &&
          typeof target === 'number' &&
          current.price <= target;
        const backInStock =
          product.notifyStock === true &&
          current.inStock === true &&
          product.priceAlert?.lastInStock === false;

        // Siempre se registra lo observado (alimenta el badge y el aviso de stock).
        markPriceCheck(userId, product.id, {
          lastPrice: current.price,
          lastInStock: current.inStock,
          triggered: priceDrop, // un solo email de bajada por producto
        });

        if (!priceDrop && !backInStock) continue;

        const user = findRadarUserById(userId);
        if (!user?.email) continue;
        const name = user.name || user.email.split('@')[0] || '';
        const mail = buildAlertEmail({
          name,
          product,
          currentPrice: current.price,
          initialPrice: product.initialPrice,
          targetPrice: target,
          image: current.image,
          kind: priceDrop ? 'drop' : 'stock',
        });
        let ok = await sendGenericMailSmtp({ to: user.email, ...mail });
        if (!ok) ok = await notifyFallbackWebhook(user.email, mail.subject, mail.html, product.id);
        if (ok) {
          sent += 1;
          console.log(`[PriceAlerts] Alerta enviada (${product.id} → ${user.email}).`);
        }
      } catch (error) {
        console.error(`[PriceAlerts] Error con ${product.id}:`, error);
      }
    }
  } finally {
    running = false;
  }
  return sent;
}

/** Arranca el worker de alertas (una sola vez por proceso). */
export function startPriceAlertScheduler(): void {
  if (started) return;
  started = true;
  const tick = () => {
    void runPriceAlertCheck().catch((error) => console.error('[PriceAlerts] Tick falló:', error));
  };
  const boot = setTimeout(tick, INITIAL_DELAY_MS);
  boot.unref?.();
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
}
