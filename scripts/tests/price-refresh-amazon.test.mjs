// «Actualizar precios» debe poder CORREGIR los precios de Amazon que están mal:
//  - lector de precios sin fallos con separadores de miles (antes: NaN o 1,329 en lugar de 1.329);
//  - la corrección real: precio erróneo → precio correcto, con histórico y sin tocar el resto de la ficha;
//  - el lote del botón sólo incluye fichas actualizables (las de otras redes ya no ocupan los puestos).
// Sin red, sin ScraperAPI y sin IA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupIsolatedData, readCatalog, writeCatalog, adminCookie, apiRequest, jsonOf } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-price-refresh-');
const { normalizeScrapedAmazonData } = await import('../../src/lib/amazonImport.ts');
const { refreshOffers, isRefreshable, amazonAdapter } = await import('../../src/lib/offerRefresh.ts');
const route = await import('../../src/pages/api/admin/sync-prices.ts');

const ASIN = 'B09B32PCGH';
const noSleep = async () => {};
const makeStore = (products) => {
  const state = { products: structuredClone(products) };
  return { state, read: () => structuredClone(state.products), write: (next) => { state.products = structuredClone(next); return true; } };
};
const amazonProduct = (over = {}) => ({
  id: 'amazon-' + ASIN.toLowerCase(), title: 'Portátil de prueba', brand: 'Zeta', merchant: 'Amazon', network: 'amazon', asin: ASIN,
  price: 1.329, currency: 'EUR', inStock: true, priceHistory: [], pros: [], cons: [], affiliateUrl: 'https://www.amazon.es/dp/' + ASIN,
  verdict: 'Texto enriquecido y revisado', ...over,
});
/** Adaptador que usa la NORMALIZACIÓN real de Amazon sobre una respuesta cruda de ScraperAPI. */
const adapterFromRaw = (raw) => ({
  id: 'amazon-scraperapi-raw',
  networks: ['amazon'],
  resolveSource: (p) => (p.asin ? { type: 'asin', id: p.asin } : null),
  fetch: async () => {
    const n = normalizeScrapedAmazonData(raw, ASIN);
    return { price: n.price ?? null, originalPrice: n.originalPrice ?? null, currency: n.currency, inStock: n.inStock, identity: { title: n.title, brand: n.brand, sourceId: n.asin } };
  },
});

test('lector de precios de Amazon: formatos europeos y anglosajones con miles, símbolo y espacios (antes NaN o 1.000 veces menos)', () => {
  const table = [
    ['689,99 €', 689.99], ['€689.99', 689.99], ['1.329,00 €', 1329], ['€1,329.00', 1329], ['1.329 €', 1329], ['1 329,00 €', 1329],
    ['2.499,99€', 2499.99], ['€2,499.99', 2499.99], ['1329.00', 1329], ['12,5', 12.5], [689.99, 689.99], [1329, 1329],
    [{ value: '1.329,00' }, 1329], [{ amount: 1329 }, 1329], [{ value: 689.99, currency: 'EUR' }, 689.99],
  ];
  for (const [input, expected] of table) {
    for (const key of ['price', 'pricing']) {
      const n = normalizeScrapedAmazonData({ asin: ASIN, title: 'x', [key]: input }, ASIN);
      assert.equal(n.price, expected, `${key}=${JSON.stringify(input)}`);
    }
  }
  // precio de lista con el mismo lector
  assert.equal(normalizeScrapedAmazonData({ asin: ASIN, title: 'x', price: '1.329,00 €', list_price: '1.499,00 €' }, ASIN).originalPrice, 1499);
});

test('lo que no es un importe válido NO produce NaN ni 0: queda sin precio', () => {
  for (const bad of ['', 'agotado', 'No disponible', null, undefined, 0, '0,00 €', {}, []]) {
    const n = normalizeScrapedAmazonData({ asin: ASIN, title: 'x', price: bad }, ASIN);
    assert.ok(n.price === undefined || n.price === null || (Number.isFinite(n.price) && n.price > 0), JSON.stringify(bad) + ' → ' + n.price);
    assert.ok(!Number.isNaN(n.price), 'nunca NaN');
  }
});

