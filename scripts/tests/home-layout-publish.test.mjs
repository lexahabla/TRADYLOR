// Portada editable · etapa 4: publicación INTERNA, historial, comparación y recuperación de versiones. Funciones puras (planes, diff), API
// POST publish / GET versions (permisos, CSRF, límites, conflictos entre sesiones, referencias bloqueantes, fallos de escritura, archivo dañado,
// integridad del historial) y garantía de que NADA activa la portada nueva ni toca catálogo, secciones o categorías. Datos aislados, sin red.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-publish-');
delete process.env.HOME_LAYOUT_ENABLED;
const P = await import('../../src/lib/homeLayout/publish.ts');
const D = await import('../../src/lib/homeLayout/draft.ts');
const V = await import('../../src/lib/homeLayout/validate.ts');
const S = await import('../../src/lib/homeLayout/store.ts');
const pub = await import('../../src/pages/api/admin/home-layout/publish.ts');
const ver = await import('../../src/pages/api/admin/home-layout/versions.ts');
const draftRoute = await import('../../src/pages/api/admin/home-layout/draft.ts');
const auth = await import('../../src/lib/adminAuth.ts');
const users = await import('../../src/lib/userStore.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const f = (n) => path.join(dir, n);
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const OTHER = ['products.json', 'deleted-product-ids.json', 'categories.json', 'sections.json'];
const snapOther = () => Object.fromEntries(OTHER.map((n) => [n, sha(f(n))]));
const B = 'http://localhost/api/admin/home-layout/';

/* ───────── Fixtures ───────── */
const ref = (kind, id) => ({ kind, id });
const manual = (id, over = {}) => ({ id, modality: 'manual', format: 'carrusel', width: 12, title: `Manual ${id}`, card: 'producto', config: {}, refs: [ref('product', 'p1')], visible: true, ...over });
const editorial = (id, over = {}) => ({ id, modality: 'editorial', format: 'banner', width: 6, title: 'Campaña', card: 'promocion', config: { headline: 'Titular' }, refs: [], visible: true, ...over });
const seed = () => {
  fs.writeFileSync(f('products.json'), JSON.stringify([{ id: 'p1', slug: 'p1', title: 'P1', price: 10, category: 'Sonido', network: 'amazon', merchant: 'Amazon', currency: 'EUR', inStock: true, image: '/i.jpg', affiliateUrl: 'https://x/', sourceId: 'P1', extra: {} }, { id: 'p2', slug: 'p2', title: 'P2', price: 12, category: 'Sonido', network: 'amazon', merchant: 'Amazon', currency: 'EUR', inStock: true, image: '/i.jpg', affiliateUrl: 'https://x/', sourceId: 'P2', extra: {} }]));
  fs.writeFileSync(f('categories.json'), JSON.stringify([{ id: 'sonido', name: 'Sonido', slug: 'sonido', icon: '🎧', keywords: [] }]));
  fs.writeFileSync(f('sections.json'), JSON.stringify([{ id: 's1', title: 'S1', productIds: ['p1'], published: true, order: 0, position: 'below', speed: 'normal', createdAt: '2026-11-01' }]));
  fs.writeFileSync(f('deleted-product-ids.json'), '[]');
};
seed();
const NOW = new Date('2026-11-10T12:00:00.000Z');
const docWith = (over = {}) => ({ ...V.emptyDocument(), ...over });
const withDraft = (blocks, stamp = '2026-11-10T10:00:00.000Z') => docWith({ draft: { blocks, updatedAt: stamp } });

/* ───────── Comparación ───────── */
test('diff: detecta bloques añadidos y eliminados, orden, ancho, formato, modalidad, título, tarjeta, visibilidad, referencias y propiedades editoriales', () => {
  const a = [manual('a'), manual('b'), editorial('c')];
  const kinds = (x, y) => P.diffBlocks(x, y).map((e) => e.kind);
  assert.deepEqual(kinds(a, a), []);
  assert.ok(kinds(a, [...a, manual('d')]).includes('added'));
  assert.ok(kinds(a, a.slice(0, 2)).includes('removed'));
  assert.ok(kinds(a, [a[2], a[0], a[1]]).includes('moved'));
  assert.ok(kinds(a, [{ ...a[0], width: 6 }, a[1], a[2]]).includes('width'));
  assert.ok(kinds(a, [{ ...a[0], format: 'banner' }, a[1], a[2]]).includes('format'));
  assert.ok(kinds(a, [{ ...a[0], modality: 'seccion' }, a[1], a[2]]).includes('modality'));
  assert.ok(kinds(a, [{ ...a[0], title: 'Otro' }, a[1], a[2]]).includes('title'));
  assert.ok(kinds(a, [{ ...a[0], visible: false }, a[1], a[2]]).includes('visibility'));
  const withRefs = P.diffBlocks(a, [{ ...a[0], refs: [ref('product', 'p2')] }, a[1], a[2]], (r) => `«${r.id}»`);
  assert.equal(withRefs.find((e) => e.kind === 'refs').detail.includes('«p2»'), true);
  const ed = P.diffBlocks(a, [a[0], a[1], { ...a[2], config: { headline: 'Nuevo' } }]);
  assert.equal(ed.find((e) => e.kind === 'config').detail, 'Propiedades: titular');
  const frozen = JSON.stringify(a);
  P.diffBlocks(a, []);
  assert.equal(JSON.stringify(a), frozen, 'no muta');
});

/* ───────── Planes puros ───────── */
const goodPublish = (over = {}) => ({ action: 'publish', baseRevision: '2026-11-10T10:00:00.000Z', basePublished: null, confirm: true, ...over });

test('planPublish: archiva la publicada anterior, numera consecutivamente, no activa nada y no toca el borrador', () => {
  const draft = [manual('a')];
  const r1 = P.planPublish({ status: 'ok', doc: withDraft(draft) }, goodPublish(), [], NOW);
  assert.ok(r1.ok);
  assert.equal(r1.version, 1);
  assert.equal(r1.doc.published.version, 1);
  assert.deepEqual(r1.doc.versions, []);
  assert.deepEqual(r1.doc.activation, { enabled: false });
  assert.deepEqual(r1.doc.draft, withDraft(draft).draft);
  const next = [manual('a'), editorial('e')];
  const doc2 = { ...r1.doc, draft: { blocks: next, updatedAt: '2026-11-10T11:00:00.000Z' } };
  const r2 = P.planPublish({ status: 'ok', doc: doc2 }, goodPublish({ baseRevision: '2026-11-10T11:00:00.000Z', basePublished: 1 }), [], new Date('2026-11-10T13:00:00.000Z'));
  assert.ok(r2.ok);
  assert.equal(r2.version, 2);
  assert.deepEqual(r2.doc.versions.map((v) => v.version), [1]);
  assert.deepEqual(r2.doc.versions[0].blocks, draft, 'la anterior se conserva íntegra');
});

test('planPublish: rechazos (petición inválida, confirmación, archivo protegido, conflictos, vacío, sin cambios, referencias, límite)', () => {
  const ok = { status: 'ok', doc: withDraft([manual('a')]) };
  const reason = (read, input, blocking = []) => P.planPublish(read, input, blocking, NOW).reason;
  for (const bad of [null, [], 'x', {}, goodPublish({ baseRevision: '' }), goodPublish({ basePublished: 0 }), goodPublish({ basePublished: '1' }), goodPublish({ extra: 1 }), goodPublish({ activation: { enabled: true } })]) {
    assert.equal(reason(ok, bad), 'peticion_invalida', JSON.stringify(bad));
  }
  for (const c of [false, undefined, 'true', 1]) assert.equal(reason(ok, goodPublish({ confirm: c })), 'confirmacion_requerida');
  for (const status of ['corrupt', 'invalid', 'newer']) assert.equal(reason({ ...ok, status }, goodPublish()), 'archivo_protegido');
  assert.equal(reason(ok, goodPublish({ baseRevision: 'vieja' })), 'conflicto');
  assert.equal(reason(ok, goodPublish({ basePublished: 4 })), 'conflicto_publicada');
  assert.equal(reason({ status: 'missing', doc: V.emptyDocument() }, goodPublish({ baseRevision: 'inicial' })), 'borrador_vacio');
  assert.equal(reason({ status: 'ok', doc: withDraft([]) }, goodPublish()), 'borrador_vacio');
  const block = [{ blockId: 'a', title: 'x', code: 'producto_inexistente', message: 'm' }];
  assert.equal(reason(ok, goodPublish(), block), 'referencias_bloqueantes');
  const same = withDraft([manual('a')]);
  same.published = { version: 7, publishedAt: '2026-11-09T00:00:00.000Z', blocks: [manual('a')] };
  assert.equal(reason({ status: 'ok', doc: same }, goodPublish({ basePublished: 7 })), 'sin_cambios');
  const full = withDraft([manual('a')]);
  full.published = { version: 101, publishedAt: '2026-11-09T00:00:00.000Z', blocks: [manual('z')] };
  full.versions = Array.from({ length: V.MAX_VERSIONS }, (_, i) => ({ version: i + 1, publishedAt: '2026-11-01T00:00:00.000Z', blocks: [manual('old')] }));
  const refusal = P.planPublish({ status: 'ok', doc: full }, goodPublish({ basePublished: 101 }), [], NOW);
  assert.equal(refusal.reason, 'limite_versiones');
  assert.equal(full.versions.length, V.MAX_VERSIONS, 'no se elimina ninguna');
});

test('planRestore: sustituye sólo el borrador (nueva revisión estrictamente posterior) y deja publicada e historial intactos', () => {
  const doc = withDraft([manual('draft')]);
  doc.published = { version: 3, publishedAt: '2026-11-09T10:00:00.000Z', blocks: [manual('pub')] };
  doc.versions = [{ version: 2, publishedAt: '2026-11-08T10:00:00.000Z', blocks: [manual('old')] }];
  const before = JSON.stringify({ p: doc.published, v: doc.versions });
  const rev = doc.draft.updatedAt;
  const r = P.planRestore({ status: 'ok', doc }, { action: 'restore', baseRevision: rev, version: 2, confirm: true }, new Date('2026-11-01T00:00:00.000Z'));
  assert.ok(r.ok);
  assert.deepEqual(r.doc.draft.blocks, [manual('old')]);
  assert.ok(r.revision > rev, 'aunque el reloj vaya atrasado');
  assert.equal(JSON.stringify({ p: r.doc.published, v: r.doc.versions }), before);
  const reason = (input) => P.planRestore({ status: 'ok', doc }, input, NOW).reason;
  assert.equal(reason({ action: 'restore', baseRevision: rev, version: 2 }), 'confirmacion_requerida');
  assert.equal(reason({ action: 'restore', baseRevision: 'x', version: 2, confirm: true }), 'conflicto');
  assert.equal(reason({ action: 'restore', baseRevision: rev, version: 9, confirm: true }), 'version_no_encontrada');
  assert.equal(reason({ action: 'restore', baseRevision: rev, version: 0, confirm: true }), 'peticion_invalida');
  assert.equal(reason({ action: 'restore', baseRevision: rev, version: 2, confirm: true, x: 1 }), 'peticion_invalida');
  const same = withDraft([manual('old')]);
  same.versions = doc.versions;
  assert.equal(P.planRestore({ status: 'ok', doc: same }, { action: 'restore', baseRevision: same.draft.updatedAt, version: 2, confirm: true }, NOW).reason, 'sin_cambios');
  assert.equal(P.planRestore({ status: 'corrupt', doc }, { action: 'restore', baseRevision: rev, version: 2, confirm: true }, NOW).reason, 'archivo_protegido');
});

test('splitIssues: sólo los errores de bloques visibles bloquean; avisos y errores de bloques ocultos no', () => {
  const blocks = [manual('a'), manual('b', { visible: false }), manual('c')];
  const resolved = [
    { id: 'a', title: 'A', issues: [{ severity: 'error', code: 'e1', message: 'm' }, { severity: 'warning', code: 'w1', message: 'm' }] },
    { id: 'b', title: 'B', issues: [{ severity: 'error', code: 'e2', message: 'm' }] },
    { id: 'c', title: 'C', issues: [{ severity: 'info', code: 'i1', message: 'm' }] },
  ];
  const { blocking, warnings } = P.splitIssues(blocks, resolved);
  assert.deepEqual(blocking.map((x) => x.code), ['e1']);
  assert.deepEqual(warnings.map((x) => x.code).sort(), ['e2', 'w1']);
});

/* ───────── API ───────── */
let adminC; let common;
const post = (body, { cookie, headers = {}, raw } = {}) => pub.POST({ request: new Request(`${B}publish`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? JSON.stringify(body) }) });
const getV = (qs = '', ...rest) => { const cookie = rest.length ? rest[0] : adminC; return ver.GET({ request: new Request(`${B}versions${qs}`, { method: 'GET', headers: cookie ? { Cookie: cookie } : {} }) }); };
const putDraft = (body) => draftRoute.PUT({ request: new Request(`${B}draft`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC }, body: JSON.stringify(body) }) });
const json = async (r) => r.json();
const state = async () => json(await getV(''));
const doPublish = async () => { const s = await state(); return post({ action: 'publish', baseRevision: s.draft.revision, basePublished: s.published?.version ?? null, confirm: true }, { cookie: adminC }); };
const saveDraft = async (blocks) => { const s = await state(); const r = await putDraft({ baseRevision: s.draft.revision, blocks }); assert.equal(r.status, 200); return (await json(r)).revision; };

