import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { searchIcons, suggestKeywords } from '../../../lib/iconLibrary';

export const prerender = false;

/**
 * GET /api/admin/icon-library?q=<palabra>[&emoji=<icono elegido>]
 * Biblioteca local de iconos para el formulario de categorías (solo lectura, sin IA ni red):
 *   - icons:    emojis relacionados con la palabra, por relevancia.
 *   - keywords: palabras clave generadas a partir de la palabra (y del icono elegido, si viene).
 */
export const GET: APIRoute = ({ request, url }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 60);
  const emoji = (url.searchParams.get('emoji') ?? '').trim().slice(0, 16) || undefined;
  return new Response(
    JSON.stringify({
      success: true,
      query: q,
      icons: searchIcons(q).map(({ emoji: e, label }) => ({ emoji: e, label })),
      keywords: suggestKeywords(q, emoji),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
};
