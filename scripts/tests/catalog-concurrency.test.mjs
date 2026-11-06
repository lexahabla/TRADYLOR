// Regresión: escritores LENTOS (leen → esperan red/IA → escriben) no deben pisar lo que otros
// procesos escriben mientras tanto (fichas nuevas, ofertas, precios, ediciones).
// Red e IA SIMULADAS (ninguna prueba sale a Internet ni gasta créditos) y datos aislados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedData, adminCookie, apiRequest, jsonOf, deferred, mockFetch, tick, readCatalog, writeCatalog, jsonRecord, importRecords, GTIN } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-conc-');
const cookie = await adminCookie();
const store = await import('../../src/lib/productStore.ts');
const addRoute = await import('../../src/pages/api/products/add.ts');
const enrichRoute = await import('../../src/pages/api/admin/enrich-bulk.ts');
const opencodeRoute = await import('../../src/pages/api/v1/admin/opencode-command.ts');
const pipelineRoute = await import('../../src/pages/api/v1/products/import.ts');
const buildRoute = await import('../../src/pages/api/v1/products/build-catalog.ts');
const { refreshOffers } = await import('../../src/lib/offerRefresh.ts');
const importer = await import('../../src/lib/jsonImport/service.ts');

/** Importación SÍNCRONA (el servicio real): sirve para intercalarla dentro de otro proceso. */
const syncImport = (records) => importer.processChunk({ batchId: 'conc-' + Math.random().toString(36).slice(2, 10), records, defaults: { category: 'Audio' }, dryRun: false, indexOffset: 0 });

const reset = () => writeCatalog(dir, []);
const byId = (id) => readCatalog(dir).find((p) => p.id === id);

/** Ficha semilla con GTIN (para poder vincularle una oferta de otro comercio durante la espera). */
async function seed() {
  reset();
  await importRecords([jsonRecord(1, { gtin: GTIN })]);
  const [ficha] = readCatalog(dir);
  return ficha;
}

/** Lo que «otro proceso» hace durante la espera: crea 5 fichas, vincula una oferta y baja el precio de la semilla. */
async function concurrentActivity() {
  const out = syncImport([
    ...Array.from({ length: 5 }, (_, i) => jsonRecord(100 + i)),
    jsonRecord(1, { gtin: GTIN, platform: 'otra', externalId: 'OTRA-1', url: 'https://otra.invalid/1', sellerName: 'OtraShop', price: 7 }),
    jsonRecord(1, { gtin: GTIN, price: 9, capturedAt: '2026-10-07T10:00:00Z' }),
  ]);
  return out.results.map((r) => r.outcome);
}

function assertConcurrentWorkSurvived(seedId, label) {
  const all = readCatalog(dir);
  const created = all.filter((p) => /Zeta 10\d/.test(p.title)).length;
  const ficha = all.find((p) => p.id === seedId);
  assert.equal(created, 5, `${label}: las 5 fichas creadas durante la espera sobreviven`);
  assert.equal(ficha.extra?.offers?.length, 1, `${label}: la oferta vinculada durante la espera sobrevive`);
  assert.equal(ficha.price, 9, `${label}: el precio actualizado durante la espera sobrevive`);
}

test('threeWayMerge / commitOwnChanges: sólo se aplican los campos que la operación cambió', () => {
  const base = { id: 'a', title: 'T', price: 10, description: 'd', extra: { x: 1, offers: [] } };
  const ours = { ...base, description: 'nueva' };                       // la operación sólo cambia la descripción
  const theirs = { ...base, price: 7, extra: { x: 1, offers: [{ k: 1 }], nuevo: true } }; // otro proceso cambió precio y extra
  const merged = store.threeWayMerge(base, ours, theirs);
  assert.equal(merged.description, 'nueva');
  assert.equal(merged.price, 7, 'el precio ajeno se conserva');
  assert.deepEqual(merged.extra.offers, [{ k: 1 }], 'las ofertas ajenas se conservan');
  assert.equal(merged.extra.nuevo, true);
  // Borrar un campo propio también es «cambiar»; lo que no se tocó sigue como está.
  const dropped = store.threeWayMerge(base, { ...base, description: undefined }, theirs);
  assert.equal('description' in dropped, false);
  assert.equal(dropped.price, 7);
  // Una ficha sin base (alta nueva) se aplica entera sobre lo existente.
  assert.equal(store.threeWayMerge(undefined, { id: 'a', title: 'N' }, theirs).title, 'N');
});

