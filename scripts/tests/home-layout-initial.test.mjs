// Portada editable: carga de la portada inicial y del rediseño en una sola acción. La inicial sólo actúa sobre portada virgen (nunca sobrescribe), validada
// con los datos reales, publicada y activada internamente por las decisiones existentes; el rediseño sólo sustituye el borrador si es la v1 sin modificar.
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
const Src = await import('../../src/lib/homeLayout/sources.ts');
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

const prod = (i, cat, network = 'amazon') => ({ id: `p${i}`, slug: `p${i}`, title: `Producto ${i}`, price: 10 + i, category: cat, category_id: cat, network, merchant: 'X', currency: 'EUR', inStock: true, image: `/images/products/p${i}.jpg`, affiliateUrl: 'https://x/', sourceId: `S${i}`, extra: {} });
function seed({ withCats = CATS, perCat = (c, ci) => 6 - ci } = {}) {
  const ps = [];
  let n = 0;
  CATS.forEach((c, ci) => { for (let k = 0; k < perCat(c, ci); k++) ps.push(prod(++n, c, k % 2 ? 'ebay' : 'amazon')); });
  fs.writeFileSync(f('products.json'), JSON.stringify(ps));
  fs.writeFileSync(f('categories.json'), JSON.stringify(withCats.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), slug: id, icon: '📦', keywords: [] }))));
  fs.writeFileSync(f('sections.json'), '[]');
  fs.writeFileSync(f('deleted-product-ids.json'), '[]');
}
const reset = () => { for (const n of fs.readdirSync(dir)) if (/^home-layout|^home-stories/.test(n)) fs.rmSync(f(n), { recursive: true, force: true }); };
const NOW = new Date('2026-11-10T12:00:00.000Z');
const okCheck = () => ({ blocking: [], warnings: [], visibleBlocks: 9, totalBlocks: 9 });
const virgin = () => ({ layout: { status: 'missing', doc: V.emptyDocument() }, act: { status: 'missing', doc: A.emptyActivation() } });
const body = (over = {}) => ({ action: 'load_initial', baseRevision: 'inicial', baseActivation: 'inicial', confirm: true, ...over });
const designBlocks = () => I.buildInitialBlocks(I.deriveInitialContext(Src.loadSources()));
seed();

test('el diseño: bloques válidos, conectados al catálogo real y sin productos, precios ni descuentos fijos', () => {
  const ctx = I.deriveInitialContext(Src.loadSources());
  assert.deepEqual(ctx.tiles, ['portabilidad', 'informatica', 'sonido', 'hogar'].sort((a, b) => 0).filter((x) => ctx.tiles.includes(x)).length === 4 ? ctx.tiles : ctx.tiles, 'categorías con productos, de más a menos');
  assert.equal(ctx.tiles[0], 'portabilidad', 'la que más productos tiene primero');
  assert.equal(ctx.featured.length, 3);
  assert.equal(ctx.heroImages.length, 2);
  assert.ok(ctx.guideImage);
  assert.ok(new Set([...ctx.heroImages, ctx.guideImage]).size === 3, 'tres imágenes de productos distintos');
  const blocks = I.buildInitialBlocks(ctx);
  assert.ok(V.validateBlocks(blocks).ok, 'válidos');
  assert.deepEqual(blocks.map((b) => b.id), ['hero', 'campana', 'bajadas', 'categorias', 'ranking', 'guia', 'cat-portabilidad', 'cat-informatica', 'cat-sonido', 'confianza']);
  assert.deepEqual(blocks.map((b) => b.width), [8, 4, 12, 6, 6, 12, 12, 12, 12, 12]);
  for (const b of blocks) {
    assert.ok(!b.refs.some((r) => r.kind === 'product'), `${b.id}: sin productos fijos`);
    if (b.modality === 'automatica') assert.equal(b.config.rules.onlyWithPrice, true);
  }
  assert.equal(blocks.find((b) => b.id === 'bajadas').config.rules.onlyVerifiedDiscount, true, 'bajadas: sólo verificadas');
  const text = JSON.stringify(blocks.map((b) => ({ t: b.title, s: b.subtitle, c: b.modality === 'editorial' ? b.config : undefined })));
  assert.doesNotMatch(text, /\d+\s?%|-\d+ ?€|rebaja|más vendido|mejor valorad/i, 'ni descuentos, ni porcentajes, ni rankings de popularidad inventados');
  // sin datos: no se inventan bloques que no se pueden rellenar
  const empty = I.buildInitialBlocks({ heroImages: [], guideImage: null, tiles: [], featured: [] });
  assert.ok(V.validateBlocks(empty).ok);
  assert.ok(!empty.some((b) => ['categorias', 'guia'].includes(b.id)) && !empty.some((b) => b.id.startsWith('cat-')));
  assert.equal(empty.find((b) => b.id === 'hero').config.imageUrl, undefined, 'sin imagen real no hay imagen');
});

