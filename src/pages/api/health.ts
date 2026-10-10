import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { DATA_DIR } from '../../lib/paths';

export const prerender = false;

/** Commit corto del despliegue (una sola vez en memoria); null si no hay git. */
let cachedCommit: string | null = null;
function buildCommit(): string | null {
  if (cachedCommit !== null) return cachedCommit;
  try {
    cachedCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    cachedCommit = null;
  }
  return cachedCommit;
}

/** Instante de arranque del proceso SSR (cambia en cada deploy). */
const startedAt = new Date().toISOString();

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
      commit: buildCommit(),
      startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      dataDirExists,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
};
