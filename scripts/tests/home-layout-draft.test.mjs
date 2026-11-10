// Portada editable · etapa 3: operaciones sobre el borrador (puras), API GET/PUT del borrador (permisos, CSRF, límites, conflictos entre sesiones,
// escritura atómica, copia .bak, archivo dañado) y garantía de que guardar/editar/eliminar bloques NO toca catálogo, secciones, categorías ni la
// portada pública. Datos aislados, sin red.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-draft-');
delete process.env.HOME_LAYOUT_ENABLED;
const D = await import('../../src/lib/homeLayout/draft.ts');
const V = await import('../../src/lib/homeLayout/validate.ts');
const S = await import('../../src/lib/homeLayout/store.ts');
const route = await import('../../src/pages/api/admin/home-layout/draft.ts');
const auth = await import('../../src/lib/adminAuth.ts');
const users = await import('../../src/lib/userStore.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const f = (n) => path.join(dir, n);
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const OTHER = ['products.json', 'deleted-product-ids.json', 'categories.json', 'sections.json'];
const snapOther = () => Object.fromEntries(OTHER.map((n) => [n, sha(f(n))]));
const URL_ = 'http://localhost/api/admin/home-layout/draft';

/* ───────── Fixtures ───────── */
const ref = (kind, id) => ({ kind, id });
const manual = (id, over = {}) => ({ id, modality: 'manual', format: 'carrusel', width: 12, title: `Manual ${id}`, card: 'producto', config: {}, refs: [ref('product', 'p1')], visible: true, ...over });
const editorial = (id, over = {}) => ({ id, modality: 'editorial', format: 'banner', width: 6, title: 'Campaña', card: 'promocion', config: { headline: 'Titular' }, refs: [], visible: true, ...over });
const seccion = (id, over = {}) => ({ id, modality: 'seccion', format: 'carrusel', width: 12, title: 'Sección', card: 'producto', config: {}, refs: [ref('section', 's1')], visible: true, ...over });
const seed = () => { fs.writeFileSync(f('products.json'), JSON.stringify([{ id: 'p1', slug: 'p1', title: 'P1', price: 10, category: 'Sonido', network: 'amazon', merchant: 'Amazon', currency: 'EUR', inStock: true, image: '/i.jpg', affiliateUrl: 'https://x/', sourceId: 'P1', extra: {} }])); fs.writeFileSync(f('categories.json'), JSON.stringify([{ id: 'sonido', name: 'Sonido', slug: 'sonido', icon: '🎧', keywords: [] }])); fs.writeFileSync(f('sections.json'), JSON.stringify([{ id: 's1', title: 'S1', productIds: ['p1'], published: true, order: 0, position: 'below', speed: 'normal', createdAt: '2026-11-01' }])); fs.writeFileSync(f('deleted-product-ids.json'), '[]'); };
seed();
const ids = (blocks) => blocks.map((b) => b.id);

/* ───────── Operaciones puras ───────── */
test('bloques nuevos: cada modalidad nace con su tarjeta; automática y editorial ya son válidas, manual y sección piden contenido', () => {
  for (const [m, valid, card] of [['manual', false, 'producto'], ['automatica', true, 'producto'], ['seccion', false, 'producto'], ['editorial', true, 'promocion']]) {
    const b = D.createBlock(m, 'carrusel', []);
    assert.equal(b.modality, m);
    assert.equal(b.card, card);
    assert.equal(V.validateBlock(b).ok, valid, m);
  }
  assert.equal(D.createBlock('automatica', 'cuadricula2x2', []).config.rules.limit, 4, 'el límite respeta la cuadrícula 2×2');
  assert.equal(D.createBlock('manual', 'carrusel', []).width, 12);
  assert.equal(D.createBlock('manual', 'banner', []).width, 6);
});

test('operaciones: añadir, duplicar, mover, ancho y eliminar son puras (no mutan la entrada) y mantienen ids únicos', () => {
  const base = [manual('a'), manual('b'), manual('c')];
  const frozen = JSON.stringify(base);
  const added = D.addBlock(base, editorial('d'));
  assert.deepEqual(ids(added), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(D.addBlock(base, editorial('d'), 1)), ['a', 'd', 'b', 'c']);
  const dup = D.duplicateBlock(base, 'b');
  assert.equal(dup.length, 4);
  assert.equal(dup[2].title, 'Manual b (copia)');
  assert.equal(new Set(ids(dup)).size, 4);
  assert.deepEqual(ids(D.moveBlock(base, 'c', 0)), ['c', 'a', 'b']);
  assert.deepEqual(ids(D.moveBlock(base, 'a', 99)), ['b', 'c', 'a'], 'se acota al final');
  assert.deepEqual(ids(D.moveBy(base, 'b', -1)), ['b', 'a', 'c']);
  assert.deepEqual(ids(D.moveBy(base, 'a', -1)), ['a', 'b', 'c'], 'el primero no sube');
  assert.deepEqual(ids(D.moveBy(base, 'c', 1)), ['a', 'b', 'c'], 'el último no baja');
  assert.equal(D.setWidth(base, 'b', 3)[1].width, 3);
  assert.deepEqual(ids(D.removeBlock(base, 'b')), ['a', 'c']);
  assert.deepEqual(ids(D.removeBlock(base, 'zz')), ['a', 'b', 'c']);
  assert.equal(JSON.stringify(base), frozen, 'la entrada no se modifica');
  assert.equal(D.newBlockId(base, () => 0.5).startsWith('b-'), true);
  assert.ok(V.validateBlock({ ...manual('x'), id: D.newBlockId(base) }).ok, 'los ids generados son válidos');
});

test('límite de bloques: no se añade ni duplica por encima del máximo', () => {
  const full = Array.from({ length: V.MAX_BLOCKS }, (_, i) => manual(`b${i}`));
  assert.equal(D.addBlock(full, editorial('extra')).length, V.MAX_BLOCKS);
  assert.equal(D.duplicateBlock(full, 'b0').length, V.MAX_BLOCKS);
});

test('modalidad y formato: cambiar de modalidad reinicia el contenido; cambiar de formato recorta lo que no cabe', () => {
  const b = manual('a', { refs: ['1', '2', '3', '4', '5', '6'].map((x) => ref('product', `p${x}`)) });
  const e = D.changeModality([b], 'a', 'editorial')[0];
  assert.deepEqual([e.modality, e.card, e.refs.length, e.config.headline], ['editorial', 'promocion', 0, 'Nuevo titular']);
  assert.ok(V.validateBlock(e).ok);
  const g = D.changeFormat([b], 'a', 'cuadricula2x2')[0];
  assert.equal(g.refs.length, 4, 'la 2×2 admite 4');
  assert.ok(V.validateBlock(g).ok);
  const auto = D.createBlock('automatica', 'carrusel', []);
  auto.config.rules.limit = 8;
  assert.equal(D.changeFormat([auto], auto.id, 'cuadricula2x2')[0].config.rules.limit, 4);
});

test('referencias: añadir (sin duplicados ni exceso), quitar y reordenar', () => {
  let bs = [manual('a', { refs: [ref('product', 'p1')] })];
  bs = D.addRef(bs, 'a', ref('product', 'p2'));
  bs = D.addRef(bs, 'a', ref('product', 'p2'));
  assert.deepEqual(bs[0].refs.map((r) => r.id), ['p1', 'p2'], 'sin repetidos');
  bs = D.moveRef(bs, 'a', 1, -1);
  assert.deepEqual(bs[0].refs.map((r) => r.id), ['p2', 'p1']);
  assert.deepEqual(D.moveRef(bs, 'a', 0, -1)[0].refs.map((r) => r.id), ['p2', 'p1'], 'fuera de rango: sin cambios');
  assert.deepEqual(D.removeRef(bs, 'a', 0)[0].refs.map((r) => r.id), ['p1']);
  const grid = [manual('g', { format: 'cuadricula2x2', refs: ['a', 'b', 'c', 'd'].map((x) => ref('product', x)) })];
  assert.equal(D.addRef(grid, 'g', ref('product', 'e'))[0].refs.length, 4, 'no se pasa del máximo del formato');
});

/* ───────── Decisión de guardado (pura) ───────── */
test('prepareDraftSave: revisión inicial, avance estrictamente creciente, conflicto, archivo protegido y petición inválida', () => {
  const empty = { status: 'missing', doc: V.emptyDocument() };
  const NOW = new Date('2026-11-10T12:00:00.000Z');
  const p1 = D.prepareDraftSave(empty, { baseRevision: 'inicial', blocks: [manual('a')] }, NOW);
  assert.ok(p1.ok);
  assert.equal(p1.revision, '2026-11-10T12:00:00.000Z');
  const second = D.prepareDraftSave({ status: 'ok', doc: p1.doc }, { baseRevision: p1.revision, blocks: [manual('a'), manual('b')] }, NOW);
  assert.ok(second.ok);
  assert.ok(second.revision > p1.revision, 'aunque el reloj no avance, la revisión sí');
  const stale = D.prepareDraftSave({ status: 'ok', doc: second.doc }, { baseRevision: p1.revision, blocks: [] }, NOW);
  assert.equal(stale.reason, 'conflicto');
  assert.equal(stale.currentRevision, second.revision);
  assert.equal(D.prepareDraftSave(empty, { baseRevision: p1.revision, blocks: [] }, NOW).reason, 'conflicto', 'quien cree que ya existe un borrador y el servidor no tiene ninguno');
  for (const status of ['corrupt', 'invalid', 'newer']) assert.equal(D.prepareDraftSave({ status, doc: V.emptyDocument() }, { baseRevision: 'inicial', blocks: [] }, NOW).reason, 'archivo_protegido', status);
  for (const bad of [null, [], 'x', {}, { baseRevision: 'inicial' }, { blocks: [] }, { baseRevision: 5, blocks: [] }, { baseRevision: '', blocks: [] }, { baseRevision: 'inicial', blocks: [], publicar: true }, { baseRevision: 'inicial', blocks: [], activation: { enabled: true } }]) {
    assert.equal(D.prepareDraftSave(empty, bad, NOW).ok, false, JSON.stringify(bad));
  }
  assert.equal(D.prepareDraftSave(empty, { baseRevision: 'inicial', blocks: [manual('a', { width: 5 })] }, NOW).reason, 'documento_invalido');
  assert.equal(D.prepareDraftSave(empty, { baseRevision: 'inicial', blocks: [manual('a'), manual('a')] }, NOW).reason, 'documento_invalido', 'ids repetidos');
});

test('guardar sólo cambia el borrador: activación, portada publicada y versiones se conservan', () => {
  const published = { version: 3, publishedAt: '2026-11-09T10:00:00.000Z', blocks: [manual('pub')] };
  const doc = { ...V.emptyDocument(), activation: { enabled: true }, published, versions: [{ version: 2, publishedAt: '2026-11-08T10:00:00.000Z', blocks: [manual('old')] }] };
  const plan = D.prepareDraftSave({ status: 'ok', doc }, { baseRevision: 'inicial', blocks: [editorial('e')] }, new Date());
  assert.ok(plan.ok);
  assert.deepEqual(plan.doc.activation, { enabled: true });
  assert.deepEqual(plan.doc.published, published);
  assert.equal(plan.doc.versions.length, 1);
  assert.deepEqual(ids(plan.doc.draft.blocks), ['e']);
});

/* ───────── API ───────── */
let adminC; let common;
const put = (body, { cookie, headers = {}, raw } = {}) => route.PUT({ request: new Request(URL_, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? JSON.stringify(body) }) });
const get = (cookie) => route.GET({ request: new Request(URL_, { method: 'GET', headers: cookie ? { Cookie: cookie } : {} }) });
const json = async (r) => r.json();

