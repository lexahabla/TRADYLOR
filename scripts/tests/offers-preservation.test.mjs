// Regresión: `extra.offers` (y observaciones/campos bloqueados) se conservan en importación,
// reimportación, edición, enriquecimiento y en los DEMÁS procesos que guardan fichas completas.
// Servicios externos simulados: sin red, sin claves, sin créditos; datos aislados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedData, adminCookie, apiRequest, jsonOf, mockFetch, readCatalog, writeCatalog, jsonRecord, importRecords, GTIN } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-offers-');
const cookie = await adminCookie();
const importer = await import('../../src/lib/jsonImport/service.ts');
const addRoute = await import('../../src/pages/api/products/add.ts');
const addProductRoute = await import('../../src/pages/api/admin/add-product.ts');
const enrichRoute = await import('../../src/pages/api/admin/enrich-bulk.ts');
const pipelineRoute = await import('../../src/pages/api/v1/products/import.ts');
const curationRoute = await import('../../src/pages/api/products/curation.ts');
const variantRoute = await import('../../src/pages/api/admin/products/variant-group.ts');
const migrateRoute = await import('../../src/pages/api/admin/migrate-categories.ts');
const amazonRoute = await import('../../src/pages/api/admin/amazon/import-json.ts');
const opencodeRoute = await import('../../src/pages/api/v1/admin/opencode-command.ts');
const buildRoute = await import('../../src/pages/api/v1/products/build-catalog.ts');
const storeModule = await import('../../src/lib/productStore.ts');
const curation = await import('../../src/lib/curation.ts');
globalThis.require = (spec) => (String(spec).endsWith('curation') ? curation : storeModule); // ver deleted-identity.test.mjs
const { MassCatalogPipeline } = await import('../../src/lib/services/massCatalogPipeline.ts');

const sync = (records, defaults = { category: 'Audio' }) =>
  importer.processChunk({ batchId: 'off-' + Math.random().toString(36).slice(2, 9), records, defaults, dryRun: false, indexOffset: 0 });
const ficha = () => readCatalog(dir)[0];
const offersJson = (p) => JSON.stringify(p?.extra?.offers ?? null);

/** Ficha con la oferta principal + 2 ofertas adicionales + estado «enriquecido/editado». */
async function seed(extraFields = {}) {
  writeCatalog(dir, []);
  await importRecords([jsonRecord(1, { gtin: GTIN, platform: 'amazon', externalId: 'B0OFFERS01', url: 'https://www.amazon.es/dp/B0OFFERS01' })]);
  await importRecords([jsonRecord(1, { gtin: GTIN, platform: 'otra', externalId: 'OTRA-1', url: 'https://otra.invalid/p/o1', sellerName: 'OtraShop', price: 28 })]);
  await importRecords([jsonRecord(1, { gtin: GTIN, platform: 'tercera', externalId: 'TER-1', url: 'https://tercera.invalid/p/t1', price: 27 })]);
  const f = ficha();
  assert.equal(f.extra.offers.length, 2);
  writeCatalog(dir, [{
    ...f, description: 'Descripción enriquecida con IA', ai_enriched: true, ia_status: 'completed', verdict: 'Veredicto propio', pros: ['Buen sonido'],
    extra: { ...f.extra, lockedFields: ['verdict'], observations: [{ price: 31, capturedAt: '2026-10-01T00:00:00Z' }] },
    ...extraFields,
  }]);
  return ficha();
}

function assertIntact(before, label) {
  const after = readCatalog(dir).find((p) => p.id === before.id);
  assert.ok(after, `${label}: la ficha sigue en el catálogo`);
  assert.equal(offersJson(after), offersJson(before), `${label}: extra.offers intacto`);
  assert.equal(JSON.stringify(after.extra.observations), JSON.stringify(before.extra.observations), `${label}: observaciones intactas`);
  return after;
}

const noNetwork = () => mockFetch(async () => new Response('', { status: 404 }));

