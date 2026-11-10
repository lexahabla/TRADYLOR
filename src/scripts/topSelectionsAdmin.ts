/**
 * ==============================================================================
 * TREIDILOR — ADMIN: SUBPANEL «MENÚ TOP SELECCIONES» (navegador)
 * ==============================================================================
 * Se monta en `#topSelectionsAdmin` (dentro de «Secciones de la web»). El administrador elige qué secciones salen en el menú «Top Selecciones» del
 * encabezado y en qué orden (independiente del orden y de la visibilidad de la portada). Añadir/retirar NO elimina secciones. Sólo se guarda al pulsar
 * «Guardar menú». Sin innerHTML: todo se construye con nodos de texto.
 * ==============================================================================
 */

type Row = { id: string; title: string; published: boolean; position: 'above' | 'below'; productCount: number; inMenu: boolean; linked: boolean; warnings: string[] };
type ServerState = { mode: 'automatico' | 'manual'; revision: string; storage: { status: string; errors: string[] }; homeMode: 'legacy' | 'layout'; maxItems: number; menu: string[]; orphans: string[]; sections: Row[] };
type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>;
type Child = Node | string | null | false | undefined;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const clear = (el: Element) => { while (el.firstChild) el.removeChild(el.firstChild); };

const REASON: Record<string, string> = {
  sin_productos: 'No se enlazará: la sección no tiene productos que mostrar.',
  no_publicada: 'No se enlazará: la sección no está publicada.',
  no_se_muestra_en_la_portada_nueva: 'No se enlazará: la portada nueva activa no muestra esta sección (bloque oculto o no incluida).',
  no_existe: 'No se enlazará: la sección ya no existe.',
};

