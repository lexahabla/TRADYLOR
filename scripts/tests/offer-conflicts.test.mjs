// Regresión: conflictos y borrados CONCURRENTES.
//  · dos operaciones que incorporan/actualizan ofertas DISTINTAS de una misma ficha: ambas se conservan;
//  · cambios simultáneos sobre la MISMA oferta: qué valor prevalece y por qué (documentado con pruebas);
//  · eliminar una ficha u oferta mientras una tarea lenta espera: al terminar NO se recrean.
// Red e IA simuladas, sin claves ni créditos, datos aislados.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie, apiRequest, jsonOf, deferred, mockFetch, tick, readCatalog, writeCatalog, jsonRecord, importRecords, GTIN } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-confl-');
const cookie = await adminCookie();
const store = await import('../../src/lib/productStore.ts');
const identity = await import('../../src/lib/deletedIdentity.ts');
const catalogOffers = await import('../../src/lib/catalogOffers.ts');
const importer = await import('../../src/lib/jsonImport/service.ts');
const importRoute = await import('../../src/pages/api/admin/json-import/index.ts');
const addRoute = await import('../../src/pages/api/products/add.ts');
const addProductRoute = await import('../../src/pages/api/admin/add-product.ts');
const enrichRoute = await import('../../src/pages/api/admin/enrich-bulk.ts');
const opencodeRoute = await import('../../src/pages/api/v1/admin/opencode-command.ts');
const pipelineRoute = await import('../../src/pages/api/v1/products/import.ts');
const amazonRoute = await import('../../src/pages/api/admin/amazon/import-json.ts');
const buildRoute = await import('../../src/pages/api/v1/products/build-catalog.ts');
const { refreshOffers } = await import('../../src/lib/offerRefresh.ts');
const history = await import('../../src/lib/priceHistory.ts');

const reset = () => {
  writeCatalog(dir, []);
  for (const f of ['deleted-product-ids.json', 'deleted-identities.json', 'deleted-offers.json']) fs.rmSync(path.join(dir, f), { force: true });
};
const byId = (id) => readCatalog(dir).find((p) => p.id === id);
const sync = (records) => importer.processChunk({ batchId: 'cf-' + Math.random().toString(36).slice(2, 10), records, defaults: { category: 'Audio' }, dryRun: false, indexOffset: 0 });
const viaRoute = async (records) => jsonOf(await importRoute.POST({ request: apiRequest('/api/admin/json-import', { token: true, body: { batchId: 'rt-' + Math.random().toString(36).slice(2, 10), records, defaults: { category: 'Audio' } } }) }));
const panelDelete = (id) => addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'delete', id } }) });

/** Borrado síncrono equivalente al del panel (para intercalarlo dentro de otro proceso). */
function deleteSync(id) {
  const { result: removed } = store.updateCatalog((products) => {
    const gone = products.find((p) => p.id === id);
    if (!gone) return { changed: false, result: null };
    products.splice(products.indexOf(gone), 1);
    return { changed: true, result: gone };
  });
  if (removed) identity.recordProductDeletion(removed);
}

const OTRA = (over = {}) => jsonRecord(1, { gtin: GTIN, platform: 'otra', externalId: 'OTRA-1', url: 'https://otra.invalid/p/o1', sellerName: 'OtraShop', price: 28, ...over });
const TERCERA = (over = {}) => jsonRecord(1, { gtin: GTIN, platform: 'tercera', externalId: 'TER-1', url: 'https://tercera.invalid/p/t1', price: 27, ...over });

async function seed() {
  reset();
  sync([jsonRecord(1, { gtin: GTIN })]);
  return readCatalog(dir)[0];
}

/* ───────────────── Ofertas DISTINTAS de una misma ficha ───────────────── */

test('dos importaciones simultáneas que vinculan ofertas DISTINTAS a la misma ficha: se conservan ambas', async () => {
  const f = await seed();
  const [a, b] = await Promise.all([viaRoute([OTRA()]), viaRoute([TERCERA()])]);
  assert.deepEqual([a.results[0].outcome, b.results[0].outcome], ['linked', 'linked']);
  const offers = byId(f.id).extra.offers;
  assert.deepEqual(offers.map((o) => o.platform).sort(), ['otra', 'tercera']);
  assert.equal(readCatalog(dir).length, 1, 'una sola ficha');
});

