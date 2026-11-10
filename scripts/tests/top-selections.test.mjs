// Menú «Top Selecciones» gestionado a mano: modelo puro, almacén (atómico, protegido, recuperable), API (permisos, CSRF, conflictos, límites),
// creación de secciones sin incorporación automática (con fallo = sin sección y sin estado parcial) y enlaces válidos con ambas portadas.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-top-selections-');
delete process.env.HOME_LAYOUT_ENABLED;
const T = await import('../../src/lib/topSelections.ts');
const route = await import('../../src/pages/api/admin/top-selections.ts');
const secRoute = await import('../../src/pages/api/admin/sections.ts');
const auth = await import('../../src/lib/adminAuth.ts');
const users = await import('../../src/lib/userStore.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const f = (n) => path.join(dir, n);
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const B = 'http://localhost/api/admin/';

const prod = (i) => ({ id: `p${i}`, slug: `p${i}`, title: `Producto ${i}`, price: 10 + i, category: 'Sonido', network: 'amazon', merchant: 'X', currency: 'EUR', inStock: true, image: '/i.jpg', affiliateUrl: 'https://x/', sourceId: `S${i}`, extra: {} });
const sec = (id, ids, over = {}) => ({ id, title: `Sección ${id}`, productIds: ids, published: true, order: 0, position: 'below', speed: 'normal', createdAt: '2026-11-01', ...over });
const SECS = () => [sec('a', ['p1', 'p2'], { order: 2 }), sec('b', ['p3'], { order: 0, position: 'above' }), sec('c', ['p4'], { order: 1 }), sec('vacia', ['p404'], { order: 3 }), sec('oculta', ['p5'], { order: 4, published: false })];
const seed = (secs = SECS()) => {
  fs.writeFileSync(f('products.json'), JSON.stringify(Array.from({ length: 8 }, (_, i) => prod(i + 1))));
  fs.writeFileSync(f('categories.json'), JSON.stringify([{ id: 'sonido', name: 'Sonido', slug: 'sonido', icon: '🎧', keywords: [] }]));
  fs.writeFileSync(f('sections.json'), JSON.stringify(secs));
  fs.writeFileSync(f('deleted-product-ids.json'), '[]');
};
const resetNav = () => { for (const n of ['nav-top-sections.json', 'nav-top-sections.json.bak']) fs.rmSync(f(n), { recursive: true, force: true }); for (const x of fs.readdirSync(dir)) if (x.startsWith('nav-top-sections.corrupt-')) fs.rmSync(f(x)); };
const doc = (ids, updatedAt = '2026-11-10T10:00:00.000Z') => ({ schemaVersion: 1, updatedAt, items: ids.map((sectionId) => ({ sectionId })) });
const ctxLegacy = (rendered) => ({ mode: 'legacy', rendered: new Set(rendered) });
seed();

/* ───────── Modelo puro ───────── */
test('documento: validación estricta (campos, duplicados, límite, esquema)', () => {
  assert.ok(T.validateTopDocument(doc(['a', 'b'])).ok);
  const bad = (x) => T.validateTopDocument(x).ok;
  assert.equal(bad(null), false);
  assert.equal(bad({ ...doc(['a']), extra: 1 }), false);
  assert.equal(bad({ ...doc(['a']), schemaVersion: 2 }), false);
  assert.equal(bad(doc(['a', 'a'])), false, 'repetidos');
  assert.equal(bad(doc(Array.from({ length: 31 }, (_, i) => `s${i}`))), false, 'máximo 30');
  assert.ok(bad(doc(Array.from({ length: 30 }, (_, i) => `s${i}`))));
  assert.equal(bad({ ...doc(['a']), updatedAt: 'ayer' }), false);
  assert.equal(bad({ ...doc([]), items: [{ sectionId: 'a', x: 1 }] }), false);
  assert.equal(bad({ ...doc([]), items: [{ sectionId: '<script>' }] }), false);
});

test('resolveNav: automático = comportamiento de siempre (publicadas por order); manual = sólo lo elegido y en ese orden; omite lo que no se renderiza sin tocar lo guardado', () => {
  const secs = SECS();
  const auto = T.resolveNav(secs, { status: 'missing', doc: T.emptyTopDocument() }, ctxLegacy(['a', 'b', 'c']));
  assert.deepEqual([auto.mode, auto.items.map((s) => s.id)], ['automatico', ['b', 'c', 'a']], 'orden por order, sin la no publicada ni la vacía');
  assert.deepEqual(auto.skipped.map((s) => [s.id, s.reason]), [['vacia', 'sin_productos']].map((x) => x));
  const manual = T.resolveNav(secs, { status: 'ok', doc: doc(['a', 'c', 'oculta', 'vacia', 'fantasma', 'a']) }, ctxLegacy(['a', 'b', 'c']));
  assert.deepEqual(manual.items.map((s) => s.id), ['a', 'c'], 'orden manual; la b (publicada pero no elegida) NO entra');
  assert.deepEqual(manual.skipped.map((s) => `${s.id}:${s.reason}`), ['oculta:no_publicada', 'vacia:sin_productos', 'fantasma:no_existe']);
  assert.equal(T.resolveNav(secs, { status: 'ok', doc: doc([]) }, ctxLegacy(['a'])).items.length, 0, 'menú vacío: sólo las fijas');
  for (const status of ['corrupt', 'invalid', 'newer']) assert.equal(T.resolveNav(secs, { status, doc: T.emptyTopDocument() }, ctxLegacy(['a', 'b', 'c'])).mode, 'automatico', status);
  // independiente del orden de la portada: cambiar `order` no cambia el menú manual
  const reordered = secs.map((s) => ({ ...s, order: 10 - s.order }));
  assert.deepEqual(T.resolveNav(reordered, { status: 'ok', doc: doc(['a', 'c']) }, ctxLegacy(['a', 'b', 'c'])).items.map((s) => s.id), ['a', 'c']);
  // con la portada nueva: sólo lo que el plan pinta
  const layout = T.resolveNav(secs, { status: 'ok', doc: doc(['a', 'c']) }, { mode: 'layout', rendered: new Set(['c']) });
  assert.deepEqual(layout.items.map((s) => s.id), ['c']);
  assert.deepEqual(layout.skipped, [{ id: 'a', reason: 'no_se_muestra_en_la_portada_nueva' }]);
});

test('homeRenderContext: portada de siempre = publicadas con productos; portada nueva = las que pinta el plan (bloque oculto ⇒ sin enlace)', () => {
  const secs = SECS();
  const legacy = T.homeRenderContext(secs, () => ({ mode: 'legacy', reason: 'x' }));
  assert.deepEqual([legacy.mode, [...legacy.rendered].sort()], ['legacy', ['a', 'b', 'c']]);
  const plan = { mode: 'layout', version: 1, publishedAt: 'x', stories: [], top: [{ id: 'bb', section: { id: 'b' }, productIds: ['p3'] }, { id: 'm', productIds: ['p1'] }], bottom: [{ id: 'cc', section: { id: 'c' }, productIds: ['p4'] }] };
  const layout = T.homeRenderContext(secs, () => plan);
  assert.deepEqual([layout.mode, [...layout.rendered].sort()], ['layout', ['b', 'c']], 'la «a» no está en el plan (bloque oculto/no incluido): no se enlaza');
  assert.deepEqual(T.homeRenderContext(secs, () => { throw new Error('x'); }).mode, 'legacy', 'si el plan falla, portada de siempre');
});

test('planSave: revisión, duplicados, desconocidas, límite y estados protegidos', () => {
  const ok = { status: 'missing', doc: T.emptyTopDocument() };
  const ids = new Set(['a', 'b', 'c']);
  const now = new Date('2026-11-10T12:00:00.000Z');
  const p = T.planSave(ok, { baseRevision: 'inicial', items: ['c', 'a'] }, ids, now);
  assert.ok(p.ok);
  assert.deepEqual(p.doc.items.map((i) => i.sectionId), ['c', 'a']);
  const r = (input, read = ok) => T.planSave(read, input, ids, now).reason;
  assert.equal(r({ baseRevision: 'otra', items: [] }), 'conflicto');
  assert.equal(r({ baseRevision: 'inicial', items: ['a', 'a'] }), 'documento_invalido');
  assert.equal(r({ baseRevision: 'inicial', items: ['zzz'] }), 'documento_invalido');
  assert.equal(r({ baseRevision: 'inicial', items: Array.from({ length: 31 }, (_, i) => `s${i}`) }), 'documento_invalido');
  assert.equal(r({ baseRevision: 'inicial', items: [1] }), 'peticion_invalida');
  assert.equal(r({ baseRevision: 'inicial', items: [], x: 1 }), 'peticion_invalida');
  assert.equal(r(null), 'peticion_invalida');
  for (const status of ['corrupt', 'invalid', 'newer']) assert.equal(r({ baseRevision: 'inicial', items: [] }, { status, doc: T.emptyTopDocument() }), 'archivo_protegido', status);
  const stamped = { status: 'ok', doc: doc(['a'], '2026-11-10T13:00:00.000Z') };
  assert.ok(T.planSave(stamped, { baseRevision: '2026-11-10T13:00:00.000Z', items: ['a'] }, ids, now).revision > '2026-11-10T13:00:00.000Z', 'revisión estrictamente creciente aunque el reloj vaya atrasado');
});

/* ───────── Almacén ───────── */
test('almacén: escritura atómica con .bak; dañado/no válido/más nuevo no se sobrescriben; recuperación explícita con copia del dañado', () => {
  resetNav();
  assert.equal(T.readTopSelections().status, 'missing');
  assert.equal(fs.existsSync(f('nav-top-sections.json')), false, 'leer no crea nada');
  assert.ok(T.writeTopSelections(doc(['a'], '2026-11-10T10:00:00.000Z')).ok);
  assert.ok(T.writeTopSelections(doc(['a', 'b'], '2026-11-10T10:00:01.000Z')).ok);
  assert.ok(fs.existsSync(f('nav-top-sections.json.bak')));
  assert.equal(T.writeTopSelections({ ...doc(['a']), extra: 1 }).reason, 'documento_invalido');
  const good = fs.readFileSync(f('nav-top-sections.json'), 'utf8');
  for (const [text, status] of [['{no', 'corrupt'], [JSON.stringify({ ...doc(['a']), items: 'x' }), 'invalid'], [JSON.stringify({ ...doc(['a']), schemaVersion: 9 }), 'newer']]) {
    fs.writeFileSync(f('nav-top-sections.json'), text);
    assert.equal(T.readTopSelections().status, status);
    assert.equal(T.writeTopSelections(doc(['b'])).reason, 'archivo_protegido');
    assert.equal(fs.readFileSync(f('nav-top-sections.json'), 'utf8'), text, 'conservado');
  }
  const r = T.recoverTopSelections();
  assert.ok(r.ok && r.preservedCorrupt);
  assert.equal(T.readTopSelections().status, 'ok');
  assert.deepEqual(T.readTopSelections().doc.items.map((i) => i.sectionId), ['a'], 'la copia .bak era la versión anterior');
  assert.ok(fs.readdirSync(dir).some((x) => x.startsWith('nav-top-sections.corrupt-')), 'copia del dañado para diagnóstico');
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0);
  resetNav();
  assert.equal(T.recoverTopSelections().reason, 'sin_copia');
  void good;
});

