// Portada editable · etapa 6: activación y desactivación de emergencia. Modelo puro, API (permisos, CSRF, confirmación, concurrencia,
// bloqueos, registro, archivos dañados, fallos de escritura) y recuperación de la portada anterior.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-activation-');
delete process.env.HOME_LAYOUT_ENABLED;
const A = await import('../../src/lib/homeLayout/activation.ts');
const AS = await import('../../src/lib/homeLayout/activationStore.ts');
const L = await import('../../src/lib/homeLayout/store.ts');
const V = await import('../../src/lib/homeLayout/validate.ts');
const Pub = await import('../../src/lib/homeLayout/public.ts');
const route = await import('../../src/pages/api/admin/home-layout/activation.ts');
const pubRoute = await import('../../src/pages/api/admin/home-layout/publish.ts');
const auth = await import('../../src/lib/adminAuth.ts');
const users = await import('../../src/lib/userStore.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const f = (n) => path.join(dir, n);
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const OTHER = ['products.json', 'deleted-product-ids.json', 'categories.json', 'sections.json'];
const snapOther = () => Object.fromEntries(OTHER.map((n) => [n, sha(f(n))]));
const B = 'http://localhost/api/admin/home-layout/';
const NOW = new Date('2026-11-10T12:00:00.000Z');

const prod = (i, over = {}) => ({ id: `p${i}`, slug: `p${i}`, title: `Producto ${i}`, price: 10 + i, category: 'Sonido', category_id: 'sonido', network: 'amazon', merchant: 'X', currency: 'EUR', inStock: true, image: '/i.jpg', affiliateUrl: 'https://x/', sourceId: `S${i}`, extra: {}, ...over });
const seed = (over = {}) => {
  fs.writeFileSync(f('products.json'), JSON.stringify(Array.from({ length: 8 }, (_, i) => prod(i + 1, over[i + 1] ?? {}))));
  fs.writeFileSync(f('categories.json'), JSON.stringify([{ id: 'sonido', name: 'Sonido', slug: 'sonido', icon: '🎧', keywords: [] }]));
  fs.writeFileSync(f('sections.json'), '[]');
  fs.writeFileSync(f('deleted-product-ids.json'), '[]');
};
seed();
const blk = (id, over = {}) => ({ id, modality: 'manual', format: 'carrusel', width: 12, title: `Bloque ${id}`, card: 'producto', config: {}, refs: [{ kind: 'product', id: 'p1' }, { kind: 'product', id: 'p2' }], visible: true, ...over });
const ver = (version, blocks) => ({ version, publishedAt: '2026-11-10T10:00:00.000Z', blocks });
const layoutDoc = ({ pub, archived = [], enabled = false } = {}) => ({ ...V.emptyDocument(), activation: { enabled }, draft: { blocks: [], updatedAt: null }, published: pub ?? null, versions: archived });
const reset = () => { for (const n of ['home-layout.json', 'home-layout.json.bak', 'home-layout-activation.json', 'home-layout-activation.json.bak']) fs.rmSync(f(n), { force: true }); };

/* ───────── Modelo puro ───────── */
test('documento de activación: validación estricta, registro acotado y selectActiveVersion exige archivo activo + versión existente', () => {
  assert.ok(A.validateActivationDocument(A.emptyActivation()).ok);
  const bad = (x) => A.validateActivationDocument(x).ok;
  assert.equal(bad({ ...A.emptyActivation(), extra: 1 }), false);
  assert.equal(bad({ ...A.emptyActivation(), schemaVersion: 2 }), false);
  assert.equal(bad({ ...A.emptyActivation(), active: true }), false, 'activa sin versión fijada');
  assert.equal(bad({ ...A.emptyActivation(), pinnedVersion: 0 }), false);
  assert.equal(bad({ ...A.emptyActivation(), updatedAt: 'ayer' }), false);
  assert.equal(bad({ ...A.emptyActivation(), log: [{ at: 'x' }] }), false);
  let d = A.emptyActivation();
  for (let i = 0; i < 260; i++) d = A.appendLog(d, { at: 'x', by: 'u', action: 'activate', version: 1, result: 'ok' });
  assert.equal(d.log.length, A.MAX_LOG_ENTRIES, 'registro acotado');
  const doc = layoutDoc({ pub: ver(3, [blk('a')]), archived: [ver(2, [blk('b')])] });
  assert.equal(A.selectActiveVersion(doc, { active: true, pinnedVersion: 2 }).blocks[0].id, 'b');
  assert.equal(A.selectActiveVersion(doc, { active: false, pinnedVersion: 2 }), null);
  assert.equal(A.selectActiveVersion(doc, { active: true, pinnedVersion: 9 }), null);
  assert.equal(A.selectActiveVersion(doc, { active: true, pinnedVersion: null }), null);
});

const okCheck = () => ({ blocking: [], warnings: [], visibleBlocks: 1, totalBlocks: 1 });
const plan = (input, { layout, act, check = okCheck } = {}) => A.planActivate(layout ?? { status: 'ok', doc: layoutDoc({ pub: ver(1, [blk('a')]) }) }, act ?? { status: 'ok', doc: A.emptyActivation() }, input, check, NOW, 'tester');
const body = (over = {}) => ({ action: 'activate', version: 1, baseRevision: 'inicial', confirm: true, ...over });

test('planActivate: confirmación, concurrencia, versión, bloqueos, protegidos y éxito (fija versión, enciende, registra)', () => {
  const r = plan(body());
  assert.ok(r.ok);
  assert.deepEqual([r.doc.active, r.doc.pinnedVersion, r.layout.activation.enabled, r.doc.log.at(-1).action], [true, 1, true, 'activate']);
  assert.ok(r.doc.updatedAt > '2026-11-10T11:59:59.999Z');
  const reason = (input, opts) => plan(input, opts).reason;
  assert.equal(reason(body({ confirm: undefined })), 'confirmacion_requerida');
  assert.equal(reason(body({ confirm: 'si' })), 'confirmacion_requerida');
  assert.equal(reason(body({ baseRevision: 'otra' })), 'conflicto');
  assert.equal(reason(body({ version: 9 })), 'version_no_encontrada');
  assert.equal(reason(body({ version: 0 })), 'peticion_invalida');
  assert.equal(reason(body({ extra: 1 })), 'peticion_invalida');
  assert.equal(reason(null), 'peticion_invalida');
  assert.equal(reason(body(), { layout: { status: 'corrupt', doc: layoutDoc() } }), 'archivo_protegido');
  for (const status of ['corrupt', 'invalid', 'newer']) assert.equal(reason(body(), { act: { status, doc: A.emptyActivation() } }), 'activacion_protegida', status);
  assert.equal(reason(body(), { layout: { status: 'ok', doc: layoutDoc({ pub: ver(1, []) }) } }), 'version_vacia');
  const blocked = plan(body(), { check: () => ({ ...okCheck(), blocking: [{ blockId: 'a', title: 'A', code: 'x', message: 'm' }] }) });
  assert.equal(blocked.reason, 'referencias_bloqueantes');
  assert.equal(blocked.blocking.length, 1);
  // ya activa la misma versión → sin cambios; otra versión → permitido (cambia la fijada)
  const active = { status: 'ok', doc: { ...A.emptyActivation(), active: true, pinnedVersion: 1, updatedAt: '2026-11-10T11:00:00.000Z' } };
  const lay = { status: 'ok', doc: layoutDoc({ pub: ver(2, [blk('b')]), archived: [ver(1, [blk('a')])], enabled: true }) };
  assert.equal(reason(body({ baseRevision: '2026-11-10T11:00:00.000Z' }), { act: active, layout: lay }), 'sin_cambios');
  assert.equal(plan(body({ version: 2, baseRevision: '2026-11-10T11:00:00.000Z' }), { act: active, layout: lay }).doc.pinnedVersion, 2);
});

test('planDeactivate: siempre posible (ignora la revisión y archivos protegidos), apaga los dos interruptores y registra', () => {
  const act = { status: 'ok', doc: { ...A.emptyActivation(), active: true, pinnedVersion: 2, updatedAt: '2026-11-10T11:00:00.000Z' } };
  const layout = { status: 'ok', doc: layoutDoc({ pub: ver(2, [blk('a')]), enabled: true }) };
  const r = A.planDeactivate(layout, act, { action: 'deactivate', confirm: true }, NOW, 'tester');
  assert.ok(r.ok);
  assert.deepEqual([r.doc.active, r.doc.pinnedVersion, r.layout.activation.enabled, r.doc.log.at(-1).action], [false, 2, false, 'deactivate'], 'la versión fijada se conserva para auditoría');
  assert.equal(A.planDeactivate(layout, act, { action: 'deactivate' }, NOW, 'x').reason, 'confirmacion_requerida');
  assert.equal(A.planDeactivate(layout, act, { action: 'deactivate', confirm: true, x: 1 }, NOW, 'x').reason, 'peticion_invalida');
  assert.ok(A.planDeactivate(layout, { status: 'corrupt', doc: A.emptyActivation() }, { action: 'deactivate', confirm: true }, NOW, 'x').ok, 'aunque el archivo de activación esté dañado');
});

const BLOCKS = (...x) => x;
test('checkForActivation: «recientes» sin fecha fiable, enlaces e imágenes editoriales inseguros y portada vacía BLOQUEAN; los avisos no', async () => {
  seed();
  const S = await import('../../src/lib/homeLayout/sources.ts');
  const R = await import('../../src/lib/homeLayout/resolve.ts');
  const check = (blocks) => A.checkForActivation(blocks, R.resolveBlocks(blocks, S.loadSources(), { runAutomatic: true }).blocks);
  const rec = blk('rec', { modality: 'automatica', refs: [], config: { rules: { order: 'recientes', limit: 4 } } });
  const c1 = check(BLOCKS(blk('ok'), rec));
  assert.ok(c1.blocking.some((b) => b.code === 'recientes_sin_fecha_fiable' && b.blockId === 'rec'), 'bloquea y explica');
  assert.match(c1.blocking.find((b) => b.code === 'recientes_sin_fecha_fiable').message, /precio/, 'indica cómo corregirlo desde el editor');
  assert.equal(check(BLOCKS(blk('ok'), { ...rec, visible: false })).blocking.length, 0, 'oculto: no bloquea');
  assert.equal(check(BLOCKS(blk('ok'), { ...rec, config: { rules: { order: 'precio_asc', limit: 4 } } })).blocking.length, 0, 'corregido a precio: se puede activar');
  const ed = (cfg) => blk('ed', { modality: 'editorial', card: 'promocion', refs: [], config: { headline: 'H', buttonLabel: 'Ir', ...cfg } });
  assert.ok(check(BLOCKS(blk('ok'), ed({ link: { type: 'path', target: '/upayp1b4' } }))).blocking.some((b) => b.code === 'editorial_link_unsafe'));
  assert.ok(check(BLOCKS(blk('ok'), ed({ link: { type: 'path', target: '/api/admin/x' } }))).blocking.some((b) => b.code === 'editorial_link_unsafe'));
  assert.ok(check(BLOCKS(blk('ok'), ed({ imageUrl: '/images/products/v.mp4' }))).blocking.some((b) => b.code === 'editorial_image_unsafe'));
  assert.equal(check(BLOCKS(blk('ok'), ed({ link: { type: 'path', target: '/guias' }, imageUrl: '/images/products/a.jpg' }))).blocking.length, 0);
  const empty = check(BLOCKS(blk('roto', { refs: [{ kind: 'product', id: 'p404' }] })));
  assert.ok(empty.blocking.some((b) => b.code === 'sin_bloques_visibles'));
  assert.equal(c1.visibleBlocks, 1);
});

/* ───────── API ───────── */
let adminC; let common;
const getA = (qs = '', ...rest) => { const cookie = rest.length ? rest[0] : adminC; return route.GET({ request: new Request(`${B}activation${qs}`, { method: 'GET', headers: cookie ? { Cookie: cookie } : {} }) }); };
const postA = (payload, opts = {}) => { const { headers = {}, raw } = opts; const cookie = 'cookie' in opts ? opts.cookie : adminC; return route.POST({ request: new Request(`${B}activation`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? JSON.stringify(payload) }) }); };
const json = (r) => r.json();
const writeLayout = (doc) => assert.equal(L.writeHomeLayout(doc).ok, true);
const st = async () => json(await getA());
const activate = async (version, over = {}) => { const s = await st(); return postA({ action: 'activate', version, baseRevision: s.revision, confirm: true, ...over }); };

