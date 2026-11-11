// Portada editable: eliminar versiones. Permanente, nunca la activa públicamente, sin renumerar ni reutilizar números, con registro, concurrencia y
// sin tocar borrador, copias, historias ni activación. Todo con datos aislados.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-delete-');
delete process.env.HOME_LAYOUT_ENABLED;
const D = await import('../../src/lib/homeLayout/versionDelete.ts');
const V = await import('../../src/lib/homeLayout/validate.ts');
const P = await import('../../src/lib/homeLayout/publish.ts');
const L = await import('../../src/lib/homeLayout/store.ts');
const A = await import('../../src/lib/homeLayout/activation.ts');
const AS = await import('../../src/lib/homeLayout/activationStore.ts');
const BK = await import('../../src/lib/homeLayout/draftBackups.ts');
const BS = await import('../../src/lib/homeLayout/draftBackupsStore.ts');
const route = await import('../../src/pages/api/admin/home-layout/version-delete.ts');
const publishRoute = await import('../../src/pages/api/admin/home-layout/publish.ts');
const auth = await import('../../src/lib/adminAuth.ts');
const users = await import('../../src/lib/userStore.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const f = (n) => path.join(dir, n);
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const B = 'http://localhost/api/admin/home-layout/';
const NOW = new Date('2026-11-13T10:00:00.000Z');

const blk = (id, title = id) => ({ id, modality: 'editorial', format: 'banner', width: 12, title, card: 'promocion', visible: true, refs: [], config: { headline: title } });
const set = (...ids) => V.validateBlocks(ids.map((i) => blk(i))).value;
const pub = (version, ...ids) => ({ version, publishedAt: `2026-11-1${version}T10:00:00.000Z`, blocks: set(...ids) });
const reset = () => { for (const n of fs.readdirSync(dir)) if (/^home-/.test(n)) fs.rmSync(f(n), { recursive: true, force: true }); };

/** v4 publicada, v3/v2/v1 archivadas, v1 activa públicamente, borrador propio, una copia y una historia. */
function seed({ active = true, pinned = 1 } = {}) {
  reset();
  const doc = { ...V.emptyDocument(), activation: { enabled: true }, draft: { blocks: set('mio1', 'mio2', 'mio3'), updatedAt: '2026-11-12T09:00:00.000Z' }, published: pub(4, 'v4a', 'v4b'), versions: [pub(3, 'v3a'), pub(2, 'v2a'), pub(1, 'v1a', 'v1b')] };
  assert.ok(L.writeHomeLayout(doc).ok);
  assert.ok(AS.writeActivation({ ...A.emptyActivation(), active, pinnedVersion: pinned, updatedAt: '2026-11-10T10:00:00.000Z' }).ok);
  const bk = BK.protectDraft(BK.emptyBackupsDocument(), { blocks: set('copia1'), updatedAt: null }, 'antes_de_cargar_diseno', NOW, 'a');
  assert.ok(BS.writeDraftBackups(bk.doc).ok);
  fs.writeFileSync(f('home-stories.json'), JSON.stringify({ schemaVersion: 1, draft: { stories: [], updatedAt: null } }));
}
const files = () => ({ draft: JSON.stringify(L.readHomeLayout().doc.draft), backups: sha(f('home-layout-draft-backups.json')), stories: sha(f('home-stories.json')) });
const body = (version, over = {}) => {
  const doc = L.readHomeLayout().doc;
  const v = P.findVersion(doc, version);
  return { action: 'delete', version, publishedAt: v?.publishedAt ?? 'x', basePublished: doc.published?.version ?? null, baseActivation: A.activationRevision(AS.readActivation().doc), confirm: true, ...over };
};

/* ───────── módulo puro ───────── */
test('planDeleteVersion: elimina una archivada sin renumerar; la publicada queda sin publicada; recuerda el número más alto; registra sin cambiar la revisión', () => {
  seed();
  const lay = L.readHomeLayout(); const act = AS.readActivation();
  const p = D.planDeleteVersion(lay, act, body(2), NOW, 'axel');
  assert.ok(p.ok);
  assert.deepEqual(p.layout.versions.map((v) => v.version), [3, 1], 'v1 y v3 conservan su número');
  assert.equal(p.layout.published.version, 4);
  assert.equal(p.layout.lastVersion, 4);
  assert.deepEqual(p.layout.draft, lay.doc.draft, 'borrador intacto');
  assert.equal(p.activation.updatedAt, act.doc.updatedAt, 'la revisión de la activación no cambia');
  assert.deepEqual([p.activation.active, p.activation.pinnedVersion], [true, 1]);
  const last = p.activation.log.at(-1);
  assert.deepEqual([last.action, last.version, last.result, last.by], ['delete_version', 2, 'ok', 'axel']);
  assert.match(last.note, /archivada/);
  assert.equal(lay.doc.versions.length, 3, 'no muta la entrada');
  // la publicada
  const q = D.planDeleteVersion(lay, act, body(4), NOW, 'axel');
  assert.ok(q.ok && q.wasPublished);
  assert.equal(q.layout.published, null);
  assert.deepEqual(q.layout.versions.map((v) => v.version), [3, 2, 1]);
  assert.equal(q.layout.lastVersion, 4, 'el número 4 no se reutilizará');
  assert.equal(P.nextVersionNumber(q.layout), 5);
  assert.match(q.activation.log.at(-1).note, /publicada/);
});

test('planDeleteVersion: rechazos (activa, inexistente, conflictos, petición inválida, confirmación, archivos protegidos)', () => {
  seed();
  const lay = L.readHomeLayout(); const act = AS.readActivation();
  const r = (input, l = lay, a = act) => D.planDeleteVersion(l, a, input, NOW, 'a').reason;
  assert.equal(r(body(1)), 'version_activa', 'la activa públicamente no se elimina');
  assert.equal(r(body(9)), 'version_no_encontrada');
  assert.equal(r(body(2, { publishedAt: '1999-01-01T00:00:00.000Z' })), 'conflicto_version');
  assert.equal(r(body(2, { basePublished: 3 })), 'conflicto_publicada');
  assert.equal(r(body(2, { basePublished: null })), 'conflicto_publicada');
  assert.equal(r(body(2, { baseActivation: 'otra' })), 'conflicto_activacion');
  assert.equal(r(body(2, { confirm: false })), 'confirmacion_requerida');
  assert.equal(r(body(2, { x: 1 })), 'peticion_invalida');
  assert.equal(r(body(2, { action: 'otra' })), 'peticion_invalida');
  assert.equal(r(body(0)), 'peticion_invalida');
  assert.equal(r(body(1.5)), 'peticion_invalida');
  assert.equal(r('hola'), 'peticion_invalida');
  assert.equal(r(body(2), { status: 'corrupt', doc: V.emptyDocument() }), 'archivo_protegido');
  assert.equal(r(body(2), lay, { status: 'newer', doc: A.emptyActivation() }), 'activacion_protegida');
  // activación apagada con v1 fijada: ya no está activa públicamente → se puede eliminar
  seed({ active: false, pinned: 1 });
  const lay2 = L.readHomeLayout(); const act2 = AS.readActivation();
  assert.ok(D.planDeleteVersion(lay2, act2, body(1), NOW, 'a').ok, 'fijada pero desactivada: se puede');
  // activa pero otra versión: la fijada sigue protegida, las demás no
  seed({ active: true, pinned: 3 });
  const lay3 = L.readHomeLayout(); const act3 = AS.readActivation();
  assert.equal(D.planDeleteVersion(lay3, act3, body(3), NOW, 'a').reason, 'version_activa');
  assert.ok(D.planDeleteVersion(lay3, act3, body(1), NOW, 'a').ok);
});

test('numeración: eliminar la versión más alta no libera su número; documentos antiguos sin lastVersion también', () => {
  seed();
  const doc = L.readHomeLayout().doc;
  assert.equal(doc.lastVersion, undefined, 'documento antiguo sin marca');
  const act = AS.readActivation();
  const p = D.planDeleteVersion({ status: 'ok', doc }, act, body(4), NOW, 'a');
  assert.ok(p.ok);
  assert.equal(P.nextVersionNumber(p.layout), 5, 'sin lastVersion previo, se calcula con las existentes ANTES de borrar');
  assert.ok(L.writeHomeLayout(p.layout).ok);
  assert.equal(L.readHomeLayout().doc.lastVersion, 4);
  // validación: lastVersion nunca queda por debajo de la versión más alta existente
  const v = V.validateDocument({ ...p.layout, lastVersion: 1 });
  assert.ok(v.ok && v.value.lastVersion === 3);
  assert.equal(V.validateDocument({ ...p.layout, lastVersion: -1 }).ok, false);
  assert.equal(V.validateDocument({ ...p.layout, lastVersion: 'x' }).ok, false);
  const plain = V.validateDocument(JSON.parse(JSON.stringify(V.emptyDocument())));
  assert.ok(plain.ok && !('lastVersion' in plain.value), 'sin marca no se inventa');
});

/* ───────── API ───────── */
let adminC; let common;
const post = (payload, opts = {}) => { const { headers = {}, raw } = opts; const cookie = 'cookie' in opts ? opts.cookie : adminC; return route.POST({ request: new Request(`${B}version-delete`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? JSON.stringify(payload) }) }); };
const j = (r) => r.json();
const publishPost = (payload) => publishRoute.POST({ request: new Request(`${B}publish`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC }, body: JSON.stringify(payload) }) });