test('ensureSnapshot: fija el menú vigente una sola vez; con manual no hace nada; dañado o fallo de escritura = error', () => {
  resetNav();
  const secs = SECS();
  const r = T.ensureSnapshot(secs);
  assert.deepEqual([r.ok, r.created], [true, true]);
  assert.deepEqual(T.readTopSelections().doc.items.map((i) => i.sectionId), ['b', 'c', 'a', 'vacia'], 'las publicadas por order (la no publicada no)');
  assert.deepEqual(T.ensureSnapshot(secs), { ok: true, created: false });
  fs.writeFileSync(f('nav-top-sections.json'), '{roto');
  assert.equal(T.ensureSnapshot(secs).reason, 'archivo_protegido');
  resetNav();
  const failing = T.ensureSnapshot(secs, { write: () => ({ ok: false, reason: 'error_escritura', errors: ['x'] }) });
  assert.deepEqual([failing.ok, failing.reason], [false, 'error_escritura']);
  assert.equal(fs.existsSync(f('nav-top-sections.json')), false);
  assert.equal(T.removeSnapshot(), false, 'sin archivo no borra nada');
});

/* ───────── Creación de secciones (API real) ───────── */
let adminC; let common;
const j = async (r) => r.json();
const secPost = (body, cookie = adminC) => secRoute.POST({ request: new Request(`${B}sections`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }) });
const menuIds = () => T.readTopSelections().doc.items.map((i) => i.sectionId);
const sectionIds = () => JSON.parse(fs.readFileSync(f('sections.json'), 'utf8')).map((s) => s.id);

