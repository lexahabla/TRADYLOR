import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { AI_PROVIDER_IDS, effectiveKey, type AiProviderId } from '../../../lib/aiKeysStore';
import { testOpencodeCli } from '../../../lib/aiProviders';
import { chatComplete, textProvider, type ChatMessage, type TextProvider } from '../../../lib/ai';
import { adminIaSystemPrompt, withSkills } from '../../../lib/aiPersonas';
import { getSkillsForPersona } from '../../../lib/aiSkillsStore';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

/** Límite de salida de la consola local (caracteres). */
const OUTPUT_LIMIT = 12_000;
const OPENCODE_TIMEOUT_MS = 180_000;

/**
 * GET /api/admin/ai-console
 * Disponibilidad de la consola: proveedores con clave + estado del CLI local.
 */
export const GET: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const providers = AI_PROVIDER_IDS.map((id) => ({
    id,
    configured: Boolean(effectiveKey(id as AiProviderId)),
  }));
  const opencode = await testOpencodeCli();

  return json({
    success: true,
    defaultProvider: textProvider(),
    providers,
    opencode: { available: opencode.status === 'connected', detail: opencode.detail },
  });
};

/**
 * Ejecuta el CLI opencode local con el prompt como ÚNICO argumento
 * (sin shell ⇒ sin inyección de comandos). Sólo admin autenticado.
 */
function runOpencode(prompt: string, model?: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const args = ['run'];
    if (model) args.push('-m', model);
    args.push(prompt);
    let child;
    try {
      child = spawn('opencode', args, { shell: false, cwd: process.cwd() });
    } catch (error) {
      resolve({ ok: false, output: `No se pudo lanzar opencode: ${error instanceof Error ? error.message : 'error'}` });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ya finalizado */ }
      resolve({ ok: false, output: `Timeout tras ${Math.round(OPENCODE_TIMEOUT_MS / 1000)}s.\n${(out + err).slice(0, OUTPUT_LIMIT)}` });
    }, OPENCODE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `CLI opencode no disponible en el servidor: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = (out + (err ? `\n[stderr]\n${err}` : '')).trim().slice(0, OUTPUT_LIMIT);
      resolve({ ok: code === 0, output: output || '(sin salida)' });
    });
  });
}

/**
 * POST /api/admin/ai-console
 * Consola de IA del panel:
 *   { mode: 'chat', messages: [{role, content}], provider?, model? }
 *       → conversación vía API con el proveedor configurado/guardado.
 *   { mode: 'opencode', prompt, model? }
 *       → ejecuta el asistente local `opencode run` del contenedor.
 */
export const POST: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return json({ success: false, message: 'Cuerpo JSON inválido.' }, 400);
  }

  const mode = String(body.mode || 'chat');
  const model = String(body.model || '').trim() || undefined;

  if (mode === 'opencode') {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) {
      return json({ success: false, message: 'Escribe un prompt para opencode.' }, 400);
    }
    const result = await runOpencode(prompt.slice(0, 4000), model);
    return json({ success: result.ok, mode: 'opencode', output: result.output });
  }

  // ── Chat vía API ──────────────────────────────────────────────────────────
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages: ChatMessage[] = rawMessages
    .slice(-20)
    .map((m: any) => ({
      role: m?.role === 'assistant' ? 'assistant' as const : m?.role === 'system' ? 'system' as const : 'user' as const,
      content: String(m?.content ?? '').slice(0, 6000),
    }))
    .filter((m: ChatMessage) => m.content.trim());

  if (!messages.length) {
    return json({ success: false, message: 'La conversación está vacía.' }, 400);
  }

  // Personalidad «Consola IA» (gestión de tienda) + skills entrenados por el admin.
  const hasSystem = messages.some((m) => m.role === 'system');
  const adminPrompt = withSkills(adminIaSystemPrompt(), getSkillsForPersona('admin'));
  const finalMessages: ChatMessage[] = hasSystem
    ? messages
    : [{ role: 'system' as const, content: adminPrompt }, ...messages];

  const providerRaw = String(body.provider || '').trim().toLowerCase();
  const provider = (AI_PROVIDER_IDS as string[]).includes(providerRaw)
    ? (providerRaw as TextProvider)
    : undefined;

  try {
    // jsonMode:false explícito: es chat libre (no una extracción estructurada),
    // y sin la palabra "json" en el prompt del sistema, OpenAI/Groq rechazan
    // con 400 cualquier llamada con response_format:json_object (lo exigen
    // ambos). Antes se heredaba el jsonMode por defecto del proveedor (true
    // en OpenAI y Groq), así que el chat libre fallaba siempre con esos dos.
    const reply = await chatComplete(finalMessages, { provider, model, jsonMode: false });
    return json({ success: true, mode: 'chat', provider: provider ?? textProvider(), reply });
  } catch (error) {
    return json({
      success: false,
      message: error instanceof Error ? error.message : 'Error desconocido del proveedor de IA.',
    });
  }
};