test('dos importaciones simultáneas que ACTUALIZAN ofertas distintas de la misma ficha: ambas actualizaciones se aplican', async () => {
  const f = await seed();
  sync([OTRA(), TERCERA()]);
  const [a, b] = await Promise.all([
    viaRoute([OTRA({ price: 20, capturedAt: '2026-10-08T10:00:00Z' })]),
    viaRoute([TERCERA({ price: 19, capturedAt: '2026-10-08T10:00:00Z' })]),
  ]);
  assert.deepEqual([a.results[0].outcome, b.results[0].outcome], ['updated', 'updated']);
  const offers = byId(f.id).extra.offers;
  assert.equal(offers.find((o) => o.platform === 'otra').price, 20);
  assert.equal(offers.find((o) => o.platform === 'tercera').price, 19);
});

test('tarea lenta con instantánea antigua + DOS importaciones que vinculan ofertas distintas durante la espera: se conservan ambas', async () => {
  const f = await seed();
  const gate = deferred();
  let started = false;
  const restore = mockFetch(async () => { started = true; await gate.promise; return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }); });
  try {
    const pending = addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'save', product: { ...f, title: f.title + ' (editado)' } } }) });
    await tick(30);
    assert.equal(started, true, 'ventana real');
    const [a, b] = await Promise.all([viaRoute([OTRA()]), viaRoute([TERCERA()])]);
    assert.deepEqual([a.results[0].outcome, b.results[0].outcome], ['linked', 'linked']);
    gate.resolve();
    assert.equal((await jsonOf(await pending)).success, true);
    const after = byId(f.id);
    assert.equal(after.extra.offers.length, 2, 'las dos ofertas sobreviven');
    assert.match(after.title, /\(editado\)/, 'y la edición también');
  } finally { restore(); }
});

/* ───────────────── Cambios simultáneos sobre la MISMA oferta ───────────────── */

test('misma oferta ADICIONAL: prevalece la lectura con fecha de captura MÁS RECIENTE, llegue en el orden que llegue', async () => {
  for (const order of ['reciente-primero', 'antigua-primero']) {
    const f = await seed();
    sync([OTRA({ price: 30, capturedAt: '2026-10-06T10:00:00Z' })]);
    const newer = OTRA({ price: 20, capturedAt: '2026-10-08T10:00:00Z' });
    const older = OTRA({ price: 25, capturedAt: '2026-10-07T10:00:00Z' });
    const results = await Promise.all((order === 'reciente-primero' ? [newer, older] : [older, newer]).map((r) => viaRoute([r])));
    const offer = byId(f.id).extra.offers.find((o) => o.platform === 'otra');
    assert.equal(offer.price, 20, `${order}: gana la lectura más reciente`);
    assert.equal(new Date(offer.capturedAt).toISOString(), '2026-10-08T10:00:00.000Z');
    if (order === 'reciente-primero') assert.ok(results[1].results[0].reasons.includes('lectura_anterior_descartada'), 'la antigua se descarta, no se aplica');
  }
});

test('misma oferta PRINCIPAL: si ya fue VERIFICADA por el refresco, una lectura de JSON anterior a esa verificación se descarta', async () => {
  reset();
  sync([jsonRecord(1, { gtin: GTIN, platform: 'amazon', externalId: 'B0CONFL010', url: 'https://www.amazon.es/dp/B0CONFL010' })]);
  const f = readCatalog(dir)[0];
  const adapter = { id: 'fake', networks: ['amazon'], resolveSource: (p) => ({ type: 'asin', id: p.asin }), fetch: async () => ({ price: 20, currency: 'EUR', inStock: true, shippingCost: 0, identity: { sourceId: 'B0CONFL010' } }) };
  await refreshOffers({ ids: [f.id], adapters: [adapter], sleep: async () => {}, evaluateAlerts: false, baseDelayMs: 0, runId: 'cf-v', now: () => new Date('2026-10-12T10:00:00Z') });
  const late = sync([jsonRecord(1, { gtin: GTIN, platform: 'amazon', externalId: 'B0CONFL010', url: 'https://www.amazon.es/dp/B0CONFL010', price: 25, capturedAt: '2026-10-07T10:00:00Z' })]);
  assert.ok(late.results[0].reasons.includes('lectura_anterior_descartada'));
  assert.equal(byId(f.id).price, 20);
});