test('crear una sección: fija antes el menú vigente y la nueva NO entra; con menú manual tampoco; editar/publicar/reordenar no cambia el menú', async () => {
  adminC = await adminCookie();
  seed(); resetNav();
  const before = menuIds();
  assert.deepEqual(before, []);
  const r = await secPost({ title: 'Nueva sección', productIds: ['p6'], published: true });
  assert.equal(r.status, 200);
  const created = (await j(r)).section;
  assert.ok(sectionIds().includes(created.id));
  assert.deepEqual(menuIds(), ['b', 'c', 'a', 'vacia'], 'el menú de antes quedó fijado y la nueva no está');
  assert.ok(!menuIds().includes(created.id));
  // con menú manual ya existente: no se toca
  const rev = fs.readFileSync(f('nav-top-sections.json'), 'utf8');
  assert.equal((await secPost({ title: 'Otra más', productIds: ['p7'] })).status, 200);
  assert.equal(fs.readFileSync(f('nav-top-sections.json'), 'utf8'), rev, 'el archivo no cambia');
  // editar, publicar/ocultar y reordenar una existente no cambian el menú
  assert.equal((await secPost({ action: 'update', id: 'a', published: false })).status, 200);
  assert.equal((await secPost({ action: 'update', id: 'a', published: true, order: 99 })).status, 200);
  assert.equal(fs.readFileSync(f('nav-top-sections.json'), 'utf8'), rev);
  const rn = T.resolveNav(JSON.parse(fs.readFileSync(f('sections.json'), 'utf8')), T.readTopSelections(), ctxLegacy(['a', 'b', 'c', created.id]));
  assert.ok(!rn.items.some((s) => s.id === created.id), 'la sección nueva no aparece en el menú resuelto');
  assert.deepEqual(rn.items.map((s) => s.id), ['b', 'c', 'a'], 'orden del menú independiente de `order` (a pasó a order 99)');
  assert.deepEqual(sectionIds().filter((x) => ['a', 'b', 'c'].includes(x)).length, 3, 'no se eliminó nada');
});

