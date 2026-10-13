/**
 * ==============================================================================
 * TRADYLOR — TARJETA HTML DEL CORREO "COMPARTIR POR EMAIL"
 * ==============================================================================
 * Fuente única del diseño de la tarjeta: barra azul superior, mensaje, producto
 * (imagen + título + categoría + botón) y pie. /share/[id] la usa para la vista
 * previa y /api/share/email para el correo que se envía a la cuenta del usuario,
 * así que lo que se ve es exactamente lo que llega.
 *
 * Compatibilidad con clientes de correo (Gmail, Outlook, Apple Mail):
 *  - maquetación con <table> y estilos 100 % inline: el diseño no depende de ninguna hoja
 *    de estilos. Las clases tz-* sólo sirven para apilar el producto en móvil (buildShareEmailDocument);
 *  - cada degradado lleva un color sólido de respaldo;
 *  - URLs absolutas (imagen y enlaces); todo el texto va escapado.
 * ==============================================================================
 */

import type { ShareLangCode } from './share';

export interface ShareEmailLabels {
  /** Texto del botón principal. */
  cta: string;
  /** Prefijo del pie: "Enviado desde". */
  footer: string;
  /** Lema que sigue a "Tradylor.com ·" en el pie. */
  tagline: string;
}

export const SHARE_EMAIL_LABELS: Record<ShareLangCode, ShareEmailLabels> = {
  es: { cta: 'Ver la ficha del producto', footer: 'Enviado desde', tagline: 'Comparativa de precios y análisis' },
  ca: { cta: 'Veure la fitxa del producte', footer: 'Enviat des de', tagline: 'Comparativa de preus i anàlisi' },
  eu: { cta: 'Ikusi produktuaren fitxa', footer: 'Bidali da', tagline: 'Prezioen konparaketa eta azterketa' },
  gl: { cta: 'Ver a ficha do produto', footer: 'Enviado desde', tagline: 'Comparativa de prezos e análise' },
  en: { cta: 'View the product page', footer: 'Sent from', tagline: 'Price comparison and analysis' },
  fr: { cta: 'Voir la fiche du produit', footer: 'Envoyé depuis', tagline: 'Comparateur de prix et analyses' },
  de: { cta: 'Zur Produktseite', footer: 'Gesendet von', tagline: 'Preisvergleich und Analyse' },
  pt: { cta: 'Ver a ficha do produto', footer: 'Enviado desde', tagline: 'Comparação de preços e análise' },
  it: { cta: 'Vedi la scheda del prodotto', footer: 'Inviato da', tagline: 'Confronto prezzi e analisi' },
};

export interface ShareEmailInput {
  /** Mensaje personal (texto plano, sin el enlace). */
  message: string;
  title: string;
  category?: string;
  /** URL absoluta de la imagen del producto. */
  imageUrl: string;
  /** URL absoluta a la que lleva el botón. */
  ctaUrl: string;
  lang: ShareLangCode;
}

export function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const FONT = 'Inter,Arial,Helvetica,sans-serif';
const FONT_HEAD = 'Outfit,Inter,Arial,Helvetica,sans-serif';