const API = '/api/admin/top-selections';
const HEADERS = { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1' };

export function initTopSelectionsAdmin(): void {
  const root = document.getElementById('topSelectionsAdmin');
  if (!root || root.dataset.tsInit === '1') return;
  root.dataset.tsInit = '1';

  if (!document.getElementById('topSelectionsAdminCss')) {
    const st = document.createElement('style');
    st.id = 'topSelectionsAdminCss';
    st.textContent = `
      #topSelectionsAdmin { margin-top: 1.25rem; border-top: 1px solid var(--color-border); padding-top: 1rem; }
      #topSelectionsAdmin h4 { font-family: var(--font-heading); font-size: 1.05rem; margin: 0 0 .35rem; }
      #topSelectionsAdmin .ts-note { color: var(--color-text-muted); font-size: .85rem; margin: .2rem 0 .6rem; }
      #topSelectionsAdmin .ts-chip { display: inline-block; font-size: .75rem; font-weight: 700; padding: .15rem .55rem; border-radius: 999px; border: 1px solid var(--color-border-hover); margin-left: .5rem; }
      #topSelectionsAdmin .ts-box { border: 1px solid var(--color-border); border-radius: var(--border-radius-md); padding: .6rem .75rem; margin: .5rem 0; background: rgba(255,255,255,.02); }
      #topSelectionsAdmin .ts-box h5 { margin: 0 0 .4rem; font-size: .9rem; }
      #topSelectionsAdmin ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .35rem; }
      #topSelectionsAdmin li.ts-row { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; padding: .35rem .5rem; border: 1px solid var(--color-border); border-radius: var(--border-radius-sm); }
      #topSelectionsAdmin .ts-title { flex: 1 1 14rem; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
      #topSelectionsAdmin .ts-meta { color: var(--color-text-muted); font-size: .78rem; }
      #topSelectionsAdmin .ts-warn { flex: 1 1 100%; color: #fcd34d; font-size: .8rem; }
      #topSelectionsAdmin .ts-msg { margin: .5rem 0; font-size: .88rem; }
      #topSelectionsAdmin .ts-msg.is-error { color: #fca5a5; } #topSelectionsAdmin .ts-msg.is-ok { color: #86efac; }
      #topSelectionsAdmin button { min-height: 44px; min-width: 44px; }
      #topSelectionsAdmin button:focus-visible { outline: 3px solid #fbbf24; outline-offset: 2px; }
      #topSelectionsAdmin .ts-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .6rem; }`;
    document.head.append(st);
  }

  const S = { loaded: false, loading: false, busy: false, server: null as ServerState | null, menu: [] as string[], dirty: false, msg: null as null | { kind: 'ok' | 'error'; text: string } };
  const live = h('div', { role: 'status', 'aria-live': 'polite', class: 'ts-msg' });
  const body = h('div');
  root.append(h('h4', {}, 'Menú «Top Selecciones»'), body, live);

  const say = (kind: 'ok' | 'error', text: string) => { S.msg = { kind, text }; render(); };
  async function api(method: string, payload?: unknown): Promise<{ status: number; body: any }> {
    try {
      const r = await fetch(API, { method, headers: method === 'GET' ? { Accept: 'application/json' } : HEADERS, cache: 'no-store', ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    } catch {
      return { status: 0, body: {} };
    }
  }
  async function load(keepMsg = false) {
    S.loading = true; if (!keepMsg) S.msg = null; render();
    const r = await api('GET');
    S.loading = false;
    if (r.status === 200 && r.body?.success) { S.server = r.body as ServerState; S.menu = [...S.server.menu]; S.dirty = false; S.loaded = true; }
    else if (!S.loaded) S.msg = { kind: 'error', text: r.status === 401 ? 'La sesión ha caducado: vuelve a iniciar sesión.' : 'No se pudo cargar el menú.' };
    render();
  }
  const explain = (r: { status: number; body: any }): string => {
    const c = r.body?.code;
    if (r.status === 409 && c === 'conflicto') return 'Otra sesión cambió el menú. No se guardó nada: recarga y vuelve a intentarlo.';
    if (r.status === 423) return 'El archivo del menú está dañado: no se sobrescribe. Usa «Recuperar copia».';
    if (r.status === 400) return `Petición rechazada: ${(r.body?.errors ?? [r.body?.message ?? 'no válida']).slice(0, 2).join(' · ')}`;
    if (r.status === 401) return 'La sesión ha caducado: vuelve a iniciar sesión.';
    if (r.status === 403) return 'No se pudo verificar el origen de la petición. Recarga la página.';
    return 'No se pudo completar la operación. El menú anterior sigue intacto.';
  };
  async function save() {
    if (!S.server || S.busy || !S.dirty) return;
    S.busy = true; render();
    const r = await api('PUT', { baseRevision: S.server.revision, items: S.menu });
    S.busy = false;
    if (r.status === 200 && r.body?.success) { await load(true); say('ok', 'Menú guardado. Los cambios se ven en el encabezado de toda la web.'); }
    else say('error', explain(r));
  }
  async function post(action: 'snapshot' | 'recover', okText: string) {
    if (S.busy) return;
    if (action === 'recover' && !window.confirm('Se restaurará el menú desde la copia de seguridad. El archivo dañado se conserva aparte. ¿Continuar?')) return;
    S.busy = true; render();
    const r = await api('POST', { action });
    S.busy = false;
    if (r.status === 200 && r.body?.success) { await load(true); say('ok', okText); }
    else say('error', r.status === 409 ? (r.body?.message ?? 'No hay nada que hacer.') : explain(r));
  }
  const move = (id: string, d: -1 | 1) => { const i = S.menu.indexOf(id); const j = i + d; if (i < 0 || j < 0 || j >= S.menu.length) return; [S.menu[i], S.menu[j]] = [S.menu[j], S.menu[i]]; S.dirty = true; S.msg = null; render(id); };
  const remove = (id: string) => { S.menu = S.menu.filter((x) => x !== id); S.dirty = true; S.msg = null; render(); };
  const add = (id: string) => { if (!S.server || S.menu.length >= S.server.maxItems || S.menu.includes(id)) return; S.menu.push(id); S.dirty = true; S.msg = null; render(); };

  function render(focusId?: string) {
    clear(body); clear(live);
    if (S.msg) live.append(h('span', { class: `ts-msg is-${S.msg.kind}`, role: S.msg.kind === 'error' ? 'alert' : undefined }, S.msg.text));
    if (!S.server) { body.append(h('p', { class: 'ts-note' }, S.loading ? 'Cargando…' : 'No disponible.')); return; }
    const sv = S.server; const byId = new Map(sv.sections.map((r) => [r.id, r]));
    const protectedFile = !['ok', 'missing'].includes(sv.storage.status);
    body.append(h('p', { class: 'ts-note' },
      'Elige qué secciones salen en «Top Selecciones» y en qué orden. Es independiente del orden y de la visibilidad de la portada. Retirar una sección del menú NO la elimina. Las opciones «Lo más vendido» y «Mejor valorados» siempre aparecen.',
      h('span', { class: 'ts-chip' }, sv.mode === 'manual' ? 'Manual' : 'Automático (todas las publicadas)'),
      h('span', { class: 'ts-chip' }, sv.homeMode === 'layout' ? 'Portada nueva activa' : 'Portada de siempre')));
    if (protectedFile) body.append(h('div', { class: 'ts-box', role: 'alert' }, h('b', {}, `⚠ El archivo del menú está «${sv.storage.status}»: no se sobrescribe. Mientras tanto el menú muestra todas las publicadas y no se pueden crear secciones nuevas. `), h('button', { type: 'button', class: 'btn-secondary btn-sm', disabled: S.busy, onclick: () => { void post('recover', 'Menú recuperado desde la copia de seguridad.'); } }, 'Recuperar copia')));
    if (sv.mode === 'automatico' && !protectedFile) body.append(h('div', { class: 'ts-box' }, 'Ahora mismo el menú es automático: cualquier sección publicada aparece. ', h('b', {}, 'Guarda el menú o fíjalo para que las secciones nuevas NO se añadan solas. '), h('button', { type: 'button', class: 'btn-secondary btn-sm', disabled: S.busy, onclick: () => { void post('snapshot', 'Menú actual fijado: las secciones nuevas ya no se añaden solas.'); } }, 'Fijar el menú actual')));
    if (sv.orphans.length) body.append(h('p', { class: 'ts-note', role: 'status' }, `${sv.orphans.length} sección(es) del menú guardado ya no existen; se quitarán al guardar.`));

    const rowEl = (r: Row, inMenu: boolean, idx: number): HTMLElement => {
      const warn = inMenu && !protectedFile ? (S.dirty ? (r.published ? (r.productCount === 0 ? 'sin_productos' : null) : 'no_publicada') : r.warnings[0] ?? null) : null;
      return h('li', { class: 'ts-row', 'data-section': r.id },
        h('span', { class: 'ts-title' }, r.title || r.id),
        h('span', { class: 'ts-meta' }, `${r.published ? 'Publicada' : 'No publicada'} · ${r.productCount} producto(s) · ${r.position === 'above' ? 'sobre el catálogo' : 'bajo el catálogo'}`),
        ...(inMenu
          ? [
              h('button', { type: 'button', class: 'btn-secondary btn-sm', 'data-focus': `up:${r.id}`, 'aria-label': `Subir «${r.title}» en el menú`, disabled: idx === 0 || S.busy, onclick: () => move(r.id, -1) }, '▲'),
              h('button', { type: 'button', class: 'btn-secondary btn-sm', 'data-focus': `down:${r.id}`, 'aria-label': `Bajar «${r.title}» en el menú`, disabled: idx === S.menu.length - 1 || S.busy, onclick: () => move(r.id, 1) }, '▼'),
              h('button', { type: 'button', class: 'btn-secondary btn-sm', 'aria-label': `Retirar «${r.title}» del menú (no se elimina la sección)`, disabled: S.busy, onclick: () => remove(r.id) }, 'Retirar'),
            ]
          : [h('button', { type: 'button', class: 'btn-secondary btn-sm', 'aria-label': `Añadir «${r.title}» al menú`, disabled: S.busy || S.menu.length >= sv.maxItems, onclick: () => add(r.id) }, 'Añadir')]),
        warn ? h('span', { class: 'ts-warn' }, `⚠ ${REASON[warn] ?? warn}`) : null);
    };
    const appendRows = (ul: HTMLElement, rows: Array<[Row, boolean, number]>) => { for (const [r, m, i] of rows) { const li = rowEl(r, m, i); ul.append(li); } };
    const inMenu = S.menu.map((id) => byId.get(id)).filter((r): r is Row => Boolean(r));
    const ulIn = h('ul', { 'aria-label': 'Secciones en el menú, en orden' });
    // los botones de acción son varios nodos: se añaden uno a uno
    for (const [i, r] of inMenu.entries()) {
      const li = rowEl(r, true, i);
      ulIn.append(li);
    }
    const outRows = sv.sections.filter((r) => !S.menu.includes(r.id));
    const ulOut = h('ul', { 'aria-label': 'Secciones fuera del menú' });
    appendRows(ulOut, outRows.map((r, i) => [r, false, i] as [Row, boolean, number]));
    body.append(
      h('div', { class: 'ts-box' }, h('h5', {}, `En el menú (${inMenu.length}/${sv.maxItems})`), inMenu.length ? ulIn : h('p', { class: 'ts-note' }, 'Ninguna: sólo se verán «Lo más vendido» y «Mejor valorados».')),
      h('div', { class: 'ts-box' }, h('h5', {}, `Fuera del menú (${outRows.length})`), outRows.length ? ulOut : h('p', { class: 'ts-note' }, 'Todas las secciones están en el menú.')),
      h('div', { class: 'ts-actions' },
        h('button', { type: 'button', class: 'btn-primary', disabled: !S.dirty || S.busy || protectedFile, onclick: () => { void save(); } }, S.busy ? 'Guardando…' : 'Guardar menú'),
        h('button', { type: 'button', class: 'btn-secondary', disabled: !S.dirty || S.busy, onclick: () => { void load(); } }, 'Descartar cambios'),
        h('button', { type: 'button', class: 'btn-secondary', disabled: S.busy || S.loading, onclick: () => { void load(); } }, 'Actualizar')),
    );
    if (focusId) (body.querySelector(`[data-focus="up:${focusId}"]:not([disabled]), [data-focus="down:${focusId}"]:not([disabled])`) as HTMLElement | null)?.focus();
  }

  // Se refresca cuando cambian las secciones (publicar/ocultar/crear/eliminar en la lista de arriba) si no hay cambios sin guardar.
  const list = document.getElementById('sectionsListAdmin');
  if (list) {
    let t: number | undefined;
    new MutationObserver(() => { window.clearTimeout(t); t = window.setTimeout(() => { if (!S.dirty && !S.busy && S.loaded) void load(true); }, 600); }).observe(list, { childList: true });
  }
  render();
  void load();
}
