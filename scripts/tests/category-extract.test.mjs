// Extracción de categoría de Amazon con Apify (actor junglee/Amazon-crawler): validación, límites TRANSMITIDOS al actor,
// ejecución asíncrona idempotente, cancelación, resultados parciales, errores saneados y adaptación al importador JSON.
// Apify SIMULADO (ninguna prueba sale a Internet ni gasta créditos). La prueba real controlada se hizo aparte.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, readCatalog, apiRequest, jsonOf, mockFetch, importRecords } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-apify-');
const TOKEN = 'apify_api_TOKEN-SECRETO-DE-PRUEBA-0123456789';
process.env.APIFY_TOKEN = TOKEN;
// Un destino ajeno en APIFY_API_BASE se IGNORA (el token nunca viaja fuera de api.apify.com): el simulador de abajo
// rechaza cualquier petición que no vaya a api.apify.com.
process.env.APIFY_API_BASE = 'https://evil.example.com/v2';
for (const k of ['APIFY_MAX_ITEMS', 'APIFY_PROXY_COUNTRY', 'APIFY_LANGUAGE', 'APIFY_MAX_RUNS_PER_DAY']) delete process.env[k];

const lib = await import('../../src/lib/apify/categoryExtraction.ts');
const adapter = await import('../../src/lib/jsonImport/apifyAmazon.ts');
const { resolveCategoryIn } = await import('../../src/lib/jsonImport/categoryResolver.ts');
const route = await import('../../src/pages/api/admin/category-extract/index.ts');
const { getCategories } = await import('../../src/lib/categories.ts');

const CAT_URL = 'https://www.amazon.es/gp/browse.html?node=938008031&ref_=nav_em__lap_0_2_14_2';
const jobsFile = path.join(dir, 'category-extractions.json');
const resetJobs = () => { fs.rmSync(jobsFile, { force: true }); fs.rmSync(path.join(dir, 'category-extractions'), { recursive: true, force: true }); };

// Parámetros de ENTRADA reales del actor (build 0.0.448 consultado el 6-nov-2026): no se admiten nombres inventados.
const SCHEMA_KEYS = ['categoryOrProductUrls', 'maxItemsPerStartUrl', 'language', 'proxyCountry', 'maxSearchPagesPerStartUrl', 'maxProductVariantsAsSeparateResults', 'maxOffers', 'scrapeSellers', 'useCaptchaSolver', 'scrapeProductVariantPrices', 'scrapeProductDetails', 'countryCode', 'zipCode', 'locationDeliverableRoutes'];

/* ───────────── Fixtures con la estructura real del dataset de Apify ───────────── */
const item = (over = {}) => ({
  asin: 'B0HKJWM6DF',
  highResolutionImages: ['https://m.media-amazon.com/images/I/71IEYqnWRDL._AC_SL1500_.jpg', 'https://m.media-amazon.com/images/I/61RCeI62aLL._AC_SL1500_.jpg'],
  thumbnailImage: 'https://m.media-amazon.com/images/I/71IEYqnWRDL._AC_SY300_SX300_QL70_ML2_.jpg',
  aPlusContent: { rawImages: [{ url: 'https://m.media-amazon.com/images/S/aplus-media-library-service-media/db7405bd.__CR0,0,1464,600_PT0_SX1464_V1___.png' }] },
  brandStory: { image: { url: 'https://m.media-amazon.com/images/S/aplus-media-library-service-media/d60f4e0c.jpg' } },
  attributes: [{ key: 'RAM Memory Installed', value: '16 GB' }, { key: 'Hard-Drive Size', value: '1 TB' }, { key: 'CPU Model Number', value: 'i5-13420H' }, { key: 'Screen Size', value: '15.3 Inches' }, { key: 'Model Number', value: '83K1015XSP' }, { key: 'ASIN', value: 'B0HKJWM6DF' }],
  brand: 'Lenovo',
  breadCrumbs: 'Computers > Laptops > Traditional Laptops',
  condition: null,
  features: ['Powerful performance with Intel Core i5-13420H processor, 16 GB DDR5 and 1 TB PCIe 4.0 SSD'],
  inStock: true,
  inStockText: 'In stock',
  listPrice: null,
  offers: [],
  price: { value: 689, currency: '€' },
  productOverview: [{ key: 'Brand Name', value: 'Lenovo' }, { key: 'Colour', value: 'Grey moon' }],
  reviewsCount: 12,
  seller: { id: null, url: 'https://www.amazon.com', name: 'Amazon', businessName: 'Amazon.com, Inc.', phone: '1-206-266-1000', address: ['410 Terry Ave N', 'Seattle'] },
  shippingPrice: null,
  stars: 4.5,
  title: 'Lenovo IdeaPad Slim 3, 15.3", IPS, i5-13420H, 16GB RAM, 1TB SSD, W11',
  url: 'https://www.amazon.es/dp/B0HKJWM6DF',
  variantAsins: [],
  variantAttributes: [],
  variantDetails: [],
  ...over,
});

