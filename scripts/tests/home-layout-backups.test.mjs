// Portada editable: copias de seguridad del borrador. Antes de sustituir un borrador con contenido (cargar el nuevo diseño, recuperar una copia o una
// versión) se guarda una copia recuperable; nunca se pierde un borrador, no se tocan versiones ni activación y se mantiene el control de revisiones.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-backups-');
delete process.env.HOME_LAYOUT_ENABLED;
const BK = await import('../../src/lib/homeLayout/draftBackups.ts');
const BS = await import('../../src/lib/homeLayout/draftBackupsStore.ts');
const V = await import('../../src/lib/homeLayout/validate.ts');
const L = await import('../../src/lib/homeLayout/store.ts');
const A = await import('../../src/lib/homeLayout/activation.ts');
const AS = await import('../../src/lib/homeLayout/activationStore.ts');
const I = await import('../../src/lib/homeLayout/initialLayout.ts');
const route = await import('../../src/pages/api/admin/home-layout/draft-backups.ts');
const publish = await import('../../src/pages/api/admin/home-layout/publish.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const f = (n) => path.join(dir, n);
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const B = 'http://localhost/api/admin/home-layout/';
const NOW = new Date('2026-11-12T10:00:00.000Z');

const blk = (id, title = id) => ({ id, modality: 'editorial', format: 'banner', width: 12, title, card: 'promocion', visible: true, refs: [], config: { headline: title } });
const set = (...ids) => V.validateBlocks(ids.map((i) => blk(i))).value;
const layoutDoc = (draftBlocks, updatedAt, published = null, versions = []) => ({ ...V.emptyDocument(), draft: { blocks: draftBlocks, updatedAt }, published, versions });
const reset = () => { for (const n of fs.readdirSync(dir)) if (/^home-layout/.test(n)) fs.rmSync(f(n), { recursive: true, force: true }); };

/* ───────── módulo puro ───────── */
test('protectDraft: borrador vacío no necesita copia; con contenido crea una; idéntico no se duplica; límite sin borrar', () => {
  const empty = BK.emptyBackupsDocument();
  assert.deepEqual(BK.protectDraft(empty, { blocks: [], updatedAt: null }, 'antes_de_cargar_diseno', NOW, 'a'), { ok: true, doc: empty, id: null, created: false });
  const d = { blocks: set('a', 'b'), updatedAt: '2026-11-12T09:00:00.000Z' };
  const first = BK.protectDraft(empty, d, 'antes_de_cargar_diseno', NOW, 'axel');
  assert.ok(first.ok && first.created && first.id);
  assert.equal(first.doc.backups.length, 1);
  assert.deepEqual(first.doc.backups[0].blocks, d.blocks);
  assert.equal(first.doc.backups[0].draftRevision, '2026-11-12T09:00:00.000Z');
  assert.equal(empty.backups.length, 0, 'no muta el documento original');
  const again = BK.protectDraft(first.doc, d, 'antes_de_cargar_diseno', NOW, 'axel');
  assert.ok(again.ok && !again.created && again.id === first.id && again.doc === first.doc);
  let doc = empty;
  for (let i = 0; i < BK.MAX_BACKUPS; i++) { const r = BK.protectDraft(doc, { blocks: set(`x${i}`), updatedAt: null }, 'antes_de_cargar_diseno', new Date(NOW.getTime() + i), 'a'); assert.ok(r.ok && r.created); doc = r.doc; }
  assert.equal(doc.backups.length, BK.MAX_BACKUPS);
  assert.equal(new Set(doc.backups.map((b) => b.id)).size, BK.MAX_BACKUPS, 'ids únicos');
  const over = BK.protectDraft(doc, { blocks: set('otro'), updatedAt: null }, 'antes_de_cargar_diseno', NOW, 'a');
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'limite_copias');
  assert.equal(doc.backups.length, BK.MAX_BACKUPS, 'no se borra ninguna');
  assert.ok(BK.validateBackupsDocument(doc).ok);
  assert.equal(BK.validateBackupsDocument({ ...doc, backups: [...doc.backups, doc.backups[0]] }).ok, false);
});

