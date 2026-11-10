/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: PUBLICACIÓN INTERNA Y RECUPERACIÓN DE VERSIONES (etapa 4)
 * ==============================================================================
 * POST /api/admin/home-layout/publish
 *
 * «Publicar» es INTERNO: la versión queda guardada en `home-layout.json` (publicada + historial) pero la portada nueva NO se activa y los
 * visitantes siguen viendo la portada actual. `activation.enabled` no se toca.
 *
 * Cuerpo JSON (cualquier otro campo → 400):
 *   { action:'publish', baseRevision:string, basePublished:number|null, confirm:true }
 *       · baseRevision  = revisión del borrador que viste (GET …/draft o …/versions).
 *       · basePublished = número de la versión publicada que viste (null si no había).
 *       · confirm       = true OBLIGATORIO (confirmación explícita).
 *       Publica el borrador GUARDADO como la versión siguiente; la publicada anterior pasa al historial.
 *   { action:'restore', baseRevision:string, version:number, confirm:true }
 *       Sustituye el BORRADOR por el contenido de esa versión (publicada o archivada). No cambia la publicada ni el historial.
 * Reglas (todas comprobadas en el servidor, con los datos actuales del catálogo, categorías y secciones):
 *   · el borrador debe validar y no tener errores de referencias en bloques visibles (422 `referencias_bloqueantes` con la lista);
 *   · revisiones obsoletas → 409 `conflicto` (borrador) o `conflicto_publicada`; nunca se sobrescribe nada;
 *   · borrador vacío o idéntico a lo publicado → 409 `borrador_vacio` / `sin_cambios`;
 *   · máximo de 100 versiones archivadas: no se borra ninguna, se rechaza (409 `limite_versiones`);
 *   · escritura atómica con copia `.bak`; un archivo dañado, inválido o de un esquema más nuevo NO se sobrescribe (423).
 * Respuestas:
 *   200 { success, action, version?, publishedAt?, revision?, published:{version,publishedAt}|null, mode:'legacy' }
 *   400 `peticion_invalida` | `json_invalido` | `confirmacion_requerida` | `documento_invalido`   401 sin admin
 *   403 `origen_no_permitido` | `cabecera_requerida` (CSRF: Origin propio + cabecera X-Home-Layout-Editor: 1)
 *   404 `version_no_encontrada`   413 `cuerpo_demasiado_grande` (> 4 KiB)   415 `tipo_no_admitido`   423 `archivo_protegido`
 *   405 `metodo_no_permitido` (Allow: POST)   500 `error_escritura` | `error_interno` (sin detalles internos)
 * No hay guardado automático ni publicación implícita: sólo esta petición explícita.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { sameOrigin } from '../../../../lib/alertsHttp';
import { readHomeLayout, resolveHomeMode, writeHomeLayout } from '../../../../lib/homeLayout/store';
import { loadSources } from '../../../../lib/homeLayout/sources';
import { resolveBlocks } from '../../../../lib/homeLayout/resolve';
import { MAX_PUBLISH_BODY_BYTES, planPublish, planRestore, splitIssues, type PlanRefusal } from '../../../../lib/homeLayout/publish';

export const prerender = false;

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, more: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, code, message, ...extra }), { status, headers: { ...headers, ...more } });

function refuse(plan: PlanRefusal): Response {
  const extra: Record<string, unknown> = { errors: plan.errors };
  if (plan.currentRevision !== undefined) extra.currentRevision = plan.currentRevision;
  if (plan.currentPublished !== undefined) extra.currentPublished = plan.currentPublished;
  if (plan.blocking) extra.blocking = plan.blocking;
  const status: Record<PlanRefusal['reason'], number> = {
    peticion_invalida: 400, confirmacion_requerida: 400, documento_invalido: 400, version_no_encontrada: 404, archivo_protegido: 423,
    conflicto: 409, conflicto_publicada: 409, borrador_vacio: 409, sin_cambios: 409, limite_versiones: 409, referencias_bloqueantes: 422,
  };
  return fail(status[plan.reason], plan.reason, plan.errors[0] ?? 'Operación rechazada', extra);
}

export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  if (!sameOrigin(request)) return fail(403, 'origen_no_permitido', 'No se pudo verificar el origen de la petición');
  if (request.headers.get('x-home-layout-editor') !== '1') return fail(403, 'cabecera_requerida', 'Falta la cabecera de seguridad del editor');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return fail(415, 'tipo_no_admitido', 'El cuerpo debe ser application/json');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PUBLISH_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');

  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_PUBLISH_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');
    body = JSON.parse(text);
  } catch {
    return fail(400, 'json_invalido', 'El cuerpo no es JSON válido');
  }
  const action = typeof body === 'object' && body !== null ? (body as { action?: unknown }).action : undefined;
  if (action !== 'publish' && action !== 'restore') return fail(400, 'peticion_invalida', 'action debe ser publish o restore', { errors: ['action no válida'] });

  try {
    // Desde aquí NO hay `await`: leer, comprobar revisiones, comprobar referencias con datos actuales y escribir ocurre sin interrupciones.
    const read = readHomeLayout();
    const now = new Date();
    let written;
    let result: Record<string, unknown>;
    if (action === 'publish') {
      const blocks = read.doc.draft.blocks;
      const resolved = resolveBlocks(blocks, loadSources()).blocks;
      const plan = planPublish(read, body, splitIssues(blocks, resolved).blocking, now);
      if (!plan.ok) return refuse(plan);
      written = writeHomeLayout(plan.doc);
      result = { action, version: plan.version, publishedAt: plan.publishedAt, published: { version: plan.version, publishedAt: plan.publishedAt } };
    } else {
      const plan = planRestore(read, body, now);
      if (!plan.ok) return refuse(plan);
      written = writeHomeLayout(plan.doc);
      result = { action, version: plan.version, revision: plan.revision, published: plan.doc.published ? { version: plan.doc.published.version, publishedAt: plan.doc.published.publishedAt } : null };
    }
    if (!written.ok) {
      if (written.reason === 'archivo_protegido') return fail(423, 'archivo_protegido', written.errors[0] ?? 'Almacenamiento protegido');
      if (written.reason === 'documento_invalido') return fail(400, 'documento_invalido', 'El documento resultante no es válido', { errors: written.errors });
      return fail(500, 'error_escritura', 'No se pudo guardar; el historial anterior sigue intacto');
    }
    return new Response(JSON.stringify({ success: true, ...result, mode: resolveHomeMode() }), { status: 200, headers });
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