test('permisos: GET y PUT exigen administrador (sin sesión, cookie falsa o usuario común → 401) y no escriben', async () => {
  adminC = await adminCookie();
  const master = auth.authenticateUser('tester', 'Test-pass-123');
  const actor = users.toPublicUser(users.findUserById(master.id));
  users.createUser({ username: 'comun3', password: 'Clave-comun-123', name: 'Común', role: 'user' }, actor);
  common = auth.createAdminSession(auth.authenticateUser('comun3', 'Clave-comun-123')).split(';')[0];
  const body = { baseRevision: 'inicial', blocks: [editorial('e')] };
  for (const cookie of [undefined, 'tradylor_admin_session=falsa.1.x', common]) {
    assert.equal((await get(cookie)).status, 401);
    assert.equal((await put(body, { cookie })).status, 401);
  }
  assert.equal(fs.existsSync(f('home-layout.json')), false);
});

test('GET: devuelve el borrador y la revisión; NO crea archivos (sin guardado automático al cargar)', async () => {
  const names = fs.readdirSync(dir).sort().join();
  const r = await get(adminC);
  const body = await json(r);
  assert.equal(r.status, 200);
  assert.equal(body.revision, 'inicial');
  assert.deepEqual(body.blocks, []);
  assert.equal(body.writable, true);
  assert.deepEqual(body.limits, { maxBlocks: 60, maxBodyBytes: 262144 });
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal(fs.readdirSync(dir).sort().join(), names);
});