test('misma oferta PRINCIPAL: dos lecturas con fechas FIABLES recibidas en orden inverso → prevalece la de captura más reciente (en cualquier orden)', async () => {
  for (const order of ['reciente-primero', 'antigua-primero']) {
    const f = await seed();
    const main = (price, capturedAt) => jsonRecord(1, { gtin: GTIN, price, capturedAt });
    const newer = main(20, '2026-10-08T10:00:00Z');
    const older = main(25, '2026-10-07T10:00:00Z');
    const results = (order === 'reciente-primero' ? [newer, older] : [older, newer]).map((r) => sync([r]).results[0]);
    const after = byId(f.id);
    assert.equal(after.price, 20, order + ': gana la lectura más reciente');
    assert.equal(new Date(after.extra.priceReading.capturedAt).toISOString(), '2026-10-08T10:00:00.000Z', 'la captura guardada es la de la lectura vencedora');
    assert.equal(after.extra.priceReading.capturedAtInferred, false);
    assert.equal(after.lastPriceSync, undefined, 'sin inventar una verificación');
    if (order === 'reciente-primero') assert.ok(results[1].reasons.includes('lectura_anterior_descartada'));
  }
});

test('misma oferta PRINCIPAL con una lectura SIN fecha fiable: la recepción no se trata como captura (no descarta ni es descartada)', async () => {
  const f = await seed();
  sync([jsonRecord(1, { gtin: GTIN, price: 20, capturedAt: undefined })]); // captura inferida (= recepción)
  const stored = byId(f.id).extra.priceReading;
  assert.equal(stored.capturedAtInferred, true);
  const dated = sync([jsonRecord(1, { gtin: GTIN, price: 25, capturedAt: '2026-10-01T10:00:00Z' })]); // fecha fiable anterior a la recepción
  assert.equal(dated.results[0].outcome, 'updated', 'una captura inferida no declara «anterior» a una lectura con fecha fiable');
  assert.equal(byId(f.id).price, 25);
  assert.equal(byId(f.id).extra.priceReading.capturedAtInferred, false);
});

test('misma oferta con la MISMA fecha de captura y precios distintos: prevalece la última en llegar (no es «anterior»)', async () => {
  const f = await seed();
  sync([OTRA({ price: 30 })]);
  sync([OTRA({ price: 11, capturedAt: '2026-10-09T10:00:00Z' })]);
  sync([OTRA({ price: 12, capturedAt: '2026-10-09T10:00:00Z' })]);
  assert.equal(byId(f.id).extra.offers[0].price, 12, 'empate de fecha → gana el último que se procesa (orden serializado de llegada)');
});

test('LIMITACIÓN documentada · add-product (edición manual) y una actualización simultánea del MISMO precio: prevalece el valor del formulario', async () => {
  const f = await seed();
  const gate = deferred();
  const restore = mockFetch(async () => { await gate.promise; return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }); });
  try {
    const pending = addProductRoute.POST({ request: apiRequest('/api/admin/add-product', { cookie, body: { id: f.id, title: f.title, affiliateUrl: f.affiliateUrl, price: f.price, category: 'Audio', options: { text: false, image: false, save: true } } }) });
    await tick(30);
    sync([jsonRecord(1, { gtin: GTIN, price: 9, capturedAt: '2026-10-09T10:00:00Z' })]);
    assert.equal(byId(f.id).price, 9);
    gate.resolve();
    assert.equal((await jsonOf(await pending)).success, true);
    // El formulario reenvía TODOS los campos (no distingue lo editado de lo no tocado): su precio prevalece.
    assert.equal(byId(f.id).price, f.price);
  } finally { restore(); }
});

test('FUNCIONA · enrich-bulk (precio derivado de lo que leyó) frente a una importación simultánea: prevalece el precio actual del disco', async () => {
  const f = await seed();
  writeCatalog(dir, [{ ...f, gallery: ['https://img.invalid/g1.jpg'] }]);
  const gate = deferred();
  const restore = mockFetch(async () => { await gate.promise; return new Response('', { status: 200, headers: { 'content-length': '999999' } }); });
  try {
    const pending = enrichRoute.POST({ request: apiRequest('/api/admin/enrich-bulk', { cookie, body: { ids: [f.id] } }) });
    await tick(30);
    sync([jsonRecord(1, { gtin: GTIN, price: 9, capturedAt: '2026-10-09T10:00:00Z' })]);
    gate.resolve();
    await pending;
    assert.equal(byId(f.id).price, 9, 'protectIfChanged: el precio es de otra fuente y cambió mientras esperaba');
  } finally { restore(); }
});

/* ───────────────── Eliminar mientras una tarea lenta espera ───────────────── */

