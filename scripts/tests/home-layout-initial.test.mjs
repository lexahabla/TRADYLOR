// Portada editable: carga de la portada inicial (v1) en una sola acción. Sólo sobre portada virgen (nunca sobrescribe), validada con los datos
// reales, publicada y activada internamente por las decisiones existentes; con fallo de escritura se deshace; la web no cambia sin la variable.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-initial-');
delete process.env.HOME_LAYOUT_ENABLED;
const I = await import('../../src/lib/homeLayout/initialLayout.ts');
const V = await import('../../src/lib/homeLayout/validate.ts');
const A = await import('../../src/lib/homeLayout/activation.ts');
const AS = await import('../../src/lib/homeLayout/activationStore.ts');
const L = await import('../../src/lib/homeLayout/store.ts');
const Pub = await import('../../src/lib/homeLayout/public.ts');
const route = await import('../../src/pages/api/admin/home-layout/initial.ts');
const actRoute = await import('../../src/pages/api/admin/home-layout/activation.ts');
const auth = await import('../../src/lib/adminAuth.ts');
const users = await import('../../src/lib/userStore.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const f = (n) => path.join(dir, n);
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const OTHER = ['products.json', 'deleted-product-ids.json', 'categories.json', 'sections.json'];
const snapOther = () => Object.fromEntries(OTHER.map((n) => [n, sha(f(n))]));
const B = 'http://localhost/api/admin/home-layout/';
const CATS = ['portabilidad', 'informatica', 'sonido', 'hogar'];

const prod = (i, cat, network = 'amazon') => ({ id: `p${i}`, slug: `p${i}`, title: `Producto ${i}`, price: 10 + i, category: cat, category_id: cat, network, merchant: 'X', currency: 'EUR', inStock: true, image: '/i.jpg', affiliateUrl: 'https://x/', sourceId: `S${i}`, extra: {} });
function seed({ withCats = CATS } = {}) {
  const ps = [];
  CATS.forEach((c, ci) => { for (let k = 0; k < 6; k++) ps.push(prod(ci * 10 + k + 1, c, k % 2 ? 'ebay' : 'amazon')); });
  fs.writeFileSync(f('products.json'), JSON.stringify(ps));
  fs.writeFileSync(f('categories.json'), JSON.stringify(withCats.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), slug: id, icon: '📦', keywords: [] }))));
  fs.writeFileSync(f('sections.json'), '[]');
  fs.writeFileSync(f('deleted-product-ids.json'), '[]');
}
const reset = () => { for (const n of fs.readdirSync(dir)) if (/^home-layout|^home-stories/.test(n)) fs.rmSync(f(n), { recursive: true, force: true }); };
const NOW = new Date('2026-11-10T12:00:00.000Z');
const okCheck = () => ({ blocking: [], warnings: [], visibleBlocks: 7, totalBlocks: 7 });
const virgin = () => ({ layout: { status: 'missing', doc: V.emptyDocument() }, act: { status: 'missing', doc: A.emptyActivation() } });
const body = (over = {}) => ({ action: 'load_initial', baseRevision: 'inicial', baseActivation: 'inicial', confirm: true, ...over });
seed();

test('los 7 bloques iniciales son válidos, automáticos/conectados al catálogo y sin datos fijos inventados', () => {
  assert.equal(I.INITIAL_BLOCKS.length, 7);
  assert.ok(V.validateBlocks(I.INITIAL_BLOCKS).ok);
  assert.deepEqual(I.INITIAL_BLOCKS.map((b) => b.id), ['bienvenida', 'categorias', 'mas-economicos', 'en-amazon', 'portabilidad', 'informatica', 'sonido']);
  for (const b of I.INITIAL_BLOCKS) {
    assert.ok(!b.refs.some((r) => r.kind === 'product'), `${b.id}: sin productos fijos`);
    if (b.modality === 'automatica') { assert.equal(b.config.rules.order, 'precio_asc'); assert.equal(b.config.rules.onlyWithPrice, true); }
  }
  const text = JSON.stringify(I.INITIAL_BLOCKS);
  assert.doesNotMatch(text, /descuento|%|oferta|valoraci|mejor(es)?\b|más vendido/i, 'sin afirmaciones comerciales no demostrables');
});

