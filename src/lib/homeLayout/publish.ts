/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · PUBLICACIÓN INTERNA, VERSIONES Y COMPARACIÓN (etapa 4, funciones PURAS)
 * ==============================================================================
 * Sin acceso a disco ni a la red (se usa en el servidor y en el navegador). La escritura la hacen los endpoints con `store.writeHomeLayout`.
 *
 * «Publicar» aquí es INTERNO: guarda el borrador como la versión `published` del documento y archiva la anterior en `versions`. NO activa la
 * portada nueva (`activation.enabled` no se toca y `resolveHomeMode()` sigue devolviendo la portada actual): los visitantes no ven nada nuevo.
 *
 * Garantías del almacenamiento (`LayoutDocument`):
 *  · `published` + `versions[]` (≤ 100) se actualizan en UNA sola escritura atómica con copia `.bak`: un fallo deja el historial anterior intacto.
 *  · Nunca se elimina una versión: al llegar al máximo, publicar se rechaza (`limite_versiones`) hasta decidir una política de retención.
 *  · Concurrencia: publicar y recuperar exigen la revisión del borrador que vio el administrador (`baseRevision` = `draft.updatedAt`); publicar
 *    exige además la versión publicada que vio (`basePublished`). Una revisión obsoleta se rechaza con 409 y NO se escribe nada.
 *  · Un archivo dañado, inválido o de un esquema más nuevo NO se sobrescribe.
 *  · Los números de versión son consecutivos (máximo existente + 1) y no se reutilizan.
 * ==============================================================================
 */

import type { Block, ContentRef, LayoutDocument, PublishedLayout } from './types';
import { MAX_VERSIONS, validateBlocks, validateDocument } from './validate';
import { revisionOf } from './draft';
import type { Issue, ResolvedBlock } from './resolve';

export const MAX_PUBLISH_BODY_BYTES = 4 * 1024;

/* ───────────────────────── Comparación de versiones ───────────────────────── */

export type DiffKind = 'added' | 'removed' | 'moved' | 'width' | 'format' | 'modality' | 'title' | 'card' | 'visibility' | 'refs' | 'config';
export interface DiffEntry {
  kind: DiffKind;
  blockId: string;
  title: string;
  detail: string;
}

const WIDTH_TXT: Record<number, string> = { 3: '¼', 4: '⅓', 6: '½', 8: '⅔', 9: '¾', 12: 'completo' };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const refKey = (r: ContentRef) => `${r.kind}:${r.id}`;