const assertGone = (f, label) => {
  assert.equal(readCatalog(dir).some((p) => p.id === f.id), false, `${label}: la ficha eliminada NO se recrea`);
  assert.equal(readCatalog(dir).length, 0, `${label}: el catálogo sigue vacío`);
};
const pageFetch = (gate) => mockFetch(async () => { await gate.promise; return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }); });

test('products/add (editar) lento + ficha eliminada durante la espera: no se recrea', async () => {
  const f = await seed();
  const gate = deferred();
  const restore = pageFetch(gate);
  try {
    const pending = addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'save', product: { ...f, title: 'Editada mientras se borraba' } } }) });
    await tick(30);
    assert.equal((await panelDelete(f.id)).status, 200);
    gate.resolve();
    const res = await jsonOf(await pending);
    assert.equal(res.success, false);
    assert.equal(res.deleted, true);
    assertGone(f, 'products/add');
  } finally { restore(); }
});

test('add-product (editar) lento + ficha eliminada durante la espera: no se recrea', async () => {
  const f = await seed();
  const gate = deferred();
  const restore = pageFetch(gate);
  try {
    const pending = addProductRoute.POST({ request: apiRequest('/api/admin/add-product', { cookie, body: { id: f.id, title: f.title, affiliateUrl: f.affiliateUrl, price: f.price, category: 'Audio', options: { text: false, image: false, save: true } } }) });
    await tick(30);
    await panelDelete(f.id);
    gate.resolve();
    const res = await jsonOf(await pending);
    assert.equal(res.success, false);
    assert.equal(res.deleted, true);
    assertGone(f, 'add-product');
  } finally { restore(); }
});

test('add-product (ALTA) lento cuya identidad se elimina durante la espera: no se crea', async () => {
  reset();
  const gate = deferred();
  const restore = pageFetch(gate);
  try {
    const pending = addProductRoute.POST({ request: apiRequest('/api/admin/add-product', { cookie, body: { title: 'Producto nuevo distinto de prueba', affiliateUrl: 'https://tienda.invalid/z/77', sourceId: 'Z77', network: 'tienda', price: 12, image: 'https://img.invalid/n.jpg', category: 'Audio', options: { text: false, image: false, save: true } } }) });
    await tick(30);
    // mientras tanto alguien importa ese mismo producto y lo elimina
    sync([jsonRecord(77, { externalId: 'Z77', url: 'https://tienda.invalid/z/77' })]);
    deleteSync(readCatalog(dir)[0].id);
    gate.resolve();
    const res = await jsonOf(await pending);
    assert.equal(res.success, false);
    assert.equal(res.deleted, true);
    assert.equal(readCatalog(dir).length, 0);
  } finally { restore(); }
});

test('enrich-bulk lento + ficha eliminada durante la espera: no se recrea', async () => {
  const f = await seed();
  writeCatalog(dir, [{ ...f, gallery: ['https://img.invalid/g1.jpg'] }]);
  const gate = deferred();
  const restore = mockFetch(async () => { await gate.promise; return new Response('', { status: 200, headers: { 'content-length': '999999' } }); });
  try {
    const pending = enrichRoute.POST({ request: apiRequest('/api/admin/enrich-bulk', { cookie, body: { ids: [f.id] } }) });
    await tick(30);
    deleteSync(f.id);
    gate.resolve();
    const res = await jsonOf(await pending);
    assert.notEqual(res.failed, 0, JSON.stringify(res).slice(0, 200));
    assertGone(f, 'enrich-bulk');
  } finally { restore(); }
});

test('opencode-command con LLM lento + ficha eliminada durante la espera: no se recrea', async () => {
  const f = await seed();
  process.env.OPENAI_API_KEY = 'clave-de-prueba-no-valida';
  process.env.TEXT_AI_PROVIDER = 'openai';
  const gate = deferred();
  const actions = { actions: [{ type: 'assign_categories', params: { categoryMap: { [f.id]: 'Hogar' } }, description: 'x' }], summary: 's' };
  const restore = mockFetch(async () => { await gate.promise; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(actions) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); });
  try {
    const pending = opencodeRoute.POST({ request: apiRequest('/api/v1/admin/opencode-command', { cookie, body: { prompt: 'x', productIds: [f.id], context: 'selected' } }) });
    await tick(30);
    deleteSync(f.id);
    gate.resolve();
    await pending;
    assertGone(f, 'opencode-command');
  } finally { restore(); delete process.env.OPENAI_API_KEY; delete process.env.TEXT_AI_PROVIDER; }
});

