/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · OPERACIONES SOBRE EL BORRADOR (etapa 3, funciones PURAS)
 * ==============================================================================
 * Sin acceso a disco ni a la red: se usa tanto en el servidor (API del borrador) como en el navegador (editor visual). Cada operación devuelve
 * una lista NUEVA de bloques; la validación estricta es la de `validate.ts` y se aplica siempre antes de guardar.
 *
 * CONTROL DE REVISIONES — la revisión del borrador es `draft.updatedAt` (el único metadato que se añade al guardar):
 *   · «inicial» = todavía no se ha guardado ningún borrador.
 *   · Un guardado debe enviar la revisión que cargó (`baseRevision`). Si ya no coincide con la del servidor (otra sesión guardó antes) se
 *     rechaza con `conflicto` y NO se sobrescribe nada.
 *   · La nueva revisión es siempre estrictamente posterior a la anterior (aunque dos guardados caigan en el mismo milisegundo).
 * Guardar sólo cambia `draft`; `activation`, `published` y `versions` se conservan tal cual. Nunca publica ni activa nada.
 * ==============================================================================
 */

import {
  CARD_KINDS,
  type Block,
  type CardKind,
  type ContentRef,
  type Format,
  type LayoutDocument,
  type Modality,
  type Width,
} from './types';
import { FORMAT_REGISTRY, MAX_BLOCKS, MODALITY_REGISTRY, validateBlocks, validateDocument } from './validate';

export const INITIAL_REVISION = 'inicial';
/** Tamaño máximo del cuerpo de un guardado (bytes). 60 bloques de 24 referencias caben con holgura. */
export const MAX_BODY_BYTES = 256 * 1024;

export const revisionOf = (updatedAt: string | null | undefined): string => (updatedAt ? updatedAt : INITIAL_REVISION);

/* ───────────────────────── Bloques nuevos ───────────────────────── */

/** Tarjetas admitidas por una modalidad. */
export const cardsFor = (modality: Modality): readonly CardKind[] => MODALITY_REGISTRY[modality].cards;

/** Máximo de elementos que admite un formato (la cuadrícula 2×2 muestra 4). */
export const maxItemsFor = (format: Format): number => FORMAT_REGISTRY[format].maxItems;

/** Identificador nuevo, único dentro del borrador y válido para el modelo. */
export function newBlockId(existing: readonly Block[], random: () => number = Math.random): string {
  const used = new Set(existing.map((b) => b.id));
  for (let i = 0; i < 50; i++) {
    const id = `b-${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`;
    if (!used.has(id)) return id;
  }
  let n = existing.length + 1;
  while (used.has(`b-${n}`)) n++;
  return `b-${n}`;
}

const defaultWidth = (format: Format): Width => (format === 'carrusel' ? 12 : 6);

/** Contenido inicial de una modalidad (la manual y la de sección empiezan sin referencias: hay que completarlas antes de guardar). */
export function defaultsFor(modality: Modality, format: Format): Pick<Block, 'card' | 'config' | 'refs'> {
  const card = cardsFor(modality)[0];
  if (modality === 'automatica') return { card, config: { rules: { order: 'recientes', limit: Math.min(8, maxItemsFor(format)) } }, refs: [] };
  if (modality === 'editorial') return { card, config: { headline: 'Nuevo titular' }, refs: [] };
  return { card, config: {}, refs: [] };
}

export function createBlock(modality: Modality, format: Format, existing: readonly Block[], random?: () => number): Block {
  return {
    id: newBlockId(existing, random),
    modality,
    format,
    width: defaultWidth(format),
    title: modality === 'editorial' ? 'Nueva campaña' : 'Nuevo bloque',
    visible: true,
    ...defaultsFor(modality, format),
  };
}

/* ───────────────────────── Operaciones (puras) ───────────────────────── */

const indexOf = (blocks: readonly Block[], id: string): number => blocks.findIndex((b) => b.id === id);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function addBlock(blocks: readonly Block[], block: Block, atIndex?: number): Block[] {
  if (blocks.length >= MAX_BLOCKS) return [...blocks];
  const out = clone(blocks) as Block[];
  out.splice(atIndex === undefined ? out.length : Math.max(0, Math.min(atIndex, out.length)), 0, clone(block));
  return out;
}

export function removeBlock(blocks: readonly Block[], id: string): Block[] {
  return clone(blocks.filter((b) => b.id !== id)) as Block[];
}

export function duplicateBlock(blocks: readonly Block[], id: string, random?: () => number): Block[] {
  const i = indexOf(blocks, id);
  if (i < 0 || blocks.length >= MAX_BLOCKS) return clone(blocks) as Block[];
  const copy = clone(blocks[i]) as Block;
  copy.id = newBlockId(blocks, random);
  copy.title = `${copy.title} (copia)`.slice(0, 120);
  return addBlock(blocks, copy, i + 1);
}

/** Mueve un bloque a una posición concreta (0-based). */
export function moveBlock(blocks: readonly Block[], id: string, toIndex: number): Block[] {
  const out = clone(blocks) as Block[];
  const from = indexOf(out, id);
  if (from < 0) return out;
  const [b] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(toIndex, out.length)), 0, b);
  return out;
}

/** Sube (-1) o baja (+1) un bloque (alternativa accesible al arrastre). */
export function moveBy(blocks: readonly Block[], id: string, delta: number): Block[] {
  const from = indexOf(blocks, id);
  return from < 0 ? (clone(blocks) as Block[]) : moveBlock(blocks, id, from + delta);
}

export function setWidth(blocks: readonly Block[], id: string, width: Width): Block[] {
  return updateBlock(blocks, id, { width });
}

