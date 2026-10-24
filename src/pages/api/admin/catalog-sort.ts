import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { getGlobalCatalogSort, setGlobalCatalogSort } from '../../../lib/catalogSort';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  return new Response(JSON.stringify({ success: true, sort: getGlobalCatalogSort() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => ({}));
  const sort = typeof body?.sort === 'string' ? body.sort.trim() : '';

  if (!sort) {
    return new Response(JSON.stringify({ success: false, message: 'El parámetro sort es obligatorio' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  setGlobalCatalogSort(sort);

  return new Response(JSON.stringify({ success: true, sort }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