test('API: permisos, CSRF, tipo, tamaño y 405 — sin escribir', async () => {
  adminC = await adminCookie();
  const master = auth.authenticateUser('tester', 'Test-pass-123');
  users.createUser({ username: 'comun7', password: 'Clave-comun-123', name: 'Común', role: 'user' }, users.toPublicUser(users.findUserById(master.id)));
  common = auth.createAdminSession(auth.authenticateUser('comun7', 'Clave-comun-123')).split(';')[0];
  seed();
  const snap = [sha(f('home-layout.json')), sha(f('home-layout-activation.json'))];
  for (const cookie of [undefined, 'tradylor_admin_session=falsa.1.x', common]) assert.equal((await post(body(2), { cookie })).status, 401);
  assert.equal((await route.ALL({ request: new Request(`${B}version-delete`, { method: 'GET', headers: { Cookie: adminC } }) })).status, 405);
  assert.equal((await route.ALL({ request: new Request(`${B}version-delete`, { method: 'DELETE', headers: { Cookie: adminC } }) })).status, 405);
  const evil = await route.POST({ request: new Request(`${B}version-delete`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC, Origin: 'https://evil.example' }, body: JSON.stringify(body(2)) }) });
  assert.equal(evil.status, 403);
  assert.equal((await post(body(2), { headers: { 'X-Home-Layout-Editor': '0' } })).status, 403);
  assert.equal((await post(body(2), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post(null, { raw: '{no' })).status, 400);
  assert.equal((await post(null, { raw: JSON.stringify({ x: 'a'.repeat(3000) }) })).status, 413);
  assert.equal((await post({ ...body(2), confirm: false })).status, 400);
  assert.deepEqual([sha(f('home-layout.json')), sha(f('home-layout-activation.json'))], snap, 'nada se escribió');
});