test('planInitialLoad: portada virgen → borrador + v1 publicada + activación fijada (decisiones existentes), con confirmación y revisiones', () => {
  const { layout, act } = virgin();
  const r = I.planInitialLoad(layout, act, body(), okCheck, NOW, 'tester');
  assert.ok(r.ok);
  assert.equal(r.version, 1);
  assert.deepEqual(r.layout.draft.blocks, r.layout.published.blocks, 'el editor verá los mismos bloques en el borrador');
  assert.equal(r.layout.published.version, 1);
  assert.deepEqual([r.layout.activation.enabled, r.activation.active, r.activation.pinnedVersion, r.activation.log.at(-1).by], [true, true, 1, 'tester']);
  assert.ok(V.validateDocument(r.layout).ok && A.validateActivationDocument(r.activation).ok);
  const reason = (input, o = {}) => I.planInitialLoad(o.layout ?? layout, o.act ?? act, input, o.check ?? okCheck, NOW, 'x').reason;
  assert.equal(reason(body({ confirm: undefined })), 'confirmacion_requerida');
  assert.equal(reason(body({ baseRevision: 'otra' })), 'conflicto');
  assert.equal(reason(body({ baseActivation: 'otra' })), 'conflicto');
  assert.equal(reason(body({ action: 'x' })), 'peticion_invalida');
  assert.equal(reason(body({ extra: 1 })), 'peticion_invalida');
  assert.equal(reason(null), 'peticion_invalida');
  const blocked = reason(body(), { check: () => ({ ...okCheck(), blocking: [{ blockId: 'categorias', title: 'c', code: 'category_not_found', message: 'm' }] }) });
  assert.equal(blocked, 'referencias_bloqueantes');
});

test('planInitialLoad NO sobrescribe nada: borrador, publicada, historial, activación y archivos protegidos se rechazan', () => {
  const { layout, act } = virgin();
  const doc = (over) => ({ status: 'ok', doc: { ...V.emptyDocument(), ...over } });
  const blk = I.INITIAL_BLOCKS.slice(0, 1);
  const r = (l, a) => I.planInitialLoad(l ?? layout, a ?? act, body(), okCheck, NOW, 'x').reason;
  assert.equal(r(doc({ draft: { blocks: blk, updatedAt: '2026-11-10T10:00:00.000Z' } })), 'ya_existe_borrador');
  assert.equal(r(doc({ draft: { blocks: [], updatedAt: '2026-11-10T10:00:00.000Z' } })), 'ya_existe_borrador', 'aunque el borrador guardado esté vacío');
  assert.equal(r(doc({ published: { version: 1, publishedAt: 'x', blocks: blk } })), 'ya_hay_versiones');
  assert.equal(r(doc({ versions: [{ version: 1, publishedAt: 'x', blocks: blk }] })), 'ya_hay_versiones');
  assert.equal(r(doc({ activation: { enabled: true } })), 'activacion_existente');
  assert.equal(r(undefined, { status: 'ok', doc: { ...A.emptyActivation(), active: true, pinnedVersion: 1, updatedAt: 'x' } }), 'activacion_existente');
  for (const status of ['corrupt', 'invalid', 'newer']) { assert.equal(r({ status, doc: V.emptyDocument() }), 'archivo_protegido', status); assert.equal(r(undefined, { status, doc: A.emptyActivation() }), 'activacion_protegida', status); }
});

/* ───────── API ───────── */
let adminC; let common;
const get = (...rest) => { const cookie = rest.length ? rest[0] : adminC; return route.GET({ request: new Request(`${B}initial`, { method: 'GET', headers: cookie ? { Cookie: cookie } : {} }) }); };
const post = (payload, opts = {}) => { const { headers = {}, raw } = opts; const cookie = 'cookie' in opts ? opts.cookie : adminC; return route.POST({ request: new Request(`${B}initial`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? JSON.stringify(payload) }) }); };
const j = (r) => r.json();
const load = async (over = {}) => { const g = await j(await get()); return post({ action: 'load_initial', baseRevision: g.draftRevision, baseActivation: g.activationRevision, confirm: true, ...over }); };

