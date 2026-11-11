/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: COPIAS DE SEGURIDAD DEL BORRADOR DE LA PORTADA
 * ==============================================================================
 * GET  /api/admin/home-layout/draft-backups            { success, storage, max, draftRevision, draftBlocks, backups:[{id,createdAt,by,reason,blocks,titles}] } (más recientes primero)
 * GET  /api/admin/home-layout/draft-backups?id=<id>    { success, backup:{…, blocks}, changes } (diferencias para pasar del borrador actual a la copia). Sólo lectura.
 * POST /api/admin/home-layout/draft-backups  { action:'restore', id, baseRevision, confirm:true }
 *   Recupera una copia COMO BORRADOR. Antes protege el borrador actual (copia propia si tiene contenido y no estaba ya copiado); la copia se escribe
 *   PRIMERO y el borrador DESPUÉS: si falla la primera no se toca nada. NO toca versiones, historial ni activación; no publica ni activa.
 *   Errores: 401, 403 (origen/cabecera), 409 conflicto (borrador obsoleto) / sin_cambios / limite_copias, 404 copia inexistente, 423 archivo protegido.
 * Seguridad: administrador, CSRF (sameOrigin + X-Home-Layout-Editor: 1 + JSON), cuerpo ≤ 4 KiB, 405 en otros métodos.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { getSessionUser, requireAdminAuth } from '../../../../lib/adminAuth';
import { sameOrigin } from '../../../../lib/alertsHttp';
import { readHomeLayout, writeHomeLayout } from '../../../../lib/homeLayout/store';
import { backupsProtected, readDraftBackups, writeDraftBackups } from '../../../../lib/homeLayout/draftBackupsStore';
import { MAX_BACKUPS, MAX_BACKUPS_BODY_BYTES, diffBackupAgainstDraft, planRestoreBackup, summarizeBackups, type RestoreBackupReason } from '../../../../lib/homeLayout/draftBackups';
import { revisionOf } from '../../../../lib/homeLayout/draft';

export const prerender = false;

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const json = (status: number, body: unknown, more: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...more } });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, more: Record<string, string> = {}) => json(status, { success: false, code, message, ...extra }, more);

const STATUS: Record<RestoreBackupReason, number> = {
  peticion_invalida: 400, confirmacion_requerida: 400, documento_invalido: 400, conflicto: 409, sin_cambios: 409, limite_copias: 409, copia_no_encontrada: 404, archivo_protegido: 423,
};

export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const url = new URL(request.url);
    const unknown = [...url.searchParams.keys()].filter((k) => k !== 'id');
    if (unknown.length || url.searchParams.getAll('id').length > 1) return fail(400, 'parametro_no_valido', 'Parámetro no válido');
    const bk = readDraftBackups();
    const layout = readHomeLayout();
    if (url.searchParams.has('id')) {
      const id = url.searchParams.get('id') ?? '';
      const found = bk.doc.backups.find((b) => b.id === id);
      if (!found) return fail(404, 'copia_no_encontrada', 'La copia indicada no existe');
      return json(200, { success: true, backup: { id: found.id, createdAt: found.createdAt, by: found.by, reason: found.reason, blocks: found.blocks }, changes: diffBackupAgainstDraft(layout.doc.draft, found) });
    }
    return json(200, {
      success: true,
      storage: bk.status,
      ...(bk.errors.length ? { errors: bk.errors } : {}),
      max: MAX_BACKUPS,
      draftRevision: revisionOf(layout.doc.draft.updatedAt),
      draftBlocks: layout.doc.draft.blocks.length,
      backups: summarizeBackups(bk.doc),
    });
  } catch {
    return fail(500, 'error_interno', 'No se pudieron leer las copias');
  }
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  if (!sameOrigin(request)) return fail(403, 'origen_no_permitido', 'No se pudo verificar el origen de la petición');
  if (request.headers.get('x-home-layout-editor') !== '1') return fail(403, 'cabecera_requerida', 'Falta la cabecera de seguridad del editor');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return fail(415, 'tipo_no_admitido', 'El cuerpo debe ser application/json');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BACKUPS_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');
  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BACKUPS_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');
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
    // Sin `await` desde aquí: leer, decidir y escribir sin interrupciones.
    const layout = readHomeLayout();
    const bk = readDraftBackups();
    if (backupsProtected(bk.status)) return fail(423, 'archivo_protegido', `El archivo de copias está en estado «${bk.status}»: se conserva sin sobrescribir`);
    const plan = planRestoreBackup(layout, bk.doc, body, new Date(), by);
    if (!plan.ok) return fail(STATUS[plan.reason], plan.reason, plan.errors[0] ?? 'Operación rechazada', { errors: plan.errors, ...(plan.currentRevision ? { currentRevision: plan.currentRevision } : {}) });
    if (plan.backups !== bk.doc) {
      const bw = writeDraftBackups(plan.backups);
      if (!bw.ok) return bw.reason === 'archivo_protegido' ? fail(423, 'archivo_protegido', bw.errors[0] ?? 'Archivo protegido') : fail(500, 'error_copia', 'No se pudo proteger el borrador actual; no se cambió nada');
    }
    const w = writeHomeLayout(plan.layout);
    if (!w.ok) return w.reason === 'archivo_protegido' ? fail(423, 'archivo_protegido', w.errors[0] ?? 'Archivo protegido') : fail(500, 'error_escritura', 'No se pudo guardar el borrador; tu borrador anterior sigue como estaba y su copia se conserva');
    return json(200, { success: true, action: 'restore', revision: plan.revision, protectedId: plan.protectedId, restoredId: plan.restoredId });
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