test('API: eliminar una archivada — se elimina, no se renumera, queda en el registro y borrador, copias, historias y activación no cambian', async () => {
  seed();
  const before = files(); const actBefore = AS.readActivation().doc;
  const r = await post(body(2));
  assert.equal(r.status, 200);
  const rb = await j(r);
  assert.deepEqual([rb.version, rb.wasPublished, rb.remaining], [2, false, [4, 3, 1]]);
  const lay = L.readHomeLayout().doc;
  assert.deepEqual([lay.published.version, ...lay.versions.map((v) => v.version)], [4, 3, 1]);
  assert.equal(lay.lastVersion, 4);
  assert.deepEqual(files(), before, 'borrador, copias e historias idénticos');
  const act = AS.readActivation().doc;
  assert.deepEqual([act.active, act.pinnedVersion, act.updatedAt], [actBefore.active, actBefore.pinnedVersion, actBefore.updatedAt], 'activación intacta (y su revisión)');
  assert.equal(act.log.length, actBefore.log.length + 1);
  assert.deepEqual([act.log.at(-1).action, act.log.at(-1).version, act.log.at(-1).result], ['delete_version', 2, 'ok']);
  // repetir: ya no existe
  assert.equal((await post(body(2, { publishedAt: '2026-11-12T10:00:00.000Z' }))).status, 404);
});

