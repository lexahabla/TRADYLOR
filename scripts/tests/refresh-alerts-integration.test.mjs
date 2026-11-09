// Plan de aprovechamiento de la actualización de precios: una consulta por anuncio, prioridad a fichas con alerta, cadencia adaptativa, historial de
// lecturas verificadas, conexión con el centro «Alertas de precio» (salvaguardas) y fuentes adicionales opt-in. Sin red, sin créditos, datos aislados.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, writeCatalog, readCatalog } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-refresh-alerts-');
const refresh = await import('../../src/lib/offerRefresh.ts');
const extra = await import('../../src/lib/offerRefreshExtra.ts');
const center = await import('../../src/lib/priceAlertCenter.ts');
const auth = await import('../../src/lib/radarAuth.ts');
const { collectPoints, buildHistoryView } = await import('../../src/lib/priceHistoryView.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const NOW = new Date('2026-11-10T10:00:00Z');
const prod = (id, price, over = {}) => ({
  id, slug: id, title: `Producto ${id}`, price, category: 'Informática', network: 'amazon', merchant: 'Amazon', currency: 'EUR', inStock: true, image: '/x.jpg',
  affiliateUrl: `https://www.amazon.es/dp/${id.toUpperCase()}`, asin: id.toUpperCase(), sourceId: id.toUpperCase(), extra: {}, ...over,
});
const memStore = (list) => ({ read: () => structuredClone(list.current), write: (next) => { list.current = structuredClone(next); return true; } });
const fakeAdapter = (calls, priceOf = () => 40, extraProps = {}) => ({
  id: 'fake', networks: ['amazon'], ...extraProps,
  resolveSource: (p) => (p.asin ? { type: 'asin', id: p.asin } : null),
  fetch: async (_p, source) => { calls.push(source.id); return { price: priceOf(source.id), currency: 'EUR', inStock: true }; },
});
const run = (list, adapter, opts = {}) => refresh.refreshOffers({ store: memStore(list), adapters: [adapter], now: () => NOW, sleep: async () => {}, evaluateAlerts: false, baseDelayMs: 0, ...opts });

test('varias fichas del MISMO anuncio = una sola consulta a la tienda, y todas se actualizan', async () => {
  const calls = [];
  const list = { current: [prod('b0aaaa0001', 50), prod('b0aaaa0001-copia', 50, { asin: 'B0AAAA0001', sourceId: 'B0AAAA0001' }), prod('b0bbbb0002', 70)] };
  const report = await run(list, fakeAdapter(calls), { all: true });
  assert.equal(calls.length, 2, 'dos anuncios distintos → dos consultas (no tres)');
  assert.equal(report.total, 3);
  assert.deepEqual(list.current.map((p) => p.price), [40, 40, 40]);
  assert.ok(list.current.every((p) => p.extra.refresh.lastVerifiedAt));
});

test('un fallo en un anuncio compartido no se reintenta por cada ficha y se conserva el último valor válido', async () => {
  let n = 0;
  const adapter = { id: 'f2', networks: ['amazon'], resolveSource: (p) => ({ type: 'asin', id: p.asin }), fetch: async () => { n++; throw new refresh.RefreshError('caída temporal', true); } };
  const list = { current: [prod('b0cccc0003', 50), prod('b0cccc0003-b', 50, { asin: 'B0CCCC0003' })] };
  const report = await run(list, adapter, { all: true, maxAttempts: 2 });
  assert.equal(n, 2, 'sólo los 2 intentos de la primera ficha; la gemela reutiliza el fallo');
  assert.equal(report.errors, 2);
  assert.deepEqual(list.current.map((p) => p.price), [50, 50]);
});

test('con «sólo las vencidas» y límite, las fichas con alerta activa se consultan primero', async () => {
  fs.rmSync(path.join(dir, 'price-alert-center.json'), { force: true });
  const user = auth.registerRadarUser({ email: 'q@example.com', password: 'Clave-segura-123', name: 'q', verified: true });
  const list = { current: [prod('b0old00001', 50, { extra: { refresh: { lastVerifiedAt: '2026-11-01T00:00:00Z', status: 'ok' } } }), prod('b0alert0002', 50, { extra: { refresh: { lastVerifiedAt: '2026-11-08T00:00:00Z', status: 'ok' } } })] };
  writeCatalog(dir, list.current);
  center.createAlert(user.id, { productId: 'b0alert0002', targetPrice: 10 });
  const calls = [];
  await run(list, fakeAdapter(calls), { onlyDue: true, limit: 1, schedule: { amazon: { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72 } } });
  assert.deepEqual(calls, ['B0ALERT0002'], 'la ficha con alerta va antes que la más antigua');
});

test('cadencia adaptativa: un precio estable en 3 lecturas se consulta la mitad de veces; con alerta activa, no', () => {
  const obs = (p) => ({ capturedAt: '2026-11-01T00:00:00Z', verifiedAt: '2026-11-01T00:00:00Z', price: p, contextKey: 'k', context: { currency: 'EUR' } });
  const stable = prod('b0stab0001', 50, { extra: { refresh: { lastVerifiedAt: '2026-11-08T22:00:00Z' }, observations: [obs(50), obs(50), obs(50)] } });
  const moving = prod('b0move0001', 50, { extra: { refresh: { lastVerifiedAt: '2026-11-08T22:00:00Z' }, observations: [obs(50), obs(48), obs(50)] } });
  const cfg = { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72 };
  assert.equal(refresh.isStable(stable), true);
  assert.equal(refresh.isStable(moving), false);
  assert.equal(refresh.isDue(stable, cfg, NOW), false, '36 h < 48 h: aún no toca');
  assert.equal(refresh.isDue(moving, cfg, NOW), true, '36 h ≥ 24 h');
  assert.equal(refresh.isDue(stable, cfg, NOW, { hasAlert: true }), true, 'con alerta: frecuencia normal');
});

test('al terminar un refresco con observaciones se evalúan las alertas del centro (sin consultar otra vez a la tienda) y el aviso lleva la fecha de la lectura', async () => {
  fs.rmSync(path.join(dir, 'price-alert-center.json'), { force: true });
  const user = auth.registerRadarUser({ email: 'r@example.com', password: 'Clave-segura-123', name: 'r', verified: true });
  const list = { current: [prod('b0goal0001', 50)] };
  writeCatalog(dir, list.current);
  center.createAlert(user.id, { productId: 'b0goal0001', targetPrice: 45 });
  assert.equal(center.listNotifications(user.id).length, 0);
  const calls = [];
  // Almacén real (products.json aislado) para que el centro lea el precio recién escrito.
  await refresh.refreshOffers({ adapters: [fakeAdapter(calls, () => 40)], ids: ['b0goal0001'], now: () => new Date(), sleep: async () => {}, alertRunner: async () => 0, baseDelayMs: 0 });
  assert.equal(calls.length, 1, 'una sola consulta a la tienda');
  const notes = center.listNotifications(user.id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].newPrice, 40);
  assert.ok(notes[0].priceAsOf, 'fecha de la lectura verificada');
  assert.equal(readCatalog(dir).find((p) => p.id === 'b0goal0001').price, 40);
});

