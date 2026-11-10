/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · EDITOR VISUAL DEL BORRADOR (etapa 3, navegador)
 * ==============================================================================
 * Monta el editor dentro de `#homeLayoutEditor` (página /upayp1b4/portada). Todo el contenido dinámico se crea con `textContent` (nunca
 * `innerHTML`). Solo trabaja sobre el BORRADOR:
 *   · carga con GET /api/admin/home-layout/draft (no guarda nada al cargar);
 *   · guarda ÚNICAMENTE cuando el administrador pulsa «Guardar borrador» (PUT con control de revisiones);
 *   · no publica, no activa la portada nueva y no modifica el catálogo, las secciones ni las categorías.
 * Etapa 4 · pestaña «Publicación y versiones»: publica el borrador GUARDADO como versión INTERNA (no activa la portada pública), lista el
 *   historial, previsualiza y compara versiones y recupera una versión como borrador. Cada acción exige confirmación explícita y se envía con
 *   UNA sola petición POST (`act`), nunca de forma automática.
 * Etapa 5 · previsualizaciones con datos REALES (imágenes, títulos y precios del catálogo, selección de la modalidad Automática) y comprobación
 *   de referencias EN VIVO sobre lo que se edita aunque no esté guardado (POST de sólo lectura a /preview: no escribe nada); pestaña C «Historias»
 *   (módulo `homeLayoutStories.ts`, almacenamiento propio).
 * Las operaciones sobre bloques son las funciones puras de `lib/homeLayout/draft.ts`; la validación, la de `validate.ts`.
 * ==============================================================================
 */

import { FORMATS, MODALITIES, WIDTHS, type Block, type CardKind, type ContentRef, type Format, type Modality, type Width } from '../lib/homeLayout/types';
import { FORMAT_REGISTRY, MAX_BLOCKS, MODALITY_REGISTRY, validateBlocks } from '../lib/homeLayout/validate';
import {
  addBlock,
  addRef,
  cardsFor,
  changeFormat,
  changeModality,
  createBlock,
  duplicateBlock,
  maxItemsFor,
  moveBlock,
  moveBy,
  moveRef,
  removeBlock,
  removeRef,
  setWidth,
  updateBlock,
} from '../lib/homeLayout/draft';

import type { BlockingIssue, DiffEntry, VersionSummary } from '../lib/homeLayout/publish';
import { initHomeLayoutStories } from './homeLayoutStories';

/* ───────────────────────── Tipos de las API de lectura ───────────────────────── */
interface Issue { severity: 'error' | 'warning' | 'info'; code: string; message: string }
interface AutoSel { status: 'ok' | 'vacio' | 'no_ejecutable' | 'reglas_invalidas'; ids: string[]; reason?: string; message?: string }
interface ResolvedBlock { id: string; visible: boolean | null; items: number; valid: number; issues: Issue[]; refs: Array<{ kind: string; id: string; label?: string; status: string }>; selection?: AutoSel }
interface PItem { kind: 'product' | 'category'; id: string; title: string; price: number | null; image: string | null; network: string; inStock: boolean | null; missing?: boolean }
interface BlockPreview { items: PItem[]; auto?: { status: AutoSel['status']; message?: string; reason?: string; items: PItem[]; stats?: Record<string, number> }; note?: string }
type PvData = Record<string, BlockPreview>;
interface CatOption { id: string; name: string; parentId: string | null; level: string }
interface SecOption { id: string; title: string; published: boolean; productCount: number; validProductCount: number }
interface MerOption { id: string; productCount: number }
interface ProdOption { id: string; title: string; price: number | null; hasImage: boolean; network: string }

type Msg = { kind: 'ok' | 'error' | 'info'; text: string } | null;

const WIDTH_LABEL: Record<number, string> = { 3: '¼', 4: '⅓', 6: '½', 8: '⅔', 9: '¾', 12: '1' };
const WIDTH_NAME: Record<number, string> = { 3: 'un cuarto', 4: 'un tercio', 6: 'la mitad', 8: 'dos tercios', 9: 'tres cuartos', 12: 'el ancho completo' };
const CARD_LABEL: Record<CardKind, string> = { producto: 'Tarjeta de producto', categoria: 'Tarjeta de categoría', promocion: 'Tarjeta de promoción' };
const ORDER_LABEL: Record<string, string> = { recientes: 'Más recientes', precio_asc: 'Precio ascendente', precio_desc: 'Precio descendente' };
const LINK_LABEL: Record<string, string> = { path: 'Ruta propia (/…)', url: 'URL externa (https)', product: 'Ficha de producto', category: 'Categoría', section: 'Sección' };

/* ───────────────────────── Utilidades DOM (sin innerHTML) ───────────────────────── */
type Child = Node | string | null | false | undefined;
type Attrs = Record<string, string | number | boolean | undefined | null | ((e: any) => void)>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== false && c !== undefined) el.append(c);
  return el;
}
const clear = (el: Element) => { while (el.firstChild) el.removeChild(el.firstChild); };
const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