test('permisos: GET y POST exigen administrador (sin sesión, cookie falsa o usuario común → 401); otros métodos 405 sólo con sesión; no escriben', async () => {
  reset();
  adminC = await adminCookie();
  const master = auth.authenticateUser('tester', 'Test-pass-123');
  const actor = users.toPublicUser(users.findUserById(master.id));
  users.createUser({ username: 'comun6', password: 'Clave-comun-123', name: 'Común', role: 'user' }, actor);
  common = auth.createAdminSession(auth.authenticateUser('comun6', 'Clave-comun-123')).split(';')[0];
  for (const cookie of [undefined, 'tradylor_admin_session=falsa.1.x', common]) {
    assert.equal((await getA('', cookie)).status, 401);
    assert.equal((await postA({ action: 'deactivate', confirm: true }, { cookie })).status, 401);
    assert.equal((await route.ALL({ request: new Request(`${B}activation`, { method: 'DELETE', headers: cookie ? { Cookie: cookie } : {} }) })).status, 401);
  }
  const r = await route.ALL({ request: new Request(`${B}activation`, { method: 'PUT', headers: { Cookie: adminC } }) });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('Allow'), 'GET, POST');
  assert.equal(fs.existsSync(f('home-layout-activation.json')), false);
});

test('POST: CSRF (origen y cabecera), JSON, tamaño y campos desconocidos se rechazan sin escribir', async () => {
  reset();
  writeLayout(layoutDoc({ pub: ver(1, [blk('a')]) }));
  const before = sha(f('home-layout.json'));
  const ok = { action: 'activate', version: 1, baseRevision: 'inicial', confirm: true };
  const evil = await route.POST({ request: new Request(`${B}activation`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC, Origin: 'https://evil.example' }, body: JSON.stringify(ok) }) });
  assert.equal(evil.status, 403);
  assert.equal((await postA(ok, { headers: { 'X-Home-Layout-Editor': '0' } })).status, 403);
  assert.equal((await postA(ok, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await postA(null, { raw: '{no json' })).status, 400);
  assert.equal((await postA(null, { raw: JSON.stringify({ ...ok, relleno: 'x'.repeat(3000) }) })).status, 413);
  assert.equal((await postA({ ...ok, action: 'borrar' })).status, 400);
  assert.equal((await postA({ ...ok, extra: 1 })).status, 400);
  assert.equal((await postA({ ...ok, confirm: false })).status, 400);
  assert.equal(sha(f('home-layout.json')), before);
  assert.equal(fs.existsSync(f('home-layout-activation.json')), false, 'ninguna petición rechazada escribe');
});

