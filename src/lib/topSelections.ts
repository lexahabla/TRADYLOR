/**
 * ==============================================================================
 * TREIDILOR — MENÚ «TOP SELECCIONES» GESTIONADO A MANO (SOLO SERVIDOR)
 * ==============================================================================
 * El menú «Top Selecciones» del encabezado deja de depender de «todas las secciones publicadas» y pasa a ser una lista que el administrador
 * elige y ordena (`nav-top-sections.json`, volumen, no va a git). Es INDEPENDIENTE de `sections.json` (no se toca), del orden de la portada y de
 * la visibilidad de los bloques de la portada nueva; funciona igual con la portada de siempre y con la nueva.
 *
 *  · Sin archivo = modo AUTOMÁTICO (el comportamiento de siempre: todas las publicadas por `order`). Así el menú actual se conserva al desplegar.
 *  · Con archivo válido = modo MANUAL: sólo las secciones listadas, en ese orden. Crear una sección NO la añade (ver `ensureSnapshot`: la creación
 *    fija antes el menú vigente; si no se puede fijar, la sección no se crea).
 *  · LEER no escribe ni lanza. ESCRIBIR es atómico (temporal + fsync + renombrado) con `.bak`. Un archivo dañado / no válido / de esquema más nuevo NO
 *    se sobrescribe (se avisa y el menú vuelve al modo automático hasta recuperarlo).
 *  · Antes de enlazar una sección se comprueba que se RENDERIZA en la portada (`/`) del contexto actual: portada de siempre = publicada y con
 *    productos; portada nueva = la que realmente pinta el plan público. Las ids guardadas que no cumplen se omiten del menú (no se borran del archivo).
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from './paths';
import { readSections, type WebSection } from './sections';
import { getCatalogProducts } from './catalog';
import { buildPublicHome } from './homeLayout/public';

export const TOP_SCHEMA_VERSION = 1;
export const MAX_TOP_ITEMS = 30;
export const INITIAL_REVISION = 'inicial';
export const MAX_BODY_BYTES = 8 * 1024;

export interface TopItem {
  sectionId: string;
}
export interface TopDocument {
  schemaVersion: number;
  updatedAt: string | null;
  items: TopItem[];
}
export type TopStatus = 'missing' | 'ok' | 'corrupt' | 'invalid' | 'newer';
export interface TopRead {
  status: TopStatus;
  doc: TopDocument;
  errors: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ID_RE = /^[^\s<>"'`\\]{1,120}$/;
export const emptyTopDocument = (): TopDocument => ({ schemaVersion: TOP_SCHEMA_VERSION, updatedAt: null, items: [] });
export const revisionOf = (d: { updatedAt: string | null }): string => d.updatedAt ?? INITIAL_REVISION;
export const navFile = (): string => dataFile('nav-top-sections.json');
export const navBackupFile = (): string => `${navFile()}.bak`;

export function validateTopDocument(raw: unknown): { ok: true; value: TopDocument } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ['El documento debe ser un objeto'] };
  const errors: string[] = [];
  const extra = Object.keys(raw).filter((k) => !['schemaVersion', 'updatedAt', 'items'].includes(k));
  if (extra.length) errors.push(`campos no admitidos (${extra.slice(0, 4).join(', ')})`);
  if (raw.schemaVersion !== TOP_SCHEMA_VERSION) errors.push(`schemaVersion: se esperaba ${TOP_SCHEMA_VERSION}`);
  if (!(raw.updatedAt === null || (typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt))))) errors.push('updatedAt: fecha no válida');
  const items: TopItem[] = [];
  if (!Array.isArray(raw.items)) errors.push('items: debe ser una lista');
  else {
    if (raw.items.length > MAX_TOP_ITEMS) errors.push(`items: máximo ${MAX_TOP_ITEMS}`);
    const seen = new Set<string>();
    raw.items.slice(0, MAX_TOP_ITEMS + 1).forEach((it, i) => {
      if (!isObj(it) || typeof it.sectionId !== 'string' || !ID_RE.test(it.sectionId) || Object.keys(it).length !== 1) return void errors.push(`items[${i}]: no válido`);
      if (seen.has(it.sectionId)) return void errors.push(`items[${i}]: repetido (${it.sectionId})`);
      seen.add(it.sectionId);
      items.push({ sectionId: it.sectionId });
    });
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  return { ok: true, value: { schemaVersion: TOP_SCHEMA_VERSION, updatedAt: raw.updatedAt as string | null, items } };
}

function parse(text: string): { status: 'ok' | 'corrupt' | 'invalid' | 'newer'; doc?: TopDocument; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: 'corrupt', errors: ['El archivo no es JSON válido'] };
  }
  if (isObj(raw) && typeof raw.schemaVersion === 'number' && raw.schemaVersion > TOP_SCHEMA_VERSION) return { status: 'newer', errors: ['El archivo es de un esquema más nuevo que esta versión'] };
  const v = validateTopDocument(raw);
  return v.ok ? { status: 'ok', doc: v.value, errors: [] } : { status: 'invalid', errors: v.errors };
}

/** Lee el menú guardado. No escribe, no crea archivos y no lanza. */
export function readTopSelections(): TopRead {
  try {
    const file = navFile();
    if (!fs.existsSync(file)) return { status: 'missing', doc: emptyTopDocument(), errors: [] };
    const p = parse(fs.readFileSync(file, 'utf-8'));
    return p.status === 'ok' ? { status: 'ok', doc: p.doc as TopDocument, errors: [] } : { status: p.status, doc: emptyTopDocument(), errors: p.errors };
  } catch {
    return { status: 'corrupt', doc: emptyTopDocument(), errors: ['No se pudo leer el archivo'] };
  }
}

