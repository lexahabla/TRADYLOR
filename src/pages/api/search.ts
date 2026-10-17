import type { APIRoute } from 'astro';
import { getCatalogProducts } from '../../lib/catalog';
import { getCategoryById } from '../../lib/categories';
import type { Product } from '../../data/products';

export const prerender = false;

/**
 * GET /api/search?q=&limit=&deals=
 * Búsqueda híbrida del catálogo (pública, sin auth):
 *   - q       → texto libre (mín. 2 caracteres; sin q rankea por recomendación
 *               o por descuento si deals=1).
 *   - limit   → nº de resultados (1..20, por defecto 8).
 *   - deals=1 → sólo productos con descuento real (originalPrice > price).
 * Devuelve un resumen ligero pensado para el buscador del hero.
 */

const euro = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
});

const normalize = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

/** Mismo score de recomendación que la home (rating 60% + reseñas 30% + dto 10%). */
const scoreOf = (p: Product) => {
  const ratingScore = (p.rating ?? 0) / 5;
  const reviewScore = Math.min(Math.log10((p.reviewsCount ?? 0) + 1) / 4, 1);
  const discountScore =
    p.originalPrice && p.originalPrice > p.price ? (p.originalPrice - p.price) / p.originalPrice : 0;
  return ratingScore * 0.6 + reviewScore * 0.3 + discountScore * 0.1;
};

const discountPctOf = (p: Product) =>
  p.originalPrice && p.originalPrice > p.price
    ? Math.round(((p.originalPrice - p.price) / p.originalPrice) * 100)
    : null;

interface SearchHit {
  id: string;
  slug: string;
  title: string;
  price: string;
  priceValue: number;
  originalPrice: string | null;
  discountPct: number | null;
  image: string;
  rating: number | null;
  reviewsCount: number | null;
  category: string;
  merchant: string;
  /** Enlace Tradylor de la ficha. */
  url: string;
  /** Enlace de salida (checkout → afiliado). */
  buyUrl: string;
  store: 'amazon' | 'aliexpress';
}

const toHit = (product: Product): SearchHit => {
  const slugOrId = String(product.slug ?? product.id);
  return {
    id: String(product.id),
    slug: slugOrId,
    title: product.title,
    price: euro.format(product.price),
    priceValue: product.price,
    originalPrice: product.originalPrice ? euro.format(product.originalPrice) : null,
    discountPct: discountPctOf(product),
    image: product.image,
    rating: product.rating ?? null,
    reviewsCount: product.reviewsCount ?? null,
    category: getCategoryById(String(product.category ?? ''))?.name ?? String(product.category ?? ''),
    merchant: product.merchant ?? '',
    url: `/producto/${slugOrId}`,
    buyUrl: product.buyNowUrl?.trim() || `/checkout/${slugOrId}`,
    store: /ali/i.test(product.merchant ?? '') ? 'aliexpress' : 'amazon',
  };
};

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const queryRaw = (url.searchParams.get('q') ?? '').trim();
    const query = normalize(queryRaw);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '8', 10) || 8, 1), 20);
    const dealsOnly = ['1', 'true', 'yes'].includes((url.searchParams.get('deals') ?? '').toLowerCase());

    const all = getCatalogProducts();
    const pool = dealsOnly
      ? all.filter((p) => typeof p.originalPrice === 'number' && p.originalPrice > p.price)
      : all;

    let hits: Product[] = [];

    if (query.length >= 2) {
      const terms = query.split(/\s+/).filter((t) => t.length >= 2);
      const scored: { product: Product; score: number }[] = [];

      for (const product of pool) {
        const title = normalize(product.title);
        const brand = normalize(product.brand ?? '');
        const type = normalize(product.productType ?? '');
        const cat = normalize(
          getCategoryById(String(product.category ?? ''))?.name ?? String(product.category ?? ''),
        );
        const desc = normalize(product.description ?? '');

        let score = 0;
        for (const term of terms) {
          if (title.includes(term)) score += 4;
          if (brand.includes(term)) score += 3;
          if (type.includes(term)) score += 3;
          if (cat.includes(term)) score += 2;
          if (desc.includes(term)) score += 1;
        }
        if (title.startsWith(query)) score += 2;
        if (score > 0) scored.push({ product, score });
      }

      scored.sort(
        (a, b) => b.score - a.score || (b.product.rating ?? 0) - (a.product.rating ?? 0),
      );
      hits = scored.map((entry) => entry.product);
    } else {
      // Sin texto: orden natural (recomendación; en ofertas, por descuento).
      hits = [...pool].sort((a, b) => {
        if (dealsOnly) {
          const da = discountPctOf(a) ?? 0;
          const db = discountPctOf(b) ?? 0;
          return db - da || scoreOf(b) - scoreOf(a);
        }
        return scoreOf(b) - scoreOf(a);
      });
    }

    const top = hits.slice(0, limit);

    return new Response(
      JSON.stringify({
        success: true,
        query: queryRaw,
        dealsOnly,
        total: top.length,
        products: top.map(toHit),
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=60',
        },
      },
    );
  } catch (error) {
    console.error('[API Search] Error:', error);
    return new Response(
      JSON.stringify({ success: false, message: 'Error al buscar productos.' }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  }
};
