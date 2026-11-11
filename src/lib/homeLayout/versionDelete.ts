/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · ELIMINAR UNA VERSIÓN (decisión PURA)
 * ==============================================================================
 * Elimina de forma PERMANENTE una versión publicada internamente (la «publicada» o una archivada). Reglas:
 *  · Nunca la versión ACTIVA públicamente (`activation.active` y `pinnedVersion` = esa versión): la web no puede quedarse sin su portada.
 *  · No toca el borrador, las copias de seguridad, las historias, la activación ni las demás versiones; NO renumera: las restantes conservan su número.
 *  · El número eliminado no se reutiliza: `lastVersion` recuerda el más alto usado, así que la siguiente versión es `lastVersion + 1`.
 *  · Si se elimina la «publicada», la portada queda sin versión publicada (la siguiente publicación crea una nueva); el resto no cambia.
 *  · Control de concurrencia: exige la identidad de la versión que se vio (`publishedAt`), cuál era la publicada (`basePublished`) y la revisión de
 *    la activación (`baseActivation`). Si algo cambió → rechazo sin escribir.
 *  · La operación queda en el registro de operaciones (log de la activación) sin cambiar la revisión de la activación.
 * No escribe: devuelve los documentos nuevos; quien llama escribe PRIMERO el registro y DESPUÉS la portada.
 * ==============================================================================
 */

import type { LayoutDocument } from './types';
import { activationRevision, appendLog, type ActivationDocument } from './activation';
import { findVersion } from './publish';
import { validateDocument } from './validate';

export const MAX_DELETE_BODY_BYTES = 2 * 1024;

export type DeleteReason =
  | 'peticion_invalida' | 'confirmacion_requerida' | 'archivo_protegido' | 'activacion_protegida' | 'version_no_encontrada' | 'version_activa'
  | 'conflicto_version' | 'conflicto_publicada' | 'conflicto_activacion' | 'documento_invalido';
export type DeleteRefusal = { ok: false; reason: DeleteReason; errors: string[]; currentPublished?: number | null; currentRevision?: string };
export type DeletePlan = { ok: true; layout: LayoutDocument; activation: ActivationDocument; version: number; wasPublished: boolean; blocks: number } | DeleteRefusal;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const protectedStatus = (s: string) => s === 'corrupt' || s === 'invalid' || s === 'newer';

/** Cuerpo: { action:'delete', version, publishedAt, basePublished, baseActivation, confirm:true }. */
export function planDeleteVersion(
  layout: { status: string; doc: LayoutDocument },
  act: { status: string; doc: ActivationDocument },
  input: unknown,
  now: Date,
  by: string,
): DeletePlan {
  const bad = (errors: string[], reason: DeleteReason = 'peticion_invalida'): DeleteRefusal => ({ ok: false, reason, errors });
  if (!isObj(input)) return bad(['El cuerpo debe ser un objeto']);
  const extra = Object.keys(input).filter((k) => !['action', 'version', 'publishedAt', 'basePublished', 'baseActivation', 'confirm'].includes(k));
  if (extra.length) return bad([`Campos no admitidos: ${extra.slice(0, 5).join(', ')}`]);
  if (input.action !== 'delete') return bad(['action debe ser delete']);
  if (!Number.isInteger(input.version) || (input.version as number) < 1) return bad(['version debe ser un entero ≥ 1']);
  if (typeof input.publishedAt !== 'string' || !input.publishedAt || input.publishedAt.length > 40) return bad(['publishedAt es obligatorio']);
  if (!(input.basePublished === null || (Number.isInteger(input.basePublished) && (input.basePublished as number) >= 1))) return bad(['basePublished debe ser null o el número de versión publicada que viste']);
  if (typeof input.baseActivation !== 'string' || !input.baseActivation || input.baseActivation.length > 64) return bad(['baseActivation es obligatoria']);
  if (input.confirm !== true) return bad(['Eliminar exige confirmación explícita (confirm: true)'], 'confirmacion_requerida');
  if (protectedStatus(layout.status)) return bad([`El almacenamiento está en estado «${layout.status}»: se conserva sin sobrescribir`], 'archivo_protegido');
  if (protectedStatus(act.status)) return bad([`El archivo de activación está en estado «${act.status}»: se conserva sin sobrescribir`], 'activacion_protegida');

  const version = input.version as number;
  const doc = layout.doc;
  const found = findVersion(doc, version);
  if (!found) return bad(['La versión indicada no existe (puede que ya se haya eliminado)'], 'version_no_encontrada');
  if (found.publishedAt !== input.publishedAt) return bad(['La versión cambió desde que la viste'], 'conflicto_version');
  const published = doc.published?.version ?? null;
  if (input.basePublished !== published) return { ok: false, reason: 'conflicto_publicada', currentPublished: published, errors: ['La versión publicada cambió desde que la viste'] };
  const rev = activationRevision(act.doc);
  if (input.baseActivation !== rev) return { ok: false, reason: 'conflicto_activacion', currentRevision: rev, errors: ['La activación cambió desde que la viste'] };
  if (act.doc.active && act.doc.pinnedVersion === version) return bad([`La versión ${version} está activa públicamente: desactiva la portada nueva o activa otra versión antes de eliminarla`], 'version_activa');

  const wasPublished = doc.published?.version === version;
  const highest = Math.max(0, doc.lastVersion ?? 0, doc.published?.version ?? 0, ...doc.versions.map((v) => v.version));
  const next: LayoutDocument = {
    ...doc,
    published: wasPublished ? null : doc.published,
    versions: wasPublished ? [...doc.versions] : doc.versions.filter((v) => v.version !== version),
    lastVersion: highest,
  };
  const full = validateDocument(next);
  if (!full.ok) return bad(full.errors.slice(0, 10), 'documento_invalido');
  // Registro de operaciones: SIN cambiar `updatedAt` (la revisión de la activación sólo cambia cuando cambia su estado).
  const activation = appendLog(act.doc, {
    at: now.toISOString(),
    by: by.slice(0, 80),
    action: 'delete_version',
    version,
    result: 'ok',
    note: `${wasPublished ? 'publicada' : 'archivada'} · ${found.blocks.length} bloques · permanente`,
  });
  return { ok: true, layout: full.value, activation, version, wasPublished, blocks: found.blocks.length };
}
