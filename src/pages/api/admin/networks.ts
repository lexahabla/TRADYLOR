/**
 * ==============================================================================
 * TRADYLOR - API ADMIN: GESTIÓN DE CREDENCIALES POR RED
 * ==============================================================================
 * POST /api/admin/networks
 *   { action: 'save',     networkId, values: { accessKey, ... } } → guarda
 *   { action: 'delete',   networkId }                             → desconecta
 *   { action: 'validate', networkId }                             → valida
 *
 * Protegida por la sesión de administrador (cookie HttpOnly).
 * Los valores secretos NUNCA se devuelven en las respuestas.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { deleteCredentials, saveCredentials } from '../../../lib/networks/credentials';
import { getConnector, getNetworksOverview } from '../../../lib/networks';

export const prerender = false;

const jsonHeaders = { 'Content-Type': 'application/json' };

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
        return new Response(
          JSON.stringify({ success: false, message: 'Red desconocida o faltan campos obligatorios.' }),
          { status: 400, headers: jsonHeaders },
        );
      }
      return new Response(
        JSON.stringify({ success: true, network: view, networks: getNetworksOverview() }),
        { status: 200, headers: jsonHeaders },
      );
    }

    case 'delete': {
      const removed = deleteCredentials(networkId);
      if (!removed) {
        return new Response(
          JSON.stringify({ success: false, message: 'La red no tenía credenciales almacenadas.' }),
          { status: 404, headers: jsonHeaders },
        );
      }
      return new Response(
        JSON.stringify({ success: true, networks: getNetworksOverview() }),
        { status: 200, headers: jsonHeaders },
      );
    }

    case 'validate': {
      const connector = getConnector(networkId);
      if (!connector) {
        return new Response(
          JSON.stringify({ success: false, message: 'Red no registrada.' }),
          { status: 404, headers: jsonHeaders },
        );
      }
      const result = await connector.validate();
      return new Response(
        JSON.stringify({ success: result.ok, message: result.message, networks: getNetworksOverview() }),
        { status: result.ok ? 200 : 400, headers: jsonHeaders },
      );
    }

    default:
      return new Response(
        JSON.stringify({ success: false, message: 'Acción no reconocida. Usa save, delete o validate.' }),
        { status: 400, headers: jsonHeaders },
      );
  }
};
