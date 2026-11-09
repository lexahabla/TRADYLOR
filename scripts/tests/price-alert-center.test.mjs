// Centro «Alertas de precio»: alertas por precio objetivo, bajadas de productos visitados (apagado por defecto), preferencias, duplicados, correos,
// aislamiento entre usuarios y separación de Mi Radar. Datos sintéticos aislados; el correo se simula (ningún SMTP real, ninguna red).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, writeCatalog, readCatalog } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-alert-center-');
delete process.env.PRICE_DROP_VISITS_ENABLED;
const center = await import('../../src/lib/priceAlertCenter.ts');
const auth = await import('../../src/lib/radarAuth.ts');

const PRODUCT = (over = {}) => ({
  id: 'prod-a', slug: 'prod-a', title: 'Auriculares Alfa Bluetooth', price: 50, category: 'Sonido', network: 'amazon', merchant: 'Amazon', currency: 'EUR', inStock: true,
  image: 'https://img.invalid/a.jpg', affiliateUrl: 'https://www.amazon.es/dp/B0ALFA0001', sourceId: 'B0ALFA0001', asin: 'B0ALFA0001', condition: 'Nuevo', extra: {}, ...over,
});
const setCatalog = (list) => writeCatalog(dir, list);
const mkUser = (email) => auth.registerRadarUser({ email, password: 'Clave-segura-123', name: email.split('@')[0], verified: true });
const alice = mkUser('alice@example.com');
const bob = mkUser('bob@example.com');
const sent = [];
const mailer = async (m) => { sent.push(m); return true; };
const reset = () => { sent.length = 0; fs.rmSync(path.join(dir, 'price-alert-center.json'), { force: true }); };

test('crear una alerta: validación, propietario y una sola alerta vigilando por producto', () => {
  reset(); setCatalog([PRODUCT()]);
  assert.throws(() => center.createAlert(alice.id, { productId: 'prod-a', targetPrice: 0 }), /positivo/);
  assert.throws(() => center.createAlert(alice.id, { productId: 'no-existe', targetPrice: 10 }), /No se encuentra/);
  const a = center.createAlert(alice.id, { productId: 'prod-a', targetPrice: 40, includeShipping: false });
  assert.equal(a.userId, alice.id);
  assert.equal(a.status, 'watching');
  const again = center.createAlert(alice.id, { productId: 'prod-a', targetPrice: 35 });
  assert.equal(again.id, a.id, 'actualiza en lugar de duplicar');
  assert.equal(center.listAlerts(alice.id).length, 1);
  assert.equal(center.listAlerts(alice.id)[0].targetPrice, 35);
});

test('un precio objetivo alcanzado genera UNA notificación interna y UN correo con producto, precio detectado, objetivo y enlace', async () => {
  reset(); setCatalog([PRODUCT({ price: 50 })]);
  const a = center.createAlert(alice.id, { productId: 'prod-a', targetPrice: 45 });
  let run = await center.evaluateAlerts({ mailer });
  assert.equal(run.targetsMet, 0, '50 € no alcanza el objetivo de 45 €');
  setCatalog([PRODUCT({ price: 44.9 })]);
  run = await center.evaluateAlerts({ mailer });
  assert.equal(run.targetsMet, 1);
  assert.equal(run.emailsSent, 1);
  const notes = center.listNotifications(alice.id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'target_met');
  assert.equal(notes[0].newPrice, 44.9);
  assert.equal(notes[0].targetPrice, 45);
  assert.equal(notes[0].email.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'alice@example.com');
  assert.match(sent[0].text, /Auriculares Alfa Bluetooth/);
  assert.match(sent[0].text, /44,90/);
  assert.match(sent[0].text, /45,00/);
  assert.match(sent[0].text, /\/producto\/prod-a/);
  assert.equal(center.listAlerts(alice.id)[0].status, 'met');
  // Sin duplicados: otra pasada no repite ni la notificación ni el correo.
  run = await center.evaluateAlerts({ mailer });
  assert.equal(run.targetsMet, 0);
  assert.equal(center.listNotifications(alice.id).length, 1);
  assert.equal(sent.length, 1);
  assert.equal(a.id, center.listAlerts(alice.id)[0].id);
});

