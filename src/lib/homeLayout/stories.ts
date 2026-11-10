/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · HISTORIAS (etapa 5, funciones PURAS; válido en servidor y navegador)
 * ==============================================================================
 * Las historias son propias de Treidilor (sin Instagram) y viven en `home-stories.json`, un archivo independiente de `home-layout.json`:
 * el contrato de la portada (`types.ts`, `validate.ts`, `store.ts`) no cambia. Modelo, según la maqueta v3 (pestaña C):
 *   Historia  = id, nombre, estado (borrador | publicada internamente) y 1-10 pantallas. La portada de la historia es la imagen de su 1.ª pantalla.
 *   Pantalla  = imagen vertical (9:16), texto principal, texto secundario, botón (texto + destino) y duración (5, 7 o 10 s).
 *   Destino   = producto, categoría o campaña (ruta propia). Se REFERENCIA por id; nunca se copian datos del catálogo.
 * Un único borrador con control de revisión (`draft.updatedAt`, «inicial» si no hay) y estado por historia; no hay historial de versiones.
 * «Publicada» es INTERNO: no aparece en la web pública (la integración es de la etapa 6).
 *
 * Límites: ≤ 20 historias, ≤ 10 pantallas por historia, documento ≤ 128 KiB. Las imágenes se guardan aparte (sistema de subida existente).
 * Una historia con errores bloqueantes NO puede pasar a «publicada» (ver `blockingErrors`); en borrador puede tener errores.
 * ==============================================================================
 */

import { isSafeImageUrl } from './validate';
import type { ReferenceSources } from './sources';

export const STORIES_SCHEMA_VERSION = 1;
export const MAX_STORIES = 20;
export const MAX_SCREENS = 10;
export const MAX_STORIES_BYTES = 128 * 1024;
export const DURATIONS = [5, 7, 10] as const;
export type Duration = (typeof DURATIONS)[number];
export const STORY_STATUSES = ['borrador', 'publicada'] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];
export const STORY_LINK_TYPES = ['product', 'category', 'campaign'] as const;
export type StoryLinkType = (typeof STORY_LINK_TYPES)[number];
export const INITIAL_REVISION = 'inicial';

export interface StoryLink {
  type: StoryLinkType;
  target: string;
}
export interface StoryScreen {
  id: string;
  image: string;
  title: string;
  text?: string;
  buttonLabel?: string;
  link?: StoryLink;
  duration: Duration;
}
export interface Story {
  id: string;
  name: string;
  status: StoryStatus;
  screens: StoryScreen[];
}
export interface StoriesDocument {
  schemaVersion: number;
  draft: { stories: Story[]; updatedAt: string | null };
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TARGET_ID = /^[^\s<>"'`\\]{1,120}$/;
export const revisionOf = (updatedAt: string | null | undefined): string => (updatedAt ? updatedAt : INITIAL_REVISION);
export const emptyStoriesDocument = (): StoriesDocument => ({ schemaVersion: STORIES_SCHEMA_VERSION, draft: { stories: [], updatedAt: null } });

/** Ruta propia de una campaña: empieza por «/», sin «//», sin «..», sin espacios ni caracteres de control. */
export const isSafeCampaignPath = (u: string): boolean => u.length > 0 && u.length <= 300 && u.startsWith('/') && !u.startsWith('//') && !u.includes('..') && !/[\s<>"'`\\\u0000-\u001f]/.test(u);

/* ───────────────────────── Validación estructural (rechaza el guardado) ───────────────────────── */

function text(raw: unknown, path: string, max: number, errors: string[], opts: { required?: boolean } = {}): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (opts.required) errors.push(`${path}: es obligatorio`);
    return undefined;
  }
  if (typeof raw !== 'string') { errors.push(`${path}: debe ser texto`); return undefined; }
  const t = raw.trim();
  if (!t && opts.required) { errors.push(`${path}: es obligatorio`); return undefined; }
  if (t.length > max) { errors.push(`${path}: máximo ${max} caracteres`); return undefined; }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t)) { errors.push(`${path}: caracteres no permitidos`); return undefined; }
  return t || undefined;
}
function onlyKeys(o: Record<string, unknown>, allowed: string[], path: string, errors: string[]) {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) errors.push(`${path}: campos no admitidos (${extra.slice(0, 4).join(', ')})`);
}

