import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import {
  BASE_TOGGLEABLE_FIELDS,
  getBaseFieldStates,
  getCustomFields,
  setBaseFieldVisibility,
  addCustomField,
  setCustomFieldVisibility,
  removeCustomField,
} from '../../../lib/productFieldsStore';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * GET /api/admin/product-fields
 * Estado completo de los campos "de serie" (con su visibilidad) y los
 * campos personalizados registrados. Lo consume el panel admin:
 *   - «1. Extracción & Alta de Producto» (pinta un input por cada campo
 *     personalizado, enlazado a `product.extra[key]`).
 *   - El panel «Campos visibles en la ficha» (checkboxes + alta de campos).
 */
export const GET: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  return json({
    success: true,
    baseFields: getBaseFieldStates(),
    customFields: getCustomFields(),
  });
};

/**
 * POST /api/admin/product-fields
 *   { action: 'set-base-visibility', key, visible }
 *   { action: 'add-custom-field', label, visible? }
 *   { action: 'set-custom-visibility', key, visible }
 *   { action: 'remove-custom-field', key }
 */
export const POST: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return json({ success: false, message: 'Cuerpo JSON inválido.' }, 400);
  }

  const action = String((body as Record<string, unknown>).action || '');

  if (action === 'set-base-visibility') {
    const key = String((body as Record<string, unknown>).key || '').trim();
    const visible = Boolean((body as Record<string, unknown>).visible);
    if (!BASE_TOGGLEABLE_FIELDS.some((f) => f.key === key)) {
      return json({ success: false, message: 'Campo no reconocido.' }, 400);
    }
    const ok = setBaseFieldVisibility(key, visible);
    return json({ success: ok, baseFields: getBaseFieldStates() }, ok ? 200 : 500);
  }

  if (action === 'add-custom-field') {
    const label = String((body as Record<string, unknown>).label || '').trim();
    const visible = (body as Record<string, unknown>).visible !== false;
    if (!label) {
      return json({ success: false, message: 'Escribe un nombre para el campo.' }, 400);
    }
    const field = addCustomField(label, visible);
    if (!field) {
      return json(
        { success: false, message: 'No se pudo crear el campo (nombre repetido o límite alcanzado).' },
        400,
      );
    }
    return json({ success: true, field, customFields: getCustomFields() });
  }

  if (action === 'set-custom-visibility') {
    const key = String((body as Record<string, unknown>).key || '').trim();
    const visible = Boolean((body as Record<string, unknown>).visible);
    const ok = setCustomFieldVisibility(key, visible);
    return json({ success: ok, customFields: getCustomFields() }, ok ? 200 : 404);
  }

  if (action === 'remove-custom-field') {
    const key = String((body as Record<string, unknown>).key || '').trim();
    const ok = removeCustomField(key);
    return json({ success: ok, customFields: getCustomFields() }, ok ? 200 : 404);
  }

  return json({ success: false, message: 'Acción no reconocida.' }, 400);
};
