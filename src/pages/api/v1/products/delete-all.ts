import type { APIRoute } from 'astro';
import { isValidApiToken, unauthorizedApiResponse } from '../../../../lib/apiAuth';
import { deleteAllProducts } from '../../../../lib/curation';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!isValidApiToken(request)) return unauthorizedApiResponse();

  try {
    const { deletedCount } = deleteAllProducts();
    return new Response(
      JSON.stringify({ success: true, deleted: deletedCount }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, error: error?.message || 'Error al vaciar el catálogo.' }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }
};