import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { getSeasonalSectionSuggestions } from '../../../../lib/sectionSuggestions';
import { readSections } from '../../../../lib/sections';

export const prerender = false;

/**
 * GET /api/admin/sections/suggestions
 * Sugerencias automáticas (calendario comercial + heurísticas de catálogo)
 * para crear secciones de un clic desde "Secciones de la web". Marca
 * `existingSectionId` cuando ya existe una sección con ese mismo id (el
 * admin puede "Actualizar" en vez de crear una duplicada).
 */
export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const existingIds = new Set(readSections().map((s) => s.id));
  const suggestions = getSeasonalSectionSuggestions().map((s) => ({
    ...s,
    existingSectionId: existingIds.has(s.key) ? s.key : undefined,
  }));

  return new Response(JSON.stringify({ success: true, suggestions }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
