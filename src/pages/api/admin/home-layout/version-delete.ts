/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: ELIMINAR UNA VERSIÓN DE LA PORTADA (permanente)
 * ==============================================================================
 * POST /api/admin/home-layout/version-delete
 *   { action:'delete', version, publishedAt, basePublished, baseActivation, confirm:true }
 * Elimina de forma PERMANENTE una versión publicada internamente (decisión en `homeLayout/versionDelete.ts`). Nunca la versión activa públicamente.
 * No toca el borrador, las copias, las historias, la activación ni las demás versiones; no renumera; el número eliminado no se reutiliza.
 * Escritura: primero el registro de operaciones (activación, sin cambiar su revisión) y después la portada; si la portada falla se anota el error y
 * no cambia nada. Errores: 401, 403 (origen/cabecera), 404 versión inexistente, 409 versión activa / conflictos, 423 archivo protegido, 413/415/400.
 * Seguridad: administrador, CSRF (`sameOrigin` + `X-Home-Layout-Editor: 1` + JSON), cuerpo ≤ 2 KiB, 405 en otros métodos.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { getSessionUser, requireAdminAuth } from '../../../../lib/adminAuth';
import { sameOrigin } from '../../../../lib/alertsHttp';
import { readHomeLayout, resolveHomeMode, writeHomeLayout } from '../../../../lib/homeLayout/store';
import { readActivation, writeActivation } from '../../../../lib/homeLayout/activationStore';
import { appendLog } from '../../../../lib/homeLayout/activation';
import { MAX_DELETE_BODY_BYTES, planDeleteVersion, type DeleteReason } from '../../../../lib/homeLayout/versionDelete';

export const prerender = false;

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const json = (status: number, body: unknown, more: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...more } });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, more: Record<string, string> = {}) => json(status, { success: false, code, message, ...extra }, more);

const STATUS: Record<DeleteReason, number> = {
  peticion_invalida: 400, confirmacion_requerida: 400, documento_invalido: 400, version_no_encontrada: 404, version_activa: 409, conflicto_version: 409,
  conflicto_publicada: 409, conflicto_activacion: 409, archivo_protegido: 423, activacion_protegida: 423,
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  if (!sameOrigin(request)) return fail(403, 'origen_no_permitido', 'No se pudo verificar el origen de la petición');
  if (request.headers.get('x-home-layout-editor') !== '1') return fail(403, 'cabecera_requerida', 'Falta la cabecera de seguridad del editor');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return fail(415, 'tipo_no_admitido', 'El cuerpo debe ser application/json');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DELETE_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');
  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_DELETE_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');
    body = JSON.parse(text);
  } catch {
    return fail(400, 'json_invalido', 'El cuerpo no es JSON válido');
  }
  const by = (() => {
    try {
      return getSessionUser(request)?.username ?? 'admin';
    } catch {
      return 'admin';
    }
  })();
  try {
    // Sin `await` desde aquí: leer, decidir y escribir sin interrupciones (dos peticiones simultáneas no pueden intercalarse).
    const layout = readHomeLayout();
    const act = readActivation();
    const now = new Date();
    const plan = planDeleteVersion(layout, act, body, now, by);
    if (!plan.ok) {
      return fail(STATUS[plan.reason], plan.reason, plan.errors[0] ?? 'Operación rechazada', {
        errors: plan.errors,
        ...(plan.currentPublished !== undefined ? { currentPublished: plan.currentPublished } : {}),
        ...(plan.currentRevision ? { currentRevision: plan.currentRevision } : {}),
      });
    }
    const w1 = writeActivation(plan.activation);
    if (!w1.ok) return w1.reason === 'archivo_protegido' ? fail(423, 'activacion_protegida', w1.errors[0] ?? 'Archivo protegido') : fail(500, 'error_escritura', 'No se pudo guardar el registro; no se eliminó nada');
    const w2 = writeHomeLayout(plan.layout);
    if (!w2.ok) {
      // La versión sigue existiendo: se corrige el registro (la entrada «ok» se anota también como error).
      writeActivation(appendLog(plan.activation, { at: now.toISOString(), by, action: 'delete_version', version: plan.version, result: 'error', note: 'no se pudo escribir la portada: la versión NO se eliminó' }));
      return w2.reason === 'archivo_protegido' ? fail(423, 'archivo_protegido', w2.errors[0] ?? 'Archivo protegido') : fail(500, 'error_escritura', 'No se pudo eliminar la versión; sigue existiendo');
    }
    const after = plan.layout;
    return json(200, {
      success: true,
      action: 'delete',
      version: plan.version,
      wasPublished: plan.wasPublished,
      published: after.published ? { version: after.published.version, publishedAt: after.published.publishedAt } : null,
      remaining: [...(after.published ? [after.published.version] : []), ...after.versions.map((v) => v.version)].sort((a, b) => b - a),
      mode: resolveHomeMode(),
    });
  } catch {
    return fail(500, 'error_interno', 'No se pudo completar la operación');
  }
};

/** Cualquier otro método: 405 (tras comprobar permisos). */
export const ALL: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  return fail(405, 'metodo_no_permitido', 'Sólo se admite POST', {}, { Allow: 'POST' });
};
