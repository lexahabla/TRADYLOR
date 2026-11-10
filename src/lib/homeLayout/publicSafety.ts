/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · SEGURIDAD DE DESTINOS E IMÁGENES PÚBLICOS (etapa 6, funciones PURAS)
 * ==============================================================================
 * Reglas estrictas que se aplican ANTES de mostrar en la web pública un enlace o una imagen escritos en el editor (editorial e historias).
 * No sustituyen a `validate.ts` (que sigue siendo la validación estructural al guardar): son una segunda barrera que no invalida los
 * documentos ya guardados; lo que no pasa se omite en público y se informa al activar.
 *
 *  · Rutas propias: empiezan por «/», sin «//», sin «..» (ni codificado), sin barras invertidas, espacios ni caracteres de control, y NUNCA apuntan
 *    a zonas administrativas o técnicas (`/upayp1b4`, `/api`, `/out`, `/checkout`, `/admin`, `/_astro`, `/_image`).
 *  · Imágenes: ruta propia o https, con extensión de imagen admitida (jpg, jpeg, png, webp, avif, gif). Los vídeos (mp4/webm) no valen como imagen.
 *    Las https externas no pueden llevar credenciales, ni puerto, ni apuntar a localhost, IP o nombres internos.
 * ==============================================================================
 */

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'] as const;

const FORBIDDEN_PREFIXES = ['/upayp1b4', '/api', '/out', '/checkout', '/admin', '/_astro', '/_image'];
const CTRL = /[\s<>"'`\\\u0000-\u001f\u007f]/;

function decodedLower(p: string): string | null {
  try {
    return decodeURIComponent(p).toLowerCase();
  } catch {
    return null;
  }
}

/** Ruta propia permitida como destino público (sin zonas administrativas ni técnicas). */
export function isPublicSafePath(u: unknown): u is string {
  if (typeof u !== 'string' || u.length === 0 || u.length > 300) return false;
  if (!u.startsWith('/') || u.startsWith('//') || CTRL.test(u)) return false;
  const dec = decodedLower(u);
  if (dec === null || dec.includes('..') || dec.includes('\\') || dec.startsWith('//')) return false;
  const pathOnly = dec.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  return !FORBIDDEN_PREFIXES.some((f) => pathOnly === f || pathOnly.startsWith(`${f}/`));
}

/** Extensión de imagen de la parte de ruta (sin consulta ni fragmento), en minúsculas, o null. */
export function imageExtension(pathPart: string): string | null {
  const m = /\.([a-z0-9]{2,5})$/i.exec(pathPart.split(/[?#]/)[0]);
  return m ? m[1].toLowerCase() : null;
}

const isIp = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || /^\[.*\]$/.test(h);
const INTERNAL_HOST = /(^|\.)(localhost|local|internal|lan|home|intranet|corp)$/i;

/** URL https externa admisible para una imagen. */
export function isSafeExternalImageUrl(u: string): boolean {
  if (u.length > 600 || CTRL.test(u)) return false;
  let p: URL;
  try {
    p = new URL(u);
  } catch {
    return false;
  }
  if (p.protocol !== 'https:' || p.username || p.password || p.port) return false;
  const host = p.hostname.toLowerCase();
  if (!host.includes('.') || isIp(host) || INTERNAL_HOST.test(host)) return false;
  const dec = decodedLower(p.pathname);
  if (dec === null || dec.includes('..')) return false;
  return (IMAGE_EXTENSIONS as readonly string[]).includes(imageExtension(p.pathname) ?? '');
}

/** Imagen admisible en la web pública (ruta propia o https externa), con extensión de imagen. */
export function isPublicSafeImage(u: unknown): u is string {
  if (typeof u !== 'string' || !u) return false;
  if (u.startsWith('/')) {
    if (u.length > 300 || u.startsWith('//') || CTRL.test(u)) return false;
    const dec = decodedLower(u);
    if (dec === null || dec.includes('..') || dec.includes('\\')) return false;
    if (FORBIDDEN_PREFIXES.some((f) => dec === f || dec.startsWith(`${f}/`))) return false;
    return (IMAGE_EXTENSIONS as readonly string[]).includes(imageExtension(u) ?? '');
  }
  return isSafeExternalImageUrl(u);
}

/** Enlace https externo para un botón editorial. */
export function isPublicSafeExternalUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > 600 || CTRL.test(u)) return false;
  try {
    const p = new URL(u);
    const host = p.hostname.toLowerCase();
    return p.protocol === 'https:' && !p.username && !p.password && !p.port && host.includes('.') && !isIp(host) && !INTERNAL_HOST.test(host);
  } catch {
    return false;
  }
}
