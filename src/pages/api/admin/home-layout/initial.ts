/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: CARGA DE LA PORTADA INICIAL (v1) EN UNA SOLA ACCIÓN
 * ==============================================================================
 * GET  /api/admin/home-layout/initial
 *   { success, available, reason?, message?, blocks:[{id,title,modality,format,width}], check:{ canLoad, blocking[], warnings[], visibleBlocks, totalBlocks },
 *     draftRevision, activationRevision, gates:{ env } }. Sólo lectura.
 * POST /api/admin/home-layout/initial   { action:'load_initial', baseRevision, baseActivation, confirm:true }
 *   Guarda los 7 bloques como borrador, publica la v1 y la FIJA/activa internamente (decisiones existentes: publish + activation). La web pública NO
 *   cambia hasta que el servidor tenga HOME_LAYOUT_ENABLED=true. SÓLO sobre una portada virgen (sin borrador, versiones ni activación): nunca sobrescribe.
 * POST {action:'load_design', baseRevision, confirm:true}: carga el REDISEÑO como borrador (sólo si el borrador es la primera portada sin modificar). No publica ni activa.
 *   Si algún bloque no se puede mostrar con los datos reales → 422 sin escribir nada. Escritura: activación primero y portada después; si falla la
 *   segunda se deshace la primera. Seguridad: administrador (401), CSRF (sameOrigin + X-Home-Layout-Editor: 1 + JSON), cuerpo ≤ 2 KiB, 405 en otros métodos.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { getSessionUser, requireAdminAuth } from '../../../../lib/adminAuth';
import { sameOrigin } from '../../../../lib/alertsHttp';
import { envEnabled, readHomeLayout, resolveHomeMode, writeHomeLayout } from '../../../../lib/homeLayout/store';
import { readActivation, writeActivation } from '../../../../lib/homeLayout/activationStore';
import { loadSources } from '../../../../lib/homeLayout/sources';
import { resolveBlocks } from '../../../../lib/homeLayout/resolve';
import { activationRevision, appendLog, checkForActivation } from '../../../../lib/homeLayout/activation';
import { revisionOf } from '../../../../lib/homeLayout/draft';
import { MAX_INITIAL_BODY_BYTES, buildInitialBlocks, deriveInitialContext, designAvailability, initialAvailability, planDesignLoad, planInitialLoad, type InitialReason } from '../../../../lib/homeLayout/initialLayout';
import type { Block } from '../../../../lib/homeLayout/types';

export const prerender = false;

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const json = (status: number, body: unknown, more: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...more } });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, more: Record<string, string> = {}) => json(status, { success: false, code, message, ...extra }, more);

const STATUS: Record<InitialReason, number> = {
  peticion_invalida: 400, confirmacion_requerida: 400, documento_invalido: 400, conflicto: 409, ya_existe_borrador: 409, ya_hay_versiones: 409, activacion_existente: 409,
  referencias_bloqueantes: 422, archivo_protegido: 423, activacion_protegida: 423,
};

/** Bloques del diseño actual con los datos REALES de este momento (categorías e imágenes del catálogo). */
const designBlocks = (): Block[] => buildInitialBlocks(deriveInitialContext(loadSources()));
const checkBlocks = (blocks: readonly Block[]) => checkForActivation(blocks, resolveBlocks([...blocks], loadSources(), { runAutomatic: true }).blocks);