test('GET: estado de los candados, versiones, registro y validación previa (check) sin escribir', async () => {
  reset();
  writeLayout(layoutDoc({ pub: ver(2, [blk('a')]), archived: [ver(1, [blk('b')])] }));
  const s = await st();
  assert.equal(s.success, true);
  assert.deepEqual([s.gates.stage, s.gates.env, s.gates.adminFlag, s.gates.activeFile, s.gates.pinnedVersion], [true, false, false, false, null]);
  assert.equal(s.mode, 'legacy');
  assert.equal(s.revision, 'inicial');
  assert.deepEqual(s.versions.map((v) => v.version), [2, 1]);
  const c = await json(await getA('?check=2'));
  assert.equal(c.check.canActivate, true);
  assert.equal(c.check.visibleBlocks, 1);
  assert.equal((await getA('?check=9')).status, 404);
  assert.equal((await getA('?check=abc')).status, 400);
  assert.equal((await getA('?otro=1')).status, 400);
  assert.equal((await getA('?check=1&check=2')).status, 400);
  assert.equal(fs.existsSync(f('home-layout-activation.json')), false, 'GET no escribe');
});

test('activar: fija la versión, enciende el interruptor, registra, y sin la variable del servidor la web NO cambia; con ella sí', async () => {
  reset();
  seed();
  writeLayout(layoutDoc({ pub: ver(1, [blk('a')]) }));
  const other = snapOther();
  const r = await activate(1);
  assert.equal(r.status, 200);
  const b = await json(r);
  assert.deepEqual([b.success, b.version, b.envEnabled, b.mode], [true, 1, false, 'legacy'], 'sin HOME_LAYOUT_ENABLED la web sigue igual');
  assert.equal(L.readHomeLayout().doc.activation.enabled, true);
  const a = AS.readActivation().doc;
  assert.deepEqual([a.active, a.pinnedVersion, a.log.length, a.log[0].by, a.log[0].result], [true, 1, 1, 'tester', 'ok']);
  assert.equal(Pub.buildPublicHome().mode, 'legacy');
  process.env.HOME_LAYOUT_ENABLED = 'true';
  try {
    assert.equal(Pub.buildPublicHome().mode, 'layout', 'con la variable del servidor, la portada nueva se sirve');
    assert.equal((await st()).mode, 'layout');
    // publicar otra versión interna NO cambia la web
    const s = JSON.parse(fs.readFileSync(f('home-layout.json'), 'utf8'));
    const doc = L.readHomeLayout().doc;
    const draft = { blocks: [blk('nuevo', { title: 'Otra' })], updatedAt: '2026-11-10T11:30:00.000Z' };
    writeLayout({ ...doc, draft });
    const pubRes = await pubRoute.POST({ request: new Request(`${B}publish`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC }, body: JSON.stringify({ action: 'publish', baseRevision: draft.updatedAt, basePublished: 1, confirm: true }) }) });
    assert.equal(pubRes.status, 200);
    assert.equal(L.readHomeLayout().doc.published.version, 2);
    const home = Pub.buildPublicHome();
    assert.equal(home.version, 1, 'la web sigue con la versión FIJADA (v1)');
    assert.deepEqual(home.top.map((x) => x.id), ['a']);
    assert.ok(s);
  } finally { delete process.env.HOME_LAYOUT_ENABLED; }
  assert.deepEqual(snapOther(), other, 'catálogo, categorías y secciones intactos');
});

