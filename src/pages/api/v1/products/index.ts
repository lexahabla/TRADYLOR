/**
 * ==============================================================================
 * TRADYLOR - API PÚBLICA v1: FEED DEL CATÁLOGO (para n8n y automatizaciones)
 * ==============================================================================
 * GET /api/v1/products?category=...&minPrice=...&maxPrice=...&limit=...
 *
 * Autenticación: header  Authorization: Bearer <TRADYLOR_API_TOKEN>
 * (configurar TRADYLOR_API_TOKEN en el archivo .env del servidor)
 *
 * Respuesta: catálogo activo con URLs internas de detalle y de salida
 * enmascarada (/out/[id]), listo para que n8n evalúe rentabilidad y decida
 * qué promocionar o retirar.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { getCatalogProducts } from '../../../../lib/catalog';
import { isValidApiToken, unauthorizedApiResponse } from '../../../../lib/apiAuth';

export const prerender = false;

const jsonHeaders = { 'Content-Type': 'application/json' };

export const GET: APIRoute = ({ request, url }) => {
  if (!isValidApiToken(request)) return unauthorizedApiResponse();

  const category = url.searchParams.get('category')?.toLowerCase();
  const minPrice = Number(url.searchParams.get('minPrice')) || undefined;
  const maxPrice = Number(url.searchParams.get('maxPrice')) || undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);

  let products = getCatalogProducts();
  if (category) products = products.filter((p) => p.category.toLowerCase() === category);
  if (minPrice != null) products = products.filter((p) => p.price >= minPrice);
  if (maxPrice != null) products = products.filter((p) => p.price <= maxPrice);

  const origin = new URL(request.url).origin;
  const feed = products.slice(0, limit).map((p) => ({
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
    JSON.stringify({ success: true, total: feed.length, generatedAt: new Date().toISOString(), products: feed }),
    { status: 200, headers: jsonHeaders },
  );
};