const macbook = () => item({
  asin: 'B0GR1SB84G', url: 'https://www.amazon.es/dp/B0GR1SB84G', brand: 'Apple', breadCrumbs: '',
  title: 'Apple MacBook Air 13.6-inch with M5 Chip, 10-core CPU, 16GB Unified Memory, 512GB SSD, Midnight',
  price: { value: 1329, currency: '€' }, listPrice: { value: 1429, currency: '€' },
  attributes: [], productOverview: [{ key: 'RAM Memory Installed', value: '16 GB' }, { key: 'Screen Size', value: '13.6 Inches' }, { key: 'Colour', value: 'Midnight' }],
  variantAsins: ['B0GR1SB84G', 'B0GR19K97B'],
  variantAttributes: [{ key: 'Style Name', value: '16GB RAM' }, { key: 'Size Name', value: '512GB' }, { key: 'Colour Name', value: 'Midnight' }],
  variantDetails: [
    { name: '16GB RAM 512GB Midnight', asin: 'B0GR1SB84G', price: null, images: ['https://m.media-amazon.com/images/I/71APX2UPTVL._AC_SL1500_.jpg'] },
    { name: '16GB RAM 512GB Silver', asin: 'B0GR19K97B', price: null, images: ['https://m.media-amazon.com/images/I/71Nv1YhnAFL._AC_SL1500_.jpg'] },
  ],
  highResolutionImages: ['https://m.media-amazon.com/images/I/71APX2UPTVL._AC_SL1500_.jpg'],
});

/** Discrepancia título (SER3/3500U/256 GB) frente a atributos (SER5/5560U/1 TB). */
const contradictory = () => item({
  asin: 'B0MINIPC01', url: 'https://www.amazon.es/dp/B0MINIPC01', brand: 'Minisforum', breadCrumbs: 'Computers > Desktops',
  title: 'Mini PC Ryzen 5 3500U SER3 16GB RAM 256GB SSD Windows 11',
  attributes: [{ key: 'CPU Model Number', value: 'Ryzen 5 5560U' }, { key: 'RAM Memory Installed', value: '16 GB' }, { key: 'Hard-Drive Size', value: '1 TB' }],
  productOverview: [], price: { value: 299, currency: '€' },
});

/* ───────────── Validación y entrada del actor ───────────── */

test('URL de categoría: sólo Amazon, https, categoría/búsqueda/más vendidos; rechaza productos y destinos ajenos', () => {
  for (const ok of [CAT_URL, 'https://www.amazon.es/s?k=teclado', 'https://www.amazon.es/b?node=938008031', 'https://www.amazon.es/gp/bestsellers/computers/938008031', 'https://www.amazon.es/-/en/gp/bestsellers/computers/ref=pd_zg_ts_computers']) {
    assert.doesNotThrow(() => lib.validateCategoryUrl(ok), ok);
  }
  for (const bad of ['', 'amazon.es/s?k=a', 'http://www.amazon.es/s?k=a', 'https://evil.example/s?k=a', 'https://www.amazon.es.evil.example/s?k=a', 'https://user:pw@www.amazon.es/s?k=a', 'javascript:alert(1)', 'https://www.amazon.es/dp/B01EXDG2MO', 'https://www.amazon.es/Algo/dp/B01EXDG2MO/ref=x', 'https://www.amazon.es/', 'https://www.amazon.es/' + 'a'.repeat(2100)]) {
    assert.throws(() => lib.validateCategoryUrl(bad), (e) => e instanceof lib.ExtractionError, String(bad).slice(0, 60));
  }
});

test('límite: entero entre 1 y el máximo; 0, negativos, decimales, texto y excesos se rechazan; 10 por defecto', () => {
  assert.equal(lib.validateLimit(10), 10);
  assert.equal(lib.validateLimit('25'), 25);
  assert.equal(lib.validateLimit(50), 50);
  for (const bad of [0, -1, 1.5, 51, 100000, 'abc', '', null, NaN, Infinity, undefined]) assert.throws(() => lib.validateLimit(bad), lib.ExtractionError, String(bad));
  assert.equal(lib.extractionConfig().defaultLimit, 10);
  process.env.APIFY_MAX_ITEMS = '20';
  assert.throws(() => lib.validateLimit(21), /máximo de productos permitido es 20/);
  delete process.env.APIFY_MAX_ITEMS;
});

