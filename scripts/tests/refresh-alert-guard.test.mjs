// Actualización manual con `evaluateAlerts:false`: sólo admin, por defecto las alertas siguen evaluándose, y se rechaza si alguna alerta vigila las fichas
// (los vigilantes de Mi Radar y del centro notificarían después de guardar el precio). Sin red, sin correos, datos aislados.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, writeCatalog, readCatalog, adminCookie, apiRequest, jsonOf, mockFetch } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-refresh-guard-');
const refresh = await import('../../src/lib/offerRefresh.ts');
const center = await import('../../src/lib/priceAlertCenter.ts');
const radar = await import('../../src/lib/radarStore.ts');
const auth = await import('../../src/lib/radarAuth.ts');
const route = await import('../../src/pages/api/admin/offers/refresh.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

// Sin red: una ejecución sobre fichas sin fuente no debe consultar nada.
const restore = mockFetch(() => { throw new Error('PRUEBA: no debe haber ninguna petición de red'); });
test.after(() => restore());

const prod = (id, over = {}) => ({ id, slug: id, title: `Producto ${id}`, price: 20, category: 'Informática', network: 'temu', merchant: 'Temu', currency: 'EUR', inStock: true, image: '/x.jpg', affiliateUrl: `https://www.temu.com/es/-g-${id}.html`, sourceId: '601099500000001', extra: {}, ...over });
writeCatalog(dir, [prod('ficha-a'), prod('ficha-b')]);
const cookie = await adminCookie();
const post = (body, opts = {}) => route.POST({ request: apiRequest('/api/admin/offers/refresh', { cookie: opts.noCookie ? undefined : cookie, body }) });
const user = auth.registerRadarUser({ email: 'guard@example.com', password: 'Clave-segura-123', name: 'guard', verified: true });
const before = () => JSON.stringify(readCatalog(dir));

test('sólo un administrador puede pedir evaluateAlerts:false', async () => {
  const res = await post({ ids: ['ficha-a'], evaluateAlerts: false }, { noCookie: true });
  assert.equal(res.status, 401);
});

test('evaluateAlerts:false exige una lista concreta de fichas (no all:true)', async () => {
  const res = await post({ all: true, evaluateAlerts: false });
  assert.equal(res.status, 400);
  assert.equal((await jsonOf(res)).code, 'evaluate_alerts_requiere_ids');
  const res2 = await post({ evaluateAlerts: false });
  assert.equal(res2.status, 400);
});

test('sin alertas vigilando, evaluateAlerts:false se ejecuta, lo indica y no toca el centro de alertas ni sale a la red', async () => {
  const res = await post({ ids: ['ficha-a'], evaluateAlerts: false });
  assert.equal(res.status, 200);
  const body = await jsonOf(res);
  assert.equal(body.alertsEvaluation, 'omitida');
  assert.deepEqual(readCatalog(dir).map((p) => p.price), [20, 20], 'una ficha sin fuente no cambia de precio (sólo anota que no hay fuente)');
  assert.equal(fs.existsSync(path.join(dir, 'price-alert-center.json')), false, 'no se creó ni escribió el centro de alertas');
});

test('por defecto (sin el parámetro, o con un valor que no es el booleano false) el comportamiento es el normal', async () => {
  for (const extra of [{}, { evaluateAlerts: true }, { evaluateAlerts: 'false' }, { evaluateAlerts: 0 }, { evaluateAlerts: null }]) {
    const res = await post({ ids: ['ficha-a'], ...extra });
    assert.equal(res.status, 200, JSON.stringify(extra));
    assert.equal((await jsonOf(res)).alertsEvaluation, 'normal', JSON.stringify(extra));
  }
});

test('una alerta del centro «Alertas de precio» sobre la ficha bloquea la omisión (409) sin ejecutar ni exponer datos de usuarios', async () => {
  center.createAlert(user.id, { productId: 'ficha-a', targetPrice: 10 });
  const snapshot = before();
  const res = await post({ ids: ['ficha-a', 'ficha-b'], evaluateAlerts: false });
  assert.equal(res.status, 409);
  const body = await jsonOf(res);
  assert.equal(body.code, 'alertas_vigilando');
  assert.deepEqual(body.alertExposure, { center: 1, radar: 0, total: 1 });
  assert.doesNotMatch(JSON.stringify(body), /guard@example\.com|alertId|userId/);
  assert.equal(before(), snapshot);
  // Otra ficha sin alertas no queda bloqueada.
  const other = await post({ ids: ['ficha-b'], evaluateAlerts: false });
  assert.equal(other.status, 200);
});

test('un producto de Mi Radar con precio objetivo o aviso de stock sobre la ficha también bloquea (409)', async () => {
  radar.addProduct(user.id, { id: 'ficha-b', title: 'Producto ficha-b', price: '20,00 €', priceValue: 20, image: '/x.jpg', buyUrl: '/producto/ficha-b', store: 'amazon', dateAdded: new Date().toISOString() });
  radar.updateProductAlert(user.id, 'ficha-b', { targetPrice: 15, notifyPriceDrop: true });
  const res = await post({ ids: ['ficha-b'], evaluateAlerts: false });
  assert.equal(res.status, 409);
  assert.deepEqual((await jsonOf(res)).alertExposure, { center: 0, radar: 1, total: 1 });
});

test('refreshOffers: evaluateAlerts:false no lanza ni el barrido de Mi Radar ni el centro; sin el parámetro sí se evalúa', async () => {
  let runs = 0;
  const memory = { current: [prod('ficha-c', { network: 'amazon', asin: 'B0AAAA0003', sourceId: 'B0AAAA0003', affiliateUrl: 'https://www.amazon.es/dp/B0AAAA0003' })] };
  const adapter = { id: 'fake', networks: ['amazon'], resolveSource: (p) => ({ type: 'asin', id: p.asin }), fetch: async () => ({ price: 18, currency: 'EUR', inStock: true }) };
  const opts = (more) => ({ store: { read: () => structuredClone(memory.current), write: (n) => { memory.current = structuredClone(n); return true; } }, adapters: [adapter], ids: ['ficha-c'], sleep: async () => {}, baseDelayMs: 0, alertRunner: async () => { runs++; return 0; }, ...more });
  const r1 = await refresh.refreshOffers(opts({ evaluateAlerts: false }));
  assert.equal(r1.observations, 1);
  assert.equal(runs, 0, 'con evaluateAlerts:false el barrido no se ejecuta');
  const r2 = await refresh.refreshOffers(opts({ now: () => new Date(Date.now() + 86_400_000 * 2) }));
  assert.equal(r2.observations, 1);
  assert.equal(runs, 1, 'por defecto el barrido se sigue ejecutando');
});

test('el endpoint sólo pasa evaluateAlerts:false cuando el cuerpo trae exactamente false', () => {
  const src = read('src/pages/api/admin/offers/refresh.ts');
  assert.match(src, /const skipAlerts = body\?\.evaluateAlerts === false;/);
  assert.match(src, /evaluateAlerts: skipAlerts \? false : undefined/);
  assert.match(src, /requireAdminAuth\(request\)/);
});