test('crear con el almacén del menú dañado: NO se crea la sección (423), sections.json y el archivo del menú quedan intactos', async () => {
  seed(); resetNav();
  fs.writeFileSync(f('nav-top-sections.json'), '{roto');
  const s0 = sha(f('sections.json'));
  const r = await secPost({ title: 'No debe crearse', productIds: ['p1'] });
  assert.equal(r.status, 423);
  assert.equal((await j(r)).success, false);
  assert.equal(sha(f('sections.json')), s0, 'sections.json intacto');
  assert.equal(fs.readFileSync(f('nav-top-sections.json'), 'utf8'), '{roto', 'archivo dañado conservado');
  // fallo de escritura al fijar: el archivo del menú es un DIRECTORIO → no se puede leer ni escribir
  resetNav();
  fs.mkdirSync(f('nav-top-sections.json'));
  const r2 = await secPost({ title: 'Tampoco', productIds: ['p1'] });
  assert.ok([423, 500].includes(r2.status));
  assert.equal(sha(f('sections.json')), s0);
  resetNav();
});

test('crear con fallo al guardar la sección: se deshace la copia fija recién hecha (sin estado parcial)', async () => {
  seed(); resetNav();
  // sections.json como directorio: upsertSection falla (writeFileSync) pero el snapshot sí se escribe
  fs.rmSync(f('sections.json')); fs.mkdirSync(f('sections.json'));
  const r = await secPost({ title: 'Fallará', productIds: ['p1'] });
  assert.equal(r.status, 500);
  assert.equal(fs.existsSync(f('nav-top-sections.json')), false, 'la copia fija se deshizo');
  fs.rmSync(f('sections.json'), { recursive: true });
  seed(); resetNav();
});

/* ───────── API del menú ───────── */
const getA = (...rest) => { const cookie = rest.length ? rest[0] : adminC; return route.GET({ request: new Request(`${B}top-selections`, { method: 'GET', headers: cookie ? { Cookie: cookie } : {} }) }); };
const send = (method, payload, opts = {}) => { const { headers = {}, raw } = opts; const cookie = 'cookie' in opts ? opts.cookie : adminC; return route[method]({ request: new Request(`${B}top-selections`, { method, headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? JSON.stringify(payload) }) }); };