test('activar: concurrencia (revisión obsoleta), versión inexistente, ya activa y registro de las rechazadas', async () => {
  reset();
  writeLayout(layoutDoc({ pub: ver(2, [blk('a')]), archived: [ver(1, [blk('b')])] }));
  const first = await st();
  assert.equal((await postA({ action: 'activate', version: 2, baseRevision: 'obsoleta', confirm: true })).status, 409);
  assert.equal(fs.existsSync(f('home-layout-activation.json')), false, 'el conflicto no escribe');
  assert.equal((await postA({ action: 'activate', version: 9, baseRevision: first.revision, confirm: true })).status, 404);
  assert.equal((await activate(2)).status, 200);
  const again = await activate(2);
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'sin_cambios');
  const sw = await activate(1);
  assert.equal(sw.status, 200, 'cambiar de versión fijada estando activa es posible');
  assert.equal(AS.readActivation().doc.pinnedVersion, 1);
  // dos administradores con la misma revisión: sólo el primero entra
  const s = await st();
  const r1 = await postA({ action: 'activate', version: 2, baseRevision: s.revision, confirm: true });
  const r2 = await postA({ action: 'activate', version: 1, baseRevision: s.revision, confirm: true });
  assert.deepEqual([r1.status, r2.status], [200, 409]);
  // las rechazadas por validación quedan en el registro sin cambiar la revisión
  const log = AS.readActivation().doc.log;
  assert.ok(log.length >= 4);
});

