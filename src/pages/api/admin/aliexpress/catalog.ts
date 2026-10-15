/**
 * ==============================================================================
 * TRADYLOR - API ADMIN: CATÁLOGO ALIEXPRESS (CACHÉ)
 * ==============================================================================
 * GET  /api/admin/aliexpress/catalog
 *   -> { success, connected, syncedAt, stale, count, products }
 *      Lee el snapshot guardado en el volumen. NO consulta la TOP API.
 *
 * POST /api/admin/aliexpress/catalog
 *   -> { success, ok, syncedAt, stale, count, message, products }
 *      Fuerza una sincronización contra la TOP API. Body opcional
 *      { append: true } descarga además las páginas 2-3 de cada keyword
 *      para ampliar el catálogo sin borrar lo ya guardado.
 *
 * Ambas protegidas por sesión de administrador.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import {
  ALI_CATALOG_STALE_MS,
  getAliCatalogState,
  readAliCatalog,
  syncAliCatalog,
} from '../../../../lib/aliexpressCatalog';
import { getConnectedNetworkIds } from '../../../../lib/networks/credentials';

export const prerender = false;

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function currentStatePayload() {
  const state = getAliCatalogState();
  const snapshot = readAliCatalog();
  return {
    success: true,
    connected: getConnectedNetworkIds().includes('aliexpress'),
    staleMs: ALI_CATALOG_STALE_MS,
    syncedAt: state.syncedAt,
    stale: state.stale,
    count: state.count,
    products: snapshot?.products ?? [],
  };
}

export const GET: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;
  return new Response(JSON.stringify(currentStatePayload()), { status: 200, headers: jsonHeaders });
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const body = (await request.json().catch(() => ({}))) as { append?: boolean };
  const result = await syncAliCatalog({ append: body?.append === true });

  return new Response(
    JSON.stringify({
      ...currentStatePayload(),
      success: result.ok,
      ok: result.ok,
      message: result.message,
    }),
    { status: 200, headers: jsonHeaders },
  );
};