function parseScreen(raw: unknown, path: string, errors: string[]): StoryScreen | null {
  if (!isObj(raw)) { errors.push(`${path}: pantalla no válida`); return null; }
  onlyKeys(raw, ['id', 'image', 'title', 'text', 'buttonLabel', 'link', 'duration'], path, errors);
  const id = typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : (errors.push(`${path}.id: identificador no válido`), '');
  const image = typeof raw.image === 'string' && isSafeImageUrl(raw.image) ? raw.image : (errors.push(`${path}.image: imagen obligatoria (ruta propia «/…» o URL https)`), '');
  const title = text(raw.title, `${path}.title`, 80, errors) ?? '';
  const body = text(raw.text, `${path}.text`, 200, errors);
  const buttonLabel = text(raw.buttonLabel, `${path}.buttonLabel`, 40, errors);
  const duration = (DURATIONS as readonly unknown[]).includes(raw.duration) ? (raw.duration as Duration) : (errors.push(`${path}.duration: debe ser 5, 7 o 10`), 5);
  let link: StoryLink | undefined;
  if (raw.link !== undefined) {
    if (!isObj(raw.link)) errors.push(`${path}.link: enlace no válido`);
    else {
      onlyKeys(raw.link, ['type', 'target'], `${path}.link`, errors);
      const type = raw.link.type;
      const target = raw.link.target;
      if (!(STORY_LINK_TYPES as readonly unknown[]).includes(type)) errors.push(`${path}.link.type: tipo no válido`);
      else if (typeof target !== 'string' || !target) errors.push(`${path}.link.target: elige un destino`);
      else if (type === 'campaign' ? !isSafeCampaignPath(target) : !TARGET_ID.test(target)) errors.push(`${path}.link.target: destino no válido`);
      else link = { type: type as StoryLinkType, target };
    }
  }
  const out: StoryScreen = { id, image, title, duration };
  if (body) out.text = body;
  if (buttonLabel) out.buttonLabel = buttonLabel;
  if (link) out.link = link;
  return out;
}

export function validateStories(raw: unknown, path = 'stories'): Result<Story[]> {
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { ok: false, errors: [`${path}: debe ser una lista`] };
  if (raw.length > MAX_STORIES) errors.push(`${path}: máximo ${MAX_STORIES} historias`);
  const ids = new Set<string>();
  const out: Story[] = [];
  raw.slice(0, MAX_STORIES + 1).forEach((s, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(s)) { errors.push(`${p}: historia no válida`); return; }
    onlyKeys(s, ['id', 'name', 'status', 'screens'], p, errors);
    const id = typeof s.id === 'string' && ID.test(s.id) ? s.id : (errors.push(`${p}.id: identificador no válido`), '');
    if (id && ids.has(id)) errors.push(`${p}.id: repetido (${id})`);
    ids.add(id);
    const name = text(s.name, `${p}.name`, 60, errors, { required: true }) ?? '';
    const status = (STORY_STATUSES as readonly unknown[]).includes(s.status) ? (s.status as StoryStatus) : (errors.push(`${p}.status: debe ser borrador o publicada`), 'borrador');
    const screens: StoryScreen[] = [];
    if (!Array.isArray(s.screens) || s.screens.length < 1) errors.push(`${p}.screens: una historia necesita al menos una pantalla`);
    else if (s.screens.length > MAX_SCREENS) errors.push(`${p}.screens: máximo ${MAX_SCREENS} pantallas`);
    else {
      const sid = new Set<string>();
      s.screens.forEach((x, j) => {
        const sc = parseScreen(x, `${p}.screens[${j}]`, errors);
        if (sc) {
          if (sc.id && sid.has(sc.id)) errors.push(`${p}.screens[${j}].id: repetido (${sc.id})`);
          sid.add(sc.id);
          screens.push(sc);
        }
      });
    }
    out.push({ id, name, status, screens });
  });
  return errors.length ? { ok: false, errors: errors.slice(0, 30) } : { ok: true, value: out };
}

export function validateStoriesDocument(raw: unknown): Result<StoriesDocument> {
  if (!isObj(raw)) return { ok: false, errors: ['El documento de historias debe ser un objeto'] };
  const errors: string[] = [];
  onlyKeys(raw, ['schemaVersion', 'draft'], 'documento', errors);
  if (raw.schemaVersion !== STORIES_SCHEMA_VERSION) errors.push(`schemaVersion: se esperaba ${STORIES_SCHEMA_VERSION}`);
  const d = raw.draft;
  if (!isObj(d)) return { ok: false, errors: [...errors, 'draft: debe ser un objeto'] };
  onlyKeys(d, ['stories', 'updatedAt'], 'draft', errors);
  let updatedAt: string | null = null;
  if (d.updatedAt !== null && d.updatedAt !== undefined) {
    if (typeof d.updatedAt !== 'string' || !Number.isFinite(Date.parse(d.updatedAt))) errors.push('draft.updatedAt: fecha no válida');
    else updatedAt = d.updatedAt;
  }
  const stories = validateStories(d.stories, 'draft.stories');
  if (!stories.ok) errors.push(...stories.errors);
  if (errors.length || !stories.ok) return { ok: false, errors: errors.slice(0, 30) };
  const doc: StoriesDocument = { schemaVersion: STORIES_SCHEMA_VERSION, draft: { stories: stories.value, updatedAt } };
  if (JSON.stringify(doc).length > MAX_STORIES_BYTES) return { ok: false, errors: [`El documento supera ${MAX_STORIES_BYTES / 1024} KiB`] };
  return { ok: true, value: doc };
}

