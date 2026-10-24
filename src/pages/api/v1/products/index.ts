/**
 * ==============================================================================
 * TRADYLOR - API PÚBLICA v1: FEED DEL CATÁLOGO (para n8n y automatizaciones)
 * ==============================================================================
 * GET /api/v1/products?category=...&minPrice=...&maxPrice=...&limit=...&page=...
 *
 * Autenticación: header  Authorization: Bearer <TRADYLOR_API_TOKEN>
 * (configurar TRADYLOR_API_TOKEN en el archivo .env del servidor)
 *
 * Respuesta: catálogo activo con URLs internas de detalle y de salida
 * enmascarada (/out/[id]), listo para que n8n evalúe rentabilidad y decida
 * qué promocionar o retirar.
 * 
 * Paginación: 
 *   - page: número de página (1-indexed, default: 1)
 *   - limit: productos por página (default: 24, max: 100)
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { getCatalogProducts } from '../../../../lib/catalog';
import { getGlobalCatalogSort, sortCatalogProducts } from '../../../../lib/catalogSort';
import { isValidApiToken, unauthorizedApiResponse } from '../../../../lib/apiAuth';

export const prerender = false;

const jsonHeaders = { 'Content-Type': 'application/json' };

export const GET: APIRoute = ({ request, url }) => {
  if (!isValidApiToken(request)) return unauthorizedApiResponse();

  const category = url.searchParams.get('category')?.toLowerCase();
  const minPrice = Number(url.searchParams.get('minPrice')) || undefined;
  const maxPrice = Number(url.searchParams.get('maxPrice')) || undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 24, 1), 100);
  const page = Math.max(Number(url.searchParams.get('page')) || 1, 1);

  let products = getCatalogProducts();
  if (category) products = products.filter((p) => (p.category ?? '').toLowerCase() === category);
  if (minPrice != null) products = products.filter((p) => p.price >= minPrice);
  if (maxPrice != null) products = products.filter((p) => p.price <= maxPrice);

  const rawSort = (url.searchParams.get('sort') ?? '').trim().toLowerCase();
  const sortKey = rawSort || getGlobalCatalogSort();
  products = sortCatalogProducts(products, sortKey);

  const totalProducts = products.length;
  const totalPages = Math.ceil(totalProducts / limit);
  const startIndex = (page - 1) * limit;
  const endIndex = Math.min(startIndex + limit, totalProducts);
  const paginatedProducts = products.slice(startIndex, endIndex);

  const origin = new URL(request.url).origin;
  const feed = paginatedProducts.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    price: p.price,
    originalPrice: p.originalPrice ?? null,
    currency: 'EUR',
    category: p.category,
    merchant: p.merchant,
    rating: p.rating ?? null,
    reviewsCount: p.reviewsCount ?? null,
    badge: p.badge ?? null,
    detailUrl: `${origin}/producto/${p.id}`,
    outboundUrl: `${origin}/out/${p.id}`,
    image: p.image,
  }));

  return new Response(
    JSON.stringify({ 
      success: true, 
      total: totalProducts,
      page,
      limit,
      totalPages,
      generatedAt: new Date().toISOString(), 
      products: feed 
    }),
    { status: 200, headers: jsonHeaders },
  );
};
