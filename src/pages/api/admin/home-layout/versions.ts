/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: VERSIONES DE LA PORTADA EDITABLE (etapa 4, SOLO LECTURA)
 * ==============================================================================
 * GET /api/admin/home-layout/versions
 *
 * Permisos: sólo administradores (401 si no). Cualquier otro método → 405 (Allow: GET). No escribe nada.
 * Un único modo por petición (parámetros desconocidos o repetidos → 400; mezclar modos → 400 `combinacion_no_valida`):
 *   (sin parámetros)              Resumen: borrador (revisión y nº de bloques), publicada, archivadas, almacenamiento y portada servida.
 *   ?version=N                    Detalle de la versión N (publicada o archivada): bloques + comprobación con los datos ACTUALES (`resolved`).
 *                                 N entero ≥ 1 (otro valor → 400 `version_no_valida`; no existe → 404 `version_no_encontrada`).
 *   ?compare=A&with=B             Diferencias para pasar de A a B. A y B ∈ draft | published | N. Deben ir las dos
 *                                 (si falta una → 400 `combinacion_no_valida`; valor no válido → 400 `referencia_no_valida`; no existe → 404).
 *   ?check=publish                Comprobación previa a publicar con los datos actuales: { canPublish, reasons[], blocking[], warnings[],
 *                                 changes[], nextVersion, stories }. No publica nada. Ejecuta la selección de los bloques automáticos.
 *                                 `stories` (etapa 5) = avisos INFORMATIVOS de las historias publicadas internamente (nunca bloquean la
 *                                 publicación de la portada): { published, issues[] }.
 * Respuestas 200 { success, … } · 400/404 { success:false, code, message } · 500 { code:'error_interno' } sin detalles internos.
 * No devuelve enlaces de afiliado, comisiones, credenciales ni rutas del servidor.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { readHomeLayout, resolveHomeMode } from '../../../../lib/homeLayout/store';
import { loadSources } from '../../../../lib/homeLayout/sources';
import { resolveBlocks } from '../../../../lib/homeLayout/resolve';
import { revisionOf } from '../../../../lib/homeLayout/draft';
import { MAX_VERSIONS } from '../../../../lib/homeLayout/validate';
import { diffBlocks, findVersion, listVersions, nextVersionNumber, splitIssues } from '../../../../lib/homeLayout/publish';
import { readStories } from '../../../../lib/homeLayout/storiesStore';
import { checkStories } from '../../../../lib/homeLayout/stories';
import type { Block, ContentRef } from '../../../../lib/homeLayout/types';

export const prerender = false;

const ALLOWED = new Set(['version', 'compare', 'with', 'check']);
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const fail = (status: number, code: string, message: string, more: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, code, message }), { status, headers: { ...headers, ...more } });
const ok = (body: Record<string, unknown>) => new Response(JSON.stringify({ success: true, ...body }), { status: 200, headers });

const parseVersion = (raw: string): number | null => (/^\d{1,6}$/.test(raw) && Number(raw) >= 1 ? Number(raw) : null);