test('salvaguardas del centro: una lectura caducada o un precio recibido por JSON sin verificar NO disparan avisos', () => {
  const stale = prod('b0stale001', 30, { extra: { refresh: { lastVerifiedAt: '2026-11-01T00:00:00Z' } } });
  const json = prod('b0json0001', 30, { extra: { priceReading: { receivedAt: '2026-11-09T09:00:00Z', capturedAt: '2026-11-09T08:00:00Z' } } });
  const verifiedAfter = prod('b0okok0001', 30, { extra: { priceReading: { receivedAt: '2026-11-09T09:00:00Z' }, refresh: { lastVerifiedAt: '2026-11-10T09:00:00Z' } } });
  const noStock = prod('b0nostk001', 30, { inStock: false });
  const usd = prod('b0usd00001', 30, { currency: 'USD' });
  writeCatalog(dir, [stale, json, verifiedAfter, noStock, usd]);
  assert.equal(center.priceStatusOf('b0stale001', NOW).reason, 'lectura_caducada');
  assert.equal(center.priceStatusOf('b0json0001', NOW).reason, 'sin_verificar');
  assert.equal(center.priceStatusOf('b0okok0001', NOW).reason, null);
  assert.equal(center.priceStatusOf('b0okok0001', NOW).cur.asOf, '2026-11-10T09:00:00Z');
  assert.equal(center.priceStatusOf('b0nostk001', NOW).reason, 'sin_stock');
  assert.equal(center.priceStatusOf('b0usd00001', NOW).reason, 'otra_moneda');
  assert.equal(center.priceStatusOf('no-existe', NOW).reason, 'producto_no_encontrado');
});

