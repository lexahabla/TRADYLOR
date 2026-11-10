/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · PESTAÑA C «HISTORIAS» (etapa 5, navegador)
 * ==============================================================================
 * Se monta dentro de la pestaña C del editor (`homeLayoutEditor.ts`). Sigue la maqueta v3 aprobada: lista de historias reordenable (los círculos
 * bajo la cabecera, en ese orden), tira de pantallas, formulario de la pantalla y visor vertical 9:16 en escritorio y móvil. Todo el contenido
 * dinámico se crea con `textContent` (nunca `innerHTML`).
 *   · carga con GET /api/admin/home-layout/stories (no guarda nada al cargar);
 *   · guarda ÚNICAMENTE al pulsar «Guardar historias» (PUT con control de revisiones); no hay guardado automático;
 *   · «Publicada» se muestra en la web SOLO con la portada nueva activada y sin errores (etapa 6); un borrador nunca se muestra;
 *   · las imágenes se eligen del catálogo o se suben con la API existente `/api/admin/upload-image` (sin modificarla).
 * ==============================================================================
 */

import {
  DURATIONS,
  MAX_SCREENS,
  MAX_STORIES,
  addScreen,
  addStory,
  coverOf,
  createStory,
  duplicateStory,
  moveScreen,
  moveStory,
  removeScreen,
  removeStory,
  updateScreen,
  updateStory,
  validateStories,
  type Story,
  type StoryIssue,
  type StoryLink,
  type StoryLinkType,
  type StoryScreen,
} from '../lib/homeLayout/stories';

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

export interface StoriesDeps {
  api: (path: string, init?: RequestInit) => Promise<{ status: number; body: any }>;
  confirmBox: (title: string, text: string, ok: string, danger?: boolean) => Promise<boolean>;
  announce: (text: string) => void;
}
interface CatalogItem { id: string; title: string; price: number | null; image: string | null }
interface CatOption { id: string; name: string; parentId: string | null }
type Msg = { kind: 'ok' | 'error' | 'info'; text: string } | null;

const LINK_LABEL: Record<StoryLinkType, string> = { product: 'Producto', category: 'Categoría', campaign: 'Campaña (ruta propia)' };
const FALLBACK_IMAGE = '/images/products/placeholder.jpg';