test('PUT: protección CSRF (origen ajeno, cabecera obligatoria), tipo de contenido, tamaño y JSON inválido', async () => {
  const body = { baseRevision: 'inicial', blocks: [editorial('e')] };
  let r = await put(body, { cookie: adminC, headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 403);
  assert.equal((await json(r)).code, 'origen_no_permitido');
  r = await put(body, { cookie: adminC, headers: { 'X-Home-Layout-Editor': '' } });
  assert.equal(r.status, 403);
  assert.equal((await json(r)).code, 'cabecera_requerida');
  r = await put(body, { cookie: adminC, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 415);
  r = await put(null, { cookie: adminC, raw: '{ no json' });
  assert.equal(r.status, 400);
  assert.equal((await json(r)).code, 'json_invalido');
  r = await put(null, { cookie: adminC, raw: JSON.stringify({ baseRevision: 'inicial', blocks: [], relleno: 'x'.repeat(D.MAX_BODY_BYTES) }) });
  assert.equal(r.status, 413);
  r = await put(null, { cookie: adminC, headers: { 'Content-Length': String(D.MAX_BODY_BYTES + 1) }, raw: '{}' });
  assert.equal(r.status, 413);
  assert.equal(fs.existsSync(f('home-layout.json')), false, 'ninguna petición rechazada escribe');
  // un origen propio sí se acepta
  r = await put({ baseRevision: 'inicial', blocks: [] }, { cookie: adminC, headers: { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(r.status, 200);
  fs.rmSync(f('home-layout.json'), { force: true });
});

test('PUT: validación estricta (campos, modalidades, anchos, referencias, límites) con errores 400 y sin escribir', async () => {
  const bad = [
    { baseRevision: 'inicial' },
    { baseRevision: 'inicial', blocks: 'no' },
    { baseRevision: 'inicial', blocks: [manual('a', { width: 5 })] },
    { baseRevision: 'inicial', blocks: [manual('a', { modality: 'mixta' })] },
    { baseRevision: 'inicial', blocks: [manual('a', { refs: [] })] },
    { baseRevision: 'inicial', blocks: [editorial('a', { config: { headline: 'x', link: { type: 'url', target: 'javascript:alert(1)' }, buttonLabel: 'b' } })] },
    { baseRevision: 'inicial', blocks: Array.from({ length: 61 }, (_, i) => editorial(`b${i}`)) },
    { baseRevision: 'inicial', blocks: [manual('a'), manual('a')] },
    { baseRevision: 'inicial', blocks: [], publicar: true },
  ];
  for (const b of bad) {
    const r = await put(b, { cookie: adminC });
    assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80));
    assert.ok(['documento_invalido', 'peticion_invalida'].includes((await json(r)).code));
  }
  assert.equal(fs.existsSync(f('home-layout.json')), false);
});

test('PUT: guarda el borrador de forma atómica, la 2.ª escritura deja .bak con la anterior y las revisiones avanzan', async () => {
  const before = snapOther();
  const r1 = await put({ baseRevision: 'inicial', blocks: [editorial('e1')] }, { cookie: adminC });
  const b1 = await json(r1);
  assert.equal(r1.status, 200);
  assert.equal(b1.success, true);
  assert.deepEqual(ids(b1.blocks), ['e1']);
  const file1 = sha(f('home-layout.json'));
  assert.equal(fs.existsSync(f('home-layout.json.bak')), false);
  const r2 = await put({ baseRevision: b1.revision, blocks: [editorial('e1'), manual('m1')] }, { cookie: adminC });
  const b2 = await json(r2);
  assert.equal(r2.status, 200);
  assert.ok(b2.revision > b1.revision);
  assert.equal(sha(f('home-layout.json.bak')), file1, 'el .bak es el guardado anterior exacto');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'sin temporales');
  const got = await json(await get(adminC));
  assert.equal(got.revision, b2.revision);
  assert.deepEqual(ids(got.blocks), ['e1', 'm1']);
  assert.deepEqual(snapOther(), before, 'el catálogo, las categorías y las secciones no cambian');
});

test('conflicto entre sesiones: la segunda sesión con una revisión obsoleta recibe 409 y NO sobrescribe nada', async () => {
  const cur = await json(await get(adminC));
  // dos sesiones cargan la misma revisión
  const A = { baseRevision: cur.revision, blocks: [...cur.blocks, editorial('de-a')] };
  const B = { baseRevision: cur.revision, blocks: [editorial('de-b')] };
  const ra = await put(A, { cookie: adminC });
  assert.equal(ra.status, 200);
  const stored = sha(f('home-layout.json'));
  const rb = await put(B, { cookie: adminC });
  assert.equal(rb.status, 409);
  const body = await json(rb);
  assert.equal(body.code, 'conflicto');
  assert.equal(body.currentRevision, (await json(ra)).revision);
  assert.equal(sha(f('home-layout.json')), stored, 'el guardado de la otra sesión sigue intacto');
  // la sesión B recarga y puede guardar de nuevo
  const fresh = await json(await get(adminC));
  assert.equal((await put({ baseRevision: fresh.revision, blocks: B.blocks }, { cookie: adminC })).status, 200);
});

test('peticiones simultáneas con la misma revisión: exactamente una se guarda y la otra recibe 409', async () => {
  const cur = await json(await get(adminC));
  const results = await Promise.all([1, 2, 3].map((n) => put({ baseRevision: cur.revision, blocks: [editorial(`sim${n}`)] }, { cookie: adminC })));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409, 409]);
  const got = await json(await get(adminC));
  assert.equal(got.blocks.length, 1);
});