test('historial: con ≥2 lecturas verificadas se usan sólo ellas; con menos se conservan las anotadas en visitas', () => {
  const obs = (d, p) => ({ capturedAt: `${d}T08:00:00Z`, verifiedAt: `${d}T09:00:00Z`, price: p, context: { currency: 'EUR' } });
  const withVisits = { priceHistory: [{ date: '2026-11-01', price: 100 }, { date: '2026-11-05', price: 100 }, { date: '2026-11-08', price: 99 }], extra: { observations: [obs('2026-11-06', 95), obs('2026-11-09', 90)] } };
  const pts = collectPoints(withVisits);
  assert.deepEqual(pts.map((p) => [p.date, p.source]), [['2026-11-06', 'verificada'], ['2026-11-09', 'verificada']]);
  assert.equal(buildHistoryView(withVisits, NOW).onlyVerified, true);
  const one = { priceHistory: [{ date: '2026-11-01', price: 100 }], extra: { observations: [obs('2026-11-06', 95)] } };
  assert.equal(collectPoints(one).length, 2);
  assert.equal(buildHistoryView(one, NOW).onlyVerified, false);
  assert.match(read('src/middleware.ts'), /lastVerifiedAt\) recordPricePoint/, 'las fichas verificadas ya no anotan el precio del catálogo en cada visita');
});

test('fuentes adicionales: sin la variable de entorno no hay ninguna; con ella, AliExpress y eBay por id, sin tocar el comportamiento de Amazon', () => {
  assert.deepEqual(extra.extraAdaptersFromEnv(undefined), []);
  assert.deepEqual(extra.extraAdaptersFromEnv('').map((a) => a.id), []);
  assert.deepEqual(extra.extraAdaptersFromEnv('aliexpress, ebay').map((a) => a.id), ['aliexpress-affiliate-api', 'ebay-browse-api']);
  assert.deepEqual(refresh.DEFAULT_ADAPTERS.map((a) => a.id), ['amazon-scraperapi'], 'por defecto, sólo Amazon');
  assert.equal(extra.aliexpressAdapter.resolveSource({ network: 'aliexpress', sourceId: 'AE-1005005704532450' }).id, '1005005704532450');
  assert.equal(extra.aliexpressAdapter.resolveSource({ network: 'aliexpress', sourceId: 'raro' }), null);
  assert.equal(extra.ebayAdapter.resolveSource({ network: 'ebay', sourceId: 'v1|167256651525|466937760078' }).id, 'v1|167256651525|466937760078');
  assert.equal(extra.ebayAdapter.resolveSource({ network: 'ebay', sourceId: '', affiliateUrl: 'https://www.ebay.es/itm/167256651525?x=1' }).id, '167256651525');
  assert.ok(extra.aliexpressAdapter.experimental && extra.ebayAdapter.experimental);
});

test('adaptadores extra con transporte simulado: aplican el precio verificado; un anuncio retirado no se reintenta; un salto >50 % va a revisión sin cambiar el precio', async () => {
  const ae = (id, price, over = {}) => ({ id, slug: id, title: `AE ${id}`, price, category: 'X', network: 'aliexpress', merchant: 'AliExpress', currency: 'EUR', inStock: true, image: '/x.jpg', sourceId: `AE-${id}`, affiliateUrl: `https://s.click.aliexpress.com/e/_${id}`, extra: {}, ...over });
  extra.transports.aliexpress = async (id) => (id === '1005000000000001' ? { price: 9.5, originalPrice: 12, currency: 'EUR' } : id === '1005000000000002' ? null : { price: 1, currency: 'EUR' });
  try {
    const list = { current: [ae('1005000000000001', 10), ae('1005000000000002', 10), ae('1005000000000003', 10)] };
    const report = await run(list, extra.aliexpressAdapter, { all: true });
    const byId = Object.fromEntries(list.current.map((p) => [p.id, p]));
    assert.equal(byId['1005000000000001'].price, 9.5);
    assert.ok(byId['1005000000000001'].extra.observations.length === 1);
    assert.equal(byId['1005000000000002'].price, 10, 'retirado: se conserva el último valor');
    assert.match(report.results.find((r) => r.id === '1005000000000002').message, /retirado/);
    assert.equal(byId['1005000000000003'].price, 10, 'salto sospechoso (10 → 1): no se aplica');
    assert.equal(report.results.find((r) => r.id === '1005000000000003').status, 'review');
    assert.equal(byId['1005000000000003'].extra.reviewQueue.at(-1).field, 'price');
    assert.equal(report.review, 1);
  } finally {
    delete extra.transports.aliexpress;
  }
});