test('updateCatalog/commitOwnChanges son síncronos: ninguna escritura intercala entre leer y guardar', () => {
  reset();
  store.upsertProduct({ id: 'p', title: 'P', description: '', price: 1, image: 'x', category: 'c', merchant: 'm', affiliateUrl: 'u', pros: [], cons: [] });
  let sawInterleaving = false;
  const result = store.updateCatalog((products) => {
    // Dentro de la sección crítica nada más puede escribir: lo comprobamos releyendo el disco.
    const before = JSON.stringify(readCatalog(dir));
    products[0].price = 2;
    sawInterleaving = JSON.stringify(readCatalog(dir)) !== before;
    return { changed: true, result: 'ok' };
  });
  assert.equal(result.result, 'ok');
  assert.equal(sawInterleaving, false);
  assert.equal(readCatalog(dir)[0].price, 2);
  // La función es síncrona de principio a fin (no devuelve promesa).
  assert.equal(typeof store.updateCatalog(() => ({ changed: false, result: 1 })).then, 'undefined');
});

test('products/add (guardar) lento: la importación concurrente NO se pierde', async () => {
  const ficha = await seed();
  const gate = deferred();
  let fetchStarted = false;
  const restore = mockFetch(async () => { fetchStarted = true; await gate.promise; return new Response('<html><head><title>x</title></head><body>x</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }); });
  try {
    const pending = addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'save', product: { id: 'lento-1', title: 'Ficha guardada desde el panel', affiliateUrl: 'https://tienda-lenta.invalid/p', asin: 'B0LENTO001', sourceId: 'LENTO-1', price: 20, image: 'https://img.invalid/l.jpg', category: 'Audio', merchant: 'Prueba', pros: [], cons: [], description: 'd' } } }) });
    await tick(30);
    assert.equal(fetchStarted, true, 'el guardado está esperando a la tienda (ventana real)');
    const outcomes = await concurrentActivity();
    assert.deepEqual(outcomes, ['created', 'created', 'created', 'created', 'created', 'linked', 'updated']);
    gate.resolve();
    const res = await jsonOf(await pending);
    assert.equal(res.success, true);
    assertConcurrentWorkSurvived(ficha.id, 'products/add');
    assert.ok(readCatalog(dir).some((p) => p.title === 'Ficha guardada desde el panel'), 'la ficha guardada desde el panel también está');
  } finally { restore(); }
});

test('products/add: una ficha NUEVA sin ASIN ni sourceId no sobrescribe la primera ficha sin ASIN', async () => {
  reset();
  await importRecords([jsonRecord(1)]);
  const before = readCatalog(dir)[0];
  const restore = mockFetch(async () => new Response('', { status: 404 }));
  try {
    const res = await addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'save', product: { id: 'nuevo-distinto', title: 'Producto totalmente distinto dos', affiliateUrl: 'https://otro.invalid/b', price: 10, image: 'https://i.invalid/a.jpg', category: 'X', merchant: 'M', pros: [], cons: [], description: 'd' } } }) });
    assert.equal((await jsonOf(res)).success, true);
  } finally { restore(); }
  const all = readCatalog(dir);
  assert.equal(all.length, 2, 'se crea una ficha nueva, no se reemplaza ninguna');
  assert.equal(all.find((p) => p.id === before.id).title, before.title, 'la ficha existente sigue intacta');
});

test('enrich-bulk lento: la importación concurrente NO se pierde y el enriquecimiento se aplica', async () => {
  const ficha = await seed();
  writeCatalog(dir, [{ ...ficha, gallery: ['https://img.invalid/g1.jpg', 'https://img.invalid/g2.jpg'], description: 'Descripción original' }]);
  const gate = deferred();
  let fetchStarted = false;
  const restore = mockFetch(async () => { fetchStarted = true; await gate.promise; return new Response('', { status: 200, headers: { 'content-length': '999999' } }); });
  try {
    const pending = enrichRoute.POST({ request: apiRequest('/api/admin/enrich-bulk', { cookie, body: { ids: [ficha.id] } }) });
    await tick(30);
    assert.equal(fetchStarted, true, 'el enriquecimiento está esperando a la red (ventana real)');
    await concurrentActivity();
    gate.resolve();
    const res = await jsonOf(await pending);
    assert.equal(res.success, true, JSON.stringify(res).slice(0, 200));
    assertConcurrentWorkSurvived(ficha.id, 'enrich-bulk');
    const after = byId(ficha.id);
    assert.notEqual(after.description, 'Descripción original', 'el enriquecimiento (local) sí se aplicó');
    assert.equal(after.ia_status, 'completed');
  } finally { restore(); }
});