/** HTML completo de la tarjeta (un único <div> raíz, listo para pegar en un correo). */
export function buildShareEmailHtml(input: ShareEmailInput): string {
  const labels = SHARE_EMAIL_LABELS[input.lang] ?? SHARE_EMAIL_LABELS.es;
  const message = escapeHtml(input.message);
  const title = escapeHtml(input.title);
  const category = input.category ? escapeHtml(input.category) : '';
  const image = escapeHtml(input.imageUrl);
  const link = escapeHtml(input.ctaUrl);

  return [
    // Contenedor: esquinas redondeadas y borde fino (los clientes que no soportan
    // overflow/border-radius simplemente muestran esquinas rectas).
    `<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;font-family:${FONT};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">`,

    // Barra azul superior
    `<tr><td height="6" style="height:6px;line-height:6px;font-size:0;background-color:#3b82f6;background-image:linear-gradient(90deg,#60a5fa 0%,#3b82f6 40%,#2563eb 100%);">&nbsp;</td></tr>`,

    // Cuerpo
    `<tr><td style="padding:28px 28px 20px;background-color:#ffffff;">`,
    `<p style="margin:0 0 20px;font-family:${FONT};font-size:16px;line-height:1.65;color:#1f2937;">${message}</p>`,
    `<div style="height:1px;line-height:1px;font-size:0;margin:0 0 20px;background-color:#e5e7eb;background-image:linear-gradient(90deg,rgba(229,231,235,0) 0%,#e5e7eb 20%,#e5e7eb 80%,rgba(229,231,235,0) 100%);">&nbsp;</div>`,

    // Producto: imagen | separación | título + categoría + botón.
    // Las clases tz-* son sólo ganchos para que la vista previa se apile en móvil;
    // el diseño (y lo que ve el destinatario) va todo en estilos inline.
    `<table class="tz-prod" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tr>`,
    `<td class="tz-img" width="140" valign="top" style="width:140px;vertical-align:top;">`,
    `<div style="box-sizing:border-box;width:140px;height:140px;border:1px solid #e5e7eb;border-radius:12px;background-color:#f8fafc;overflow:hidden;text-align:center;">`,
    `<img src="${image}" alt="${title}" width="122" height="122" style="display:block;width:122px;height:122px;margin:8px auto 0;border:0;outline:none;object-fit:contain;">`,
    `</div></td>`,
    `<td class="tz-gap" width="20" style="width:20px;font-size:0;line-height:0;">&nbsp;</td>`,
    `<td class="tz-txt" valign="top" style="vertical-align:top;">`,
    `<h2 style="margin:0 0 6px;font-family:${FONT_HEAD};font-size:17px;line-height:1.3;font-weight:700;color:#0d1422;">${title}</h2>`,
    category
      ? `<p style="margin:0 0 14px;font-family:${FONT};font-size:12px;line-height:1.4;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;">${category}</p>`
      : `<div style="height:8px;line-height:8px;font-size:0;">&nbsp;</div>`,
    // Botón: enlace normal a la ficha (misma pestaña, sin target=_blank) con manita al pasar el ratón.
    // La clase tz-cta sólo la usa la vista previa de /share para el efecto hover.
    `<a class="tz-cta" href="${link}" style="display:inline-block;cursor:pointer;padding:10px 18px;border-radius:8px;background-color:#3b82f6;background-image:linear-gradient(135deg,#60a5fa 0%,#3b82f6 100%);color:#ffffff;font-family:${FONT};font-size:14px;line-height:1.3;font-weight:700;text-decoration:none;">${escapeHtml(labels.cta)}</a>`,
    `</td></tr></table>`,
    `</td></tr>`,

    // Pie
    `<tr><td style="padding:14px 28px;background-color:#f8fafc;border-top:1px solid #e5e7eb;text-align:center;font-family:${FONT};font-size:12px;line-height:1.4;color:#9ca3af;">${escapeHtml(labels.footer)} <strong>Tradylor.com</strong> · ${escapeHtml(labels.tagline)}</td></tr>`,

    `</table></div>`,
  ].join('');
}

/** Título del producto sin el sufijo de tienda ("… - Amazon.es"), para el asunto y la tarjeta. */
export function cleanShareTitle(title: string): string {
  return String(title ?? '')
    .replace(/\s*[\-|:]\s*(Amazon(?:\.es)?|PcComponentes|El Corte Inglés|MediaMarkt|Fnac|AliExpress|Carrefour|Apple).*$/i, '')
    .trim();
}

/** Apila el bloque de producto en pantallas estrechas (mismas reglas que la vista previa de /share). */
const MOBILE_CSS =
  '@media only screen and (max-width:520px){.tz-prod,.tz-prod tbody,.tz-prod tr,.tz-prod td{display:block!important;width:auto!important}.tz-gap{display:none!important}.tz-img{padding-bottom:16px!important}.tz-img>div{margin:0 auto!important}.tz-txt{text-align:center!important}}';

/**
 * Correo completo (documento HTML) que se envía: la tarjeta sobre un fondo gris claro más las
 * reglas para móvil. Los clientes que ignoran <style> (Outlook de escritorio) muestran la tarjeta
 * igual, con su maquetación en tablas.
 */
export function buildShareEmailDocument(input: ShareEmailInput): string {
  const card = buildShareEmailHtml(input);
  return [
    `<!doctype html><html lang="${escapeHtml(input.lang)}"><head>`,
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light">`,
    `<title>${escapeHtml(input.title)}</title><style>${MOBILE_CSS}</style></head>`,
    `<body style="margin:0;padding:24px 12px;background-color:#f3f4f6;">${card}</body></html>`,
  ].join('');
}

/** Versión en texto plano del correo (para clientes sin HTML; también la valoran los filtros antispam). */
export function buildShareEmailText(input: Pick<ShareEmailInput, 'message' | 'title' | 'ctaUrl' | 'lang'>): string {
  const labels = SHARE_EMAIL_LABELS[input.lang] ?? SHARE_EMAIL_LABELS.es;
  return `${input.message}\n\n${input.title}\n${labels.cta}: ${input.ctaUrl}\n\n— ${labels.footer} Tradylor.com · ${labels.tagline}`;
}
