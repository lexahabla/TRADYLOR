/**
 * Utilidades de medios para la galería de productos (imágenes + vídeos).
 * Válidas tanto en servidor (Astro frontmatter/endpoints) como en cliente.
 */

/** ¿La URL apunta a un vídeo? (archivos directos o plataformas embebibles) */
export function isVideoUrl(url: string): boolean {
  const u = String(url || '').trim().toLowerCase();
  if (!u) return false;
  if (/\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/.test(u)) return true;
  return /(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com)/.test(u);
}

/**
 * URL de incrustación (iframe) para vídeos de plataformas.
 * Devuelve null para archivos directos (mp4/webm…): se usan con <video>.
 */
export function videoEmbedUrl(url: string, autoplay = false): string | null {
  const u = String(url || '').trim();

  const yt = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/i);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}${autoplay ? '?autoplay=1&mute=1' : ''}`;

  const vimeo = u.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}${autoplay ? '?autoplay=1&mute=1' : ''}`;

  const dailymotion = u.match(/dailymotion\.com\/(?:video|embed\/video)\/([\w]+)/i);
  if (dailymotion) return `https://www.dailymotion.com/embed/video/${dailymotion[1]}${autoplay ? '?autoplay=1' : ''}`;

  return null;
}

/**
 * Miniatura (fotograma) de un vídeo para mostrarlo como imagen en galerías.
 * - YouTube / Vimeo / Dailymotion → URL de la miniatura del proveedor.
 * - Archivos directos (mp4/webm…) → null: usar <video preload="metadata">.
 */
export function videoThumbUrl(url: string): string | null {
  const u = String(url || '').trim();

  const yt = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/i);
  if (yt) return `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg`;

  const vimeo = u.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (vimeo) return `https://vumbnail.com/${vimeo[1]}.jpg`;

  const dailymotion = u.match(/dailymotion\.com\/(?:video|embed\/video)\/([\w]+)/i);
  if (dailymotion) return `https://www.dailymotion.com/thumbnail/video/${dailymotion[1]}`;

  return null;
}
