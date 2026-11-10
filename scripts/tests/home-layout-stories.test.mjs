// Portada editable · etapa 5: Historias (pestaña C). Modelo y validación puros, operaciones, API GET/PUT (permisos, CSRF, límites, conflictos,
// archivo dañado, fallos de escritura, historias con errores que no pueden quedar publicadas) y avisos informativos al publicar la portada.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-stories-');
delete process.env.HOME_LAYOUT_ENABLED;
const T = await import('../../src/lib/homeLayout/stories.ts');
const St = await import('../../src/lib/homeLayout/storiesStore.ts');
const L = await import('../../src/lib/homeLayout/store.ts');
const route = await import('../../src/pages/api/admin/home-layout/stories.ts');
const versions = await import('../../src/pages/api/admin/home-layout/versions.ts');
const auth = await import('../../src/lib/adminAuth.ts');
const users = await import('../../src/lib/userStore.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const f = (n) => path.join(dir, n);
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const OTHER = ['products.json', 'deleted-product-ids.json', 'categories.json', 'sections.json'];
const snapOther = () => Object.fromEntries(OTHER.map((n) => [n, sha(f(n))]));
const URL_ = 'http://localhost/api/admin/home-layout/stories';

const screen = (id, over = {}) => ({ id, image: '/images/products/a.jpg', title: 'Título', text: 'Texto', buttonLabel: 'Ver', duration: 5, ...over });
const story = (id, over = {}) => ({ id, name: `Historia ${id}`, status: 'borrador', screens: [screen('p1')], ...over });
const seed = () => {
  fs.writeFileSync(f('products.json'), JSON.stringify([
    { id: 'p1', slug: 'p1', title: 'P1', price: 10, category: 'Sonido', network: 'amazon', merchant: 'Amazon', currency: 'EUR', inStock: true, image: '/i.jpg', affiliateUrl: 'https://x/', sourceId: 'P1', extra: {} },
    { id: 'p2', slug: 'p2', title: 'Sin precio', price: 0, category: 'Sonido', network: 'amazon', merchant: 'Amazon', currency: 'EUR', inStock: true, image: '/i.jpg', affiliateUrl: 'https://x/', sourceId: 'P2', extra: {} },
  ]));
  fs.writeFileSync(f('categories.json'), JSON.stringify([{ id: 'sonido', name: 'Sonido', slug: 'sonido', icon: '🎧', keywords: [] }]));
  fs.writeFileSync(f('sections.json'), '[]');
  fs.writeFileSync(f('deleted-product-ids.json'), '[]');
};
seed();

/* ───────── Modelo y validación ───────── */
test('validación: historias y pantallas válidas, campos obligatorios, límites y entradas hostiles', () => {
  assert.ok(T.validateStories([story('h1')]).ok);
  const bad = (s) => T.validateStories(s).ok;
  assert.equal(bad('x'), false);
  assert.equal(bad([story('h1'), story('h1')]), false, 'ids repetidos');
  assert.equal(bad([story('H1')]), false, 'id no válido');
  assert.equal(bad([story('h1', { name: '' })]), false);
  assert.equal(bad([story('h1', { name: 'x'.repeat(61) })]), false);
  assert.equal(bad([story('h1', { status: 'activa' })]), false);
  assert.equal(bad([story('h1', { screens: [] })]), false, 'al menos una pantalla');
  assert.equal(bad([story('h1', { screens: Array.from({ length: 11 }, (_, i) => screen(`p${i}`)) })]), false, 'máximo 10 pantallas');
  assert.ok(bad([story('h1', { screens: Array.from({ length: 10 }, (_, i) => screen(`p${i}`)) })]));
  assert.equal(bad(Array.from({ length: 21 }, (_, i) => story(`h${i}`))), false, 'máximo 20 historias');
  assert.ok(bad(Array.from({ length: 20 }, (_, i) => story(`h${i}`))));
  for (const img of ['', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//evil.example/x.png', 'http://insecure.example/x.png', '/a b.png']) {
    assert.equal(bad([story('h1', { screens: [screen('p1', { image: img })] })]), false, `imagen: ${img}`);
  }
  assert.ok(bad([story('h1', { screens: [screen('p1', { image: 'https://img.example/x.jpg' })] })]));
  assert.equal(bad([story('h1', { screens: [screen('p1', { duration: 6 })] })]), false);
  assert.equal(bad([story('h1', { screens: [screen('p1', { title: 'x'.repeat(81) })] })]), false);
  assert.equal(bad([story('h1', { screens: [screen('p1', { text: 'x'.repeat(201) })] })]), false);
  assert.equal(bad([story('h1', { screens: [screen('p1', { buttonLabel: 'x'.repeat(41) })] })]), false);
  assert.equal(bad([story('h1', { screens: [screen('p1'), screen('p1')] })]), false, 'pantallas repetidas');
  assert.equal(bad([{ ...story('h1'), extra: 1 }]), false, 'campos desconocidos');
  assert.equal(bad([story('h1', { screens: [screen('p1', { link: { type: 'campaign', target: 'javascript:alert(1)' } })] })]), false);
  assert.equal(bad([story('h1', { screens: [screen('p1', { link: { type: 'campaign', target: '//evil' } })] })]), false);
  assert.equal(bad([story('h1', { screens: [screen('p1', { link: { type: 'campaign', target: '/a/../b' } })] })]), false);
  assert.equal(bad([story('h1', { screens: [screen('p1', { link: { type: 'otro', target: 'x' } })] })]), false);
  assert.ok(bad([story('h1', { screens: [screen('p1', { link: { type: 'campaign', target: '/guias/portatiles' } })] })]));
});

test('documento: esquema, revisión y tamaño máximo de 128 KiB', () => {
  assert.ok(T.validateStoriesDocument(T.emptyStoriesDocument()).ok);
  assert.equal(T.validateStoriesDocument({ schemaVersion: 2, draft: { stories: [], updatedAt: null } }).ok, false);
  assert.equal(T.validateStoriesDocument({ schemaVersion: 1, draft: { stories: [], updatedAt: 'no' } }).ok, false);
  assert.equal(T.validateStoriesDocument({ schemaVersion: 1, draft: { stories: [] }, extra: 1 }).ok, false);
  const huge = Array.from({ length: 20 }, (_, i) => story(`h${i}`, { screens: Array.from({ length: 10 }, (_, j) => screen(`p${j}`, { image: `https://img.example/${'x'.repeat(560)}.jpg`, text: 'y'.repeat(200), title: 'z'.repeat(80) })) }));
  assert.equal(T.validateStoriesDocument({ schemaVersion: 1, draft: { stories: huge, updatedAt: null } }).ok, false, 'supera 128 KiB');
  assert.equal(T.revisionOf(null), 'inicial');
});

test('operaciones puras: crear, duplicar, reordenar, eliminar historias y mover/añadir/eliminar pantallas', () => {
  const base = [story('a'), story('b'), story('c')];
  const frozen = JSON.stringify(base);
  const ids = (xs) => xs.map((s) => s.id);
  const created = T.addStory(base, T.createStory(base, '/images/products/x.jpg'));
  assert.equal(created.length, 4);
  assert.equal(created[3].status, 'borrador', 'las nuevas nacen como borrador');
  assert.equal(T.validateStories(created).ok, true);
  assert.equal(T.addStory(Array.from({ length: 20 }, (_, i) => story(`h${i}`)), story('z')).length, 20, 'tope de 20');
  const dup = T.duplicateStory([story('a', { status: 'publicada' }), story('b')], 'a');
  assert.equal(dup.length, 3);
  assert.deepEqual([dup[1].status, dup[1].name], ['borrador', 'Historia a (copia)']);
  assert.equal(new Set(ids(dup)).size, 3);
  assert.notEqual(dup[1].screens[0].id, '', 'las pantallas copiadas tienen id propio');
  assert.ok(T.validateStories(dup).ok);
  assert.deepEqual(ids(T.moveStory(base, 'c', 0)), ['c', 'a', 'b']);
  assert.deepEqual(ids(T.removeStory(base, 'b')), ['a', 'c']);
  assert.equal(JSON.stringify(base), frozen, 'no muta la entrada');
  let s = [story('a')];
  s = T.addScreen(s, 'a', '/images/products/y.jpg');
  s = T.addScreen(s, 'a', '/images/products/z.jpg');
  assert.equal(s[0].screens.length, 3);
  assert.equal(new Set(s[0].screens.map((x) => x.id)).size, 3);
  const first = s[0].screens[0].id;
  s = T.moveScreen(s, 'a', 0, 1);
  assert.equal(s[0].screens[1].id, first);
  assert.equal(T.moveScreen(s, 'a', 0, -1)[0].screens[0].id, s[0].screens[0].id, 'el primero no sube');
  s = T.removeScreen(s, 'a', 0);
  assert.equal(s[0].screens.length, 2);
  assert.equal(T.removeScreen(T.removeScreen(s, 'a', 0), 'a', 0)[0].screens.length, 1, 'la última pantalla no se elimina');
  let many = [story('a')];
  for (let i = 0; i < 12; i++) many = T.addScreen(many, 'a', '/x.jpg');
  assert.equal(many[0].screens.length, T.MAX_SCREENS, 'tope de 10 pantallas');
  assert.equal(T.coverOf(story('a', { screens: [screen('p1', { image: '/c.jpg' }), screen('p2')] })), '/c.jpg', 'la portada es la imagen de la 1.ª pantalla');
});

test('comprobación de referencias: errores, avisos e información; sólo las publicadas bloquean', () => {
  const src = {
    products: new Map([['p1', { id: 'p1', price: 10 }], ['p2', { id: 'p2', price: null }]]),
    retiredIds: new Set(['gone']),
    categories: new Map([['sonido', { id: 'sonido', name: 'Sonido', slug: 'sonido', parentId: null }]]),
  };
  const link = (type, target) => story(`h-${type}-${target}`.slice(0, 40), { status: 'publicada', screens: [screen('p1', { link: { type, target } })] });
  const stories = [link('product', 'p1'), link('product', 'nada'), link('product', 'gone'), link('product', 'p2'), link('category', 'sonido'), link('category', 'nada'), link('campaign', '/guias/x')];
  const issues = T.checkStories(stories, src);
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes('link_product_missing') && codes.includes('link_product_retired') && codes.includes('link_category_missing'));
  assert.ok(issues.some((i) => i.code === 'link_product_without_price' && i.severity === 'warning'));
  assert.ok(issues.some((i) => i.code === 'link_campaign_unverified' && i.severity === 'info'));
  assert.equal(issues.filter((i) => i.severity === 'error').length, 3);
  assert.equal(T.blockingErrors(stories, issues).length, 3);
  const asDraft = stories.map((s) => ({ ...s, status: 'borrador' }));
  assert.equal(T.blockingErrors(asDraft, T.checkStories(asDraft, src)).length, 0, 'en borrador nada bloquea');
  const warn = T.checkStories([story('w', { screens: [screen('p1', { title: '', text: undefined, buttonLabel: 'Ir', link: undefined, image: 'https://img.example/a.jpg' })] })], src).map((i) => i.code);
  assert.ok(warn.includes('screen_without_text') && warn.includes('button_without_link') && warn.includes('image_external'));
});

test('prepareStoriesSave: revisión inicial, avance estricto, conflicto, archivo protegido y petición inválida', () => {
  const empty = { status: 'missing', doc: T.emptyStoriesDocument() };
  const NOW = new Date('2026-11-10T12:00:00.000Z');
  const p1 = T.prepareStoriesSave(empty, { baseRevision: 'inicial', stories: [story('a')] }, NOW);
  assert.ok(p1.ok);
  const p2 = T.prepareStoriesSave({ status: 'ok', doc: p1.doc }, { baseRevision: p1.revision, stories: [story('a'), story('b')] }, NOW);
  assert.ok(p2.ok && p2.revision > p1.revision);
  assert.equal(T.prepareStoriesSave({ status: 'ok', doc: p2.doc }, { baseRevision: p1.revision, stories: [] }, NOW).reason, 'conflicto');
  for (const status of ['corrupt', 'invalid', 'newer']) assert.equal(T.prepareStoriesSave({ status, doc: T.emptyStoriesDocument() }, { baseRevision: 'inicial', stories: [] }, NOW).reason, 'archivo_protegido');
  for (const bad of [null, [], 'x', {}, { baseRevision: 'inicial' }, { stories: [] }, { baseRevision: 'inicial', stories: [], publicar: true }]) assert.equal(T.prepareStoriesSave(empty, bad, NOW).ok, false);
  assert.equal(T.prepareStoriesSave(empty, { baseRevision: 'inicial', stories: [{ ...story('a'), status: 'x' }] }, NOW).reason, 'documento_invalido');
});

/* ───────── Almacenamiento ───────── */
test('almacén: lectura sin efectos, escritura atómica con .bak y archivo dañado protegido', () => {
  const names = fs.readdirSync(dir).sort().join();
  assert.equal(St.readStories().status, 'missing');
  assert.equal(fs.readdirSync(dir).sort().join(), names, 'leer no crea archivos');
  const doc1 = { schemaVersion: 1, draft: { stories: [story('a')], updatedAt: '2026-11-10T10:00:00.000Z' } };
  assert.equal(St.writeStories(doc1).ok, true);
  assert.equal(fs.existsSync(`${f('home-stories.json')}.bak`), false);
  const first = sha(f('home-stories.json'));
  assert.equal(St.writeStories({ ...doc1, draft: { stories: [story('a'), story('b')], updatedAt: '2026-11-10T11:00:00.000Z' } }).ok, true);
  assert.equal(sha(`${f('home-stories.json')}.bak`), first);
  assert.equal(St.writeStories({ schemaVersion: 1, draft: { stories: [story('a', { name: '' })], updatedAt: null } }).ok, false);
  fs.writeFileSync(f('home-stories.json'), '{ "schemaVersion": 1, "draft": ');
  const corrupt = sha(f('home-stories.json'));
  assert.equal(St.readStories().status, 'corrupt');
  assert.equal(St.writeStories(doc1).reason, 'archivo_protegido');
  assert.equal(sha(f('home-stories.json')), corrupt);
  fs.writeFileSync(f('home-stories.json'), JSON.stringify({ schemaVersion: 9, draft: {} }));
  assert.equal(St.readStories().status, 'newer');
  fs.rmSync(f('home-stories.json'), { force: true });
  fs.rmSync(`${f('home-stories.json')}.bak`, { force: true });
});

/* ───────── API ───────── */
let adminC; let common;
const put = (body, { cookie, headers = {}, raw } = {}) => route.PUT({ request: new Request(URL_, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? JSON.stringify(body) }) });
const get = (cookie) => route.GET({ request: new Request(URL_, { headers: cookie ? { Cookie: cookie } : {} }) });
const json = (r) => r.json();
const saveOk = async (stories) => { const cur = await json(await get(adminC)); const r = await put({ baseRevision: cur.revision, stories }, { cookie: adminC }); assert.equal(r.status, 200); return json(r); };