/* ───────────────────────── Comprobación de referencias (no bloquea el guardado) ───────────────────────── */

export type Severity = 'error' | 'warning' | 'info';
export interface StoryIssue {
  storyId: string;
  storyName: string;
  screenIndex?: number;
  severity: Severity;
  code: string;
  message: string;
}
type StorySources = Pick<ReferenceSources, 'products' | 'retiredIds' | 'categories'>;

function categoryExists(src: StorySources, ref: string): boolean {
  if (src.categories.has(ref)) return true;
  for (const c of src.categories.values()) if (c.slug === ref) return true;
  return false;
}

/** Comprueba, sin escribir, que lo que referencian las historias existe y se puede presentar. Los errores de una historia en borrador no bloquean nada. */
export function checkStories(stories: readonly Story[], src: StorySources): StoryIssue[] {
  const out: StoryIssue[] = [];
  for (const s of stories) {
    const add = (severity: Severity, code: string, message: string, screenIndex?: number) => out.push({ storyId: s.id, storyName: s.name, severity, code, message, ...(screenIndex !== undefined ? { screenIndex } : {}) });
    s.screens.forEach((sc, i) => {
      const n = i + 1;
      if (!sc.title && !sc.text) add('warning', 'screen_without_text', `La pantalla ${n} no tiene texto`, i);
      if (sc.buttonLabel && !sc.link) add('warning', 'button_without_link', `La pantalla ${n} tiene botón pero no destino`, i);
      if (sc.link && !sc.buttonLabel) add('warning', 'link_without_button', `La pantalla ${n} tiene destino pero no texto de botón`, i);
      if (sc.image.startsWith('https://')) add('info', 'image_external', `La imagen de la pantalla ${n} es una URL externa`, i);
      if (!sc.link) return;
      if (sc.link.type === 'product') {
        const p = src.products.get(sc.link.target);
        if (!p) add('error', src.retiredIds.has(sc.link.target) ? 'link_product_retired' : 'link_product_missing', `El producto de la pantalla ${n} ${src.retiredIds.has(sc.link.target) ? 'fue retirado del catálogo' : 'no existe'}`, i);
        else if (p.price === null) add('warning', 'link_product_without_price', `El producto de la pantalla ${n} no tiene precio utilizable`, i);
      } else if (sc.link.type === 'category') {
        if (!categoryExists(src, sc.link.target)) add('error', 'link_category_missing', `La categoría de la pantalla ${n} no existe`, i);
      } else add('info', 'link_campaign_unverified', `El destino de campaña de la pantalla ${n} es una ruta propia que no se puede comprobar`, i);
    });
  }
  return out;
}

/** Errores que impiden que una historia esté «publicada» internamente. Las historias en borrador nunca bloquean. */
export const blockingErrors = (stories: readonly Story[], issues: readonly StoryIssue[]): StoryIssue[] => {
  const published = new Set(stories.filter((s) => s.status === 'publicada').map((s) => s.id));
  return issues.filter((i) => i.severity === 'error' && published.has(i.storyId));
};

/* ───────────────────────── Operaciones (puras) ───────────────────────── */

export function newId(prefix: string, taken: Iterable<string>, rnd: () => number = Math.random): string {
  const used = new Set(taken);
  for (let k = 0; k < 50; k++) {
    const id = `${prefix}-${Math.floor(rnd() * 0xfffff).toString(36).padStart(4, '0')}`;
    if (!used.has(id)) return id;
  }
  return `${prefix}-${Date.now().toString(36)}`;
}
export const coverOf = (s: Story): string => s.screens[0]?.image ?? '';