test('API: permisos (sin sesión, cookie falsa, usuario común → 401), CSRF, tipo, tamaño, 405 — sin escribir', async () => {
  adminC = await adminCookie(); reset(); seed();
  const master = auth.authenticateUser('tester', 'Test-pass-123');
  users.createUser({ username: 'comun9', password: 'Clave-comun-123', name: 'Común', role: 'user' }, users.toPublicUser(users.findUserById(master.id)));
  common = auth.createAdminSession(auth.authenticateUser('comun9', 'Clave-comun-123')).split(';')[0];
  for (const cookie of [undefined, 'tradylor_admin_session=falsa.1.x', common]) {
    assert.equal((await get(cookie)).status, 401);
    assert.equal((await post(body(), { cookie })).status, 401);
    assert.equal((await route.ALL({ request: new Request(`${B}initial`, { method: 'DELETE', headers: cookie ? { Cookie: cookie } : {} }) })).status, 401);
  }
  assert.equal((await route.ALL({ request: new Request(`${B}initial`, { method: 'PUT', headers: { Cookie: adminC } }) })).status, 405);
  const evil = await route.POST({ request: new Request(`${B}initial`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC, Origin: 'https://evil.example' }, body: JSON.stringify(body()) }) });
  assert.equal(evil.status, 403);
  assert.equal((await post(body(), { headers: { 'X-Home-Layout-Editor': '0' } })).status, 403);
  assert.equal((await post(body(), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post(null, { raw: '{no' })).status, 400);
  assert.equal((await post(null, { raw: JSON.stringify({ ...body(), x: 'y'.repeat(3000) }) })).status, 413);
  assert.equal((await post(body({ confirm: false }))).status, 400);
  assert.equal(fs.readdirSync(dir).some((n) => /^home-layout/.test(n)), false, 'ninguna petición rechazada escribe');
});

test('API: GET describe la portada inicial y su comprobación con los datos reales (sin escribir)', async () => {
  reset(); seed();
  const g = await j(await get());
  assert.deepEqual([g.success, g.available, g.gates.env, g.draftRevision, g.activationRevision], [true, true, false, 'inicial', 'inicial']);
  assert.equal(g.blocks.length, 7);
  assert.deepEqual([g.check.canLoad, g.check.visibleBlocks, g.check.totalBlocks, g.check.blocking.length], [true, 7, 7, 0]);
  assert.equal(fs.readdirSync(dir).some((n) => /^home-layout/.test(n)), false);
});

test('API: una acción carga, publica y activa internamente; la web NO cambia sin la variable; con ella se ve la portada nueva; desactivar vuelve a la anterior', async () => {
  reset(); seed();
  const other = snapOther();
  const r = await load();
  assert.equal(r.status, 200);
  const b = await j(r);
  assert.deepEqual([b.success, b.version, b.mode, b.envEnabled], [true, 1, 'legacy', false]);
  const lay = L.readHomeLayout();
  assert.deepEqual([lay.status, lay.doc.published.version, lay.doc.activation.enabled, lay.doc.draft.blocks.length, lay.doc.versions.length], ['ok', 1, true, 7, 0]);
  const act = AS.readActivation();
  assert.deepEqual([act.status, act.doc.active, act.doc.pinnedVersion, act.doc.log.length], ['ok', true, 1, 1]);
  assert.equal(Pub.buildPublicHome().mode, 'legacy', 'sin HOME_LAYOUT_ENABLED la web sigue con la portada anterior');
  assert.deepEqual(snapOther(), other, 'catálogo, categorías y secciones intactos');
  process.env.HOME_LAYOUT_ENABLED = 'true';
  try {
    const home = Pub.buildPublicHome();
    assert.equal(home.mode, 'layout');
    const by = Object.fromEntries([...home.top, ...home.bottom].map((x) => [x.id, x]));
    assert.deepEqual(Object.keys(by), ['bienvenida', 'categorias', 'mas-economicos', 'en-amazon', 'portabilidad', 'informatica', 'sonido']);
    assert.equal(by['mas-economicos'].productIds.length, 4);
    assert.equal(by['en-amazon'].productIds.length, 4);
    assert.ok(by['en-amazon'].productIds.every((id) => ['p1', 'p3', 'p5', 'p11', 'p13', 'p15', 'p21', 'p23', 'p25', 'p31', 'p33', 'p35'].includes(id)), 'sólo productos de Amazon');
    for (const id of ['portabilidad', 'informatica', 'sonido']) assert.equal(by[id].productIds.length, 6, id);
    assert.equal(by.categorias.categories.length, 4);
    assert.equal(by.bienvenida.editorial.href, '/#catalogo');
    // restauración: desactivar vuelve a la portada anterior sin borrar nada
    const dres = await actRoute.POST({ request: new Request(`${B}activation`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC }, body: JSON.stringify({ action: 'deactivate', confirm: true }) }) });
    assert.equal(dres.status, 200);
    assert.equal(Pub.buildPublicHome().mode, 'legacy');
    assert.equal(L.readHomeLayout().doc.published.version, 1, 'la versión sigue guardada');
    assert.equal(L.readHomeLayout().doc.draft.blocks.length, 7);
  } finally { delete process.env.HOME_LAYOUT_ENABLED; }
});

