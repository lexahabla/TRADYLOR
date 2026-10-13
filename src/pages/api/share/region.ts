import type { APIRoute } from 'astro';
import { clientIp, detectRegionLangs } from '../../../lib/shareGeo';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });

// Rate limit: 60 consultas/hora por IP (el cliente cachea el resultado varios días)
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 60;
const hits = new Map<string, { count: number; resetAt: number }>();

function allow(key: string): boolean {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    if (hits.size > 5000) hits.clear();
    hits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_MAX;
}

/**
 * GET /api/share/region
 * Idiomas cooficiales (ca / eu / gl) que corresponden a la región del visitante,
 * según Accept-Language y la geolocalización de su IP. Público: lo usa la página
 * /share/[id] y el panel de compartir para completar el selector de idioma.
 */
export const GET: APIRoute = async ({ request }) => {
  if (!allow(clientIp(request) ?? 'unknown')) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }
  const detection = await detectRegionLangs(request);
  return json({
    ok: true,
    langs: detection.langs,
    resolved: detection.resolved,
    region: detection.region ?? null,
  });
};