export type TopWrite = { ok: true } | { ok: false; reason: 'documento_invalido' | 'archivo_protegido' | 'error_escritura'; errors: string[] };

/** Guarda de forma atómica; rechaza sin tocar nada si no valida o si el archivo existente está protegido. */
export function writeTopSelections(doc: unknown): TopWrite {
  const v = validateTopDocument(doc);
  if (!v.ok) return { ok: false, reason: 'documento_invalido', errors: v.errors };
  const cur = readTopSelections();
  if (cur.status === 'corrupt' || cur.status === 'invalid' || cur.status === 'newer') return { ok: false, reason: 'archivo_protegido', errors: [`El archivo actual está en estado «${cur.status}»: se conserva sin sobrescribir`] };
  const file = navFile();
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
    if (fs.existsSync(file)) fs.copyFileSync(file, navBackupFile());
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

export type TopRecover = { ok: true; preservedCorrupt: boolean } | { ok: false; reason: 'sin_copia' | 'copia_invalida' | 'error_escritura'; errors: string[] };

/** Recupera el menú desde `.bak` (acción EXPLÍCITA). Antes guarda una copia del archivo dañado para diagnóstico. */
export function recoverTopSelections(): TopRecover {
  try {
    if (!fs.existsSync(navBackupFile())) return { ok: false, reason: 'sin_copia', errors: ['No hay copia de seguridad'] };
    const p = parse(fs.readFileSync(navBackupFile(), 'utf-8'));
    if (p.status !== 'ok' || !p.doc) return { ok: false, reason: 'copia_invalida', errors: p.errors };
    const file = navFile();
    let preserved = false;
    const cur = readTopSelections();
    if (fs.existsSync(file) && cur.status !== 'ok' && cur.status !== 'missing') {
      fs.copyFileSync(file, `${path.join(path.dirname(file), 'nav-top-sections.corrupt-')}${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
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
  } catch {
    return { ok: false, reason: 'error_escritura', errors: ['No se pudo recuperar la copia'] };
  }
}

/* ───────────────────────── Menú automático actual y «fijado» ───────────────────────── */

/** Lo que el menú mostraba SIEMPRE hasta ahora: las publicadas, por `order`. */
export const automaticMenu = (sections: readonly WebSection[]): WebSection[] => sections.filter((s) => s.published).sort((a, b) => a.order - b.order);

export type SnapshotResult = { ok: true; created: boolean } | { ok: false; reason: 'archivo_protegido' | 'error_escritura'; errors: string[] };

/**
 * Fija el menú vigente (las publicadas actuales, por `order`) SI todavía no hay configuración manual. Se llama ANTES de crear una sección: así la nueva
 * no entra sola en el menú. Con configuración manual válida no hace nada. Con archivo dañado devuelve error (el llamante NO debe crear la sección).
 */
export function ensureSnapshot(
  sections: readonly WebSection[] = readSections(),
  deps: { read?: () => TopRead; write?: (doc: unknown) => TopWrite; now?: () => Date } = {},
): SnapshotResult {
  const read = (deps.read ?? readTopSelections)();
  if (read.status === 'ok') return { ok: true, created: false };
  if (read.status !== 'missing') return { ok: false, reason: 'archivo_protegido', errors: [`El menú «Top Selecciones» está en estado «${read.status}»: recupéralo antes de crear secciones`] };
  const doc: TopDocument = { schemaVersion: TOP_SCHEMA_VERSION, updatedAt: (deps.now ?? (() => new Date()))().toISOString(), items: automaticMenu(sections).slice(0, MAX_TOP_ITEMS).map((s) => ({ sectionId: s.id })) };
  const w = (deps.write ?? writeTopSelections)(doc);
  return w.ok ? { ok: true, created: true } : { ok: false, reason: w.reason === 'archivo_protegido' ? 'archivo_protegido' : 'error_escritura', errors: w.errors };
}

/** Deshace una copia fija recién creada por `ensureSnapshot` (si la creación de la sección falla después). Sólo borra si el archivo es el que acabamos de crear. */
export function removeSnapshot(): boolean {
  try {
    const r = readTopSelections();
    if (r.status !== 'ok') return false;
    fs.unlinkSync(navFile());
    if (fs.existsSync(navBackupFile())) fs.unlinkSync(navBackupFile());
    return true;
  } catch {
    return false;
  }
}

/* ───────────────────────── Guardado (decisión pura) ───────────────────────── */

export type TopSavePlan =
  | { ok: true; doc: TopDocument; revision: string }
  | { ok: false; reason: 'peticion_invalida' | 'archivo_protegido' | 'conflicto' | 'documento_invalido'; errors: string[]; currentRevision?: string };

/** Cuerpo esperado: { baseRevision, items: string[] } (ids de sección, en el orden elegido). No escribe. */
export function planSave(read: { status: string; doc: TopDocument }, input: unknown, knownIds: ReadonlySet<string>, now: Date): TopSavePlan {
  if (!isObj(input)) return { ok: false, reason: 'peticion_invalida', errors: ['El cuerpo debe ser un objeto'] };
  const extra = Object.keys(input).filter((k) => k !== 'baseRevision' && k !== 'items');
  if (extra.length) return { ok: false, reason: 'peticion_invalida', errors: [`Campos no admitidos: ${extra.slice(0, 5).join(', ')}`] };
  if (typeof input.baseRevision !== 'string' || !input.baseRevision || input.baseRevision.length > 64) return { ok: false, reason: 'peticion_invalida', errors: ['baseRevision es obligatoria'] };
  if (!Array.isArray(input.items) || input.items.some((x) => typeof x !== 'string')) return { ok: false, reason: 'peticion_invalida', errors: ['items debe ser una lista de ids de sección'] };
  if (read.status === 'corrupt' || read.status === 'invalid' || read.status === 'newer') return { ok: false, reason: 'archivo_protegido', errors: [`El archivo del menú está en estado «${read.status}»: se conserva sin sobrescribir`] };
  const current = revisionOf(read.doc);
  if (input.baseRevision !== current) return { ok: false, reason: 'conflicto', currentRevision: current, errors: ['El menú cambió desde que lo cargaste (otra sesión lo guardó)'] };
  const ids = input.items as string[];
  const errors: string[] = [];
  if (ids.length > MAX_TOP_ITEMS) errors.push(`Máximo ${MAX_TOP_ITEMS} secciones en el menú`);
  if (new Set(ids).size !== ids.length) errors.push('Hay secciones repetidas');
  const unknown = ids.filter((id) => !knownIds.has(id));
  if (unknown.length) errors.push(`Secciones que no existen: ${unknown.slice(0, 3).join(', ')}`);
  if (errors.length) return { ok: false, reason: 'documento_invalido', errors };
  const prev = read.doc.updatedAt ? Date.parse(read.doc.updatedAt) : 0;
  const stamp = new Date(Math.max(now.getTime(), Number.isFinite(prev) ? prev + 1 : 0)).toISOString();
  const full = validateTopDocument({ schemaVersion: TOP_SCHEMA_VERSION, updatedAt: stamp, items: ids.map((sectionId) => ({ sectionId })) });
  if (!full.ok) return { ok: false, reason: 'documento_invalido', errors: full.errors };
  return { ok: true, doc: full.value, revision: stamp };
}

/* ───────────────────────── Qué se renderiza realmente en la portada ───────────────────────── */

export type SkipReason = 'no_existe' | 'no_publicada' | 'sin_productos' | 'no_se_muestra_en_la_portada_nueva';
export interface RenderContext {
  /** Portada que se sirve hoy en `/`. */
  mode: 'legacy' | 'layout';
  /** Ids de sección cuyo ancla `#section-<id>` existe en `/`. */
  rendered: Set<string>;
}

/**
 * Secciones cuyo ancla existe en la portada `/` (el destino real de los enlaces `/#section-<id>` desde cualquier página, con o sin filtros en la
 * página de origen). Portada de siempre: publicadas con al menos un producto existente. Portada nueva: las que pinta el plan público (que respeta
 * bloques ocultos, secciones no referenciadas, etc.). Nunca lanza.
 */
export function homeRenderContext(sections: readonly WebSection[] = readSections(), planFn: () => ReturnType<typeof buildPublicHome> = buildPublicHome): RenderContext {
  try {
    const ids = new Set((getCatalogProducts() as Array<{ id?: string }>).map((p) => p.id).filter((x): x is string => typeof x === 'string'));
    const legacy = new Set(sections.filter((s) => s.published && s.productIds.some((id) => ids.has(id))).map((s) => s.id));
    const plan = planFn();
    if (plan.mode === 'layout') {
      const fromPlan = new Set<string>();
      for (const b of [...plan.top, ...plan.bottom]) if (b.section) fromPlan.add(b.section.id);
      return { mode: 'layout', rendered: fromPlan };
    }
    return { mode: 'legacy', rendered: legacy };
  } catch {
    return { mode: 'legacy', rendered: new Set(sections.filter((s) => s.published && s.productIds.length > 0).map((s) => s.id)) };
  }
}

export interface NavResolution {
  mode: 'automatico' | 'manual';
  storage: TopStatus;
  /** Secciones que se enlazan, en orden. */
  items: WebSection[];
  /** Ids guardadas que no se enlazan, y por qué (no se modifica lo guardado). */
  skipped: Array<{ id: string; reason: SkipReason }>;
}

/** Resolución pura del menú. */
export function resolveNav(sections: readonly WebSection[], read: { status: string; doc: TopDocument }, ctx: RenderContext): NavResolution {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const storage = read.status as TopStatus;
  if (storage !== 'ok') {
    // Automático (= comportamiento de siempre) pero sin enlaces a anclas inexistentes.
    const auto = automaticMenu(sections);
    return { mode: 'automatico', storage, items: auto.filter((s) => ctx.rendered.has(s.id)), skipped: auto.filter((s) => !ctx.rendered.has(s.id)).map((s) => ({ id: s.id, reason: ctx.mode === 'layout' ? 'no_se_muestra_en_la_portada_nueva' : 'sin_productos' })) };
  }
  const items: WebSection[] = [];
  const skipped: NavResolution['skipped'] = [];
  const seen = new Set<string>();
  for (const { sectionId } of read.doc.items) {
    if (seen.has(sectionId)) continue;
    seen.add(sectionId);
    const s = byId.get(sectionId);
    if (!s) skipped.push({ id: sectionId, reason: 'no_existe' });
    else if (!s.published) skipped.push({ id: sectionId, reason: 'no_publicada' });
    else if (!ctx.rendered.has(sectionId)) skipped.push({ id: sectionId, reason: ctx.mode === 'layout' ? 'no_se_muestra_en_la_portada_nueva' : 'sin_productos' });
    else items.push(s);
  }
  return { mode: 'manual', storage, items, skipped };
}

/** Menú para el encabezado. Nunca lanza: ante cualquier fallo, el comportamiento de siempre. */
export function resolveTopSelectionsNav(): NavResolution {
  try {
    const sections = readSections() || [];
    return resolveNav(sections, readTopSelections(), homeRenderContext(sections));
  } catch {
    let sections: WebSection[] = [];
    try {
      sections = readSections() || [];
    } catch {
      /* sin secciones */
    }
    return { mode: 'automatico', storage: 'corrupt', items: automaticMenu(sections), skipped: [] };
  }
}