test('fallo de escritura: el borrador anterior queda intacto y se informa (500), sin temporales', async () => {
  const cur = await json(await get(adminC));
  const before = sha(f('home-layout.json'));
  const real = fs.renameSync;
  fs.renameSync = () => { throw new Error('disco lleno (simulado)'); };
  let r;
  try { r = await put({ baseRevision: cur.revision, blocks: [editorial('nuevo')] }, { cookie: adminC }); } finally { fs.renameSync = real; }
  assert.equal(r.status, 500);
  assert.equal((await json(r)).code, 'error_escritura');
  assert.equal(sha(f('home-layout.json')), before);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  assert.doesNotMatch(JSON.stringify(await json(await get(adminC))), /disco lleno/);
});

test('archivo dañado: GET lo informa, PUT responde 423 y el original se conserva sin sobrescribir; la recuperación es explícita', async () => {
  const good = fs.readFileSync(f('home-layout.json'), 'utf8');
  fs.writeFileSync(f('home-layout.json'), '{ "schemaVersion": 1, "draft": ');
  const corrupt = sha(f('home-layout.json'));
  const g = await json(await get(adminC));
  assert.equal(g.storage.status, 'corrupt');
  assert.equal(g.writable, false);
  assert.deepEqual(g.blocks, []);
  const r = await put({ baseRevision: 'inicial', blocks: [editorial('x')] }, { cookie: adminC });
  assert.equal(r.status, 423);
  assert.equal((await json(r)).code, 'archivo_protegido');
  assert.equal(sha(f('home-layout.json')), corrupt, 'el archivo dañado no se toca');
  // recuperación explícita desde la copia
  assert.equal(S.recoverHomeLayoutFromBackup().ok, true);
  assert.equal((await json(await get(adminC))).storage.status, 'ok');
  fs.writeFileSync(f('home-layout.json'), good);
});

