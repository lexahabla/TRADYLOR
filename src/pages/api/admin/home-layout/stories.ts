/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: HISTORIAS DE LA PORTADA EDITABLE (etapa 5)
 * ==============================================================================
 * GET /api/admin/home-layout/stories   Lista las historias del borrador + la comprobación de referencias (solo lectura).
 * PUT /api/admin/home-layout/stories   Guarda las historias. Cuerpo { baseRevision, stories } (cualquier otro campo → 400).
 *
 * Almacenamiento independiente: `home-stories.json` (volumen, no git). Un único borrador con revisión (= `draft.updatedAt`, «inicial» si no
 * hay) y estado por historia (borrador | publicada INTERNAMENTE: no se muestra en la web pública; eso es de la etapa 6). Sin historial.
 * Seguridad: sólo administradores (401); PUT con CSRF (Origin propio + cabecera X-Home-Layout-Editor: 1 + JSON), cuerpo ≤ 128 KiB (413),
 * validación estricta (≤ 20 historias, ≤ 10 pantallas, imágenes seguras), revisión obsoleta → 409 `conflicto`, archivo dañado → 423 sin
 * sobrescribir, escritura atómica con `.bak`; fallo de escritura → 500 sin detalles y el archivo anterior intacto.
 * Publicación: una historia con ERRORES (producto o categoría inexistente/retirado) no puede pasar a «publicada» ni modificarse estando
 * publicada → 422 `historias_con_errores` con la lista; las que ya estaban publicadas y no cambian no bloquean (así un producto retirado
 * después no impide editar el resto). Los avisos nunca bloquean.
 * Respuestas GET 200 { success, revision, stories, storage, writable, limits, issues[] }; PUT 200 { success, revision, stories, savedAt, issues[] }.
 * No modifica productos ni categorías, no devuelve enlaces de afiliado ni rutas del servidor.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { sameOrigin } from '../../../../lib/alertsHttp';
import { loadSources } from '../../../../lib/homeLayout/sources';
import { readStories, writeStories } from '../../../../lib/homeLayout/storiesStore';
import { MAX_BODY_BYTES, MAX_SCREENS, MAX_STORIES, blockingErrors, checkStories, prepareStoriesSave, revisionOf } from '../../../../lib/homeLayout/stories';

export const prerender = false;

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, more: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, code, message, ...extra }), { status, headers: { ...headers, ...more } });

export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const read = readStories();
    const stories = read.doc.draft.stories;
    return new Response(
      JSON.stringify({
        success: true,
        revision: revisionOf(read.doc.draft.updatedAt),
        stories,
        storage: { status: read.status },
        writable: read.status === 'ok' || read.status === 'missing',
        limits: { maxStories: MAX_STORIES, maxScreens: MAX_SCREENS, maxBodyBytes: MAX_BODY_BYTES },
        issues: checkStories(stories, loadSources()).slice(0, 200),
      }),
      { status: 200, headers },
    );
  } catch {
    return fail(500, 'error_interno', 'No se pudieron leer las historias');
  }
};

export const PUT: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  if (!sameOrigin(request)) return fail(403, 'origen_no_permitido', 'No se pudo verificar el origen de la petición');
  if (request.headers.get('x-home-layout-editor') !== '1') return fail(403, 'cabecera_requerida', 'Falta la cabecera de seguridad del editor');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return fail(415, 'tipo_no_admitido', 'El cuerpo debe ser application/json');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Las historias superan el tamaño máximo');

  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Las historias superan el tamaño máximo');
    body = JSON.parse(text);
  } catch {
    return fail(400, 'json_invalido', 'El cuerpo no es JSON válido');
  }

  try {
    // Desde aquí NO hay `await`: leer, comprobar revisión y referencias con los datos actuales y escribir ocurre sin interrupciones.
    const read = readStories();
    const plan = prepareStoriesSave(read, body, new Date());
    if (!plan.ok) {
      if (plan.reason === 'conflicto') return fail(409, 'conflicto', plan.errors[0], { currentRevision: plan.currentRevision });
      if (plan.reason === 'archivo_protegido') return fail(423, 'archivo_protegido', plan.errors[0]);
      return fail(400, plan.reason, plan.reason === 'documento_invalido' ? 'Las historias no son válidas' : 'Petición no válida', { errors: plan.errors });
    }
    const stories = plan.doc.draft.stories;
    const issues = checkStories(stories, loadSources());
    // Sólo bloquean las historias publicadas que son nuevas o han cambiado (las ya publicadas y sin cambios no impiden guardar el resto).
    const before = new Map(read.doc.draft.stories.map((s) => [s.id, JSON.stringify(s)]));
    const unchanged = new Set(stories.filter((s) => s.status === 'publicada' && before.get(s.id) === JSON.stringify(s)).map((s) => s.id));
    const blocking = blockingErrors(stories, issues).filter((i) => !unchanged.has(i.storyId));
    if (blocking.length) {
      return fail(422, 'historias_con_errores', 'Hay historias con errores que no pueden quedar como publicadas: corrígelas o déjalas en borrador', { blocking: blocking.slice(0, 50) });
    }
    const written = writeStories(plan.doc);
    if (!written.ok) {
      if (written.reason === 'archivo_protegido') return fail(423, 'archivo_protegido', written.errors[0] ?? 'Almacenamiento protegido');
      if (written.reason === 'documento_invalido') return fail(400, 'documento_invalido', 'Las historias no son válidas', { errors: written.errors });
      return fail(500, 'error_escritura', 'No se pudieron guardar las historias; las anteriores siguen intactas');
    }
    return new Response(JSON.stringify({ success: true, revision: plan.revision, stories, savedAt: plan.revision, issues: issues.slice(0, 200) }), { status: 200, headers });
  } catch {
    return fail(500, 'error_interno', 'No se pudieron guardar las historias');
  }
};

/** Cualquier otro método: 405 (tras comprobar permisos). */
export const ALL: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  return fail(405, 'metodo_no_permitido', 'Sólo se admite GET y PUT', {}, { Allow: 'GET, PUT' });
};