test('la entrada del actor usa SÓLO parámetros de su esquema real y TRANSMITE el límite (nunca 0 ni countryCode/zipCode)', () => {
  const input = lib.buildActorInput(CAT_URL, 10);
  for (const key of Object.keys(input)) assert.ok(SCHEMA_KEYS.includes(key), 'parámetro inventado: ' + key);
  assert.deepEqual(input.categoryOrProductUrls, [{ url: CAT_URL }]);
  assert.equal(input.maxItemsPerStartUrl, 10);
  assert.ok(input.maxSearchPagesPerStartUrl >= 1 && input.maxSearchPagesPerStartUrl <= 10);
  assert.equal(input.maxOffers, 0);
  assert.equal(input.scrapeSellers, true);
  assert.equal('countryCode' in input || 'zipCode' in input, false, 'deliveryLocation cobra 0,06 USD por resultado');
  // Idioma: «es» (valor del enum del actor, admitido por amazon.es) por defecto; no se toca ni el dominio ni el mercado (sin proxyCountry/countryCode)
  assert.equal(input.language, 'es');
  assert.equal('proxyCountry' in input, false, 'el mercado lo decide el dominio (amazon.es → EUR)');
  assert.ok(['cs', 'da', 'de', 'en', 'es', 'fr', 'nl', 'pl', 'pt', 'sv', 'tr'].includes(input.language), 'valor del enum real del actor');
  assert.ok(input.categoryOrProductUrls[0].url.includes('amazon.es'));
  assert.equal(lib.buildActorInput(CAT_URL, 1).maxItemsPerStartUrl, 1);
  assert.equal(lib.buildActorInput(CAT_URL, 50).maxItemsPerStartUrl, 50);
  process.env.APIFY_PROXY_COUNTRY = 'es'; process.env.APIFY_LANGUAGE = 'es';
  const withEnv = lib.buildActorInput(CAT_URL, 10);
  assert.equal(withEnv.proxyCountry, 'ES'); assert.equal(withEnv.language, 'es');
  delete process.env.APIFY_PROXY_COUNTRY; delete process.env.APIFY_LANGUAGE;
  assert.equal(lib.maxChargeFor(10), 0.15);
  assert.ok(lib.maxChargeFor(50) <= 2 && lib.maxChargeFor(1) >= 0.05);
});

/* ───────────── Ejecución asíncrona simulada ───────────── */

function fakeApify(opts = {}) {
  const state = { calls: [], runStatus: 'RUNNING', items: [], itemCount: 0, startStatus: 200, usage: 0.075, finishedAt: '2026-11-06T18:30:00.000Z' };
  Object.assign(state, opts);
  const restore = mockFetch(async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    state.calls.push({ method, path: u.pathname, search: u.search, headers: init.headers, body: init.body });
    const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.hostname !== 'api.apify.com') throw new Error('petición inesperada fuera de Apify: ' + u.hostname);
    if (method === 'POST' && /\/v2\/actors\/[^/]+\/runs$/.test(u.pathname)) {
      if (state.startStatus !== 200) return ok({ error: { message: 'x ' + TOKEN } }, state.startStatus);
      if (state.startDelay) await new Promise((r) => setTimeout(r, state.startDelay));
      return ok({ data: { id: 'RUN123', defaultDatasetId: 'DS123', status: 'READY' } }, 201);
    }
    if (method === 'POST' && /\/v2\/actor-runs\/RUN123\/abort$/.test(u.pathname)) { state.runStatus = 'ABORTING'; return ok({ data: { status: 'ABORTING' } }); }
    if (method === 'GET' && /\/v2\/actor-runs\/RUN123$/.test(u.pathname)) return ok({ data: { id: 'RUN123', status: state.runStatus, defaultDatasetId: 'DS123', usageTotalUsd: state.usage, finishedAt: state.finishedAt, statusMessage: 'fin' } });
    if (method === 'GET' && /\/v2\/datasets\/DS123$/.test(u.pathname)) return ok({ data: { itemCount: state.itemCount } });
    if (method === 'GET' && /\/v2\/datasets\/DS123\/items$/.test(u.pathname)) return ok(state.items);
    return ok({}, 404);
  });
  return { state, restore };
}

const post = (body) => route.POST({ request: apiRequest('/api/admin/category-extract', { body, token: true }) });
const get = (qs = '') => route.GET({ request: apiRequest('/api/admin/category-extract' + qs, { method: 'GET', token: true }), url: new URL('http://localhost/api/admin/category-extract' + qs) });

