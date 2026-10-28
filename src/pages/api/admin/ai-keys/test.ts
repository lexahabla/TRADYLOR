import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { maskKey, type AiProviderId } from '../../../../lib/aiKeysStore';
import { getProviderInfo, testOpencodeCli, testProvider } from '../../../../lib/aiProviders';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 12_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/admin/ai-keys/test  { provider, key? }
 * Test de conexión REAL: valida la clave contra el endpoint de modelos del
 * proveedor (sin consumir tokens de chat). Si se envía `key`, se prueba esa
 * clave ANTES de guardarla; si no, la guardada/en el entorno.
 * Para `opencode` comprueba el CLI local del contenedor.
 */
export const POST: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const provider = String(body?.provider || '').trim().toLowerCase();
  const candidateKey = String(body?.key || '').trim();

  if (provider === 'opencode') {
    const status = await testOpencodeCli();
    return json({ success: status.status === 'connected', provider: status });
  }

  const info = getProviderInfo(provider);
  if (!info?.modelsUrl) {
    return json({ success: false, message: `Proveedor desconocido: «${provider}».` }, 400);
  }

  if (!candidateKey) {
    // Sin clave candidata: test de la clave efectiva (entorno o almacén).
    const status = await testProvider(provider as AiProviderId);
    return json({ success: status.status === 'connected', provider: status, message: status.detail });
  }

  // Clave introducida en el formulario (aún no guardada).
  try {
    const headers: Record<string, string> = {};
    if (provider === 'anthropic') {
      headers['x-api-key'] = candidateKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (provider === 'gemini') {
      headers['x-goog-api-key'] = candidateKey;
    } else {
      headers.Authorization = `Bearer ${candidateKey}`;
      if (provider === 'openrouter') headers['HTTP-Title'] = 'Tradylor Admin';
    }
    const res = await fetchWithTimeout(info.modelsUrl, { method: 'GET', headers });
    if (!res.ok) {
      return json({ success: false, message: `El proveedor respondió ${res.status}.` });
    }
    const payload = await res.json().catch(() => null);
    const count = Array.isArray(payload?.data) ? payload.data.length : Array.isArray(payload?.models) ? payload.models.length : 0;
    return json({
      success: true,
      message: `Conectado · ${count} modelo(s) disponibles.`,
      keyMasked: maskKey(candidateKey),
      modelsAvailable: count,
    });
  } catch (error) {
    return json({ success: false, message: `Sin conexión: ${error instanceof Error ? error.message : 'error de red'}.` });
  }
};
