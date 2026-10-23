import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { ensureAlternativeRoles, linkAlternatives, linkCatalogAlternativesAuto, roleIdsOf, suggestAlternatives } from '../../../lib/curation';
import { readProductsFromFile } from '../../../lib/productStore';

export const prerender = false;

/**
 * GET /api/admin/alternatives?id=<productId>
 * Devuelve el producto, sus alternativas vinculadas y sugerencias por
 * coincidencia de título/categoría (cross-matching).
 *
 * Además GARANTIZA que el modal abra con la selección auto-rellena: si el
 * producto no tiene alternativas, las sugiere y las vincula; si las tiene pero
 * sin roles, le asigna los 3 roles automáticamente. Nunca toca vínculos/roles
 * ya definidos a mano (`auto: false` cuando la selección ya existía).
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

  // Rellena la selección automática si faltaba (persiste en products.json).
  const ensured = ensureAlternativeRoles(id);
  const fresh = readProductsFromFile().find((p) => p.id === id) || product;
  const roles = roleIdsOf(fresh);

  const linkedIds = new Set(fresh.alternative_product_ids || []);
  // Incluye también los slots de rol (premium/económica/similar) como vinculados.
  for (const roleId of [...roles.premium, ...roles.cheaper, ...roles.similar]) {
    if (roleId) linkedIds.add(roleId);
  }
  const linked = readProductsFromFile().filter((p) => linkedIds.has(p.id));

  return new Response(
    JSON.stringify({
      success: true,
      product: {
        id: fresh.id,
        title: fresh.title,
        alternative_product_ids: fresh.alternative_product_ids || [],
        alternatives: fresh.alternatives || {},
      },
      // Selección de los 3 roles (en plural: admite varias económicas/competidores)
      // + flag de si acaba de rellenarse automáticamente.
      roles: {
        auto: ensured.auto,
        premiumOptionId: roles.premium[0],
        cheaperOptionIds: roles.cheaper,
        similarOptionIds: roles.similar,
      },
      linked: linked.map((p) => ({ id: p.id, title: p.title, price: p.price, image: p.image, category: p.category, rating: p.rating })),
      suggestions: suggestAlternatives(products, fresh.id, 8).map(({ product: p, score }) => ({
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
 *   premiumOptionId?: string | null,        // Opción Principal / Mejor Valorada
 *   cheaperOptionId?: string | null,        // Alternativa Económica (legado)
 *   similarOptionId?: string | null,        // Competidor directo (legado)
 *   cheaperOptionIds?: (string|null)[],     // Varias alternativas económicas
 *   similarOptionIds?: (string|null)[]      // Varios competidores directos
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

  if (body?.action === 'link-all') {
    const result = linkCatalogAlternativesAuto();
    return new Response(
      JSON.stringify(result),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
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
  const ensureRolesInList = (values: unknown): string[] =>
    (Array.isArray(values) ? values : [])
      .map((value) => ensureRoleInList(value))
      .filter((value): value is string => Boolean(value));

  const cheaperOptionIds = ensureRolesInList(body?.cheaperOptionIds);
  const similarOptionIds = ensureRolesInList(body?.similarOptionIds);
  // El valor legado (singular) entra en la lista pero sólo si NO envían plural.
  const legacyCheaper = ensureRoleInList(body?.cheaperOptionId);
  const legacySimilar = ensureRoleInList(body?.similarOptionId);

  const result = linkAlternatives({
    productId,
    alternativeProductIds,
    premiumOptionId: ensureRoleInList(body?.premiumOptionId),
    cheaperOptionId: cheaperOptionIds.length ? null : legacyCheaper,
    similarOptionId: similarOptionIds.length ? null : legacySimilar,
    cheaperOptionIds,
    similarOptionIds,
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