test('inicio: llamada a Apify con token en cabecera (no en la URL), límite/timeout/coste en la petición y SIN guardar nada', async () => {
  resetJobs();
  const catalogBefore = fs.readFileSync(path.join(dir, 'products.json'), 'utf8');
  const f = fakeApify();
  try {
    const res = await post({ url: CAT_URL, limit: 10 });
    assert.equal(res.status, 201);
    const body = await jsonOf(res);
    assert.equal(body.job.status, 'running');
    assert.equal(body.job.runId, 'RUN123');
    const start = f.state.calls[0];
    assert.equal(start.method, 'POST');
    assert.match(start.path, /^\/v2\/actors\/junglee~amazon-crawler\/runs$/);
    assert.match(start.search, /timeout=900/);
    assert.match(start.search, /maxTotalChargeUsd=0\.15/);
    assert.doesNotMatch(start.search, new RegExp(TOKEN), 'el token no viaja en la URL');
    assert.equal(start.headers.Authorization, `Bearer ${TOKEN}`);
    const sent = JSON.parse(start.body);
    assert.equal(sent.maxItemsPerStartUrl, 10, 'el límite se transmite a Apify');
    assert.deepEqual(sent.categoryOrProductUrls, [{ url: CAT_URL }]);
    // ni el token ni el cuerpo del proveedor llegan al navegador ni al fichero de ejecuciones
    assert.doesNotMatch(JSON.stringify(body) + fs.readFileSync(jobsFile, 'utf8'), new RegExp(TOKEN));
  } finally { f.restore(); }
  assert.equal(fs.readFileSync(path.join(dir, 'products.json'), 'utf8'), catalogBefore, 'obtener datos no toca el catálogo');
});

test('doble clic / recarga / reintento: una sola ejecución; otra distinta mientras hay una activa → 409', async () => {
  resetJobs();
  const f = fakeApify({ startDelay: 30 });
  try {
    const [a, b, c] = await Promise.all([post({ url: CAT_URL, limit: 10 }), post({ url: CAT_URL, limit: 10 }), post({ url: CAT_URL, limit: 10 })]);
    const bodies = await Promise.all([a, b, c].map(jsonOf));
    assert.equal(f.state.calls.filter((x) => x.method === 'POST' && /runs$/.test(x.path)).length, 1, 'un único POST a Apify');
    assert.ok(bodies.every((x) => x.success && x.job.id === bodies[0].job.id), 'las tres peticiones devuelven la misma ejecución');
    assert.equal(bodies.filter((x) => x.reused).length, 2);
    const other = await post({ url: 'https://www.amazon.es/s?k=teclado', limit: 10 });
    assert.equal(other.status, 409);
    const diffLimit = await post({ url: CAT_URL, limit: 20 });
    assert.equal(diffLimit.status, 409);
    const config = await jsonOf(await get());
    assert.equal(config.active.id, bodies[0].job.id, 'tras recargar la página se recupera la ejecución activa');
    assert.equal(f.state.calls.filter((x) => /runs$/.test(x.path) && x.method === 'POST').length, 1);
  } finally { f.restore(); }
});

test('estado: sin esperar; mientras corre informa de los productos y el coste; al terminar adapta y devuelve los registros', async () => {
  resetJobs();
  const f = fakeApify({ itemCount: 3 });
  try {
    const { job } = await jsonOf(await post({ url: CAT_URL, limit: 10 }));
    let st = await jsonOf(await get('?id=' + job.id));
    assert.equal(st.job.status, 'running');
    assert.equal(st.job.itemsSoFar, 3);
    assert.equal(st.records, undefined);
    f.state.runStatus = 'SUCCEEDED';
    f.state.items = [item(), macbook()];
    st = await jsonOf(await get('?id=' + job.id));
    assert.equal(st.job.status, 'succeeded');
    assert.equal(st.job.costUsd, 0.075);
    assert.equal(st.records.length, 2);
    assert.equal(st.job.summary.fetched, 2);
    assert.equal(st.job.summary.partial, true, 'se pidieron 10 y llegaron 2: resultado incompleto, indicado');
    const dataset = f.state.calls.find((x) => /datasets\/DS123\/items/.test(x.path));
    assert.match(dataset.search, /limit=11/, 'sólo se lee limit+1 (para detectar excesos)');
    assert.equal(f.state.calls.filter((x) => /\/v2\/actor-runs\/RUN123$/.test(x.path)).length, 2, 'una consulta de estado por cada consulta de la interfaz');
    assert.doesNotMatch(f.state.calls.map((x) => x.search).join(''), /waitForFinish/);
    // consultar de nuevo no vuelve a pedir el dataset ni a lanzar nada
    const before = f.state.calls.length;
    const again = await jsonOf(await get('?id=' + job.id));
    assert.equal(again.records.length, 2);
    assert.equal(f.state.calls.length, before, 'resultado ya guardado: sin llamadas nuevas a Apify');
  } finally { f.restore(); }
});