export function updateBlock(blocks: readonly Block[], id: string, patch: Partial<Omit<Block, 'id'>>): Block[] {
  return blocks.map((b) => (b.id === id ? ({ ...clone(b), ...clone(patch) } as Block) : (clone(b) as Block)));
}

/** Cambia la modalidad: el contenido anterior no tiene sentido en la nueva, así que se reinicia (config, referencias y tarjeta). */
export function changeModality(blocks: readonly Block[], id: string, modality: Modality): Block[] {
  return blocks.map((b) => (b.id === id ? ({ ...clone(b), modality, ...defaultsFor(modality, b.format) } as Block) : (clone(b) as Block)));
}

/** Cambia el formato; si la nueva modalidad/formato admite menos elementos recorta las referencias manuales. */
export function changeFormat(blocks: readonly Block[], id: string, format: Format): Block[] {
  return blocks.map((b) => {
    if (b.id !== id) return clone(b) as Block;
    const next = { ...clone(b), format } as Block;
    const max = maxItemsFor(format);
    if (next.refs.length > max) next.refs = next.refs.slice(0, max);
    const rules = (next.config as { rules?: { limit: number } }).rules;
    if (rules && rules.limit > max) rules.limit = max;
    return next;
  });
}

export const hasRef = (b: Block, ref: ContentRef): boolean => b.refs.some((r) => r.kind === ref.kind && r.id === ref.id);

export function addRef(blocks: readonly Block[], id: string, ref: ContentRef): Block[] {
  return blocks.map((b) => {
    if (b.id !== id) return clone(b) as Block;
    const next = clone(b) as Block;
    if (!hasRef(next, ref) && next.refs.length < maxItemsFor(next.format)) next.refs.push({ kind: ref.kind, id: ref.id });
    return next;
  });
}

export function removeRef(blocks: readonly Block[], id: string, index: number): Block[] {
  return blocks.map((b) => {
    if (b.id !== id) return clone(b) as Block;
    const next = clone(b) as Block;
    next.refs.splice(index, 1);
    return next;
  });
}

export function moveRef(blocks: readonly Block[], id: string, index: number, delta: number): Block[] {
  return blocks.map((b) => {
    if (b.id !== id) return clone(b) as Block;
    const next = clone(b) as Block;
    const to = index + delta;
    if (index < 0 || index >= next.refs.length || to < 0 || to >= next.refs.length) return next;
    const [r] = next.refs.splice(index, 1);
    next.refs.splice(to, 0, r);
    return next;
  });
}

/** Tarjeta válida para la modalidad (si no lo es, la primera permitida). */
export const normalizeCard = (modality: Modality, card: CardKind): CardKind => (cardsFor(modality).includes(card) ? card : cardsFor(modality)[0]);
export const isCardKind = (v: unknown): v is CardKind => CARD_KINDS.includes(v as CardKind);

/* ───────────────────────── Guardado: decisión pura (la escritura la hace el servidor) ───────────────────────── */

export type SaveRefusal =
  | { ok: false; reason: 'peticion_invalida'; errors: string[] }
  | { ok: false; reason: 'archivo_protegido'; errors: string[] }
  | { ok: false; reason: 'conflicto'; currentRevision: string; errors: string[] }
  | { ok: false; reason: 'documento_invalido'; errors: string[] };

export type SavePlan = { ok: true; doc: LayoutDocument; revision: string } | SaveRefusal;

/**
 * Decide si un guardado procede y construye el documento resultante. NO escribe nada.
 * `read` es el estado leído del almacenamiento (`store.readHomeLayout()`).
 */
export function prepareDraftSave(read: { status: string; doc: LayoutDocument }, input: unknown, now: Date): SavePlan {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, reason: 'peticion_invalida', errors: ['El cuerpo debe ser un objeto'] };
  const body = input as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => k !== 'baseRevision' && k !== 'blocks');
  if (extra.length) return { ok: false, reason: 'peticion_invalida', errors: [`Campos no admitidos: ${extra.slice(0, 5).join(', ')}`] };
  if (typeof body.baseRevision !== 'string' || body.baseRevision.length === 0 || body.baseRevision.length > 64) return { ok: false, reason: 'peticion_invalida', errors: ['baseRevision es obligatoria'] };

  // Un archivo dañado, no válido o de un esquema más nuevo NUNCA se sobrescribe.
  if (read.status === 'corrupt' || read.status === 'invalid' || read.status === 'newer') {
    return { ok: false, reason: 'archivo_protegido', errors: [`El almacenamiento está en estado «${read.status}»: se conserva sin sobrescribir`] };
  }

  const current = revisionOf(read.doc.draft.updatedAt);
  if (body.baseRevision !== current) {
    return { ok: false, reason: 'conflicto', currentRevision: current, errors: ['El borrador cambió desde que lo cargaste (otra sesión lo guardó)'] };
  }

  const blocks = validateBlocks(body.blocks, 'blocks');
  if (!blocks.ok) return { ok: false, reason: 'documento_invalido', errors: blocks.errors.slice(0, 20) };

  const prev = read.doc.draft.updatedAt ? Date.parse(read.doc.draft.updatedAt) : 0;
  const stamp = new Date(Math.max(now.getTime(), Number.isFinite(prev) ? prev + 1 : 0)).toISOString();
  const doc: LayoutDocument = {
    ...read.doc,
    draft: { blocks: blocks.value, updatedAt: stamp },
  };
  const full = validateDocument(doc);
  if (!full.ok) return { ok: false, reason: 'documento_invalido', errors: full.errors.slice(0, 20) };
  return { ok: true, doc: full.value, revision: stamp };
}
