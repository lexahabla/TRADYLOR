/**
 * ==============================================================================
 * TRADYLOR — COMPARTIR DESDE MI RADAR (marketing indirecto)
 * ==============================================================================
 * Plantillas de texto + envío a cada red. Todo lo que sale de aquí apunta al
 * enlace corto /p/<id> con UTM para medir el tráfico social indirecto.
 *
 * Tono: recomendación de persona a persona, jamás "compra en mi enlace".
 * ==============================================================================
 */

export type ShareChannel =
  | 'whatsapp'
  | 'telegram'
  | 'x'
  | 'facebook'
  | 'reddit'
  | 'instagram'
  | 'pinterest'
  | 'tiktok'
  | 'email'
  | 'copy'
  | 'native';

export interface ShareInput {
  productId: string;
  title: string;
  category?: string;
}

export interface ShareResult {
  ok: boolean;
  /** opened = app/web abierta; copied = texto copiado; native = share nativo. */
  mode: 'opened' | 'copied' | 'native';
  message?: string;
}

const ORIGIN = 'https://tradylor.com';

/** Canal → nombre visible (para el toast). */
export const SHARE_LABELS: Record<ShareChannel, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  x: 'X',
  facebook: 'Facebook',
  reddit: 'Reddit',
  instagram: 'Instagram',
  pinterest: 'Pinterest',
  tiktok: 'TikTok',
  email: 'Email',
  copy: 'Copiar enlace',
  native: 'Compartir…',
};

/** Plantillas DM (WhatsApp, Telegram, Email). */
const TEMPLATES_DM: string[] = [
  'Oye, le estaba echando un ojo a esto y tras comparar un buen rato en Tradylor.com, es claramente la mejor opción calidad-precio de la categoría. Te dejo la ficha con el análisis y la gráfica de precios: {url}',
];

/** Plantillas hilos (X, Reddit, Facebook). */
const TEMPLATES_THREADS: string[] = [
  'Si alguien anda buscando {categoria}, en Tradylor.com lo han puesto como la opción top tras comparar especificaciones y precio. Aquí tenéis la ficha con el seguimiento de precio activo: {url}',
];

/** Plantillas visuales (Instagram, Pinterest, TikTok): frase clave + enlace. */
const TEMPLATES_VISUAL: string[] = [
  'La mejor opción calidad-precio en {categoria}, con el histórico de precio verificado. Ficha completa → {url}',
  'Comparé specs y precio de todo lo que hay en {categoria} y esto se quedó solo. Ficha en Tradylor → {url}',
  '{categoria}: análisis, pros/contras y gráfica de precio al día. Todo aquí → {url}',
];

function pick(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)] ?? list[0] ?? '';
}

/** Enlace corto con UTM para el canal indicado. */
export function buildShareUrl(productId: string, channel: ShareChannel): string {
  const id = encodeURIComponent(String(productId ?? '').trim());
  const campaign = channel === 'copy' || channel === 'native' ? 'indirect_link' : `indirect_${channel}`;
  return `${ORIGIN}/p/${id}?utm_source=mi_radar&utm_medium=share&utm_campaign=${encodeURIComponent(campaign)}`;
}

/** Texto de la plantilla para un canal ({{categoria}} = categoría o "este producto"). */
export function buildShareText(channel: ShareChannel, input: ShareInput, url?: string): string {
  const link = url ?? buildShareUrl(input.productId, channel);
  const categoria = (input.category ?? '').trim() || 'este producto';
  const group =
    channel === 'whatsapp' || channel === 'telegram' || channel === 'email'
      ? TEMPLATES_DM
      : channel === 'x' || channel === 'reddit' || channel === 'facebook'
        ? TEMPLATES_THREADS
        : TEMPLATES_VISUAL;
  return pick(group).replace(/\{categoria\}/g, categoria).replace(/\{url\}/g, link);
}

function openTab(href: string): boolean {
  try {
    const win = window.open(href, '_blank', 'noopener,noreferrer');
    if (win) return true;
  } catch {
    /* cae al fallback */
  }
  try {
    window.location.href = href;
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Ejecuta el compartir en el canal indicado.
 * Devuelve cómo terminó para que la UI muestre el toast adecuado.
 */
export async function shareTo(channel: ShareChannel, input: ShareInput): Promise<ShareResult> {
  const link = buildShareUrl(input.productId, channel);
  const text = buildShareText(channel, input, link);
  const title = input.title || 'Un producto en Tradylor';

  switch (channel) {
    case 'whatsapp':
      return openTab(`https://wa.me/?text=${encodeURIComponent(text)}`)
        ? { ok: true, mode: 'opened' }
        : { ok: false, mode: 'opened', message: 'No se pudo abrir WhatsApp.' };

    case 'telegram':
      return openTab(
        `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(
          text.replace(link, '').trim(),
        )}`,
      )
        ? { ok: true, mode: 'opened' }
        : { ok: false, mode: 'opened', message: 'No se pudo abrir Telegram.' };

    case 'x':
      return openTab(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}`)
        ? { ok: true, mode: 'opened' }
        : { ok: false, mode: 'opened', message: 'No se pudo abrir X.' };

    case 'facebook':
      return openTab(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}`)
        ? { ok: true, mode: 'opened' }
        : { ok: false, mode: 'opened', message: 'No se pudo abrir Facebook.' };

    case 'reddit':
      return openTab(
        `https://www.reddit.com/submit?url=${encodeURIComponent(link)}&title=${encodeURIComponent(
          input.title || 'Este producto',
        )}`,
      )
        ? { ok: true, mode: 'opened' }
        : { ok: false, mode: 'opened', message: 'No se pudo abrir Reddit.' };

    case 'pinterest':
      return openTab(
        `https://www.pinterest.com/pin/create/button/?url=${encodeURIComponent(link)}&description=${encodeURIComponent(
          text,
        )}`,
      )
        ? { ok: true, mode: 'opened' }
        : { ok: false, mode: 'opened', message: 'No se pudo abrir Pinterest.' };

    case 'email':
      return openTab(
        `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`,
      )
        ? { ok: true, mode: 'opened' }
        : { ok: false, mode: 'opened', message: 'No se pudo abrir el cliente de correo.' };

    case 'instagram':
    case 'tiktok': {
      // Sin web intent fiable: copiamos el texto y abrimos la app/web.
      const copied = await copyText(text);
      openTab(channel === 'instagram' ? 'https://www.instagram.com/' : 'https://www.tiktok.com/');
      return copied
        ? { ok: true, mode: 'copied', message: `Texto copiado. Pégalo en ${SHARE_LABELS[channel]}.` }
        : { ok: false, mode: 'copied', message: 'No se pudo copiar el texto.' };
    }

    case 'copy': {
      const copied = await copyText(`${text}`);
      return copied
        ? { ok: true, mode: 'copied', message: 'Enlace copiado al portapapeles.' }
        : { ok: false, mode: 'copied', message: 'No se pudo copiar el enlace.' };
    }

    case 'native': {
      const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
      if (nav.share) {
        try {
          await nav.share({ title, text: text.replace(link, '').trim(), url: link });
          return { ok: true, mode: 'native' };
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return { ok: true, mode: 'native' };
          }
        }
      }
      const copied = await copyText(text);
      return copied
        ? { ok: true, mode: 'copied', message: 'Tu navegador no permite compartir: texto copiado.' }
        : { ok: false, mode: 'copied', message: 'No se pudo compartir.' };
    }

    default:
      return { ok: false, mode: 'copied', message: 'Canal no soportado.' };
  }
}