/* ───────────────────────── Editor ───────────────────────── */
export function initHomeLayoutEditor(root: HTMLElement): void {
  const state = {
    blocks: [] as Block[],
    saved: '[]',
    revision: 'inicial',
    storage: 'missing',
    writable: true,
    loaded: false,
    dirty: false,
    sel: null as string | null,
    device: 'desktop' as 'desktop' | 'mobile',
    conflict: false,
    busy: false,
    msg: null as Msg,
    resolved: new Map<string, ResolvedBlock>(),
    resolvedStale: true,
    /** Datos reales de las previsualizaciones (bloque → elementos), calculados por el servidor con lo que hay en el editor. */
    pv: {} as PvData,
    pvInvalid: {} as Record<string, string[]>,
  };
  let liveTimer: number | undefined;
  let liveSeq = 0;
  const catalog = { categories: [] as CatOption[], sections: [] as SecOption[], merchants: [] as MerOption[] };
  const info = new Map<string, { label: string; price?: number | null }>();
  const key = (r: ContentRef) => `${r.kind}:${r.id}`;
  const labelOf = (r: ContentRef) => info.get(key(r))?.label ?? r.id;
  let focusKey: string | null = null;
  let search = { q: '', items: [] as ProdOption[] | CatOption[], loading: false, error: '' as string };
  let searchTimer: number | undefined;

  /* ---- Regiones ---- */
  const live = h('div', { class: 'pe-live', role: 'status', 'aria-live': 'polite' });
  const toolbar = h('div', { class: 'pe-toolbar' });
  const banner = h('div', { class: 'pe-banner', hidden: true, role: 'alert' });
  const addbar = h('div', { class: 'pe-addbar', role: 'group', 'aria-label': 'Añadir bloque' });
  const canvasWrap = h('div', { class: 'pe-frame' });
  const canvas = h('div', { class: 'pe-canvas', 'aria-label': 'Bloques de la portada' });
  const props = h('aside', { class: 'pe-props', 'aria-label': 'Propiedades del bloque' });
  const previews = h('div', { class: 'pe-previews' });
  const modal = h('div', { class: 'pe-modal', hidden: true, role: 'dialog', 'aria-modal': 'true' });
  canvasWrap.append(canvas);
  const tabs = h('div', { class: 'pe-tabs', role: 'tablist', 'aria-label': 'Secciones del editor de portada' });
  const editorPane = h('div', { class: 'pe-pane', id: 'peEditorPane', role: 'tabpanel' });
  const versionsPane = h('div', { class: 'pe-pane', id: 'peVersionsPane', role: 'tabpanel', hidden: true });
  const storiesPane = h('div', { class: 'pe-pane', id: 'peStoriesPane', role: 'tabpanel', hidden: true });
  editorPane.append(
    toolbar,
    banner,
    addbar,
    h('div', { class: 'pe-main' }, h('div', {}, canvasWrap, h('p', { class: 'pe-note' }, 'Arrastra ⠿ o usa ▲ ▼ para ordenar · pulsa un ancho para cambiarlo. Los bloques no se muestran en la web con una búsqueda o categoría activa. Solo se guarda al pulsar «Guardar borrador»; nada se publica.')), props),
    previews,
  );
  root.append(tabs, editorPane, versionsPane, storiesPane, live, modal);

  /* ---- API ---- */
  async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    try {
      const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
      let body: any = null;
      try { body = await r.json(); } catch { body = null; }
      return { status: r.status, body };
    } catch {
      return { status: 0, body: null };
    }
  }
  const say = (m: Msg) => { state.msg = m; live.textContent = m ? m.text : ''; renderToolbar(); };

  /* ---- Validación y estado derivado ---- */
  function validation() {
    const v = validateBlocks(state.blocks);
    const byIndex = new Map<number, string>();
    if (!v.ok) {
      for (const e of v.errors) {
        const m = /^blocks\[(\d+)\]/.exec(e);
        const i = m ? Number(m[1]) : -1;
        if (!byIndex.has(i)) byIndex.set(i, e.replace(/^blocks\[\d+\]\.?/, ''));
      }
    }
    return { ok: v.ok, errors: v.ok ? [] : v.errors, byIndex };
  }
  const isDirty = () => JSON.stringify(state.blocks) !== state.saved;
  function scheduleLive() {
    window.clearTimeout(liveTimer);
    liveTimer = window.setTimeout(() => { void refreshLive(); }, 450);
  }
  function touch() {
    state.dirty = isDirty();
    state.resolvedStale = true;
    scheduleLive();
    renderToolbar();
    renderCanvas();
    renderPreviews();
  }
  function setBlocks(next: Block[], opts: { focus?: string } = {}) {
    state.blocks = next;
    if (opts.focus) focusKey = opts.focus;
    state.dirty = isDirty();
    state.resolvedStale = true;
    scheduleLive();
    renderAll();
  }
  const selected = () => state.blocks.find((b) => b.id === state.sel) ?? null;

  /* ---- Carga / guardado ---- */
  async function loadOptions() {
    const [c, s, m] = await Promise.all([
      api('/api/admin/home-layout/options?kind=category&limit=50'),
      api('/api/admin/home-layout/options?kind=section&limit=50'),
      api('/api/admin/home-layout/options?kind=merchant&limit=50'),
    ]);
    if (c.status === 200) catalog.categories = c.body.items;
    if (s.status === 200) catalog.sections = s.body.items;
    if (m.status === 200) catalog.merchants = m.body.items;
    for (const x of catalog.categories) info.set(`category:${x.id}`, { label: x.name });
    for (const x of catalog.sections) info.set(`section:${x.id}`, { label: x.title });
  }
  /** Comprueba y previsualiza LO QUE HAY EN EL EDITOR (guardado o no) con los datos actuales del catálogo. Sólo lectura: no guarda nada. */
  async function refreshLive() {
    const seq = ++liveSeq;
    const r = await api('/api/admin/home-layout/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1' },
      body: JSON.stringify({ blocks: state.blocks }),
    });
    if (seq !== liveSeq) return; // llegó una respuesta más antigua que otra posterior
    if (r.status === 200 && r.body?.success) {
      state.pv = r.body.blocks as PvData;
      state.pvInvalid = r.body.invalid as Record<string, string[]>;
      state.resolved = new Map((r.body.resolved.blocks as ResolvedBlock[]).map((b) => [b.id, b]));
      for (const b of r.body.resolved.blocks as ResolvedBlock[]) for (const ref of b.refs) if (ref.label) info.set(`${ref.kind}:${ref.id}`, { label: ref.label, price: info.get(`${ref.kind}:${ref.id}`)?.price });
      state.resolvedStale = false;
      if (tab === 'editor') { renderCanvas(); renderProps(); renderPreviews(); }
    }
  }
  const loadResolved = () => refreshLive();
  async function load() {
    const r = await api('/api/admin/home-layout/draft');
    if (r.status !== 200 || !r.body?.success) { say({ kind: 'error', text: r.status === 401 ? 'La sesión ha caducado: vuelve a iniciar sesión.' : 'No se pudo cargar el borrador.' }); return; }
    state.blocks = r.body.blocks;
    state.saved = JSON.stringify(r.body.blocks);
    state.revision = r.body.revision;
    state.storage = r.body.storage.status;
    state.writable = r.body.writable;
    state.dirty = false;
    state.conflict = false;
    state.loaded = true;
    if (!state.sel || !state.blocks.some((b) => b.id === state.sel)) state.sel = state.blocks[0]?.id ?? null;
    banner.hidden = true;
    await Promise.all([loadResolved(), catalog.categories.length ? Promise.resolve() : loadOptions()]);
    renderAll();
  }
  async function save() {
    if (state.busy) return;
    const v = validation();
    if (!v.ok) { say({ kind: 'error', text: 'Hay bloques incompletos o no válidos: complétalos antes de guardar.' }); return; }
    state.busy = true; renderToolbar();
    const r = await api('/api/admin/home-layout/draft', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1' },
      body: JSON.stringify({ baseRevision: state.revision, blocks: state.blocks }),
    });
    state.busy = false;
    if (r.status === 200 && r.body?.success) {
      state.blocks = r.body.blocks;
      state.saved = JSON.stringify(r.body.blocks);
      state.revision = r.body.revision;
      state.dirty = false;
      state.storage = 'ok';
      state.conflict = false;
      banner.hidden = true;
      await loadResolved();
      renderAll();
      say({ kind: 'ok', text: `Borrador guardado (${new Date(r.body.savedAt).toLocaleTimeString('es-ES')}). No se ha publicado nada.` });
    } else if (r.status === 409) {
      state.conflict = true;
      showBanner('Otra sesión ha guardado el borrador después de que lo cargaras. Tus cambios NO se han guardado. Recarga la versión del servidor (se descartan tus cambios locales) o copia lo que necesites antes.', true);
      say({ kind: 'error', text: 'Conflicto de revisión: el borrador del servidor es más reciente.' });
      renderToolbar();
    } else if (r.status === 423) {
      say({ kind: 'error', text: 'El almacenamiento del borrador está dañado: no se sobrescribe. Avisa al responsable técnico.' });
    } else if (r.status === 400) {
      say({ kind: 'error', text: `El servidor rechazó el borrador: ${(r.body?.errors ?? [r.body?.message]).slice(0, 2).join(' · ')}` });
    } else if (r.status === 401) {
      say({ kind: 'error', text: 'La sesión ha caducado: vuelve a iniciar sesión (los cambios siguen en esta página).' });
    } else if (r.status === 403) {
      say({ kind: 'error', text: 'No se pudo verificar el origen de la petición. Recarga la página.' });
    } else {
      say({ kind: 'error', text: 'No se pudo guardar el borrador. Inténtalo de nuevo; el anterior sigue intacto.' });
    }
  }
  async function reload() {
    if (state.dirty && !(await confirmBox('Recargar el borrador del servidor', 'Se descartarán los cambios que no hayas guardado.', 'Descartar y recargar', true))) return;
    await load();
    say({ kind: 'info', text: 'Borrador recargado desde el servidor.' });
  }
  function showBanner(text: string, withReload: boolean) {
    clear(banner);
    banner.append(h('span', {}, text));
    if (withReload) banner.append(h('button', { class: 'pe-btn', type: 'button', onclick: () => { void reload(); } }, 'Recargar la versión del servidor'));
    banner.hidden = false;
  }
  window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---- Confirmaciones ---- */
  function confirmBox(title: string, text: string, ok: string, danger = false, extra: Node | null = null, okDisabled = false): Promise<boolean> {
    return new Promise((resolve) => {
      const previous = document.activeElement as HTMLElement | null;
      const done = (v: boolean) => { modal.hidden = true; clear(modal); document.removeEventListener('keydown', onKey); previous?.focus?.(); resolve(v); };
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') done(false); };
      clear(modal);
      const yes = h('button', { class: danger ? 'pe-btn pe-danger' : 'pe-btn pe-primary', type: 'button', disabled: okDisabled, onclick: () => done(true) }, ok);
      modal.append(
        h('div', { class: 'pe-backdrop', onclick: () => done(false) }),
        h('div', { class: 'pe-dialog' }, h('h3', {}, title), h('p', {}, text), extra, h('div', { class: 'pe-row-end' }, h('button', { class: 'pe-btn', type: 'button', onclick: () => done(false) }, 'Cancelar'), yes)),
      );
      modal.setAttribute('aria-label', title);
      modal.hidden = false;
      document.addEventListener('keydown', onKey);
      (okDisabled ? (modal.querySelector('.pe-btn') as HTMLElement | null) : yes)?.focus();
    });
  }

  /* ---- Barra superior ---- */
  function renderToolbar() {
    clear(toolbar);
    queueMicrotask(() => { if (typeof renderGlobal === 'function') renderGlobal(); });
    const v = validation();
    const stateChip = !state.loaded
      ? h('span', { class: 'pe-chip' }, 'Cargando…')
      : state.conflict
        ? h('span', { class: 'pe-chip is-err' }, '⚠ Conflicto de revisión')
        : state.dirty
          ? h('span', { class: 'pe-chip is-draft' }, '✎ Cambios sin guardar')
          : h('span', { class: 'pe-chip is-draft' }, state.revision === 'inicial' ? '✎ Borrador vacío (sin guardar aún)' : '✎ Borrador guardado · sin publicar');
    const msg = state.msg ? h('span', { class: `pe-msg is-${state.msg.kind}` }, state.msg.text) : null;
    const invalid = !v.ok ? h('span', { class: 'pe-msg is-error' }, `${v.byIndex.size || 1} bloque(s) por completar`) : null;
    const canSave = state.loaded && state.dirty && v.ok && state.writable && !state.busy && !state.conflict;
    toolbar.append(
      stateChip,
      h('span', { class: 'pe-note' }, `Revisión: ${state.revision === 'inicial' ? '—' : new Date(state.revision).toLocaleString('es-ES')}`),
      ...(msg ? [msg] : []),
      ...(invalid ? [invalid] : []),
      h('span', { class: 'pe-grow' }),
      h('div', { class: 'pe-seg', role: 'group', 'aria-label': 'Vista del lienzo' },
        h('button', { type: 'button', 'aria-pressed': String(state.device === 'desktop'), onclick: () => { state.device = 'desktop'; renderCanvas(); renderToolbar(); } }, '🖥 Escritorio'),
        h('button', { type: 'button', 'aria-pressed': String(state.device === 'mobile'), onclick: () => { state.device = 'mobile'; renderCanvas(); renderToolbar(); } }, '📱 Móvil')),
      h('button', { class: 'pe-btn', type: 'button', disabled: !state.loaded || state.busy, onclick: () => { void reload(); } }, 'Recargar borrador'),
      h('button', { class: 'pe-btn pe-primary', type: 'button', disabled: !canSave, onclick: () => { void save(); }, title: !state.writable ? 'El almacenamiento está protegido' : !v.ok ? 'Completa los bloques marcados' : !state.dirty ? 'No hay cambios' : '' }, state.busy ? 'Guardando…' : 'Guardar borrador'),
    );
  }

  /* ---- Añadir bloque ---- */
  let addModality: Modality = 'manual';
  let addFormat: Format = 'carrusel';
  function renderAddbar() {
    clear(addbar);
    const selM = h('select', { id: 'peAddModality', 'aria-label': 'Modalidad del bloque nuevo', onchange: (e: any) => { addModality = e.target.value; } },
      ...MODALITIES.map((m) => h('option', { value: m, selected: m === addModality }, MODALITY_REGISTRY[m].label)));
    const selF = h('select', { id: 'peAddFormat', 'aria-label': 'Formato del bloque nuevo', onchange: (e: any) => { addFormat = e.target.value; } },
      ...FORMATS.map((f) => h('option', { value: f, selected: f === addFormat }, FORMAT_REGISTRY[f].label)));
    addbar.append(
      h('b', {}, 'Añadir bloque:'),
      h('label', { for: 'peAddModality' }, 'Modalidad'), selM,
      h('label', { for: 'peAddFormat' }, 'Formato'), selF,
      h('button', { class: 'pe-btn pe-primary', type: 'button', disabled: state.blocks.length >= MAX_BLOCKS, onclick: () => {
        const b = createBlock(addModality, addFormat, state.blocks);
        state.sel = b.id;
        setBlocks(addBlock(state.blocks, b), { focus: `title:${b.id}` });
        say({ kind: 'info', text: `Bloque «${MODALITY_REGISTRY[addModality].label}» añadido al final. Complétalo y pulsa «Guardar borrador».` });
      } }, '＋ Añadir'),
      h('span', { class: 'pe-note pe-warn' }, 'Modalidades y formatos provisionales (pendientes de confirmación definitiva). Las tarjetas de producto, categoría y promoción son componentes reutilizables.'),
    );
  }

  /* ---- Lienzo ---- */
  function thumbs(b: Block): HTMLElement {
    const n = b.format === 'cuadricula2x2' ? 4 : 5;
    if (b.modality === 'editorial') return h('div', { class: 'pe-thumbs' }, h('span', { class: 'pe-banner-th' }, (b.config as { headline?: string }).headline || 'Editorial'));
    if (b.modality === 'automatica') {
      const a = state.pv[b.id]?.auto;
      if (a?.status === 'ok') return h('div', { class: 'pe-thumbs' }, ...a.items.slice(0, n).map((it) => h('span', { title: it.title }, it.title.slice(0, 14))));
      return h('div', { class: 'pe-thumbs' }, h('span', { class: 'pe-banner-th' + (a ? ' is-empty' : '') }, a?.message ? a.message.slice(0, 90) : 'Selección automática (calculando…)'));
    }
    const refs = b.refs.slice(0, n);
    if (!refs.length) return h('div', { class: 'pe-thumbs' }, h('span', { class: 'pe-banner-th is-empty' }, 'Sin contenido: complétalo'));
    return h('div', { class: 'pe-thumbs' }, ...refs.map((r) => h('span', { title: labelOf(r) }, labelOf(r).slice(0, 14))));
  }
  function statusBadge(b: Block): HTMLElement | null {
    const rb = state.resolved.get(b.id);
    if (!rb) return h('span', { class: 'pe-badge' }, 'Sin comprobar');
    if (state.resolvedStale) return h('span', { class: 'pe-badge', title: 'Se está comprobando con los datos actuales del catálogo' }, 'Comprobando…');
    const errs = rb.issues.filter((i) => i.severity === 'error').length;
    const warns = rb.issues.filter((i) => i.severity === 'warning').length;
    const vis = rb.visible === true ? '✓ Se mostraría' : rb.visible === false ? '● No se mostraría' : '? Visibilidad sin evaluar';
    const auto = b.modality === 'automatica' && rb.selection ? ` · ${rb.items} producto(s)` : '';
    return h('span', { class: `pe-badge ${rb.visible === false ? 'is-err' : errs || warns ? 'is-warn' : 'is-ok'}`, title: rb.issues.map((i) => i.message).slice(0, 6).join('\n') }, `${vis}${auto}${errs ? ` · ${errs} error(es)` : ''}${warns ? ` · ${warns} aviso(s)` : ''}`);
  }
  function renderCanvas() {
    canvasWrap.className = `pe-frame ${state.device === 'mobile' ? 'is-mobile' : ''}`;
    clear(canvas);
    const v = validation();
    if (!state.blocks.length) {
      canvas.append(h('p', { class: 'pe-empty' }, state.loaded ? 'La portada no tiene bloques. Añade uno con «Añadir bloque».' : 'Cargando el borrador…'));
      return;
    }
    state.blocks.forEach((b, i) => {
      const bad = v.byIndex.get(i);
      const mobileSpan = b.width === 3 ? 6 : 12;
      const el = h('div', { class: `pe-block${b.id === state.sel ? ' is-sel' : ''}${bad ? ' is-bad' : ''}${b.visible ? '' : ' is-off'}`, 'data-id': b.id, draggable: 'true', style: `grid-column: span ${state.device === 'mobile' ? mobileSpan : b.width}` });
      el.addEventListener('dragstart', (e) => { el.classList.add('is-drag'); e.dataTransfer?.setData('text/plain', b.id); });
      el.addEventListener('dragend', () => el.classList.remove('is-drag'));
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('is-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('is-over'));
      el.addEventListener('drop', (e) => {
        e.preventDefault(); el.classList.remove('is-over');
        const from = e.dataTransfer?.getData('text/plain');
        if (from && from !== b.id) setBlocks(moveBlock(state.blocks, from, i), { focus: `title:${from}` });
      });
      const fk = (k: string) => `${k}:${b.id}`;
      el.append(
        h('div', { class: 'pe-bh' },
          h('span', { class: 'pe-handle', 'aria-hidden': 'true', title: 'Arrastrar' }, '⠿'),
          h('button', { class: 'pe-bt', type: 'button', 'data-fk': fk('title'), onclick: () => { state.sel = b.id; renderCanvas(); renderProps(); } }, b.title || '(sin título)')),
        h('div', { class: 'pe-ba' },
          h('span', { class: 'pe-chip-s' }, MODALITY_REGISTRY[b.modality].label),
          h('span', { class: 'pe-chip-s is-alt' }, FORMAT_REGISTRY[b.format].label),
          h('span', { class: 'pe-grow' }),
          h('button', { class: 'pe-ib', type: 'button', 'data-fk': fk('up'), disabled: i === 0, 'aria-label': `Subir el bloque ${b.title}`, onclick: () => setBlocks(moveBy(state.blocks, b.id, -1), { focus: fk('up') }) }, '▲'),
          h('button', { class: 'pe-ib', type: 'button', 'data-fk': fk('down'), disabled: i === state.blocks.length - 1, 'aria-label': `Bajar el bloque ${b.title}`, onclick: () => setBlocks(moveBy(state.blocks, b.id, 1), { focus: fk('down') }) }, '▼'),
          h('button', { class: 'pe-ib', type: 'button', 'aria-label': `Duplicar el bloque ${b.title}`, disabled: state.blocks.length >= MAX_BLOCKS, onclick: () => { const next = duplicateBlock(state.blocks, b.id); state.sel = next[i + 1]?.id ?? state.sel; setBlocks(next); } }, '⧉'),
          h('button', { class: 'pe-ib', type: 'button', 'aria-label': `Eliminar el bloque ${b.title}`, onclick: async () => {
            if (await confirmBox('Eliminar bloque', `¿Eliminar «${b.title}» del borrador? No afecta a la portada publicada y puedes recargar el borrador guardado para recuperarlo.`, 'Eliminar', true)) {
              const next = removeBlock(state.blocks, b.id);
              if (state.sel === b.id) state.sel = next[Math.min(i, next.length - 1)]?.id ?? null;
              setBlocks(next);
              say({ kind: 'info', text: 'Bloque eliminado del borrador (sin guardar).' });
            }
          } }, '🗑')),
        thumbs(b),
        bad ? h('div', { class: 'pe-bad' }, `⚠ ${bad}`) : (statusBadge(b) ?? ''),
        h('div', { class: 'pe-widths', role: 'group', 'aria-label': `Ancho del bloque ${b.title}` },
          ...WIDTHS.map((w) => h('button', { type: 'button', 'aria-pressed': String(b.width === w), 'aria-label': `Ancho ${WIDTH_NAME[w]}`, onclick: () => { state.sel = b.id; setBlocks(setWidth(state.blocks, b.id, w as Width), { focus: `w${w}:${b.id}` }); }, 'data-fk': `w${w}:${b.id}` }, WIDTH_LABEL[w]))),
      );
      canvas.append(el);
    });
  }

  /* ---- Propiedades ---- */
  const field = (label: string, control: Node, hint?: string) => h('div', { class: 'pe-field' }, h('label', {}, label), control, hint ? h('small', {}, hint) : null);
  const textInput = (value: string, max: number, onInput: (v: string) => void, id?: string) => h('input', { type: 'text', id, value, maxlength: max, oninput: (e: any) => onInput(e.target.value) });

  function patch(id: string, p: Partial<Block>) { state.blocks = updateBlock(state.blocks, id, p); touch(); }
  function patchConfig(id: string, cfg: Record<string, unknown>) {
    const b = state.blocks.find((x) => x.id === id)!;
    patch(id, { config: { ...(b.config as object), ...cfg } as Block['config'] });
  }
  function patchRules(id: string, rules: Record<string, unknown>) {
    const b = state.blocks.find((x) => x.id === id)!;
    const cur = (b.config as { rules: Record<string, unknown> }).rules;
    const next: Record<string, unknown> = { ...cur, ...rules };
    for (const k of Object.keys(next)) if (next[k] === '' || next[k] === undefined) delete next[k];
    patch(id, { config: { rules: next } as Block['config'] });
  }
  const optionList = (items: Array<{ value: string; label: string }>, current: string | undefined, empty?: string) => [
    empty !== undefined ? h('option', { value: '' }, empty) : null,
    ...items.map((o) => h('option', { value: o.value, selected: o.value === current }, o.label)),
  ];

  function manualEditor(b: Block): HTMLElement {
    const wrap = h('div', {});
    const kind = b.card === 'categoria' ? 'category' : b.card === 'promocion' ? 'promotion' : 'product';
    wrap.append(h('div', { class: 'pe-sub' }, `Elementos (${b.refs.length}/${maxItemsFor(b.format)})`));
    const list = h('ul', { class: 'pe-refs' });
    b.refs.forEach((r, i) => list.append(h('li', {},
      h('span', { class: 'pe-ref-l' }, labelOf(r)),
      h('button', { class: 'pe-ib', type: 'button', 'aria-label': `Subir ${labelOf(r)}`, disabled: i === 0, onclick: () => { setBlocks(moveRef(state.blocks, b.id, i, -1)); } }, '▲'),
      h('button', { class: 'pe-ib', type: 'button', 'aria-label': `Bajar ${labelOf(r)}`, disabled: i === b.refs.length - 1, onclick: () => { setBlocks(moveRef(state.blocks, b.id, i, 1)); } }, '▼'),
      h('button', { class: 'pe-ib', type: 'button', 'aria-label': `Quitar ${labelOf(r)}`, onclick: () => { setBlocks(removeRef(state.blocks, b.id, i)); } }, '✕'))));
    if (!b.refs.length) list.append(h('li', { class: 'pe-note' }, 'Sin elementos: añade al menos uno para poder guardar.'));
    wrap.append(list);
    if (kind === 'promotion') {
      wrap.append(h('p', { class: 'pe-note pe-warn' }, 'Todavía no existe una fuente de promociones. Para campañas usa la modalidad Editorial.'));
      return wrap;
    }
    const results = h('ul', { class: 'pe-results', 'aria-label': 'Resultados de la búsqueda' });
    const status = h('p', { class: 'pe-note' });
    const paint = () => {
      clear(results);
      status.textContent = search.loading ? 'Buscando…' : search.error || (search.items.length ? '' : search.q ? 'Sin resultados' : '');
      for (const it of search.items as any[]) {
        const ref: ContentRef = { kind: kind as ContentRef['kind'], id: it.id };
        const label = kind === 'product' ? it.title : it.name;
        const exists = b.refs.some((r) => r.kind === ref.kind && r.id === ref.id);
        results.append(h('li', {},
          h('span', { class: 'pe-ref-l' }, label, kind === 'product' && it.price !== null && it.price !== undefined ? h('small', {}, ` · ${eur(it.price)}${it.hasImage ? '' : ' · sin imagen'}`) : null,
            kind === 'product' && it.price === null ? h('small', { class: 'pe-warn' }, ' · sin precio') : null),
          h('button', { class: 'pe-btn pe-sm', type: 'button', disabled: exists || b.refs.length >= maxItemsFor(b.format), onclick: () => {
            info.set(key(ref), { label, price: it.price });
            setBlocks(addRef(state.blocks, b.id, ref));
          } }, exists ? 'Añadido' : 'Añadir')));
      }
    };
    const run = async (q: string) => {
      search.q = q; search.loading = true; search.error = ''; paint();
      const r = await api(`/api/admin/home-layout/options?kind=${kind}&limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      search.loading = false;
      if (r.status === 200) {
        search.items = r.body.items;
        if (kind === 'product') for (const it of r.body.items as ProdOption[]) info.set(`product:${it.id}`, { label: it.title, price: it.price });
      } else { search.items = []; search.error = r.status === 400 ? 'Búsqueda no válida' : 'No se pudo buscar'; }
      paint();
    };
    wrap.append(
      field(kind === 'product' ? 'Buscar producto' : 'Buscar categoría', h('input', { type: 'search', placeholder: 'Escribe para buscar…', maxlength: 80, 'aria-label': 'Buscar en el catálogo', oninput: (e: any) => { window.clearTimeout(searchTimer); const q = e.target.value.trim(); searchTimer = window.setTimeout(() => { void run(q); }, 250); } })),
      status, results,
    );
    search = { q: '', items: [], loading: false, error: '' };
    void run('');
    return wrap;
  }

  function sectionEditor(b: Block): HTMLElement {
    const cur = b.refs[0]?.id ?? '';
    const sel = h('select', { id: 'peSection', onchange: (e: any) => {
      const id = e.target.value;
      if (!id) return;
      const s = catalog.sections.find((x) => x.id === id);
      info.set(`section:${id}`, { label: s?.title ?? id });
      state.blocks = updateBlock(state.blocks, b.id, { refs: [{ kind: 'section', id }], title: b.title && b.title !== 'Nuevo bloque' ? b.title : (s?.title ?? b.title).slice(0, 120) });
      state.dirty = isDirty(); state.resolvedStale = true; scheduleLive(); renderAll();
    } }, ...optionList(catalog.sections.map((s) => ({ value: s.id, label: `${s.title}${s.published ? '' : ' (no publicada)'} · ${s.validProductCount}/${s.productCount} productos` })), cur, 'Elige una sección…'));
    const s = catalog.sections.find((x) => x.id === cur);
    return h('div', {},
      field('Sección de «Catálogo → Crear sección»', sel, 'Se referencia por identificador: no se copian los productos.'),
      cur && !s ? h('p', { class: 'pe-note pe-warn' }, 'Esta sección ya no existe en el catálogo.') : null,
      s && !s.published ? h('p', { class: 'pe-note pe-warn' }, 'La sección no está publicada: el bloque no se mostraría.') : null);
  }

  /** Resultado real de la selección con los datos actuales (sólo lectura): cuántos productos devuelve o por qué no devuelve ninguno. */
  function autoStatus(b: Block): HTMLElement {
    const a = state.pv[b.id]?.auto;
    if (state.resolvedStale || !a) return h('p', { class: 'pe-note' }, 'Calculando la selección con los datos actuales del catálogo…');
    if (a.status === 'ok') return h('p', { class: 'pe-note pe-ok' }, `✓ La selección devuelve ${a.items.length} producto(s) con los datos actuales. Sólo se calcula para previsualizar y validar; no se muestra en la web pública.`);
    return h('p', { class: 'pe-note pe-warn', role: 'status' }, `⚠ ${a.message ?? 'La selección no devuelve productos.'}`);
  }

  function automaticEditor(b: Block): HTMLElement {
    const rules = (b.config as { rules: { categoryId?: string; subcategoryId?: string; merchant?: string; order: string; limit: number; onlyWithPrice?: boolean } }).rules;
    const roots = catalog.categories.filter((c) => !c.parentId);
    const subs = catalog.categories.filter((c) => c.parentId && c.parentId === rules.categoryId);
    return h('div', {},
      autoStatus(b),
      field('Categoría', h('select', { onchange: (e: any) => { patchRules(b.id, { categoryId: e.target.value, subcategoryId: '' }); renderProps(); } }, ...optionList(roots.map((c) => ({ value: c.id, label: c.name })), rules.categoryId, 'Cualquiera'))),
      field('Subcategoría', h('select', { disabled: !subs.length, onchange: (e: any) => patchRules(b.id, { subcategoryId: e.target.value }) }, ...optionList(subs.map((c) => ({ value: c.id, label: c.name })), rules.subcategoryId, subs.length ? 'Cualquiera' : 'Sin subcategorías'))),
      field('Comercio o plataforma', h('select', { onchange: (e: any) => patchRules(b.id, { merchant: e.target.value }) }, ...optionList(catalog.merchants.map((m) => ({ value: m.id, label: `${m.id} (${m.productCount})` })), rules.merchant, 'Cualquiera'))),
      field('Orden', h('select', { onchange: (e: any) => patchRules(b.id, { order: e.target.value }) }, ...optionList(Object.entries(ORDER_LABEL).map(([value, label]) => ({ value, label })), rules.order)), 'Solo criterios con datos fiables: no hay descuentos, bajadas de precio ni ventas. «Más recientes» sólo funciona si todos los productos tienen fecha de alta fiable.'),
      field(`Máximo de productos (1–${maxItemsFor(b.format)})`, h('input', { type: 'number', min: 1, max: maxItemsFor(b.format), value: rules.limit, oninput: (e: any) => patchRules(b.id, { limit: Number(e.target.value) }) })),
      h('label', { class: 'pe-check' }, h('input', { type: 'checkbox', checked: rules.onlyWithPrice === true, onchange: (e: any) => patchRules(b.id, { onlyWithPrice: e.target.checked ? true : undefined }) }), ' Solo productos con precio'));
  }

  function editorialEditor(b: Block): HTMLElement {
    const c = b.config as { headline: string; text?: string; imageUrl?: string; buttonLabel?: string; link?: { type: string; target: string } };
    const setLink = (type: string, target: string) => {
      const cfg: Record<string, unknown> = { ...c };
      if (!type) delete cfg.link; else cfg.link = { type, target };
      patch(b.id, { config: cfg as Block['config'] });
    };
    const link = c.link;
    const targetControl = !link ? null
      : link.type === 'section' ? h('select', { onchange: (e: any) => setLink('section', e.target.value) }, ...optionList(catalog.sections.map((s) => ({ value: s.id, label: s.title })), link.target, 'Elige…'))
      : link.type === 'category' ? h('select', { onchange: (e: any) => setLink('category', e.target.value) }, ...optionList(catalog.categories.map((x) => ({ value: x.id, label: `${x.parentId ? '— ' : ''}${x.name}` })), link.target, 'Elige…'))
      : textInput(link.target, 600, (v) => setLink(link.type, v));
    return h('div', {},
      field('Titular', textInput(c.headline, 120, (v) => patchConfig(b.id, { headline: v }))),
      field('Texto (opcional)', h('textarea', { maxlength: 400, oninput: (e: any) => { const v = e.target.value; const cfg: Record<string, unknown> = { ...c }; if (v.trim()) cfg.text = v; else delete cfg.text; patch(b.id, { config: cfg as Block['config'] }); } }, c.text ?? '')),
      field('Imagen (opcional)', textInput(c.imageUrl ?? '', 600, (v) => { const cfg: Record<string, unknown> = { ...c }; if (v.trim()) cfg.imageUrl = v.trim(); else delete cfg.imageUrl; patch(b.id, { config: cfg as Block['config'] }); }), 'Ruta propia (/…) o URL https.'),
      field('Texto del botón', textInput(c.buttonLabel ?? '', 40, (v) => { const cfg: Record<string, unknown> = { ...c }; if (v.trim()) cfg.buttonLabel = v.trim(); else delete cfg.buttonLabel; patch(b.id, { config: cfg as Block['config'] }); })),
      field('El botón enlaza a', h('select', { onchange: (e: any) => { setLink(e.target.value, ''); renderProps(); } }, ...optionList(Object.entries(LINK_LABEL).map(([value, label]) => ({ value, label })), link?.type, 'Sin enlace'))),
      targetControl ? field('Destino', targetControl, link && (link.type === 'product') ? 'Identificador del producto.' : undefined) : null);
  }

  function renderProps() {
    const b = selected();
    clear(props);
    if (!b) { props.append(h('h3', {}, 'Propiedades'), h('p', { class: 'pe-note' }, 'Selecciona un bloque del lienzo.')); return; }
    props.append(
      h('h3', {}, 'Propiedades del bloque'),
      field('Título', h('input', { type: 'text', id: 'peTitle', value: b.title, maxlength: 120, 'data-fk': `title-input:${b.id}`, oninput: (e: any) => patch(b.id, { title: e.target.value }) })),
      field('Modalidad', h('select', { onchange: async (e: any) => {
        const to = e.target.value as Modality;
        const hasContent = b.refs.length > 0 || b.modality === 'editorial' || b.modality === 'automatica';
        if (hasContent && !(await confirmBox('Cambiar de modalidad', 'El contenido del bloque (elementos, reglas o textos) se reiniciará.', 'Cambiar', true))) { e.target.value = b.modality; return; }
        setBlocks(changeModality(state.blocks, b.id, to));
      } }, ...MODALITIES.map((m) => h('option', { value: m, selected: m === b.modality }, MODALITY_REGISTRY[m].label)))),
      field('Formato', h('select', { onchange: (e: any) => setBlocks(changeFormat(state.blocks, b.id, e.target.value as Format)) }, ...FORMATS.map((f) => h('option', { value: f, selected: f === b.format }, FORMAT_REGISTRY[f].label)))),
      field('Ancho', h('div', { class: 'pe-widths', role: 'group', 'aria-label': 'Ancho' }, ...WIDTHS.map((w) => h('button', { type: 'button', 'aria-pressed': String(b.width === w), 'aria-label': `Ancho ${WIDTH_NAME[w]}`, onclick: () => setBlocks(setWidth(state.blocks, b.id, w as Width)) }, WIDTH_LABEL[w]))), 'En móvil ocupa todo el ancho; dos bloques de ¼ seguidos comparten fila.'),
      cardsFor(b.modality).length > 1
        ? field('Tarjeta (componente reutilizable)', h('select', { onchange: (e: any) => setBlocks(updateBlock(state.blocks, b.id, { card: e.target.value as CardKind, refs: [] })) }, ...cardsFor(b.modality).map((c) => h('option', { value: c, selected: c === b.card }, CARD_LABEL[c]))), 'Al cambiar de tarjeta se vacían los elementos.')
        : field('Tarjeta', h('span', { class: 'pe-static' }, CARD_LABEL[cardsFor(b.modality)[0]])),
      h('label', { class: 'pe-check' }, h('input', { type: 'checkbox', checked: b.visible, onchange: (e: any) => patch(b.id, { visible: e.target.checked }) }), ' Bloque visible (si se desmarca, queda en el borrador pero oculto)'),
      b.modality === 'manual' ? manualEditor(b) : b.modality === 'seccion' ? sectionEditor(b) : b.modality === 'automatica' ? automaticEditor(b) : editorialEditor(b),
    );
  }

  /* ---- Vista previa (de lo que hay en el editor, guardado o no) ---- */
  function pvImg(src: string | null, alt = ''): HTMLElement {
    return src ? h('img', { src, alt, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e: any) => { e.target.replaceWith(document.createTextNode('🖼')); } }) : h('span', { class: 'pv-noimg' }, '🖼');
  }
  function pvCard(it: { title: string; price?: number | null; image?: string | null; missing?: boolean }): HTMLElement {
    return h('div', { class: `pv-card${it.missing ? ' is-missing' : ''}` }, h('div', { class: 'pv-im' }, pvImg(it.image ?? null)), h('div', { class: 'pv-tt' }, it.title), it.price ? h('div', { class: 'pv-pr' }, eur(it.price)) : null);
  }
  /** Elementos de un bloque: los del servidor (datos reales) y, mientras llegan, los que ya se conocen por etiqueta. */
  function itemsOf(b: Block, data: PvData): { items: PItem[]; note?: string; auto?: BlockPreview['auto'] } {
    const d = data[b.id];
    if (d) return { items: d.auto ? d.auto.items : d.items, note: d.note, auto: d.auto };
    if (b.modality === 'manual') return { items: b.refs.map((r) => ({ kind: r.kind === 'category' ? 'category' : 'product', id: r.id, title: labelOf(r), price: info.get(key(r))?.price ?? null, image: null, network: '', inStock: null }) as PItem) };
    return { items: [] };
  }
  function pvBlock(b: Block, mobile: boolean, data: PvData = state.pv): HTMLElement {
    const span = mobile ? (b.width === 3 ? 6 : 12) : b.width;
    const el = h('div', { class: `pv-bk${b.visible ? '' : ' is-off'}`, style: `grid-column: span ${span}` });
    const title = b.modality === 'editorial' ? (b.config as { headline?: string }).headline || b.title : b.title;
    if (!b.visible) el.append(h('div', { class: 'pv-hidden' }, `Oculto: ${b.title}`));
    else if (b.modality === 'editorial') {
      const c = b.config as { text?: string; buttonLabel?: string; imageUrl?: string };
      el.append(h('div', { class: `pv-ban${c.imageUrl ? ' has-img' : ''}` }, c.imageUrl ? h('img', { class: 'pv-ban-img', src: c.imageUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e: any) => { e.target.remove(); } }) : null, h('h4', {}, title), c.text ? h('p', {}, c.text) : null, c.buttonLabel ? h('span', { class: 'pv-btn' }, c.buttonLabel) : null));
    } else {
      const { items, note, auto } = itemsOf(b, data);
      const max = b.format === 'cuadricula2x2' ? 4 : 8;
      el.append(h('div', { class: 'pv-bt' }, b.title));
      if (b.modality === 'automatica') {
        const r = (b.config as { rules: { categoryId?: string; merchant?: string; order: string; limit: number } }).rules;
        el.append(h('div', { class: 'pv-auto' }, `Selección automática · ${r.categoryId ? labelOf({ kind: 'category', id: r.categoryId }) : 'todas las categorías'}${r.merchant ? ` · ${r.merchant}` : ''} · ${ORDER_LABEL[r.order] ?? r.order} · hasta ${r.limit}`));
        if (auto && auto.status !== 'ok') { el.append(h('div', { class: 'pv-hidden' }, auto.message ?? 'La selección no devuelve productos')); return el; }
      }
      if (note) { el.append(h('div', { class: 'pv-hidden' }, note)); return el; }
      const shown = items.slice(0, max);
      if (!shown.length) { el.append(h('div', { class: 'pv-hidden' }, b.modality === 'seccion' && !b.refs.length ? 'Elige una sección' : b.modality === 'automatica' ? 'Calculando…' : 'Sin elementos')); return el; }
      if (b.format !== 'cuadricula2x2' && shown.length < items.length) el.append(h('div', { class: 'pv-more' }, `+${items.length - shown.length}`));
      el.append(h('div', { class: b.format === 'cuadricula2x2' ? 'pv-grid' : 'pv-rail' }, ...shown.map((it) => pvCard(it))));
    }
    return el;
  }
  function pvFrame(label: string, mobile: boolean, blocks: Block[] = state.blocks, chip: string = state.dirty ? 'con cambios sin guardar' : 'borrador guardado', data: PvData = state.pv): HTMLElement {
    const inner = h('div', { class: `pv${mobile ? ' is-m' : ''}` },
      h('div', { class: 'pv-hd' }, h('b', {}, 'Treidilor'), h('span', {}, '🔍 Buscar productos…')),
      h('div', { class: 'pv-grid12' }, ...blocks.map((b) => pvBlock(b, mobile, data))));
    const win = h('div', { class: `pe-pvwin${mobile ? ' is-phone' : ''}` }, inner);
    return h('div', { class: 'pe-pvbox' }, h('h3', {}, label, h('span', { class: 'pe-chip-s' }, chip)), win);
  }
  const previewNote = () => h('p', { class: 'pe-note pe-pvnote' }, 'Vista aproximada con los datos reales del catálogo (imágenes, títulos, precios, orden, anchos y selección automática). En la web, las tarjetas de producto usan el diseño habitual del sitio.');
  /** Escala: escritorio = 1200 px virtuales; móvil = 390 px virtuales. Hay que llamarla con las cajas ya insertadas en el documento. */
  function scalePreviews(boxes: Array<[HTMLElement, number]>) {
    for (const [box, nat] of boxes) {
      const win = box.querySelector('.pe-pvwin') as HTMLElement;
      const inner = win.firstElementChild as HTMLElement;
      const w = Math.max(200, win.clientWidth || (nat === 390 ? 280 : 640));
      const s = w / nat;
      inner.style.width = `${nat}px`;
      inner.style.transform = `scale(${s})`;
      inner.style.transformOrigin = '0 0';
      win.style.height = `${Math.min(inner.scrollHeight * s, 560)}px`;
    }
  }
  function renderPreviews() {
    clear(previews);
    const d = pvFrame('Vista previa · escritorio', false);
    const m = pvFrame('Vista previa · móvil', true);
    previews.append(d, m, previewNote());
    scalePreviews([[d, 1200], [m, 390]]);
  }

  /* ---- Pestaña B · Publicación y versiones (etapa 4) ---- */
  type Tab = 'editor' | 'versions' | 'stories';
  let tab: Tab = 'editor';
  const vs = {
    loaded: false,
    loading: false,
    error: '',
    mode: 'legacy',
    storage: 'ok',
    draft: { revision: 'inicial', blocks: 0 },
    published: null as { version: number; publishedAt: string; blocks: number } | null,
    versions: [] as VersionSummary[],
    maxVersions: 100,
    msg: null as Msg,
    detail: null as null | { title: string; kind: 'preview' | 'compare'; blocks?: Block[]; changes?: DiffEntry[]; chip?: string; data?: PvData },
    busy: false,
    initial: null as null | { available: boolean; reason?: string; message?: string; blocks: Array<{ id: string; title: string; modality: string; format: string; width: number }>; check: { canLoad: boolean; blocking: BlockingIssue[]; warnings: BlockingIssue[]; visibleBlocks: number; totalBlocks: number }; draftRevision: string; activationRevision: string; gates: { env: boolean } },
    act: null as null | { gates: { stage: boolean; env: boolean; adminFlag: boolean; activeFile: boolean; pinnedVersion: number | null }; revision: string; log: Array<{ at: string; by: string; action: string; version: number | null; result: string; note?: string }>; storage: { layout: string; activation: string } },
  };
  const dateTxt = (iso: string) => new Date(iso).toLocaleString('es-ES');
  const DIFF_ICON: Record<string, string> = { added: '＋', removed: '－', moved: '↕', width: '↔', format: '▦', modality: '⚙', title: 'Aa', card: '🃏', visibility: '👁', refs: '🔗', config: '✎' };
  const vsay = (m: Msg) => { vs.msg = m; live.textContent = m ? m.text : ''; renderVersions(); };

  function renderTabs() {
    clear(tabs);
    const mk = (id: Tab, label: string) => h('button', { class: 'pe-tab', type: 'button', role: 'tab', 'aria-selected': String(tab === id), 'aria-controls': id === 'editor' ? 'peEditorPane' : id === 'versions' ? 'peVersionsPane' : 'peStoriesPane', onclick: () => { void setTab(id); } }, label);
    tabs.append(
      mk('editor', 'A · Editor visual'),
      mk('versions', 'B · Publicación y versiones'),
      mk('stories', 'C · Historias'),
    );
  }
  async function setTab(next: Tab) {
    tab = next;
    editorPane.hidden = next !== 'editor';
    versionsPane.hidden = next !== 'versions';
    storiesPane.hidden = next !== 'stories';
    renderTabs();
    if (next === 'editor') renderPreviews();
    else if (next === 'versions') await loadVersions();
    else stories.activate();
  }

  async function loadVersions() {
    vs.loading = true; vs.error = ''; renderVersions();
    const r = await api('/api/admin/home-layout/versions');
    const a = await api('/api/admin/home-layout/activation');
    const ini = await api('/api/admin/home-layout/initial');
    vs.initial = ini.status === 200 && ini.body?.success ? ini.body : null;
    vs.act = a.status === 200 && a.body?.success ? { gates: a.body.gates, revision: a.body.revision, log: a.body.log, storage: a.body.storage } : null;
    vs.loading = false;
    if (r.status === 200 && r.body?.success) {
      vs.loaded = true;
      vs.mode = r.body.mode;
      vs.storage = r.body.storage.status;
      vs.draft = { revision: r.body.draft.revision, blocks: r.body.draft.blocks };
      vs.published = r.body.published;
      vs.versions = r.body.versions;
      vs.maxVersions = r.body.limits.maxVersions;
      renderGlobal();
    } else vs.error = r.status === 401 ? 'La sesión ha caducado: vuelve a iniciar sesión.' : 'No se pudo cargar el historial de versiones.';
    renderVersions();
  }

  async function showVersion(v: number) {
    const [r, p] = await Promise.all([api(`/api/admin/home-layout/versions?version=${v}`), api(`/api/admin/home-layout/preview?version=${v}`)]);
    if (r.status !== 200 || !r.body?.success) { vsay({ kind: 'error', text: r.status === 404 ? 'Esa versión ya no existe.' : 'No se pudo cargar la versión.' }); return; }
    for (const rb of r.body.resolved as ResolvedBlock[]) for (const ref of rb.refs) if (ref.label) info.set(`${ref.kind}:${ref.id}`, { label: ref.label, price: info.get(`${ref.kind}:${ref.id}`)?.price });
    vs.detail = { title: `Versión ${v} · ${r.body.state === 'published' ? 'publicada internamente' : 'archivada'}`, kind: 'preview', blocks: r.body.blocks as Block[], data: p.status === 200 && p.body?.success ? (p.body.blocks as PvData) : {}, chip: `v${v} · ${dateTxt(r.body.publishedAt)}` };
    vs.msg = null;
    renderVersions();
  }
  async function compareWith(a: string, b: string, title: string) {
    const r = await api(`/api/admin/home-layout/versions?compare=${encodeURIComponent(a)}&with=${encodeURIComponent(b)}`);
    if (r.status !== 200 || !r.body?.success) { vsay({ kind: 'error', text: 'No se pudo comparar: alguna de las versiones ya no existe.' }); return; }
    vs.detail = { title, kind: 'compare', changes: r.body.changes as DiffEntry[] };
    vs.msg = null;
    renderVersions();
  }

  function diffList(changes: DiffEntry[], empty: string): HTMLElement {
    if (!changes.length) return h('p', { class: 'pe-note' }, empty);
    return h('ul', { class: 'pe-diff' }, ...changes.map((c) => h('li', {}, h('span', { class: `pe-dk is-${c.kind}`, 'aria-hidden': 'true' }, DIFF_ICON[c.kind] ?? '•'), h('span', {}, h('b', {}, c.title || '(sin título)'), ` — ${c.detail}`))));
  }
  const issueList = (items: BlockingIssue[]) => h('ul', { class: 'pe-diff' }, ...items.map((i) => h('li', {}, h('span', { class: 'pe-dk is-removed', 'aria-hidden': 'true' }, '⚠'), h('span', {}, h('b', {}, i.title || i.blockId), ` — ${i.message}`))));

  /** ÚNICO punto de publicación y recuperación: sólo se llama tras una confirmación explícita del administrador. */
  async function act(payload: Record<string, unknown>) {
    const r = await api('/api/admin/home-layout/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1' },
      body: JSON.stringify({ ...payload, confirm: true }),
    });
    return r;
  }
  function explain(r: { status: number; body: any }): string {
    const code = r.body?.code as string | undefined;
    if (r.status === 409 && code === 'conflicto') return 'Otra sesión ha cambiado el borrador. No se ha hecho nada: recarga y vuelve a intentarlo.';
    if (r.status === 409 && code === 'conflicto_publicada') return 'Otra sesión ha publicado una versión mientras tanto. No se ha hecho nada: recarga el historial.';
    if (r.status === 409 && code === 'sin_cambios') return 'No hay nada que hacer: el borrador es idéntico a esa versión.';
    if (r.status === 409 && code === 'borrador_vacio') return 'No hay ningún borrador guardado con bloques que publicar.';
    if (r.status === 409 && code === 'limite_versiones') return 'Se alcanzó el máximo de versiones archivadas. No se borra ninguna automáticamente: consulta con el responsable técnico.';
    if (r.status === 422) return 'Hay errores en las referencias de bloques visibles. No se ha publicado nada: corrígelos y guarda el borrador.';
    if (r.status === 423) return 'El almacenamiento está dañado: no se sobrescribe. Avisa al responsable técnico.';
    if (r.status === 404) return 'Esa versión ya no existe.';
    if (r.status === 401) return 'La sesión ha caducado: vuelve a iniciar sesión.';
    if (r.status === 403) return 'No se pudo verificar el origen de la petición. Recarga la página.';
    if (r.status === 400) return `El servidor rechazó la petición: ${(r.body?.errors ?? [r.body?.message ?? 'petición no válida']).slice(0, 2).join(' · ')}`;
    return 'No se pudo completar la operación. El historial anterior sigue intacto; inténtalo de nuevo.';
  }

  async function startPublish() {
    if (vs.busy) return;
    if (state.dirty) { vsay({ kind: 'error', text: 'Hay cambios sin guardar en el editor. Guarda el borrador (pestaña A) antes de publicar: sólo se publica lo guardado.' }); return; }
    const c = await api('/api/admin/home-layout/versions?check=publish');
    if (c.status !== 200 || !c.body?.success) { vsay({ kind: 'error', text: 'No se pudo comprobar el borrador.' }); return; }
    const chk = c.body as { canPublish: boolean; reasons: string[]; blocking: BlockingIssue[]; warnings: BlockingIssue[]; changes: DiffEntry[]; nextVersion: number; revision: string; basePublished: number | null };
    const REASON: Record<string, string> = {
      archivo_protegido: 'El almacenamiento está protegido (archivo dañado).',
      borrador_vacio: 'No hay un borrador guardado con bloques.',
      referencias_bloqueantes: 'Hay errores de referencias en bloques visibles.',
      sin_cambios: 'El borrador es idéntico a la versión publicada.',
      limite_versiones: 'Se alcanzó el máximo de versiones archivadas.',
    };
    const body = h('div', { class: 'pe-confirm-body' },
      h('p', { class: 'pe-note' }, `Se publicará el borrador guardado como la versión ${chk.nextVersion}. Publicar NO cambia la web: la portada que ven los visitantes es la versión FIJADA al activar (o la portada anterior si no hay ninguna activada). Para cambiarla hay que activar la versión expresamente.`),
      chk.reasons.length ? h('div', {}, h('div', { class: 'pe-sub' }, 'No se puede publicar'), h('ul', { class: 'pe-diff' }, ...chk.reasons.map((x) => h('li', {}, h('span', { class: 'pe-dk is-removed', 'aria-hidden': 'true' }, '⚠'), REASON[x] ?? x)))) : null,
      chk.blocking.length ? h('div', {}, h('div', { class: 'pe-sub' }, `Errores que bloquean (${chk.blocking.length})`), issueList(chk.blocking)) : null,
      chk.warnings.length ? h('div', {}, h('div', { class: 'pe-sub' }, `Avisos (${chk.warnings.length}) — no bloquean`), issueList(chk.warnings)) : null,
      h('div', { class: 'pe-sub' }, vs.published ? `Cambios respecto a la versión publicada (v${vs.published.version})` : 'Contenido que se publicará (primera versión)'),
      diffList(chk.changes, 'Sin cambios.'),
    );
    const ok = await confirmBox(`Publicar internamente la versión ${chk.nextVersion}`, vs.published ? `La versión v${vs.published.version} pasará al historial; no se borra nada.` : 'Será la primera versión publicada.', 'Publicar internamente', false, body, !chk.canPublish);
    if (!ok) return;
    vs.busy = true; renderVersions();
    const r = await act({ action: 'publish', baseRevision: chk.revision, basePublished: chk.basePublished });
    vs.busy = false;
    if (r.status === 200 && r.body?.success) {
      vs.detail = null;
      await loadVersions();
      vsay({ kind: 'ok', text: `Versión ${r.body.version} publicada (${dateTxt(r.body.publishedAt)}). La web pública no ha cambiado: actívala para que la vean los visitantes.` });
    } else { await loadVersions(); vsay({ kind: 'error', text: explain(r) }); }
  }

  async function startRestore(v: VersionSummary) {
    if (vs.busy) return;
    const warn = state.dirty ? ' Además hay cambios SIN GUARDAR en el editor: se perderán.' : '';
    const ok = await confirmBox(`Recuperar la versión ${v.version} como borrador`, `El borrador guardado se sustituirá por el contenido de la versión ${v.version} (${dateTxt(v.publishedAt)}, ${v.blocks} bloques).${warn} La versión publicada y el historial no cambian y la web pública tampoco. Después podrás editar y volver a publicar.`, 'Recuperar como borrador', true);
    if (!ok) return;
    vs.busy = true; renderVersions();
    const r = await act({ action: 'restore', baseRevision: vs.draft.revision, version: v.version });
    vs.busy = false;
    if (r.status === 200 && r.body?.success) {
      vs.detail = null;
      state.dirty = false;
      await load();
      await loadVersions();
      say({ kind: 'ok', text: `Versión ${r.body.version} recuperada como borrador. Revisa el editor y guarda o publica cuando quieras.` });
      await setTab('editor');
    } else { await loadVersions(); vsay({ kind: 'error', text: explain(r) }); }
  }

  /* ---- Portada inicial: cargar, publicar y activar internamente (v1) en una sola acción ---- */
  function initialPanel(): HTMLElement {
    const ini = vs.initial;
    if (!ini || !ini.available) return h('div', { hidden: true });
    const box = h('div', { class: 'pe-box pe-act' }, h('h3', {}, 'Portada inicial'));
    box.append(h('p', { class: 'pe-note' }, 'Todavía no hay ninguna portada. Con un solo paso se cargan 7 bloques que se rellenan solos con los productos reales del catálogo (bienvenida, categorías y los más económicos), se publica la versión 1 y se deja activada internamente. Después podrás modificarlo todo en este editor. La web pública no cambia hasta que el servidor tenga HOME_LAYOUT_ENABLED=true.'));
    box.append(h('ul', { class: 'pe-diff' }, ...ini.blocks.map((b) => h('li', {}, h('span', { class: 'pe-dk is-added', 'aria-hidden': 'true' }, '＋'), h('span', {}, `${b.title} (${b.modality}, ${b.format})`)))));
    if (!ini.check.canLoad) box.append(h('div', {}, h('div', { class: 'pe-sub' }, `No se puede cargar con los datos actuales (${ini.check.blocking.length})`), issueList(ini.check.blocking)));
    box.append(h('div', { class: 'pe-vact' }, h('button', { class: 'pe-btn pe-primary', type: 'button', disabled: vs.busy || !ini.check.canLoad, onclick: () => { void startInitial(); } }, 'Cargar, publicar y activar la portada inicial…')));
    return box;
  }
  async function startInitial() {
    const ini = vs.initial;
    if (vs.busy || !ini || !ini.available) return;
    const body = h('div', { class: 'pe-confirm-body' },
      h('p', { class: 'pe-note' }, `Se guardarán ${ini.check.totalBlocks} bloques como borrador, se publicará la versión 1 y quedará fijada y activada internamente (${ini.check.visibleBlocks} de ${ini.check.totalBlocks} bloques se mostrarían). No se sobrescribe nada: solo funciona si todavía no existe ninguna portada. ${ini.gates.env ? 'ATENCIÓN: el servidor ya tiene HOME_LAYOUT_ENABLED=true, así que la portada nueva se verá públicamente al confirmar.' : 'La web seguirá mostrando la portada actual hasta definir HOME_LAYOUT_ENABLED=true en el servidor.'} Podrás volver a la portada anterior con «Desactivar».`),
      ini.check.warnings.length ? h('div', {}, h('div', { class: 'pe-sub' }, `Avisos (${ini.check.warnings.length}) — no bloquean`), issueList(ini.check.warnings)) : null);
    if (!(await confirmBox('Cargar la portada inicial', 'Se cargan, publican y activan internamente los 7 bloques de la portada inicial.', 'Cargar y activar', false, body, !ini.check.canLoad))) return;
    vs.busy = true; renderVersions();
    const r = await api('/api/admin/home-layout/initial', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1' }, body: JSON.stringify({ action: 'load_initial', baseRevision: ini.draftRevision, baseActivation: ini.activationRevision, confirm: true }) });
    vs.busy = false;
    if (r.status === 200 && r.body?.success) {
      state.dirty = false;
      await load();
      await loadVersions();
      vsay({ kind: 'ok', text: `Portada inicial cargada: versión ${r.body.version} publicada y activada internamente.${r.body.envEnabled ? '' : ' La web pública no cambia hasta definir HOME_LAYOUT_ENABLED=true en el servidor.'}` });
    } else {
      await loadVersions();
      vsay({ kind: 'error', text: r.status === 409 ? 'Ya existe una portada o el estado cambió: no se ha sobrescrito nada.' : r.status === 422 ? 'Hay bloques que no se pueden mostrar con los datos actuales: no se ha cargado nada.' : r.status === 423 ? 'El almacenamiento está protegido: no se sobrescribe.' : 'No se pudo cargar la portada inicial. La web sigue como estaba.' });
    }
  }

  /* ---- Activación (etapa 6) ---- */
  function activationPanel(): HTMLElement {
    const a = vs.act;
    const box = h('div', { class: 'pe-box pe-act' }, h('h3', {}, 'Activación de la portada nueva'));
    if (!a) { box.append(h('p', { class: 'pe-note' }, vs.loaded ? 'No se pudo leer el estado de la activación.' : 'Cargando…')); return box; }
    const g = a.gates;
    const gate = (ok: boolean, label: string, hint: string) => h('li', { class: ok ? 'pe-ok' : 'pe-warn' }, `${ok ? '✔' : '✖'} ${label}`, h('small', {}, ` — ${hint}`));
    box.append(h('p', { class: 'pe-note' }, 'La portada nueva solo se muestra si están abiertos los tres candados. Activar fija una versión: publicar otra después no cambia la web.'),
      h('ul', { class: 'pe-gates', 'aria-label': 'Candados de la portada nueva' },
        gate(g.stage, 'Candado del código', g.stage ? 'abierto' : 'cerrado en esta versión del código'),
        gate(g.env, 'Variable HOME_LAYOUT_ENABLED del servidor', g.env ? 'activada' : 'no activada (la configura quien administra el servidor)'),
        gate(g.adminFlag && g.activeFile, 'Activación del administrador', g.adminFlag && g.activeFile ? `activa · versión fijada v${g.pinnedVersion}` : 'desactivada')));
    const on = g.adminFlag && g.activeFile;
    box.append(h('div', { class: 'pe-vact' },
      h('button', { class: 'pe-btn pe-primary', type: 'button', disabled: vs.busy || !vs.published, onclick: () => { void startActivate(); } }, vs.published ? `${on && g.pinnedVersion === vs.published.version ? 'Revalidar' : 'Activar'} v${vs.published.version}…` : 'Activar…'),
      h('button', { class: 'pe-btn pe-danger', type: 'button', disabled: vs.busy || !(on || g.adminFlag || g.activeFile), onclick: () => { void startDeactivate(); } }, 'Desactivar (volver a la portada de siempre)…')));
    if (a.log.length) box.append(h('details', {}, h('summary', {}, `Registro de operaciones (${a.log.length})`), h('ul', { class: 'pe-diff' }, ...a.log.slice(0, 10).map((e) => h('li', {}, h('span', { class: `pe-dk ${e.result === 'ok' ? 'is-added' : 'is-removed'}`, 'aria-hidden': 'true' }, e.result === 'ok' ? '✔' : '✖'), h('span', {}, `${dateTxt(e.at)} · ${e.by} · ${e.action === 'activate' ? 'activar' : 'desactivar'}${e.version ? ` v${e.version}` : ''} · ${e.result}${e.note ? ` (${e.note})` : ''}`))))));
    return box;
  }
  async function actApi(payload: Record<string, unknown>) {
    return api('/api/admin/home-layout/activation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1' }, body: JSON.stringify({ ...payload, confirm: true }) });
  }
  async function startActivate() {
    if (vs.busy || !vs.published || !vs.act) return;
    const n = vs.published.version;
    const c = await api(`/api/admin/home-layout/activation?check=${n}`);
    if (c.status !== 200 || !c.body?.success) { vsay({ kind: 'error', text: 'No se pudo comprobar la versión.' }); return; }
    const chk = c.body.check as { canActivate: boolean; blocking: BlockingIssue[]; warnings: BlockingIssue[]; visibleBlocks: number; totalBlocks: number };
    const body = h('div', { class: 'pe-confirm-body' },
      h('p', { class: 'pe-note' }, `Se FIJARÁ la versión ${n} (${chk.visibleBlocks} de ${chk.totalBlocks} bloques se mostrarían). ${vs.act.gates.env ? 'Los visitantes verán la portada nueva en cuanto confirmes.' : 'El servidor no tiene HOME_LAYOUT_ENABLED=true: los visitantes seguirán viendo la portada de siempre hasta que se active.'} Puedes volver a la portada anterior en cualquier momento con «Desactivar».`),
      chk.blocking.length ? h('div', {}, h('div', { class: 'pe-sub' }, `Errores que impiden activar (${chk.blocking.length})`), issueList(chk.blocking)) : null,
      chk.warnings.length ? h('div', {}, h('div', { class: 'pe-sub' }, `Avisos (${chk.warnings.length}) — no bloquean`), issueList(chk.warnings)) : null);
    if (!(await confirmBox(`Activar la versión ${n}`, 'Esta acción cambia lo que ven los visitantes (si el servidor lo permite).', 'Activar portada nueva', false, body, !chk.canActivate))) return;
    vs.busy = true; renderVersions();
    const r = await actApi({ action: 'activate', version: n, baseRevision: vs.act.revision });
    vs.busy = false;
    await loadVersions();
    vsay(r.status === 200 && r.body?.success ? { kind: 'ok', text: `Versión ${n} activada y fijada.${r.body.envEnabled ? '' : ' (El servidor aún no tiene HOME_LAYOUT_ENABLED=true: la web no cambia.)'}` } : { kind: 'error', text: r.status === 409 ? 'El estado cambió desde que lo viste (o la versión ya está activa). Recarga e inténtalo de nuevo.' : r.status === 422 ? 'La versión tiene errores que impiden activarla.' : r.status === 423 ? 'El almacenamiento está protegido: no se sobrescribe.' : 'No se pudo activar. La web sigue como estaba.' });
  }
  async function startDeactivate() {
    if (vs.busy || !vs.act) return;
    if (!(await confirmBox('Desactivar la portada nueva', 'La web pública volverá a la portada de siempre de inmediato. No se borra ninguna versión ni ningún borrador.', 'Desactivar ahora', true))) return;
    vs.busy = true; renderVersions();
    const r = await actApi({ action: 'deactivate' });
    vs.busy = false;
    await loadVersions();
    vsay(r.status === 200 && r.body?.success ? { kind: 'ok', text: 'Portada nueva desactivada: los visitantes ven la portada de siempre.' } : { kind: 'error', text: r.body?.message ?? 'No se pudo desactivar.' });
  }

  /** Franja global (maqueta v3): última versión publicada, portada servida y acciones frecuentes, visible en las tres pestañas. */
  const gstrip = h('div', { class: 'pe-gstrip' });
  tabs.before(gstrip);
  function renderGlobal() {
    clear(gstrip);
    const v = validation();
    const canSave = state.loaded && state.dirty && v.ok && state.writable && !state.busy && !state.conflict;
    gstrip.append(
      h('span', { class: 'pe-note' }, vs.published ? `Última versión publicada: v${vs.published.version} · ${dateTxt(vs.published.publishedAt)}` : 'Aún no hay versión publicada'),
      h('span', { class: `pe-chip-s${vs.mode === 'layout' ? '' : ' is-alt'}` }, vs.mode === 'layout' ? 'Web: portada nueva' : 'Web: portada de siempre'),
      h('span', { class: 'pe-grow' }),
      h('button', { class: 'pe-btn', type: 'button', disabled: !canSave, onclick: () => { void save(); } }, 'Guardar borrador'),
      h('button', { class: 'pe-btn pe-primary', type: 'button', disabled: vs.busy, onclick: async () => { await setTab('versions'); void startPublish(); } }, 'Publicar…'));
  }

  function renderVersions() {
    renderGlobal();
    clear(versionsPane);
    const head = h('div', { class: 'pe-vhead' },
      h('div', { class: 'pe-vcard' }, h('div', { class: 'pe-sub' }, 'Borrador actual'),
        h('b', {}, state.dirty ? '✎ Cambios sin guardar en el editor' : vs.draft.revision === 'inicial' ? '✎ Sin borrador guardado' : `✎ Guardado · ${dateTxt(vs.draft.revision)}`),
        h('small', {}, `${vs.draft.blocks} bloques en el servidor`)),
      h('div', { class: 'pe-vcard' }, h('div', { class: 'pe-sub' }, 'Última versión publicada'),
        vs.published ? h('b', {}, `v${vs.published.version} · ${dateTxt(vs.published.publishedAt)}`) : h('b', {}, 'Ninguna todavía'),
        h('small', {}, vs.published ? `${vs.published.blocks} bloques · ${vs.act?.gates.pinnedVersion === vs.published.version && vs.mode === 'layout' ? 'es la que ven los visitantes' : 'no se muestra hasta activarla'}` : 'Nada se ha publicado')),
      h('div', { class: 'pe-vcard' }, h('div', { class: 'pe-sub' }, 'Portada servida a los visitantes'),
        h('b', {}, vs.mode === 'layout' ? `Portada nueva · versión fijada v${vs.act?.gates.pinnedVersion ?? '?'}` : 'La portada de siempre'),
        h('small', {}, vs.mode === 'layout' ? 'Activada y en servicio.' : 'La portada nueva no se está mostrando.')));
    const actions = h('div', { class: 'pe-vact' },
      h('button', { class: 'pe-btn pe-primary', type: 'button', disabled: !vs.loaded || vs.busy || vs.storage !== 'ok' && vs.storage !== 'missing', onclick: () => { void startPublish(); }, title: state.dirty ? 'Guarda antes el borrador (pestaña A)' : '' }, vs.busy ? 'Trabajando…' : 'Publicar borrador…'),
      h('button', { class: 'pe-btn', type: 'button', disabled: !vs.published || vs.busy, onclick: () => { void compareWith('published', 'draft', 'Publicada → borrador guardado'); } }, 'Comparar publicada con borrador'),
      h('button', { class: 'pe-btn', type: 'button', disabled: vs.loading, onclick: () => { void loadVersions(); } }, 'Actualizar'),
      state.dirty ? h('span', { class: 'pe-note pe-warn' }, 'Hay cambios sin guardar: sólo se publica lo guardado.') : null);
    versionsPane.append(head, initialPanel(), actions, activationPanel());
    if (vs.msg) versionsPane.append(h('p', { class: `pe-msg is-${vs.msg.kind}`, role: vs.msg.kind === 'error' ? 'alert' : undefined }, vs.msg.text));
    if (vs.loading && !vs.loaded) { versionsPane.append(h('p', { class: 'pe-empty' }, 'Cargando el historial…')); return; }
    if (vs.error) { versionsPane.append(h('p', { class: 'pe-msg is-error', role: 'alert' }, vs.error)); return; }
    if (vs.storage !== 'ok' && vs.storage !== 'missing') versionsPane.append(h('p', { class: 'pe-msg is-error', role: 'alert' }, `El almacenamiento está en estado «${vs.storage}»: se conserva sin sobrescribir.`));

    const table = h('div', { class: 'pe-vtable', role: 'table', 'aria-label': 'Historial de versiones' });
    table.append(h('div', { class: 'pe-vrow is-head', role: 'row' }, ...['Versión', 'Estado', 'Fecha', 'Bloques', 'Acciones'].map((t) => h('div', { role: 'columnheader' }, t))));
    if (!vs.versions.length) table.append(h('p', { class: 'pe-empty' }, 'Todavía no hay versiones. Guarda un borrador y publícalo internamente para crear la primera.'));
    for (const v of vs.versions) {
      table.append(h('div', { class: 'pe-vrow', role: 'row' },
        h('div', { role: 'cell', 'data-l': 'Versión' }, h('b', {}, `v${v.version}`)),
        h('div', { role: 'cell', 'data-l': 'Estado' }, h('span', { class: `pe-chip-s${v.state === 'published' ? '' : ' is-alt'}` }, v.state === 'published' ? 'Publicada internamente' : 'Archivada')),
        h('div', { role: 'cell', 'data-l': 'Fecha' }, dateTxt(v.publishedAt)),
        h('div', { role: 'cell', 'data-l': 'Bloques' }, String(v.blocks)),
        h('div', { role: 'cell', class: 'pe-vbtns' },
          h('button', { class: 'pe-btn pe-sm', type: 'button', disabled: vs.busy, 'aria-label': `Previsualizar la versión ${v.version}`, onclick: () => { void showVersion(v.version); } }, 'Previsualizar'),
          h('button', { class: 'pe-btn pe-sm', type: 'button', disabled: vs.busy, 'aria-label': `Comparar la versión ${v.version} con el borrador`, onclick: () => { void compareWith(String(v.version), 'draft', `v${v.version} → borrador guardado`); } }, 'Comparar con borrador'),
          h('button', { class: 'pe-btn pe-sm', type: 'button', disabled: vs.busy || vs.storage !== 'ok', 'aria-label': `Recuperar la versión ${v.version} como borrador`, onclick: () => { void startRestore(v); } }, 'Recuperar como borrador'))));
    }
    versionsPane.append(table, h('p', { class: 'pe-note' }, `Máximo de ${vs.maxVersions} versiones. Nunca se elimina una versión: al llegar al límite no se podrá publicar hasta decidir una política de retención.`));

    if (vs.detail) {
      const d = vs.detail;
      const box = h('div', { class: 'pe-vdetail' }, h('h3', {}, d.title, h('button', { class: 'pe-btn pe-sm', type: 'button', onclick: () => { vs.detail = null; renderVersions(); } }, 'Cerrar')));
      if (d.kind === 'compare') {
        box.append(diffList(d.changes ?? [], 'Sin diferencias.'));
        versionsPane.append(box);
      } else {
        const blocks = d.blocks ?? [];
        const dsk = pvFrame('Escritorio', false, blocks, d.chip ?? '', d.data ?? {});
        const mob = pvFrame('Móvil', true, blocks, d.chip ?? '', d.data ?? {});
        box.append(blocks.length ? h('div', { class: 'pe-previews' }, dsk, mob) : h('p', { class: 'pe-note' }, 'Esta versión no tiene bloques.'), previewNote());
        versionsPane.append(box);
        scalePreviews([[dsk, 1200], [mob, 390]]);
      }
    }
  }

  function applyFocus() {
    if (!focusKey) return;
    const el = root.querySelector(`[data-fk="${focusKey}"]`) as HTMLElement | null;
    focusKey = null;
    el?.focus();
  }
  function renderAll() {
    renderToolbar();
    renderAddbar();
    renderCanvas();
    renderProps();
    renderPreviews();
    applyFocus();
  }
  window.addEventListener('resize', () => { if (state.loaded) renderPreviews(); });

  const stories = initHomeLayoutStories(storiesPane, { api, confirmBox, announce: (t) => { live.textContent = t; } });
  renderTabs();
  renderVersions();
  renderAll();
  void load();
  void loadVersions();
}
