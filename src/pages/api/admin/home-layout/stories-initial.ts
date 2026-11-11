/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: HISTORIAS INICIALES DE LA PORTADA
 * ==============================================================================
 * GET  /api/admin/home-layout/stories-initial
 *   { success, available, reason?, revision, stories[], report[] }. Sólo lectura: calcula con el catálogo REAL de este momento las seis primeras
 *   historias (`homeLayout/initialStories.ts`) y dice si se pueden crear (sólo si NO existe ninguna historia: nunca sobrescribe).
 * POST /api/admin/home-layout/stories-initial   { action:'create_initial', baseRevision, confirm:true }
 *   Guarda esas historias como BORRADOR (no se ven en la web hasta que el administrador marque cada una como «publicada»). Se recalculan en el
 *   servidor (no se confía en el cliente) y se guardan con las mismas validaciones que «Guardar historias» (revisión, tamaño, imágenes seguras).
 * Seguridad: administrador (401), CSRF (`sameOrigin` + `X-Home-Layout-Editor: 1` + JSON), cuerpo ≤ 1 KiB, 405 en otros métodos.
 * No toca portada, versiones, copias, activación, catálogo ni precios. Sin llamadas externas.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { sameOrigin } from '../../../../lib/alertsHttp';
import { getCatalogProducts } from '../../../../lib/catalog';
import { loadSources } from '../../../../lib/homeLayout/sources';
import { localImageExists } from '../../../../lib/homeLayout/public';
import { readStories, writeStories } from '../../../../lib/homeLayout/storiesStore';
import { checkStories, prepareStoriesSave, revisionOf } from '../../../../lib/homeLayout/stories';
import { buildInitialStories } from '../../../../lib/homeLayout/initialStories';

export const prerender = false;

const MAX_BODY = 1024;
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const json = (status: number, body: unknown, more: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...more } });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, more: Record<string, string> = {}) => json(status, { success: false, code, message, ...extra }, more);

const compute = () => {
  const src = loadSources();
  return { src, ...buildInitialStories({ products: getCatalogProducts() as unknown as Array<Record<string, any>>, categories: [...src.categories.values()], retiredIds: src.retiredIds, imageOk: localImageExists, now: new Date() }) };
};

export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const read = readStories();
    const protectedFile = read.status === 'corrupt' || read.status === 'invalid' || read.status === 'newer';
    const existing = read.doc.draft.stories.length;
    const { src, stories, report } = compute();
    const available = !protectedFile && existing === 0 && stories.length > 0;
    return json(200, {
      success: true,
      available,
      ...(available ? {} : { reason: protectedFile ? 'archivo_protegido' : existing > 0 ? 'ya_hay_historias' : 'sin_contenido' }),
      revision: revisionOf(read.doc.draft.updatedAt),
      stories,
      report,
      issues: checkStories(stories, src).filter((i) => i.severity !== 'info'),
    });
  } catch {
    return fail(500, 'error_interno', 'No se pudieron preparar las historias iniciales');
  }
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  if (!sameOrigin(request)) return fail(403, 'origen_no_permitido', 'No se pudo verificar el origen de la petición');
  if (request.headers.get('x-home-layout-editor') !== '1') return fail(403, 'cabecera_requerida', 'Falta la cabecera de seguridad del editor');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return fail(415, 'tipo_no_admitido', 'El cuerpo debe ser application/json');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');
  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');
    body = JSON.parse(text);
  } catch {
    return fail(400, 'json_invalido', 'El cuerpo no es JSON válido');
  }
  const o = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : null) as Record<string, unknown> | null;
  if (!o || Object.keys(o).some((k) => !['action', 'baseRevision', 'confirm'].includes(k)) || o.action !== 'create_initial' || typeof o.baseRevision !== 'string' || !o.baseRevision) {
    return fail(400, 'peticion_invalida', 'Cuerpo no válido');
  }
  if (o.confirm !== true) return fail(400, 'confirmacion_requerida', 'Crear las historias exige confirmación explícita (confirm: true)');
  try {
    // Sin `await` desde aquí: leer, decidir con los datos actuales y escribir sin interrupciones.
    const read = readStories();
    if (read.status === 'corrupt' || read.status === 'invalid' || read.status === 'newer') return fail(423, 'archivo_protegido', `El almacenamiento está en estado «${read.status}»: se conserva sin sobrescribir`);
    if (read.doc.draft.stories.length > 0) return fail(409, 'ya_hay_historias', 'Ya existen historias: no se sobrescribe nada');
    const { src, stories, report } = compute();
    if (!stories.length) return fail(422, 'sin_contenido', 'No hay productos reales suficientes para crear historias', { report });
    if (stories.some((s) => s.status !== 'borrador')) return fail(500, 'error_interno', 'Las historias iniciales deben crearse como borrador');
    const plan = prepareStoriesSave(read, { baseRevision: o.baseRevision, stories }, new Date());
    if (!plan.ok) return fail(plan.reason === 'conflicto' ? 409 : plan.reason === 'archivo_protegido' ? 423 : 400, plan.reason, plan.errors[0] ?? 'Operación rechazada', { errors: plan.errors });
    const w = writeStories(plan.doc);
    if (!w.ok) return w.reason === 'archivo_protegido' ? fail(423, 'archivo_protegido', w.errors[0] ?? 'Archivo protegido') : fail(500, 'error_escritura', 'No se pudieron guardar las historias; no se cambió nada');
    return json(200, { success: true, action: 'create_initial', revision: plan.revision, created: stories.map((s) => ({ id: s.id, name: s.name, screens: s.screens.length })), report, issues: checkStories(stories, src).filter((i) => i.severity !== 'info') });
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