test('con «envío incluido» se compara el TOTAL; si el envío no consta no se dispara', async () => {
  reset(); setCatalog([PRODUCT({ price: 40 })]);
  center.createAlert(alice.id, { productId: 'prod-a', targetPrice: 45, includeShipping: true });
  let run = await center.evaluateAlerts({ mailer });
  assert.equal(run.targetsMet, 0, 'envío desconocido: no se puede afirmar que el total cumpla');
  setCatalog([PRODUCT({ price: 40, freeShipping: true })]);
  run = await center.evaluateAlerts({ mailer });
  assert.equal(run.targetsMet, 1);
  assert.equal(center.listNotifications(alice.id)[0].includeShipping, true);
});

test('sin stock o sin precio válido no se dispara; modificar el objetivo rearma; pausar detiene', async () => {
  reset(); setCatalog([PRODUCT({ price: 30, inStock: false })]);
  const a = center.createAlert(alice.id, { productId: 'prod-a', targetPrice: 45 });
  assert.equal((await center.evaluateAlerts({ mailer })).targetsMet, 0);
  setCatalog([PRODUCT({ price: 30 })]);
  center.updateAlert(alice.id, a.id, { active: false });
  assert.equal((await center.evaluateAlerts({ mailer })).targetsMet, 0, 'alerta pausada');
  center.updateAlert(alice.id, a.id, { active: true });
  assert.equal((await center.evaluateAlerts({ mailer })).targetsMet, 1);
  const rearmed = center.updateAlert(alice.id, a.id, { targetPrice: 20 });
  assert.equal(rearmed.status, 'watching');
  assert.equal((await center.evaluateAlerts({ mailer })).targetsMet, 0, '30 € no alcanza el nuevo objetivo de 20 €');
});

test('preferencias independientes: sin correo hay notificación interna; sin interna nace leída; se respeta de inmediato', async () => {
  reset(); setCatalog([PRODUCT({ price: 30 })]);
  center.setPrefs(alice.id, { targets: { email: false } });
  center.createAlert(alice.id, { productId: 'prod-a', targetPrice: 45 });
  await center.evaluateAlerts({ mailer });
  assert.equal(sent.length, 0, 'correo desactivado');
  let n = center.listNotifications(alice.id)[0];
  assert.equal(n.email.status, 'disabled');
  assert.equal(center.unreadCount(alice.id), 1);
  reset(); setCatalog([PRODUCT({ price: 30 })]);
  center.setPrefs(alice.id, { targets: { inApp: false, email: true } });
  center.createAlert(alice.id, { productId: 'prod-a', targetPrice: 45 });
  await center.evaluateAlerts({ mailer });
  n = center.listNotifications(alice.id)[0];
  assert.ok(n.readAt, 'interna desactivada: no enciende la campana');
  assert.equal(center.unreadCount(alice.id), 0);
  assert.equal(sent.length, 1, 'el correo sigue activo');
  center.setPrefs(alice.id, { targets: { inApp: true, email: true } });
});

test('campana: sólo hay avisos sin leer hasta que se marcan como leídos', async () => {
  reset(); setCatalog([PRODUCT({ price: 30 })]);
  center.createAlert(alice.id, { productId: 'prod-a', targetPrice: 45 });
  await center.evaluateAlerts({ mailer });
  assert.equal(center.unreadCount(alice.id), 1);
  const id = center.listNotifications(alice.id)[0].id;
  assert.equal(center.markRead(bob.id, [id]), 0, 'otro usuario no puede marcar las de Alice');
  assert.equal(center.unreadCount(alice.id), 1);
  assert.equal(center.markRead(alice.id, [id]), 1);
  assert.equal(center.unreadCount(alice.id), 0);
});

test('aislamiento: nadie lee, edita ni borra alertas o avisos de otro usuario', async () => {
  reset(); setCatalog([PRODUCT({ price: 30 })]);
  const a = center.createAlert(alice.id, { productId: 'prod-a', targetPrice: 45 });
  await center.evaluateAlerts({ mailer });
  assert.equal(center.listAlerts(bob.id).length, 0);
  assert.equal(center.listNotifications(bob.id).length, 0);
  assert.throws(() => center.updateAlert(bob.id, a.id, { targetPrice: 1 }), /no encontrada/i);
  assert.equal(center.deleteAlert(bob.id, a.id), false);
  assert.equal(center.listAlerts(alice.id).length, 1);
  assert.equal(sent.every((m) => m.to === 'alice@example.com'), true, 'los correos sólo van a su destinatario');
});

