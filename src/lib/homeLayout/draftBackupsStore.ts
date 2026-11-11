/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · ALMACENAMIENTO DE LAS COPIAS DEL BORRADOR
 * ==============================================================================
 * `home-layout-draft-backups.json` (volumen, NO va a git). Mismas garantías que `store.ts`: leer nunca escribe ni lanza; escribir valida, guarda de
 * forma atómica (temporal + fsync + renombrado) y conserva el anterior en `.bak`; un archivo corrupto, inválido o de un esquema más nuevo NO se
 * sobrescribe (la operación que lo necesita se rechaza sin tocar nada).
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from '../paths';
import { BACKUPS_SCHEMA_VERSION, emptyBackupsDocument, validateBackupsDocument, type BackupsDocument } from './draftBackups';

export const backupsFile = (): string => dataFile('home-layout-draft-backups.json');
export const backupsBackupFile = (): string => `${backupsFile()}.bak`;

export type BackupsStatus = 'missing' | 'ok' | 'corrupt' | 'invalid' | 'newer';
export interface BackupsRead {
  status: BackupsStatus;
  doc: BackupsDocument;
  errors: string[];
}

/** Lee el estado actual. No escribe, no crea archivos y no lanza. */
export function readDraftBackups(): BackupsRead {
  try {
    const file = backupsFile();
    if (!fs.existsSync(file)) return { status: 'missing', doc: emptyBackupsDocument(), errors: [] };
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return { status: 'corrupt', doc: emptyBackupsDocument(), errors: ['El archivo no es JSON válido'] };
    }
    if (typeof raw === 'object' && raw !== null && typeof (raw as { schemaVersion?: unknown }).schemaVersion === 'number' && (raw as { schemaVersion: number }).schemaVersion > BACKUPS_SCHEMA_VERSION) {
      return { status: 'newer', doc: emptyBackupsDocument(), errors: ['El archivo es de un esquema más nuevo que esta versión'] };
    }
    const v = validateBackupsDocument(raw);
    return v.ok ? { status: 'ok', doc: v.value, errors: [] } : { status: 'invalid', doc: emptyBackupsDocument(), errors: v.errors.slice(0, 20) };
  } catch {
    return { status: 'corrupt', doc: emptyBackupsDocument(), errors: ['No se pudo leer el archivo'] };
  }
}

export const backupsProtected = (s: BackupsStatus): boolean => s === 'corrupt' || s === 'invalid' || s === 'newer';

export type BackupsWrite = { ok: true } | { ok: false; reason: 'documento_invalido' | 'archivo_protegido' | 'error_escritura'; errors: string[] };

/** Guarda el documento de forma atómica; rechaza sin tocar nada si no valida o si el archivo existente está protegido. */
export function writeDraftBackups(doc: unknown): BackupsWrite {
  const v = validateBackupsDocument(doc);
  if (!v.ok) return { ok: false, reason: 'documento_invalido', errors: v.errors.slice(0, 20) };
  const current = readDraftBackups();
  if (backupsProtected(current.status)) return { ok: false, reason: 'archivo_protegido', errors: [`El archivo de copias está en estado «${current.status}»: se conserva sin sobrescribir`] };
  const file = backupsFile();
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
    if (fs.existsSync(file)) fs.copyFileSync(file, backupsBackupFile());
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
