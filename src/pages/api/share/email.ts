import type { APIRoute } from 'astro';
import { findCatalogProduct, productKey } from '../../../lib/catalog';
import { sendGenericMailSmtp, getSmtpConfig } from '../../../lib/mailer';
import { buildShareText, buildShareUrl, SHARE_LANG_CODES, type ShareLangCode } from '../../../utils/share';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

// Rate limit: 15 envíos/hora por IP
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 15;
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

/** CTA y footer traducidos para el HTML del correo. */
const CTA_LABELS: Record<ShareLangCode, { cta: string; footer: string }> = {
  es: { cta: 'Ver ficha completa en Tradylor →', footer: 'Enviado desde' },
  ca: { cta: 'Veure la fitxa completa a Tradylor →', footer: 'Enviat des de' },
  eu: { cta: 'Ikusi fitxa osoa Tradylor-en →', footer: 'Bidali da' },
  gl: { cta: 'Ver a ficha completa en Tradylor →', footer: 'Enviado desde' },
  en: { cta: 'View full sheet on Tradylor →', footer: 'Sent from' },
  fr: { cta: 'Voir la fiche complète sur Tradylor →', footer: 'Envoyé depuis' },
  de: { cta: 'Vollständiges Datenblatt auf Tradylor ansehen →', footer: 'Gesendet von' },
  pt: { cta: 'Ver a ficha completa no Tradylor →', footer: 'Enviado desde' },
  it: { cta: 'Vedi la scheda completa su Tradylor →', footer: 'Inviato da' },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/share/email
 * Envía el correo de recomendación con tarjeta HTML (imagen + colores) al
 * destinatario indicado, usando el SMTP configurado en el servidor.
 */
export const POST: APIRoute = async ({ request }) => {
  if (!getSmtpConfig()) {
    return json({ ok: false, error: 'smtp_unavailable' }, 503);
  }

  const ip = clientKey(request);
  if (!allow(ip)) return json({ ok: false, error: 'rate_limited' }, 429);

  let body: { productId?: string; to?: string; lang?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const productId = String(body.productId ?? '').trim();
  const to = String(body.to ?? '').trim();
  const langParam = String(body.lang ?? '').trim() as ShareLangCode;
  const lang: ShareLangCode = SHARE_LANG_CODES.includes(langParam) ? langParam : 'es';

  if (!productId) return json({ ok: false, error: 'missing_product' }, 400);
  if (!EMAIL_RE.test(to)) return json({ ok: false, error: 'invalid_email' }, 400);

  const product = findCatalogProduct(productId);
  if (!product) return json({ ok: false, error: 'product_not_found' }, 404);

  const key = productKey(product);
  const shortUrl = buildShareUrl(key, 'email');
  const rawMessage = buildShareText(
    'email',
    { productId: key, title: product.title, category: product.category },
    shortUrl,
    lang,
  );
  // El enlace se oculta del cuerpo: ya hay botón CTA
  const message = rawMessage.replace(shortUrl, '').replace(/\s+/g, ' ').trim();

  const absoluteImage = /^https?:\/\//i.test(product.image)
    ? product.image
    : new URL(product.image, 'https://tradylor.com').href;

  const cleanTitle = product.title
    .replace(/\s*[\-|:]\s*(Amazon(?:\.es)?|PcComponentes|El Corte Inglés|MediaMarkt|Fnac|AliExpress|Carrefour|Apple).*$/i, '')
    .trim();

  const labels = CTA_LABELS[lang] ?? CTA_LABELS.es;

  const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1);border:1px solid #e5e7eb;">
  <div style="height:6px;background:linear-gradient(90deg,#60a5fa,#3b82f6,#2563eb);"></div>
  <div style="padding:28px 28px 20px;background:#ffffff;">
    <p style="font-size:15px;line-height:1.65;color:#1f2937;margin:0 0 20px;">${message}</p>
    <div style="height:1px;background:linear-gradient(90deg,transparent,#e5e7eb,#e5e7eb,transparent);margin:0 0 20px;"></div>
    <div style="display:flex;gap:20px;align-items:flex-start;">
      <div style="flex-shrink:0;width:140px;height:140px;border-radius:12px;background:#f8fafc;border:1px solid #e5e7eb;display:flex;align-items:center;justify-content:center;overflow:hidden;">
        <img src="${absoluteImage}" alt="${cleanTitle}" width="130" height="130" style="width:100%;height:100%;object-fit:contain;padding:8px;" />
      </div>
      <div style="flex:1;min-width:0;">
        <h2 style="font-size:16px;font-weight:700;color:#0d1422;margin:0 0 6px;line-height:1.3;">${cleanTitle}</h2>
        ${product.category ? `<p style="font-size:12px;color:#6b7280;margin:0 0 12px;text-transform:uppercase;letter-spacing:.04em;font-weight:600;">${product.category}</p>` : ''}
        <a href="${shortUrl}" style="display:inline-block;background:linear-gradient(135deg,#60a5fa,#3b82f6);color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 18px;border-radius:8px;">${labels.cta}</a>
      </div>
    </div>
  </div>
  <div style="background:#f8fafc;padding:14px 28px;border-top:1px solid #e5e7eb;">
    <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">${labels.footer} <strong>Tradylor.com</strong> · Comparativa de precios y análisis</p>
  </div>
</div>`;

  const text = `${message}\n\n${shortUrl}`;

  const sent = await sendGenericMailSmtp({
    to,
    subject: cleanTitle,
    html,
    text,
  });

  if (!sent) return json({ ok: false, error: 'send_failed' }, 502);
  return json({ ok: true });
};