test('topes anti-saturación: máximo de correos por usuario y día', async () => {
  reset();
  const list = [1, 2, 3, 4, 5].map((i) => PRODUCT({ id: `p${i}`, slug: `p${i}`, title: `Producto ${i}`, price: 10, sourceId: `B0TOPE000${i}`, asin: `B0TOPE000${i}`, affiliateUrl: `https://www.amazon.es/dp/B0TOPE000${i}` }));
  setCatalog(list);
  for (const p of list) center.createAlert(alice.id, { productId: p.id, targetPrice: 20 });
  const run = await center.evaluateAlerts({ mailer });
  assert.equal(run.targetsMet, 5);
  assert.equal(run.emailsSent, center.MAX_EMAILS_PER_USER_PER_DAY);
  const skipped = center.listNotifications(alice.id).filter((n) => n.email.status === 'skipped' && n.email.reason === 'tope_diario_usuario');
  assert.equal(skipped.length, 5 - center.MAX_EMAILS_PER_USER_PER_DAY, 'las demás quedan en el centro sin correo');
});

test('cada ejecución queda registrada y un fallo de SMTP se anota sin perder la notificación', async () => {
  reset(); setCatalog([PRODUCT({ price: 30 })]);
  center.createAlert(alice.id, { productId: 'prod-a', targetPrice: 45 });
  const run = await center.evaluateAlerts({ mailer: async () => false });
  assert.equal(run.emailsFailed, 1);
  assert.equal(center.listNotifications(alice.id)[0].email.status, 'failed');
  assert.equal(center.listRuns(5)[0].emailsFailed, 1);
});

test('avisos B (bajadas de productos visitados): APAGADOS por defecto: no se registra ninguna visita ni se envía nada', async () => {
  reset(); setCatalog([PRODUCT()]);
  assert.equal(center.dropVisitsEnabled(), false);
  assert.equal(center.recordVisit(alice.id, 'prod-a', 'Auriculares Alfa'), false);
  const state = JSON.parse(fs.existsSync(path.join(dir, 'price-alert-center.json')) ? fs.readFileSync(path.join(dir, 'price-alert-center.json'), 'utf8') : '{"visits":{}}');
  assert.deepEqual(state.visits, {});
});

test('avisos B activados (sólo en la prueba): exige bajada VERIFICADA posterior a la visita, una sola vez y respetando preferencias', async () => {
  reset();
  process.env.PRICE_DROP_VISITS_ENABLED = 'true';
  try {
    const visitedAt = Date.now();
    setCatalog([PRODUCT({ price: 100 })]);
    assert.equal(center.recordVisit(alice.id, 'prod-a', 'Auriculares Alfa'), true);
    // Bajada observada y verificada DESPUÉS de la visita (señal comparable vigente).
    const detectedAt = new Date(visitedAt + 60_000).toISOString();
    const signal = { offerKey: 'amazon:b0alfa0001', contextKey: 'EUR|ES', previousPrice: 100, price: 80, currency: 'EUR', detectedAt, expiresAt: new Date(visitedAt + 7 * 86_400_000).toISOString(), shippingCriterion: 'standard' };
    setCatalog([PRODUCT({ price: 80, extra: { priceSignal: signal, refresh: { lastVerifiedAt: new Date(visitedAt + 61_000).toISOString() } } })]);
    const now = new Date(visitedAt + 120_000);
    let run = await center.evaluateAlerts({ mailer, now });
    assert.equal(run.dropsFound, 1);
    const n = center.listNotifications(alice.id)[0];
    assert.equal(n.kind, 'price_drop');
    assert.equal(n.oldPrice, 100);
    assert.equal(n.newPrice, 80);
    assert.equal(n.pct, 20);
    assert.equal(sent.length, 1);
    // Sin repetir la misma bajada.
    run = await center.evaluateAlerts({ mailer, now });
    assert.equal(run.dropsFound, 0);
    assert.equal(center.listNotifications(alice.id).length, 1);
    // Una bajada ANTERIOR a la visita no cuenta.
    reset();
    setCatalog([PRODUCT({ price: 80, extra: { priceSignal: { ...signal, detectedAt: new Date(visitedAt - 86_400_000).toISOString() }, refresh: { lastVerifiedAt: new Date(visitedAt).toISOString() } } })]);
    center.recordVisit(alice.id, 'prod-a', 'Auriculares Alfa');
    assert.equal((await center.evaluateAlerts({ mailer, now })).dropsFound, 0);
    // Sin señal verificada (descuento sólo declarado) no hay aviso.
    reset();
    setCatalog([PRODUCT({ price: 80, originalPrice: 120 })]);
    center.recordVisit(alice.id, 'prod-a', 'Auriculares Alfa');
    assert.equal((await center.evaluateAlerts({ mailer, now })).dropsFound, 0);
  } finally {
    delete process.env.PRICE_DROP_VISITS_ENABLED;
  }
});