test('activar bloqueado: «recientes» sin fecha fiable y referencias rotas → 422 con la explicación; queda registrado y no cambia nada', async () => {
  reset();
  seed();
  const rec = blk('rec', { modality: 'automatica', refs: [], config: { rules: { order: 'recientes', limit: 4 } } });
  writeLayout(layoutDoc({ pub: ver(1, [blk('ok'), rec]) }));
  const before = sha(f('home-layout.json'));
  const r = await activate(1);
  assert.equal(r.status, 422);
  const b = await json(r);
  assert.equal(b.code, 'referencias_bloqueantes');
  assert.ok(b.blocking.some((x) => x.code === 'recientes_sin_fecha_fiable'));
  assert.equal(sha(f('home-layout.json')), before, 'home-layout.json intacto');
  const a = AS.readActivation().doc;
  assert.deepEqual([a.active, a.pinnedVersion], [false, null]);
  assert.equal(a.log.at(-1).result, 'rechazada');
  // corregido a precio, se puede activar (y el GET ?check lo anticipa)
  const fixed = blk('rec', { modality: 'automatica', refs: [], config: { rules: { order: 'precio_asc', limit: 4 } } });
  writeLayout(layoutDoc({ pub: ver(1, [blk('ok'), fixed]) }));
  assert.equal((await json(await getA('?check=1'))).check.canActivate, true);
  assert.equal((await activate(1)).status, 200);
});

