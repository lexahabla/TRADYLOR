/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: PORTADA EDITABLE · COMPROBACIÓN DE REFERENCIAS (etapa 2, SOLO LECTURA)
 * ==============================================================================
 * GET /api/admin/home-layout/resolve
 *
 * Permisos : sólo administradores (comprobado en el servidor). Sin sesión o sin rol admin → 401.
 * Parámetros (todos opcionales; cualquier otro parámetro → 400 `parametro_desconocido`; un parámetro repetido → 400 `parametro_duplicado`):
 *   source   = draft (por defecto) | published | proposal
 *              · draft     bloques del borrador de `home-layout.json`
 *              · published bloques de la portada publicada (vacío si no hay ninguna)
 *              · proposal  bloques «Sección» generados EN MEMORIA desde las secciones publicadas de «Crear sección» (no se guardan)
 *              Otro valor → 400 `source_no_valido`.
 *   auto     = 1 (opcional, etapa 5): EJECUTA la selección de los bloques automáticos (sólo lectura, `automatic.ts`); sin él la selección
 *              sigue sin ejecutarse (`visible: null`), como en la etapa 2. Otro valor → 400 `auto_no_valido`. Con `auto=1` cada bloque
 *              automático incluye `selection` (estado, ids, explicación y recuentos).
 * Respuestas:
 *   200 { success, source, generatedAt, storage, sources, totals, blocks[], proposal? }
 *       blocks[].visible = true | false | null (null = modalidad automática sin evaluar); blocks[].issues[] con gravedad error|warning|info.
 *   400 { success:false, code, message }   parámetros no válidos
 *   401 (texto)                            sin permisos
 *   405 { success:false, code:'metodo_no_permitido' }  cualquier método distinto de GET (cabecera Allow: GET)
 *   500 { success:false, code:'error_interno', message }  sin detalles internos
 * No escribe nada, no crea `home-layout.json`, no devuelve rutas del servidor, comisiones, credenciales ni enlaces de afiliado.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { readHomeLayout } from '../../../../lib/homeLayout/store';
import { loadSources } from '../../../../lib/homeLayout/sources';
import { resolveBlocks } from '../../../../lib/homeLayout/resolve';
import { buildSectionsProposal } from '../../../../lib/homeLayout/sectionsProposal';

export const prerender = false;

const SOURCES = ['draft', 'published', 'proposal'] as const;
type SourceName = (typeof SOURCES)[number];
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

const fail = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, code, message }), { status, headers: { ...headers, ...extra } });

export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const seen = new Set<string>();
    for (const key of url.searchParams.keys()) {
      if (key !== 'source' && key !== 'auto') return fail(400, 'parametro_desconocido', `Parámetro no admitido: ${key.slice(0, 40)}`);
      if (seen.has(key)) return fail(400, 'parametro_duplicado', 'El parámetro «' + key + '» está repetido');
      seen.add(key);
    }
    const raw = url.searchParams.get('source') ?? 'draft';
    if (!SOURCES.includes(raw as SourceName)) return fail(400, 'source_no_valido', 'source debe ser draft, published o proposal');
    const source = raw as SourceName;
    const autoRaw = url.searchParams.get('auto');
    if (autoRaw !== null && autoRaw !== '1') return fail(400, 'auto_no_valido', 'auto solo admite el valor 1');

    const read = readHomeLayout();
    const src = loadSources();
    let blocks = read.doc.draft.blocks;
    let proposal: unknown;
    let note: string | undefined;

    if (source === 'published') {
      blocks = read.doc.published?.blocks ?? [];
      if (!read.doc.published) note = 'No hay ninguna portada publicada';
    } else if (source === 'proposal') {
      const p = buildSectionsProposal(src);
      blocks = p.proposed.map((x) => x.block);
      proposal = {
        above: p.above.map((x) => x.block.id),
        below: p.below.map((x) => x.block.id),
        skipped: p.skipped,
        sections: p.proposed.map((x) => ({
          blockId: x.block.id,
          sectionId: x.section.id,
          title: x.section.title,
          order: x.section.order,
          position: x.section.position,
          speed: x.section.speed,
          validProducts: x.validProductIds.length,
          invalidProducts: x.invalidProductIds.length,
        })),
      };
    }

    const { blocks: resolved, totals } = resolveBlocks(blocks, src, { runAutomatic: autoRaw === '1' });
    return new Response(
      JSON.stringify({
        success: true,
        source,
        generatedAt: new Date().toISOString(),
        ...(note ? { note } : {}),
        storage: { status: read.status },
        sources: src.status,
        totals,
        blocks: resolved,
        ...(proposal ? { proposal } : {}),
      }),
      { status: 200, headers },
    );
  } catch {
    return fail(500, 'error_interno', 'No se pudo comprobar la portada');
  }
};

/** Cualquier otro método: 405 (tras comprobar permisos). */
export const ALL: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  return fail(405, 'metodo_no_permitido', 'Sólo se admite GET', { Allow: 'GET' });
};
