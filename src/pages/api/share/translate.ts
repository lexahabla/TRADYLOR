import type { APIRoute } from 'astro';
import { getRadarSessionUser } from '../../../lib/radarAuth';
import { shareTranslatesPerIp } from '../../../lib/rateLimit';
import { clientIp } from '../../../lib/shareGeo';
import { GOOGLE_TRANSLATE_LANGS } from '../../../utils/translate';

export const prerender = false;

const TEXT_MAX = 1500;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min: el mismo mensaje no pide dos veces lo mismo
const CACHE_MAX = 500;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** Caché en memoria de traducciones (mensaje ya traducido → se reutiliza). */
const cache = new Map<string, { text: string; at: number }>();

/**
 * POST /api/share/translate  { text, target }
 *
 * Traduce el mensaje de la tarjeta "A mi correo" con el traductor de Google
 * (endpoint público gtx), para que el usuario vea y envíe el texto en el
 * idioma que elija antes de pulsar "Enviar". Requiere sesión de Mi Radar y
 * limita los pedidos por IP; las respuestas se cachean un rato en el servidor.
 */
export const POST: APIRoute = async ({ request }) => {
  const session = getRadarSessionUser(request);
  if (!session) return json({ ok: false, error: 'auth_required' }, 401);

  let body: { text?: unknown; target?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const text = String(body.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return json({ ok: false, error: 'missing_text' }, 400);
  if (text.length > TEXT_MAX) return json({ ok: false, error: 'text_too_long' }, 400);

  const target = String(body.target ?? '').trim();
  if (!GOOGLE_TRANSLATE_LANGS.some((lang) => lang.code === target)) {
    return json({ ok: false, error: 'invalid_target' }, 400);
  }

  if (!shareTranslatesPerIp.hit(clientIp(request) ?? 'unknown')) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }

  const cacheKey = `${target}:${text}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < CACHE_TTL_MS) return json({ ok: true, text: hit.text, target, cached: true }, 200);

  try {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'auto');
    url.searchParams.set('tl', target);
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', text);

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Tradylor/1.0)', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return json({ ok: false, error: 'translate_unavailable' }, 502);

    const data = (await res.json()) as unknown;
    // Respuesta gtx: [[[ "traducción", "original", ...], ["...", ...], ...], ...]
    const segments = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as unknown[]) : [];
    const translated = segments
      .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
      .join('')
      .trim();
    if (!translated) return json({ ok: false, error: 'translate_empty' }, 502);

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(cacheKey, { text: translated, at: now });
    return json({ ok: true, text: translated, target }, 200);
  } catch (error) {
    console.error('[share/translate] Error traduciendo:', error);
    return json({ ok: false, error: 'translate_failed' }, 502);
  }
};
