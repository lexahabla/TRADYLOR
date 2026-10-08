import type { APIRoute } from 'astro';
import fs from 'node:fs';
import { DATA_DIR } from '../../lib/paths';

export const prerender = false;

/**
 * Healthcheck público para Easy Panel / Docker.
 * No requiere autenticación: sólo reporta estado básico del proceso.
 */
export const GET: APIRoute = () => {
  let dataDirExists = false;
  try {
    dataDirExists = fs.existsSync(DATA_DIR);
  } catch {
    dataDirExists = false;
  }

  return new Response(
    JSON.stringify({
      status: 'ok',
      service: 'tradylor-web',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      dataDirExists,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
};