test('importación JSON: reimportar las tres ofertas actualiza precios sin duplicar ni perder ninguna', async () => {
  const before = await seed();
  const out = sync([
    jsonRecord(1, { gtin: GTIN, platform: 'amazon', externalId: 'B0OFFERS01', url: 'https://www.amazon.es/dp/B0OFFERS01', price: 25, capturedAt: '2026-10-07T10:00:00Z' }),
    jsonRecord(1, { gtin: GTIN, platform: 'otra', externalId: 'OTRA-1', url: 'https://otra.invalid/p/o1', sellerName: 'OtraShop', price: 24, capturedAt: '2026-10-07T10:00:00Z' }),
  ]);
  assert.deepEqual(out.results.map((r) => r.outcome), ['updated', 'updated']);
  const after = ficha();
  assert.equal(after.extra.offers.length, 2);
  assert.equal(after.extra.offers.find((o) => o.platform === 'otra').price, 24);
  assert.equal(after.extra.offers.find((o) => o.platform === 'tercera').price, 27, 'la oferta no reimportada no cambia');
  assert.equal(after.price, 25);
  assert.equal(after.description, before.description, 'enriquecimiento intacto');
  assert.equal(after.verdict, 'Veredicto propio');
});

test('edición manual (add-product y products/add) conserva extra.offers', async () => {
  const before = await seed();
  const restore = noNetwork();
  try {
    const r1 = await jsonOf(await addProductRoute.POST({ request: apiRequest('/api/admin/add-product', { cookie, body: { id: before.id, title: before.title + ' (editado)', affiliateUrl: before.affiliateUrl, price: before.price, brand: 'Zeta', category: 'Audio', options: { text: false, image: false, save: true } } }) }));
    assert.equal(r1.success, true);
    assertIntact(before, 'add-product');
    const { extra: _e, ...panel } = ficha();
    const r2 = await jsonOf(await addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'save', product: { ...panel, title: 'Título desde el panel' } } }) }));
    assert.equal(r2.success, true);
    assert.equal(assertIntact(before, 'products/add').title, 'Título desde el panel');
    const r3 = await jsonOf(await addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'save', product: { ...panel, extra: { 'Campo propio': 'valor' } } } }) }));
    assert.equal(r3.success, true);
    assert.equal(assertIntact(before, 'products/add con extra').extra['Campo propio'], 'valor');
    await addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'set-category', ids: [before.id], category: 'Hogar' } }) });
    await addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'set-badge', ids: [before.id], badge: 'Top' } }) });
    assertIntact(before, 'set-category/set-badge');
  } finally { restore(); }
});

test('enriquecimiento (enrich-bulk) conserva extra.offers y sólo cambia texto/tags', async () => {
  const before = await seed();
  const restore = noNetwork();
  try {
    const res = await jsonOf(await enrichRoute.POST({ request: apiRequest('/api/admin/enrich-bulk', { cookie, body: { ids: [before.id] } }) }));
    assert.equal(res.success, true);
    const after = assertIntact(before, 'enrich-bulk');
    assert.ok(after.normalized_tags, 'el enriquecimiento sí se aplicó');
  } finally { restore(); }
});

test('API v1 (pipeline), curation, variantes y reclasificación conservan extra.offers', async () => {
  const before = await seed();
  const restore = noNetwork();
  try {
    const api = await jsonOf(await pipelineRoute.POST({ request: apiRequest('/api/v1/products/import', { token: true, body: { id: before.id, title: before.title, affiliateUrl: before.affiliateUrl, price: before.price, sourceId: before.sourceId, description: 'x', category: 'Audio' } }) }));
    assert.equal(api.results[0].ok, true);
    assertIntact(before, 'API v1');
    for (const body of [{ action: 'set-status', ids: [before.id], ia_status: 'completed' }, { action: 'recalc' }]) {
      await curationRoute.POST({ request: apiRequest('/api/products/curation', { cookie, body }) });
    }
    assertIntact(before, 'curation');
    writeCatalog(dir, [...readCatalog(dir), { ...ficha(), id: before.id + '-2', title: 'otra variante', sourceId: 'zzz', affiliateUrl: 'https://z.invalid/2', extra: {} }]);
    await variantRoute.POST({ request: apiRequest('/api/admin/products/variant-group', { cookie, body: { variantGroup: 'grp', productIds: [before.id, before.id + '-2'], featureById: { [before.id]: '1', [before.id + '-2']: '2' } } }) });
    assertIntact(before, 'variant-group');
    await migrateRoute.POST({ request: apiRequest('/api/admin/migrate-categories', { cookie, body: {} }) });
    assertIntact(before, 'migrate-categories');
  } finally { restore(); }
});