test('planRestoreBackup: protege antes el borrador actual, exige confirmación y revisión vigente, y es reversible', () => {
  const published = { version: 1, publishedAt: 'x', blocks: set('v1') };
  const bk0 = BK.protectDraft(BK.emptyBackupsDocument(), { blocks: set('viejo1', 'viejo2'), updatedAt: '2026-11-12T08:00:00.000Z' }, 'antes_de_cargar_diseno', NOW, 'axel');
  const id = bk0.id;
  const lay = { status: 'ok', doc: layoutDoc(set('actual1', 'actual2', 'actual3'), '2026-11-12T09:00:00.000Z', published) };
  const good = { action: 'restore', id, baseRevision: '2026-11-12T09:00:00.000Z', confirm: true };
  const p = BK.planRestoreBackup(lay, bk0.doc, good, NOW, 'axel');
  assert.ok(p.ok);
  assert.deepEqual(p.layout.draft.blocks, set('viejo1', 'viejo2'), 'borrador = copia');
  assert.ok(p.revision > '2026-11-12T09:00:00.000Z');
  assert.equal(p.backups.backups.length, 2, 'el borrador actual quedó protegido');
  assert.deepEqual(p.backups.backups[1].blocks, set('actual1', 'actual2', 'actual3'));
  assert.equal(p.backups.backups[1].reason, 'antes_de_recuperar_copia');
  assert.deepEqual(p.layout.published, published, 'publicada intacta');
  const back = BK.planRestoreBackup({ status: 'ok', doc: p.layout }, p.backups, { action: 'restore', id: p.protectedId, baseRevision: p.revision, confirm: true }, new Date(NOW.getTime() + 5), 'axel');
  assert.ok(back.ok && JSON.stringify(back.layout.draft.blocks) === JSON.stringify(set('actual1', 'actual2', 'actual3')), 'se puede volver al borrador anterior');
  const r = (input, l = lay) => BK.planRestoreBackup(l, bk0.doc, input, NOW, 'a').reason;
  assert.equal(r({ ...good, confirm: false }), 'confirmacion_requerida');
  assert.equal(r({ ...good, baseRevision: 'otra' }), 'conflicto');
  assert.equal(r({ ...good, id: 'c-nada' }), 'copia_no_encontrada');
  assert.equal(r({ ...good, x: 1 }), 'peticion_invalida');
  assert.equal(r({ ...good, action: 'otra' }), 'peticion_invalida');
  assert.equal(r(good, { status: 'corrupt', doc: V.emptyDocument() }), 'archivo_protegido');
  assert.equal(r(good, { status: 'ok', doc: layoutDoc(set('viejo1', 'viejo2'), '2026-11-12T09:00:00.000Z') }), 'sin_cambios');
  const full = { schemaVersion: 1, backups: [...bk0.doc.backups, ...Array.from({ length: BK.MAX_BACKUPS - 1 }, (_, i) => ({ ...bk0.doc.backups[0], id: `c-z${i}`, blocks: set(`z${i}`) }))] };
  assert.equal(BK.planRestoreBackup(lay, full, good, NOW, 'a').reason, 'limite_copias');
  // borrador vacío: recupera sin crear copia
  const e = BK.planRestoreBackup({ status: 'ok', doc: layoutDoc([], null, published) }, bk0.doc, { ...good, baseRevision: 'inicial' }, NOW, 'a');
  assert.ok(e.ok && e.protectedId === null && e.backups === bk0.doc);
});