test('API: nunca sobrescribe — repetir la carga, o cargar con borrador, versión o activación previas, se rechaza (409) sin tocar los archivos', async () => {
  const before = { l: sha(f('home-layout.json')), a: sha(f('home-layout-activation.json')) };
  const again = await load();
  assert.equal(again.status, 409);
  assert.equal(sha(f('home-layout.json')), before.l);
  assert.equal(sha(f('home-layout-activation.json')), before.a);
  const gg = await j(await get());
  assert.deepEqual([gg.available, gg.reason], [false, 'ya_existe_borrador']);
  // sólo borrador existente
  reset(); seed();
  const doc = { ...V.emptyDocument(), draft: { blocks: I.INITIAL_BLOCKS.slice(0, 2), updatedAt: '2026-11-10T10:00:00.000Z' } };
  assert.ok(L.writeHomeLayout(doc).ok);
  const h = sha(f('home-layout.json'));
  assert.equal((await post(body())).status, 409);
  assert.equal(sha(f('home-layout.json')), h);
  assert.equal(fs.existsSync(f('home-layout-activation.json')), false);
});

test('API: con datos que no permiten mostrar la portada (categorías inexistentes) → 422 y no se escribe nada', async () => {
  reset(); seed({ withCats: ['informatica'] });
  const g = await j(await get());
  assert.equal(g.check.canLoad, false);
  assert.ok(g.check.blocking.length > 0);
  const r = await load();
  assert.equal(r.status, 422);
  const b = await j(r);
  assert.equal(b.code, 'referencias_bloqueantes');
  assert.ok(b.blocking.length > 0);
  assert.equal(fs.readdirSync(dir).some((n) => /^home-layout/.test(n)), false);
  seed();
});

test('API: archivos protegidos (dañados) → 423 sin tocarlos; fallo de escritura de la portada → se deshace la activación (la web sigue igual)', async () => {
  reset(); seed();
  fs.writeFileSync(f('home-layout.json'), '{roto');
  assert.equal((await load()).status === 423 || (await post(body())).status === 423, true);
  assert.equal(fs.readFileSync(f('home-layout.json'), 'utf8'), '{roto');
  reset(); fs.writeFileSync(f('home-layout-activation.json'), '{roto');
  assert.equal((await post(body())).status === 423 || (await load()).status === 423, true);
  assert.equal(fs.readFileSync(f('home-layout-activation.json'), 'utf8'), '{roto');
  reset(); seed();
  // home-layout.json como DIRECTORIO: la activación se escribe pero la portada no → se deshace
  fs.mkdirSync(f('home-layout.json'));
  const r = await post(body());
  assert.ok([423, 500].includes(r.status));
  const act = AS.readActivation();
  assert.ok(act.status === 'missing' || act.doc.active === false, 'la activación no queda activa');
  fs.rmSync(f('home-layout.json'), { recursive: true });
  process.env.HOME_LAYOUT_ENABLED = 'true';
  try { assert.equal(Pub.buildPublicHome().mode, 'legacy'); } finally { delete process.env.HOME_LAYOUT_ENABLED; }
});

test('estático: la carga usa las decisiones existentes, el editor la lanza sólo con confirmación y nada la ejecuta sola', () => {
  const lib = read('src/lib/homeLayout/initialLayout.ts').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(lib, /planPublish\(/);
  assert.match(lib, /planActivate\(/);
  assert.doesNotMatch(lib, /node:fs|fetch\(|process\.env/, 'puro');
  const api = read('src/pages/api/admin/home-layout/initial.ts');
  assert.match(api, /requireAdminAuth\(request\)/);
  assert.match(api, /sameOrigin\(request\)/);
  assert.match(api, /x-home-layout-editor/);
  const client = read('src/scripts/homeLayoutEditor.ts').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal((client.match(/home-layout\/initial', \{\s*method: 'POST'/g) ?? []).length, 1, 'un único punto de carga');
  assert.match(client, /confirmBox\('Cargar la portada inicial'/);
  for (const p of ['src/pages/index.astro', 'src/layouts/Layout.astro', 'src/middleware.ts']) assert.doesNotMatch(read(p), /initialLayout|home-layout\/initial/, p);
});
