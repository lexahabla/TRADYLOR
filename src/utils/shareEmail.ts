/**
 * ==============================================================================
 * TRADYLOR — TARJETA HTML DEL CORREO "COMPARTIR POR EMAIL"
 * ==============================================================================
 * Fuente única del diseño de la tarjeta: barra azul superior, mensaje, producto
 * (imagen + título + categoría + botón) y pie. /share/[id] la usa para la vista
 * previa Y para el contenido que se copia al portapapeles, así que lo que se ve
 * es exactamente lo que se pega en el correo.
 *
 * Compatibilidad con clientes de correo (Gmail, Outlook, Apple Mail):
 *  - maquetación con <table> y estilos 100 % inline (sin <style> ni clases);
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
  es: { cta: 'Ver ficha completa en Tradylor →', footer: 'Enviado desde', tagline: 'Comparativa de precios y análisis' },
  ca: { cta: 'Veure la fitxa completa a Tradylor →', footer: 'Enviat des de', tagline: 'Comparativa de preus i anàlisi' },
  eu: { cta: 'Ikusi fitxa osoa Tradylor-en →', footer: 'Bidali da', tagline: 'Prezioen konparaketa eta azterketa' },
  gl: { cta: 'Ver a ficha completa en Tradylor →', footer: 'Enviado desde', tagline: 'Comparativa de prezos e análise' },
  en: { cta: 'View full sheet on Tradylor →', footer: 'Sent from', tagline: 'Price comparison and analysis' },
  fr: { cta: 'Voir la fiche complète sur Tradylor →', footer: 'Envoyé depuis', tagline: 'Comparateur de prix et analyses' },
  de: { cta: 'Vollständiges Datenblatt auf Tradylor ansehen →', footer: 'Gesendet von', tagline: 'Preisvergleich und Analyse' },
  pt: { cta: 'Ver a ficha completa no Tradylor →', footer: 'Enviado desde', tagline: 'Comparação de preços e análise' },
  it: { cta: 'Vedi la scheda completa su Tradylor →', footer: 'Inviato da', tagline: 'Confronto prezzi e analisi' },
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
    `<a href="${link}" target="_blank" style="display:inline-block;padding:10px 18px;border-radius:8px;background-color:#3b82f6;background-image:linear-gradient(135deg,#60a5fa 0%,#3b82f6 100%);color:#ffffff;font-family:${FONT};font-size:14px;line-height:1.3;font-weight:700;text-decoration:none;">${escapeHtml(labels.cta)}</a>`,
    `</td></tr></table>`,
    `</td></tr>`,

    // Pie
    `<tr><td style="padding:14px 28px;background-color:#f8fafc;border-top:1px solid #e5e7eb;text-align:center;font-family:${FONT};font-size:12px;line-height:1.4;color:#9ca3af;">${escapeHtml(labels.footer)} <strong>Tradylor.com</strong> · ${escapeHtml(labels.tagline)}</td></tr>`,

    `</table></div>`,
  ].join('');
}
