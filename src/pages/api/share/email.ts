import type { APIRoute } from 'astro';
import { findCatalogProduct, productKey } from '../../../lib/catalog';
import { getSmtpConfig, sendGenericMailSmtp } from '../../../lib/mailer';
import { getRadarSessionUser } from '../../../lib/radarAuth';
import { shareEmailsPerIp, shareEmailsPerUser } from '../../../lib/rateLimit';
import { clientIp } from '../../../lib/shareGeo';
import { buildProductPageUrl, buildShareText, SHARE_LANG_CODES, type ShareLangCode } from '../../../utils/share';
import { buildShareEmailDocument, buildShareEmailText, cleanShareTitle } from '../../../utils/shareEmail';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * POST /api/share/email  { productId, lang }
 *
 * "A mi correo": envía la tarjeta del producto (la misma que se ve en /share/<id>) al correo de la
 * cuenta del usuario con sesión, y desde su bandeja la reenviará a quien quiera.
 *
 * Seguridad: el destinatario NUNCA viene de la petición. Siempre es el email de la cuenta (verificado
 * al registrarse o al cambiarlo), así que el endpoint no puede usarse para escribir a terceros. Exige
 * sesión y limita los envíos por usuario y por IP.
 */
export const POST: APIRoute = async ({ request }) => {
  const session = getRadarSessionUser(request);
  if (!session) return json({ ok: false, error: 'auth_required' }, 401);

  let body: { productId?: unknown; lang?: unknown };
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

  if (!getSmtpConfig()) return json({ ok: false, error: 'smtp_unavailable' }, 503);

  if (!shareEmailsPerUser.hit(session.id) || !shareEmailsPerIp.hit(clientIp(request) ?? 'unknown')) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }

  const key = productKey(product);
  const productUrl = buildProductPageUrl(key);
  const title = cleanShareTitle(product.title);
  // El enlace va en el botón de la tarjeta, no repetido dentro del mensaje.
  const message = buildShareText(
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
    to: session.email,
    subject: title,
    html: buildShareEmailDocument(card),
    text: buildShareEmailText(card),
  });

  if (!sent) return json({ ok: false, error: 'send_failed' }, 502);
  return json({ ok: true, to: session.email }, 200);
};