test('permisos: GET y PUT exigen administrador y no escriben', async () => {
  adminC = await adminCookie();
  const master = auth.authenticateUser('tester', 'Test-pass-123');
  users.createUser({ username: 'comun6', password: 'Clave-comun-123', name: 'Común', role: 'user' }, users.toPublicUser(users.findUserById(master.id)));
  common = auth.createAdminSession(auth.authenticateUser('comun6', 'Clave-comun-123')).split(';')[0];
  for (const cookie of [undefined, 'tradylor_admin_session=falsa.1.x', common]) {
    assert.equal((await get(cookie)).status, 401);
    assert.equal((await put({ baseRevision: 'inicial', stories: [] }, { cookie })).status, 401);
  }
  assert.equal(fs.existsSync(f('home-stories.json')), false);
});

test('GET: historias vacías y límites; no crea archivos', async () => {
  const names = fs.readdirSync(dir).sort().join();
  const r = await get(adminC);
  const b = await json(r);
  assert.equal(r.status, 200);
  assert.deepEqual([b.revision, b.stories, b.writable, b.storage.status], ['inicial', [], true, 'missing']);
  assert.deepEqual(b.limits, { maxStories: 20, maxScreens: 10, maxBodyBytes: 131072 });
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal(fs.readdirSync(dir).sort().join(), names);
});