/** Cambios para pasar de `from` a `to`: bloques añadidos o eliminados, orden, anchos, formatos, modalidades, referencias y propiedades. */
export function diffBlocks(from: readonly Block[], to: readonly Block[], label: (r: ContentRef) => string = (r) => r.id): DiffEntry[] {
  const out: DiffEntry[] = [];
  const a = new Map(from.map((b, i) => [b.id, { b, i }]));
  const b = new Map(to.map((x, i) => [x.id, { b: x, i }]));
  for (const x of to) if (!a.has(x.id)) out.push({ kind: 'added', blockId: x.id, title: x.title, detail: `Bloque añadido en la posición ${(b.get(x.id) as { i: number }).i + 1}` });
  for (const x of from) if (!b.has(x.id)) out.push({ kind: 'removed', blockId: x.id, title: x.title, detail: 'Bloque eliminado' });

  // Orden: posición relativa entre los bloques que existen en ambas versiones.
  const common = from.filter((x) => b.has(x.id)).map((x) => x.id);
  const orderTo = to.filter((x) => a.has(x.id)).map((x) => x.id);
  for (let i = 0; i < common.length; i++) {
    if (common[i] !== orderTo[i]) {
      // Sólo se informa de los bloques cuya posición relativa cambió.
      const id = common[i];
      const pos = orderTo.indexOf(id);
      if (pos !== i) {
        const blk = (b.get(id) as { b: Block }).b;
        out.push({ kind: 'moved', blockId: id, title: blk.title, detail: `Orden: posición ${i + 1} → ${pos + 1} (entre los bloques comunes)` });
      }
    }
  }

  for (const x of to) {
    const before = a.get(x.id)?.b;
    if (!before) continue;
    if (before.width !== x.width) out.push({ kind: 'width', blockId: x.id, title: x.title, detail: `Ancho: ${WIDTH_TXT[before.width]} → ${WIDTH_TXT[x.width]}` });
    if (before.format !== x.format) out.push({ kind: 'format', blockId: x.id, title: x.title, detail: `Formato: ${before.format} → ${x.format}` });
    if (before.modality !== x.modality) out.push({ kind: 'modality', blockId: x.id, title: x.title, detail: `Modalidad: ${before.modality} → ${x.modality}` });
    if (before.title !== x.title) out.push({ kind: 'title', blockId: x.id, title: x.title, detail: `Título: «${before.title}» → «${x.title}»` });
    if (before.card !== x.card) out.push({ kind: 'card', blockId: x.id, title: x.title, detail: `Tarjeta: ${before.card} → ${x.card}` });
    if (before.visible !== x.visible) out.push({ kind: 'visibility', blockId: x.id, title: x.title, detail: x.visible ? 'Pasa a visible' : 'Pasa a oculto' });
    const kb = new Set(before.refs.map(refKey));
    const ka = new Set(x.refs.map(refKey));
    const added = x.refs.filter((r) => !kb.has(refKey(r)));
    const removed = before.refs.filter((r) => !ka.has(refKey(r)));
    const reordered = !added.length && !removed.length && !same(before.refs.map(refKey), x.refs.map(refKey));
    if (added.length || removed.length || reordered) {
      const parts = [
        added.length ? `añadidos: ${added.map(label).join(', ')}` : '',
        removed.length ? `quitados: ${removed.map(label).join(', ')}` : '',
        reordered ? 'cambia el orden de los elementos' : '',
      ].filter(Boolean);
      out.push({ kind: 'refs', blockId: x.id, title: x.title, detail: `Elementos ${parts.join(' · ')}` });
    }
    if (!same(before.config, x.config)) {
      const bc = before.config as Record<string, unknown>;
      const xc = x.config as Record<string, unknown>;
      let fields: string[];
      if (x.modality === 'editorial' && before.modality === 'editorial') {
        const names: Record<string, string> = { headline: 'titular', text: 'texto', imageUrl: 'imagen', buttonLabel: 'botón', link: 'enlace' };
        fields = Object.keys(names).filter((k) => !same(bc[k], xc[k])).map((k) => names[k]);
      } else if (x.modality === 'automatica' && before.modality === 'automatica') {
        const ra = (bc.rules ?? {}) as Record<string, unknown>;
        const rb = (xc.rules ?? {}) as Record<string, unknown>;
        fields = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter((k) => !same(ra[k], rb[k]));
      } else fields = ['configuración'];
      if (fields.length) out.push({ kind: 'config', blockId: x.id, title: x.title, detail: `Propiedades: ${fields.join(', ')}` });
    }
  }
  return out;
}

/* ───────────────────────── Comprobaciones previas a publicar ───────────────────────── */

export interface BlockingIssue {
  blockId: string;
  title: string;
  code: string;
  message: string;
}

/**
 * Errores BLOQUEANTES de la comprobación con datos actuales: cualquier incidencia de gravedad «error» en un bloque que el administrador quiere
 * ver (los bloques ocultos a propósito no bloquean). Los avisos nunca bloquean; se devuelven aparte para informar.
 */
export function splitIssues(blocks: readonly Block[], resolved: readonly ResolvedBlock[]): { blocking: BlockingIssue[]; warnings: BlockingIssue[] } {
  const wanted = new Map(blocks.map((b) => [b.id, b]));
  const blocking: BlockingIssue[] = [];
  const warnings: BlockingIssue[] = [];
  for (const rb of resolved) {
    const src = wanted.get(rb.id);
    if (!src) continue;
    for (const i of rb.issues as Issue[]) {
      const entry = { blockId: rb.id, title: rb.title, code: i.code, message: i.message };
      if (i.severity === 'error' && src.visible) blocking.push(entry);
      else if (i.severity === 'warning' || (i.severity === 'error' && !src.visible)) warnings.push(entry);
    }
  }
  return { blocking: blocking.slice(0, 50), warnings: warnings.slice(0, 50) };
}

/* ───────────────────────── Versiones ───────────────────────── */

