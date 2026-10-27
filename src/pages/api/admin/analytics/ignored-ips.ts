import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import {
  addIgnoredIp,
  clientIpFrom,
  getIgnoredIpSources,
  isIgnoredIp,
  removeIgnoredIp,
} from '../../../../lib/analytics';

export const prerender = false;

/**
 * GET /api/admin/analytics/ignored-ips
 *
 * Diagnóstico de autoexclusión: devuelve la IP con la que el servidor ve ESTA
 * petición (la misma función que decide si un evento se descarta) junto con
 * las listas de IPs ignoradas (fijadas por entorno y añadidas desde el panel).
 * Así el admin puede comprobar si su IP está realmente excluida sin adivinar.
 */
export const GET: APIRoute = async ({ request }) => {
  const denied = requireAdminAuth(request);
  if (denied) return denied;

  const detectedIp = clientIpFrom(request) ?? null;
  const { env, file } = getIgnoredIpSources();
  return json({
    success: true,
    detectedIp,
    detectedIpExcluded: detectedIp ? isIgnoredIp(detectedIp) : false,
    envIps: env,
    fileIps: file,
  });
};

/** POST { ip } — añade una IP a la lista persistida (panel de administración). */
export const POST: APIRoute = async ({ request }) => {
  const denied = requireAdminAuth(request);
  if (denied) return denied;

  const body = await readBody(request);
  const ip = typeof body.ip === 'string' ? body.ip.trim() : '';
  if (!ip) return json({ success: false, message: 'Indica una IP válida.' }, 400);

  const fileIps = addIgnoredIp(ip);
  return json({ success: true, fileIps });
};

/** DELETE { ip } — quita una IP de la lista persistida (no afecta a las de entorno). */
export const DELETE: APIRoute = async ({ request }) => {
  const denied = requireAdminAuth(request);
  if (denied) return denied;

  const body = await readBody(request);
  const ip = typeof body.ip === 'string' ? body.ip.trim() : '';
  if (!ip) return json({ success: false, message: 'Indica una IP válida.' }, 400);

  const fileIps = removeIgnoredIp(ip);
  return json({ success: true, fileIps });
};

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await request.json();
    return (data ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