test('PUT: CSRF, tipo, tamaño, JSON inválido y validación estricta (400) sin escribir', async () => {
  const body = { baseRevision: 'inicial', stories: [story('a')] };
  let r = await put(body, { cookie: adminC, headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.deepEqual([r.status, (await json(r)).code], [403, 'origen_no_permitido']);
  r = await put(body, { cookie: adminC, headers: { 'X-Home-Layout-Editor': '' } });
  assert.equal((await json(r)).code, 'cabecera_requerida');
  assert.equal((await put(body, { cookie: adminC, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await json(await put(null, { cookie: adminC, raw: '{ no json' }))).code, 'json_invalido');
  assert.equal((await put(null, { cookie: adminC, raw: JSON.stringify({ ...body, relleno: 'x'.repeat(T.MAX_BODY_BYTES) }) })).status, 413);
  assert.equal((await put(null, { cookie: adminC, headers: { 'Content-Length': String(T.MAX_BODY_BYTES + 1) }, raw: '{}' })).status, 413);
  for (const stories of ['no', [story('a', { name: '' })], [story('a'), story('a')], [story('a', { screens: [] })], [story('a', { screens: [screen('p1', { image: 'javascript:alert(1)' })] })], Array.from({ length: 21 }, (_, i) => story(`h${i}`))]) {
    const x = await put({ baseRevision: 'inicial', stories }, { cookie: adminC });
    assert.equal(x.status, 400);
  }
  assert.equal((await put({ baseRevision: 'inicial', stories: [], publicar: true }, { cookie: adminC })).status, 400);
  assert.equal(fs.existsSync(f('home-stories.json')), false);
});

test('PUT: guarda de forma atómica, revisión creciente, .bak del guardado anterior y datos del catálogo intactos', async () => {
  const before = snapOther();
  const a = await saveOk([story('a')]);
  const file1 = sha(f('home-stories.json'));
  const b = await saveOk([story('a'), story('b', { status: 'publicada' })]);
  assert.ok(b.revision > a.revision);
  assert.equal(sha(`${f('home-stories.json')}.bak`), file1);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  const got = await json(await get(adminC));
  assert.deepEqual(got.stories.map((s) => [s.id, s.status]), [['a', 'borrador'], ['b', 'publicada']]);
  assert.deepEqual(snapOther(), before);
  assert.equal(fs.existsSync(f('home-layout.json')), false, 'no toca home-layout.json');
});

test('conflicto entre sesiones y peticiones simultáneas: sólo una se guarda y la otra recibe 409', async () => {
  const cur = await json(await get(adminC));
  const ra = await put({ baseRevision: cur.revision, stories: [story('a'), story('x')] }, { cookie: adminC });
  assert.equal(ra.status, 200);
  const stored = sha(f('home-stories.json'));
  const rb = await put({ baseRevision: cur.revision, stories: [story('y')] }, { cookie: adminC });
  assert.equal(rb.status, 409);
  assert.equal((await json(rb)).currentRevision, (await json(ra)).revision);
  assert.equal(sha(f('home-stories.json')), stored);
  const now = await json(await get(adminC));
  const rs = await Promise.all([1, 2, 3].map((n) => put({ baseRevision: now.revision, stories: [story(`s${n}`)] }, { cookie: adminC })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
});

test('historias con errores: no pueden quedar publicadas (422) y en borrador sí; las ya publicadas y sin cambios no bloquean', async () => {
  const broken = (status) => story('rota', { status, screens: [screen('p1', { link: { type: 'product', target: 'no-existe' } })] });
  const cur = await json(await get(adminC));
  const stored = sha(f('home-stories.json'));
  let r = await put({ baseRevision: cur.revision, stories: [broken('publicada')] }, { cookie: adminC });
  assert.equal(r.status, 422);
  const body = await json(r);
  assert.equal(body.code, 'historias_con_errores');
  assert.equal(body.blocking[0].code, 'link_product_missing');
  assert.equal(sha(f('home-stories.json')), stored, 'no se escribe nada');
  const draft = await saveOk([broken('borrador')]);
  assert.equal(draft.issues.some((i) => i.severity === 'error'), true, 'el borrador con errores se guarda y los errores se informan');
  // Publicada válida que luego se rompe: guardar OTRA historia no queda bloqueado
  await saveOk([story('ok', { status: 'publicada', screens: [screen('p1', { link: { type: 'product', target: 'p1' } })] })]);
  fs.writeFileSync(f('deleted-product-ids.json'), JSON.stringify(['p1']));
  fs.writeFileSync(f('products.json'), JSON.stringify([]));
  const g = await json(await get(adminC));
  assert.ok(g.issues.some((i) => i.code === 'link_product_missing' || i.code === 'link_product_retired'), 'el GET informa del error sobrevenido');
  const okAfter = await put({ baseRevision: g.revision, stories: [...g.stories, story('nueva')] }, { cookie: adminC });
  assert.equal(okAfter.status, 200, 'una publicada sin cambios no impide guardar otras');
  const g2 = await json(await get(adminC));
  const edited = g2.stories.map((s) => (s.id === 'ok' ? { ...s, name: 'Cambiada' } : s));
  assert.equal((await put({ baseRevision: g2.revision, stories: edited }, { cookie: adminC })).status, 422, 'al modificarla sí se exige que no tenga errores');
  seed();
});

test('fallo de escritura: 500 sin detalles y el archivo anterior intacto; archivo dañado: 423', async () => {
  const cur = await json(await get(adminC));
  const before = sha(f('home-stories.json'));
  const real = fs.renameSync;
  fs.renameSync = () => { throw new Error('disco lleno (simulado)'); };
  let r;
  try { r = await put({ baseRevision: cur.revision, stories: [story('nuevo')] }, { cookie: adminC }); } finally { fs.renameSync = real; }
  assert.equal(r.status, 500);
  const b = await json(r);
  assert.equal(b.code, 'error_escritura');
  assert.doesNotMatch(JSON.stringify(b), /disco lleno/);
  assert.equal(sha(f('home-stories.json')), before);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  const good = fs.readFileSync(f('home-stories.json'), 'utf8');
  fs.writeFileSync(f('home-stories.json'), '{ "schemaVersion": 1, "draft": ');
  const corrupt = sha(f('home-stories.json'));
  const g = await json(await get(adminC));
  assert.deepEqual([g.storage.status, g.writable], ['corrupt', false]);
  assert.equal((await put({ baseRevision: 'inicial', stories: [] }, { cookie: adminC })).status, 423);
  assert.equal(sha(f('home-stories.json')), corrupt);
  fs.writeFileSync(f('home-stories.json'), good);
});

test('otros métodos: 405 con Allow tras comprobar permisos', async () => {
  const del = await route.ALL({ request: new Request(URL_, { method: 'DELETE', headers: { Cookie: adminC } }) });
  assert.equal(del.status, 405);
  assert.equal(del.headers.get('Allow'), 'GET, PUT');
  assert.equal((await route.ALL({ request: new Request(URL_, { method: 'DELETE' }) })).status, 401);
  assert.equal(typeof route.POST, 'undefined');
});

/* ───────── Aviso informativo al publicar la portada ───────── */
test('publicar la portada: las historias publicadas con problemas sólo generan AVISOS informativos y nunca bloquean', async () => {
  seed();
  fs.writeFileSync(f('home-stories.json'), JSON.stringify({ schemaVersion: 1, draft: { updatedAt: '2026-11-10T09:00:00.000Z', stories: [
    story('buena', { status: 'publicada', screens: [screen('p1', { link: { type: 'product', target: 'p1' } })] }),
    story('rota', { status: 'publicada', screens: [screen('p1', { link: { type: 'product', target: 'no-existe' } })] }),
    story('borr', { status: 'borrador', screens: [screen('p1', { link: { type: 'product', target: 'no-existe' } })] }),
  ] } }));
  const blocks = [{ id: 'e1', modality: 'editorial', format: 'banner', width: 6, title: 'Campaña', card: 'promocion', config: { headline: 'Hola' }, refs: [], visible: true }];
  assert.equal(L.writeHomeLayout({ schemaVersion: 1, activation: { enabled: false }, draft: { blocks, updatedAt: '2026-11-10T10:00:00.000Z' }, published: null, versions: [] }).ok, true);
  const r = await versions.GET({ request: new Request('http://localhost/api/admin/home-layout/versions?check=publish', { headers: { Cookie: adminC } }) });
  const b = await json(r);
  assert.equal(b.canPublish, true, 'los problemas de las historias no bloquean la portada');
  assert.equal(b.stories.published, 2);
  assert.deepEqual([...new Set(b.stories.issues.map((i) => i.storyId))], ['rota'], 'sólo las historias publicadas, y sin la de borrador');
  assert.ok(b.stories.issues.every((i) => i.severity !== 'info'));
  assert.equal(b.blocking.length, 0);
  assert.equal(L.resolveHomeMode(), 'legacy');
});

/* ───────── Estático ───────── */
test('estático: módulo de historias puro, almacén independiente, API segura y portada pública intacta', () => {
  assert.doesNotMatch(code('src/lib/homeLayout/stories.ts'), /node:fs|^import (?!type)[^\n]*from '[^']*(store|sources)'|fetch\(|process\.env/m);
  const store = code('src/lib/homeLayout/storiesStore.ts');
  assert.match(store, /home-stories\.json/);
  assert.doesNotMatch(store, /home-layout\.json/);
  const api = code('src/pages/api/admin/home-layout/stories.ts');
  assert.match(api, /requireAdminAuth/);
  assert.match(api, /sameOrigin/);
  assert.match(api, /x-home-layout-editor/);
  for (const p of ['src/lib/homeLayout/types.ts', 'src/lib/homeLayout/validate.ts', 'src/lib/homeLayout/store.ts']) assert.doesNotMatch(code(p), /stor(y|ies)|historia/i, `${p} no se ha tocado`);
  assert.doesNotMatch(code('src/pages/index.astro'), /home-stories|storiesStore|homeLayout/);
  assert.doesNotMatch(code('src/pages/api/admin/upload-image.ts'), /home-stories|homeLayout/);
  const client = code('src/scripts/homeLayoutStories.ts');
  assert.doesNotMatch(client, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  assert.doesNotMatch(client, /from '[^']*storiesStore'|node:fs/);
  assert.equal((client.match(/method: 'PUT'/g) ?? []).length, 1, 'un único punto de guardado');
  assert.doesNotMatch(client, /setInterval|setTimeout\([^)]*save/, 'sin guardado automático');
});
