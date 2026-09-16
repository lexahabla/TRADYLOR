/**
 * ==============================================================================
 * TRADYLOR - API ADMIN: BÚSQUEDA UNIFICADA MULTI-RED
 * ==============================================================================
 * POST /api/admin/search
 *   {
 *     query, category, minPrice, maxPrice, minCommission, minRating,
 *     inStockOnly, networks: ['amazon', ...], sortBy, limit
 *   }
 *
 * Devuelve resultados normalizados de todas las redes conectadas, con el
 * detalle por red en `byNetwork` (incluye errores parciales sin romper la
 * búsqueda global). Protegida por sesión de administrador.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { unifiedSearch } from '../../../lib/networks';
import { getConnectedNetworkIds } from '../../../lib/networks/credentials';
import type { UnifiedSearchParams } from '../../../lib/networks/types';

export const prerender = false;

const jsonHeaders = { 'Content-Type': 'application/json' };

const toNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== null && value !== '' ? parsed : undefined;
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ success: false, message: 'Petición JSON inválida.' }), { status: 400, headers: jsonHeaders });
  }

  const params: UnifiedSearchParams = {
    query: body.query ? String(body.query).trim() : undefined,
    category: body.category ? String(body.category).trim() : undefined,
    minPrice: toNumber(body.minPrice),
    maxPrice: toNumber(body.maxPrice),
    minCommission: toNumber(body.minCommission),
    minRating: toNumber(body.minRating),
    inStockOnly: Boolean(body.inStockOnly),
    networks: Array.isArray(body.networks) ? body.networks.map(String) : undefined,
    sortBy: ['commission', 'price_asc', 'price_desc', 'rating', 'popularity'].includes(body.sortBy) ? body.sortBy : 'commission',
    limit: Math.min(Math.max(toNumber(body.limit) ?? 24, 1), 100),
  };

  const response = await unifiedSearch(params);

  return new Response(
    JSON.stringify({ ...response, connectedNetworks: getConnectedNetworkIds() }),
    { status: 200, headers: jsonHeaders },
  );
};