test('si el actor devuelve más productos que el límite: se avisa y se conservan sólo los pedidos', async () => {
  resetJobs();
  const f = fakeApify({ runStatus: 'SUCCEEDED', items: Array.from({ length: 4 }, (_, i) => item({ asin: 'B0EXTRA00' + i, url: 'https://www.amazon.es/dp/B0EXTRA00' + i })) });
  try {
    const { job } = await jsonOf(await post({ url: CAT_URL, limit: 3 }));
    const st = await jsonOf(await get('?id=' + job.id));
    assert.equal(st.records.length, 3);
    assert.ok(st.job.summary.warnings.some((w) => /devolvio_mas_de_3/.test(w)));
  } finally { f.restore(); }
});

test('cancelar: aborta la ejecución EN APIFY y se conservan los resultados parciales; cancelar mientras se crea aborta al crearse', async () => {
  resetJobs();
  const f = fakeApify();
  try {
    const { job } = await jsonOf(await post({ url: CAT_URL, limit: 10 }));
    const res = await jsonOf(await post({ action: 'cancel', id: job.id }));
    assert.equal(res.job.status, 'aborting');
    assert.ok(f.state.calls.some((x) => x.method === 'POST' && /actor-runs\/RUN123\/abort$/.test(x.path)), 'se llamó a /abort de Apify');
    f.state.runStatus = 'ABORTED';
    f.state.items = [item(), macbook(), contradictory()];
    const st = await jsonOf(await get('?id=' + job.id));
    assert.equal(st.job.status, 'aborted');
    assert.equal(st.records.length, 3, 'los productos ya extraídos se conservan');
    assert.equal(st.job.summary.partial, true);
    // cancelar una ya terminada no hace nada
    const callsBefore = f.state.calls.length;
    await post({ action: 'cancel', id: job.id });
    assert.equal(f.state.calls.length, callsBefore);
  } finally { f.restore(); }

  resetJobs();
  const g = fakeApify({ startDelay: 60 });
  try {
    const starting = post({ url: CAT_URL, limit: 10 });
    await new Promise((r) => setTimeout(r, 10));
    const active = (await jsonOf(await get())).active;
    assert.equal(active.status, 'starting');
    await post({ action: 'cancel', id: active.id });
    await starting;
    assert.ok(g.state.calls.some((x) => /abort$/.test(x.path)), 'abortada en cuanto existió la ejecución');
  } finally { g.restore(); }
});

test('errores de Apify: token rechazado, saldo, límite de peticiones, red y fallo de ejecución; sin token ni cuerpo del proveedor', async () => {
  for (const [status, re] of [[401, /rechazó el token/], [402, /saldo|límite de uso/], [429, /demasiadas peticiones/], [500, /estado 500/]]) {
    resetJobs();
    const f = fakeApify({ startStatus: status });
    try {
      const res = await post({ url: CAT_URL, limit: 10 });
      const body = await jsonOf(res);
      assert.equal(body.success, false);
      assert.match(body.message, re);
      assert.doesNotMatch(JSON.stringify(body), new RegExp(TOKEN));
      assert.equal(body.job.status, 'failed');
      const next = await post({ url: CAT_URL, limit: 10 });
      assert.notEqual(next.status, 409, 'una ejecución fallida no bloquea la siguiente');
      resetJobs();
    } finally { f.restore(); }
  }
  resetJobs();
  const restore = mockFetch(async () => { throw new Error('ECONNRESET ' + TOKEN); });
  try {
    const body = await jsonOf(await post({ url: CAT_URL, limit: 10 }));
    assert.match(body.message, /No se pudo contactar con Apify/);
    assert.match(body.message, /comprueba en la consola de Apify/);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(TOKEN));
  } finally { restore(); }
  resetJobs();
  const f = fakeApify({ runStatus: 'FAILED' });
  try {
    const { job } = await jsonOf(await post({ url: CAT_URL, limit: 10 }));
    const st = await jsonOf(await get('?id=' + job.id));
    assert.equal(st.job.status, 'failed');
    assert.match(st.job.error, /terminó con error/);
  } finally { f.restore(); }
  resetJobs();
  const t = fakeApify({ runStatus: 'TIMED-OUT', items: [item()] });
  try {
    const { job } = await jsonOf(await post({ url: CAT_URL, limit: 10 }));
    const st = await jsonOf(await get('?id=' + job.id));
    assert.equal(st.job.status, 'timed_out');
    assert.equal(st.records.length, 1, 'resultado parcial tras el tiempo máximo');
  } finally { t.restore(); }
});