export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const seen = new Set<string>();
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED.has(key)) return fail(400, 'parametro_desconocido', `Parámetro no admitido: ${key.slice(0, 40)}`);
      if (seen.has(key)) return fail(400, 'parametro_duplicado', `El parámetro «${key}» está repetido`);
      seen.add(key);
    }
    const q = url.searchParams;
    const modes = ['version', 'compare', 'check'].filter((k) => q.has(k));
    if (modes.length > 1 || (q.has('with') && !q.has('compare')) || (q.has('compare') && !q.has('with'))) return fail(400, 'combinacion_no_valida', 'Combinación de parámetros no válida');

    const read = readHomeLayout();
    const doc = read.doc;
    const src = loadSources();
    const label = (r: ContentRef): string => {
      if (r.kind === 'product') return src.products.get(r.id)?.title || r.id;
      if (r.kind === 'category') return src.categories.get(r.id)?.name ?? r.id;
      if (r.kind === 'section') return src.sections.get(r.id)?.title ?? r.id;
      return r.id;
    };

    if (q.has('version')) {
      const n = parseVersion(q.get('version') ?? '');
      if (n === null) return fail(400, 'version_no_valida', 'version debe ser un entero ≥ 1');
      const v = findVersion(doc, n);
      if (!v) return fail(404, 'version_no_encontrada', 'La versión indicada no existe');
      return ok({ version: v.version, state: v.state, publishedAt: v.publishedAt, blocks: v.blocks, resolved: resolveBlocks(v.blocks, src, { runAutomatic: true }).blocks });
    }

    if (q.has('compare')) {
      const pick = (raw: string): { blocks: Block[]; name: string } | 'invalid' | null => {
        if (raw === 'draft') return { blocks: doc.draft.blocks, name: 'Borrador' };
        if (raw === 'published') return doc.published ? { blocks: doc.published.blocks, name: `v${doc.published.version}` } : null;
        const n = parseVersion(raw);
        if (n === null) return 'invalid';
        const v = findVersion(doc, n);
        return v ? { blocks: v.blocks, name: `v${v.version}` } : null;
      };
      const a = pick(q.get('compare') ?? '');
      const b = pick(q.get('with') ?? '');
      if (a === 'invalid' || b === 'invalid') return fail(400, 'referencia_no_valida', 'compare y with deben ser draft, published o un número de versión');
      if (!a || !b) return fail(404, 'version_no_encontrada', 'Alguna de las versiones indicadas no existe');
      return ok({ from: a.name, to: b.name, changes: diffBlocks(a.blocks, b.blocks, label) });
    }

    if (q.has('check')) {
      if (q.get('check') !== 'publish') return fail(400, 'check_no_valido', 'check solo admite publish');
      const blocks = doc.draft.blocks;
      const { blocking, warnings } = splitIssues(blocks, resolveBlocks(blocks, src, { runAutomatic: true }).blocks);
      const storyDoc = readStories().doc.draft.stories;
      const published = storyDoc.filter((s) => s.status === 'publicada');
      const storyIssues = checkStories(published, src).filter((i) => i.severity !== 'info').slice(0, 50);
      const reasons: string[] = [];
      if (read.status === 'corrupt' || read.status === 'invalid' || read.status === 'newer') reasons.push('archivo_protegido');
      if (doc.draft.updatedAt === null) reasons.push('borrador_vacio');
      else if (blocks.length === 0) reasons.push('borrador_vacio');
      if (blocking.length) reasons.push('referencias_bloqueantes');
      if (doc.published && JSON.stringify(doc.published.blocks) === JSON.stringify(blocks)) reasons.push('sin_cambios');
      if (doc.versions.length + (doc.published ? 1 : 0) > MAX_VERSIONS) reasons.push('limite_versiones');
      return ok({
        canPublish: reasons.length === 0,
        reasons,
        blocking,
        warnings,
        changes: diffBlocks(doc.published?.blocks ?? [], blocks, label),
        nextVersion: nextVersionNumber(doc),
        revision: revisionOf(doc.draft.updatedAt),
        basePublished: doc.published?.version ?? null,
        stories: { published: published.length, issues: storyIssues },
      });
    }

    return ok({
      mode: resolveHomeMode(),
      storage: { status: read.status },
      activation: doc.activation,
      draft: { revision: revisionOf(doc.draft.updatedAt), blocks: doc.draft.blocks.length, updatedAt: doc.draft.updatedAt },
      published: doc.published ? { version: doc.published.version, publishedAt: doc.published.publishedAt, blocks: doc.published.blocks.length } : null,
      versions: listVersions(doc),
      limits: { maxVersions: MAX_VERSIONS },
    });
  } catch {
    return fail(500, 'error_interno', 'No se pudieron obtener las versiones');
  }
};

/** Cualquier otro método: 405 (tras comprobar permisos). */
export const ALL: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  return fail(405, 'metodo_no_permitido', 'Sólo se admite GET', { Allow: 'GET' });
};
