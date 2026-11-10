/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · ALMACENAMIENTO (etapa 1)
 * ==============================================================================
 * `home-layout.json` vive en el volumen de datos (junto a los demás JSON; NO va a git) y es independiente de `sections.json`.
 *
 *  · LEER nunca escribe ni crea archivos y nunca lanza: devuelve el estado (`missing | ok | corrupt | invalid | newer`) y un documento
 *    vacío seguro cuando el archivo falta o no es válido.
 *  · ESCRIBIR valida el documento, lo guarda de forma ATÓMICA (archivo temporal + renombrado) y conserva la versión anterior en
 *    `home-layout.json.bak`. Si el archivo actual está corrupto o es de un esquema más nuevo, NO se sobrescribe: el original se conserva
 *    para diagnóstico y la escritura se rechaza.
 *  · RECUPERAR desde `.bak` es una acción explícita (no se ejecuta sola): antes de reemplazar un archivo corrupto guarda una copia
 *    `home-layout.corrupt-<fecha>.json`.
 *
 * Mecanismo de respaldo de la portada pública (etapa 6): `resolveHomeMode()` devuelve `layout` SOLO con los tres candados abiertos
 * (`HOME_LAYOUT_STAGE_ENABLED` del código, `HOME_LAYOUT_ENABLED=true` del entorno y la activación del administrador con una versión fijada
 * válida en `home-layout-activation.json`); ante cualquier error, ausencia o duda se vuelve a la portada actual.
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from '../paths';
import { SCHEMA_VERSION, type HomeMode, type LayoutDocument } from './types';
import { emptyDocument, validateDocument } from './validate';
import { selectActiveVersion, type ActivationDocument } from './activation';
import { readActivation } from './activationStore';

/**
 * Candado 1 de 3 (código). Etapa 6: el código de la portada nueva ya está integrado, así que el candado se abre; la portada NO se sirve
 * mientras falte cualquiera de los otros dos (`HOME_LAYOUT_ENABLED=true` en el servidor y la activación del administrador con versión fijada).
 */
export const HOME_LAYOUT_STAGE_ENABLED = true;

export type LayoutStatus = 'missing' | 'ok' | 'corrupt' | 'invalid' | 'newer';

export interface ReadResult {
  status: LayoutStatus;
  /** Documento utilizable: el leído si `ok`; uno vacío y seguro en cualquier otro caso. */
  doc: LayoutDocument;
  /** Motivos de invalidez (sin rutas ni datos sensibles). */
  errors: string[];
}

export const layoutFile = (): string => dataFile('home-layout.json');
export const backupFile = (): string => `${layoutFile()}.bak`;

function parse(text: string): { status: 'ok' | 'corrupt' | 'invalid' | 'newer'; doc?: LayoutDocument; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: 'corrupt', errors: ['El archivo no es JSON válido'] };
  }
  if (typeof raw === 'object' && raw !== null && typeof (raw as { schemaVersion?: unknown }).schemaVersion === 'number' && (raw as { schemaVersion: number }).schemaVersion > SCHEMA_VERSION) {
    return { status: 'newer', errors: ['El archivo es de un esquema más nuevo que esta versión'] };
  }
  const v = validateDocument(raw);
  return v.ok ? { status: 'ok', doc: v.value, errors: [] } : { status: 'invalid', errors: v.errors.slice(0, 20) };
}

/** Lee el estado actual. No escribe, no crea archivos y no lanza. */
export function readHomeLayout(): ReadResult {
  try {
    const file = layoutFile();
    if (!fs.existsSync(file)) return { status: 'missing', doc: emptyDocument(), errors: [] };
    const p = parse(fs.readFileSync(file, 'utf-8'));
    return p.status === 'ok' ? { status: 'ok', doc: p.doc as LayoutDocument, errors: [] } : { status: p.status, doc: emptyDocument(), errors: p.errors };
  } catch {
    return { status: 'corrupt', doc: emptyDocument(), errors: ['No se pudo leer el archivo'] };
  }
}

export type WriteResult = { ok: true } | { ok: false; reason: 'documento_invalido' | 'archivo_protegido' | 'error_escritura'; errors: string[] };