test('sin APIFY_TOKEN no se llama a Apify; entrada inválida (URL, límite) se rechaza antes; cuota diaria', async () => {
  resetJobs();
  const calls = [];
  const restore = mockFetch(async (u) => { calls.push(String(u)); return new Response('{}', { status: 200 }); });
  try {
    for (const body of [{ url: 'https://www.amazon.es/dp/B01EXDG2MO', limit: 10 }, { url: CAT_URL, limit: 0 }, { url: CAT_URL, limit: 9999 }, { url: 'https://evil.example/s?k=a', limit: 5 }]) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(calls.length, 0);
    delete process.env.APIFY_TOKEN;
    const noToken = await post({ url: CAT_URL, limit: 10 });
    assert.equal(noToken.status, 503);
    assert.equal(calls.length, 0);
    assert.equal((await jsonOf(await get())).configured, false);
    process.env.APIFY_TOKEN = TOKEN;
    process.env.APIFY_MAX_RUNS_PER_DAY = '1';
    resetJobs();
    const f = fakeApify({ runStatus: 'SUCCEEDED' });
    try {
      const first = await jsonOf(await post({ url: CAT_URL, limit: 10 }));
      await get('?id=' + first.job.id);
      const second = await post({ url: CAT_URL, limit: 10 });
      assert.equal(second.status, 429);
    } finally { f.restore(); delete process.env.APIFY_MAX_RUNS_PER_DAY; }
  } finally { restore(); process.env.APIFY_TOKEN = TOKEN; }
});

test('autenticación: sin sesión ni token → 401 en GET y POST', async () => {
  const get401 = await route.GET({ request: apiRequest('/api/admin/category-extract', { method: 'GET' }), url: new URL('http://localhost/api/admin/category-extract') });
  const post401 = await route.POST({ request: apiRequest('/api/admin/category-extract', { body: { url: CAT_URL, limit: 10 } }) });
  assert.equal(get401.status, 401);
  assert.equal(post401.status, 401);
});

/* ───────────── Adaptación al modelo del importador ───────────── */

test('adaptador: oferta principal en price + seller (offers vacío), moneda ISO, envío desconocido, sólo imágenes del producto', () => {
  const rec = adapter.adaptApifyAmazonItem(item({ listPrice: { value: 799, currency: '€' } }), { capturedAt: '2026-11-06T18:30:00.000Z' });
  assert.equal(rec.offer.platform, 'amazon');
  assert.equal(rec.offer.externalId, 'B0HKJWM6DF');
  assert.equal(rec.offer.price, 689);
  assert.equal(rec.offer.currency, 'EUR');
  assert.equal(rec.offer.originalPrice, 799);
  assert.equal(rec.offer.sellerName, 'Amazon');
  assert.equal(rec.offer.shipping, undefined, 'shippingPrice nulo = desconocido, no gratis');
  assert.equal(rec.offer.availability, true);
  assert.equal(rec.offer.capturedAt, '2026-11-06T18:30:00.000Z');
  assert.equal(rec.product.images.length, 2);
  assert.ok(rec.product.images.every((u) => !/aplus-media|brand/i.test(u)));
  assert.equal(rec.product.specs['Model Number'], '83K1015XSP');
  assert.equal(rec.product.specs.ASIN, undefined, 'ruido de página fuera de las especificaciones');
  assert.equal(rec.product.mpn, '83K1015XSP');
  assert.equal(JSON.stringify(rec).includes('Seattle'), false, 'no se copian dirección ni teléfono del vendedor');
  assert.deepEqual(rec.__import.review, []);
  // moneda: símbolo desconocido se deduce del dominio (con aviso); sin precio no se inventa
  const odd = adapter.adaptApifyAmazonItem(item({ price: { value: 10, currency: 'EUR ' } }));
  assert.equal(odd.offer.currency, 'EUR');
  const sym = adapter.adaptApifyAmazonItem(item({ price: { value: 10, currency: '¤' } }));
  assert.equal(sym.offer.currency, 'EUR');
  assert.ok(sym.__import.warnings.includes('moneda_deducida_del_dominio'));
  const noPrice = adapter.adaptApifyAmazonItem(item({ price: null }));
  assert.equal(noPrice.offer.price, undefined);
  assert.equal(adapter.adaptApifyAmazonItem(item({ shippingPrice: { value: 4.99, currency: '€' } })).offer.shipping.cost, 4.99);
  assert.equal(adapter.adaptApifyAmazonItem(item({ listPrice: { value: 500, currency: '€' } })).offer.originalPrice, undefined, 'precio anterior menor que el actual: se descarta');
});

