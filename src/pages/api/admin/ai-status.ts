import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { maskKey } from '../../../lib/aiKeysStore';
import { testOpencodeCli, testProvider } from '../../../lib/aiProviders';
import { env, hasImageCredentials, hasTextCredentials, imageProvider, textProvider, enrichConcurrency } from '../../../lib/ai';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

/**
 * GET /api/admin/ai-status
 * Panel de Transparencia › Conectividad de IA:
 *   - proveedor de texto/imagen activo (TEXT_AI_PROVIDER / IMAGE_AI_PROVIDER)
 *   - estado de conexión real de cada proveedor (test de red contra /models)
 *   - disponibilidad de modelos gratuitos
 *   - consumo/cuota expuesto por el proveedor en cabeceras (OpenRouter, etc.)
 */
export const GET: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const [openai, nvidia, openrouter, anthropic, groq, gemini, opencode] = await Promise.all([
    testProvider('openai'),
    testProvider('nvidia'),
    testProvider('openrouter'),
    testProvider('anthropic'),
    testProvider('groq'),
    testProvider('gemini'),
    testOpencodeCli(),
  ]);

  const providers = [opencode, openai, nvidia, openrouter, anthropic, groq, gemini];
  const activeText = textProvider();
  const activeImage = imageProvider();

  return json({
    success: true,
    active: {
      textProvider: activeText,
      textReady: hasTextCredentials(),
      imageProvider: activeImage,
      imageReady: hasImageCredentials(),
      textKeyMasked: maskKey(env(activeText === 'anthropic' ? 'ANTHROPIC_API_KEY' : activeText === 'groq' ? 'GROQ_API_KEY' : activeText === 'nvidia' ? 'NVIDIA_API_KEY' : activeText === 'openrouter' ? 'OPENROUTER_API_KEY' : activeText === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY')),
      /** Nº de productos que «Enriquecer» puede procesar EN PARALELO con el
       *  proveedor de texto activo (ver TEXT_PROVIDER_CONCURRENCY en lib/ai.ts). */
      enrichConcurrency: hasTextCredentials() ? enrichConcurrency(activeText) : 1,
    },
    providers,
    checkedAt: new Date().toISOString(),
  });
};
