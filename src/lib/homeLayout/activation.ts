/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · ACTIVACIÓN Y DESACTIVACIÓN (etapa 6, funciones PURAS)
 * ==============================================================================
 * La portada nueva sólo se sirve si TODOS los candados lo permiten (ver `store.ts`):
 *   1. `HOME_LAYOUT_STAGE_ENABLED` (constante del código),
 *   2. `HOME_LAYOUT_ENABLED=true` (variable de entorno del servidor),
 *   3. `activation.enabled` de `home-layout.json` (interruptor del administrador) Y el archivo independiente
 *      `home-layout-activation.json` (`active` + versión FIJADA).
 * La versión pública queda FIJADA al activar: publicar otra versión interna NO cambia la web. Para cambiarla hay que volver a activar.
 *
 * Activar exige: confirmación explícita, control de concurrencia (revisión del archivo de activación que vio el administrador),
 * validación completa de la versión con los datos actuales (referencias, motor automático) y al menos un bloque visible.
 * Un bloque automático visible con «más recientes» sin fechas fiables BLOQUEA la activación (no se inventan fechas).
 * Desactivar es siempre posible, inmediato y registrado.
 *
 * Este módulo no toca disco ni red (funciones puras, inyectables en pruebas); la escritura la hace `activationStore.ts`.
 * ==============================================================================
 */

import type { Block, LayoutDocument, PublishedLayout } from './types';
import type { ResolvedBlock } from './resolve';
import { findVersion, splitIssues, type BlockingIssue } from './publish';
import { isPublicSafeExternalUrl, isPublicSafeImage, isPublicSafePath } from './publicSafety';

export const ACTIVATION_SCHEMA_VERSION = 1;
export const MAX_LOG_ENTRIES = 200;
export const MAX_ACTIVATION_BODY_BYTES = 2 * 1024;
export const INITIAL_REVISION = 'inicial';

