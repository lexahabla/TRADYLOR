import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { normalizeTagsForProducts, extractNormalizedTags } from '../../../lib/curation';
import { readProductsFromFile } from '../../../lib/productStore';

export const prerender = false;

/**
 * POST /api/admin/normalize-tags
 * Extrae y normaliza tags técnicos (matriz de atributos) de los productos
 * indicados y los persiste en `normalized_tags` para los filtros públicos.
 * Body: { ids: string[] }  (vacío = todos los productos del catálogo)
 *
 * La extracción es una heurística local determinista (USB/SATA/Bluetooth/Wi-Fi/
 * IP/capacidades…) sobre título + specs + ficha técnica: instantánea, gratis y
 * sin dependencias de claves de IA para el procesamiento en lote.
 */
export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const ids = Array.isArray(body?.ids)
      ? body.ids.map((v: unknown) => String(v || '').trim()).filter(Boolean)
      : [];
    // Sin IDs: se procesa todo el catálogo.
    const targetIds = ids.length
      ? ids
      : readProductsFromFile().map((p) => p.id);

    const { updated, products } = normalizeTagsForProducts(targetIds);

    return new Response(
      JSON.stringify({
        success: true,
        updated,
        total: targetIds.length,
        products: products.filter((p) => targetIds.includes(p.id)).map((p) => ({
          id: p.id,
          normalized_tags: p.normalized_tags || [],
        })),
        message: `Tags normalizados en ${updated} producto(s).`,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, message: error?.message || 'Error al normalizar tags.' }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }
};

/**
 * GET /api/admin/normalize-tags?id=xyz
 * Vista previa de los tags que se extraerían de un producto sin persistir.
 */
export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const id = new URL(request.url).searchParams.get('id') || '';
  const product = readProductsFromFile().find((p) => p.id === id);
  if (!product) {
    return new Response(
      JSON.stringify({ success: false, message: `Producto "${id}" no encontrado.` }),
      { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }
  return new Response(
    JSON.stringify({ success: true, id, normalized_tags: extractNormalizedTags(product) }),
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
};
