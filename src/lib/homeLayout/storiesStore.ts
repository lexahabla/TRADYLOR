/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · ALMACENAMIENTO DE HISTORIAS (etapa 5)
 * ==============================================================================
 * `home-stories.json` vive en el volumen de datos (NO va a git) y es independiente de `home-layout.json` y de `sections.json`. Mismas
 * garantías que `store.ts`:
 *  · LEER nunca escribe ni crea archivos y nunca lanza: devuelve el estado (`missing | ok | corrupt | invalid | newer`) y un documento vacío
 *    seguro cuando el archivo falta o no es válido.
 *  · ESCRIBIR valida el documento, lo guarda de forma ATÓMICA (temporal + fsync + renombrado) y conserva la versión anterior en
 *    `home-stories.json.bak`. Un archivo corrupto, no válido o de un esquema más nuevo NO se sobrescribe.
 * Las historias no se muestran en la web pública: la integración pertenece a la etapa 6.
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from '../paths';
import { STORIES_SCHEMA_VERSION, emptyStoriesDocument, validateStoriesDocument, type StoriesDocument } from './stories';

export const storiesFile = (): string => dataFile('home-stories.json');
export const storiesBackupFile = (): string => `${storiesFile()}.bak`;

export type StoriesStatus = 'missing' | 'ok' | 'corrupt' | 'invalid' | 'newer';
export interface StoriesRead {
  status: StoriesStatus;
  doc: StoriesDocument;
  errors: string[];
}

function parse(text: string): { status: 'ok' | 'corrupt' | 'invalid' | 'newer'; doc?: StoriesDocument; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: 'corrupt', errors: ['El archivo no es JSON válido'] };
  }
  if (typeof raw === 'object' && raw !== null && typeof (raw as { schemaVersion?: unknown }).schemaVersion === 'number' && (raw as { schemaVersion: number }).schemaVersion > STORIES_SCHEMA_VERSION) {
    return { status: 'newer', errors: ['El archivo es de un esquema más nuevo que esta versión'] };
  }
  const v = validateStoriesDocument(raw);
  return v.ok ? { status: 'ok', doc: v.value, errors: [] } : { status: 'invalid', errors: v.errors.slice(0, 20) };
}

/** Lee el estado actual. No escribe, no crea archivos y no lanza. */
export function readStories(): StoriesRead {
  try {
    const file = storiesFile();
    if (!fs.existsSync(file)) return { status: 'missing', doc: emptyStoriesDocument(), errors: [] };
    const p = parse(fs.readFileSync(file, 'utf-8'));
    return p.status === 'ok' ? { status: 'ok', doc: p.doc as StoriesDocument, errors: [] } : { status: p.status, doc: emptyStoriesDocument(), errors: p.errors };
  } catch {
    return { status: 'corrupt', doc: emptyStoriesDocument(), errors: ['No se pudo leer el archivo'] };
  }
}

export type StoriesWrite = { ok: true } | { ok: false; reason: 'documento_invalido' | 'archivo_protegido' | 'error_escritura'; errors: string[] };

/** Guarda el documento de forma atómica; rechaza sin tocar nada si no valida o si el archivo existente está protegido. */
export function writeStories(doc: unknown): StoriesWrite {
  const v = validateStoriesDocument(doc);
  if (!v.ok) return { ok: false, reason: 'documento_invalido', errors: v.errors.slice(0, 20) };
  const current = readStories();
  if (current.status === 'corrupt' || current.status === 'invalid' || current.status === 'newer') {
    return { ok: false, reason: 'archivo_protegido', errors: [`El archivo actual está en estado «${current.status}»: se conserva sin sobrescribir`] };
  }
  const file = storiesFile();
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
    if (fs.existsSync(file)) fs.copyFileSync(file, storiesBackupFile());
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
