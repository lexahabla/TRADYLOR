import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../lib/paths';

export const prerender = false;

/**
 * Commit corto del despliegue, leyendo .git directamente (sin invocar git:
 * en el contenedor el volumen/propiedad puede bloquear el binario).
 */
let cachedCommit: string | null | undefined;
function buildCommit(): string | null {
  if (cachedCommit !== undefined) return cachedCommit;
  try {
    const gitDir = path.join(process.cwd(), '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    if (!head.startsWith('ref:')) {
      cachedCommit = head.slice(0, 7);
      return cachedCommit;
    }
    const ref = head.slice(4).trim();
    try {
      cachedCommit = fs.readFileSync(path.join(gitDir, ref), 'utf-8').trim().slice(0, 7);
    } catch {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf-8');
      const line = packed.split('\n').find((row) => row.endsWith(` ${ref}`));
      cachedCommit = line ? line.split(' ')[0].slice(0, 7) : null;
    }
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