test('API v1 import (pipeline) con IA lenta: la importación concurrente NO se pierde', async () => {
  const ficha = await seed();
  process.env.OPENAI_API_KEY = 'clave-de-prueba-no-valida';
  process.env.TEXT_AI_PROVIDER = 'openai';
  const gate = deferred();
  let fetchStarted = false;
  const restore = mockFetch(async () => { fetchStarted = true; await gate.promise; return new Response(JSON.stringify({ error: 'simulado' }), { status: 500, headers: { 'content-type': 'application/json' } }); });
  try {
    const pending = pipelineRoute.POST({ request: apiRequest('/api/v1/products/import', { token: true, body: { id: ficha.id, title: ficha.title, affiliateUrl: ficha.affiliateUrl, price: ficha.price, sourceId: ficha.sourceId, description: 'd', category: 'Audio' } }) });
    await tick(30);
    assert.equal(fetchStarted, true, 'el pipeline espera a la IA (ventana real)');
    await concurrentActivity();
    gate.resolve();
    const res = await jsonOf(await pending);
    assert.equal(res.results?.[0]?.ok, true, JSON.stringify(res).slice(0, 300));
    assertConcurrentWorkSurvived(ficha.id, 'pipeline v1');
  } finally { restore(); delete process.env.OPENAI_API_KEY; delete process.env.TEXT_AI_PROVIDER; }
});

test('opencode-command con LLM lento: la importación concurrente NO se pierde y sus cambios sí se aplican', async () => {
  const ficha = await seed();
  process.env.OPENAI_API_KEY = 'clave-de-prueba-no-valida';
  process.env.TEXT_AI_PROVIDER = 'openai';
  const gate = deferred();
  let fetchStarted = false;
  const actions = { actions: [{ type: 'assign_categories', params: { categoryMap: { [ficha.id]: 'Hogar' } }, description: 'x' }], summary: 'prueba' };
  const restore = mockFetch(async () => { fetchStarted = true; await gate.promise; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(actions) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); });
  try {
    const pending = opencodeRoute.POST({ request: apiRequest('/api/v1/admin/opencode-command', { cookie, body: { prompt: 'recategoriza', productIds: [ficha.id], context: 'selected' } }) });
    await tick(30);
    assert.equal(fetchStarted, true, 'espera al LLM (ventana real)');
    await concurrentActivity();
    gate.resolve();
    const res = await jsonOf(await pending);
    assert.equal(res.success, true, JSON.stringify(res).slice(0, 300));
    assertConcurrentWorkSurvived(ficha.id, 'opencode-command');
    assert.equal(byId(ficha.id).category, 'Hogar', 'el cambio pedido al LLM sí se aplicó');
  } finally { restore(); delete process.env.OPENAI_API_KEY; delete process.env.TEXT_AI_PROVIDER; }
});

/** Grupo sintético multi-comerciante (sin red ni IA). */
function group(n, over = {}) {
  const url = `https://tienda.invalid/bc/${n}`;
  return {
    canonical: { network: 'tienda', externalId: `BC${n}`, affiliateUrl: url, directUrl: url, title: `Producto build catalog ${n} edición ${n * 7}`, description: 'd', price: 10 + n, originalPrice: 12 + n, currency: 'EUR', discountPercentage: 0, inStock: true, commissionRate: 0, estimatedCommission: 0, category: 'Audio', brand: 'Marca', merchantName: 'Tienda', rating: 4, reviewCount: 10, mainImage: `https://img.invalid/bc${n}.jpg`, extraImages: [] },
    variants: [], bestPrice: 10 + n, bestOriginalPrice: 12 + n, bestCommissionRate: 0, bestCommissionAmount: 0, bestRating: 4, bestSales: 0,
    allNetworks: ['tienda'], allAffiliateUrls: { tienda: url }, allDirectUrls: { tienda: url }, allMerchantNames: { tienda: 'Tienda' },
    allExtraImages: [], allPrices: { tienda: 10 + n }, allOriginalPrices: { tienda: 12 + n }, allCurrencies: { tienda: 'EUR' },
    category: 'Audio', isHSR: false, hsrScore: 0, ...over,
  };
}