/* ───────── API ───────── */
let adminC; let common;
const get = (qs = '', ...rest) => { const cookie = rest.length ? rest[0] : adminC; return route.GET({ request: new Request(`${B}draft-backups${qs}`, { method: 'GET', headers: cookie ? { Cookie: cookie } : {} }) }); };
const post = (payload, opts = {}) => { const { headers = {}, raw } = opts; const cookie = 'cookie' in opts ? opts.cookie : adminC; return route.POST({ request: new Request(`${B}draft-backups`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? JSON.stringify(payload) }) }); };
const j = (r) => r.json();
const seedLayout = (draft, updatedAt = '2026-11-12T09:00:00.000Z') => {
  reset();
  const pub = { version: 1, publishedAt: '2026-11-10T10:00:00.000Z', blocks: set('v1a', 'v1b') };
  assert.ok(L.writeHomeLayout({ ...V.emptyDocument(), activation: { enabled: true }, draft: { blocks: draft, updatedAt }, published: pub }).ok);
  assert.ok(AS.writeActivation({ ...A.emptyActivation(), active: true, pinnedVersion: 1, updatedAt: '2026-11-10T10:00:00.000Z' }).ok);
};

test('API: permisos, CSRF, tipo, tamaño, 405 y parámetros — sin escribir', async () => {
  adminC = await adminCookie();
  const auth = await import('../../src/lib/adminAuth.ts');
  const users = await import('../../src/lib/userStore.ts');
  const master = auth.authenticateUser('tester', 'Test-pass-123');
  users.createUser({ username: 'comun8', password: 'Clave-comun-123', name: 'Común', role: 'user' }, users.toPublicUser(users.findUserById(master.id)));
  common = auth.createAdminSession(auth.authenticateUser('comun8', 'Clave-comun-123')).split(';')[0];
  seedLayout(set('a', 'b'));
  const snap = sha(f('home-layout.json'));
  for (const cookie of [undefined, 'tradylor_admin_session=falsa.1.x', common]) {
    assert.equal((await get('', cookie)).status, 401);
    assert.equal((await post({}, { cookie })).status, 401);
  }
  assert.equal((await route.ALL({ request: new Request(`${B}draft-backups`, { method: 'PUT', headers: { Cookie: adminC } }) })).status, 405);
  const evil = await route.POST({ request: new Request(`${B}draft-backups`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC, Origin: 'https://evil.example' }, body: '{}' }) });
  assert.equal(evil.status, 403);
  assert.equal((await post({}, { headers: { 'X-Home-Layout-Editor': '0' } })).status, 403);
  assert.equal((await post({}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post(null, { raw: '{no' })).status, 400);
  assert.equal((await post(null, { raw: JSON.stringify({ x: 'a'.repeat(5000) }) })).status, 413);
  assert.equal((await get('?otra=1')).status, 400);
  assert.equal((await get('?id=a&id=b')).status, 400);
  assert.equal((await get('?id=c-nada')).status, 404);
  assert.equal(sha(f('home-layout.json')), snap);
  assert.equal(fs.existsSync(f('home-layout-draft-backups.json')), false, 'nada se escribe');
});

