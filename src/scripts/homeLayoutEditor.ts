/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · EDITOR VISUAL DEL BORRADOR (etapa 3, navegador)
 * ==============================================================================
 * Monta el editor dentro de `#homeLayoutEditor` (página /upayp1b4/portada). Todo el contenido dinámico se crea con `textContent` (nunca
 * `innerHTML`). Solo trabaja sobre el BORRADOR:
 *   · carga con GET /api/admin/home-layout/draft (no guarda nada al cargar);
 *   · guarda ÚNICAMENTE cuando el administrador pulsa «Guardar borrador» (PUT con control de revisiones);
 *   · no publica, no activa la portada nueva y no modifica el catálogo, las secciones ni las categorías.
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

/* ───────────────────────── Tipos de las API de lectura ───────────────────────── */
interface Issue { severity: 'error' | 'warning' | 'info'; code: string; message: string }
interface ResolvedBlock { id: string; visible: boolean | null; items: number; valid: number; issues: Issue[]; refs: Array<{ kind: string; id: string; label?: string; status: string }> }
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
  };
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
  root.append(
    toolbar,
    banner,
    addbar,
    h('div', { class: 'pe-main' }, h('div', {}, canvasWrap, h('p', { class: 'pe-note' }, 'Arrastra ⠿ o usa ▲ ▼ para ordenar · pulsa un ancho para cambiarlo. Los bloques no se muestran en la web con una búsqueda o categoría activa. Solo se guarda al pulsar «Guardar borrador»; nada se publica.')), props),
    previews,
    live,
    modal,
  );

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
  function touch() {
    state.dirty = isDirty();
    state.resolvedStale = true;
    renderToolbar();
    renderCanvas();
    renderPreviews();
  }
  function setBlocks(next: Block[], opts: { focus?: string } = {}) {
    state.blocks = next;
    if (opts.focus) focusKey = opts.focus;
    state.dirty = isDirty();
    state.resolvedStale = true;
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
  async function loadResolved() {
    const r = await api('/api/admin/home-layout/resolve?source=draft');
    if (r.status === 200) {
      state.resolved = new Map((r.body.blocks as ResolvedBlock[]).map((b) => [b.id, b]));
      for (const b of r.body.blocks as ResolvedBlock[]) for (const ref of b.refs) if (ref.label) info.set(`${ref.kind}:${ref.id}`, { label: ref.label, price: info.get(`${ref.kind}:${ref.id}`)?.price });
      state.resolvedStale = false;
    }
  }
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
  function confirmBox(title: string, text: string, ok: string, danger = false): Promise<boolean> {
    return new Promise((resolve) => {
      const previous = document.activeElement as HTMLElement | null;
      const done = (v: boolean) => { modal.hidden = true; clear(modal); document.removeEventListener('keydown', onKey); previous?.focus?.(); resolve(v); };
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') done(false); };
      clear(modal);
      const yes = h('button', { class: danger ? 'pe-btn pe-danger' : 'pe-btn pe-primary', type: 'button', onclick: () => done(true) }, ok);
      modal.append(
        h('div', { class: 'pe-backdrop', onclick: () => done(false) }),
        h('div', { class: 'pe-dialog' }, h('h3', {}, title), h('p', {}, text), h('div', { class: 'pe-row-end' }, h('button', { class: 'pe-btn', type: 'button', onclick: () => done(false) }, 'Cancelar'), yes)),
      );
      modal.setAttribute('aria-label', title);
      modal.hidden = false;
      document.addEventListener('keydown', onKey);
      yes.focus();
    });
  }

  /* ---- Barra superior ---- */
  function renderToolbar() {
    clear(toolbar);
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
    if (b.modality === 'automatica') return h('div', { class: 'pe-thumbs' }, h('span', { class: 'pe-banner-th' }, 'Selección automática (no ejecutada)'));
    const refs = b.refs.slice(0, n);
    if (!refs.length) return h('div', { class: 'pe-thumbs' }, h('span', { class: 'pe-banner-th is-empty' }, 'Sin contenido: complétalo'));
    return h('div', { class: 'pe-thumbs' }, ...refs.map((r) => h('span', { title: labelOf(r) }, labelOf(r).slice(0, 14))));
  }
  function statusBadge(b: Block): HTMLElement | null {
    const rb = state.resolved.get(b.id);
    if (!rb) return h('span', { class: 'pe-badge' }, 'Sin comprobar');
    if (state.resolvedStale) return h('span', { class: 'pe-badge', title: 'Guarda el borrador para actualizar la comprobación' }, 'Comprobación pendiente');
    const errs = rb.issues.filter((i) => i.severity === 'error').length;
    const warns = rb.issues.filter((i) => i.severity === 'warning').length;
    const vis = rb.visible === true ? '✓ Se mostraría' : rb.visible === false ? '● No se mostraría' : '? Visibilidad sin evaluar';
    return h('span', { class: `pe-badge ${rb.visible === false ? 'is-err' : errs || warns ? 'is-warn' : 'is-ok'}`, title: rb.issues.map((i) => i.message).slice(0, 6).join('\n') }, `${vis}${errs ? ` · ${errs} error(es)` : ''}${warns ? ` · ${warns} aviso(s)` : ''}`);
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
      state.dirty = isDirty(); state.resolvedStale = true; renderAll();
    } }, ...optionList(catalog.sections.map((s) => ({ value: s.id, label: `${s.title}${s.published ? '' : ' (no publicada)'} · ${s.validProductCount}/${s.productCount} productos` })), cur, 'Elige una sección…'));
    const s = catalog.sections.find((x) => x.id === cur);
    return h('div', {},
      field('Sección de «Catálogo → Crear sección»', sel, 'Se referencia por identificador: no se copian los productos.'),
      cur && !s ? h('p', { class: 'pe-note pe-warn' }, 'Esta sección ya no existe en el catálogo.') : null,
      s && !s.published ? h('p', { class: 'pe-note pe-warn' }, 'La sección no está publicada: el bloque no se mostraría.') : null);
  }

  function automaticEditor(b: Block): HTMLElement {
    const rules = (b.config as { rules: { categoryId?: string; subcategoryId?: string; merchant?: string; order: string; limit: number; onlyWithPrice?: boolean } }).rules;
    const roots = catalog.categories.filter((c) => !c.parentId);
    const subs = catalog.categories.filter((c) => c.parentId && c.parentId === rules.categoryId);
    return h('div', {},
      h('p', { class: 'pe-note pe-warn' }, 'La selección automática se podrá configurar pero todavía NO se ejecuta: aquí solo se guardan las reglas.'),
      field('Categoría', h('select', { onchange: (e: any) => { patchRules(b.id, { categoryId: e.target.value, subcategoryId: '' }); renderProps(); } }, ...optionList(roots.map((c) => ({ value: c.id, label: c.name })), rules.categoryId, 'Cualquiera'))),
      field('Subcategoría', h('select', { disabled: !subs.length, onchange: (e: any) => patchRules(b.id, { subcategoryId: e.target.value }) }, ...optionList(subs.map((c) => ({ value: c.id, label: c.name })), rules.subcategoryId, subs.length ? 'Cualquiera' : 'Sin subcategorías'))),
      field('Comercio o plataforma', h('select', { onchange: (e: any) => patchRules(b.id, { merchant: e.target.value }) }, ...optionList(catalog.merchants.map((m) => ({ value: m.id, label: `${m.id} (${m.productCount})` })), rules.merchant, 'Cualquiera'))),
      field('Orden', h('select', { onchange: (e: any) => patchRules(b.id, { order: e.target.value }) }, ...optionList(Object.entries(ORDER_LABEL).map(([value, label]) => ({ value, label })), rules.order)), 'Solo criterios con datos fiables: no hay descuentos, bajadas de precio ni ventas.'),
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
  function pvCard(label: string, price?: number | null): HTMLElement {
    return h('div', { class: 'pv-card' }, h('div', { class: 'pv-im' }, '🖼'), h('div', { class: 'pv-tt' }, label), price ? h('div', { class: 'pv-pr' }, eur(price)) : null);
  }
  function pvBlock(b: Block, mobile: boolean): HTMLElement {
    const span = mobile ? (b.width === 3 ? 6 : 12) : b.width;
    const el = h('div', { class: `pv-bk${b.visible ? '' : ' is-off'}`, style: `grid-column: span ${span}` });
    const title = b.modality === 'editorial' ? (b.config as { headline?: string }).headline || b.title : b.title;
    if (!b.visible) el.append(h('div', { class: 'pv-hidden' }, `Oculto: ${b.title}`));
    else if (b.modality === 'editorial') {
      const c = b.config as { text?: string; buttonLabel?: string };
      el.append(h('div', { class: 'pv-ban' }, h('h4', {}, title), c.text ? h('p', {}, c.text) : null, c.buttonLabel ? h('span', { class: 'pv-btn' }, c.buttonLabel) : null));
    } else if (b.modality === 'automatica') {
      const r = (b.config as { rules: { categoryId?: string; merchant?: string; order: string; limit: number } }).rules;
      el.append(h('div', { class: 'pv-bt' }, b.title), h('div', { class: 'pv-auto' }, `Selección automática · ${r.categoryId ? labelOf({ kind: 'category', id: r.categoryId }) : 'todas las categorías'}${r.merchant ? ` · ${r.merchant}` : ''} · ${ORDER_LABEL[r.order] ?? r.order} · hasta ${r.limit} (sin ejecutar)`));
    } else if (b.modality === 'seccion') {
      const r = b.refs[0];
      el.append(h('div', { class: 'pv-bt' }, b.title), r ? h('div', { class: 'pv-auto' }, `Sección «${labelOf(r)}» (se resuelve al publicar)`) : h('div', { class: 'pv-hidden' }, 'Elige una sección'));
    } else {
      const items = b.refs.slice(0, b.format === 'cuadricula2x2' ? 4 : 8);
      const cards = items.map((r) => pvCard(labelOf(r), info.get(key(r))?.price));
      el.append(h('div', { class: 'pv-bt' }, b.title), items.length ? h('div', { class: b.format === 'cuadricula2x2' ? 'pv-grid' : 'pv-rail' }, ...cards) : h('div', { class: 'pv-hidden' }, 'Sin elementos'));
    }
    return el;
  }
  function pvFrame(label: string, mobile: boolean): HTMLElement {
    const inner = h('div', { class: `pv${mobile ? ' is-m' : ''}` },
      h('div', { class: 'pv-hd' }, h('b', {}, 'Treidilor'), h('span', {}, '🔍 Buscar productos…')),
      h('div', { class: 'pv-grid12' }, ...state.blocks.map((b) => pvBlock(b, mobile))));
    const win = h('div', { class: `pe-pvwin${mobile ? ' is-phone' : ''}` }, inner);
    return h('div', { class: 'pe-pvbox' }, h('h3', {}, label, h('span', { class: 'pe-chip-s' }, state.dirty ? 'con cambios sin guardar' : 'borrador guardado')), win);
  }
  function renderPreviews() {
    clear(previews);
    const d = pvFrame('Vista previa · escritorio', false);
    const m = pvFrame('Vista previa · móvil', true);
    previews.append(d, m);
    // Escala: escritorio = 1200 px virtuales; móvil = 390 px virtuales.
    for (const [box, nat] of [[d, 1200], [m, 390]] as Array<[HTMLElement, number]>) {
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

  renderAll();
  void load();
}