test('otros métodos: 405 (con Allow) tras comprobar permisos', async () => {
  const del = await route.ALL({ request: new Request(URL_, { method: 'DELETE', headers: { Cookie: adminC } }) });
  assert.equal(del.status, 405);
  assert.equal(del.headers.get('Allow'), 'GET, PUT');
  assert.equal((await route.ALL({ request: new Request(URL_, { method: 'DELETE' }) })).status, 401);
  assert.equal(typeof route.POST, 'undefined');
  assert.equal(typeof route.DELETE, 'undefined');
});

test('editar y eliminar bloques del borrador no toca el catálogo, las secciones ni las categorías, y la portada sigue siendo la actual', async () => {
  const before = snapOther();
  let cur = await json(await get(adminC));
  const steps = [
    (b) => D.addBlock(b, manual('z1')),
    (b) => D.addBlock(b, seccion('z2')),
    (b) => D.duplicateBlock(b, 'z1'),
    (b) => D.moveBlock(b, 'z2', 0),
    (b) => D.setWidth(b, 'z1', 3),
    (b) => D.removeBlock(b, 'z1'),
    () => [],
  ];
  let blocks = cur.blocks;
  for (const step of steps) {
    blocks = step(blocks);
    const r = await put({ baseRevision: cur.revision, blocks }, { cookie: adminC });
    assert.equal(r.status, 200);
    cur = { revision: (await json(r)).revision };
  }
  assert.deepEqual(snapOther(), before);
  assert.equal(S.resolveHomeMode(), 'legacy');
  assert.equal(S.readHomeLayout().doc.published, null, 'nada se publica');
  assert.equal(S.readHomeLayout().doc.activation.enabled, false, 'nada se activa');
});