export interface VersionSummary {
  version: number;
  publishedAt: string;
  blocks: number;
  state: 'published' | 'archived';
}

export function listVersions(doc: LayoutDocument): VersionSummary[] {
  const out: VersionSummary[] = [];
  if (doc.published) out.push({ version: doc.published.version, publishedAt: doc.published.publishedAt, blocks: doc.published.blocks.length, state: 'published' });
  for (const v of [...doc.versions].sort((x, y) => y.version - x.version)) out.push({ version: v.version, publishedAt: v.publishedAt, blocks: v.blocks.length, state: 'archived' });
  return out;
}

export function findVersion(doc: LayoutDocument, version: number): (PublishedLayout & { state: 'published' | 'archived' }) | null {
  if (doc.published?.version === version) return { ...doc.published, state: 'published' };
  const v = doc.versions.find((x) => x.version === version);
  return v ? { ...v, state: 'archived' } : null;
}

/** Siguiente número de versión: nunca reutiliza uno ya usado, tampoco el de una versión eliminada (`lastVersion`). */
export const nextVersionNumber = (doc: LayoutDocument): number => Math.max(0, doc.lastVersion ?? 0, doc.published?.version ?? 0, ...doc.versions.map((v) => v.version)) + 1;

/* ───────────────────────── Decisiones puras de publicar y recuperar ───────────────────────── */