export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const layout = readHomeLayout();
    const act = readActivation();
    const av = initialAvailability(layout, act);
    const blocksNow = designBlocks();
    const chk = checkBlocks(blocksNow);
    const dv = designAvailability(layout);
    return json(200, {
      success: true,
      available: av.available,
      ...(av.available ? {} : { reason: av.reason, message: av.message }),
      designAvailable: dv.available,
      ...(dv.available ? {} : { designReason: dv.reason }),
      blocks: blocksNow.map((b) => ({ id: b.id, title: b.title, modality: b.modality, format: b.format, width: b.width })),
      check: { canLoad: chk.blocking.length === 0, blocking: chk.blocking, warnings: chk.warnings, visibleBlocks: chk.visibleBlocks, totalBlocks: chk.totalBlocks },
      draftRevision: revisionOf(layout.doc.draft.updatedAt),
      activationRevision: activationRevision(act.doc),
      gates: { env: envEnabled(process.env) },
    });
  } catch {
    return fail(500, 'error_interno', 'No se pudo comprobar la portada inicial');
  }
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  if (!sameOrigin(request)) return fail(403, 'origen_no_permitido', 'No se pudo verificar el origen de la petición');
  if (request.headers.get('x-home-layout-editor') !== '1') return fail(403, 'cabecera_requerida', 'Falta la cabecera de seguridad del editor');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return fail(415, 'tipo_no_admitido', 'El cuerpo debe ser application/json');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_INITIAL_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');
  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_INITIAL_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');
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
    // Sin `await` desde aquí: leer, decidir con datos actuales y escribir sin interrupciones.
    const layout = readHomeLayout();
    const act = readActivation();
    const now = new Date();
    if (typeof body === 'object' && body !== null && (body as { action?: unknown }).action === 'load_design') {
      // Rediseño: sustituye SÓLO el borrador (si es la v1 sin modificar). No publica ni activa nada.
      const dplan = planDesignLoad(layout, body, checkBlocks, now, designBlocks());
      if (!dplan.ok) return fail(STATUS[dplan.reason], dplan.reason, dplan.errors[0] ?? 'Operación rechazada', { errors: dplan.errors, ...(dplan.blocking ? { blocking: dplan.blocking } : {}) });
      const dw = writeHomeLayout(dplan.layout);
      if (!dw.ok) return dw.reason === 'archivo_protegido' ? fail(423, 'archivo_protegido', dw.errors[0] ?? 'Archivo protegido') : fail(500, 'error_escritura', 'No se pudo guardar el borrador; no se cambió nada');
      return json(200, { success: true, action: 'load_design', revision: dplan.revision, warnings: dplan.warnings, mode: resolveHomeMode() });
    }
    const plan = planInitialLoad(layout, act, body, checkBlocks, now, by, designBlocks());
    if (!plan.ok) return fail(STATUS[plan.reason], plan.reason, plan.errors[0] ?? 'Operación rechazada', { errors: plan.errors, ...(plan.blocking ? { blocking: plan.blocking } : {}) });
    const w1 = writeActivation(plan.activation);
    if (!w1.ok) return w1.reason === 'archivo_protegido' ? fail(423, 'activacion_protegida', w1.errors[0] ?? 'Archivo protegido') : fail(500, 'error_escritura', 'No se pudo guardar la activación; no se cambió nada');
    const w2 = writeHomeLayout(plan.layout);
    if (!w2.ok) {
      // Deshacer: la activación queda inactiva (sin versión fijada) y el fallo se registra. La portada no se ha escrito.
      writeActivation(appendLog({ ...act.doc, updatedAt: plan.activation.updatedAt }, { at: now.toISOString(), by, action: 'activate', version: plan.version, result: 'error', note: 'carga inicial: no se pudo escribir home-layout.json' }));
      return fail(500, 'error_escritura', 'No se pudo cargar la portada inicial; la web sigue como estaba');
    }
    return json(200, { success: true, action: 'load_initial', version: plan.version, warnings: plan.warnings, mode: resolveHomeMode(), envEnabled: envEnabled(process.env), revision: plan.activation.updatedAt });
  } catch {
    return fail(500, 'error_interno', 'No se pudo completar la operación');
  }
};

/** Cualquier otro método: 405 (tras comprobar permisos). */
export const ALL: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  return fail(405, 'metodo_no_permitido', 'Sólo se admite GET y POST', {}, { Allow: 'GET, POST' });
};
