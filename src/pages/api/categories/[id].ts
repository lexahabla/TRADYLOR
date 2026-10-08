import type { APIRoute } from 'astro';
import {
  getCategoryById,
  updateCategory,
  removeCategory,
} from '../../../lib/categories';
import { requireAdminAuth } from '../../../lib/adminAuth';

export const prerender = false;

/**
 * GET /api/categories/[id]
 * Devuelve el detalle de una categor�a por su ID o Slug.
 */
export const GET: APIRoute = async ({ params }) => {
  const id = String(params.id || '').trim();
  if (!id) {
    return new Response(
      JSON.stringify({ success: false, message: 'Identificador no proporcionado.' }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  const category = getCategoryById(id);
  if (!category) {
    return new Response(
      JSON.stringify({ success: false, message: `Categor�a "${id}" no encontrada.` }),
      { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, category }),
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
};

/**
 * PUT /api/categories/[id]
 * Actualiza los campos de una categor�a existente (nombre, slug, icono, descripci�n, keywords/rules).
 * Protegido mediante sesi�n administrativa.
 */
export const PUT: APIRoute = async ({ params, request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const id = String(params.id || '').trim();
  if (!id) {
    return new Response(
      JSON.stringify({ success: false, message: 'Identificador no proporcionado.' }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

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
      };
    } else {
      body = await request.json().catch(() => ({}));
    }

    let keywords: string[] | undefined = undefined;
    const rawKeywords = body.keywords ?? body.rules;
    if (rawKeywords !== undefined) {
      if (Array.isArray(rawKeywords)) {
        keywords = rawKeywords.map((k) => String(k).trim()).filter(Boolean);
      } else if (typeof rawKeywords === 'string') {
        keywords = rawKeywords
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean);
      }
    }

    const current = getCategoryById(id);
    const targetSlug = current?.slug ?? id;
    const result = updateCategory(targetSlug, {
      name: body.name !== undefined ? String(body.name) : current?.name ?? '',
      icon: body.icon !== undefined ? String(body.icon) : undefined,
      keywords,
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
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        success: false,
        message: 'Error al actualizar categor�a: ' + (error?.message || 'Error desconocido'),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }
};

/**
 * DELETE /api/categories/[id]
 * Elimina una categor�a del archivo JSON persistente.
 * Protegido mediante sesi�n administrativa.
 */
export const DELETE: APIRoute = async ({ params, request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const id = String(params.id || '').trim();
  if (!id) {
    return new Response(
      JSON.stringify({ success: false, message: 'Identificador no proporcionado.' }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  const target = getCategoryById(id);
  const result = removeCategory(target?.slug ?? id);
  if (!result.ok) {
    return new Response(
      JSON.stringify({ success: false, message: result.message, categories: result.categories }),
      { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      message: result.message,
      categories: result.categories,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
};