test('API: cargar el nuevo diseño con borrador propio guarda antes una copia; se consulta, se compara y se recupera sin perder nada', async () => {
  const mine = set('mio1', 'mio2', 'mio3');
  seedLayout(mine);
  const actBefore = sha(f('home-layout-activation.json'));
  const g0 = await j(await get());
  assert.deepEqual([g0.success, g0.backups.length, g0.draftBlocks], [true, 0, 3]);
  // 1) cargar el diseño (ruta initial) con copia previa
  const initial = await import('../../src/pages/api/admin/home-layout/initial.ts');
  const iget = await j(await initial.GET({ request: new Request(`${B}initial`, { headers: { Cookie: adminC } }) }));
  assert.deepEqual([iget.designAvailable, iget.designNeedsBackup, iget.draftBlocks], [true, true, 3]);
  const ipost = (payload) => initial.POST({ request: new Request(`${B}initial`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC }, body: JSON.stringify(payload) }) });
  const ld = await ipost({ action: 'load_design', baseRevision: iget.draftRevision, confirm: true, acknowledgeBackup: true });
  assert.equal(ld.status, 200);
  const ldb = await j(ld);
  assert.ok(ldb.backupId);
  const lay1 = L.readHomeLayout().doc;
  assert.ok(lay1.draft.blocks.length >= 3 && lay1.draft.blocks[0].id !== 'mio1', 'borrador = diseño nuevo');
  assert.equal(lay1.published.version, 1);
  assert.equal(sha(f('home-layout-activation.json')), actBefore, 'activación intacta');
  assert.equal(lay1.versions.length, 0, 'sin versiones nuevas');
  // 2) listar y detallar
  const l1 = await j(await get());
  assert.equal(l1.backups.length, 1);
  assert.equal(l1.backups[0].id, ldb.backupId);
  assert.deepEqual([l1.backups[0].blocks, l1.backups[0].reason], [3, 'antes_de_cargar_diseno']);
  assert.ok(!('blocks' in l1.backups[0]) || typeof l1.backups[0].blocks === 'number', 'el listado no incluye bloques completos');
  const det = await j(await get(`?id=${ldb.backupId}`));
  assert.deepEqual(det.backup.blocks, mine, 'la copia contiene el borrador íntegro');
  assert.ok(det.changes.length > 0, 'diferencias respecto al borrador actual');
  // 3) recuperar con conflicto de revisión → 409 y no cambia nada
  const s = sha(f('home-layout.json')); const sb = sha(f('home-layout-draft-backups.json'));
  assert.equal((await post({ action: 'restore', id: ldb.backupId, baseRevision: 'vieja', confirm: true })).status, 409);
  assert.equal((await post({ action: 'restore', id: ldb.backupId, baseRevision: l1.draftRevision, confirm: false })).status, 400);
  assert.equal(sha(f('home-layout.json')), s);
  assert.equal(sha(f('home-layout-draft-backups.json')), sb);
  // 4) recuperar: el diseño nuevo queda protegido y el borrador vuelve a ser el mío
  const rr = await post({ action: 'restore', id: ldb.backupId, baseRevision: l1.draftRevision, confirm: true });
  assert.equal(rr.status, 200);
  const rrb = await j(rr);
  assert.ok(rrb.protectedId && rrb.protectedId !== ldb.backupId);
  assert.deepEqual(L.readHomeLayout().doc.draft.blocks, mine, 'borrador recuperado');
  assert.equal((await j(await get())).backups.length, 2, 'el diseño nuevo quedó como copia');
  assert.equal(sha(f('home-layout-activation.json')), actBefore, 'activación intacta tras recuperar');
  assert.equal(L.readHomeLayout().doc.published.version, 1);
  // 5) ida y vuelta: recuperar el diseño protegido
  const l2 = await j(await get());
  const rr2 = await post({ action: 'restore', id: rrb.protectedId, baseRevision: l2.draftRevision, confirm: true });
  assert.equal(rr2.status, 200);
  assert.equal(L.readHomeLayout().doc.draft.blocks.length, lay1.draft.blocks.length);
  const l2b = await j(await get());
  assert.equal(l2b.backups.length, 2, 'mi borrador ya estaba copiado (copia idéntica): no se duplica');
  const mineCopy = await j(await get(`?id=${ldb.backupId}`));
  assert.deepEqual(mineCopy.backup.blocks, mine, 'y esa copia sigue conteniendo mi borrador');
  // 6) recuperar algo idéntico → 409 sin_cambios
  const l3 = await j(await get());
  const same = l3.backups.find((b) => b.blocks === lay1.draft.blocks.length);
  assert.equal((await post({ action: 'restore', id: same.id, baseRevision: l3.draftRevision, confirm: true })).status, 409);
});

