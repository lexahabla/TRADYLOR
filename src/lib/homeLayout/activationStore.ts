/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · ALMACENAMIENTO DE LA ACTIVACIÓN (etapa 6)
 * ==============================================================================
 * `home-layout-activation.json` vive en el volumen (NO va a git) y es independiente de `home-layout.json`: guarda el segundo interruptor
 * (`active`), la versión FIJADA y el registro de operaciones, sin cambiar el contrato de `types.ts` / `validate.ts`.
 * Mismas garantías que `store.ts`: leer no escribe ni lanza; escribir es atómico (temporal + fsync + renombrado) con copia `.bak`; un archivo
 * corrupto, no válido o de esquema más nuevo NO se sobrescribe (y mientras tanto la web sirve la portada anterior).
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from '../paths';
import { ACTIVATION_SCHEMA_VERSION, emptyActivation, validateActivationDocument, type ActivationDocument } from './activation';

export const activationFile = (): string => dataFile('home-layout-activation.json');
export const activationBackupFile = (): string => `${activationFile()}.bak`;

export type ActivationStatus = 'missing' | 'ok' | 'corrupt' | 'invalid' | 'newer';
export interface ActivationRead {
  status: ActivationStatus;
  doc: ActivationDocument;
  errors: string[];
}

function parse(text: string): { status: 'ok' | 'corrupt' | 'invalid' | 'newer'; doc?: ActivationDocument; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: 'corrupt', errors: ['El archivo no es JSON válido'] };
  }
  if (typeof raw === 'object' && raw !== null && typeof (raw as { schemaVersion?: unknown }).schemaVersion === 'number' && (raw as { schemaVersion: number }).schemaVersion > ACTIVATION_SCHEMA_VERSION) {
    return { status: 'newer', errors: ['El archivo es de un esquema más nuevo que esta versión'] };
  }
  const v = validateActivationDocument(raw);
  return v.ok ? { status: 'ok', doc: v.value, errors: [] } : { status: 'invalid', errors: v.errors.slice(0, 20) };
}

/** Lee el estado. No escribe, no crea archivos y no lanza. */
export function readActivation(): ActivationRead {
  try {
    const file = activationFile();
    if (!fs.existsSync(file)) return { status: 'missing', doc: emptyActivation(), errors: [] };
    const p = parse(fs.readFileSync(file, 'utf-8'));
    return p.status === 'ok' ? { status: 'ok', doc: p.doc as ActivationDocument, errors: [] } : { status: p.status, doc: emptyActivation(), errors: p.errors };
  } catch {
    return { status: 'corrupt', doc: emptyActivation(), errors: ['No se pudo leer el archivo'] };
  }
}

export type ActivationWrite = { ok: true } | { ok: false; reason: 'documento_invalido' | 'archivo_protegido' | 'error_escritura'; errors: string[] };

/** Guarda de forma atómica; rechaza sin tocar nada si el documento no valida o el archivo existente está protegido. */
export function writeActivation(doc: unknown): ActivationWrite {
  const v = validateActivationDocument(doc);
  if (!v.ok) return { ok: false, reason: 'documento_invalido', errors: v.errors.slice(0, 20) };
  const current = readActivation();
  if (current.status === 'corrupt' || current.status === 'invalid' || current.status === 'newer') {
    return { ok: false, reason: 'archivo_protegido', errors: [`El archivo actual está en estado «${current.status}»: se conserva sin sobrescribir`] };
  }
  const file = activationFile();
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
    if (fs.existsSync(file)) fs.copyFileSync(file, activationBackupFile());
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
