/**
 * ==============================================================================
 * TREIDILOR — ENLACES CORTOS / DE AFILIADO DE TEMU (temu.to, share.temu.com)
 * ==============================================================================
 * Un enlace corto de afiliado de Temu (p. ej. https://temu.to/k/xxxxxxxx) redirige a la ficha del producto. Para importarlo hay que
 * averiguar el `goodsId` al que apunta. Este módulo sigue las redirecciones en el SERVIDOR con estas garantías:
 *
 *  - Sólo https y sólo dominios de Temu (temu.to, *.temu.com y la página de descarga static-cross.kwcdn.com): cualquier otro destino se
 *    detiene (no se sigue), así que no puede usarse para hacer peticiones a sitios arbitrarios ni a la red interna.
 *  - Máximo 6 saltos y 10 s por petición; sin cookies, sin credenciales y sin enviar ningún dato de Treidilor.
 *  - El `goodsId` se busca en CADA salto: ruta `…-g-<id>.html`, parámetro `goods_id`/`goodsId`, y URLs anidadas (codificadas) dentro de
 *    los parámetros. Si no aparece, se explica (enlace caducado, incorrecto o bloqueado) sin inventar nada.
 *  - El enlace corto original se conserva como ENLACE DE AFILIADO (separado del de origen /es/-g-<id>.html).
 * ==============================================================================
 */

export interface Hop {
  /** URL del salto SIN parámetros (no se guardan tokens de seguimiento). */
  url: string;
  status: number;
}

export type ResolveResult =
  | { ok: true; goodsId: string; chain: Hop[] }
  | { ok: false; code: 'not_short_link' | 'blocked' | 'no_redirect' | 'no_goods_id' | 'foreign_host' | 'too_many_redirects' | 'network'; message: string; chain: Hop[] };

const SHORT_HOST = /^(temu\.to|share\.temu\.com)$/i;
const FOLLOW_HOST = /(^|\.)temu\.(com|to)$|^static-cross\.kwcdn\.com$/i;
const MAX_HOPS = 6;
const TIMEOUT_MS = 10_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function parse(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
}

/** ¿Es un enlace corto de Temu (temu.to/…, share.temu.com/…) con ruta? */
export function isTemuShortLink(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const u = parse(raw.trim());
  return Boolean(u && SHORT_HOST.test(u.hostname) && u.pathname.length > 1);
}

/** Enlace corto saneado para guardarlo como enlace de afiliado: https, sin fragmento ni credenciales. */
export function cleanShortLink(raw: string): string {
  const u = parse(raw.trim());
  if (!u) return '';
  u.hash = '';
  return u.toString();
}

const safeDecode = (s: string): string => {
  try { return decodeURIComponent(s); } catch { return s; }
};

/** Busca un goodsId de Temu en una URL o texto: ruta `-g-<id>.html`, `goods_id=<id>` y URLs anidadas/codificadas (profundidad 3). */
export function extractGoodsId(text: string, depth = 0): string | undefined {
  const path = text.match(/-g-([0-9]{6,20})\.html/);
  if (path) return path[1];
  const param = text.match(/[?&#]goods_?id(?:_str)?=([0-9]{6,20})/i);
  if (param) return param[1];
  if (depth >= 3) return undefined;
  const decoded = safeDecode(text);
  if (decoded !== text) {
    const inner = extractGoodsId(decoded, depth + 1);
    if (inner) return inner;
  }
  try {
    for (const value of new URL(text).searchParams.values()) {
      if (value.length < 12 || value === text) continue;
      const inner = extractGoodsId(value, depth + 1);
      if (inner) return inner;
    }
  } catch {
    /* no es una URL: sólo se probó el texto */
  }
  return undefined;
}

const stripQuery = (u: URL): string => `${u.origin}${u.pathname}`;

/** Resuelve un enlace corto de Temu al goodsId del producto (ver garantías en la cabecera). */
export async function resolveTemuShortLink(raw: string, opts: { fetchImpl?: typeof fetch; maxHops?: number; timeoutMs?: number } = {}): Promise<ResolveResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxHops = opts.maxHops ?? MAX_HOPS;
  const chain: Hop[] = [];
  const first = parse(raw.trim());
  if (!first || !SHORT_HOST.test(first.hostname) || first.pathname.length <= 1) {
    return { ok: false, code: 'not_short_link', message: 'No es un enlace corto de Temu (temu.to/… o share.temu.com/…).', chain };
  }
  let current: URL = first;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    if (!FOLLOW_HOST.test(current.hostname)) {
      return { ok: false, code: 'foreign_host', message: `El enlace redirige fuera de Temu (${current.hostname}); no se sigue.`, chain };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(current.toString(), { redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9' }, signal: controller.signal });
    } catch {
      return { ok: false, code: 'network', message: 'No se pudo contactar con Temu para resolver el enlace (red o tiempo de espera).', chain };
    } finally {
      clearTimeout(timer);
    }
    chain.push({ url: stripQuery(current), status: response.status });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const id = extractGoodsId(location);
      if (id) return { ok: true, goodsId: id, chain };
      let next: URL;
      try { next = new URL(location, current); } catch { return { ok: false, code: 'no_redirect', message: 'Temu devolvió una redirección no válida.', chain }; }
      if (next.protocol !== 'https:') return { ok: false, code: 'foreign_host', message: 'El enlace redirige a un destino no https; no se sigue.', chain };
      current = next;
      continue;
    }
    if (response.status === 403 || response.status === 429) {
      return { ok: false, code: 'blocked', message: `Temu bloqueó la petición (HTTP ${response.status}) al resolver el enlace corto.`, chain };
    }
    if (response.status === 200) {
      let body = '';
      try { body = (await response.text()).slice(0, 120_000); } catch { /* sin cuerpo */ }
      const id = extractGoodsId(body);
      if (id) return { ok: true, goodsId: id, chain };
    }
    return { ok: false, code: 'no_goods_id', message: 'El enlace no lleva a la ficha de un producto de Temu (puede estar caducado o ser incorrecto).', chain };
  }
  return { ok: false, code: 'too_many_redirects', message: 'El enlace encadena demasiadas redirecciones.', chain };
}