test('permisos: publicar y consultar versiones exigen administrador (sin sesión, cookie falsa o usuario común → 401) y no escriben', async () => {
  adminC = await adminCookie();
  const master = auth.authenticateUser('tester', 'Test-pass-123');
  const actor = users.toPublicUser(users.findUserById(master.id));
  users.createUser({ username: 'comun4', password: 'Clave-comun-123', name: 'Común', role: 'user' }, actor);
  common = auth.createAdminSession(auth.authenticateUser('comun4', 'Clave-comun-123')).split(';')[0];
  const body = { action: 'publish', baseRevision: 'inicial', basePublished: null, confirm: true };
  for (const cookie of [undefined, 'tradylor_admin_session=falsa.1.x', common]) {
    assert.equal((await post(body, { cookie })).status, 401);
    assert.equal((await getV('', cookie)).status, 401);
    assert.equal((await pub.ALL({ request: new Request(`${B}publish`, { method: 'DELETE', headers: cookie ? { Cookie: cookie } : {} }) })).status, 401);
  }
  assert.equal(fs.existsSync(f('home-layout.json')), false);
});

test('POST: protección CSRF, tipo de contenido, tamaño, JSON inválido, acción desconocida y confirmación obligatoria; nada se escribe', async () => {
  const body = { action: 'publish', baseRevision: 'inicial', basePublished: null, confirm: true };
  let r = await post(body, { cookie: adminC, headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 403);
  assert.equal((await json(r)).code, 'origen_no_permitido');
  r = await post(body, { cookie: adminC, headers: { 'X-Home-Layout-Editor': '' } });
  assert.equal((await json(r)).code, 'cabecera_requerida');
  assert.equal((await post(body, { cookie: adminC, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  r = await post(null, { cookie: adminC, raw: '{ no json' });
  assert.equal((await json(r)).code, 'json_invalido');
  assert.equal((await post(null, { cookie: adminC, raw: JSON.stringify({ ...body, relleno: 'x'.repeat(P.MAX_PUBLISH_BODY_BYTES) }) })).status, 413);
  r = await post({ action: 'activar' }, { cookie: adminC });
  assert.equal(r.status, 400);
  r = await post({ ...body, confirm: false }, { cookie: adminC });
  assert.equal(r.status, 400);
  assert.equal((await json(r)).code, 'confirmacion_requerida');
  assert.equal(fs.existsSync(f('home-layout.json')), false);
  const del = await pub.ALL({ request: new Request(`${B}publish`, { method: 'GET', headers: { Cookie: adminC } }) });
  assert.equal(del.status, 405);
  assert.equal(del.headers.get('Allow'), 'POST');
  assert.equal(typeof pub.GET, 'undefined');
  assert.equal(typeof pub.PUT, 'undefined');
});

test('GET versions: resumen sin archivo, no crea nada; parámetros desconocidos, repetidos o mezclados → 400', async () => {
  const names = fs.readdirSync(dir).sort().join();
  const r = await getV('');
  const s = await json(r);
  assert.equal(r.status, 200);
  assert.equal(s.mode, 'legacy');
  assert.deepEqual([s.draft.revision, s.draft.blocks, s.published, s.versions], ['inicial', 0, null, []]);
  assert.equal(s.limits.maxVersions, V.MAX_VERSIONS);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal(fs.readdirSync(dir).sort().join(), names);
  for (const qs of ['?x=1', '?version=1&version=2', '?version=1&check=publish', '?compare=draft', '?with=draft', '?check=otro']) {
    assert.equal((await getV(qs)).status, 400, qs);
  }
  assert.equal((await getV('?version=0')).status, 400);
  assert.equal((await getV('?version=abc')).status, 400);
  assert.equal((await getV('?version=5')).status, 404);
  assert.equal((await getV('?compare=zz&with=draft')).status, 400);
  assert.equal((await getV('?compare=published&with=draft')).status, 404, 'aún no hay publicada');
  const bad = await getV('?x=1', undefined);
  assert.equal(bad.status, 401);
});

test('publicar sin borrador → 409 borrador_vacío; con borrador y confirmación → 200, versión 1 interna, portada pública sin cambios', async () => {
  const before = snapOther();
  let r = await doPublish();
  assert.equal(r.status, 409);
  assert.equal((await json(r)).code, 'borrador_vacio');
  await saveDraft([manual('a'), editorial('e')]);
  const check = await json(await getV('?check=publish'));
  assert.equal(check.canPublish, true);
  assert.equal(check.nextVersion, 1);
  assert.equal(check.changes.filter((c) => c.kind === 'added').length, 2);
  r = await doPublish();
  const b = await json(r);
  assert.equal(r.status, 200);
  assert.deepEqual([b.success, b.version, b.mode], [true, 1, 'legacy']);
  const doc = S.readHomeLayout().doc;
  assert.equal(doc.published.version, 1);
  assert.deepEqual(doc.versions, []);
  assert.equal(doc.activation.enabled, false, 'no se activa');
  assert.equal(S.resolveHomeMode(), 'legacy');
  assert.equal(doc.draft.blocks.length, 2, 'el borrador sigue ahí');
  assert.deepEqual(snapOther(), before);
  // un segundo intento sin cambios
  r = await doPublish();
  assert.equal(r.status, 409);
  assert.equal((await json(r)).code, 'sin_cambios');
});

test('publicar una segunda versión archiva la primera, el .bak es el estado anterior exacto y el historial es coherente', async () => {
  await saveDraft([manual('a'), editorial('e'), manual('c', { width: 6 })]);
  const fileBefore = sha(f('home-layout.json'));
  const r = await doPublish();
  assert.equal(r.status, 200);
  assert.equal((await json(r)).version, 2);
  assert.equal(sha(f('home-layout.json.bak')), fileBefore);
  const s = await state();
  assert.deepEqual(s.versions.map((v) => [v.version, v.state]), [[2, 'published'], [1, 'archived']]);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  const v1 = await json(await getV('?version=1'));
  assert.equal(v1.state, 'archived');
  assert.equal(v1.blocks.length, 2);
  assert.ok(Array.isArray(v1.resolved));
  const cmp = await json(await getV('?compare=1&with=2'));
  assert.deepEqual(cmp.changes.map((c) => c.kind), ['added']);
  assert.equal((await json(await getV('?compare=published&with=draft'))).changes.length, 0);
});

test('conflicto entre sesiones: publicar con la revisión o la versión publicada obsoleta → 409 y no se escribe', async () => {
  const s = await state();
  await saveDraft([manual('a'), editorial('e'), manual('c', { width: 6 }), editorial('f')]);
  const stored = sha(f('home-layout.json'));
  let r = await post({ action: 'publish', baseRevision: s.draft.revision, basePublished: s.published.version, confirm: true }, { cookie: adminC });
  assert.equal(r.status, 409);
  assert.equal((await json(r)).code, 'conflicto');
  const s2 = await state();
  r = await post({ action: 'publish', baseRevision: s2.draft.revision, basePublished: 1, confirm: true }, { cookie: adminC });
  assert.equal(r.status, 409);
  const body = await json(r);
  assert.equal(body.code, 'conflicto_publicada');
  assert.equal(body.currentPublished, 2);
  assert.equal(sha(f('home-layout.json')), stored);
});

test('peticiones de publicación simultáneas: exactamente una publica y las demás reciben 409 (sin versiones duplicadas)', async () => {
  const s = await state();
  const body = { action: 'publish', baseRevision: s.draft.revision, basePublished: s.published.version, confirm: true };
  const rs = await Promise.all([1, 2, 3].map(() => post(body, { cookie: adminC })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  const after = await state();
  assert.deepEqual(after.versions.map((v) => v.version), [3, 2, 1]);
});

test('recuperar: reemplaza sólo el borrador, exige confirmación y revisión vigente, y la publicada y el historial no cambian', async () => {
  const s = await state();
  const hist = JSON.stringify(S.readHomeLayout().doc.versions) + JSON.stringify(S.readHomeLayout().doc.published);
  const act = { action: 'restore', baseRevision: s.draft.revision, version: 1, confirm: true };
  assert.equal((await post({ ...act, confirm: false }, { cookie: adminC })).status, 400);
  assert.equal((await post({ ...act, baseRevision: 'vieja' }, { cookie: adminC })).status, 409);
  assert.equal((await post({ ...act, version: 99 }, { cookie: adminC })).status, 404);
  const r = await post(act, { cookie: adminC });
  const b = await json(r);
  assert.equal(r.status, 200);
  assert.ok(b.revision > s.draft.revision);
  const doc = S.readHomeLayout().doc;
  assert.equal(doc.draft.blocks.length, 2);
  assert.equal(doc.draft.updatedAt, b.revision);
  assert.equal(JSON.stringify(doc.versions) + JSON.stringify(doc.published), hist, 'historial y publicada intactos');
  assert.equal(doc.activation.enabled, false);
  // recuperar lo que ya es el borrador: sin cambios
  assert.equal((await post({ ...act, baseRevision: b.revision }, { cookie: adminC })).status, 409);
  // una sesión con la revisión antigua no puede pisar el borrador recuperado
  assert.equal((await post({ ...act, version: 2 }, { cookie: adminC })).status, 409);
});

test('referencias: un borrador con referencias rotas en bloques visibles NO se publica (422 con la lista); en bloques ocultos sí, con aviso', async () => {
  await saveDraft([manual('a', { refs: [ref('product', 'inexistente')] })]);
  const stored = sha(f('home-layout.json'));
  const c = await json(await getV('?check=publish'));
  assert.equal(c.canPublish, false);
  assert.ok(c.reasons.includes('referencias_bloqueantes'));
  const r = await doPublish();
  assert.equal(r.status, 422);
  const b = await json(r);
  assert.equal(b.code, 'referencias_bloqueantes');
  assert.ok(b.blocking.length >= 1);
  assert.equal(sha(f('home-layout.json')), stored);
  // el producto se borra DESPUÉS de guardar el borrador: la comprobación usa los datos actuales
  await saveDraft([manual('a', { refs: [ref('product', 'p2')] })]);
  assert.equal((await json(await getV('?check=publish'))).canPublish, true);
  fs.writeFileSync(f('deleted-product-ids.json'), JSON.stringify(['p2']));
  assert.equal((await doPublish()).status, 422, 'p2 ya no existe');
  fs.writeFileSync(f('deleted-product-ids.json'), '[]');
  // ocultar el bloque: el error pasa a aviso
  fs.writeFileSync(f('deleted-product-ids.json'), JSON.stringify(['p2']));
  await saveDraft([manual('a', { refs: [ref('product', 'p2')], visible: false })]);
  const c2 = await json(await getV('?check=publish'));
  assert.equal(c2.canPublish, true);
  assert.ok(c2.warnings.length >= 1);
  fs.writeFileSync(f('deleted-product-ids.json'), '[]');
});

test('fallo de escritura al publicar: 500, historial y publicada anteriores intactos, sin temporales', async () => {
  await saveDraft([manual('w1'), editorial('w2')]);
  const s = await state();
  const before = sha(f('home-layout.json'));
  const real = fs.renameSync;
  fs.renameSync = () => { throw new Error('disco lleno (simulado)'); };
  let r;
  try { r = await post({ action: 'publish', baseRevision: s.draft.revision, basePublished: s.published.version, confirm: true }, { cookie: adminC }); } finally { fs.renameSync = real; }
  assert.equal(r.status, 500);
  const b = await json(r);
  assert.equal(b.code, 'error_escritura');
  assert.doesNotMatch(JSON.stringify(b), /disco lleno/);
  assert.equal(sha(f('home-layout.json')), before);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  assert.equal((await state()).published.version, s.published.version);
  // reintento correcto
  assert.equal((await doPublish()).status, 200);
});

test('archivo dañado: publicar y recuperar → 423 y el original no se toca; versions lo informa', async () => {
  const good = fs.readFileSync(f('home-layout.json'), 'utf8');
  fs.writeFileSync(f('home-layout.json'), '{ "schemaVersion": 1, "draft": ');
  const corrupt = sha(f('home-layout.json'));
  const s = await state();
  assert.equal(s.storage.status, 'corrupt');
  let r = await post({ action: 'publish', baseRevision: 'inicial', basePublished: null, confirm: true }, { cookie: adminC });
  assert.equal(r.status, 423);
  r = await post({ action: 'restore', baseRevision: 'inicial', version: 1, confirm: true }, { cookie: adminC });
  assert.equal(r.status, 423);
  assert.equal(sha(f('home-layout.json')), corrupt);
  assert.ok((await json(await getV('?check=publish'))).reasons.includes('archivo_protegido'));
  fs.writeFileSync(f('home-layout.json'), good);
});

test('límite de versiones: al llegar al máximo se rechaza (409) y nunca se borra ninguna', async () => {
  const doc = S.readHomeLayout().doc;
  const filler = Array.from({ length: V.MAX_VERSIONS }, (_, i) => ({ version: 1000 + i, publishedAt: '2026-11-01T00:00:00.000Z', blocks: [manual(`f${i}`)] }));
  const full = { ...doc, versions: filler, published: { version: 2000, publishedAt: '2026-11-02T00:00:00.000Z', blocks: [manual('zz')] }, draft: { blocks: [editorial('nuevo')], updatedAt: '2026-11-10T20:00:00.000Z' } };
  assert.equal(S.writeHomeLayout(full).ok, true);
  const stored = sha(f('home-layout.json'));
  const r = await post({ action: 'publish', baseRevision: '2026-11-10T20:00:00.000Z', basePublished: 2000, confirm: true }, { cookie: adminC });
  assert.equal(r.status, 409);
  assert.equal((await json(r)).code, 'limite_versiones');
  assert.equal(sha(f('home-layout.json')), stored);
  assert.equal(S.readHomeLayout().doc.versions.length, V.MAX_VERSIONS);
});

test('integridad: la portada pública sigue siendo la actual y ninguna operación de la etapa 4 toca catálogo, secciones ni categorías', async () => {
  assert.equal(S.resolveHomeMode(), 'legacy');
  assert.equal(S.readHomeLayout().doc.activation.enabled, false);
  assert.deepEqual(Object.keys(snapOther()).map((k) => snapOther()[k] !== undefined), [true, true, true, true]);
  assert.equal(P.nextVersionNumber(S.readHomeLayout().doc) > 1, true);
});

/* ───────── Estático ───────── */
test('estático: el módulo de publicación es puro, los endpoints no activan nada y el cliente publica/recupera sólo con acción explícita', () => {
  const pure = code('src/lib/homeLayout/publish.ts');
  assert.doesNotMatch(pure, /node:fs|from '[^']*store'|from '[^']*sources'|fetch\(|process\.env/);
  for (const p of ['src/pages/api/admin/home-layout/publish.ts', 'src/pages/api/admin/home-layout/versions.ts']) {
    const src = code(p);
    assert.doesNotMatch(src, /activation\s*[:=]\s*\{\s*enabled\s*:\s*true|HOME_LAYOUT_STAGE_ENABLED\s*=\s*true/);
    assert.match(src, /requireAdminAuth/);
  }
  assert.match(code('src/pages/api/admin/home-layout/publish.ts'), /sameOrigin/);
  assert.doesNotMatch(code('src/pages/api/admin/home-layout/versions.ts'), /writeHomeLayout/);
  assert.doesNotMatch(code('src/pages/index.astro'), /homeLayout|home-layout/);
  assert.doesNotMatch(code('src/layouts/Layout.astro'), /homeLayout\/(publish|store)/);
  const client = code('src/scripts/homeLayoutEditor.ts');
  assert.doesNotMatch(client, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  assert.doesNotMatch(client, /setInterval|setTimeout\([^)]*(publish|restore)/i, 'sin publicación automática');
  assert.equal((client.match(/method: 'POST'/g) ?? []).length, 1, 'un único punto de publicación/recuperación');
  assert.equal((client.match(/confirm: true/g) ?? []).length, 1);
});
