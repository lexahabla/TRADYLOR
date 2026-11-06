import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../lib/paths';

export const prerender = false;

/**
 * Identificación del despliegue = datos estampados en el BUILD (BUILD_INFO.json, generado por el Dockerfile con
 * scripts/source-fingerprint.mjs a partir del código que entró en la imagen):
 *  - sourceHash: huella del código real de la imagen (se compara con `node scripts/source-fingerprint.mjs --git <commit>`).
 *  - commit: sólo si la plataforma de build pasó ARG GIT_COMMIT; si no, null.
 * Deliberadamente NO se lee .git ni se consulta el remoto: el entrypoint recrea /app/.git con el main de ARRANQUE, que
 * puede no ser el commit del que se construyó la imagen.
 */
interface BuildInfo { commit: string | null; sourceHash: string | null; builtAt: string | null }
let cachedBuild: BuildInfo | undefined;
function buildInfo(): BuildInfo {
  if (cachedBuild) return cachedBuild;
  const empty: BuildInfo = { commit: null, sourceHash: null, builtAt: null };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'BUILD_INFO.json'), 'utf-8')) as Partial<BuildInfo>;
    const hash = typeof raw.sourceHash === 'string' && /^[0-9a-f]{64}$/.test(raw.sourceHash) ? raw.sourceHash : null;
    const commit = typeof raw.commit === 'string' && /^[0-9a-f]{7,40}$/.test(raw.commit) ? raw.commit : null;
    cachedBuild = { commit, sourceHash: hash, builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : null };
  } catch {
    cachedBuild = empty;
  }
  return cachedBuild;
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
    gemini: Boolean((process.env.GEMINI_API_KEY ?? '').trim()),
    flux: Boolean((process.env.FLUX_API_KEY ?? '').trim()),
    textAiProvider: (process.env.TEXT_AI_PROVIDER ?? 'openai').trim(),
    imageAiProvider: (process.env.IMAGE_AI_PROVIDER ?? 'openai').trim(),
    aliexpress: Boolean((process.env.ALIEXPRESS_APP_KEY ?? '').trim() && (process.env.ALIEXPRESS_APP_SECRET ?? '').trim()),
  };

  return new Response(
    JSON.stringify({
      status: 'ok',
      service: 'tradylor-web',
      commit: buildInfo().commit,
      sourceHash: buildInfo().sourceHash,
      builtAt: buildInfo().builtAt,
      startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      dataDirExists,
      env,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
};