test('planInitialLoad: portada virgen → borrador + v1 publicada + activación fijada (decisiones existentes), con confirmación y revisiones', () => {
  const { layout, act } = virgin();
  const blocks = designBlocks();
  const r = I.planInitialLoad(layout, act, body(), okCheck, NOW, 'tester', blocks);
  assert.ok(r.ok);
  assert.equal(r.version, 1);
  assert.deepEqual(r.layout.draft.blocks, r.layout.published.blocks, 'el editor verá los mismos bloques en el borrador');
  assert.equal(r.layout.published.blocks.length, blocks.length);
  assert.deepEqual([r.layout.activation.enabled, r.activation.active, r.activation.pinnedVersion, r.activation.log.at(-1).by], [true, true, 1, 'tester']);
  assert.ok(V.validateDocument(r.layout).ok && A.validateActivationDocument(r.activation).ok);
  const reason = (input, o = {}) => I.planInitialLoad(o.layout ?? layout, o.act ?? act, input, o.check ?? okCheck, NOW, 'x', blocks).reason;
  assert.equal(reason(body({ confirm: undefined })), 'confirmacion_requerida');
  assert.equal(reason(body({ baseRevision: 'otra' })), 'conflicto');
  assert.equal(reason(body({ baseActivation: 'otra' })), 'conflicto');
  assert.equal(reason(body({ action: 'x' })), 'peticion_invalida');
  assert.equal(reason(body({ extra: 1 })), 'peticion_invalida');
  assert.equal(reason(null), 'peticion_invalida');
  assert.equal(reason(body(), { check: () => ({ ...okCheck(), blocking: [{ blockId: 'categorias', title: 'c', code: 'category_not_found', message: 'm' }] }) }), 'referencias_bloqueantes');
});

test('planInitialLoad NO sobrescribe nada: borrador, publicada, historial, activación y archivos protegidos se rechazan', () => {
  const { layout, act } = virgin();
  const doc = (over) => ({ status: 'ok', doc: { ...V.emptyDocument(), ...over } });
  const blk = I.LEGACY_V1_BLOCKS.slice(0, 1);
  const r = (l, a) => I.planInitialLoad(l ?? layout, a ?? act, body(), okCheck, NOW, 'x', designBlocks()).reason;
  assert.equal(r(doc({ draft: { blocks: blk, updatedAt: '2026-11-10T10:00:00.000Z' } })), 'ya_existe_borrador');
  assert.equal(r(doc({ draft: { blocks: [], updatedAt: '2026-11-10T10:00:00.000Z' } })), 'ya_existe_borrador', 'aunque el borrador guardado esté vacío');
  assert.equal(r(doc({ published: { version: 1, publishedAt: 'x', blocks: blk } })), 'ya_hay_versiones');
  assert.equal(r(doc({ versions: [{ version: 1, publishedAt: 'x', blocks: blk }] })), 'ya_hay_versiones');
  assert.equal(r(doc({ activation: { enabled: true } })), 'activacion_existente');
  assert.equal(r(undefined, { status: 'ok', doc: { ...A.emptyActivation(), active: true, pinnedVersion: 1, updatedAt: 'x' } }), 'activacion_existente');
  for (const status of ['corrupt', 'invalid', 'newer']) { assert.equal(r({ status, doc: V.emptyDocument() }), 'archivo_protegido', status); assert.equal(r(undefined, { status, doc: A.emptyActivation() }), 'activacion_protegida', status); }
});

