/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: BORRADOR DE LA PORTADA EDITABLE (etapa 3)
 * ==============================================================================
 * GET /api/admin/home-layout/draft
 *   200 { success, revision, blocks[], storage:{status}, writable, limits:{maxBlocks,maxBodyBytes} }
 *   Solo lectura: no crea archivos. `revision` = «inicial» si todavía no hay borrador guardado.
 *
 * PUT /api/admin/home-layout/draft        Guarda el BORRADOR (nunca publica ni activa nada).
 *   Cuerpo JSON: { baseRevision: string, blocks: Block[] }  (cualquier otro campo → 400)
 *   · baseRevision = la `revision` que el cliente cargó. Si ya no coincide con la del servidor → 409 `conflicto` y NO se escribe nada.
 *   · Los bloques se validan con el modelo estricto (≤ 60 bloques, ≤ 24 referencias por bloque, modalidades/formatos/anchos registrados).
 *   · Escritura atómica (temporal + renombrado) con copia `home-layout.json.bak`. Un archivo dañado, inválido o de un esquema más nuevo NO se
 *     sobrescribe (423).
 *   · Sólo cambia `draft` (bloques y `updatedAt`, que es la nueva revisión); `activation`, `published` y `versions` se conservan.
 *   200 { success, revision, blocks[], savedAt }
 *   400 { success:false, code:'peticion_invalida' | 'json_invalido' | 'documento_invalido', message, errors[] }
 *   401 (texto)                                       sin permisos de administrador
 *   403 { code:'origen_no_permitido' | 'cabecera_requerida' }   protección CSRF: el Origin debe ser el propio sitio y la petición debe llevar
 *                                                      la cabecera `X-Home-Layout-Editor: 1` (obliga a un preflight CORS en peticiones cruzadas)
 *   409 { code:'conflicto', currentRevision }         revisión obsoleta (otra sesión guardó antes)
 *   413 { code:'cuerpo_demasiado_grande' }            más de 256 KiB
 *   415 { code:'tipo_no_admitido' }                   el Content-Type debe ser application/json
 *   423 { code:'archivo_protegido' }                  almacenamiento dañado: se conserva para diagnóstico
 *   405 { code:'metodo_no_permitido' }  (Allow: GET, PUT)
 *   500 { code:'error_escritura' | 'error_interno' }  sin detalles internos
 * Sin guardado automático: sólo se escribe cuando el administrador pulsa «Guardar borrador».
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { sameOrigin } from '../../../../lib/alertsHttp';
import { readHomeLayout, writeHomeLayout } from '../../../../lib/homeLayout/store';
import { MAX_BODY_BYTES, prepareDraftSave, revisionOf } from '../../../../lib/homeLayout/draft';
import { MAX_BLOCKS } from '../../../../lib/homeLayout/validate';

export const prerender = false;

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, more: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, code, message, ...extra }), { status, headers: { ...headers, ...more } });

export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const read = readHomeLayout();
    const writable = read.status === 'ok' || read.status === 'missing';
    return new Response(
      JSON.stringify({
        success: true,
        revision: revisionOf(read.doc.draft.updatedAt),
        blocks: read.doc.draft.blocks,
        storage: { status: read.status },
        writable,
        limits: { maxBlocks: MAX_BLOCKS, maxBodyBytes: MAX_BODY_BYTES },
      }),
      { status: 200, headers },
    );
  } catch {
    return fail(500, 'error_interno', 'No se pudo leer el borrador');
  }
};

export const PUT: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  // Protección CSRF (arquitectura existente: Origin del propio sitio + cookie SameSite=Lax) reforzada con una cabecera propia.
  if (!sameOrigin(request)) return fail(403, 'origen_no_permitido', 'No se pudo verificar el origen de la petición');
  if (request.headers.get('x-home-layout-editor') !== '1') return fail(403, 'cabecera_requerida', 'Falta la cabecera de seguridad del editor');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return fail(415, 'tipo_no_admitido', 'El cuerpo debe ser application/json');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'El borrador supera el tamaño máximo');

  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'El borrador supera el tamaño máximo');
    body = JSON.parse(text);
  } catch {
    return fail(400, 'json_invalido', 'El cuerpo no es JSON válido');
  }

  try {
    // Desde aquí NO hay `await`: leer, comprobar la revisión y escribir ocurre sin interrupciones (nadie puede colarse entre medias).
    const read = readHomeLayout();
    const plan = prepareDraftSave(read, body, new Date());
    if (!plan.ok) {
      if (plan.reason === 'conflicto') return fail(409, 'conflicto', plan.errors[0], { currentRevision: plan.currentRevision });
      if (plan.reason === 'archivo_protegido') return fail(423, 'archivo_protegido', plan.errors[0]);
      return fail(400, plan.reason, plan.reason === 'documento_invalido' ? 'El borrador no es válido' : 'Petición no válida', { errors: plan.errors });
    }
    const written = writeHomeLayout(plan.doc);
    if (!written.ok) {
      if (written.reason === 'archivo_protegido') return fail(423, 'archivo_protegido', written.errors[0] ?? 'Almacenamiento protegido');
      if (written.reason === 'documento_invalido') return fail(400, 'documento_invalido', 'El borrador no es válido', { errors: written.errors });
      return fail(500, 'error_escritura', 'No se pudo guardar el borrador; el anterior sigue intacto');
    }
    return new Response(JSON.stringify({ success: true, revision: plan.revision, blocks: plan.doc.draft.blocks, savedAt: plan.revision }), { status: 200, headers });
  } catch {
    return fail(500, 'error_interno', 'No se pudo guardar el borrador');
  }
};

/** Cualquier otro método: 405 (tras comprobar permisos). */
export const ALL: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  return fail(405, 'metodo_no_permitido', 'Sólo se admite GET y PUT', {}, { Allow: 'GET, PUT' });
};
