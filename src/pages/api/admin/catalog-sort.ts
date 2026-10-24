import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../lib/adminAuth';
import { getGlobalCatalogSort, setGlobalCatalogSort } from '../../../lib/catalogSort';

export const prerender = false;

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify({ success: true, sort: getGlobalCatalogSort() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  const sessionUser = getSessionUser(request);
  if (!sessionUser) {
    return new Response('Autenticacion requerida', { status: 401 });
  }

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
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `tradylor_catalog_sort=${encodeURIComponent(sort)}; Path=/; Max-Age=31536000; SameSite=Lax`,
    },
  });
};