test('desactivación de emergencia: inmediata, ignora revisiones, vuelve a la portada anterior y se registra', async () => {
  reset();
  seed();
  writeLayout(layoutDoc({ pub: ver(1, [blk('a')]) }));
  assert.equal((await activate(1)).status, 200);
  process.env.HOME_LAYOUT_ENABLED = 'true';
  try {
    assert.equal(Pub.buildPublicHome().mode, 'layout');
    const r = await postA({ action: 'deactivate', baseRevision: 'cualquiera', confirm: true });
    assert.equal(r.status, 200);
    const b = await json(r);
    assert.deepEqual([b.success, b.mode, b.activationFileWritten, b.adminFlagWritten], [true, 'legacy', true, true]);
    assert.equal(Pub.buildPublicHome().mode, 'legacy', 'a la siguiente petición la web ya sirve la portada anterior');
    assert.equal(L.readHomeLayout().doc.activation.enabled, false);
    const a = AS.readActivation().doc;
    assert.deepEqual([a.active, a.pinnedVersion, a.log.at(-1).action], [false, 1, 'deactivate']);
    assert.equal(L.readHomeLayout().doc.published.version, 1, 'no se borra nada');
    assert.equal((await postA({ action: 'deactivate', confirm: false })).status, 400);
  } finally { delete process.env.HOME_LAYOUT_ENABLED; }
});

test('desactivación de emergencia con almacenamiento dañado: funciona por la vía que quede y la web ya sirve la portada anterior', async () => {
  reset();
  seed();
  writeLayout(layoutDoc({ pub: ver(1, [blk('a')]) }));
  assert.equal((await activate(1)).status, 200);
  process.env.HOME_LAYOUT_ENABLED = 'true';
  try {
    // 1) archivo de activación dañado: la web ya sirve la portada anterior; desactivar sigue respondiendo bien y apaga el interruptor del administrador
    fs.writeFileSync(f('home-layout-activation.json'), '{roto');
    assert.equal(Pub.buildPublicHome().mode, 'legacy');
    const r1 = await postA({ action: 'deactivate', confirm: true });
    assert.equal(r1.status, 200);
    const b1 = await json(r1);
    assert.deepEqual([b1.activationFileWritten, b1.adminFlagWritten], [false, true]);
    assert.equal(fs.readFileSync(f('home-layout-activation.json'), 'utf8'), '{roto', 'el archivo dañado se conserva para diagnóstico');
    assert.equal(L.readHomeLayout().doc.activation.enabled, false);
    // 2) portada dañada: sigue siendo legacy y la petición no falla
    fs.rmSync(f('home-layout-activation.json'));
    fs.writeFileSync(f('home-layout.json'), '{roto');
    const r2 = await postA({ action: 'deactivate', confirm: true });
    assert.equal(r2.status, 200);
    assert.equal(Pub.buildPublicHome().mode, 'legacy');
    assert.equal(fs.readFileSync(f('home-layout.json'), 'utf8'), '{roto');
    // activar con la portada dañada → 423 y sin tocar nada
    assert.equal((await postA({ action: 'activate', version: 1, baseRevision: (await st()).revision, confirm: true })).status, 423);
  } finally { delete process.env.HOME_LAYOUT_ENABLED; }
});

test('fallo de escritura al activar: se deshace (queda desactivada y registrada) y la web no cambia', async () => {
  reset();
  seed();
  writeLayout(layoutDoc({ pub: ver(1, [blk('a')]) }));
  // home-layout.json.bak como DIRECTORIO: copyFileSync falla al escribir home-layout.json pero el de activación sí se escribe
  fs.mkdirSync(f('home-layout.json.bak'));
  const r = await activate(1);
  assert.equal(r.status, 500);
  assert.equal(L.readHomeLayout().doc.activation.enabled, false, 'el interruptor del administrador no se encendió');
  const a = AS.readActivation().doc;
  assert.equal(a.active, false, 'la activación se deshizo');
  assert.equal(a.log.at(-1).result, 'error');
  fs.rmSync(f('home-layout.json.bak'), { recursive: true });
  process.env.HOME_LAYOUT_ENABLED = 'true';
  try { assert.equal(Pub.buildPublicHome().mode, 'legacy'); } finally { delete process.env.HOME_LAYOUT_ENABLED; }
});