test('API v1 (pipeline) con IA lenta + ficha eliminada durante la espera: no se recrea', async () => {
  const f = await seed();
  process.env.OPENAI_API_KEY = 'clave-de-prueba-no-valida';
  process.env.TEXT_AI_PROVIDER = 'openai';
  const gate = deferred();
  const restore = mockFetch(async () => { await gate.promise; return new Response(JSON.stringify({ error: 'simulado' }), { status: 500, headers: { 'content-type': 'application/json' } }); });
  try {
    const pending = pipelineRoute.POST({ request: apiRequest('/api/v1/products/import', { token: true, body: { id: f.id, title: f.title, affiliateUrl: f.affiliateUrl, price: f.price, sourceId: f.sourceId, description: 'd', category: 'Audio' } }) });
    await tick(30);
    deleteSync(f.id);
    gate.resolve();
    const res = await jsonOf(await pending);
    assert.equal(res.results[0].ok, false);
    assertGone(f, 'pipeline v1');
  } finally { restore(); delete process.env.OPENAI_API_KEY; delete process.env.TEXT_AI_PROVIDER; }
});

test('Amazon import-json con IA lenta + ficha eliminada durante la espera: no se recrea', async () => {
  reset();
  sync([jsonRecord(1, { platform: 'amazon', externalId: 'B0CONFL001', url: 'https://www.amazon.es/dp/B0CONFL001' })]);
  const f = readCatalog(dir)[0];
  process.env.OPENAI_API_KEY = 'clave-de-prueba-no-valida';
  process.env.TEXT_AI_PROVIDER = 'openai';
  const gate = deferred();
  const restore = mockFetch(async () => { await gate.promise; return new Response(JSON.stringify({ error: 'simulado' }), { status: 500, headers: { 'content-type': 'application/json' } }); });
  try {
    const pending = amazonRoute.POST({ request: apiRequest('/api/admin/amazon/import-json', { cookie, body: { asin: 'B0CONFL001', raw: { asin: 'B0CONFL001', name: 'Altavoz (reimport)', pricing: '24,99 €', images: ['https://img.invalid/z1.jpg'] }, options: { save: true } } }) });
    await tick(30);
    deleteSync(f.id);
    gate.resolve();
    const res = await jsonOf(await pending);
    assert.equal(res.success, false, JSON.stringify(res).slice(0, 200));
    assertGone(f, 'amazon import-json');
  } finally { restore(); delete process.env.OPENAI_API_KEY; delete process.env.TEXT_AI_PROVIDER; }
});

test('Construir Catálogo + ficha eliminada durante la construcción: no se recrea (ni se crea una equivalente nueva)', async () => {
  reset();
  const url = 'https://tienda.invalid/bc/1';
  const group = { canonical: { network: 'tienda', externalId: 'BC1', affiliateUrl: url, directUrl: url, title: 'Producto build catalog uno', description: 'd', price: 10, originalPrice: 12, currency: 'EUR', discountPercentage: 0, inStock: true, commissionRate: 0, estimatedCommission: 0, category: 'Audio', brand: 'Marca', merchantName: 'Tienda', rating: 4, reviewCount: 10, mainImage: 'https://img.invalid/bc.jpg', extraImages: [] }, variants: [], bestPrice: 10, bestOriginalPrice: 12, bestCommissionRate: 0, bestCommissionAmount: 0, bestRating: 4, bestSales: 0, allNetworks: ['tienda'], allAffiliateUrls: { tienda: url }, allDirectUrls: { tienda: url }, allMerchantNames: { tienda: 'Tienda' }, allExtraImages: [], allPrices: { tienda: 10 }, allOriginalPrices: { tienda: 12 }, allCurrencies: { tienda: 'EUR' }, category: 'Audio', isHSR: false, hsrScore: 0 };
  await buildRoute.buildAndUpsertProducts([group], false, false);
  const f = readCatalog(dir)[0];
  await buildRoute.buildAndUpsertProducts([{ ...group, bestPrice: 8 }], false, false, { onProgress: () => deleteSync(f.id) });
  assertGone(f, 'build-catalog (existente)');
  // ficha NUEVA cuya identidad se elimina mientras se construye
  reset();
  sync([jsonRecord(5, { externalId: 'BC9', url: 'https://tienda.invalid/bc/9', platform: 'tienda' })]);
  const g9 = { ...group, canonical: { ...group.canonical, externalId: 'BC9', affiliateUrl: 'https://tienda.invalid/bc/9', directUrl: 'https://tienda.invalid/bc/9', title: 'Producto nuevo nueve' }, allAffiliateUrls: { tienda: 'https://tienda.invalid/bc/9' }, allDirectUrls: { tienda: 'https://tienda.invalid/bc/9' } };
  const existing = readCatalog(dir)[0];
  const out = await buildRoute.buildAndUpsertProducts([g9], false, false, { onProgress: () => deleteSync(existing.id) });
  assert.equal(readCatalog(dir).length, 0, 'no se crea una ficha equivalente a la eliminada: ' + JSON.stringify(out));
});