test('el botón corrige un precio MAL: 1,329 € guardado → 1.329 € real, con histórico, precio anterior y sin tocar el texto enriquecido', async () => {
  const store = makeStore([amazonProduct({ originalPrice: 1.499 })]);
  const report = await refreshOffers({
    ids: [amazonProduct().id], store, adapters: [adapterFromRaw({ asin: ASIN, title: 'Portátil de prueba', pricing: '1.329,00 €', list_price: '1.499,00 €', in_stock: true })],
    sleep: noSleep, now: () => new Date('2026-11-07T10:00:00.000Z'), evaluateAlerts: false, baseDelayMs: 0,
  });
  const p = store.state.products[0];
  assert.equal(report.updated, 1);
  assert.equal(report.results[0].status, 'updated');
  assert.equal(p.price, 1329, 'precio corregido');
  assert.equal(p.originalPrice, 1499, 'precio anterior corregido');
  assert.deepEqual(p.priceHistory.map((h) => h.price), [1329]);
  assert.equal(p.lastPriceSync, '2026-11-07T10:00:00.000Z');
  assert.equal(p.verdict, 'Texto enriquecido y revisado', 'texto enriquecido intacto');
  assert.match(report.results[0].message, /precio 1\.33 → 1329\.00/);
});

test('el botón corrige también un precio que quedó MUY por encima o por debajo (sin umbrales que lo bloqueen)', async () => {
  for (const wrong of [0.99, 13290, 689]) {
    const store = makeStore([amazonProduct({ price: wrong })]);
    const r = await refreshOffers({ ids: [amazonProduct().id], store, adapters: [adapterFromRaw({ asin: ASIN, title: 'x', price: '689,99 €' })], sleep: noSleep, now: () => new Date('2026-11-07T10:00:00.000Z'), evaluateAlerts: false, baseDelayMs: 0 });
    assert.equal(store.state.products[0].price, 689.99, `de ${wrong}`);
    assert.equal(r.results[0].status, wrong === 689 ? 'updated' : 'updated');
  }
});

test('un «precio anterior» que ya no es mayor que el actual (descuento falso) se retira al actualizar', async () => {
  const store = makeStore([amazonProduct({ price: 500, originalPrice: 450 })]);
  const r = await refreshOffers({ ids: [amazonProduct().id], store, adapters: [adapterFromRaw({ asin: ASIN, title: 'x', price: '500,00 €' })], sleep: noSleep, now: () => new Date('2026-11-07T10:00:00.000Z'), evaluateAlerts: false, baseDelayMs: 0 });
  assert.equal(store.state.products[0].originalPrice, undefined);
  assert.ok(r.results[0].changes.includes('precio anterior incoherente retirado'));
  assert.equal(store.state.products[0].price, 500, 'el precio correcto no cambia');
});

test('una respuesta sin precio válido NO sobrescribe el precio con basura (sigue conservando el último valor)', async () => {
  const store = makeStore([amazonProduct({ price: 689.99 })]);
  const r = await refreshOffers({ ids: [amazonProduct().id], store, adapters: [adapterFromRaw({ asin: ASIN, title: 'x', price: 'No disponible' })], sleep: noSleep, now: () => new Date('2026-11-07T10:00:00.000Z'), evaluateAlerts: false, baseDelayMs: 0, maxAttempts: 1 });
  assert.equal(r.results[0].status, 'error');
  assert.equal(store.state.products[0].price, 689.99);
});

