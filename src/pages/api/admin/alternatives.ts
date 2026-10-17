import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { linkAlternatives, suggestAlternatives } from '../../../lib/curation';
import { readProductsFromFile } from '../../../lib/productStore';

export const prerender = false;

/**
 * GET /api/admin/alternatives?id=<productId>
 * Devuelve el producto, sus alternativas vinculadas y sugerencias por
 * coincidencia de título/categoría (cross-matching).
 */
export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const id = new URL(request.url).searchParams.get('id') || '';
  const products = readProductsFromFile();
  const product = products.find((p) => p.id === id);
  if (!product) {
    return new Response(
      JSON.stringify({ success: false, message: `Producto "${id}" no encontrado.` }),
      { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  const linkedIds = new Set(product.alternative_product_ids || []);
  // Incluye también los slots de rol (premium/económica/similar) como vinculados.
  for (const roleId of [
    product.alternatives?.premiumOptionId,
    product.alternatives?.cheaperOptionId,
    product.alternatives?.similarOptionId,
  ]) {
    if (roleId) linkedIds.add(roleId);
  }
  const linked = products.filter((p) => linkedIds.has(p.id));

  return new Response(
    JSON.stringify({
      success: true,
      product: {
        id: product.id,
        title: product.title,
        alternative_product_ids: product.alternative_product_ids || [],
        alternatives: product.alternatives || {},
      },
      linked: linked.map((p) => ({ id: p.id, title: p.title, price: p.price, image: p.image, category: p.category })),
      suggestions: suggestAlternatives(products, product.id, 8).map(({ product: p, score }) => ({
        id: p.id,
        title: p.title,
        price: p.price,
        image: p.image,
        category: p.category,
        score: Math.round(score * 100),
      })),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
};

/**
 * POST /api/admin/alternatives
 * Vincula alternativas de forma bidireccional.
 * Body: {
 *   productId: string,
 *   alternativeProductIds: string[],
 *   premiumOptionId?: string | null,   // Opción Principal / Mejor Valorada
 *   cheaperOptionId?: string | null,   // Alternativa Económica
 *   similarOptionId?: string | null    // Competidor directo
 * }
 */
export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ success: false, message: 'Cuerpo JSON inválido.' }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  const productId = String(body?.productId || '').trim();
  if (!productId) {
    return new Response(
      JSON.stringify({ success: false, message: 'Se requiere "productId".' }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  const alternativeProductIds = Array.isArray(body?.alternativeProductIds)
    ? body.alternativeProductIds.map((v: unknown) => String(v || '').trim()).filter(Boolean)
    : [];

  // Los slots de rol deben pertenecer a la lista de alternativas.
  const ensureRoleInList = (value: unknown) => {
    const roleId = String(value || '').trim();
    if (!roleId) return null;
    if (!alternativeProductIds.includes(roleId)) alternativeProductIds.push(roleId);
    return roleId;
  };

  const result = linkAlternatives({
    productId,
    alternativeProductIds,
    premiumOptionId: ensureRoleInList(body?.premiumOptionId),
    cheaperOptionId: ensureRoleInList(body?.cheaperOptionId),
    similarOptionId: ensureRoleInList(body?.similarOptionId),
  });

  if (!result.ok) {
    return new Response(
      JSON.stringify({ success: false, message: result.message }),
      { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, message: result.message, product: result.product }),
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
};
