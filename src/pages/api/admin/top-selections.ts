/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: MENÚ «TOP SELECCIONES» (gestión manual)
 * ==============================================================================
 * GET  /api/admin/top-selections
 *   { success, mode:'automatico'|'manual', revision, storage:{status, errors}, homeMode:'legacy'|'layout', maxItems,
 *     menu:[sectionId…] (orden guardado), sections:[{ id, title, published, position, productCount, inMenu, linked, warnings:[código…] }] }
 *   `linked` = el menú enlaza hoy esa sección; `warnings` explica por qué una sección elegida NO se enlaza (sin_productos, no_publicada,
 *   no_se_muestra_en_la_portada_nueva, no_existe). Sólo lectura.
 * PUT  { baseRevision, items:[sectionId…] }   Guarda el menú manual (orden incluido). 409 `conflicto` si la revisión es obsoleta.
 * POST { action:'snapshot' }                  «Fijar el menú actual»: pasa de automático a manual conservando las publicadas actuales (409 si ya es manual).
 * POST { action:'recover' }                   Recupera desde `nav-top-sections.json.bak` (guarda una copia del archivo dañado).
 * Seguridad: administrador (401), CSRF (`sameOrigin` + X-Home-Layout-Editor: 1 + JSON) en escrituras, cuerpo ≤ 8 KiB (413), 405 en otros métodos.
 * No modifica `sections.json` ni el orden/visibilidad de la portada.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { sameOrigin } from '../../../lib/alertsHttp';
import { readSections } from '../../../lib/sections';
import {
  MAX_BODY_BYTES, MAX_TOP_ITEMS, automaticMenu, ensureSnapshot, homeRenderContext, planSave, readTopSelections, recoverTopSelections, resolveNav, revisionOf, writeTopSelections,
} from '../../../lib/topSelections';
import { getCatalogProducts } from '../../../lib/catalog';

export const prerender = false;

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const json = (status: number, body: unknown, more: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...more } });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, more: Record<string, string> = {}) => json(status, { success: false, code, message, ...extra }, more);

function state() {
  const sections = readSections() || [];
  const read = readTopSelections();
  const ctx = homeRenderContext(sections);
  const nav = resolveNav(sections, read, ctx);
  const existing = new Set((getCatalogProducts() as Array<{ id?: string }>).map((p) => p.id).filter((x): x is string => typeof x === 'string'));
  const linked = new Set(nav.items.map((s) => s.id));
  const skipped = new Map(nav.skipped.map((s) => [s.id, s.reason]));
  const menu = read.status === 'ok' ? read.doc.items.map((i) => i.sectionId) : [];
  const rows = sections.map((s) => ({
    id: s.id,
    title: s.title,
    published: s.published,
    position: s.position === 'above' ? 'above' : 'below',
    productCount: s.productIds.filter((id) => existing.has(id)).length,
    inMenu: read.status === 'ok' ? menu.includes(s.id) : s.published,
    linked: linked.has(s.id),
    warnings: skipped.has(s.id) && (read.status === 'ok' ? menu.includes(s.id) : s.published) ? [skipped.get(s.id)] : [],
  }));
  const orphans = menu.filter((id) => !sections.some((s) => s.id === id));
  return { read, nav, ctx, rows, menu, orphans, sections };
}

export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const { read, nav, ctx, rows, menu, orphans, sections } = state();
    return json(200, {
      success: true,
      mode: nav.mode,
      revision: revisionOf(read.doc),
      storage: { status: read.status, errors: read.errors },
      homeMode: ctx.mode,
      maxItems: MAX_TOP_ITEMS,
      menu: read.status === 'ok' ? menu.filter((id) => !orphans.includes(id)) : automaticMenu(sections).map((s) => s.id),
      orphans,
      sections: rows,
    });
  } catch {
    return fail(500, 'error_interno', 'No se pudo leer el menú');
  }
};

async function guarded(request: Request): Promise<{ body: unknown } | Response> {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  if (!sameOrigin(request)) return fail(403, 'origen_no_permitido', 'No se pudo verificar el origen de la petición');
  if (request.headers.get('x-home-layout-editor') !== '1') return fail(403, 'cabecera_requerida', 'Falta la cabecera de seguridad del editor');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return fail(415, 'tipo_no_admitido', 'El cuerpo debe ser application/json');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande');
    return { body: JSON.parse(text) };
  } catch {
    return fail(400, 'json_invalido', 'El cuerpo no es JSON válido');
  }
}

const STATUS = { peticion_invalida: 400, documento_invalido: 400, archivo_protegido: 423, conflicto: 409 } as const;

export const PUT: APIRoute = async ({ request }) => {
  const g = await guarded(request);
  if (g instanceof Response) return g;
  try {
    // Sin `await` desde aquí: leer, decidir y escribir sin interrupciones.
    const sections = readSections() || [];
    const plan = planSave(readTopSelections(), g.body, new Set(sections.map((s) => s.id)), new Date());
    if (!plan.ok) return fail(STATUS[plan.reason], plan.reason, plan.errors[0] ?? 'Operación rechazada', { errors: plan.errors, ...(plan.currentRevision ? { currentRevision: plan.currentRevision } : {}) });
    const w = writeTopSelections(plan.doc);
    if (!w.ok) return w.reason === 'archivo_protegido' ? fail(423, 'archivo_protegido', w.errors[0] ?? 'Archivo protegido') : fail(w.reason === 'documento_invalido' ? 400 : 500, w.reason, 'No se pudo guardar; el menú anterior sigue intacto');
    return json(200, { success: true, revision: plan.revision, menu: plan.doc.items.map((i) => i.sectionId) });
  } catch {
    return fail(500, 'error_interno', 'No se pudo completar la operación');
  }
};

export const POST: APIRoute = async ({ request }) => {
  const g = await guarded(request);
  if (g instanceof Response) return g;
  const action = typeof g.body === 'object' && g.body !== null ? (g.body as { action?: unknown }).action : undefined;
  const keys = typeof g.body === 'object' && g.body !== null ? Object.keys(g.body as object) : [];
  if ((action !== 'snapshot' && action !== 'recover') || keys.some((k) => k !== 'action')) return fail(400, 'peticion_invalida', 'action debe ser snapshot o recover (sin más campos)');
  try {
    if (action === 'snapshot') {
      if (readTopSelections().status === 'ok') return fail(409, 'ya_manual', 'El menú ya es manual');
      const r = ensureSnapshot();
      if (!r.ok) return fail(r.reason === 'archivo_protegido' ? 423 : 500, r.reason, r.errors[0] ?? 'No se pudo fijar el menú');
      return json(200, { success: true, action, revision: revisionOf(readTopSelections().doc) });
    }
    const r = recoverTopSelections();
    if (!r.ok) return fail(r.reason === 'error_escritura' ? 500 : 409, r.reason, r.errors[0] ?? 'No se pudo recuperar');
    return json(200, { success: true, action, preservedCorrupt: r.preservedCorrupt, revision: revisionOf(readTopSelections().doc) });
  } catch {
    return fail(500, 'error_interno', 'No se pudo completar la operación');
  }
};

/** Cualquier otro método: 405 (tras comprobar permisos). */
export const ALL: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  return fail(405, 'metodo_no_permitido', 'Sólo se admite GET, PUT y POST', {}, { Allow: 'GET, PUT, POST' });
};