test('API: permisos (sin sesión, cookie falsa, usuario común → 401), 405 y nada se escribe', async () => {
  seed(); resetNav();
  const master = auth.authenticateUser('tester', 'Test-pass-123');
  const actor = users.toPublicUser(users.findUserById(master.id));
  users.createUser({ username: 'comun7', password: 'Clave-comun-123', name: 'Común', role: 'user' }, actor);
  common = auth.createAdminSession(auth.authenticateUser('comun7', 'Clave-comun-123')).split(';')[0];
  for (const cookie of [undefined, 'tradylor_admin_session=falsa.1.x', common]) {
    assert.equal((await getA(cookie)).status, 401);
    assert.equal((await send('PUT', { baseRevision: 'inicial', items: [] }, { cookie })).status, 401);
    assert.equal((await send('POST', { action: 'snapshot' }, { cookie })).status, 401);
    assert.equal((await route.ALL({ request: new Request(`${B}top-selections`, { method: 'DELETE', headers: cookie ? { Cookie: cookie } : {} }) })).status, 401);
  }
  const r = await route.ALL({ request: new Request(`${B}top-selections`, { method: 'DELETE', headers: { Cookie: adminC } }) });
  assert.deepEqual([r.status, r.headers.get('Allow')], [405, 'GET, PUT, POST']);
  assert.equal(fs.existsSync(f('nav-top-sections.json')), false);
});

test('API: CSRF, tipo, tamaño y campos desconocidos se rechazan sin escribir', async () => {
  const body = { baseRevision: 'inicial', items: ['a'] };
  const evil = await route.PUT({ request: new Request(`${B}top-selections`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC, Origin: 'https://evil.example' }, body: JSON.stringify(body) }) });
  assert.equal(evil.status, 403);
  assert.equal((await send('PUT', body, { headers: { 'X-Home-Layout-Editor': '0' } })).status, 403);
  assert.equal((await send('PUT', body, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await send('PUT', null, { raw: '{no' })).status, 400);
  assert.equal((await send('PUT', null, { raw: JSON.stringify({ ...body, relleno: 'x'.repeat(9000) }) })).status, 413);
  assert.equal((await send('PUT', { ...body, extra: 1 })).status, 400);
  assert.equal((await send('POST', { action: 'borrar' })).status, 400);
  assert.equal((await send('POST', { action: 'snapshot', x: 1 })).status, 400);
  assert.equal(fs.existsSync(f('nav-top-sections.json')), false);
});

test('API: GET describe secciones, orden, avisos y modo; PUT guarda, ordena y detecta conflictos; retirar no elimina la sección', async () => {
  seed(); resetNav();
  let g = await j(await getA());
  assert.deepEqual([g.success, g.mode, g.revision, g.homeMode, g.maxItems], [true, 'automatico', 'inicial', 'legacy', 30]);
  assert.deepEqual(g.menu, ['b', 'c', 'a', 'vacia'], 'inicialmente: el menú actual (publicadas por order)');
  const byId = Object.fromEntries(g.sections.map((s) => [s.id, s]));
  assert.deepEqual(byId.vacia.warnings, ['sin_productos']);
  assert.equal(byId.vacia.linked, false);
  assert.equal(byId.a.linked, true);
  assert.deepEqual([byId.oculta.inMenu, byId.oculta.warnings], [false, []]);
  const s0 = sha(f('sections.json'));
  const put = await send('PUT', { baseRevision: g.revision, items: ['c', 'a'] });
  assert.equal(put.status, 200);
  const saved = await j(put);
  g = await j(await getA());
  assert.deepEqual([g.mode, g.menu, g.revision], ['manual', ['c', 'a'], saved.revision]);
  assert.equal(sha(f('sections.json')), s0, 'sections.json NO se modifica al guardar el menú');
  assert.equal((await send('PUT', { baseRevision: 'inicial', items: ['a'] })).status, 409, 'revisión obsoleta');
  assert.equal((await send('PUT', { baseRevision: g.revision, items: ['a', 'a'] })).status, 400);
  assert.equal((await send('PUT', { baseRevision: g.revision, items: ['fantasma'] })).status, 400);
  // retirar una sección del menú no la elimina
  assert.equal((await send('PUT', { baseRevision: g.revision, items: ['c'] })).status, 200);
  assert.ok(sectionIds().includes('a'));
  assert.equal(sha(f('sections.json')), s0);
  // aviso administrativo: elegida pero no publicada → advierte y NO se enlaza; lo guardado no cambia
  const g2 = await j(await getA());
  assert.equal((await send('PUT', { baseRevision: g2.revision, items: ['c', 'oculta'] })).status, 200);
  const g3 = await j(await getA());
  const oc = g3.sections.find((s) => s.id === 'oculta');
  assert.deepEqual([oc.inMenu, oc.linked, oc.warnings], [true, false, ['no_publicada']]);
  assert.deepEqual(g3.menu, ['c', 'oculta'], 'no se modifica automáticamente lo guardado');
});

