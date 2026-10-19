/**
 * ==============================================================================
 * TRADYLOR - ENDPOINT SSR: BÚSQUEDA UNIFICADA MULTI-RED (ejemplo para eBay)
 * ==============================================================================
 * GET /api/products/search?q=&networks=ebay&limit=&category=&sortBy=&page=
 *
 * Ejemplo de endpoint que usa el motor de búsqueda unificado (unifiedSearch)
 * o directamente el conector de eBay con parámetros y headers correctos.
 *
 * Autenticación: header Authorization: Bearer <TRADYLOR_API_TOKEN>
 * (configurar TRADYLOR_API_TOKEN en .env del servidor)
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { unifiedSearch } from '../../../lib/networks';
import { isValidApiToken, unauthorizedApiResponse } from '../../../lib/apiAuth';
import type { UnifiedSearchParams } from '../../../lib/networks/types';

export const prerender = false;

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };

export const GET: APIRoute = async ({ request, url }) => {
  // Autenticación opcional: si no hay token, búsqueda limitada a redes demo
  const authenticated = isValidApiToken(request);

  try {
    // Parámetros de búsqueda unificados
    const params: UnifiedSearchParams = {
      query: url.searchParams.get('q')?.trim() || undefined,
      category: url.searchParams.get('category')?.trim() || undefined,
      minPrice: url.searchParams.get('minPrice') ? Number(url.searchParams.get('minPrice')) : undefined,
      maxPrice: url.searchParams.get('maxPrice') ? Number(url.searchParams.get('maxPrice')) : undefined,
      minCommission: url.searchParams.get('minCommission') ? Number(url.searchParams.get('minCommission')) : undefined,
      minRating: url.searchParams.get('minRating') ? Number(url.searchParams.get('minRating')) : undefined,
      inStockOnly: ['1', 'true', 'yes'].includes((url.searchParams.get('inStockOnly') ?? '').toLowerCase()),
      networks: url.searchParams.get('networks')?.split(',').map((n) => n.trim()).filter(Boolean),
      sortBy: (url.searchParams.get('sortBy') as UnifiedSearchParams['sortBy']) ?? 'commission',
      limit: Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50),
      page: Math.max(Number(url.searchParams.get('page')) || 1, 1),
    };

    // Si se pide solo eBay, forzar networks=['ebay']
    if (url.searchParams.get('network') === 'ebay' || params.networks?.includes('ebay')) {
      params.networks = ['ebay'];
    }

    // Ejecutar búsqueda unificada (paralelo en todas las redes conectadas)
    const result = await unifiedSearch(params);

    // Respuesta estandarizada
    return new Response(
      JSON.stringify({
        success: true,
        authenticated,
        query: params,
        total: result.total,
        products: result.results,
        byNetwork: result.byNetwork,
        searchedAt: result.searchedAt,
      }),
      {
        status: 200,
        headers: {
          ...jsonHeaders,
          'Cache-Control': 'public, max-age=60, stale-while-revalidate=120',
        },
      },
    );
  } catch (error) {
    console.error('[API Products Search] Error:', error);
    return new Response(
      JSON.stringify({ success: false, message: 'Error al buscar productos.' }),
      { status: 500, headers: jsonHeaders },
    );
  }
};