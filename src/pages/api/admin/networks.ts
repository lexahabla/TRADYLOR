/**
 * ==============================================================================
 * TRADYLOR - API ADMIN: GESTIÓN DE CREDENCIALES POR RED
 * ==============================================================================
 * POST /api/admin/networks
 *   { action: 'save',     networkId, values: { accessKey, ... } } → guarda
 *   { action: 'delete',   networkId }                             → desconecta (borra credenciales)
 *   { action: 'validate', networkId }                             → valida
 *   { action: 'create',   name, region?, color?, description?, docUrl?, fields: [{label, secret, required}] } → crea afiliado
 *   { action: 'remove',   networkId }                             → elimina el afiliado de la lista
 *   { action: 'restore' }                                         → restaura las redes predefinidas eliminadas
 *
 * Protegida por la sesión de administrador (cookie HttpOnly).
 * Los valores secretos NUNCA se devuelven en las respuestas.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { deleteCredentials, saveCredentials } from '../../../lib/networks/credentials';
import { getConnector, getNetworksOverview } from '../../../lib/networks';
import { createNetwork, getRemovedNetworks } from '../../../lib/networks/registry';
import { clearRemovedNetworks, listCustomNetworks, markNetworkRemoved, removeCustomNetwork } from '../../../lib/networks/customNetworks';

export const prerender = false;

const jsonHeaders = { 'Content-Type': 'application/json' };

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders });
}

/** Respuesta estándar: lista activa de redes + predefinidas eliminadas. */
function overview() {
  return { networks: getNetworksOverview(), removed: getRemovedNetworks() };
}

export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ success: false, message: 'Petición JSON inválida.' }), { status: 400, headers: jsonHeaders });
  }

  const action = String(body.action ?? '');
  const networkId = String(body.networkId ?? '');

  switch (action) {
    case 'save': {
      const view = saveCredentials(networkId, body.values ?? {});
      if (!view) {
        return json({ success: false, message: 'Red desconocida o faltan campos obligatorios.', ...overview() }, 400);
      }
      return json({ success: true, network: view, ...overview() });
    }

    case 'delete': {
      const removed = deleteCredentials(networkId);
      if (!removed) {
        return json({ success: false, message: 'La red no tenía credenciales almacenadas.', ...overview() }, 404);
      }
      return json({ success: true, ...overview() });
    }

    case 'validate': {
      const connector = getConnector(networkId);
      if (!connector) {
        return json({ success: false, message: 'Red no registrada.', ...overview() }, 404);
      }
      const result = await connector.validate();
      return json({ success: result.ok, message: result.message, ...overview() }, result.ok ? 200 : 400);
    }

    case 'create': {
      const result = createNetwork(body);
      if (!result.ok) {
        return json({ success: false, message: result.message, ...overview() }, 400);
      }
      return json({ success: true, network: result.network, message: `Afiliado "${result.network.name}" creado.`, ...overview() });
    }

    case 'remove': {
      const exists = getNetworksOverview().some((network) => network.id === networkId);
      if (!exists || !networkId) {
        return json({ success: false, message: 'Red no encontrada.', ...overview() }, 404);
      }
      deleteCredentials(networkId);
      if (listCustomNetworks().some((network) => network.id === networkId)) {
        removeCustomNetwork(networkId);
      } else {
        markNetworkRemoved(networkId);
      }
      return json({ success: true, message: 'Afiliado eliminado.', ...overview() });
    }

    case 'restore': {
      clearRemovedNetworks();
      return json({ success: true, message: 'Redes predefinidas restauradas.', ...overview() });
    }

    default:
      return json({ success: false, message: 'Acción no reconocida. Usa save, delete, validate, create, remove o restore.' }, 400);
  }
};
