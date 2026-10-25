import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import {
  hasTextCredentials,
  synthesizeProductTitle,
  synthesizeTitleLocally,
} from '../../../lib/ai';

export const prerender = false;

/**
 * POST /api/admin/synthesize-title
 *
 * Sintetiza un título de producto largo (pegado a mano o extraído por el
 * scraper) en uno corto y legible para las product-cards: solo la definición
 * de lo que es el producto y, como mucho, una característica diferencial.
 *
 *   - Con claves de IA → síntesis con el proveedor de texto configurado.
 *   - Sin claves o si la IA falla → heurística local (gratis, instantánea).
 *
 * Requiere sesión de admin (cookie tradylor_admin_session).
 *
 * Body JSON: { "title": "...", "description?": "...", "brand?": "...", "category?": "..." }
 * Respuesta: { "success": true, "title": "...", "source": "ai" | "local" }
 */

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ success: false, message: 'Cuerpo JSON inválido' }, 400);
    }

    const title = String(body?.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title) {
      return jsonResponse({ success: false, message: 'El campo "title" es obligatorio' }, 400);
    }

    const localTitle = synthesizeTitleLocally(title);

    if (!hasTextCredentials()) {
      return jsonResponse({ success: true, title: localTitle || title, source: 'local' }, 200);
    }

    try {
      const aiTitle = await synthesizeProductTitle({
        title,
        description: body?.description ? String(body.description) : undefined,
        category: body?.category ? String(body.category) : undefined,
        brand: body?.brand ? String(body.brand) : undefined,
      });
      return jsonResponse({ success: true, title: aiTitle || localTitle || title, source: 'ai' }, 200);
    } catch (error: any) {
      console.warn('[API admin/synthesize-title] IA no disponible:', error?.message ?? error);
      return jsonResponse({ success: true, title: localTitle || title, source: 'local' }, 200);
    }
  } catch (error: any) {
    console.error('[API admin/synthesize-title] Error no controlado:', error);
    return jsonResponse(
      { success: false, message: error?.message || 'Error inesperado al sintetizar el título' },
      500
    );
  }
};