test('desactivar todos los avisos de bajada borra las visitas guardadas; purgar elimina todos los datos del usuario', async () => {
  reset();
  process.env.PRICE_DROP_VISITS_ENABLED = 'true';
  try {
    setCatalog([PRODUCT()]);
    center.recordVisit(alice.id, 'prod-a', 'A');
    center.clearVisits(alice.id);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'price-alert-center.json'), 'utf8'));
    assert.equal(state.visits[alice.id], undefined);
    center.createAlert(alice.id, { productId: 'prod-a', targetPrice: 10 });
    center.purgeUserData(alice.id);
    assert.equal(center.listAlerts(alice.id).length, 0);
  } finally { delete process.env.PRICE_DROP_VISITS_ENABLED; }
});

test('el catálogo nunca se modifica por el centro de alertas', async () => {
  reset(); setCatalog([PRODUCT({ price: 30 })]);
  const before = JSON.stringify(readCatalog(dir));
  center.createAlert(alice.id, { productId: 'prod-a', targetPrice: 45 });
  await center.evaluateAlerts({ mailer });
  assert.equal(JSON.stringify(readCatalog(dir)), before);
});

/* ───────────── API HTTP: autenticación y aislamiento ───────────── */

const cookieOf = (user) => `${auth.SESSION_COOKIE_NAME}=${auth.radarSessionValue(auth.findRadarUserById(user.id))}`;
const call = async (mod, method, url, { user, body, headers } = {}) => {
  const req = new Request('http://localhost' + url, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Cookie: cookieOf(user) } : {}), ...(headers ?? {}) }, body: body ? JSON.stringify(body) : undefined });
  return mod[method]({ request: req, params: { id: url.split('/').pop() } });
};