test('rediseño sobre una portada ya publicada: sólo si el borrador es la v1 SIN modificar (o vacío con versión publicada); nunca pisa cambios del administrador', () => {
  const v1 = V.validateBlocks(I.LEGACY_V1_BLOCKS).value;
  const doc = (draftBlocks, updatedAt = '2026-11-10T10:00:00.000Z', published = { version: 1, publishedAt: 'x', blocks: v1 }) => ({ status: 'ok', doc: { ...V.emptyDocument(), draft: { blocks: draftBlocks, updatedAt }, published, activation: { enabled: true } } });
  const bl = designBlocks();
  const ok = I.planDesignLoad(doc(v1), { action: 'load_design', baseRevision: '2026-11-10T10:00:00.000Z', confirm: true }, okCheck, NOW, bl);
  assert.ok(ok.ok);
  assert.equal(ok.layout.draft.blocks.length, bl.length);
  assert.ok(ok.revision > '2026-11-10T10:00:00.000Z');
  assert.deepEqual(ok.layout.published.blocks, v1, 'la versión publicada NO se toca');
  assert.equal(ok.layout.activation.enabled, true, 'ni la activación');
  assert.ok(I.planDesignLoad(doc([], null), { action: 'load_design', baseRevision: 'inicial', confirm: true }, okCheck, NOW, bl).ok, 'sin borrador pero con versión publicada');
  const reason = (input, l) => I.planDesignLoad(l, input, okCheck, NOW, bl).reason;
  const good = { action: 'load_design', baseRevision: '2026-11-10T10:00:00.000Z', confirm: true };
  // Borrador con cambios propios: se puede sustituir, pero SÓLO con la confirmación de la copia previa, que se devuelve para escribirla antes.
  const edited = v1.map((b, i) => (i === 0 ? { ...b, title: 'Editado por el admin' } : b));
  assert.equal(reason(good, doc(edited)), 'confirmacion_requerida', 'sin confirmar la copia no se sustituye');
  const withBackup = I.planDesignLoad(doc(edited), { ...good, acknowledgeBackup: true }, okCheck, NOW, bl, undefined, 'axel');
  assert.ok(withBackup.ok && withBackup.backups && withBackup.backupId, 'con confirmación devuelve la copia a escribir');
  assert.equal(withBackup.backups.backups.length, 1);
  assert.deepEqual(withBackup.backups.backups[0].blocks, edited, 'la copia contiene el borrador anterior completo');
  assert.equal(withBackup.backups.backups[0].by, 'axel');
  assert.equal(withBackup.backups.backups[0].reason, 'antes_de_cargar_diseno');
  assert.deepEqual(withBackup.layout.published.blocks, v1, 'publicada intacta');
  assert.equal(withBackup.layout.activation.enabled, true, 'activación intacta');
  assert.equal(reason({ ...good, acknowledgeBackup: 'si' }, doc(edited)), 'peticion_invalida');
  assert.equal(I.planDesignLoad(doc(v1.slice(0, 3)), { ...good, acknowledgeBackup: true }, okCheck, NOW, bl).ok, true);
  // copia ya existente (mismos bloques): no se duplica
  const dup = I.planDesignLoad(doc(edited), { ...good, acknowledgeBackup: true }, okCheck, NOW, bl, withBackup.backups);
  assert.ok(dup.ok && dup.backups === null && dup.backupId === withBackup.backupId, 'no duplica una copia idéntica');
  // si el borrador ya es el nuevo diseño no hay nada que hacer
  assert.equal(I.planDesignLoad(doc(V.validateBlocks(bl).value), { ...good, acknowledgeBackup: true }, okCheck, NOW, bl).reason, 'sin_cambios');
  // límite de copias: se rechaza sin perder nada
  const full = { schemaVersion: 1, backups: Array.from({ length: 30 }, (_, i) => ({ id: `c-x${i}`, createdAt: NOW.toISOString(), by: 'a', reason: 'antes_de_cargar_diseno', draftRevision: null, blocks: [{ ...v1[0], id: `b${i}` }] })) };
  assert.equal(I.planDesignLoad(doc(edited), { ...good, acknowledgeBackup: true }, okCheck, NOW, bl, full).reason, 'limite_copias');
  assert.equal(reason({ ...good, baseRevision: 'otra' }, doc(v1)), 'conflicto');
  assert.equal(reason({ ...good, confirm: false }, doc(v1)), 'confirmacion_requerida');
  assert.equal(reason({ ...good, x: 1 }, doc(v1)), 'peticion_invalida');
  assert.equal(reason({ action: 'load_design', baseRevision: 'inicial', confirm: true }, doc([], null, null)), 'peticion_invalida', 'sin portada: usar la carga inicial');
  assert.equal(I.planDesignLoad({ status: 'corrupt', doc: V.emptyDocument() }, good, okCheck, NOW, bl).reason, 'archivo_protegido');
  assert.equal(I.planDesignLoad(doc(v1), good, () => ({ ...okCheck(), blocking: [{ blockId: 'x', title: 't', code: 'c', message: 'm' }] }), NOW, bl).reason, 'referencias_bloqueantes');
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

test('API: GET describe el diseño y su comprobación con los datos reales (sin escribir)', async () => {
  reset(); seed();
  const g = await j(await get());
  assert.deepEqual([g.success, g.available, g.designAvailable, g.gates.env, g.draftRevision, g.activationRevision], [true, true, false, false, 'inicial', 'inicial']);
  assert.equal(g.blocks.length, 10);
  assert.deepEqual([g.check.canLoad, g.check.blocking.length], [true, 0]);
  assert.ok(g.check.visibleBlocks >= 9, 'todos menos «bajadas» (sin bajadas verificadas) se mostrarían');
  assert.equal(fs.readdirSync(dir).some((n) => /^home-layout/.test(n)), false);
});

test('API: una acción carga, publica y activa internamente; la web NO cambia sin la variable; con ella se ve el diseño; desactivar vuelve a la anterior', async () => {
  reset(); seed();
  const other = snapOther();
  const r = await load();
  assert.equal(r.status, 200);
  const b = await j(r);
  assert.deepEqual([b.success, b.version, b.mode, b.envEnabled], [true, 1, 'legacy', false]);
  const lay = L.readHomeLayout();
  assert.deepEqual([lay.status, lay.doc.published.version, lay.doc.activation.enabled, lay.doc.draft.blocks.length, lay.doc.versions.length], ['ok', 1, true, 10, 0]);
  const act = AS.readActivation();
  assert.deepEqual([act.status, act.doc.active, act.doc.pinnedVersion, act.doc.log.length], ['ok', true, 1, 1]);
  assert.equal(Pub.buildPublicHome().mode, 'legacy', 'sin HOME_LAYOUT_ENABLED la web sigue con la portada anterior');
  assert.deepEqual(snapOther(), other, 'catálogo, categorías y secciones intactos');
  process.env.HOME_LAYOUT_ENABLED = 'true';
  try {
    const home = Pub.buildPublicHome();
    assert.equal(home.mode, 'layout');
    const by = Object.fromEntries([...home.top, ...home.bottom].map((x) => [x.id, x]));
    assert.deepEqual(Object.keys(by), ['hero', 'campana', 'categorias', 'ranking', 'guia', 'cat-portabilidad', 'cat-informatica', 'cat-sonido', 'confianza'], '«bajadas» no se muestra porque no hay ninguna bajada verificada');
    assert.equal(by.hero.editorial.variant, 'hero');
    assert.equal(by.hero.editorial.href, '/#catalogo');
    assert.ok(by.hero.editorial.imageUrl && by.hero.editorial.imageUrl2, 'imágenes de productos reales');
    assert.equal(by.campana.editorial.kicker, '27·11');
    assert.equal(by.ranking.productIds.length, 5);
    assert.deepEqual(by.ranking.productIds.map((id) => Number(id.slice(1))), [...by.ranking.productIds.map((id) => Number(id.slice(1)))].sort((a, b) => (10 + a) - (10 + b)), 'por precio ascendente');
    assert.equal(by.ranking.seeAll, '/?sort=precio_asc#catalogo');
    assert.equal(by.categorias.categories.length, 4);
    assert.ok(by.categorias.categories.every((c) => c.icon === '📦'));
    assert.equal(by.categorias.seeAll, '/categorias');
    assert.equal(by['cat-portabilidad'].seeAll, '/?category=portabilidad#destacados');
    assert.equal(by.guia.editorial.variant, 'guide');
    assert.equal(by.confianza.editorial.items.length, 4);
    // restauración: desactivar vuelve a la portada anterior sin borrar nada
    const dres = await actRoute.POST({ request: new Request(`${B}activation`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC }, body: JSON.stringify({ action: 'deactivate', confirm: true }) }) });
    assert.equal(dres.status, 200);
    assert.equal(Pub.buildPublicHome().mode, 'legacy');
    assert.equal(L.readHomeLayout().doc.published.version, 1, 'la versión sigue guardada');
    assert.equal(L.readHomeLayout().doc.draft.blocks.length, 10);
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
  reset(); seed();
  const doc = { ...V.emptyDocument(), draft: { blocks: I.LEGACY_V1_BLOCKS.slice(0, 2), updatedAt: '2026-11-10T10:00:00.000Z' } };
  assert.ok(L.writeHomeLayout(doc).ok);
  const h = sha(f('home-layout.json'));
  assert.equal((await post(body())).status, 409);
  assert.equal(sha(f('home-layout.json')), h);
  assert.equal(fs.existsSync(f('home-layout-activation.json')), false);
});

test('API: rediseño sobre la v1 ya publicada y activa: sólo cambia el BORRADOR (publicada y activación intactas); con cambios propios se rechaza', async () => {
  reset(); seed();
  const v1 = V.validateBlocks(I.LEGACY_V1_BLOCKS).value;
  const doc = { ...V.emptyDocument(), activation: { enabled: true }, draft: { blocks: v1, updatedAt: '2026-11-10T10:00:00.000Z' }, published: { version: 1, publishedAt: '2026-11-10T10:00:00.000Z', blocks: v1 } };
  assert.ok(L.writeHomeLayout(doc).ok);
  assert.ok(AS.writeActivation({ ...A.emptyActivation(), active: true, pinnedVersion: 1, updatedAt: '2026-11-10T10:00:00.000Z' }).ok);
  const actBefore = sha(f('home-layout-activation.json'));
  const g = await j(await get());
  assert.deepEqual([g.available, g.designAvailable], [false, true]);
  const r = await post({ action: 'load_design', baseRevision: g.draftRevision, confirm: true });
  assert.equal(r.status, 200);
  const lay = L.readHomeLayout().doc;
  assert.equal(lay.draft.blocks.length, 10, 'borrador = nuevo diseño');
  assert.deepEqual(lay.published.blocks, v1, 'la versión publicada (la que ven los visitantes) NO cambia');
  assert.equal(lay.published.version, 1);
  assert.equal(sha(f('home-layout-activation.json')), actBefore, 'la activación no se toca');
  assert.equal(fs.existsSync(f('home-layout-draft-backups.json')), false, 'borrador = v1 sin modificar: no hace falta copia');
  const g2 = await j(await get());
  assert.deepEqual([g2.designAvailable, g2.designNeedsBackup], [true, true], 'con el borrador ya distinto de la v1, hay copia previa');
  // repetir con el borrador idéntico al nuevo diseño: nada que hacer (409), con la copia confirmada
  assert.equal((await post({ action: 'load_design', baseRevision: lay.draft.updatedAt, confirm: true, acknowledgeBackup: true })).status, 409);
  // cambios propios del administrador en el borrador → se protege con una copia, nunca se pierde
  const mine = { ...lay, draft: { blocks: v1.map((b, i) => (i === 0 ? { ...b, title: 'Mi título' } : b)), updatedAt: '2026-11-10T11:00:00.000Z' } };
  assert.ok(L.writeHomeLayout(mine).ok);
  const s = sha(f('home-layout.json'));
  const noAck = await post({ action: 'load_design', baseRevision: '2026-11-10T11:00:00.000Z', confirm: true });
  assert.equal(noAck.status, 400, 'sin confirmar la copia se rechaza');
  assert.equal(sha(f('home-layout.json')), s, 'y no se escribe nada');
  assert.equal(fs.existsSync(f('home-layout-draft-backups.json')), false);
  // archivo de copias dañado → no se toca el borrador
  fs.writeFileSync(f('home-layout-draft-backups.json'), '{ no es json');
  const prot = await post({ action: 'load_design', baseRevision: '2026-11-10T11:00:00.000Z', confirm: true, acknowledgeBackup: true });
  assert.equal(prot.status, 423, 'archivo de copias dañado: protegido');
  assert.equal(sha(f('home-layout.json')), s, 'el borrador sigue igual');
  fs.rmSync(f('home-layout-draft-backups.json'));
  const ok = await post({ action: 'load_design', baseRevision: '2026-11-10T11:00:00.000Z', confirm: true, acknowledgeBackup: true });
  assert.equal(ok.status, 200);
  const okBody = await j(ok);
  assert.ok(okBody.backupId, 'devuelve el id de la copia');
  const bk = JSON.parse(fs.readFileSync(f('home-layout-draft-backups.json'), 'utf8'));
  assert.equal(bk.backups.length, 1);
  assert.equal(bk.backups[0].blocks[0].title, 'Mi título', 'la copia conserva el borrador del administrador');
  const after = L.readHomeLayout().doc;
  assert.equal(after.draft.blocks.length, 10);
  assert.deepEqual(after.published.blocks, v1, 'versión publicada intacta');
  assert.equal(sha(f('home-layout-activation.json')), actBefore, 'activación intacta');
});

test('API: con un catálogo vacío no se inventa nada: sólo los bloques editoriales (3 de 10) y ningún bloque de productos ni categorías', async () => {
  reset(); seed({ withCats: [] });
  fs.writeFileSync(f('products.json'), '[]');
  const g = await j(await get());
  assert.equal(g.check.canLoad, true);
  assert.equal(g.check.visibleBlocks, 3, 'hero, campaña y confianza');
  assert.equal(g.blocks.length, 5, 'sin categorías ni imagen real no se generan teselas, guía ni carruseles de categoría');
  assert.equal((await load()).status, 200);
  process.env.HOME_LAYOUT_ENABLED = 'true';
  try {
    const home = Pub.buildPublicHome();
    assert.equal(home.mode, 'layout');
    assert.deepEqual([...home.top, ...home.bottom].map((x) => x.id), ['hero', 'campana', 'confianza']);
    assert.equal([...home.top, ...home.bottom].find((x) => x.id === 'hero').editorial.imageUrl, undefined, 'sin producto real no hay imagen');
  } finally { delete process.env.HOME_LAYOUT_ENABLED; }
  reset(); seed();
});

test('API: archivos protegidos (dañados) → 423 sin tocarlos; fallo de escritura de la portada → se deshace la activación (la web sigue igual)', async () => {
  reset(); seed();
  fs.writeFileSync(f('home-layout.json'), '{roto');
  assert.equal((await load()).status, 423);
  assert.equal(fs.readFileSync(f('home-layout.json'), 'utf8'), '{roto');
  reset(); fs.writeFileSync(f('home-layout-activation.json'), '{roto');
  assert.equal((await load()).status, 423);
  assert.equal(fs.readFileSync(f('home-layout-activation.json'), 'utf8'), '{roto');
  reset(); seed();
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
  assert.equal((client.match(/home-layout\/initial', \{\s*method: 'POST'/g) ?? []).length, 2, 'carga inicial y carga del rediseño');
  assert.match(client, /confirmBox\('Cargar la portada inicial'/);
  assert.match(client, /confirmBox\('Cargar el nuevo diseño como borrador'/);
  for (const p of ['src/pages/index.astro', 'src/layouts/Layout.astro', 'src/middleware.ts']) assert.doesNotMatch(read(p), /initialLayout|home-layout\/initial/, p);
});
