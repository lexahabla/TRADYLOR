/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: ACTIVACIÓN Y DESACTIVACIÓN DE LA PORTADA NUEVA (etapa 6)
 * ==============================================================================
 * GET  /api/admin/home-layout/activation[?check=<versión>]
 *   Estado: { gates:{stage, env, adminFlag, activeFile, pinnedVersion}, mode:'legacy'|'layout', revision, published, versions[], log[últimas 30],
 *   storage:{layout, activation} }. Con `check=N` devuelve además la validación completa de esa versión con los datos ACTUALES:
 *   { check:{ version, canActivate, blocking[], warnings[], visibleBlocks, totalBlocks } }. No escribe nada.
 * POST /api/admin/home-layout/activation  (cuerpo ≤ 2 KiB; cualquier campo desconocido → 400)
 *   { action:'activate',   version:number, baseRevision:string, confirm:true }
 *       Valida (referencias, motor automático, «recientes» sin fecha fiable, enlaces/imágenes editoriales, ≥ 1 bloque visible), FIJA la versión
 *       y enciende `activation.enabled`. La web sólo cambia si además el servidor tiene HOME_LAYOUT_ENABLED=true.
 *   { action:'deactivate', confirm:true [, baseRevision] }
 *       Desactivación de emergencia: apaga los DOS interruptores del administrador (archivo de activación y `activation.enabled`) y la web
 *       vuelve a la portada anterior en la siguiente petición. Siempre posible (ignora la revisión); se registra.
 * Seguridad: sesión de administrador (401), CSRF (`sameOrigin` + cabecera X-Home-Layout-Editor: 1 + JSON) en POST, 405 en otros métodos.
 * Respuestas de error: 400 | 403 | 404 | 409 `conflicto` `sin_cambios` `version_vacia` | 413 | 415 | 422 `referencias_bloqueantes` | 423 | 500.
 * Cada operación (también las rechazadas por validación) deja una entrada en el registro (fecha, usuario, acción, versión, resultado).
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { getSessionUser, requireAdminAuth } from '../../../../lib/adminAuth';
import { sameOrigin } from '../../../../lib/alertsHttp';
import { HOME_LAYOUT_STAGE_ENABLED, envEnabled, readHomeLayout, resolveHomeMode, writeHomeLayout } from '../../../../lib/homeLayout/store';
import { readActivation, writeActivation } from '../../../../lib/homeLayout/activationStore';
import { loadSources } from '../../../../lib/homeLayout/sources';
import { resolveBlocks } from '../../../../lib/homeLayout/resolve';
import type { Block } from '../../../../lib/homeLayout/types';
import { findVersion, listVersions } from '../../../../lib/homeLayout/publish';
import {
  MAX_ACTIVATION_BODY_BYTES, activationRevision, appendLog, checkForActivation, planActivate, planDeactivate,
  type ActivationRefusal,
} from '../../../../lib/homeLayout/activation';

export const prerender = false;

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const json = (status: number, body: unknown, more: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...more } });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, more: Record<string, string> = {}) => json(status, { success: false, code, message, ...extra }, more);

const STATUS: Record<ActivationRefusal['reason'], number> = {
  peticion_invalida: 400, confirmacion_requerida: 400, documento_invalido: 400, version_no_encontrada: 404, version_vacia: 409, sin_cambios: 409, conflicto: 409,
  referencias_bloqueantes: 422, archivo_protegido: 423, activacion_protegida: 423,
};

function refuse(r: ActivationRefusal): Response {
  return fail(STATUS[r.reason], r.reason, r.errors[0] ?? 'Operación rechazada', {
    errors: r.errors,
    ...(r.blocking ? { blocking: r.blocking } : {}),
    ...(r.currentRevision !== undefined ? { currentRevision: r.currentRevision } : {}),
  });
}

const checkVersion = (blocks: readonly Block[]) => checkForActivation(blocks, resolveBlocks([...blocks], loadSources(), { runAutomatic: true }).blocks);

