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
  writeAliCatalog,
  type AliCatalogSnapshot,
} from '../../../../lib/aliexpressCatalog';
import { canonicalToUnified } from '../../../../lib/networks/connectors/base';
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
    // El snapshot persiste el contrato canónico; la UI consume UnifiedProduct
    products: snapshot ? snapshot.products.map(canonicalToUnified) : [],
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

export const DELETE: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const body = (await request.json().catch(() => ({}))) as { externalIds?: string[] };

  try {
    if (Array.isArray(body?.externalIds) && body.externalIds.length > 0) {
      const idsToDelete = new Set(body.externalIds.map((id) => String(id).trim()).filter(Boolean));
      const snapshot = readAliCatalog();
      if (!snapshot) {
        return new Response(
          JSON.stringify({ success: false, message: 'No hay catálogo para borrar.' }),
          { status: 404, headers: jsonHeaders },
        );
      }
      const beforeCount = snapshot.products.length;
      const filtered = snapshot.products.filter((p) => !idsToDelete.has(p.externalId));
      const deletedCount = beforeCount - filtered.length;
      const newSnapshot: AliCatalogSnapshot = { syncedAt: snapshot.syncedAt, products: filtered };
      writeAliCatalog(newSnapshot);
      return new Response(
        JSON.stringify({
          success: true,
          deleted: deletedCount,
          remaining: filtered.length,
          message: `${deletedCount} producto(s) eliminados del catálogo de AliExpress.`,
        }),
        { status: 200, headers: jsonHeaders },
      );
    } else {
      const snapshot = readAliCatalog();
      if (!snapshot) {
        return new Response(
          JSON.stringify({ success: true, deleted: 0, remaining: 0, message: 'El catálogo ya estaba vacío.' }),
          { status: 200, headers: jsonHeaders },
        );
      }
      const deletedCount = snapshot.products.length;
      const newSnapshot: AliCatalogSnapshot = { syncedAt: '', products: [] };
      writeAliCatalog(newSnapshot);
      return new Response(
        JSON.stringify({
          success: true,
          deleted: deletedCount,
          remaining: 0,
          message: `Catálogo de AliExpress vaciado: ${deletedCount} producto(s) eliminados.`,
        }),
        { status: 200, headers: jsonHeaders },
      );
    }
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, message: error?.message || 'Error al borrar el catálogo.' }),
      { status: 500, headers: jsonHeaders },
    );
  }
};