/* ───────── Estático: editor seguro y portada pública intacta ───────── */
test('el cliente no usa innerHTML/eval, sólo toca módulos puros y guarda únicamente con una acción explícita', () => {
  const src = code('src/scripts/homeLayoutEditor.ts');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  assert.doesNotMatch(src, /from '[^']*store'|node:fs|from '[^']*sources'|from '[^']*sectionsProposal'/);
  assert.equal((src.match(/method: 'PUT'/g) ?? []).length, 1, 'un único punto de guardado');
  assert.match(src, /X-Home-Layout-Editor/);
  // el guardado sólo se invoca desde el botón
  assert.equal((src.match(/\bsave\(\)/g) ?? []).length, 2, 'definición + botón');
  assert.match(src, /onclick: \(\) => \{ void save\(\); \}/);
  assert.doesNotMatch(src, /setInterval|setTimeout\([^)]*save/, 'sin guardado automático');
  assert.match(src, /beforeunload/);
  assert.doesNotMatch(code('src/lib/homeLayout/draft.ts'), /node:fs|from '\.\/store'|from '\.\.\/paths'/, 'draft.ts es puro (válido en el navegador)');
  const api = code('src/pages/api/admin/home-layout/draft.ts');
  assert.match(api, /requireAdminAuth\(request\)/);
  assert.match(api, /sameOrigin\(request\)/);
  assert.match(api, /x-home-layout-editor/);
});

test('la página monta el editor, sigue exigiendo admin y no escribe al cargar; la portada pública no consulta el módulo', () => {
  const page = read('src/pages/upayp1b4/portada.astro');
  assert.match(page, /initHomeLayoutEditor\(root\)/);
  assert.match(page, /sessionUser\.role !== 'admin'\) return Astro\.redirect/);
  assert.doesNotMatch(code('src/pages/upayp1b4/portada.astro'), /writeHomeLayout|prepareDraftSave|writeFileSync/);
  for (const p of ['src/pages/index.astro', 'src/layouts/Layout.astro', 'src/lib/sections.ts', 'src/lib/catalog.ts', 'src/middleware.ts']) assert.doesNotMatch(read(p), /homeLayout|home-layout/, p);
});
