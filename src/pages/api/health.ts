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

  const env = {
    smtp: Boolean((process.env.SMTP_HOST ?? '').trim() && (process.env.SMTP_USER ?? '').trim() && (process.env.SMTP_PASS ?? '').trim()),
    googleAuth: Boolean((process.env.GOOGLE_CLIENT_ID ?? '').trim() && (process.env.GOOGLE_CLIENT_SECRET ?? '').trim()),
    apiToken: Boolean((process.env.TRADYLOR_API_TOKEN ?? '').trim()),
    n8nVerifyWebhook: Boolean((process.env.N8N_VERIFY_WEBHOOK_URL ?? '').trim()),
    n8nResetWebhook: Boolean((process.env.N8N_RESET_WEBHOOK_URL ?? '').trim()),
    n8nClickWebhook: Boolean((process.env.N8N_CLICK_WEBHOOK_URL ?? '').trim()),
    n8nReminderWebhook: Boolean((process.env.N8N_REMINDER_WEBHOOK_URL ?? '').trim()),
    openai: Boolean((process.env.OPENAI_API_KEY ?? '').trim()),
    anthropic: Boolean((process.env.ANTHROPIC_API_KEY ?? '').trim()),
    groq: Boolean((process.env.GROQ_API_KEY ?? '').trim()),
    flux: Boolean((process.env.FLUX_API_KEY ?? '').trim()),
    textAiProvider: (process.env.TEXT_AI_PROVIDER ?? 'openai').trim(),
    imageAiProvider: (process.env.IMAGE_AI_PROVIDER ?? 'openai').trim(),
    aliexpress: Boolean((process.env.ALIEXPRESS_APP_KEY ?? '').trim() && (process.env.ALIEXPRESS_APP_SECRET ?? '').trim() && (process.env.ALIEXPRESS_TRACKING_ID ?? '').trim()),
  };

  return new Response(
    JSON.stringify({
      status: 'ok',
      service: 'tradylor-web',
      commit: buildCommit(),
      startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      dataDirExists,
      env,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
};