test('variantes: las que no traen precio no se importan ni heredan el precio principal; se avisa', () => {
  const rec = adapter.adaptApifyAmazonItem(macbook());
  assert.ok(rec.__import.warnings.some((w) => /^variantes_no_importadas:1_sin_precio/.test(w)));
  assert.equal(rec.product.images.length, 1);
  assert.equal(rec.product.images[0], 'https://m.media-amazon.com/images/I/71APX2UPTVL._AC_SL1500_.jpg', 'sin imágenes de otras variantes');
  assert.equal(rec.variant.color, 'Midnight');
  assert.equal(rec.variant.capacity, '512GB');
  assert.deepEqual(rec.__import.review, [], 'título, atributos y variante coherentes: sin contradicción');
});

test('contradicciones título/atributos/variante → revisión con el motivo y sin elegir un valor', () => {
  const rec = adapter.adaptApifyAmazonItem(contradictory());
  const motives = rec.__import.review.join(' | ');
  assert.match(motives, /procesador: título 3500u ≠ atributos 5560u/);
  assert.match(motives, /almacenamiento: título 256 GB ≠ atributos 1 TB/);
  assert.equal(rec.offer.price, 299, 'no se altera ningún dato de la fuente');
  const variantClash = adapter.adaptApifyAmazonItem(item({ variantAttributes: [{ key: 'Size Name', value: '256GB' }, { key: 'Style Name', value: '8GB RAM' }] }));
  assert.match(variantClash.__import.review.join(' | '), /ram: título 16 GB ≠ variante 8 GB/);
  assert.match(variantClash.__import.review.join(' | '), /almacenamiento: título 1 TB ≠ variante 256 GB/);
});

test('categoría: sólo si una categoría raíz gana con claridad; empate o sin aciertos → vacía y se avisa', () => {
  const roots = getCategories().filter((c) => !c.parentId);
  const laptop = adapter.adaptApifyAmazonItem(item(), { resolveCategory: (t) => resolveCategoryIn(t, roots) });
  assert.ok(laptop.product.category, 'un portátil se asigna a su categoría del catálogo');
  assert.ok(roots.some((c) => c.name === laptop.product.category));
  const none = adapter.adaptApifyAmazonItem(item({ title: 'Objeto sin clasificar xyz', breadCrumbs: 'Zzz' }), { resolveCategory: (t) => resolveCategoryIn(t, roots) });
  assert.equal(none.product.category, undefined);
  assert.ok(none.__import.warnings.includes('categoria_no_determinada'));
  const tie = resolveCategoryIn('teclado altavoz', [{ id: 'a', name: 'A', keywords: ['teclado'] }, { id: 'b', name: 'B', keywords: ['altavoz'] }]);
  assert.deepEqual(tie, { ambiguous: true });
});

test('errores del actor por elemento se rechazan con su motivo', async () => {
  const out = await importRecords([{ asin: 'B0ERROR001', url: 'https://www.amazon.es/dp/B0ERROR001', highResolutionImages: [], variantDetails: [], errorDescription: 'Loaded a 404 page. The product does not exist.' }]);
  assert.equal(out.results[0].outcome, 'rejected');
  assert.ok(out.results[0].reasons.some((r) => /apify_error: Loaded a 404 page/.test(r)));
});

/* ───────────── Integración con el motor de importación ───────────── */

