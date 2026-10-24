import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import {
  AI_PROVIDER_IDS,
  deleteAiKey,
  hasKeyFor,
  maskKey,
  readAiKeys,
  saveAiKey,
  type AiProviderId,
} from '../../../../lib/aiKeysStore';
import { AI_PROVIDERS, testOpencodeCli, testProvider } from '../../../../lib/aiProviders';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

/**
 * GET /api/admin/ai-keys
 * Estado de todos los proveedores de IA (clave enmascarada + test de
 * conexión REAL contra el endpoint de modelos + modelos gratuitos).
 * Con ?live=1 fuerza los tests de red (por defecto sólo estado local).
 */
export const GET: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const live = new URL(request.url).searchParams.get('live') === '1';
  const keys = readAiKeys();

  const providers = await Promise.all(
    AI_PROVIDERS.map(async (info) => {
      const id = info.id;
      if (id === 'opencode') return testOpencodeCli();
      const providerId = id as AiProviderId;
      if (!live) {
        const configured = hasKeyFor(providerId);
        return {
          id: providerId,
          name: info.name,
          configured,
          keyMasked: configured ? maskKey(keys[providerId] || 'desde-entorno') : '',
          keySource: process.env[info.envKey || '']?.trim() ? 'env' : configured ? 'store' : 'none',
          status: configured ? ('unknown' as const) : ('no-key' as const),
          detail: configured
            ? 'Clave configurada (pulsa «↻ Probar conexión» para validarla en vivo).'
            : 'Sin clave configurada.',
          defaultModel: info.defaultModel,
          freeModels: info.freeModels,
          pricingNote: info.pricingNote,
          docsUrl: info.docsUrl,
        };
      }
      return testProvider(providerId);
    })
  );

  return json({ success: true, providers });
};

/**
 * POST /api/admin/ai-keys  { provider, key }
 * Guarda la API key de un proveedor (queda conectada para TODOS los botones
 * de IA del panel: Enriquecer, Construir Catálogo, Pipeline y consola).
 */
export const POST: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const provider = String(body?.provider || '').trim().toLowerCase() as AiProviderId;
  const key = String(body?.key || '').trim();

  if (!AI_PROVIDER_IDS.includes(provider)) {
    return json({ success: false, message: `Proveedor desconocido: «${provider}».` }, 400);
  }
  if (!key) {
    return json({ success: false, message: 'La API key no puede estar vacía.' }, 400);
  }

  saveAiKey(provider, key);
  return json({ success: true, message: `Clave de ${provider} guardada.`, keyMasked: maskKey(key) });
};

/**
 * DELETE /api/admin/ai-keys  { provider }
 * Desconecta un proveedor eliminando su clave guardada.
 */
export const DELETE: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const provider = String(body?.provider || '').trim().toLowerCase() as AiProviderId;
  if (!AI_PROVIDER_IDS.includes(provider)) {
    return json({ success: false, message: `Proveedor desconocido: «${provider}».` }, 400);
  }
  deleteAiKey(provider);
  return json({ success: true, message: `Clave de ${provider} eliminada.` });
};
