/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · COPIAS DE SEGURIDAD DEL BORRADOR (funciones PURAS)
 * ==============================================================================
 * Antes de SUSTITUIR un borrador con contenido (cargar el nuevo diseño, recuperar una copia o una versión) se guarda una copia recuperable
 * en `home-layout-draft-backups.json` (volumen, no va a git, independiente de `home-layout.json`). Reglas:
 *  · Nunca se borra ni se reescribe una copia. Al llegar a `MAX_BACKUPS` se rechaza la operación (`limite_copias`): no se pierde nada.
 *  · Si el borrador ya está guardado en una copia idéntica (mismos bloques), no se duplica: se reutiliza esa copia.
 *  · Un borrador vacío no necesita copia.
 *  · Todo es puro: decide y devuelve los documentos nuevos; quien llama escribe PRIMERO las copias y DESPUÉS el borrador, de modo que un fallo
 *    a mitad deja, como mucho, una copia de más (nunca un borrador perdido).
 * ==============================================================================
 */

import type { Block, LayoutDocument } from './types';
import { nextStamp } from './activation';
import { revisionOf } from './draft';
import { validateBlocks } from './validate';
import { diffBlocks, type DiffEntry } from './publish';

export const BACKUPS_SCHEMA_VERSION = 1;
export const MAX_BACKUPS = 30;
export const MAX_BACKUPS_BODY_BYTES = 4 * 1024;

export const BACKUP_REASONS = ['antes_de_cargar_diseno', 'antes_de_recuperar_copia', 'antes_de_recuperar_version'] as const;
export type BackupReason = (typeof BACKUP_REASONS)[number];

export interface DraftBackup {
  id: string;
  createdAt: string;
  by: string;
  reason: BackupReason;
  /** `updatedAt` del borrador que se copió (null si nunca se guardó). */
  draftRevision: string | null;
  blocks: Block[];
}
export interface BackupsDocument {
  schemaVersion: number;
  backups: DraftBackup[];
}

export const emptyBackupsDocument = (): BackupsDocument => ({ schemaVersion: BACKUPS_SCHEMA_VERSION, backups: [] });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function validateBackupsDocument(raw: unknown): { ok: true; value: BackupsDocument } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ['El documento debe ser un objeto'] };
  if (raw.schemaVersion !== BACKUPS_SCHEMA_VERSION) return { ok: false, errors: ['schemaVersion no admitida'] };
  if (!Array.isArray(raw.backups)) return { ok: false, errors: ['backups debe ser una lista'] };
  if (raw.backups.length > MAX_BACKUPS) return { ok: false, errors: [`Máximo ${MAX_BACKUPS} copias`] };
  const out: DraftBackup[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < raw.backups.length; i++) {
    const b = raw.backups[i];
    if (!isObj(b)) return { ok: false, errors: [`backups[${i}] no es un objeto`] };
    if (typeof b.id !== 'string' || !/^c-[0-9a-z-]{4,40}$/.test(b.id) || ids.has(b.id)) return { ok: false, errors: [`backups[${i}].id no válido o repetido`] };
    ids.add(b.id);
    if (typeof b.createdAt !== 'string' || Number.isNaN(Date.parse(b.createdAt))) return { ok: false, errors: [`backups[${i}].createdAt no válido`] };
    if (typeof b.by !== 'string' || b.by.length > 80) return { ok: false, errors: [`backups[${i}].by no válido`] };
    if (!(BACKUP_REASONS as readonly unknown[]).includes(b.reason)) return { ok: false, errors: [`backups[${i}].reason no válido`] };
    if (b.draftRevision !== null && typeof b.draftRevision !== 'string') return { ok: false, errors: [`backups[${i}].draftRevision no válido`] };
    const blocks = validateBlocks(b.blocks, `backups[${i}].blocks`);
    if (!blocks.ok) return { ok: false, errors: blocks.errors.slice(0, 10) };
    out.push({ id: b.id, createdAt: b.createdAt, by: b.by, reason: b.reason as BackupReason, draftRevision: (b.draftRevision as string | null) ?? null, blocks: blocks.value });
  }
  return { ok: true, value: { schemaVersion: BACKUPS_SCHEMA_VERSION, backups: out } };
}

export interface BackupSummary {
  id: string;
  createdAt: string;
  by: string;
  reason: BackupReason;
  blocks: number;
  titles: string[];
}
export const summarizeBackups = (doc: BackupsDocument): BackupSummary[] =>
  [...doc.backups].reverse().map((b) => ({ id: b.id, createdAt: b.createdAt, by: b.by, reason: b.reason, blocks: b.blocks.length, titles: b.blocks.slice(0, 12).map((x) => x.title) }));

export const hasContent = (draft: LayoutDocument['draft']): boolean => draft.blocks.length > 0;

export type BackupRefusal = { ok: false; reason: 'limite_copias'; errors: string[] };
export type BackupStep = { ok: true; doc: BackupsDocument; id: string | null; created: boolean } | BackupRefusal;

