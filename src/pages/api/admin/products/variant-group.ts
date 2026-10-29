import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import {
  readProductsFromFile,
  writeProductsToFile,
  type Product,
} from '../../../../lib/productStore';

export const prerender = false;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * POST /api/admin/products/variant-group
 *
 * Crea o actualiza un grupo de variantes de productos.
 *
 * Body JSON:
 * {
 *   "variantGroup": "grupo-id",           // ID del grupo (se crea si no existe)
 *   "productIds": ["id1", "id2", ...],     // IDs de productos del grupo
 *   "featureById": {                       // característica que diferencia cada producto
 *     "id1": "2 TB",
 *     "id2": "4 TB"
 *   }
 * }
 *
 * Todas las relaciones se almacenan en los campos `variantGroup` y
 * `variantFeature` de cada producto. Además se vinculan como alternativas
 * bidireccionales para que aparezcan en la ficha del producto.
 */
export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const body = await request.json();
    const { variantGroup, productIds, featureById } = body;

    if (!variantGroup || typeof variantGroup !== 'string') {
      return jsonResponse(
        { success: false, message: 'El campo "variantGroup" es obligatorio.' },
        400,
      );
    }
    if (!Array.isArray(productIds) || productIds.length < 2) {
      return jsonResponse(
        { success: false, message: 'Se requieren al menos 2 IDs de producto.' },
        400,
      );
    }

    const products = readProductsFromFile();
    const byId = new Map(products.map((p) => [p.id, p]));

    // Validar que todos los IDs existan
    const missing = productIds.filter((id) => !byId.has(String(id)));
    if (missing.length) {
      return jsonResponse(
        { success: false, message: `Productos no encontrados: ${missing.join(', ')}` },
        404,
      );
    }

    const features = featureById && typeof featureById === 'object' ? featureById : {};

    // Actualizar cada producto del grupo
    for (const id of productIds) {
      const product = byId.get(String(id)) as Product;
      product.variantGroup = variantGroup;
      product.variantFeature = String(features[id] ?? '').trim() || undefined;
    }

    if (!writeProductsToFile(products)) {
      return jsonResponse(
        { success: false, message: 'Error al escribir los cambios en disco.' },
        500,
      );
    }

    return jsonResponse({
      success: true,
      message: `Grupo "${variantGroup}" actualizado con ${productIds.length} producto(s).`,
      variantGroup,
      updatedCount: productIds.length,
    }, 200);
  } catch (error: any) {
    return jsonResponse(
      { success: false, message: error?.message || 'Error inesperado.' },
      500,
    );
  }
};

/**
 * GET /api/admin/products/variant-group
 *
 * Devuelve todos los grupos de variantes existentes con sus productos,
 * para usarse en el selector del panel admin.
 */
export const GET: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const products = readProductsFromFile();
  const groups = new Map<string, Product[]>();

  for (const product of products) {
    const group = String(product.variantGroup || '').trim();
    if (!group) continue;
    const list = groups.get(group) ?? [];
    list.push(product);
    groups.set(group, list);
  }

  const result = Array.from(groups.entries()).map(([groupId, items]) => ({
    variantGroup: groupId,
    count: items.length,
    products: items.map((p) => ({
      id: p.id,
      title: p.title,
      feature: p.variantFeature,
      price: p.price,
      image: p.image,
      merchant: p.merchant,
    })),
  }));

  return jsonResponse({ success: true, groups: result }, 200);
};

/**
 * DELETE /api/admin/products/variant-group
 *
 * Elimina un producto de un grupo de variantes (lo desvincula).
 * Query: ?variantGroup=xxx&productId=yyy
 * O body: { variantGroup, productId }
 */
export const DELETE: APIRoute = async ({ request, url }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const variantGroup = url.searchParams.get('variantGroup');
  const productId = url.searchParams.get('productId');

  let body: { variantGroup?: string; productId?: string } | null = null;
  try { body = await request.json(); } catch { /* ignorar */ }

  const group = variantGroup ?? body?.variantGroup;
  const id = productId ?? body?.productId;

  if (!group || !id) {
    return jsonResponse(
      { success: false, message: 'Se requieren "variantGroup" y "productId".' },
      400,
    );
  }

  const products = readProductsFromFile();
  const target = products.find((p) => p.id === id);
  if (!target) {
    return jsonResponse(
      { success: false, message: `Producto "${id}" no encontrado.` },
      404,
    );
  }

  if (target.variantGroup !== group) {
    return jsonResponse(
      { success: false, message: 'El producto no pertenece a ese grupo.' },
      400,
    );
  }

  target.variantGroup = undefined;
  target.variantFeature = undefined;

  if (!writeProductsToFile(products)) {
    return jsonResponse(
      { success: false, message: 'Error al escribir los cambios en disco.' },
      500,
    );
  }

  return jsonResponse({
    success: true,
    message: `Producto "${id}" eliminado del grupo "${group}".`,
  }, 200);
};
