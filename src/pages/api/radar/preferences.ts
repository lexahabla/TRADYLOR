import type { APIRoute } from 'astro';
import { getCategories } from '../../../lib/categories';
import { RadarAuthError, getRadarSessionUser, setRadarCategories } from '../../../lib/radarAuth';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** Slugs de las categorías que existen ahora mismo (el admin puede crear o borrar). */
function availableSlugs(): Set<string> {
  return new Set(getCategories().map((category) => category.slug));
}

/**
 * GET /api/radar/preferences
 * Categorías de interés guardadas por el usuario autenticado (sólo las que siguen existiendo).
 */
export const GET: APIRoute = ({ request }) => {
  const session = getRadarSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticación requerida.' }, 401);
  const available = availableSlugs();
  const categories = (session.preferences?.categories ?? []).filter((slug) => available.has(slug));
  return json({ success: true, categories }, 200);
};

/**
 * PUT /api/radar/preferences  { categories: string[] }
 * "Mis preferencias": guarda las categorías que más interesan al usuario para
 * poder recomendarle productos. Los slugs desconocidos se descartan.
 */
export const PUT: APIRoute = async ({ request }) => {
  const session = getRadarSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticación requerida.' }, 401);

  try {
    const body = await request.json();
    if (!Array.isArray(body.categories) || body.categories.length > 200) {
      return json({ success: false, message: 'Falta la lista de categorías.' }, 400);
    }
    const available = availableSlugs();
    const categories = Array.from(
      new Set(body.categories.map((slug: unknown) => String(slug)).filter((slug: string) => available.has(slug))),
    ) as string[];
    const user = setRadarCategories(session.id, categories);
    return json({ success: true, categories, user }, 200);
  } catch (error) {
    if (error instanceof RadarAuthError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'Petición inválida.' }, 400);
  }
};