test('Amazon (import-json por ASIN, mergeReimport) conserva extra.offers', async () => {
  const before = await seed();
  const restore = noNetwork();
  try {
    const res = await jsonOf(await amazonRoute.POST({ request: apiRequest('/api/admin/amazon/import-json', { cookie, body: { asin: 'B0OFFERS01', raw: { asin: 'B0OFFERS01', name: 'Altavoz (reimport)', pricing: '24,99 €', images: ['https://img.invalid/z1.jpg'] }, options: { save: true } } }) }));
    assert.equal(res.success, true, JSON.stringify(res).slice(0, 200));
    assert.equal(readCatalog(dir).length, 1, 'no se duplica la ficha');
    assertIntact(before, 'amazon/import-json');
  } finally { restore(); }
});

test('opencode-command (recategorizar y enriquecer) conserva extra.offers', async () => {
  const before = await seed();
  process.env.OPENAI_API_KEY = 'clave-de-prueba-no-valida';
  process.env.TEXT_AI_PROVIDER = 'openai';
  const actions = { actions: [{ type: 'assign_categories', params: { categoryMap: { [before.id]: 'Hogar' } }, description: 'x' }, { type: 'review_prices', params: { thresholdPercent: 1, action: 'adjust' }, description: 'y' }], summary: 's' };
  const restore = mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(actions) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    const res = await jsonOf(await opencodeRoute.POST({ request: apiRequest('/api/v1/admin/opencode-command', { cookie, body: { prompt: 'x', productIds: [before.id], context: 'selected' } }) }));
    assert.equal(res.success, true, JSON.stringify(res).slice(0, 200));
    assert.equal(assertIntact(before, 'opencode-command').category, 'Hogar');
  } finally { restore(); delete process.env.OPENAI_API_KEY; delete process.env.TEXT_AI_PROVIDER; }
});

test('Construir Catálogo y auto-curación (MassCatalogPipeline) conservan extra.offers de la ficha existente', async () => {
  writeCatalog(dir, []);
  const url = 'https://tienda.invalid/bc/9';
  const group = { canonical: { network: 'tienda', externalId: 'BC9', affiliateUrl: url, directUrl: url, title: 'Producto build catalog nueve', description: 'd', price: 10, originalPrice: 12, currency: 'EUR', discountPercentage: 0, inStock: true, commissionRate: 0, estimatedCommission: 0, category: 'Audio', brand: 'Marca', merchantName: 'Tienda', rating: 4, reviewCount: 10, mainImage: 'https://img.invalid/bc.jpg', extraImages: [] }, variants: [], bestPrice: 10, bestOriginalPrice: 12, bestCommissionRate: 0, bestCommissionAmount: 0, bestRating: 4, bestSales: 0, allNetworks: ['tienda'], allAffiliateUrls: { tienda: url }, allDirectUrls: { tienda: url }, allMerchantNames: { tienda: 'Tienda' }, allExtraImages: [], allPrices: { tienda: 10 }, allOriginalPrices: { tienda: 12 }, allCurrencies: { tienda: 'EUR' }, category: 'Audio', isHSR: false, hsrScore: 0 };
  await buildRoute.buildAndUpsertProducts([group], false, false);
  const built = ficha();
  const offers = [{ offerId: 'o1', offerKey: 'otra:x', platform: 'otra' }];
  writeCatalog(dir, [{ ...built, extra: { ...(built.extra ?? {}), offers } }]);
  await buildRoute.buildAndUpsertProducts([{ ...group, bestPrice: 8 }], false, false);
  assert.equal(offersJson(ficha()), JSON.stringify(offers), 'Construir Catálogo');

  writeCatalog(dir, []);
  const pipeline = new MassCatalogPipeline({ network: 'tienda', useAI: false, scrapePages: false, autoLinkAlternatives: false });
  const raw = { id: 'raw-1', network: 'tienda', externalId: 'AC1', capturedAt: new Date().toISOString(), processed: false, rawPayload: { ...group.canonical, externalId: 'AC1', affiliateUrl: 'https://tienda.invalid/ac/1', directUrl: 'https://tienda.invalid/ac/1', title: 'Producto auto curado uno' } };
  assert.equal((await pipeline.processSingleRaw(raw)).success, true);
  writeCatalog(dir, [{ ...ficha(), extra: { ...(ficha().extra ?? {}), offers } }]);
  assert.equal((await pipeline.processSingleRaw({ ...raw, processed: false })).success, true);
  assert.equal(offersJson(ficha()), JSON.stringify(offers), 'auto-curación');
});
