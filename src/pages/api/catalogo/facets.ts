import type { APIRoute } from 'astro';
import { getCatalogProducts } from '../../../lib/catalog';
import { buildListing, makeCategoryResolver, parseListingParams, summarizeGroups } from '../../../lib/catalogListing';

export const prerender = false;

/**
 * GET /api/catalogo/facets?q=&category=&brand=&min=&max=&deal=1&f_<atributo>=
 * Recuentos EN VIVO del panel de filtros (público, sin auth, sólo lectura). Usa exactamente el mismo motor que el listado
 * (`buildListing`), así que el total del botón «Ver N productos» del drawer móvil coincide con lo que mostrará la página.
 * Devuelve sólo datos reales del catálogo publicado; nunca cifras inventadas.
 */
export const GET: APIRoute = ({ url }) => {
  const params = parseListingParams(url.searchParams);
  const listing = buildListing(getCatalogProducts(), params, { resolver: makeCategoryResolver() });
  return new Response(
    JSON.stringify({
      success: true,
      total: listing.filtered.length,
      deals: listing.deals,
      price: listing.price,
      groups: summarizeGroups(listing.groups),
      chips: listing.chips.map((c) => ({ key: c.key, label: c.label })),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
};