test('Construir Catálogo: lo que otro proceso escribe durante la construcción NO se pierde', async () => {
  reset();
  const out = await buildRoute.buildAndUpsertProducts([group(1)], false, false, {
    onProgress: () => { syncImport([jsonRecord(300), jsonRecord(301)]); }, // entre construir y escribir
  });
  assert.equal(out.upserted, 1);
  const titles = readCatalog(dir).map((p) => p.title);
  assert.ok(titles.some((t) => /build catalog 1/.test(t)), 'la ficha construida está');
  assert.ok(titles.some((t) => /Zeta 300/.test(t)) && titles.some((t) => /Zeta 301/.test(t)), 'las fichas importadas durante la construcción también');
});

test('Construir Catálogo sobre una ficha con ofertas: conserva extra.offers y el precio de otros procesos', async () => {
  reset();
  await buildRoute.buildAndUpsertProducts([group(2)], false, false);
  const ficha = readCatalog(dir)[0];
  await importRecords([jsonRecord(2, { platform: 'otra', externalId: 'OTRA-2', url: 'https://otra.invalid/2', gtin: GTIN })]);
  // ficha existente sin GTIN: la oferta de «otra» no se vincula sola (queda en revisión) → se añade a mano una oferta a extra.offers
  const withOffer = { ...byId(ficha.id), extra: { ...(byId(ficha.id).extra ?? {}), offers: [{ offerId: 'o1', offerKey: 'otra:x', platform: 'otra', url: 'https://otra.invalid/2', canonicalUrl: 'otra.invalid/2', price: 5, currency: 'EUR', availability: 'unknown', shipping: { cost: null, free: null, days: null }, condition: 'unknown', capturedAt: '', verifiedAt: '', source: { channel: 'json', batchId: 'b', adapter: 'x' }, status: 'active' }] } };
  writeCatalog(dir, readCatalog(dir).map((p) => (p.id === ficha.id ? withOffer : p)));
  await buildRoute.buildAndUpsertProducts([group(2, { bestPrice: 99 })], false, false, {
    onProgress: () => { syncImport([jsonRecord(310)]); },
  });
  const after = byId(ficha.id);
  assert.equal(after.extra.offers.length, 1, 'extra.offers intacto tras Construir Catálogo');
  assert.ok(readCatalog(dir).some((p) => /Zeta 310/.test(p.title)), 'la ficha importada durante la construcción sobrevive');
});

test('Actualización de ofertas (offerRefresh): conserva extra.offers y lo escrito durante la consulta a la red', async () => {
  reset();
  await importRecords([jsonRecord(1, { platform: 'amazon', externalId: 'B0REFRESH1', url: 'https://www.amazon.es/dp/B0REFRESH1', gtin: GTIN })]);
  await importRecords([jsonRecord(1, { gtin: GTIN, platform: 'otra', externalId: 'OTRA-R', url: 'https://otra.invalid/r' })]);
  const ficha = readCatalog(dir)[0];
  const adapter = {
    id: 'fake', networks: ['amazon'],
    resolveSource: (p) => ({ type: 'asin', id: p.sourceId }),
    fetch: async () => {
      // Mientras «consulta la red», otro proceso crea fichas y cambia otra oferta.
      syncImport([jsonRecord(320), jsonRecord(321)]);
      return { price: 25, currency: 'EUR', inStock: true, shippingCost: 0, identity: { sourceId: 'B0REFRESH1' } };
    },
  };
  const report = await refreshOffers({ ids: [ficha.id], adapters: [adapter], sleep: async () => {}, evaluateAlerts: false, baseDelayMs: 0, runId: 'r-1' });
  assert.equal(report.updated, 1);
  const after = byId(ficha.id);
  assert.equal(after.price, 25, 'el refresco actualizó el precio');
  assert.equal(after.extra.offers.length, 1, 'extra.offers intacto');
  assert.ok(readCatalog(dir).some((p) => /Zeta 320/.test(p.title)) && readCatalog(dir).some((p) => /Zeta 321/.test(p.title)));
});