test('API: sin sesión todo devuelve 401; con sesión sólo ve lo propio; origen ajeno rechazado', async () => {
  reset(); setCatalog([PRODUCT({ price: 50 })]);
  const index = await import('../../src/pages/api/alertas-precio/index.ts');
  const byId = await import('../../src/pages/api/alertas-precio/[id].ts');
  const notif = await import('../../src/pages/api/alertas-precio/notificaciones.ts');
  const prefs = await import('../../src/pages/api/alertas-precio/preferencias.ts');
  const summary = await import('../../src/pages/api/alertas-precio/resumen.ts');
  assert.equal((await call(index, 'GET', '/api/alertas-precio')).status, 401);
  assert.equal((await call(index, 'POST', '/api/alertas-precio', { body: { productId: 'prod-a', targetPrice: 40 } })).status, 401);
  assert.equal((await call(summary, 'GET', '/api/alertas-precio/resumen')).status, 401);
  assert.equal((await call(prefs, 'GET', '/api/alertas-precio/preferencias')).status, 401);
  assert.equal((await call(notif, 'POST', '/api/alertas-precio/notificaciones', { body: { all: true } })).status, 401);

  const created = await call(index, 'POST', '/api/alertas-precio', { user: alice, body: { productId: 'prod-a', targetPrice: 40, includeShipping: false } });
  assert.equal(created.status, 201);
  const alert = (await created.json()).alert;
  const mine = await (await call(index, 'GET', '/api/alertas-precio', { user: alice })).json();
  assert.equal(mine.alerts.length, 1);
  assert.equal(mine.dropAlertsAvailable, false);
  const theirs = await (await call(index, 'GET', '/api/alertas-precio', { user: bob })).json();
  assert.equal(theirs.alerts.length, 0);
  assert.equal((await call(byId, 'PATCH', `/api/alertas-precio/${alert.id}`, { user: bob, body: { targetPrice: 1 } })).status, 404);
  assert.equal((await call(byId, 'DELETE', `/api/alertas-precio/${alert.id}`, { user: bob })).status, 404);
  assert.equal((await call(index, 'POST', '/api/alertas-precio', { user: alice, body: { productId: 'prod-a', targetPrice: 40 }, headers: { Origin: 'https://evil.example' } })).status, 403);
  const patched = await call(byId, 'PATCH', `/api/alertas-precio/${alert.id}`, { user: alice, body: { targetPrice: 35 } });
  assert.equal((await patched.json()).alert.targetPrice, 35);
  const put = await call(prefs, 'PUT', '/api/alertas-precio/preferencias', { user: alice, body: { targets: { email: false } } });
  assert.equal((await put.json()).prefs.targets.email, false);
  assert.equal((await (await call(prefs, 'GET', '/api/alertas-precio/preferencias', { user: bob })).json()).prefs.targets.email, true, 'las preferencias de Alice no afectan a Bob');
  assert.equal((await call(byId, 'DELETE', `/api/alertas-precio/${alert.id}`, { user: alice })).status, 200);
  center.setPrefs(alice.id, { targets: { email: true } });
});

test('API: crear una alerta ya cumplida avisa de inmediato (sin esperar al siguiente ciclo)', async () => {
  reset(); setCatalog([PRODUCT({ price: 30 })]);
  const index = await import('../../src/pages/api/alertas-precio/index.ts');
  const res = await call(index, 'POST', '/api/alertas-precio', { user: bob, body: { productId: 'prod-a', targetPrice: 40 } });
  const body = await res.json();
  assert.equal(body.alreadyMet, true);
  assert.equal(center.unreadCount(bob.id), 1);
});

/* ───────────── Separación de Mi Radar ───────────── */

test('independencia de Mi Radar: el centro no importa su lógica de negocio ni escribe en sus ficheros', () => {
  const src = fs.readFileSync(new URL('../../src/lib/priceAlertCenter.ts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from '\.\/([^']+)'/g)].map((m) => m[1]);
  assert.ok(!imports.includes('radarStore'), 'no usa radarStore (datos de Mi Radar)');
  assert.ok(!imports.includes('priceAlerts'), 'no usa las alertas de Mi Radar');
  assert.ok(!imports.includes('reminders'));
  assert.ok(imports.includes('radarAuth'), 'sólo comparte la identidad (sesión de cuenta)');
  assert.doesNotMatch(src, /radar-data\.json|radar-users\.json/);
  const radarStore = fs.readFileSync(new URL('../../src/lib/radarStore.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(radarStore, /priceAlertCenter/);
  assert.match(src, /price-alert-center\.json/);
});

const readSrc = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
/* ───────────── Centro de alertas: integración ───────────── */

test('menú de usuario: «Alertas de precio» con campana y punto rojo sólo con avisos sin leer; página privada y noindex', () => {
  const layout = readSrc('src/layouts/Layout.astro');
  assert.match(layout, /href="\/alertas-precio"[^>]*data-price-alerts-link/);
  assert.match(layout, /Alertas de precio<\/span>/);
  assert.match(layout, /data-price-alert-dot hidden/);
  assert.match(layout, /d\.hidden = !\(n > 0\)/);
  const page = readSrc('src/pages/alertas-precio.astro');
  assert.match(page, /noindex=\{true\}/);
  assert.match(page, /Alertas configuradas/);
  assert.match(page, /Bajadas de precio/);
  assert.match(page, /Marcar como leído/);
  // La página pinta con textContent (sin innerHTML con datos del usuario/catálogo).
  assert.doesNotMatch(page.split('<script')[1] ?? '', /innerHTML/);
});