/**
 * Guarda el documento de forma atómica. Rechaza (sin tocar nada) si el documento no valida o si el archivo existente está corrupto,
 * no es válido o es de un esquema más nuevo: en esos casos el original se conserva para diagnóstico.
 */
export function writeHomeLayout(doc: unknown): WriteResult {
  const v = validateDocument(doc);
  if (!v.ok) return { ok: false, reason: 'documento_invalido', errors: v.errors.slice(0, 20) };
  const current = readHomeLayout();
  if (current.status === 'corrupt' || current.status === 'invalid' || current.status === 'newer') {
    return { ok: false, reason: 'archivo_protegido', errors: [`El archivo actual está en estado «${current.status}»: se conserva sin sobrescribir`] };
  }
  const file = layoutFile();
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(v.value, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(file)) fs.copyFileSync(file, backupFile());
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* limpieza best-effort */
    }
    return { ok: false, reason: 'error_escritura', errors: ['No se pudo guardar el archivo (el anterior sigue intacto)'] };
  }
}

export type RecoverResult = { ok: true; preservedCorrupt: boolean } | { ok: false; reason: 'sin_copia' | 'copia_invalida'; errors: string[] };

/**
 * Recupera el documento desde la copia `.bak` (acción EXPLÍCITA). Si el archivo actual existe y no es válido, guarda antes una copia
 * `home-layout.corrupt-<fecha>.json` para diagnóstico.
 */
export function recoverHomeLayoutFromBackup(): RecoverResult {
  const bak = backupFile();
  if (!fs.existsSync(bak)) return { ok: false, reason: 'sin_copia', errors: ['No hay copia de seguridad'] };
  let p: ReturnType<typeof parse>;
  try {
    p = parse(fs.readFileSync(bak, 'utf-8'));
  } catch {
    return { ok: false, reason: 'copia_invalida', errors: ['No se pudo leer la copia'] };
  }
  if (p.status !== 'ok' || !p.doc) return { ok: false, reason: 'copia_invalida', errors: p.errors };
  const file = layoutFile();
  let preserved = false;
  const current = readHomeLayout();
  if (fs.existsSync(file) && current.status !== 'ok' && current.status !== 'missing') {
    fs.copyFileSync(file, `${path.join(path.dirname(file), 'home-layout.corrupt-')}${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    preserved = true;
  }
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(p.doc, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return { ok: true, preservedCorrupt: preserved };
}

/**
 * Qué portada se sirve. Función pura (inyectable en pruebas): `layout` sólo si TODAS las condiciones se cumplen; cualquier otra cosa →
 * `legacy` (la portada actual).
 */
export function evaluateHomeMode(
  read: ReadResult,
  env: Record<string, string | undefined>,
  stageEnabled: boolean,
  /** Etapa 6: archivo de activación (versión fijada). Si se indica, la versión fijada manda sobre «la última publicada». */
  pin?: { status: string; doc: Pick<ActivationDocument, 'active' | 'pinnedVersion'> },
): HomeMode {
  try {
    if (!stageEnabled) return 'legacy';
    if (!envEnabled(env)) return 'legacy';
    if (read.status !== 'ok') return 'legacy';
    if (!read.doc.activation.enabled) return 'legacy';
    if (pin !== undefined) {
      if (pin.status !== 'ok') return 'legacy';
      return selectActiveVersion(read.doc, pin.doc) ? 'layout' : 'legacy';
    }
    if (!read.doc.published || read.doc.published.blocks.length === 0) return 'legacy';
    return 'layout';
  } catch {
    return 'legacy';
  }
}

/** Candado 2 de 3: `HOME_LAYOUT_ENABLED=true`. */
export const envEnabled = (env: Record<string, string | undefined>): boolean => String(env.HOME_LAYOUT_ENABLED ?? '').trim().toLowerCase() === 'true';

/** Portada que debe servirse hoy. Sin los tres candados (y sin entrada/E-S de disco si los dos primeros están cerrados) → `legacy`. */
export function resolveHomeMode(): HomeMode {
  try {
    if (!HOME_LAYOUT_STAGE_ENABLED || !envEnabled(process.env)) return 'legacy';
    return evaluateHomeMode(readHomeLayout(), process.env, HOME_LAYOUT_STAGE_ENABLED, readActivation());
  } catch {
    return 'legacy';
  }
}
