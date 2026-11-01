import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import {
  getNetworkFieldsConfig,
  setNetworkFieldsConfig,
  setNetworkCaptureAll,
  addNetworkField,
  removeNetworkField,
  type NetworkFieldsConfig,
} from '../../../lib/networkFieldsStore';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * GET  /api/admin/network-fields
 *   Devuelve la configuración de campos capturables por red.
 * POST /api/admin/network-fields
 *   { action: 'set-config', configs: NetworkFieldsConfig[] }
 *   { action: 'set-capture-all', networkId, captureAll }
 *   { action: 'add-field', networkId, fieldKey }
 *   { action: 'remove-field', networkId, fieldKey }
 */
export const GET: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  return json({ success: true, networks: getNetworkFieldsConfig() });
};

export const POST: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return json({ success: false, message: 'Cuerpo JSON inválido.' }, 400);
  }

  const action = String((body as Record<string, unknown>).action || '');

  if (action === 'set-config') {
    const configs = (body as Record<string, unknown>).configs as NetworkFieldsConfig[] | undefined;
    if (!Array.isArray(configs)) {
      return json({ success: false, message: 'configs debe ser un array.' }, 400);
    }
    const ok = setNetworkFieldsConfig(configs);
    return json({ success: ok, networks: getNetworkFieldsConfig() }, ok ? 200 : 500);
  }

  if (action === 'set-capture-all') {
    const networkId = String((body as Record<string, unknown>).networkId || '').trim();
    const captureAll = Boolean((body as Record<string, unknown>).captureAll);
    if (!networkId) {
      return json({ success: false, message: 'networkId requerido.' }, 400);
    }
    const ok = setNetworkCaptureAll(networkId, captureAll);
    return json({ success: ok, networks: getNetworkFieldsConfig() }, ok ? 200 : 404);
  }

  if (action === 'add-field') {
    const networkId = String((body as Record<string, unknown>).networkId || '').trim();
    const fieldKey = String((body as Record<string, unknown>).fieldKey || '').trim();
    if (!networkId || !fieldKey) {
      return json({ success: false, message: 'networkId y fieldKey requeridos.' }, 400);
    }
    const ok = addNetworkField(networkId, fieldKey);
    return json({ success: ok, networks: getNetworkFieldsConfig() }, ok ? 200 : 400);
  }

  if (action === 'remove-field') {
    const networkId = String((body as Record<string, unknown>).networkId || '').trim();
    const fieldKey = String((body as Record<string, unknown>).fieldKey || '').trim();
    if (!networkId || !fieldKey) {
      return json({ success: false, message: 'networkId y fieldKey requeridos.' }, 400);
    }
    const ok = removeNetworkField(networkId, fieldKey);
    return json({ success: ok, networks: getNetworkFieldsConfig() }, ok ? 200 : 404);
  }

  return json({ success: false, message: 'Acción no reconocida.' }, 400);
};
