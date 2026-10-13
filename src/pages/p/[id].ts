import type { APIRoute } from 'astro';
import { findCatalogProduct, productKey } from '../../lib/catalog';

export const prerender = false;

/**
 * Ruta corta /p/<id> — la que se usa al compartir desde Mi Radar o por email.
 * Hace 302 a la ficha canónica (/producto/<slug>), conservando las UTM para
 * que el tráfico social indirecto se atribuya correctamente en analítica.
 * Si el producto ya no existe, cae al inicio (nunca 404: es un enlace público).
 */
export const GET: APIRoute = ({ params, request }) => {
  const id = String(params.id ?? '');
  const product = findCatalogProduct(id);

  const target = new URL('/', request.url);
  if (product) target.pathname = `/producto/${encodeURIComponent(productKey(product))}`;
  target.hash = '';
  target.search = product ? new URL(request.url).search : '';

  return new Response(null, {
    status: 302,
    headers: {
      Location: target.pathname + target.search + target.hash,
      'Cache-Control': 'no-store',
    },
  });
};