test('API: archivos protegidos (copias o portada dañados) → 423 sin tocar nada; el fallo de la copia no sustituye el borrador', async () => {
  seedLayout(set('mio1', 'mio2'));
  const initial = await import('../../src/pages/api/admin/home-layout/initial.ts');
  const ipost = (payload) => initial.POST({ request: new Request(`${B}initial`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC }, body: JSON.stringify(payload) }) });
  fs.writeFileSync(f('home-layout-draft-backups.json'), '{ no es json');
  const s = sha(f('home-layout.json')); const sb = sha(f('home-layout-draft-backups.json'));
  assert.equal((await j(await get())).storage, 'corrupt');
  assert.equal((await ipost({ action: 'load_design', baseRevision: '2026-11-12T09:00:00.000Z', confirm: true, acknowledgeBackup: true })).status, 423);
  assert.equal((await post({ action: 'restore', id: 'c-x', baseRevision: '2026-11-12T09:00:00.000Z', confirm: true })).status, 423);
  assert.equal(sha(f('home-layout.json')), s, 'el borrador no se toca');
  assert.equal(sha(f('home-layout-draft-backups.json')), sb, 'el archivo dañado se conserva');
  fs.writeFileSync(f('home-layout-draft-backups.json'), JSON.stringify({ schemaVersion: 99, backups: [] }));
  assert.equal((await j(await get())).storage, 'newer');
  assert.equal((await ipost({ action: 'load_design', baseRevision: '2026-11-12T09:00:00.000Z', confirm: true, acknowledgeBackup: true })).status, 423);
  fs.rmSync(f('home-layout-draft-backups.json'));
  // portada dañada
  fs.writeFileSync(f('home-layout.json'), '{ roto');
  assert.equal((await post({ action: 'restore', id: 'c-x', baseRevision: 'inicial', confirm: true })).status, 423);
  assert.equal(fs.readFileSync(f('home-layout.json'), 'utf8'), '{ roto');
  // el directorio de copias no se puede escribir (carpeta con el nombre del archivo): no se sustituye el borrador
  seedLayout(set('mio1', 'mio2'));
  fs.mkdirSync(f('home-layout-draft-backups.json'));
  const s2 = sha(f('home-layout.json'));
  const bad = await ipost({ action: 'load_design', baseRevision: '2026-11-12T09:00:00.000Z', confirm: true, acknowledgeBackup: true });
  assert.ok([423, 500].includes(bad.status), `estado ${bad.status}`);
  assert.equal(sha(f('home-layout.json')), s2, 'borrador intacto si la copia falla');
  fs.rmSync(f('home-layout-draft-backups.json'), { recursive: true, force: true });
});

test('recuperar una VERSIÓN también protege antes el borrador actual (y no toca versiones ni activación)', async () => {
  reset();
  const v1 = set('v1a', 'v1b'); const v2 = set('v2a');
  assert.ok(L.writeHomeLayout({ ...V.emptyDocument(), activation: { enabled: true }, draft: { blocks: set('borrador1', 'borrador2'), updatedAt: '2026-11-12T09:00:00.000Z' }, published: { version: 2, publishedAt: '2026-11-11T10:00:00.000Z', blocks: v2 }, versions: [{ version: 1, publishedAt: '2026-11-10T10:00:00.000Z', blocks: v1 }] }).ok);
  assert.ok(AS.writeActivation({ ...A.emptyActivation(), active: true, pinnedVersion: 1, updatedAt: '2026-11-10T10:00:00.000Z' }).ok);
  const actBefore = sha(f('home-layout-activation.json'));
  const pr = (payload) => publish.POST({ request: new Request(`${B}publish`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC }, body: JSON.stringify(payload) }) });
  const r = await pr({ action: 'restore', baseRevision: '2026-11-12T09:00:00.000Z', version: 1, confirm: true });
  assert.equal(r.status, 200);
  const rb = await j(r);
  assert.ok(rb.protectedId);
  const lay = L.readHomeLayout().doc;
  assert.deepEqual(lay.draft.blocks, v1);
  assert.equal(lay.published.version, 2);
  assert.equal(lay.versions.length, 1);
  assert.equal(sha(f('home-layout-activation.json')), actBefore);
  const bk = BS.readDraftBackups();
  assert.equal(bk.doc.backups.length, 1);
  assert.deepEqual(bk.doc.backups[0].blocks, set('borrador1', 'borrador2'), 'el borrador anterior se conserva');
  assert.equal(bk.doc.backups[0].reason, 'antes_de_recuperar_version');
  // con el archivo de copias dañado, recuperar una versión se rechaza sin tocar el borrador
  fs.writeFileSync(f('home-layout-draft-backups.json'), 'no json');
  const s = sha(f('home-layout.json'));
  const r2 = await pr({ action: 'restore', baseRevision: lay.draft.updatedAt, version: 2, confirm: true });
  assert.equal(r2.status, 423);
  assert.equal(sha(f('home-layout.json')), s);
});

