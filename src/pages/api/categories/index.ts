import type { APIRoute } from 'astro';
import fs from 'node:fs';
import { dataFile } from '../../../lib/paths';
import {
  getCategories,
  createCategory,
  suggestCategory,
  type Category,
} from '../../../lib/categories';
import { requireAdminAuth } from '../../../lib/adminAuth';

export const prerender = false;

// Ruta a products.json para calcular conteo de productos por categor�a
const PRODUCTS_PATH = dataFile('products.json');

function getProductCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  try {
    if (fs.existsSync(PRODUCTS_PATH)) {
      const raw = fs.readFileSync(PRODUCTS_PATH, 'utf-8');
      const products = JSON.parse(raw);
      if (Array.isArray(products)) {
        for (const p of products) {
          const cat = String(p.category || '').trim().toLowerCase();
          if (cat) {
            counts[cat] = (counts[cat] || 0) + 1;
          }
        }
      }
    }
  } catch (err) {
    console.error('[API Categories] Error leyendo products.json para conteo:', err);
  }
  return counts;
}

/**
 * GET /api/categories
 * Devuelve todas las categor�as persistentes, enriquecidas con el conteo de productos asociados.
 * Tambi�n permite sugerencias mediante query param: ?suggest=texto
 */
export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const querySuggest = url.searchParams.get('suggest');

    // Si se pide sugerencia por palabra clave
    if (querySuggest) {
      const suggestion = suggestCategory(querySuggest);
      return new Response(
        JSON.stringify({
          success: true,
          query: querySuggest,
          suggestion: suggestion
            ? {
                category: suggestion.category,
                matches: suggestion.matches,
                matchedKeywords: suggestion.category.keywords,
              }
            : null,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        }
      );
    }

    const categories = getCategories();
    let productCounts: Record<string, number> = {};
    try {
      productCounts = getProductCounts();
    } catch {
      productCounts = {};
    }

    const normalize = (s: string) =>
      s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

    const enrichedCategories = categories.map((cat) => {
      const nameNorm = normalize(cat.name);
      const slugNorm = normalize(cat.slug);
      const keywordsNorm = (cat.keywords || []).map(normalize);

      let count = 0;
      for (const [productCat, qty] of Object.entries(productCounts)) {
        const productCatNorm = normalize(productCat);
        // Coincidencia: nombre exacto, slug, o si el nombre del producto contiene
        // una keyword de la categor�a (o viceversa), o comparten la ra�z principal
        const nameMatch = productCatNorm === nameNorm || productCatNorm === slugNorm;
        const keywordMatch = keywordsNorm.some((k) => k && (productCatNorm.includes(k) || k.includes(productCatNorm)));
        const rootMatch = nameNorm.split(' ')[0].length > 3 && productCatNorm.includes(nameNorm.split(' ')[0]);
        if (nameMatch || keywordMatch || rootMatch) count += qty;
      }

      return {
        ...cat,
        productCount: count,
      };
    });

    return new Response(
      JSON.stringify({
        success: true,
        total: enrichedCategories.length,
        categories: enrichedCategories,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        success: false,
        message: 'Error al obtener categor�as: ' + (error?.message || 'Error desconocido'),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  }
};

/**
 * POST /api/categories
 * Crea una nueva categor�a con validaci�n y persistencia.
 * Protegido mediante sesi�n administrativa.
 */
export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const contentType = request.headers.get('content-type') || '';
    let body: any = {};

    if (contentType.includes('application/json')) {
      body = await request.json();
    } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      body = {
        name: formData.get('name'),
        slug: formData.get('slug'),
        icon: formData.get('icon'),
        description: formData.get('description'),
        keywords: formData.get('keywords'),
        parentId: formData.get('parentId'),
      };
    } else {
      body = await request.json().catch(() => ({}));
    }

    const name = String(body.name || '').trim();
    if (!name) {
      return new Response(
        JSON.stringify({ success: false, message: 'El nombre de la categor�a es obligatorio.' }),
        { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // Procesar keywords/rules si vienen como string separado por comas o array
    let keywords: string[] = [];
    const rawKeywords = body.keywords ?? body.rules;
    if (Array.isArray(rawKeywords)) {
      keywords = rawKeywords.map((k) => String(k).trim()).filter(Boolean);
    } else if (typeof rawKeywords === 'string') {
      keywords = rawKeywords
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
    }

    const result = createCategory({
      name,
      icon: body.icon ? String(body.icon) : undefined,
      keywords,
      // Subcategoría on-the-fly: si viene parentId, la categoría se guarda como
      // hija en categories.json (persistente y visible para toda la web).
      parentId: body.parentId !== undefined && body.parentId !== null && String(body.parentId).trim() !== ''
        ? String(body.parentId).trim()
        : null,
    });

    if (!result.ok) {
      return new Response(
        JSON.stringify({ success: false, message: result.message, categories: result.categories }),
        { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: result.message,
        category: result.category,
        categories: result.categories,
      }),
      { status: 201, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        success: false,
        message: 'Error al procesar la solicitud: ' + (error?.message || 'Datos inv�lidos'),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }
};
