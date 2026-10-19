/**
 * ==============================================================================
 * TRADYLOR - ENDPOINT SSR: BÚSQUEDA DIRECTA EBAY (ejemplo standalone)
 * ==============================================================================
 * GET /api/ebay/search?q=&category=&limit=&sortBy=&page=
 *
 * Endpoint de ejemplo que usa DIRECTAMENTE el conector de eBay
 * con headers y parámetros correctos para marketplace España.
 *
 * Útil para testing o integraciones que solo necesitan eBay.
 *
 * Autenticación: header Authorization: Bearer <TRADYLOR_API_TOKEN>
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { EbayConnector } from '../../../lib/networks/connectors/ebay';
import { isValidApiToken, unauthorizedApiResponse } from '../../../lib/apiAuth';
import type { UnifiedSearchParams } from '../../../lib/networks/types';

export const prerender = false;

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };

export const GET: APIRoute = async ({ request, url }) => {
  if (!isValidApiToken(request)) return unauthorizedApiResponse();

  try {
    // Parámetros específicos para eBay
    const params: UnifiedSearchParams = {
      query: url.searchParams.get('q')?.trim() || undefined,
      category: url.searchParams.get('category')?.trim() || undefined,
      minPrice: url.searchParams.get('minPrice') ? Number(url.searchParams.get('minPrice')) : undefined,
      maxPrice: url.searchParams.get('maxPrice') ? Number(url.searchParams.get('maxPrice')) : undefined,
      inStockOnly: ['1', 'true', 'yes'].includes((url.searchParams.get('inStockOnly') ?? '').toLowerCase()),
      sortBy: (url.searchParams.get('sortBy') as UnifiedSearchParams['sortBy']) ?? 'popularity',
      limit: Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50),
      page: Math.max(Number(url.searchParams.get('page')) || 1, 1),
    };

    // Instanciar conector directamente
    const connector = new EbayConnector();
    const products = await connector.search(params);

    // Respuesta con metadatos de eBay
    return new Response(
      JSON.stringify({
        success: true,
        network: 'ebay',
        query: params,
        total: products.length,
        products,
        searchedAt: new Date().toISOString(),
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
    console.error('[API eBay Search] Error:', error);
    const message = error instanceof Error ? error.message : 'Error al buscar en eBay.';
    return new Response(
      JSON.stringify({ success: false, message }),
      { status: 500, headers: jsonHeaders },
    );
  }
};