export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const url = new URL(request.url);
    const known = new Set(['check']);
    for (const k of url.searchParams.keys()) if (!known.has(k)) return fail(400, 'parametro_desconocido', `Parámetro no admitido: ${k.slice(0, 40)}`);
    if (url.searchParams.getAll('check').length > 1) return fail(400, 'parametro_repetido', 'check no puede repetirse');
    const layout = readHomeLayout();
    const act = readActivation();
    const body: Record<string, unknown> = {
      success: true,
      gates: {
        stage: HOME_LAYOUT_STAGE_ENABLED,
        env: envEnabled(process.env),
        adminFlag: layout.status === 'ok' && layout.doc.activation.enabled,
        activeFile: act.status === 'ok' && act.doc.active,
        pinnedVersion: act.status === 'ok' ? act.doc.pinnedVersion : null,
      },
      mode: resolveHomeMode(),
      revision: activationRevision(act.doc),
      published: layout.doc.published ? { version: layout.doc.published.version, publishedAt: layout.doc.published.publishedAt, blocks: layout.doc.published.blocks.length } : null,
      versions: listVersions(layout.doc),
      log: act.doc.log.slice(-30).reverse(),
      storage: { layout: layout.status, activation: act.status },
    };
    if (url.searchParams.has('check')) {
      const raw = url.searchParams.get('check') ?? '';
      const n = raw === '' ? (layout.doc.published?.version ?? 0) : Number(raw);
      if (!Number.isInteger(n) || n < 1) return fail(400, 'parametro_invalido', 'check debe ser el número de una versión');
      const v = findVersion(layout.doc, n);
      if (!v) return fail(404, 'version_no_encontrada', 'La versión indicada no existe');
      const c = checkVersion(v.blocks);
      body.check = { version: n, canActivate: c.blocking.length === 0, blocking: c.blocking, warnings: c.warnings, visibleBlocks: c.visibleBlocks, totalBlocks: c.totalBlocks };
    }
    return json(200, body);
  } catch {
    return fail(500, 'error_interno', 'No se pudo leer el estado');
  }
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  if (!sameOrigin(request)) return fail(403, 'origen_no_permitido', 'No se pudo verificar el origen de la petición');
  if (request.headers.get('x-home-layout-editor') !== '1') return fail(403, 'cabecera_requerida', 'Falta la cabecera de seguridad del editor');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return fail(415, 'tipo_no_admitido', 'El cuerpo debe ser application/json');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ACTIVATION_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');

  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_ACTIVATION_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');
    body = JSON.parse(text);
  } catch {
    return fail(400, 'json_invalido', 'El cuerpo no es JSON válido');
  }
  const action = typeof body === 'object' && body !== null ? (body as { action?: unknown }).action : undefined;
  if (action !== 'activate' && action !== 'deactivate') return fail(400, 'peticion_invalida', 'action debe ser activate o deactivate', { errors: ['action no válida'] });
  const by = (() => {
    try {
      return getSessionUser(request)?.username ?? 'admin';
    } catch {
      return 'admin';
    }
  })();

  try {
    // Desde aquí NO hay `await`: leer, validar con datos actuales y escribir ocurre sin interrupciones.
    const layout = readHomeLayout();
    const act = readActivation();
    const now = new Date();

    if (action === 'activate') {
      const plan = planActivate(layout, act, body, checkVersion, now, by);
      if (!plan.ok) {
        // Registro de la operación rechazada (no cambia la revisión del estado). Sólo si hay datos de activación utilizables.
        if (['referencias_bloqueantes', 'version_vacia', 'version_no_encontrada'].includes(plan.reason) && (act.status === 'ok' || act.status === 'missing')) {
          const v = typeof body === 'object' && body !== null && Number.isInteger((body as { version?: unknown }).version) ? ((body as { version: number }).version) : null;
          writeActivation(appendLog(act.doc, { at: now.toISOString(), by, action: 'activate', version: v, result: 'rechazada', note: plan.reason }));
        }
        return refuse(plan);
      }
      const w1 = writeActivation(plan.doc);
      if (!w1.ok) return w1.reason === 'archivo_protegido' ? fail(423, 'activacion_protegida', w1.errors[0] ?? 'Archivo protegido') : fail(500, 'error_escritura', 'No se pudo guardar la activación; no se cambió nada');
      const w2 = writeHomeLayout(plan.layout);
      if (!w2.ok) {
        // Deshacer: la versión fijada queda inactiva y el fallo se registra.
        writeActivation(appendLog({ ...act.doc, updatedAt: plan.doc.updatedAt }, { at: now.toISOString(), by, action: 'activate', version: plan.version, result: 'error', note: 'no se pudo escribir home-layout.json' }));
        return fail(500, 'error_escritura', 'No se pudo activar; la web sigue con la portada anterior');
      }
      return json(200, { success: true, action, version: plan.version, revision: plan.doc.updatedAt, warnings: plan.warnings, mode: resolveHomeMode(), envEnabled: envEnabled(process.env) });
    }

    const plan = planDeactivate(layout, act, body, now, by);
    if (!plan.ok) return refuse(plan);
    // Dos vías independientes: basta con que una funcione (la otra, si está dañada, ya sirve la portada anterior por sí sola).
    const w1 = writeActivation(plan.doc);
    const w2 = layout.status === 'ok' ? writeHomeLayout(plan.layout) : { ok: false as const };
    const inert = layout.status !== 'ok' || act.status === 'corrupt' || act.status === 'invalid' || act.status === 'newer';
    if (!w1.ok && !w2.ok && !inert) return fail(500, 'error_escritura', 'No se pudo desactivar. Como medida de emergencia, pon HOME_LAYOUT_ENABLED=false en el servidor y reinícialo');
    return json(200, { success: true, action, mode: resolveHomeMode(), revision: w1.ok ? plan.doc.updatedAt : activationRevision(act.doc), activationFileWritten: w1.ok, adminFlagWritten: w2.ok });
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