test('Actualización de ofertas (offerRefresh) + ficha eliminada durante la consulta a la red: no se recrea', async () => {
  reset();
  sync([jsonRecord(1, { platform: 'amazon', externalId: 'B0CONFL002', url: 'https://www.amazon.es/dp/B0CONFL002' })]);
  const f = readCatalog(dir)[0];
  const adapter = {
    id: 'fake', networks: ['amazon'], resolveSource: (p) => ({ type: 'asin', id: p.asin }),
    fetch: async () => { deleteSync(f.id); return { price: 25, currency: 'EUR', inStock: true, shippingCost: 0, identity: { sourceId: 'B0CONFL002' } }; },
  };
  await refreshOffers({ ids: [f.id], adapters: [adapter], sleep: async () => {}, evaluateAlerts: false, baseDelayMs: 0, runId: 'cf-r' });
  assertGone(f, 'offerRefresh');
});

test('UNA OFERTA eliminada durante una tarea lenta no vuelve (enrich-bulk y products/add) y no se puede reimportar', async () => {
  const f = await seed();
  sync([OTRA(), TERCERA()]);
  const otraKey = byId(f.id).extra.offers.find((o) => o.platform === 'otra').offerKey;
  const gate = deferred();
  const restore = pageFetch(gate);
  try {
    const pending = addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'save', product: { ...byId(f.id), title: 'Edición lenta' } } }) });
    await tick(30);
    assert.equal(identity.deleteOffer(f.id, otraKey).ok, true);
    gate.resolve();
    assert.equal((await jsonOf(await pending)).success, true);
    const after = byId(f.id);
    assert.deepEqual(after.extra.offers.map((o) => o.platform), ['tercera'], 'la oferta eliminada no vuelve con la instantánea antigua');
    assert.equal(after.title, 'Edición lenta');
    assert.equal(sync([OTRA({ capturedAt: '2026-10-12T10:00:00Z' })]).results[0].reasons[0], 'oferta_eliminada_anteriormente');
  } finally { restore(); }
});

// REGRESIÓN (antes `todo`): el volcado asíncrono del histórico resucitaba fichas eliminadas.
test('REGRESIÓN · flushPriceHistory con una ficha eliminada mientras se vuelca (o antes): NO la resucita', async () => {
  const f = await seed();
  history.recordPricePoint(f.id, f.price);
  const flushing = history.flushPriceHistory();
  deleteSync(f.id); // justo después de lanzar el volcado (con el código antiguo, éste ya estaba esperando a escribir)
  await flushing;
  assert.equal(readCatalog(dir).some((p) => p.id === f.id), false, 'la ficha eliminada no reaparece');
  // punto en cola de una ficha ya eliminada: se descarta, no se recrea
  const g = await seed();
  history.recordPricePoint(g.id, g.price);
  deleteSync(g.id);
  await history.flushPriceHistory();
  assert.equal(readCatalog(dir).length, 0);
});

test('contrato: commitOwnChanges devuelve «skipped» (y no escribe) si la ficha leída ya no existe; inserta si era un alta', () => {
  reset();
  const ficha = { id: 'x', title: 'X', description: '', price: 1, image: 'i', category: 'c', merchant: 'm', affiliateUrl: 'u', pros: [], cons: [] };
  const skipped = store.commitOwnChanges({ id: 'x', base: ficha, ours: { ...ficha, title: 'Y' } });
  assert.equal(skipped.skipped, 'eliminada_durante_la_operacion');
  assert.equal(readCatalog(dir).length, 0);
  const created = store.commitOwnChanges({ id: 'x', ours: ficha });
  assert.equal(created.updated, false);
  assert.equal(readCatalog(dir).length, 1);
  void catalogOffers;
});