export type ActivationAction = 'activate' | 'deactivate';
export interface ActivationLogEntry {
  at: string;
  by: string;
  action: ActivationAction;
  version: number | null;
  result: 'ok' | 'rechazada' | 'error';
  note?: string;
}
export interface ActivationDocument {
  schemaVersion: number;
  /** Segundo interruptor (independiente de `activation.enabled`): la portada nueva sólo se sirve con ambos. */
  active: boolean;
  /** Versión FIJADA que se sirve al público. */
  pinnedVersion: number | null;
  /** Revisión: cambia SOLO cuando cambia el estado (no con las entradas del registro). */
  updatedAt: string | null;
  log: ActivationLogEntry[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const emptyActivation = (): ActivationDocument => ({ schemaVersion: ACTIVATION_SCHEMA_VERSION, active: false, pinnedVersion: null, updatedAt: null, log: [] });
export const activationRevision = (d: { updatedAt: string | null }): string => d.updatedAt ?? INITIAL_REVISION;

export function validateActivationDocument(raw: unknown): { ok: true; value: ActivationDocument } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ['El documento de activación debe ser un objeto'] };
  const errors: string[] = [];
  const known = ['schemaVersion', 'active', 'pinnedVersion', 'updatedAt', 'log'];
  const extra = Object.keys(raw).filter((k) => !known.includes(k));
  if (extra.length) errors.push(`campos no admitidos (${extra.slice(0, 4).join(', ')})`);
  if (raw.schemaVersion !== ACTIVATION_SCHEMA_VERSION) errors.push(`schemaVersion: se esperaba ${ACTIVATION_SCHEMA_VERSION}`);
  if (typeof raw.active !== 'boolean') errors.push('active: debe ser verdadero o falso');
  const pv = raw.pinnedVersion;
  if (!(pv === null || (Number.isInteger(pv) && (pv as number) >= 1))) errors.push('pinnedVersion: debe ser null o un entero ≥ 1');
  if (raw.active === true && pv === null) errors.push('active sin versión fijada');
  const ua = raw.updatedAt;
  if (!(ua === null || (typeof ua === 'string' && Number.isFinite(Date.parse(ua))))) errors.push('updatedAt: fecha no válida');
  const log: ActivationLogEntry[] = [];
  if (!Array.isArray(raw.log)) errors.push('log: debe ser una lista');
  else {
    raw.log.slice(-MAX_LOG_ENTRIES).forEach((e, i) => {
      if (!isObj(e) || typeof e.at !== 'string' || typeof e.by !== 'string' || !['activate', 'deactivate'].includes(e.action as string) || !['ok', 'rechazada', 'error'].includes(e.result as string)) {
        errors.push(`log[${i}]: entrada no válida`);
        return;
      }
      const version = Number.isInteger(e.version) ? (e.version as number) : null;
      log.push({ at: e.at.slice(0, 40), by: e.by.slice(0, 80), action: e.action as ActivationAction, version, result: e.result as ActivationLogEntry['result'], ...(typeof e.note === 'string' ? { note: e.note.slice(0, 300) } : {}) });
    });
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  return { ok: true, value: { schemaVersion: ACTIVATION_SCHEMA_VERSION, active: raw.active as boolean, pinnedVersion: pv as number | null, updatedAt: ua as string | null, log } };
}

export function appendLog(doc: ActivationDocument, entry: ActivationLogEntry): ActivationDocument {
  return { ...doc, log: [...doc.log, entry].slice(-MAX_LOG_ENTRIES) };
}

/* ───────────────────────── Versión que se sirve ───────────────────────── */

/**
 * Versión FIJADA que debe servirse, o null (→ portada anterior). Exige: archivo de activación `active`, versión fijada existente
 * (publicada o archivada) y con al menos un bloque. NO usa «la última publicada»: publicar otra versión no cambia la web.
 */
export function selectActiveVersion(doc: LayoutDocument, act: Pick<ActivationDocument, 'active' | 'pinnedVersion'>): PublishedLayout | null {
  if (!act.active || act.pinnedVersion === null) return null;
  const v = findVersion(doc, act.pinnedVersion);
  if (!v || v.blocks.length === 0) return null;
  return { version: v.version, publishedAt: v.publishedAt, blocks: v.blocks };
}

/* ───────────────────────── Comprobación previa a activar ───────────────────────── */

export interface ActivationCheck {
  /** Errores que impiden activar. */
  blocking: BlockingIssue[];
  /** Avisos que se muestran en la confirmación. */
  warnings: BlockingIssue[];
  visibleBlocks: number;
  totalBlocks: number;
}

/** Bloques automáticos «recientes» sin fecha fiable, enlaces/imágenes editoriales inseguros y referencias rotas: lo que impide activar. */
export function checkForActivation(blocks: readonly Block[], resolved: readonly ResolvedBlock[]): ActivationCheck {
  const { blocking, warnings } = splitIssues(blocks, resolved);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  let visibleBlocks = 0;
  for (const rb of resolved) {
    const b = byId.get(rb.id);
    if (!b) continue;
    if (rb.visible === true) visibleBlocks++;
    if (!b.visible) continue;
    if (b.modality === 'automatica' && rb.selection?.status === 'no_ejecutable' && rb.selection.reason === 'recientes_sin_fecha_fiable') {
      blocking.push({
        blockId: b.id,
        title: b.title,
        code: 'recientes_sin_fecha_fiable',
        message: `${rb.selection.message ?? '«Más recientes» no se puede ejecutar: faltan fechas de alta fiables.'} Cambia el orden del bloque a «precio» desde el editor.`,
      });
      for (let i = warnings.length - 1; i >= 0; i--) if (warnings[i].blockId === b.id && warnings[i].code === 'auto_selection_not_executable') warnings.splice(i, 1);
    }
    const bl = b.link;
    if (bl && ((bl.type === 'path' && !isPublicSafePath(bl.target)) || (bl.type === 'url' && !isPublicSafeExternalUrl(bl.target)))) {
      blocking.push({ blockId: b.id, title: b.title, code: 'block_link_unsafe', message: 'El enlace «Ver todo» del bloque no es admisible (destino administrativo, peligroso o no https).' });
    }
    if (b.modality === 'editorial') {
      const cfg = b.config as { imageUrl?: string; imageUrl2?: string; link?: { type: string; target: string } };
      if (cfg.imageUrl2 && !isPublicSafeImage(cfg.imageUrl2)) blocking.push({ blockId: b.id, title: b.title, code: 'editorial_image_unsafe', message: 'La segunda imagen del bloque editorial no es admisible (formato no admitido o ruta peligrosa).' });
      if (cfg.imageUrl && !isPublicSafeImage(cfg.imageUrl)) blocking.push({ blockId: b.id, title: b.title, code: 'editorial_image_unsafe', message: 'La imagen del bloque editorial no es admisible (formato no admitido o ruta peligrosa).' });
      const l = cfg.link;
      if (l && ((l.type === 'path' && !isPublicSafePath(l.target)) || (l.type === 'url' && !isPublicSafeExternalUrl(l.target)))) {
        blocking.push({ blockId: b.id, title: b.title, code: 'editorial_link_unsafe', message: 'El enlace del bloque editorial no es admisible (destino administrativo, peligroso o no https).' });
      }
    }
  }
  if (visibleBlocks === 0) blocking.push({ blockId: '', title: 'Portada', code: 'sin_bloques_visibles', message: 'Ningún bloque de esta versión se mostraría: la portada nueva quedaría vacía.' });
  return { blocking: blocking.slice(0, 50), warnings: warnings.slice(0, 50), visibleBlocks, totalBlocks: blocks.length };
}

/* ───────────────────────── Decisiones puras ───────────────────────── */

export interface ActivationRefusal {
  ok: false;
  reason:
    | 'peticion_invalida' | 'confirmacion_requerida' | 'archivo_protegido' | 'activacion_protegida' | 'conflicto' | 'version_no_encontrada'
    | 'version_vacia' | 'referencias_bloqueantes' | 'sin_cambios' | 'documento_invalido';
  errors: string[];
  blocking?: BlockingIssue[];
  currentRevision?: string;
}
const bad = (errors: string[]): ActivationRefusal => ({ ok: false, reason: 'peticion_invalida', errors });
const isProtected = (s: string) => s === 'corrupt' || s === 'invalid' || s === 'newer';

export type ActivatePlan = { ok: true; doc: ActivationDocument; layout: LayoutDocument; version: number; warnings: BlockingIssue[] } | ActivationRefusal;

/** Estampa de revisión estrictamente creciente. */
export const nextStamp = (prev: string | null, now: Date): string => {
  const p = prev ? Date.parse(prev) : 0;
  return new Date(Math.max(now.getTime(), Number.isFinite(p) ? p + 1 : 0)).toISOString();
};

/**
 * Decide si se puede ACTIVAR una versión. Cuerpo: { action:'activate', version:number, baseRevision:string, confirm:true }.
 * `check` = comprobación con datos actuales de ESA versión (ver `checkForActivation`). No escribe.
 */
export function planActivate(
  layout: { status: string; doc: LayoutDocument },
  act: { status: string; doc: ActivationDocument },
  input: unknown,
  check: (blocks: readonly Block[]) => ActivationCheck,
  now: Date,
  by: string,
): ActivatePlan {
  if (!isObj(input)) return bad(['El cuerpo debe ser un objeto']);
  const extra = Object.keys(input).filter((k) => !['action', 'version', 'baseRevision', 'confirm'].includes(k));
  if (extra.length) return bad([`Campos no admitidos: ${extra.slice(0, 5).join(', ')}`]);
  if (!Number.isInteger(input.version) || (input.version as number) < 1) return bad(['version debe ser un entero ≥ 1']);
  if (typeof input.baseRevision !== 'string' || !input.baseRevision || input.baseRevision.length > 64) return bad(['baseRevision es obligatoria']);
  if (input.confirm !== true) return { ok: false, reason: 'confirmacion_requerida', errors: ['Activar exige confirmación explícita (confirm: true)'] };
  if (isProtected(layout.status)) return { ok: false, reason: 'archivo_protegido', errors: [`El almacenamiento de la portada está en estado «${layout.status}»: se conserva sin tocar`] };
  if (isProtected(act.status)) return { ok: false, reason: 'activacion_protegida', errors: [`El archivo de activación está en estado «${act.status}»: se conserva sin sobrescribir`] };
  const current = activationRevision(act.doc);
  if (input.baseRevision !== current) return { ok: false, reason: 'conflicto', currentRevision: current, errors: ['El estado de activación cambió desde que lo viste'] };

  const v = findVersion(layout.doc, input.version as number);
  if (!v) return { ok: false, reason: 'version_no_encontrada', errors: ['La versión indicada no existe'] };
  if (v.blocks.length === 0) return { ok: false, reason: 'version_vacia', errors: ['La versión no tiene bloques'] };
  const c = check(v.blocks);
  if (c.blocking.length) return { ok: false, reason: 'referencias_bloqueantes', errors: ['La versión no puede activarse: hay errores bloqueantes'], blocking: c.blocking };
  if (act.doc.active && layout.doc.activation.enabled && act.doc.pinnedVersion === v.version) return { ok: false, reason: 'sin_cambios', errors: [`La versión ${v.version} ya está activa`] };

  const stamp = nextStamp(act.doc.updatedAt, now);
  const nextAct = appendLog({ ...act.doc, active: true, pinnedVersion: v.version, updatedAt: stamp }, { at: now.toISOString(), by, action: 'activate', version: v.version, result: 'ok' });
  const nextLayout: LayoutDocument = { ...layout.doc, activation: { enabled: true } };
  return { ok: true, doc: nextAct, layout: nextLayout, version: v.version, warnings: c.warnings };
}

export type DeactivatePlan = { ok: true; doc: ActivationDocument; layout: LayoutDocument } | ActivationRefusal;

/**
 * Decide la DESACTIVACIÓN (siempre posible, también con el borrador bloqueado). Cuerpo: { action:'deactivate', confirm:true } (baseRevision opcional).
 * Desactivar ignora la revisión: parar la portada nueva nunca debe fallar por una carrera.
 */
export function planDeactivate(layout: { status: string; doc: LayoutDocument }, act: { status: string; doc: ActivationDocument }, input: unknown, now: Date, by: string): DeactivatePlan {
  if (!isObj(input)) return bad(['El cuerpo debe ser un objeto']);
  const extra = Object.keys(input).filter((k) => !['action', 'baseRevision', 'confirm'].includes(k));
  if (extra.length) return bad([`Campos no admitidos: ${extra.slice(0, 5).join(', ')}`]);
  if (input.baseRevision !== undefined && (typeof input.baseRevision !== 'string' || input.baseRevision.length > 64)) return bad(['baseRevision no válida']);
  if (input.confirm !== true) return { ok: false, reason: 'confirmacion_requerida', errors: ['Desactivar exige confirmación explícita (confirm: true)'] };
  const base = isProtected(act.status) ? emptyActivation() : act.doc;
  const stamp = nextStamp(base.updatedAt, now);
  const nextAct = appendLog({ ...base, active: false, updatedAt: stamp }, { at: now.toISOString(), by, action: 'deactivate', version: base.pinnedVersion, result: 'ok' });
  const nextLayout: LayoutDocument = { ...layout.doc, activation: { enabled: false } };
  return { ok: true, doc: nextAct, layout: nextLayout };
}