export function initHomeLayoutStories(root: HTMLElement, deps: StoriesDeps): { activate: () => void } {
  const { api, confirmBox, announce } = deps;
  const S = {
    stories: [] as Story[],
    saved: '[]',
    revision: 'inicial',
    storage: 'missing',
    writable: true,
    loaded: false,
    loading: false,
    dirty: false,
    busy: false,
    conflict: false,
    story: null as string | null,
    screen: 0,
    device: 'desktop' as 'desktop' | 'mobile',
    viewing: 0,
    issues: [] as StoryIssue[],
    msg: null as Msg,
    blocking: [] as StoryIssue[],
    picker: { open: true, q: '', items: [] as CatalogItem[], loading: false, error: '' },
    uploading: false,
  };
  const categories: CatOption[] = [];
  const labels = new Map<string, string>();
  let catalogLoaded = false;
  let pickTimer: number | undefined;
  let destTimer: number | undefined;
  let destResults: Array<{ id: string; title: string; price: number | null }> = [];
  let destQuery = '';
  let focusKey: string | null = null;

  const board = h('div', { class: 'ps-wrap' });
  root.append(board);

  const cur = () => S.stories.find((s) => s.id === S.story) ?? null;
  const isDirty = () => JSON.stringify(S.stories) !== S.saved;
  const say = (m: Msg) => { S.msg = m; if (m) announce(m.text); render(); };
  const validation = () => validateStories(S.stories);

  /* ---- Carga y guardado ---- */
  async function load() {
    S.loading = true; render();
    const r = await api('/api/admin/home-layout/stories');
    S.loading = false;
    if (r.status !== 200 || !r.body?.success) { say({ kind: 'error', text: r.status === 401 ? 'La sesión ha caducado: vuelve a iniciar sesión.' : 'No se pudieron cargar las historias.' }); return; }
    S.stories = r.body.stories;
    S.saved = JSON.stringify(r.body.stories);
    S.revision = r.body.revision;
    S.storage = r.body.storage.status;
    S.writable = r.body.writable;
    S.issues = r.body.issues;
    S.loaded = true; S.dirty = false; S.conflict = false; S.blocking = [];
    if (!S.story || !S.stories.some((s) => s.id === S.story)) { S.story = S.stories[0]?.id ?? null; S.screen = 0; S.viewing = 0; }
    if (!catalogLoaded) { catalogLoaded = true; void loadCategories(); void searchCatalog(''); }
    render();
  }
  async function loadCategories() {
    const r = await api('/api/admin/home-layout/options?kind=category&limit=50');
    if (r.status === 200) { categories.splice(0, categories.length, ...r.body.items); for (const c of categories) labels.set(`category:${c.id}`, c.name); render(); }
  }
  async function save() {
    if (S.busy) return;
    const v = validation();
    if (!v.ok) { say({ kind: 'error', text: 'Hay historias o pantallas incompletas: complétalas antes de guardar.' }); return; }
    S.busy = true; S.blocking = []; render();
    const r = await api('/api/admin/home-layout/stories', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1' },
      body: JSON.stringify({ baseRevision: S.revision, stories: S.stories }),
    });
    S.busy = false;
    if (r.status === 200 && r.body?.success) {
      S.stories = r.body.stories; S.saved = JSON.stringify(r.body.stories); S.revision = r.body.revision; S.issues = r.body.issues; S.dirty = false; S.conflict = false; S.storage = 'ok';
      say({ kind: 'ok', text: `Historias guardadas (${new Date(r.body.savedAt).toLocaleTimeString('es-ES')}). Las «publicadas» lo están sólo internamente: la web pública no cambia.` });
    } else if (r.status === 409) {
      S.conflict = true;
      say({ kind: 'error', text: 'Otra sesión ha guardado las historias después de que las cargaras. Tus cambios NO se han guardado: recarga la versión del servidor (se descartan tus cambios locales).' });
    } else if (r.status === 422) {
      S.blocking = r.body?.blocking ?? [];
      say({ kind: 'error', text: 'Hay historias con errores que no pueden quedar como publicadas: corrígelas o déjalas en borrador. No se ha guardado nada.' });
    } else if (r.status === 423) say({ kind: 'error', text: 'El almacenamiento de historias está dañado: no se sobrescribe. Avisa al responsable técnico.' });
    else if (r.status === 400) say({ kind: 'error', text: `El servidor rechazó las historias: ${(r.body?.errors ?? [r.body?.message]).slice(0, 2).join(' · ')}` });
    else if (r.status === 401) say({ kind: 'error', text: 'La sesión ha caducado: vuelve a iniciar sesión (los cambios siguen en esta página).' });
    else if (r.status === 403) say({ kind: 'error', text: 'No se pudo verificar el origen de la petición. Recarga la página.' });
    else say({ kind: 'error', text: 'No se pudieron guardar las historias. Inténtalo de nuevo; las anteriores siguen intactas.' });
  }
  async function reload() {
    if (S.dirty && !(await confirmBox('Recargar las historias del servidor', 'Se descartarán los cambios que no hayas guardado.', 'Descartar y recargar', true))) return;
    await load();
    say({ kind: 'info', text: 'Historias recargadas desde el servidor.' });
  }
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---- Cambios ---- */
  function set(next: Story[], opts: { story?: string | null; screen?: number; focus?: string } = {}) {
    S.stories = next;
    if (opts.story !== undefined) S.story = opts.story;
    if (opts.screen !== undefined) S.screen = opts.screen;
    if (opts.focus) focusKey = opts.focus;
    const st = cur();
    if (st) { S.screen = Math.max(0, Math.min(S.screen, st.screens.length - 1)); S.viewing = Math.max(0, Math.min(S.viewing, st.screens.length - 1)); }
    S.dirty = isDirty();
    render();
  }
  const patchScreen = (patch: Partial<StoryScreen>) => { const st = cur(); if (st) set(updateScreen(S.stories, st.id, S.screen, patch)); };
  const setLinkPatch = (link: StoryLink | undefined) => {
    const st = cur(); if (!st) return;
    const sc = st.screens[S.screen];
    const next: StoryScreen = { ...sc };
    if (link) next.link = link; else delete next.link;
    set(S.stories.map((x) => (x.id === st.id ? { ...x, screens: x.screens.map((y, i) => (i === S.screen ? next : y)) } : x)));
  };
  /* ---- Selector de imágenes (catálogo) y subida ---- */
  async function searchCatalog(q: string) {
    S.picker.q = q; S.picker.loading = true; S.picker.error = ''; renderPicker();
    const r = await api(`/api/admin/home-layout/preview?catalog=${encodeURIComponent(q)}&limit=12`);
    S.picker.loading = false;
    if (r.status === 200) S.picker.items = r.body.items; else { S.picker.items = []; S.picker.error = 'No se pudo buscar en el catálogo'; }
    renderPicker();
  }
  async function upload(file: File) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { say({ kind: 'error', text: 'Formato no admitido: usa JPG, PNG o WebP.' }); return; }
    S.uploading = true; render();
    const fd = new FormData();
    fd.append('images', file);
    let url = '';
    try {
      const res = await fetch('/api/admin/upload-image', { method: 'POST', body: fd, credentials: 'same-origin' });
      const b = await res.json().catch(() => null);
      url = res.ok && b?.success && Array.isArray(b.urls) ? String(b.urls[0] ?? '') : '';
      if (!url) say({ kind: 'error', text: b?.message ? `No se pudo subir la imagen: ${String(b.message).slice(0, 120)}` : 'No se pudo subir la imagen.' });
    } catch {
      say({ kind: 'error', text: 'No se pudo contactar con el servicio de imágenes.' });
    }
    S.uploading = false;
    if (url) { patchScreen({ image: url }); say({ kind: 'ok', text: 'Imagen subida y asignada a la pantalla (sin guardar todavía).' }); } else render();
  }

  /* ---- Vistas ---- */
  const img = (src: string, cls = '') => h('img', { src: src || FALLBACK_IMAGE, alt: '', class: cls, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e: any) => { e.target.style.visibility = 'hidden'; } });
  const issuesOf = (id: string, idx?: number) => S.issues.filter((i) => i.storyId === id && (idx === undefined || i.screenIndex === idx || i.screenIndex === undefined));
  const chip = (s: Story) => h('span', { class: `pe-chip-s${s.status === 'publicada' ? '' : ' is-alt'}` }, s.status === 'publicada' ? 'Publicada' : 'Borrador');

  function renderList(): HTMLElement {
    const box = h('aside', { class: 'pe-box ps-list' }, h('h3', {}, 'Historias'),
      h('p', { class: 'pe-note' }, 'Aparecen como círculos bajo la cabecera, en este orden. Son propias de Treidilor (sin Instagram por ahora).'));
    const ul = h('div', { role: 'list', 'aria-label': 'Historias' });
    S.stories.forEach((s, i) => {
      const errs = issuesOf(s.id).filter((x) => x.severity === 'error').length;
      const row = h('div', { class: `ps-row${s.id === S.story ? ' is-sel' : ''}`, role: 'listitem', draggable: 'true', 'data-id': s.id });
      row.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/plain', s.id));
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => { e.preventDefault(); const from = e.dataTransfer?.getData('text/plain'); if (from && from !== s.id) set(moveStory(S.stories, from, i)); });
      row.append(
        h('span', { class: 'pe-handle', 'aria-hidden': 'true' }, '⠿'),
        h('button', { class: 'ps-pick', type: 'button', 'aria-pressed': String(s.id === S.story), 'data-fk': `story:${s.id}`, onclick: () => set(S.stories, { story: s.id, screen: 0 }) },
          img(coverOf(s), 'ps-cover'),
          h('span', { class: 'ps-rg' }, h('b', {}, s.name || '(sin nombre)'), h('small', {}, `${s.screens.length} pantalla(s)`), chip(s), errs ? h('small', { class: 'pe-warn' }, `⚠ ${errs} error(es)`) : null)),
        h('span', { class: 'ps-mv' },
          h('button', { class: 'pe-ib', type: 'button', disabled: i === 0, 'aria-label': `Subir la historia ${s.name}`, 'data-fk': `up:${s.id}`, onclick: () => set(moveStory(S.stories, s.id, i - 1), { focus: `up:${s.id}` }) }, '▲'),
          h('button', { class: 'pe-ib', type: 'button', disabled: i === S.stories.length - 1, 'aria-label': `Bajar la historia ${s.name}`, 'data-fk': `down:${s.id}`, onclick: () => set(moveStory(S.stories, s.id, i + 1), { focus: `down:${s.id}` }) }, '▼')));
      ul.append(row);
    });
    if (!S.stories.length) ul.append(h('p', { class: 'pe-empty' }, S.loaded ? 'Todavía no hay historias. Crea la primera con «Nueva historia».' : 'Cargando las historias…'));
    box.append(ul, h('button', { class: 'pe-btn pe-primary ps-new', type: 'button', disabled: S.stories.length >= MAX_STORIES || !S.loaded, onclick: () => {
      const s = createStory(S.stories, coverFromCatalog());
      set(addStory(S.stories, s), { story: s.id, screen: 0, focus: 'name' });
      say({ kind: 'info', text: 'Historia creada como borrador. Elige su imagen y sus textos; pulsa «Guardar historias» cuando esté lista.' });
    } }, '＋ Nueva historia'), h('p', { class: 'pe-note' }, `${S.stories.length}/${MAX_STORIES} historias`));
    return box;
  }
  const coverFromCatalog = () => S.picker.items.find((x) => x.image)?.image ?? '/images/products/placeholder.jpg';

  function renderEditor(): HTMLElement {
    const st = cur();
    const box = h('div', { class: 'pe-box ps-edit' });
    if (!st) { box.append(h('h3', {}, 'Pantallas'), h('p', { class: 'pe-note' }, 'Selecciona o crea una historia.')); return box; }
    const sc = st.screens[S.screen];
    box.append(h('h3', {}, `Pantallas de «${st.name}»`));
    const strip = h('div', { class: 'ps-strip', role: 'group', 'aria-label': 'Pantallas de la historia' });
    st.screens.forEach((x, i) => strip.append(h('button', { class: 'ps-th', type: 'button', 'aria-pressed': String(i === S.screen), 'aria-label': `Pantalla ${i + 1}`, onclick: () => { S.screen = i; S.viewing = i; render(); } }, h('i', {}, String(i + 1)), img(x.image))));
    strip.append(h('button', { class: 'ps-add', type: 'button', disabled: st.screens.length >= MAX_SCREENS, 'aria-label': 'Añadir pantalla', onclick: () => { set(addScreen(S.stories, st.id, coverFromCatalog()), { screen: st.screens.length }); S.viewing = st.screens.length; render(); } }, '＋'));
    box.append(strip, h('p', { class: 'pe-note' }, `${st.screens.length}/${MAX_SCREENS} pantallas`));

    const field = (label: string, control: Node, hint?: string) => h('div', { class: 'pe-field' }, h('label', {}, label), control, hint ? h('small', {}, hint) : null);
    const text = (value: string, max: number, on: (v: string) => void, id?: string) => h('input', { type: 'text', id, value, maxlength: max, oninput: (e: any) => on(e.target.value) });
    const link = sc.link;

    // Destino
    const dest = h('div', {});
    if (link?.type === 'product') {
      dest.append(
        h('p', { class: 'pe-note' }, `Actual: ${labels.get(`product:${link.target}`) ?? link.target}`),
        h('input', { type: 'search', maxlength: 80, placeholder: 'Buscar producto…', 'aria-label': 'Buscar producto de destino', value: destQuery, oninput: (e: any) => { const q = e.target.value.trim(); destQuery = e.target.value; window.clearTimeout(destTimer); destTimer = window.setTimeout(() => { void searchDest(q); }, 250); } }),
        h('select', { id: 'psDestResults', 'aria-label': 'Producto de destino (resultados de la búsqueda)', onchange: (e: any) => { const p = destResults.find((x) => x.id === e.target.value); if (p) { labels.set(`product:${p.id}`, p.title); setLinkPatch({ type: 'product', target: p.id }); } } },
          h('option', { value: '' }, destResults.length ? 'Elige un producto…' : 'Escribe para buscar…'),
          ...destResults.map((p) => h('option', { value: p.id, selected: p.id === link.target }, `${p.title.slice(0, 70)}${p.price !== null ? ` · ${p.price.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}` : ' · sin precio'}`))));
    } else if (link?.type === 'category') {
      dest.append(h('select', { 'aria-label': 'Categoría de destino', onchange: (e: any) => { if (e.target.value) setLinkPatch({ type: 'category', target: e.target.value }); } },
        h('option', { value: '' }, 'Elige…'), ...categories.map((c) => h('option', { value: c.id, selected: c.id === link.target }, `${c.parentId ? '— ' : ''}${c.name}`))));
    } else if (link?.type === 'campaign') {
      dest.append(text(link.target, 300, (v) => setLinkPatch({ type: 'campaign', target: v })), h('small', {}, 'Ruta propia que empieza por «/» (p. ej. /guias/portatiles). No se puede comprobar.'));
    }

    // Imagen
    const picker = h('div', { class: 'ps-picker', id: 'psPicker' });
    box.append(
      h('div', { class: 'pe-two' },
        field('Nombre de la historia', h('input', { type: 'text', id: 'psName', value: st.name, maxlength: 60, 'data-fk': 'name', oninput: (e: any) => { S.stories = updateStory(S.stories, st.id, { name: e.target.value }); S.dirty = isDirty(); renderBar(); renderViewer(); renderListOnly(); } })),
        field('Estado', h('select', { 'aria-label': 'Estado de la historia', onchange: (e: any) => set(updateStory(S.stories, st.id, { status: e.target.value }), {}) },
          h('option', { value: 'borrador', selected: st.status === 'borrador' }, 'Borrador'), h('option', { value: 'publicada', selected: st.status === 'publicada' }, 'Publicada')),
        'Una historia publicada y sin errores se verá en la web cuando la portada nueva esté activada. Los borradores nunca se muestran.')),
      field(`Imagen de la pantalla ${S.screen + 1} (vertical 9:16)`, h('div', {},
        h('div', { class: 'ps-imgrow' }, img(sc.image, 'ps-curimg'),
          h('div', { class: 'ps-imgctl' },
            text(sc.image, 600, (v) => patchScreenQuiet({ image: v }), 'psImage'),
            h('div', { class: 'ps-imgbtns' },
              h('button', { class: 'pe-btn pe-sm', type: 'button', 'aria-expanded': String(S.picker.open), onclick: () => { S.picker.open = !S.picker.open; render(); if (S.picker.open && !S.picker.items.length) void searchCatalog(''); } }, 'Elegir del catálogo'),
              h('label', { class: 'pe-btn pe-sm ps-upload' }, S.uploading ? 'Subiendo…' : 'Subir imagen', h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'ps-file', disabled: S.uploading, 'aria-label': 'Subir imagen propia', onchange: (e: any) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; } })))))
        , S.picker.open ? picker : null)),
      field('Texto principal', text(sc.title, 80, (v) => patchScreenQuiet({ title: v }), 'psTitle')),
      field('Texto secundario', h('textarea', { id: 'psText', maxlength: 200, oninput: (e: any) => optionalTextQuiet('text', e.target.value) }, sc.text ?? '')),
      h('div', { class: 'pe-two' },
        field('Texto del botón', text(sc.buttonLabel ?? '', 40, (v) => optionalTextQuiet('buttonLabel', v), 'psBtn')),
        field('Duración', h('select', { id: 'psDur', 'aria-label': 'Duración', onchange: (e: any) => patchScreen({ duration: Number(e.target.value) as StoryScreen['duration'] }) }, ...DURATIONS.map((d) => h('option', { value: d, selected: sc.duration === d }, `${d} s`))))),
      h('div', { class: 'pe-two' },
        field('El botón enlaza a', h('select', { id: 'psLinkType', 'aria-label': 'Tipo de destino', onchange: (e: any) => { destResults = []; destQuery = ''; const t = e.target.value as StoryLinkType | ''; setLinkPatch(t ? { type: t, target: '' } as StoryLink : undefined); if (t === 'product') void searchDest(''); } },
          h('option', { value: '' }, 'Sin enlace'), ...(Object.keys(LINK_LABEL) as StoryLinkType[]).map((k) => h('option', { value: k, selected: link?.type === k }, LINK_LABEL[k])))),
        link ? field('Destino', dest) : h('div', {})),
      h('div', { class: 'ps-actions' },
        h('button', { class: 'pe-btn pe-sm', type: 'button', disabled: S.screen === 0, onclick: () => { set(moveScreen(S.stories, st.id, S.screen, -1), { screen: S.screen - 1 }); S.viewing = S.screen; render(); } }, '← Mover pantalla'),
        h('button', { class: 'pe-btn pe-sm', type: 'button', disabled: S.screen >= st.screens.length - 1, onclick: () => { set(moveScreen(S.stories, st.id, S.screen, 1), { screen: S.screen + 1 }); S.viewing = S.screen; render(); } }, 'Mover pantalla →'),
        h('button', { class: 'pe-btn pe-sm pe-danger', type: 'button', onclick: async () => {
          if (st.screens.length < 2) { say({ kind: 'error', text: 'Una historia necesita al menos una pantalla.' }); return; }
          if (await confirmBox('Eliminar pantalla', `¿Eliminar la pantalla ${S.screen + 1} de «${st.name}»? Puedes recargar las historias guardadas para recuperarla.`, 'Eliminar', true)) { set(removeScreen(S.stories, st.id, S.screen), { screen: Math.max(0, S.screen - 1) }); S.viewing = S.screen; render(); }
        } }, 'Eliminar pantalla'),
        h('span', { class: 'pe-grow' }),
        h('button', { class: 'pe-btn pe-sm', type: 'button', disabled: S.stories.length >= MAX_STORIES, onclick: () => { const next = duplicateStory(S.stories, st.id); const idx = S.stories.findIndex((x) => x.id === st.id); set(next, { story: next[idx + 1]?.id ?? st.id, screen: 0 }); say({ kind: 'info', text: 'Historia duplicada como borrador.' }); } }, 'Duplicar historia'),
        h('button', { class: 'pe-btn pe-sm pe-danger', type: 'button', onclick: async () => {
          if (await confirmBox('Eliminar historia', `¿Eliminar la historia «${st.name}» y sus ${st.screens.length} pantalla(s)?${st.status === 'publicada' ? ' Está publicada internamente.' : ''} Puedes recargar las historias guardadas para recuperarla mientras no guardes.`, 'Eliminar', true)) {
            const next = removeStory(S.stories, st.id);
            set(next, { story: next[0]?.id ?? null, screen: 0 });
            say({ kind: 'info', text: 'Historia eliminada del borrador (sin guardar).' });
          }
        } }, 'Eliminar historia')),
    );
    if (S.picker.open) { fillPicker(picker); }
    // Avisos de la historia seleccionada
    const mine = issuesOf(st.id).filter((i) => i.severity !== 'info');
    if (mine.length) box.append(h('ul', { class: 'ps-issues', 'aria-label': 'Comprobación de la historia' }, ...mine.map((i) => h('li', { class: `is-${i.severity}` }, h('b', {}, i.severity === 'error' ? 'Error · ' : 'Aviso · '), i.message))));
    return box;
  }

  // Cambios de texto sin re-render (mantienen el foco al escribir): actualizan el estado y sólo repintan el visor y la barra.
  function patchScreenQuiet(patch: Partial<StoryScreen>) {
    const st = cur(); if (!st) return;
    S.stories = updateScreen(S.stories, st.id, S.screen, patch);
    S.dirty = isDirty(); renderBar(); renderViewer(); renderListOnly();
  }
  function optionalTextQuiet(key: 'text' | 'buttonLabel', value: string) {
    const st = cur(); if (!st) return;
    const next: StoryScreen = { ...st.screens[S.screen] };
    if (value.trim()) next[key] = value; else delete next[key];
    S.stories = S.stories.map((x) => (x.id === st.id ? { ...x, screens: x.screens.map((y, i) => (i === S.screen ? next : y)) } : x));
    S.dirty = isDirty(); renderBar(); renderViewer();
  }
  async function searchDest(q: string) {
    const r = await api(`/api/admin/home-layout/options?kind=product&limit=10${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    if (r.status === 200) { destResults = r.body.items.map((p: any) => ({ id: p.id, title: p.title, price: p.price })); for (const p of destResults) labels.set(`product:${p.id}`, p.title); render(); }
  }
  function fillPicker(el: HTMLElement) {
    clear(el);
    el.append(
      h('input', { type: 'search', maxlength: 80, placeholder: 'Buscar producto por título…', 'aria-label': 'Buscar imagen en el catálogo', value: S.picker.q, oninput: (e: any) => { const q = e.target.value.trim(); window.clearTimeout(pickTimer); pickTimer = window.setTimeout(() => { void searchCatalog(q); }, 250); } }),
      h('p', { class: 'pe-note', id: 'psPickStatus' }, S.picker.loading ? 'Buscando…' : S.picker.error || (S.picker.items.length ? '' : 'Sin resultados con imagen')),
      h('div', { class: 'ps-imgs', role: 'list' }, ...S.picker.items.filter((i) => i.image).map((i) => h('button', { class: 'ps-imgopt', type: 'button', role: 'listitem', 'aria-label': `Usar la imagen de ${i.title}`, title: i.title, onclick: () => { patchScreen({ image: i.image as string }); S.picker.open = false; render(); } }, img(i.image as string)))));
  }
  function renderPicker() { const el = board.querySelector('#psPicker') as HTMLElement | null; if (el) fillPicker(el); }

  /* ---- Visor 9:16 ---- */
  const viewer = h('aside', { class: 'pe-box ps-view' });
  function renderViewer() {
    clear(viewer);
    const st = cur();
    viewer.append(h('h3', {}, 'Previsualización · visor vertical 9:16'),
      h('div', { class: 'pe-seg', role: 'group', 'aria-label': 'Dispositivo de la previsualización' },
        h('button', { type: 'button', 'aria-pressed': String(S.device === 'desktop'), onclick: () => { S.device = 'desktop'; renderViewer(); } }, '🖥 Escritorio'),
        h('button', { type: 'button', 'aria-pressed': String(S.device === 'mobile'), onclick: () => { S.device = 'mobile'; renderViewer(); } }, '📱 Móvil')));
    const published = S.stories.filter((s) => s.status === 'publicada');
    const circles = h('div', { class: 'ps-circles', role: 'list', 'aria-label': 'Historias publicadas, en orden' },
      ...(published.length ? published.map((s) => h('span', { class: `ps-circle${s.id === S.story ? ' is-sel' : ''}`, role: 'listitem' }, img(coverOf(s)), h('small', {}, s.name.slice(0, 12)))) : [h('small', { class: 'pe-note' }, 'Ninguna historia publicada')]));
    const stage = h('div', { class: `ps-stage${S.device === 'mobile' ? ' is-mobile' : ''}` }, h('div', { class: 'ps-hd' }, h('b', {}, 'Treidilor')), circles);
    if (!st) { stage.append(h('p', { class: 'pe-note' }, 'Sin historia seleccionada')); viewer.append(stage); return; }
    const idx = Math.max(0, Math.min(S.viewing, st.screens.length - 1));
    const sc = st.screens[idx];
    const bars = h('div', { class: 'ps-bars', 'aria-hidden': 'true' }, ...st.screens.map((_, i) => h('i', { class: i < idx ? 'is-done' : i === idx ? 'is-cur' : '' })));
    const dest = sc.link ? (sc.link.type === 'product' ? labels.get(`product:${sc.link.target}`) : sc.link.type === 'category' ? labels.get(`category:${sc.link.target}`) : sc.link.target) : '';
    const phone = h('div', { class: 'ps-phone', role: 'group', 'aria-label': `Pantalla ${idx + 1} de ${st.screens.length} de «${st.name}»` },
      img(sc.image, 'ps-bg'), bars,
      h('div', { class: 'ps-vhd', 'aria-hidden': 'true' }, img(coverOf(st), 'ps-av'), h('b', {}, st.name), h('span', {}, '✕')),
      h('div', { class: 'ps-cap' }, sc.title ? h('h4', {}, sc.title) : null, sc.text ? h('p', {}, sc.text) : null, sc.buttonLabel ? h('span', { class: 'pv-btn' }, sc.buttonLabel) : null),
      h('button', { class: 'ps-tap is-l', type: 'button', disabled: idx === 0, 'aria-label': 'Pantalla anterior', onclick: () => { S.viewing = idx - 1; renderViewer(); } }),
      h('button', { class: 'ps-tap is-r', type: 'button', disabled: idx >= st.screens.length - 1, 'aria-label': 'Pantalla siguiente', onclick: () => { S.viewing = idx + 1; renderViewer(); } }));
    stage.append(phone);
    viewer.append(stage,
      h('p', { class: 'pe-note' }, `Pantalla ${idx + 1}/${st.screens.length} · ${sc.duration} s${dest ? ` · botón → ${dest}` : ''}`),
      h('p', { class: 'pe-note' }, 'Toque izquierdo/derecho = anterior/siguiente. Vista aproximada del visor de la web pública (avance automático, pausa al mantener pulsado, teclado ← → y Esc).'));
  }

  /* ---- Barra superior ---- */
  const bar = h('div', { class: 'pe-toolbar' });
  const banner = h('div', { class: 'pe-banner', hidden: true, role: 'alert' });
  function renderBar() {
    clear(bar);
    const v = validation();
    const chipEl = !S.loaded ? h('span', { class: 'pe-chip' }, 'Cargando…')
      : S.conflict ? h('span', { class: 'pe-chip is-err' }, '⚠ Conflicto de revisión')
        : S.dirty ? h('span', { class: 'pe-chip is-draft' }, '✎ Cambios sin guardar')
          : h('span', { class: 'pe-chip is-draft' }, S.revision === 'inicial' ? '✎ Sin historias guardadas' : '✎ Historias guardadas');
    const canSave = S.loaded && S.dirty && v.ok && S.writable && !S.busy && !S.conflict;
    bar.append(chipEl, h('span', { class: 'pe-note' }, `Revisión: ${S.revision === 'inicial' ? '—' : new Date(S.revision).toLocaleString('es-ES')}`),
      ...(S.msg ? [h('span', { class: `pe-msg is-${S.msg.kind}` }, S.msg.text)] : []),
      ...(!v.ok ? [h('span', { class: 'pe-msg is-error' }, v.errors[0].replace(/^stories\[(\d+)\]\.?/, 'Historia $1: ').slice(0, 110))] : []),
      h('span', { class: 'pe-grow' }),
      h('button', { class: 'pe-btn', type: 'button', disabled: !S.loaded || S.busy, onclick: () => { void reload(); } }, 'Recargar historias'),
      h('button', { class: 'pe-btn pe-primary', type: 'button', disabled: !canSave, title: !S.writable ? 'El almacenamiento está protegido' : !v.ok ? 'Completa los campos marcados' : !S.dirty ? 'No hay cambios' : '', onclick: () => { void save(); } }, S.busy ? 'Guardando…' : 'Guardar historias'));
    clear(banner);
    if (S.blocking.length) {
      banner.hidden = false;
      banner.append(h('span', {}, 'No se guardó: estas historias tienen errores y no pueden estar publicadas → ' + S.blocking.slice(0, 4).map((b) => `«${b.storyName}»: ${b.message}`).join(' · ')));
    } else banner.hidden = true;
  }
  let listHost: HTMLElement | null = null;
  function renderListOnly() { if (listHost) { const fresh = renderList(); listHost.replaceWith(fresh); listHost = fresh; } }

  function render() {
    clear(board);
    renderBar();
    const list = renderList();
    listHost = list;
    renderViewer();
    board.append(bar, banner, h('div', { class: 'ps-grid' }, list, renderEditor(), viewer));
    if (focusKey) { const el = board.querySelector(`[data-fk="${focusKey}"]`) as HTMLElement | null; focusKey = null; el?.focus(); }
  }

  render();
  return { activate: () => { if (!S.loaded && !S.loading) void load(); } };
}
