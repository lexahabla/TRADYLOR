import type { APIRoute } from 'astro';
import { findCatalogProduct, productKey } from '../../../lib/catalog';
import { getSmtpConfig, sendGenericMailSmtp } from '../../../lib/mailer';
import { getRadarSessionUser } from '../../../lib/radarAuth';
import {
  shareEmailsExternalPerIp,
  shareEmailsExternalPerUser,
  shareEmailsPerIp,
  shareEmailsPerUser,
} from '../../../lib/rateLimit';
import { clientIp } from '../../../lib/shareGeo';
import { buildProductPageUrl, buildShareText, SHARE_LANG_CODES, type ShareLangCode } from '../../../utils/share';
import { buildShareEmailDocument, buildShareEmailText, cleanShareTitle } from '../../../utils/shareEmail';

export const prerender = false;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MESSAGE_MAX = 1500;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * POST /api/share/email  { productId, lang, message?, to? }
 *
 * "A mi correo": envía la tarjeta del producto (la misma que se ve en /share/<id>) al correo de la
 * cuenta del usuario con sesión, y desde su bandeja la reenviará a quien quiera. También puede
 * enviarse directamente a otra dirección que el usuario escribe en la página (`to`).
 *
 * - `message`: texto del mensaje editado/ traducido en la vista previa (texto plano; si no llega,
 *   se usa la plantilla del idioma). El servidor lo escapa al montar el HTML del correo.
 * - `to`: destinatario opcional. Si no llega, siempre es el email de la cuenta. Si es una dirección
 *   externa, pasa por un tope más bajo de envíos por usuario y por IP (el endpoint no puede usarse
 *   para escribir a terceros sin límite).
 *
 * Seguridad: exige sesión, valida el formato del destinatario y limita los envíos.
 */
export const POST: APIRoute = async ({ request }) => {
  const session = getRadarSessionUser(request);
  if (!session) return json({ ok: false, error: 'auth_required' }, 401);

  let body: { productId?: unknown; lang?: unknown; message?: unknown; to?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const productId = String(body.productId ?? '').trim();
  if (!productId) return json({ ok: false, error: 'missing_product' }, 400);
  const product = findCatalogProduct(productId);
  if (!product) return json({ ok: false, error: 'product_not_found' }, 404);

  const langParam = String(body.lang ?? '').trim().toLowerCase() as ShareLangCode;
  const lang: ShareLangCode = SHARE_LANG_CODES.includes(langParam) ? langParam : 'es';

  // Destinatario: por defecto, el de la cuenta; `to` sólo si tiene formato válido.
  const toParam = String(body.to ?? '').trim().toLowerCase();
  if (toParam && !EMAIL_RE.test(toParam)) return json({ ok: false, error: 'invalid_recipient' }, 400);
  const to = toParam || session.email;
  const isExternal = to !== session.email;

  if (!getSmtpConfig()) return json({ ok: false, error: 'smtp_unavailable' }, 503);

  // Los envíos a terceros llevan tope propio (más bajo) además del general.
  const perUser = isExternal ? shareEmailsExternalPerUser : shareEmailsPerUser;
  const perIp = isExternal ? shareEmailsExternalPerIp : shareEmailsPerIp;
  if (!perUser.hit(session.id) || !perIp.hit(clientIp(request) ?? 'unknown')) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }

  const key = productKey(product);
  const productUrl = buildProductPageUrl(key);
  const title = cleanShareTitle(product.title);
  // Mensaje de la tarjeta: el editado en la vista previa o, si no, la plantilla del idioma.
  // El enlace va en el botón de la tarjeta, no repetido dentro del mensaje.
  const customMessage = String(body.message ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MESSAGE_MAX);
  const message =
    customMessage ||
    buildShareText(
      'email',
      { productId: key, title: product.title, category: product.category },
      productUrl,
      lang,
    )
      .replace(productUrl, '')
      .replace(/\s+/g, ' ')
      .trim();
  // Los clientes de correo necesitan URLs absolutas: la imagen relativa se resuelve contra tradylor.com.
  const imageUrl = /^https?:\/\//i.test(product.image) ? product.image : new URL(product.image, 'https://tradylor.com').href;

  const card = { message, title, category: product.category, imageUrl, ctaUrl: productUrl, lang };
  const sent = await sendGenericMailSmtp({
    to,
    subject: title,
    html: buildShareEmailDocument(card),
    text: buildShareEmailText(card),
  });

  if (!sent) return json({ ok: false, error: 'send_failed' }, 502);
  return json({ ok: true, to }, 200);
};
