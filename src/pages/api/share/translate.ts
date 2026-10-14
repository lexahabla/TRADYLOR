import type { APIRoute } from 'astro';
import { shareTranslatesPerIp } from '../../../lib/rateLimit';
import { clientIp } from '../../../lib/shareGeo';
import { GOOGLE_TRANSLATE_LANGS, parseGtxResponse } from '../../../utils/translate';

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
 * Traduce el mensaje de la tarjeta "A mi correo" con el traductor de Google.
 * El cliente lo llama directamente a Google desde el navegador; este endpoint
 * sólo es el RESPALDO por si el navegador no puede llegar (red bloqueada,
 * extensor, etc.). Limita los pedidos por IP y cachea la respuesta un rato.
 */
export const POST: APIRoute = async ({ request }) => {
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

    const translated = parseGtxResponse(await res.json().catch(() => null));
    if (!translated) return json({ ok: false, error: 'translate_empty' }, 502);

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(cacheKey, { text: translated, at: now });
    return json({ ok: true, text: translated, target }, 200);
  } catch (error) {
    console.error('[share/translate] Error traduciendo:', error);
    return json({ ok: false, error: 'translate_failed' }, 502);
  }
};