test('isRefreshable: sólo Amazon con ASIN; Temu, AliExpress y Amazon sin ASIN no', () => {
  assert.equal(isRefreshable(amazonProduct()), true);
  assert.equal(isRefreshable(amazonProduct({ asin: undefined, sourceId: ASIN })), true);
  assert.equal(isRefreshable(amazonProduct({ asin: undefined, sourceId: undefined })), false);
  assert.equal(isRefreshable({ id: 't1', title: 'x', network: 'temu', sourceId: '601101683713758', price: 5, affiliateUrl: 'https://temu.to/k/abc' }), false);
  assert.equal(isRefreshable({ id: 'a1', title: 'x', network: 'aliexpress', sourceId: 'AE-1005001', price: 5, affiliateUrl: 'https://aliexpress.com/item/1.html' }), false);
  assert.equal(typeof amazonAdapter.fetch, 'function');
});

/* ───────────── El lote del botón: sólo actualizables, primero las nunca verificadas ───────────── */

test('lote del botón sin selección: ignora las fichas de otras redes y prioriza las de Amazon nunca verificadas, luego las más antiguas', async () => {
  const temu = Array.from({ length: 12 }, (_, i) => ({ id: 'temu-' + i, title: 'Temu ' + i, network: 'temu', sourceId: '70100000000000' + i, price: 5, currency: 'EUR', inStock: true, priceHistory: [], pros: [], cons: [], affiliateUrl: 'https://www.temu.com/es/-g-70100000000000' + i + '.html' }));
  const amz = (n, extra = {}) => amazonProduct({ id: 'amazon-b0test000' + n, asin: 'B0TEST000' + n, ...extra });
  writeCatalog(dir, [
    ...temu,
    amz(1, { extra: { refresh: { lastVerifiedAt: '2026-11-06T10:00:00.000Z' } } }), // verificada ayer
    amz(2), // nunca verificada
    amz(3, { extra: { refresh: { lastVerifiedAt: '2026-10-01T10:00:00.000Z' } } }), // la más antigua
  ]);
  const cookie = await adminCookie();
  const res = await route.POST({ request: apiRequest('/api/admin/sync-prices', { body: { limit: 2 }, cookie }) });
  const body = await jsonOf(res);
  assert.equal(body.success, true);
  assert.equal(body.total, 2);
  assert.deepEqual(body.results.map((r) => r.id).sort(), ['amazon-b0test0002', 'amazon-b0test0003'], 'la nunca verificada y la más antigua');
  assert.ok(!body.results.some((r) => r.id.startsWith('temu-')), 'ninguna ficha de Temu ocupa un puesto del lote');
  assert.equal(typeof body.priceCorrected, 'number');
});

test('sin ninguna ficha actualizable el botón lo dice claramente (sin consultar nada)', async () => {
  writeCatalog(dir, [{ id: 'temu-x', title: 'Temu', network: 'temu', sourceId: '701000000000009', price: 5, currency: 'EUR', priceHistory: [], pros: [], cons: [], affiliateUrl: 'https://www.temu.com/es/-g-701000000000009.html' }]);
  const cookie = await adminCookie();
  const res = await route.POST({ request: apiRequest('/api/admin/sync-prices', { body: { limit: 10 }, cookie }) });
  assert.equal(res.status, 404);
  assert.match((await jsonOf(res)).message, /No hay productos de Amazon con ASIN/);
});

test('con selección explícita se consultan exactamente las elegidas (como antes)', async () => {
  writeCatalog(dir, [amazonProduct({ id: 'amazon-b0test0010', asin: 'B0TEST0010' }), amazonProduct({ id: 'amazon-b0test0011', asin: 'B0TEST0011' })]);
  const cookie = await adminCookie();
  const res = await route.POST({ request: apiRequest('/api/admin/sync-prices', { body: { productIds: ['amazon-b0test0011'] }, cookie }) });
  const body = await jsonOf(res);
  assert.deepEqual(body.results.map((r) => r.id), ['amazon-b0test0011']);
});

test('el panel explica qué consulta el botón y muestra cuántos precios se corrigieron', () => {
  const panel = fs.readFileSync('d:/AXEL/WEBS/TRADYLOR/tradylor_web/src/pages/upayp1b4.astro', 'utf8');
  assert.ok(panel.includes('Actualizar y corregir el precio de los 10 productos de Amazon'));
  assert.ok(panel.includes('con el precio corregido'));
});