test('integración: el dataset crudo se importa con el motor existente (crear, revisión, sin duplicar) y conserva lo editado', async () => {
  fs.writeFileSync(path.join(dir, 'products.json'), '[]');
  const dataset = [item(), macbook(), contradictory(), item({ asin: 'B0NOCAT001', url: 'https://www.amazon.es/dp/B0NOCAT001', title: 'Objeto sin clasificar xyz', breadCrumbs: 'Zzz', attributes: [], productOverview: [] })];
  const dry = (await import('../../src/lib/jsonImport/service.ts')).processChunk({ batchId: 'apify-dry', records: dataset, defaults: {}, dryRun: true, indexOffset: 0 });
  assert.deepEqual(readCatalog(dir), [], 'simular no guarda');
  const outcomes = (r) => r.results.map((x) => x.outcome + (x.reasons.length ? ':' + x.reasons[0].slice(0, 28) : ''));
  assert.deepEqual(dry.results.map((r) => r.outcome), ['created', 'created', 'review', 'review']);

  const real = await importRecords(dataset, {});
  assert.deepEqual(real.results.map((r) => r.outcome), ['created', 'created', 'review', 'review']);
  assert.ok(real.results[2].reasons[0].startsWith('contradiccion_'), outcomes(real).join(' | '));
  assert.deepEqual(real.results[3].reasons, ['sin_categoria']);
  const catalog = readCatalog(dir);
  assert.equal(catalog.length, 2, 'las de revisión no crean ficha');
  const lenovo = catalog.find((p) => p.asin === 'b0hkjwm6df' || p.sourceId === 'B0HKJWM6DF');
  assert.equal(lenovo.price, 689);
  assert.equal(lenovo.currency, 'EUR');
  assert.equal(lenovo.merchant.toLowerCase().includes('amazon'), true);
  assert.equal(lenovo.freeShipping, undefined, 'envío desconocido ≠ gratis');
  assert.equal(lenovo.lastPriceSync, undefined, 'recibir datos no verifica el precio');
  assert.equal(lenovo.extra.priceReading.capturedAtInferred, true, 'el dataset pegado no trae fecha: se infiere y se indica');
  assert.equal(catalog.find((p) => p.title.includes('MacBook')).gallery, undefined, 'una sola imagen de producto');

  // edición manual + reimportación: sin duplicados y sin pisar lo editado
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify(catalog.map((p) => (p.id === lenovo.id ? { ...p, title: 'Título editado a mano', description: 'Descripción enriquecida' } : p))));
  const again = await importRecords(dataset, {});
  assert.deepEqual(again.results.map((r) => r.outcome), ['unchanged', 'unchanged', 'review', 'review']);
  const after = readCatalog(dir);
  assert.equal(after.length, 2);
  assert.equal(after.find((p) => p.id === lenovo.id).title, 'Título editado a mano');
  assert.equal(after.find((p) => p.id === lenovo.id).description, 'Descripción enriquecida');
});

test('la extracción nunca ejecuta IA ni toca el catálogo: el módulo no importa el motor de IA', () => {
  const src = fs.readFileSync(new URL('../../src/lib/apify/categoryExtraction.ts', import.meta.url), 'utf8') + fs.readFileSync(new URL('../../src/lib/jsonImport/apifyAmazon.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from '\.\.\/ai'|lib\/ai'|enrich|openai|anthropic/i);
  assert.doesNotMatch(src, /writeProductsToFile|productStore|updateCatalog/);
});

/* ───────────── Muestra REAL de Amazon (extracción de producción del 7-nov-2026, 10 productos, 0,04 USD; no se importó) ───────────── */

test('muestra real de Amazon (categoría de portátiles, amazon.es): 10 productos EUR adaptados sin errores ni revisión; destino aplicado en simulación', async () => {
  fs.writeFileSync(path.join(dir, 'products.json'), '[]'); // catálogo vacío: pruebas anteriores de este fichero ya importaron algunas de estas fichas
  const real = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'amazon-real-sample-es.json'), 'utf8'));
  assert.equal(real.length, 10);
  assert.ok(real.every((o) => adapter.isApifyAmazonItem(o)));
  const adapted = real.map((o) => adapter.adaptApifyAmazonItem(o, { capturedAt: '2026-11-07T00:28:40.000Z', resolveCategory: () => ({}) }));
  assert.ok(adapted.every((r) => r.__import.errors.length === 0 && r.__import.review.length === 0), JSON.stringify(adapted.map((r) => r.__import.review)));
  assert.ok(adapted.every((r) => r.offer.platform === 'amazon' && r.offer.currency === 'EUR' && r.offer.price > 0 && /^[A-Z0-9]{10}$/.test(r.offer.externalId)));
  assert.ok(adapted.every((r) => r.product.images.length > 0 && r.product.images.every((u) => u.startsWith('https://') && !/aplus-media|brand-?story/i.test(u))), 'sólo imágenes del producto');
  // vendedor de terceros conservado (sólo el nombre); variantes sin precio no se importan
  assert.ok(adapted.some((r) => r.offer.sellerName && r.offer.sellerName !== 'Amazon'));
  assert.ok(adapted.some((r) => r.__import.warnings.some((w) => w.startsWith('variantes_no_importadas:'))));
  // simulación con destino: no escribe y todas las fichas nuevas llevan el destino
  const service = await import('../../src/lib/jsonImport/service.ts');
  const before = fs.readFileSync(path.join(dir, 'products.json'), 'utf8');
  const out = service.processChunk({ batchId: 'amz-real-dry', records: real, defaults: {}, dryRun: true, indexOffset: 0, target: { category: 'Informatica', categoryId: 'informatica' } });
  assert.deepEqual(out.results.map((r) => r.outcome), Array(10).fill('created'));
  assert.ok(out.results.every((r) => r.categoryApplied === 'Informatica'));
  assert.equal(fs.readFileSync(path.join(dir, 'products.json'), 'utf8'), before, 'la simulación no escribe');
});