export type PlanRefusal = {
  ok: false;
  reason:
    | 'peticion_invalida' | 'confirmacion_requerida' | 'archivo_protegido' | 'conflicto' | 'conflicto_publicada' | 'borrador_vacio' | 'sin_cambios'
    | 'referencias_bloqueantes' | 'limite_versiones' | 'version_no_encontrada' | 'documento_invalido';
  errors: string[];
  blocking?: BlockingIssue[];
  currentRevision?: string;
  currentPublished?: number | null;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (errors: string[]): PlanRefusal => ({ ok: false, reason: 'peticion_invalida', errors });
const protectedStatus = (s: string) => s === 'corrupt' || s === 'invalid' || s === 'newer';

export type PublishPlan = { ok: true; doc: LayoutDocument; version: number; publishedAt: string } | PlanRefusal;

/**
 * Decide si se puede PUBLICAR (internamente) el borrador guardado. No escribe.
 * Cuerpo esperado: { action:'publish', baseRevision, basePublished, confirm:true }.
 */
export function planPublish(read: { status: string; doc: LayoutDocument }, input: unknown, blocking: readonly BlockingIssue[], now: Date): PublishPlan {
  if (!isObj(input)) return bad(['El cuerpo debe ser un objeto']);
  const extra = Object.keys(input).filter((k) => !['action', 'baseRevision', 'basePublished', 'confirm'].includes(k));
  if (extra.length) return bad([`Campos no admitidos: ${extra.slice(0, 5).join(', ')}`]);
  if (typeof input.baseRevision !== 'string' || !input.baseRevision || input.baseRevision.length > 64) return bad(['baseRevision es obligatoria']);
  if (!(input.basePublished === null || (Number.isInteger(input.basePublished) && (input.basePublished as number) >= 1))) return bad(['basePublished debe ser null o el número de versión publicada que viste']);
  if (input.confirm !== true) return { ok: false, reason: 'confirmacion_requerida', errors: ['Publicar exige confirmación explícita (confirm: true)'] };
  if (protectedStatus(read.status)) return { ok: false, reason: 'archivo_protegido', errors: [`El almacenamiento está en estado «${read.status}»: se conserva sin sobrescribir`] };

  const doc = read.doc;
  const current = revisionOf(doc.draft.updatedAt);
  if (input.baseRevision !== current) return { ok: false, reason: 'conflicto', currentRevision: current, errors: ['El borrador cambió desde que lo viste'] };
  const published = doc.published?.version ?? null;
  if (input.basePublished !== published) return { ok: false, reason: 'conflicto_publicada', currentPublished: published, errors: ['La versión publicada cambió desde que la viste'] };
  if (doc.draft.updatedAt === null) return { ok: false, reason: 'borrador_vacio', errors: ['No hay ningún borrador guardado que publicar'] };
  if (doc.draft.blocks.length === 0) return { ok: false, reason: 'borrador_vacio', errors: ['El borrador no tiene bloques'] };
  const draft = validateBlocks(doc.draft.blocks, 'draft.blocks');
  if (!draft.ok) return { ok: false, reason: 'documento_invalido', errors: draft.errors.slice(0, 20) };
  if (blocking.length) return { ok: false, reason: 'referencias_bloqueantes', errors: ['Hay errores de referencias en bloques visibles'], blocking: blocking.slice(0, 50) };
  if (doc.published && same(doc.published.blocks, draft.value)) return { ok: false, reason: 'sin_cambios', errors: ['El borrador es idéntico a la versión publicada'] };
  const archivedAfter = doc.versions.length + (doc.published ? 1 : 0);
  if (archivedAfter > MAX_VERSIONS) return { ok: false, reason: 'limite_versiones', errors: [`Se alcanzó el máximo de ${MAX_VERSIONS} versiones archivadas; no se elimina ninguna automáticamente`] };

  const version = nextVersionNumber(doc);
  const publishedAt = now.toISOString();
  const next: LayoutDocument = {
    ...doc,
    published: { version, publishedAt, blocks: draft.value },
    versions: doc.published ? [doc.published, ...doc.versions] : [...doc.versions],
    lastVersion: version,
  };
  const full = validateDocument(next);
  if (!full.ok) return { ok: false, reason: 'documento_invalido', errors: full.errors.slice(0, 20) };
  return { ok: true, doc: full.value, version, publishedAt };
}

export type RestorePlan = { ok: true; doc: LayoutDocument; revision: string; version: number } | PlanRefusal;

/**
 * Decide si se puede RECUPERAR una versión como BORRADOR. Sustituye el borrador; NO toca la versión publicada ni el historial.
 * Cuerpo esperado: { action:'restore', baseRevision, version, confirm:true }.
 */
export function planRestore(read: { status: string; doc: LayoutDocument }, input: unknown, now: Date): RestorePlan {
  if (!isObj(input)) return bad(['El cuerpo debe ser un objeto']);
  const extra = Object.keys(input).filter((k) => !['action', 'baseRevision', 'version', 'confirm'].includes(k));
  if (extra.length) return bad([`Campos no admitidos: ${extra.slice(0, 5).join(', ')}`]);
  if (typeof input.baseRevision !== 'string' || !input.baseRevision || input.baseRevision.length > 64) return bad(['baseRevision es obligatoria']);
  if (!Number.isInteger(input.version) || (input.version as number) < 1) return bad(['version debe ser un entero ≥ 1']);
  if (input.confirm !== true) return { ok: false, reason: 'confirmacion_requerida', errors: ['Recuperar exige confirmación explícita (confirm: true)'] };
  if (protectedStatus(read.status)) return { ok: false, reason: 'archivo_protegido', errors: [`El almacenamiento está en estado «${read.status}»: se conserva sin sobrescribir`] };

  const doc = read.doc;
  const current = revisionOf(doc.draft.updatedAt);
  if (input.baseRevision !== current) return { ok: false, reason: 'conflicto', currentRevision: current, errors: ['El borrador cambió desde que lo viste'] };
  const v = findVersion(doc, input.version as number);
  if (!v) return { ok: false, reason: 'version_no_encontrada', errors: ['La versión indicada no existe'] };
  const blocks = validateBlocks(v.blocks, 'blocks');
  if (!blocks.ok) return { ok: false, reason: 'documento_invalido', errors: blocks.errors.slice(0, 20) };
  if (same(doc.draft.blocks, blocks.value)) return { ok: false, reason: 'sin_cambios', errors: ['El borrador ya es idéntico a esa versión'] };

  const prev = doc.draft.updatedAt ? Date.parse(doc.draft.updatedAt) : 0;
  const stamp = new Date(Math.max(now.getTime(), Number.isFinite(prev) ? prev + 1 : 0)).toISOString();
  const next: LayoutDocument = { ...doc, draft: { blocks: blocks.value, updatedAt: stamp } };
  const full = validateDocument(next);
  if (!full.ok) return { ok: false, reason: 'documento_invalido', errors: full.errors.slice(0, 20) };
  return { ok: true, doc: full.value, revision: stamp, version: v.version };
}
