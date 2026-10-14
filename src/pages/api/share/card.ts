import type { APIRoute } from 'astro';
import { findCatalogProduct, productKey } from '../../../lib/catalog';
import { buildProductPageUrl } from '../../../utils/share';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
  });

/**
 * GET /api/share/card?productId=<id|slug>
 *
 * Datos públicos de la ficha para la tarjeta que copia "Copiar enlace"
 * (imagen, título, categoría, ventajas y enlace). Se monta en el cliente un
 * HTML con estilos inline que, al pegarlo en un correo o editor, se ve como
 * ficha visual del producto.
 */
export const GET: APIRoute = ({ request }) => {
  const productId = new URL(request.url).searchParams.get('productId')?.trim() ?? '';
  if (!productId) return json({ ok: false, error: 'missing_product' }, 400);

  const product = findCatalogProduct(productId);
  if (!product) return json({ ok: false, error: 'product_not_found' }, 404);

  const key = productKey(product);
  const image = /^https?:\/\//i.test(product.image)
    ? product.image
    : new URL(product.image, 'https://tradylor.com').href;

  return json(
    {
      ok: true,
      productId: key,
      title: product.title,
      category: product.category,
      image,
      url: buildProductPageUrl(key),
      pros: (Array.isArray(product.pros) ? product.pros : [])
        .filter((pros) => typeof pros === 'string' && pros.trim())
        .slice(0, 3),
    },
    200,
  );
};