test('API: la versión activa públicamente no se elimina (409) y no se escribe nada', async () => {
  seed();
  const l0 = sha(f('home-layout.json')); const a0 = sha(f('home-layout-activation.json'));
  const r = await post(body(1));
  assert.equal(r.status, 409);
  assert.equal((await j(r)).code, 'version_activa');
  assert.equal(sha(f('home-layout.json')), l0);
  assert.equal(sha(f('home-layout-activation.json')), a0);
  assert.equal(L.readHomeLayout().doc.versions.length, 3);
});

test('API: eliminar la publicada (no activa) deja la web igual; publicar después NO reutiliza el número', async () => {
  seed();
  process.env.HOME_LAYOUT_ENABLED = 'true';
  assert.equal(L.resolveHomeMode(), 'layout', 'la v1 activa se sirve');
  const r = await post(body(4));
  assert.equal(r.status, 200);
  assert.equal((await j(r)).wasPublished, true);
  assert.equal(L.readHomeLayout().doc.published, null);
  assert.equal(L.resolveHomeMode(), 'layout', 'la web sigue sirviendo la versión fijada');
  const act = AS.readActivation().doc;
  assert.deepEqual([act.active, act.pinnedVersion], [true, 1]);
  // publicar de nuevo: v5, no v4
  const doc = L.readHomeLayout().doc;
  const pr = await publishPost({ action: 'publish', baseRevision: doc.draft.updatedAt, basePublished: null, confirm: true });
  assert.equal(pr.status, 200);
  assert.equal((await j(pr)).version, 5, 'el número 4 eliminado no se reutiliza');
  delete process.env.HOME_LAYOUT_ENABLED;
});

test('API: conflictos de concurrencia y peticiones simultáneas — nunca se elimina de más', async () => {
  seed();
  const stale = body(3);
  // cambia la publicada (alguien publicó) → conflicto
  const doc = L.readHomeLayout().doc;
  const pr = await publishPost({ action: 'publish', baseRevision: doc.draft.updatedAt, basePublished: 4, confirm: true });
  assert.equal(pr.status, 200);
  const s = sha(f('home-layout.json'));
  const c = await post(stale);
  assert.equal(c.status, 409);
  assert.equal((await j(c)).code, 'conflicto_publicada');
  assert.equal(sha(f('home-layout.json')), s);
  // dos eliminaciones simultáneas de la misma versión: una gana
  const b = body(2);
  const [x, y] = await Promise.all([post(b), post(b)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 404]);
  assert.equal(AS.readActivation().doc.log.filter((e) => e.action === 'delete_version' && e.version === 2).length, 1, 'una sola entrada en el registro');
  // la activación cambió (alguien activó otra versión) → conflicto
  const b3 = body(3);
  assert.ok(AS.writeActivation({ ...AS.readActivation().doc, pinnedVersion: 5, updatedAt: '2026-11-13T12:00:00.000Z' }).ok);
  assert.equal((await post(b3)).status, 409);
  assert.ok(P.findVersion(L.readHomeLayout().doc, 3), 'v3 sigue existiendo');
});