test('controles de concurrencia: dos recuperaciones con la misma revisión → una gana, la otra recibe 409 y nada se pierde', async () => {
  seedLayout(set('mio1', 'mio2'));
  const bk = BK.protectDraft(BK.emptyBackupsDocument(), { blocks: set('otra1'), updatedAt: null }, 'antes_de_cargar_diseno', NOW, 'a');
  assert.ok(BS.writeDraftBackups(bk.doc).ok);
  const rev = '2026-11-12T09:00:00.000Z';
  const [a, b] = await Promise.all([post({ action: 'restore', id: bk.id, baseRevision: rev, confirm: true }), post({ action: 'restore', id: bk.id, baseRevision: rev, confirm: true })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const all = BS.readDraftBackups().doc.backups;
  assert.ok(all.some((x) => JSON.stringify(x.blocks) === JSON.stringify(set('mio1', 'mio2'))), 'mi borrador sigue protegido');
});

/* ───────── estático ───────── */
test('estático: el módulo es puro, ninguna ruta publica ni activa, y el editor sólo escribe con confirmación', () => {
  const pure = read('src/lib/homeLayout/draftBackups.ts');
  assert.doesNotMatch(pure, /node:fs|from '[^']*store'|from '[^']*sources'|fetch\(|process\.env/);
  for (const p of ['src/pages/api/admin/home-layout/draft-backups.ts', 'src/lib/homeLayout/draftBackupsStore.ts', 'src/lib/homeLayout/draftBackups.ts']) {
    assert.doesNotMatch(read(p), /writeActivation|planPublish|planActivate|activation\s*[:=]\s*\{\s*enabled\s*:\s*true|HOME_LAYOUT_STAGE_ENABLED\s*=\s*true/, p);
  }
  const api = read('src/pages/api/admin/home-layout/draft-backups.ts');
  assert.match(api, /requireAdminAuth/);
  assert.match(api, /sameOrigin/);
  assert.match(api, /x-home-layout-editor/);
  assert.ok(api.indexOf('writeDraftBackups(plan.backups)') < api.indexOf('writeHomeLayout(plan.layout)'), 'la copia se escribe ANTES que el borrador');
  const ini = read('src/pages/api/admin/home-layout/initial.ts');
  assert.ok(ini.indexOf('writeDraftBackups(dplan.backups)') < ini.indexOf('writeHomeLayout(dplan.layout)'), 'rediseño: copia antes que borrador');
  const pub = read('src/pages/api/admin/home-layout/publish.ts');
  assert.ok(pub.indexOf('writeDraftBackups(prot.doc)') < pub.indexOf('written = writeHomeLayout(plan.doc);\n      result = { action, version: plan.version, protectedId'), 'versión: copia antes que borrador');
  const client = code('src/scripts/homeLayoutEditor.ts');
  assert.doesNotMatch(client, /innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function/);
  assert.match(client, /revealDetail\(\)/, 'el resultado de una comparación se muestra y se enfoca');
  assert.match(client, /acknowledgeBackup: true/);
  assert.match(client, /Copias de seguridad del borrador/);
  assert.match(client, /Cargar el nuevo diseño \(guardando antes una copia del borrador actual\)/);
});