export function createScreen(taken: Iterable<string>, image: string): StoryScreen {
  return { id: newId('p', taken), image, title: 'Título', text: 'Texto', buttonLabel: 'Ver más', duration: 5 };
}
export function createStory(stories: readonly Story[], image: string, rnd?: () => number): Story {
  return { id: newId('h', stories.map((s) => s.id), rnd), name: 'Nueva historia', status: 'borrador', screens: [createScreen([], image)] };
}
export function addStory(stories: readonly Story[], story: Story): Story[] {
  return stories.length >= MAX_STORIES ? [...stories] : [...stories, story];
}
export function duplicateStory(stories: readonly Story[], id: string): Story[] {
  const i = stories.findIndex((s) => s.id === id);
  if (i < 0 || stories.length >= MAX_STORIES) return [...stories];
  const src = stories[i];
  const copy: Story = {
    id: newId('h', stories.map((s) => s.id)),
    name: `${src.name} (copia)`.slice(0, 60),
    status: 'borrador',
    screens: src.screens.map((sc, j) => ({ ...sc, ...(sc.link ? { link: { ...sc.link } } : {}), id: `p-${(j + 1).toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`.slice(0, 40) })),
  };
  return [...stories.slice(0, i + 1), copy, ...stories.slice(i + 1)];
}
export const removeStory = (stories: readonly Story[], id: string): Story[] => stories.filter((s) => s.id !== id);
export function moveStory(stories: readonly Story[], id: string, to: number): Story[] {
  const from = stories.findIndex((s) => s.id === id);
  if (from < 0) return [...stories];
  const next = [...stories];
  const [m] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, m);
  return next;
}
export const updateStory = (stories: readonly Story[], id: string, patch: Partial<Pick<Story, 'name' | 'status'>>): Story[] => stories.map((s) => (s.id === id ? { ...s, ...patch } : s));
export function addScreen(stories: readonly Story[], id: string, image: string): Story[] {
  return stories.map((s) => (s.id === id && s.screens.length < MAX_SCREENS ? { ...s, screens: [...s.screens, createScreen(s.screens.map((x) => x.id), image)] } : s));
}
/** Una historia necesita al menos una pantalla: la última no se elimina. */
export const removeScreen = (stories: readonly Story[], id: string, index: number): Story[] => stories.map((s) => (s.id === id && s.screens.length > 1 ? { ...s, screens: s.screens.filter((_, i) => i !== index) } : s));
export function moveScreen(stories: readonly Story[], id: string, index: number, delta: -1 | 1): Story[] {
  return stories.map((s) => {
    const j = index + delta;
    if (s.id !== id || j < 0 || j >= s.screens.length || index < 0 || index >= s.screens.length) return s;
    const screens = [...s.screens];
    [screens[index], screens[j]] = [screens[j], screens[index]];
    return { ...s, screens };
  });
}
export const updateScreen = (stories: readonly Story[], id: string, index: number, patch: Partial<StoryScreen>): Story[] =>
  stories.map((s) => (s.id === id ? { ...s, screens: s.screens.map((sc, i) => (i === index ? { ...sc, ...patch } : sc)) } : s));

/* ───────────────────────── Decisión de guardado (pura) ───────────────────────── */

export const MAX_BODY_BYTES = MAX_STORIES_BYTES;
export type SavePlan =
  | { ok: true; doc: StoriesDocument; revision: string }
  | { ok: false; reason: 'peticion_invalida' | 'archivo_protegido' | 'conflicto' | 'documento_invalido'; errors: string[]; currentRevision?: string };

/** Decide si se puede guardar. No escribe. Cuerpo esperado: { baseRevision, stories }. */
export function prepareStoriesSave(read: { status: string; doc: StoriesDocument }, input: unknown, now: Date): SavePlan {
  if (!isObj(input)) return { ok: false, reason: 'peticion_invalida', errors: ['El cuerpo debe ser un objeto'] };
  const extra = Object.keys(input).filter((k) => k !== 'baseRevision' && k !== 'stories');
  if (extra.length) return { ok: false, reason: 'peticion_invalida', errors: [`Campos no admitidos: ${extra.slice(0, 5).join(', ')}`] };
  if (typeof input.baseRevision !== 'string' || !input.baseRevision || input.baseRevision.length > 64) return { ok: false, reason: 'peticion_invalida', errors: ['baseRevision es obligatoria'] };
  if (read.status === 'corrupt' || read.status === 'invalid' || read.status === 'newer') {
    return { ok: false, reason: 'archivo_protegido', errors: [`El almacenamiento está en estado «${read.status}»: se conserva sin sobrescribir`] };
  }
  const current = revisionOf(read.doc.draft.updatedAt);
  if (input.baseRevision !== current) return { ok: false, reason: 'conflicto', currentRevision: current, errors: ['Las historias cambiaron desde que las cargaste (otra sesión las guardó)'] };
  const stories = validateStories(input.stories);
  if (!stories.ok) return { ok: false, reason: 'documento_invalido', errors: stories.errors };
  const prev = read.doc.draft.updatedAt ? Date.parse(read.doc.draft.updatedAt) : 0;
  const stamp = new Date(Math.max(now.getTime(), Number.isFinite(prev) ? prev + 1 : 0)).toISOString();
  const full = validateStoriesDocument({ schemaVersion: STORIES_SCHEMA_VERSION, draft: { stories: stories.value, updatedAt: stamp } });
  if (!full.ok) return { ok: false, reason: 'documento_invalido', errors: full.errors };
  return { ok: true, doc: full.value, revision: stamp };
}