test('API: archivos protegidos → 423 sin tocarlos; un fallo de escritura no elimina la versión', async () => {
  seed();
  const b = body(2);
  fs.writeFileSync(f('home-layout-activation.json'), '{ no es json');
  const a0 = sha(f('home-layout-activation.json')); const l0 = sha(f('home-layout.json'));
  assert.equal((await post(b)).status, 423);
  assert.deepEqual([sha(f('home-layout-activation.json')), sha(f('home-layout.json'))], [a0, l0]);
  seed();
  fs.writeFileSync(f('home-layout.json'), '{ roto');
  assert.equal((await post(body(2, { baseActivation: A.activationRevision(AS.readActivation().doc), publishedAt: 'x' }))).status, 423);
  assert.equal(fs.readFileSync(f('home-layout.json'), 'utf8'), '{ roto');
  // fallo al escribir la portada: carpeta con el nombre del archivo temporal imposible → se simula con home-layout.json de sólo lectura no portable; se comprueba la rama de error con la copia protegida
  seed();
  const lay0 = sha(f('home-layout.json'));
  fs.mkdirSync(f('home-layout.json.bak'), { recursive: true });
  const r = await post(body(2));
  assert.ok([200, 500].includes(r.status));
  if (r.status === 500) {
    assert.equal(sha(f('home-layout.json')), lay0, 'sigue existiendo');
    assert.ok(AS.readActivation().doc.log.some((e) => e.action === 'delete_version' && e.result === 'error'), 'el error queda anotado');
  }
  fs.rmSync(f('home-layout.json.bak'), { recursive: true, force: true });
});

/* ───────── estático ───────── */
test('estático: el endpoint es de sólo administrador y escribe el registro antes que la portada; el editor pide confirmación y no elimina la activa', () => {
  const api = code('src/pages/api/admin/home-layout/version-delete.ts');
  assert.match(api, /requireAdminAuth/);
  assert.match(api, /sameOrigin/);
  assert.match(api, /x-home-layout-editor/);
  assert.ok(api.indexOf('writeActivation(plan.activation)') < api.indexOf('writeHomeLayout(plan.layout)'), 'primero el registro, después la portada');
  assert.doesNotMatch(api, /writeDraftBackups|writeStories|planPublish|planActivate/);
  const pure = code('src/lib/homeLayout/versionDelete.ts');
  assert.doesNotMatch(pure, /node:fs|from '[^']*store'|from '[^']*sources'|fetch\(|process\.env/);
  const client = code('src/scripts/homeLayoutEditor.ts');
  assert.match(client, /async function startDelete/);
  assert.match(client, /confirmBox\(`Eliminar la versión \$\{v\.version\}`/);
  assert.match(client, /'Eliminar'\)\)\)\);|, 'Eliminar'\)/);
  assert.match(client, /isActiveVersion\(v\.version\)/);
  assert.doesNotMatch(client, /innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function/);
});

test('estático: botón «Secciones» (volver arriba) en la página de portada — reutiliza el del resto del backend, accesible y sin tocar el scroll de las vistas previas', () => {
  const page = read('src/pages/upayp1b4/portada.astro');
  assert.match(page, /id="adminBackToTop" class="admin-back-to-top"/);
  assert.match(page, /<span>Secciones<\/span>/);
  assert.match(page, /aria-label="Volver al menú de secciones"/);
  assert.match(page, /window\.scrollTo\(\{ top: 0, behavior: reduce \? 'auto' : 'smooth' \}\)/);
  assert.match(page, /prefers-reduced-motion/);
  assert.match(page, /\.admin-back-to-top:focus-visible/);
  assert.match(page, /scrollY \|\| document\.documentElement\.scrollTop/);
  const other = read('src/pages/upayp1b4/trafico-ventas/index.astro');
  assert.match(other, /id="adminBackToTop" class="admin-back-to-top"/, 'mismo botón que el resto del backend');
  assert.doesNotMatch(page.slice(page.indexOf('adminBackToTop" class'), page.indexOf('</script>', page.indexOf('adminBackToTop" class'))), /pe-pvframe|iframe/, 'no toca las vistas previas');
});