test('API: «fijar el menú actual» y recuperación de un archivo dañado (con aviso en el GET)', async () => {
  seed(); resetNav();
  assert.equal((await send('POST', { action: 'snapshot' })).status, 200);
  assert.deepEqual(menuIds(), ['b', 'c', 'a', 'vacia']);
  assert.equal((await send('POST', { action: 'snapshot' })).status, 409, 'ya es manual');
  const g0 = await j(await getA());
  assert.equal((await send('PUT', { baseRevision: g0.revision, items: ['a'] })).status, 200);
  fs.writeFileSync(f('nav-top-sections.json'), '{roto');
  const g = await j(await getA());
  assert.equal(g.storage.status, 'corrupt');
  assert.equal(g.mode, 'automatico', 'mientras tanto el menú es el de siempre');
  assert.equal((await send('PUT', { baseRevision: g.revision, items: [] })).status, 423, 'no se sobrescribe');
  assert.equal(fs.readFileSync(f('nav-top-sections.json'), 'utf8'), '{roto');
  const rec = await send('POST', { action: 'recover' });
  assert.equal(rec.status, 200);
  assert.equal((await j(rec)).preservedCorrupt, true);
  assert.equal((await j(await getA())).storage.status, 'ok');
  assert.equal((await send('POST', { action: 'recover' })).status, 200, 'la copia .bak sigue siendo válida');
  resetNav();
  assert.equal((await send('POST', { action: 'recover' })).status, 409, 'sin copia');
});

/* ───────── Encabezado y estático ───────── */
test('estático: Layout.astro sólo cambia la resolución de Top Selecciones; el resto del encabezado y de la navegación sigue igual', () => {
  const l = read('src/layouts/Layout.astro');
  assert.match(l, /import \{ resolveTopSelectionsNav \} from '\.\.\/lib\/topSelections';/);
  assert.match(l, /const navTopSections = isBackend \? \[\] : resolveTopSelectionsNav\(\)\.items;/);
  assert.doesNotMatch(l, /readSections/);
  // se conservan las opciones fijas, el patrón de enlaces y todo el resto del menú
  for (const t of ['Lo más vendido', 'Mejor valorados', '/?sort=ventas#catalogo', '/?sort=valoracion#catalogo', 'href={`/#section-${s.id}`}', 'El Método', 'Aviso de Afiliación', 'Perfilador', 'Comparador', 'Asesor IA',
    'data-buyer-profile-btn', 'data-top-selecciones-btn', 'data-herramientas-btn', 'data-translate-select', 'header-radar-btn', 'header-category-panel', 'brand-logo', 'SIN PERFIL', 'INACTIVO', 'radar-sweep']) assert.ok(l.includes(t), t);
  assert.ok(l.includes('navTopSections.length > 0 && <div class="nav-dropdown-sep"'), 'separador condicional intacto');
});

test('estático: no se tocan index.astro, middleware, ProductCard ni el catálogo; la API usa los candados de las demás; el subpanel se monta fuera del condicional', () => {
  for (const p of ['src/pages/index.astro', 'src/middleware.ts', 'src/components/ProductCard.astro', 'src/lib/catalog.ts', 'src/lib/sections.ts']) assert.doesNotMatch(read(p), /topSelections|top-selections/, p);
  const api = read('src/pages/api/admin/top-selections.ts');
  assert.match(api, /requireAdminAuth\(request\)/);
  assert.match(api, /sameOrigin\(request\)/);
  assert.match(api, /x-home-layout-editor/);
  const lib = read('src/lib/topSelections.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(lib, /(?<!top-)sections\.json|writeFileSync\(/, 'no escribe sections.json');
  const page = read('src/pages/upayp1b4.astro');
  assert.match(page, /id="topSelectionsAdmin"/);
  const mount = page.indexOf("import { initTopSelectionsAdmin } from '../scripts/topSelectionsAdmin';");
  assert.ok(mount > page.indexOf('window.tradylorAliFilters') && mount < page.indexOf('{isAuthenticated && sessionUser && sessionUser.role'), 'el script va fuera del condicional');
  const client = read('src/scripts/topSelectionsAdmin.ts').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(client, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  assert.equal((client.match(/method === 'GET' \?/g) ?? []).length, 1);
  assert.match(client, /aria-live/);
});