test('almacén de activación: escritura atómica con .bak, archivos dañados/no válidos/más nuevos no se sobrescriben', () => {
  reset();
  assert.equal(AS.readActivation().status, 'missing');
  const doc = { ...A.emptyActivation(), active: true, pinnedVersion: 1, updatedAt: '2026-11-10T11:00:00.000Z' };
  assert.equal(AS.writeActivation(doc).ok, true);
  assert.equal(AS.writeActivation({ ...doc, updatedAt: '2026-11-10T11:00:01.000Z' }).ok, true);
  assert.ok(fs.existsSync(f('home-layout-activation.json.bak')));
  assert.equal(AS.writeActivation({ ...doc, extra: 1 }).reason, 'documento_invalido');
  for (const [text, status] of [['{no', 'corrupt'], [JSON.stringify({ ...doc, active: 'si' }), 'invalid'], [JSON.stringify({ ...doc, schemaVersion: 9 }), 'newer']]) {
    fs.writeFileSync(f('home-layout-activation.json'), text);
    assert.equal(AS.readActivation().status, status);
    assert.equal(AS.writeActivation(doc).reason, 'archivo_protegido');
    assert.equal(fs.readFileSync(f('home-layout-activation.json'), 'utf8'), text, 'conservado');
  }
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, 'sin temporales');
});

test('estático: sólo se activa mediante la API con confirmación; el código no activa nada por sí solo y los candados siguen cerrados por defecto', () => {
  assert.equal(L.HOME_LAYOUT_STAGE_ENABLED, true);
  const api = code('src/pages/api/admin/home-layout/activation.ts');
  assert.match(api, /requireAdminAuth\(request\)/);
  assert.match(api, /sameOrigin\(request\)/);
  assert.match(api, /x-home-layout-editor/);
  assert.match(api, /MAX_ACTIVATION_BODY_BYTES/);
  for (const p of ['src/lib/homeLayout/activation.ts', 'src/lib/homeLayout/publicSafety.ts']) assert.doesNotMatch(code(p), /node:fs|fetch\(|process\.env/, `${p} es puro`);
  // ningún otro módulo enciende la activación
  for (const p of ['src/lib/homeLayout/store.ts', 'src/lib/homeLayout/publish.ts', 'src/lib/homeLayout/draft.ts', 'src/pages/api/admin/home-layout/publish.ts', 'src/pages/api/admin/home-layout/draft.ts', 'src/pages/api/admin/home-layout/versions.ts']) {
    assert.doesNotMatch(code(p), /enabled\s*:\s*true/, p);
  }
  for (const f2 of ['.env.example']) assert.doesNotMatch(read(f2), /^HOME_LAYOUT_ENABLED\s*=\s*true/m, 'la variable no se activa por defecto');
});

test('orden por defecto de los bloques automáticos NUEVOS = precio ascendente; los guardados no se tocan', async () => {
  const D = await import('../../src/lib/homeLayout/draft.ts');
  const created = D.createBlock('automatica', 'carrusel', []);
  assert.equal(created.config.rules.order, 'precio_asc');
  assert.ok(V.validateBlock(created).ok, 'el bloque nuevo es válido');
  assert.equal(D.createBlock('manual', 'carrusel', []).modality, 'manual');
  // un bloque guardado con «recientes» se normaliza tal cual (no se reescribe)
  const saved = blk('s', { modality: 'automatica', refs: [], config: { rules: { order: 'recientes', limit: 5 } } });
  assert.equal(V.validateBlock(saved).value.config.rules.order, 'recientes');
  const doc = layoutDoc({ pub: ver(1, [saved]) });
  assert.equal(V.validateDocument(doc).value.published.blocks[0].config.rules.order, 'recientes');
});