/**
 * Protege el borrador actual antes de sustituirlo. `doc` devuelto = documento de copias a escribir (igual al actual si no hace falta añadir nada).
 * `id` = copia que lo contiene (null si el borrador está vacío).
 */
export function protectDraft(backups: BackupsDocument, draft: LayoutDocument['draft'], reason: BackupReason, now: Date, by: string): BackupStep {
  if (!hasContent(draft)) return { ok: true, doc: backups, id: null, created: false };
  const existing = backups.backups.find((b) => same(b.blocks, draft.blocks));
  if (existing) return { ok: true, doc: backups, id: existing.id, created: false };
  if (backups.backups.length >= MAX_BACKUPS) {
    return { ok: false, reason: 'limite_copias', errors: [`Hay ${MAX_BACKUPS} copias guardadas (el máximo): nunca se borran. Libera espacio antes de continuar (consulta con soporte).`] };
  }
  const id = `c-${now.getTime().toString(36)}-${(backups.backups.length + 1).toString(36)}`;
  const entry: DraftBackup = { id, createdAt: now.toISOString(), by: by.slice(0, 80), reason, draftRevision: draft.updatedAt, blocks: JSON.parse(JSON.stringify(draft.blocks)) as Block[] };
  return { ok: true, doc: { schemaVersion: BACKUPS_SCHEMA_VERSION, backups: [...backups.backups, entry] }, id, created: true };
}

export type RestoreBackupReason =
  | 'peticion_invalida' | 'confirmacion_requerida' | 'archivo_protegido' | 'conflicto' | 'copia_no_encontrada' | 'sin_cambios' | 'limite_copias' | 'documento_invalido';
export type RestoreBackupRefusal = { ok: false; reason: RestoreBackupReason; errors: string[]; currentRevision?: string };
export type RestoreBackupPlan = { ok: true; layout: LayoutDocument; backups: BackupsDocument; revision: string; protectedId: string | null; restoredId: string } | RestoreBackupRefusal;

const protectedStatus = (s: string) => s === 'corrupt' || s === 'invalid' || s === 'newer';

/**
 * Recuperar una copia como borrador. Cuerpo: { action:'restore', id, baseRevision, confirm:true }.
 * Protege antes el borrador actual (si tiene contenido y no está ya copiado). No toca versiones ni activación.
 */
export function planRestoreBackup(
  layout: { status: string; doc: LayoutDocument },
  backups: BackupsDocument,
  input: unknown,
  now: Date,
  by: string,
): RestoreBackupPlan {
  const bad = (errors: string[], reason: RestoreBackupReason = 'peticion_invalida'): RestoreBackupRefusal => ({ ok: false, reason, errors });
  if (!isObj(input)) return bad(['El cuerpo debe ser un objeto']);
  const extra = Object.keys(input).filter((k) => !['action', 'id', 'baseRevision', 'confirm'].includes(k));
  if (extra.length) return bad([`Campos no admitidos: ${extra.slice(0, 5).join(', ')}`]);
  if (input.action !== 'restore') return bad(['action debe ser restore']);
  if (typeof input.id !== 'string' || !input.id || input.id.length > 60) return bad(['id es obligatorio']);
  if (typeof input.baseRevision !== 'string' || !input.baseRevision || input.baseRevision.length > 64) return bad(['baseRevision es obligatoria']);
  if (input.confirm !== true) return bad(['Recuperar exige confirmación explícita (confirm: true)'], 'confirmacion_requerida');
  if (protectedStatus(layout.status)) return bad([`El almacenamiento está en estado «${layout.status}»: se conserva sin sobrescribir`], 'archivo_protegido');
  const current = revisionOf(layout.doc.draft.updatedAt);
  if (input.baseRevision !== current) return { ok: false, reason: 'conflicto', currentRevision: current, errors: ['El borrador cambió desde que lo viste'] };
  const target = backups.backups.find((b) => b.id === input.id);
  if (!target) return bad(['La copia indicada no existe'], 'copia_no_encontrada');
  if (same(layout.doc.draft.blocks, target.blocks)) return bad(['El borrador ya es idéntico a esa copia'], 'sin_cambios');
  const blocks = validateBlocks(target.blocks, 'blocks');
  if (!blocks.ok) return bad(blocks.errors.slice(0, 10), 'documento_invalido');

  const prot = protectDraft(backups, layout.doc.draft, 'antes_de_recuperar_copia', now, by);
  if (!prot.ok) return bad(prot.errors, 'limite_copias');
  const stamp = nextStamp(layout.doc.draft.updatedAt, now);
  return { ok: true, layout: { ...layout.doc, draft: { blocks: blocks.value, updatedAt: stamp } }, backups: prot.doc, revision: stamp, protectedId: prot.id, restoredId: target.id };
}

/** Diferencias para pasar del borrador actual a una copia (sólo lectura). */
export const diffBackupAgainstDraft = (draft: LayoutDocument['draft'], backup: DraftBackup): DiffEntry[] => diffBlocks(draft.blocks, backup.blocks);
