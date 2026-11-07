// Temu (actor Apify hypebridge/temu-scraper, id 2CKn7F7pA4eH2mVRm): validación de URL, entrada del actor con el límite
// TRANSMITIDO (maxItems), memoria/coste, ejecución asíncrona idempotente y separada de Amazon, adaptación al modelo del
// importador (moneda, «desde», variantes, cupones, enlace de origen ≠ afiliado) e integración con el motor existente.
// Apify SIMULADO. La muestra `fixtures/temu-sample.synthetic.json` es SINTÉTICA (construida desde el esquema documentado
// del actor): NO es salida real del actor; la prueba real controlada requiere APIFY_TOKEN.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, readCatalog, writeCatalog, apiRequest, jsonOf, mockFetch, jsonRecord } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-temu-');
const TOKEN = 'apify_api_TOKEN-TEMU-DE-PRUEBA-0123456789';
process.env.APIFY_TOKEN = TOKEN;
for (const k of ['APIFY_MAX_ITEMS', 'APIFY_PROXY_COUNTRY', 'APIFY_LANGUAGE', 'APIFY_MAX_RUNS_PER_DAY', 'APIFY_TEMU_GET_DETAILS', 'APIFY_API_BASE']) delete process.env[k];

const lib = await import('../../src/lib/apify/categoryExtraction.ts');
const temu = await import('../../src/lib/jsonImport/apifyTemu.ts');
const service = await import('../../src/lib/jsonImport/service.ts');
const route = await import('../../src/pages/api/admin/category-extract/index.ts');
const cats = await import('../../src/lib/categories.ts');
cats.writeCategories([{ id: 'c-audio', name: 'Audio', slug: 'audio', icon: 'A', keywords: ['auriculares'] }, { id: 'c-hogar', name: 'Hogar', slug: 'hogar', icon: 'H', keywords: ['lampara'] }]);
cats.invalidateCategoriesCache();

const SAMPLE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'temu-sample.synthetic.json'), 'utf8'));
const CAT = 'https://www.temu.com/es/category-o3-248.html';
const PROD = 'https://www.temu.com/es/-g-601099513224343.html';
const jobsFile = path.join(dir, 'category-extractions.json');
const resetJobs = () => { fs.rmSync(jobsFile, { force: true }); fs.rmSync(path.join(dir, 'category-extractions'), { recursive: true, force: true }); };
// Parámetros de ENTRADA reales del actor (build 0.2.13 consultado el 7-nov-2026): no se admiten nombres inventados.
const SCHEMA_KEYS = ['startUrls', 'maxItems', 'getProductDetails', 'extractReviews'];
const adapt = (i) => temu.adaptApifyTemuItem(SAMPLE[i], { resolveCategory: () => ({}) });
const rev = (i) => adapt(i).__import.review;
const warn = (i) => adapt(i).__import.warnings;

/* ───────────── Validación y entrada del actor ───────────── */

test('URL de Temu: admite producto y categoría; rechaza búsquedas, tiendas, colecciones, portada y destinos ajenos', () => {
  assert.deepEqual(lib.validateTemuUrl(PROD), { url: PROD, kind: 'product' });
  assert.equal(lib.validateTemuUrl(CAT).kind, 'category');
  assert.equal(lib.validateTemuUrl('https://www.temu.com/es-en/category-o3-248.html').kind, 'category');
  assert.equal(lib.validateTemuUrl('https://www.temu.com/es/auriculares-flash-bluetooth-g-601099513224343.html').kind, 'product', 'una palabra como «flash» en el título del producto no es un canal');
  assert.equal(lib.validateTemuUrl('https://www.temu.com/es/-o3-248.html').kind, 'category');
  const cases = [
    ['', /Indica la URL/], ['temu.com/x', /no es válida/], ['http://www.temu.com/-g-601099513224343.html', /https/],
    ['https://user:pw@www.temu.com/-g-601099513224343.html', /credenciales/], ['https://www.amazon.es/dp/B01EXDG2MO', /Sólo se admiten URL de Temu/],
    ['https://www.temu.com.evil.example/-g-601099513224343.html', /Sólo se admiten URL de Temu/],
    ['https://www.temu.com/search_result.html?search_key=auriculares', /búsquedas/], ['https://www.temu.com/es/algo?query=auriculares', /búsquedas/],
    ['https://www.temu.com/mall.html?mall_id=634418218148716', /tienda/], ['https://www.temu.com/', /portada/], ['https://www.temu.com/es', /portada/],
    ['https://www.temu.com/us/bestsellers.html', /colecciones y canales/], ['https://www.temu.com/channel/lightning-deals.html', /colecciones y canales/],
    ['https://www.temu.com/category-o3-248.html', /no indica el mercado español/], ['https://www.temu.com/-g-601099513224343.html', /no indica el mercado español/],
    ['https://www.temu.com/us/category-o3-248.html', /no indica el mercado español/], ['https://www.temu.com/de-en/category-o3-248.html', /no indica el mercado español/],
    ['https://www.temu.com/politica-de-privacidad.html', /Tipo de URL de Temu no admitido/], ['https://www.temu.com/' + 'a'.repeat(2100), /demasiado larga/],
  ];
  for (const [bad, re] of cases) assert.throws(() => lib.validateTemuUrl(bad), (e) => e instanceof lib.ExtractionError && re.test(e.message), String(bad).slice(0, 70));
});

test('entrada del actor de Temu: sólo parámetros de su esquema, límite → maxItems, detalle activado y sin opiniones', () => {
  const input = lib.buildTemuInput(CAT, 10);
  for (const key of Object.keys(input)) assert.ok(SCHEMA_KEYS.includes(key), 'parámetro inventado: ' + key);
  assert.deepEqual(input.startUrls, [{ url: CAT }]);
  assert.equal(input.maxItems, 10);
  assert.equal(input.getProductDetails, true);
  assert.equal(input.extractReviews, false);
  assert.equal(lib.buildTemuInput(CAT, 37).maxItems, 37);
  process.env.APIFY_TEMU_GET_DETAILS = 'false';
  assert.equal(lib.buildTemuInput(CAT, 10).getProductDetails, false);
  delete process.env.APIFY_TEMU_GET_DETAILS;
});

test('coste de Temu: 1 GB de memoria (arranque 0,03 USD), tope por ejecución y estimación documentada', () => {
  assert.equal(lib.TEMU_MEMORY_MB, 1024, 'el mínimo declarado por el actor; con su 4 GB por defecto el arranque costaría 4 veces más');
  assert.equal(lib.estimateTemuCost(10), 0.19, 'medido en una ejecución real: 10 productos con detalle = 0,19 USD');
  assert.equal(lib.estimateTemuCost(3), 0.078, 'medido: 3 productos = 0,078 USD');
  assert.equal(lib.maxTemuChargeFor(10), 0.375);
  assert.ok(lib.maxTemuChargeFor(100) <= 2 && lib.maxTemuChargeFor(1) >= 0.1);
});

/* ───────────── Ejecución asíncrona simulada ───────────── */

function fakeApify(opts = {}) {
  const state = { calls: [], runStatus: 'RUNNING', items: [], itemCount: 0, usage: 0.25, finishedAt: '2026-11-07T10:05:00.000Z', ...opts };
  const restore = mockFetch(async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    state.calls.push({ method, path: u.pathname, search: u.search, headers: init.headers, body: init.body });
    const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.hostname !== 'api.apify.com') throw new Error('petición inesperada fuera de Apify: ' + u.hostname);
    if (method === 'POST' && /\/v2\/actors\/[^/]+\/runs$/.test(u.pathname)) return ok({ data: { id: 'RUNT1', defaultDatasetId: 'DST1', status: 'READY' } }, 201);
    if (method === 'POST' && /abort$/.test(u.pathname)) { state.runStatus = 'ABORTING'; return ok({ data: { status: 'ABORTING' } }); }
    if (method === 'GET' && /\/v2\/actor-runs\/RUNT1$/.test(u.pathname)) return ok({ data: { id: 'RUNT1', status: state.runStatus, defaultDatasetId: 'DST1', usageTotalUsd: state.usage, finishedAt: state.finishedAt } });
    if (method === 'GET' && /\/v2\/datasets\/DST1$/.test(u.pathname)) return ok({ data: { itemCount: state.itemCount } });
    if (method === 'GET' && /\/v2\/datasets\/DST1\/items$/.test(u.pathname)) return ok(state.items);
    return ok({}, 404);
  });
  return { state, restore };
}
const post = (body) => route.POST({ request: apiRequest('/api/admin/category-extract', { body, token: true }) });
const get = (qs = '') => route.GET({ request: apiRequest('/api/admin/category-extract' + qs, { method: 'GET', token: true }), url: new URL('http://localhost/api/admin/category-extract' + qs) });
const runPosts = (f) => f.state.calls.filter((c) => c.method === 'POST' && /runs$/.test(c.path));

test('inicio de Temu: actor hypebridge~temu-scraper, maxItems=límite, memoria 1 GB, tope de gasto, token en cabecera y sin guardar nada', async () => {
  resetJobs();
  const before = fs.readFileSync(path.join(dir, 'products.json'), 'utf8');
  const f = fakeApify();
  try {
    const res = await post({ source: 'temu', url: CAT, limit: 10 });
    assert.equal(res.status, 201);
    const body = await jsonOf(res);
    assert.equal(body.job.source, 'temu');
    assert.equal(body.job.urlKind, 'category');
    assert.equal(body.job.limit, 10);
    assert.equal(body.job.twoPhase, true);
    assert.equal(body.job.phase, 'discovery');
    const start = runPosts(f)[0];
    assert.match(start.path, /^\/v2\/actors\/hypebridge~temu-scraper\/runs$/);
    assert.match(start.search, /memory=1024/);
    assert.match(start.search, /maxTotalChargeUsd=0\.135/, 'tope de la fase 1: (0,03 + 10 × 0,006) × 1,5');
    assert.match(start.search, /timeout=900/);
    assert.doesNotMatch(start.search, new RegExp(TOKEN));
    assert.equal(start.headers.Authorization, `Bearer ${TOKEN}`);
    const sent = JSON.parse(start.body);
    assert.equal(sent.maxItems, 10, 'el límite de Treidilor viaja a Apify como maxItems');
    assert.equal(sent.getProductDetails, false, 'la fase 1 sólo descubre identificadores: sin detalle');
    assert.deepEqual(sent.startUrls, [{ url: CAT }]);
    assert.doesNotMatch(JSON.stringify(body) + fs.readFileSync(jobsFile, 'utf8'), new RegExp(TOKEN));
  } finally { f.restore(); }
  assert.equal(fs.readFileSync(path.join(dir, 'products.json'), 'utf8'), before);
});

test('URL de producto de Temu: se pide UN producto (límite efectivo 1); la de Amazon sigue usando su actor y sin memory', async () => {
  resetJobs();
  let f = fakeApify();
  try {
    const body = await jsonOf(await post({ source: 'temu', url: PROD, limit: 10 }));
    assert.equal(body.job.urlKind, 'product');
    assert.equal(body.job.limit, 1);
    assert.equal(JSON.parse(runPosts(f)[0].body).maxItems, 1);
  } finally { f.restore(); }
  resetJobs();
  f = fakeApify();
  try {
    const amazon = await jsonOf(await post({ url: 'https://www.amazon.es/gp/browse.html?node=938008031', limit: 10 }));
    assert.equal(amazon.job.source, 'amazon');
    const start = runPosts(f)[0];
    assert.match(start.path, /junglee~amazon-crawler/);
    assert.doesNotMatch(start.search, /memory=/);
    assert.equal(JSON.parse(start.body).maxItemsPerStartUrl, 10);
    assert.ok(!('startUrls' in JSON.parse(start.body)), 'Amazon no recibe parámetros de Temu');
  } finally { f.restore(); }
});

test('validación en el servidor: tipos de URL no admitidos, origen inválido y límite 0 → 400 SIN lanzar ejecución', async () => {
  resetJobs();
  const f = fakeApify();
  try {
    for (const body of [
      { source: 'temu', url: 'https://www.temu.com/search_result.html?search_key=a', limit: 10 },
      { source: 'temu', url: 'https://www.temu.com/', limit: 10 },
      { source: 'temu', url: 'https://www.amazon.es/s?k=a', limit: 10 },
      { source: 'temu', url: CAT, limit: 0 },
      { source: 'temu', url: CAT, limit: 51 },
      { source: 'ebay', url: CAT, limit: 10 },
      { source: 'amazon', url: CAT, limit: 10 },
    ]) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(runPosts(f).length, 0, 'ninguna petición inválida llegó a Apify');
  } finally { f.restore(); }
});

test('idempotencia entre orígenes: misma URL+límite+origen se reutiliza; otro origen o URL con una activa → 409', async () => {
  resetJobs();
  const f = fakeApify();
  try {
    const [a, b] = await Promise.all([post({ source: 'temu', url: CAT, limit: 10 }), post({ source: 'temu', url: CAT, limit: 10 })]);
    const [x, y] = [await jsonOf(a), await jsonOf(b)];
    assert.equal(x.job.id, y.job.id);
    assert.equal(runPosts(f).length, 1, 'doble clic = una ejecución');
    assert.equal((await post({ source: 'temu', url: 'https://www.temu.com/es/category-o3-300.html', limit: 10 })).status, 409);
    assert.equal((await post({ source: 'amazon', url: 'https://www.amazon.es/s?k=a', limit: 10 })).status, 409);
    const cfg = await jsonOf(await get());
    assert.equal(cfg.active.source, 'temu', 'al recargar se recupera la ejecución de Temu');
    assert.equal(cfg.sources.temu.actor, 'hypebridge/temu-scraper');
  } finally { f.restore(); }
});

test('resultado vacío de una categoría: no se interpreta como categoría vacía', async () => {
  resetJobs();
  const f = fakeApify({ runStatus: 'SUCCEEDED', items: [], itemCount: 0 });
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 10 }));
    const out = await jsonOf(await get('?id=' + started.job.id));
    assert.equal(out.job.summary.fetched, 0);
    assert.ok(out.job.summary.warnings.includes('sin_resultados_no_prueba_que_la_categoria_este_vacia'));
  } finally { f.restore(); }
});

/* ───────────── Adaptador ───────────── */

test('adaptador: ficha completa → identificador, URL de origen, vendedor, moneda, imágenes del producto, atributos, disponibilidad', () => {
  const r = adapt(0);
  assert.deepEqual(r.__import.review, []);
  assert.deepEqual(r.__import.errors, []);
  assert.equal(r.offer.platform, 'temu');
  assert.equal(r.offer.externalId, '601099513224343');
  assert.equal(r.offer.url, 'https://www.temu.com/-g-601099513224343.html');
  assert.equal(r.offer.price, 12.49);
  assert.equal(r.offer.currency, 'EUR');
  assert.equal(r.offer.originalPrice, 35.99);
  assert.equal(r.offer.sellerName, 'Global Tech Official Store');
  assert.equal(r.offer.sellerId, '634418218148716');
  assert.equal(r.offer.availability, true);
  assert.equal(r.offer.capturedAt, '2026-11-06T10:00:00.000Z');
  assert.deepEqual(r.product.images, ['https://img.kwcdn.com/product/fancy/a1.jpg', 'https://img.kwcdn.com/product/fancy/a2.jpg']);
  assert.ok(!r.product.images.some((u) => /sku_/.test(u)), 'las imágenes propias de cada SKU no se mezclan con las del producto');
  assert.equal(r.product.brand, 'Zonic');
  assert.equal(r.product.specs['Versión Bluetooth'], '5.3');
  assert.equal(r.offer.affiliateUrl, undefined, 'Apify no da enlace de afiliado: nunca se rellena');
  assert.ok(r.__import.warnings.includes('enlace_de_origen_sin_afiliar'));
  assert.ok(r.__import.warnings.includes('variantes_no_importadas:2'));
  assert.deepEqual(r.variant, {}, 'las variantes no heredan el precio ni se importan como ficha');
  assert.equal(r.offer.shipping.free, true);
});

test('adaptador: «desde», precio variable, oferta relámpago y descuento con código NO son precio final → revisión', () => {
  assert.deepEqual(rev(1), ['precio_desde']);
  assert.deepEqual(rev(2), ['precio_varia_segun_variante:3.5-5.9']);
  assert.deepEqual(rev(4), ['precio_promocional_temporal']);
  assert.ok(rev(5).includes('descuento_condicionado'));
  assert.equal(adapt(4).offer.originalPrice, undefined, 'en oferta relámpago no se presenta un «precio anterior»');
});

test('adaptador: moneda y mercado — sólo EUR del mercado español; USD, moneda ausente y /us/ no se asumen ni convierten', () => {
  assert.deepEqual(rev(3), ['moneda_no_euro:USD']);
  assert.equal(adapt(3).offer.price, 7.2, 'no se convierte la moneda');
  assert.equal(adapt(3).offer.currency, 'USD');
  assert.deepEqual(rev(7), ['mercado_distinto_de_espana:us']);
  const noCurrency = temu.adaptApifyTemuItem({ ...SAMPLE[0], currency: undefined });
  assert.ok(noCurrency.__import.errors.includes('moneda_ausente_no_se_asume'));
  assert.equal(noCurrency.offer.currency, undefined);
  const eurNoMarket = temu.adaptApifyTemuItem({ ...SAMPLE[0], sourceUrl: undefined, productUrl: 'https://www.temu.com/-g-601099513224343.html' });
  assert.ok(eurNoMarket.__import.warnings.includes('mercado_espana_no_verificable_por_la_moneda'), 'EUR sin prefijo de mercado no demuestra mercado español: se avisa');
  assert.ok(!warn(0).includes('mercado_espana_no_verificable_por_la_moneda'), 'EUR + /es/ = mercado español comprobado');
  assert.deepEqual(rev(0), [], 'sourceUrl /es/ y EUR: sin motivo de revisión');
});

test('adaptador: envío desconocido ≠ gratis; datos ausentes no se inventan; detalle no disponible y títulos enmascarados se avisan', () => {
  assert.equal(adapt(5).offer.shipping?.free, undefined, '«gratis en pedidos superiores a 20 €» es condicional');
  assert.match(adapt(5).offer.shipping.text, /superiores a 20/);
  const bare = adapt(6);
  assert.equal(bare.offer.sellerName, undefined);
  assert.equal(bare.offer.shipping, undefined);
  assert.equal(temu.adaptApifyTemuItem({ ...SAMPLE[0], shippingFeeText: 'Free shipping on all orders' }).offer.shipping.free, true, 'sin condición');
  assert.equal(temu.adaptApifyTemuItem({ ...SAMPLE[0], shippingFeeText: 'Free shipping on orders over €20' }).offer.shipping.free, undefined);
  assert.equal(bare.offer.availability, undefined);
  assert.equal(bare.product.brand, undefined);
  assert.ok(bare.__import.warnings.includes('detalle_no_disponible_solo_datos_de_listado'));
  assert.ok(bare.__import.warnings.includes('titulo_con_terminos_enmascarados_por_temu'));
  assert.ok(warn(1).includes('ficha_de_listado_sin_detalle'));
  assert.ok(temu.adaptApifyTemuItem({ ...SAMPLE[0], goodsId: 'abc' }).__import.errors.includes('goods_id_invalido'));
  assert.equal(temu.isApifyTemuItem(SAMPLE[0]), true);
  assert.equal(temu.isApifyTemuItem({ asin: 'B0HKJWM6DF', title: 'x' }), false);
});

/* ───────────── Integración con el motor existente ───────────── */

const run = (records, opts = {}) => service.processChunk({ batchId: `temu-${Math.random().toString(36).slice(2, 10)}`, records, defaults: opts.defaults ?? {}, dryRun: opts.dryRun ?? false, indexOffset: 0, target: opts.target });

test('importación: las fichas válidas se crean, las dudosas van a revisión y los rechazos se explican; reimportar no duplica', () => {
  writeCatalog(dir, []);
  const target = { category: 'Audio', categoryId: 'c-audio' };
  const out = run(SAMPLE, { target });
  const by = (name) => out.results.filter((r) => r.outcome === name);
  assert.deepEqual(by('created').map((r) => r.index), [0, 6], 'ficha completa y ficha de listado con aviso');
  assert.deepEqual(by('review').map((r) => r.index), [1, 2, 3, 4, 5, 7]);
  assert.equal(by('rejected').length, 0);
  assert.ok(by('review').every((r) => r.reasons.length >= 1));
  const stored = readCatalog(dir);
  assert.equal(stored.length, 2);
  const p = stored.find((x) => x.sourceId === '601099513224343');
  assert.equal(p.network, 'temu');
  assert.equal(p.category, 'Audio');
  assert.equal(p.extra.sourceUrl, 'https://www.temu.com/-g-601099513224343.html', 'el enlace de ORIGEN se guarda aparte');
  assert.equal(p.link_status, 'pending', 'sin enlace de afiliado la ficha queda pendiente: una URL normal no se presenta como afiliada');
  assert.equal(p.ia_status, 'pending');
  const again = run(SAMPLE, { target });
  assert.equal(readCatalog(dir).length, 2, 'reimportar no duplica');
  assert.deepEqual(again.results.filter((r) => r.outcome === 'created'), []);
});

test('Amazon y Temu NO se fusionan por título ni imagen parecidos: cada plataforma conserva su ficha y su oferta', () => {
  writeCatalog(dir, []);
  const title = 'Auriculares Bluetooth 5.3 con estuche de carga, 36 h de autonomía';
  run([jsonRecord(1, { title, platform: 'amazon', asin: 'B0AAAAAAA1', externalId: undefined, url: 'https://www.amazon.es/dp/B0AAAAAAA1', image: 'https://img.kwcdn.com/product/fancy/a1.jpg', category: 'Audio' })]);
  const out = run([SAMPLE[0]], { target: { category: 'Audio', categoryId: 'c-audio' } });
  const stored = readCatalog(dir);
  assert.notEqual(out.results[0].outcome, 'linked', 'nunca se vincula a la ficha de Amazon por parecido');
  assert.notEqual(out.results[0].outcome, 'updated');
  if (out.results[0].outcome === 'created') assert.equal(stored.length, 2);
  else assert.deepEqual(out.results[0].reasons, ['titulo_parecido_sin_identificador_fuerte']);
  assert.equal(stored.find((x) => x.network === 'amazon').price, 30 + 1, 'la ficha de Amazon no cambió');
});

test('JSON externo de Temu (formato genérico, sin Apify) se importa igual que antes', () => {
  writeCatalog(dir, []);
  const rec = jsonRecord(9, { platform: 'temu', externalId: '777000000000009', url: 'https://www.temu.com/-g-777000000000009.html', title: 'Organizador de cables de escritorio' });
  const out = run([rec]);
  assert.equal(out.results[0].outcome, 'created');
  assert.equal(readCatalog(dir)[0].network, 'temu');
});

test('Temu: destino de categoría, simulación y fichas existentes igual que Amazon (sin tocar categorías ni guardar en simulación)', () => {
  writeCatalog(dir, []);
  const dry = run([SAMPLE[0]], { target: { category: 'Hogar', categoryId: 'c-hogar' }, dryRun: true });
  assert.equal(dry.results[0].outcome, 'created');
  assert.equal(dry.results[0].categoryApplied, 'Hogar');
  assert.equal(readCatalog(dir).length, 0);
  run([SAMPLE[0]], { target: { category: 'Hogar', categoryId: 'c-hogar' } });
  const other = run([{ ...SAMPLE[0], price: 11.5, skus: SAMPLE[0].skus.map((k) => ({ ...k, price: 11.5 })), extractedAt: '2026-11-06T12:00:00.000Z' }], { target: { category: 'Audio', categoryId: 'c-audio' } });
  assert.equal(other.results[0].outcome, 'updated', JSON.stringify(other.results[0]));
  assert.equal(readCatalog(dir)[0].category, 'Hogar', 'una ficha existente conserva su categoría');
});

/* ───────────── Muestras REALES del actor (ejecuciones de producción del 7-nov-2026, sin importar nada) ───────────── */

const REAL_US = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'temu-real-sample-us.json'), 'utf8'));
const REAL_ES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'temu-real-sample-es.json'), 'utf8'));

test('muestra REAL sin /es/ (categoría pedida sin mercado): 10 productos en USD → todos a revisión, ninguno se importa', () => {
  assert.equal(REAL_US.length, 10);
  assert.ok(REAL_US.every((o) => temu.isApifyTemuItem(o)));
  const adapted = REAL_US.map((o) => temu.adaptApifyTemuItem(o, { resolveCategory: () => ({}) }));
  assert.ok(adapted.every((r) => r.__import.errors.length === 0), 'sin errores de adaptación');
  assert.ok(adapted.every((r) => r.__import.review.includes('moneda_no_euro:USD')), 'USD → revisión, sin convertir');
  assert.ok(adapted.every((r) => r.offer.platform === 'temu' && /^\d{6,20}$/.test(r.offer.externalId) && r.offer.url.startsWith('https://www.temu.com/') && r.offer.affiliateUrl === undefined));
  writeCatalog(dir, []);
  const out = run(REAL_US, { target: { category: 'Audio', categoryId: 'c-audio' } });
  assert.deepEqual(out.results.map((r) => r.outcome), Array(10).fill('review'));
  assert.equal(readCatalog(dir).length, 0);
});

test('muestra REAL con /es/: EUR y mercado español comprobados → se importan; enlace de origen con /es/, sin afiliado, imágenes del producto', () => {
  assert.equal(REAL_ES.length, 3);
  const adapted = REAL_ES.map((o) => temu.adaptApifyTemuItem(o, { resolveCategory: () => ({}) }));
  assert.ok(adapted.every((r) => r.__import.review.length === 0 && r.__import.errors.length === 0), JSON.stringify(adapted.map((r) => r.__import)));
  adapted.forEach((r, i) => {
    const o = REAL_ES[i];
    assert.equal(r.offer.currency, 'EUR');
    assert.equal(r.offer.price, o.price);
    assert.match(r.offer.url, /^https:\/\/www\.temu\.com\/es\//);
    const own = new Set([o.imageUrl, ...(o.galleryImages ?? [])]);
    assert.ok(r.product.images.length > 0 && r.product.images.every((u) => own.has(u)), 'sólo imágenes del producto');
    assert.ok(r.__import.warnings.some((w) => w.startsWith('variantes_no_importadas:')), 'las variantes no se importan como fichas');
    assert.deepEqual(r.variant, {});
  });
  writeCatalog(dir, []);
  const out = run(REAL_ES, { target: { category: 'Audio', categoryId: 'c-audio' } });
  assert.deepEqual(out.results.map((r) => r.outcome), ['created', 'created', 'created']);
  const stored = readCatalog(dir);
  assert.ok(stored.every((p) => p.network === 'temu' && p.currency === 'EUR' && p.link_status === 'pending' && /temu\.com\/es\//.test(p.extra.sourceUrl) && p.category === 'Audio'));
  assert.equal(run(REAL_ES, { target: { category: 'Audio', categoryId: 'c-audio' } }).results.filter((r) => r.outcome === 'created').length, 0, 'reimportar no duplica');
  assert.equal(readCatalog(dir).length, 3);
});

test('el adaptador de Temu no usa IA ni red', () => {
  const text = fs.readFileSync(path.join('d:/AXEL/WEBS/TRADYLOR/tradylor_web', 'src/lib/jsonImport/apifyTemu.ts'), 'utf8');
  assert.ok(!/from '\.\.\/ai'|openai|anthropic|fetch\(/i.test(text));
});

test('reimportar el mismo producto de Temu no duplica su oferta; otro vendedor del mismo anuncio sí añade otra oferta', async () => {
  const { getOffers } = await import('../../src/lib/catalogOffers.ts');
  writeCatalog(dir, []);
  const target = { category: 'Audio', categoryId: 'c-audio' };
  run([SAMPLE[0]], { target });
  const again = run([SAMPLE[0]], { target });
  assert.deepEqual(again.results.map((r) => r.outcome), ['unchanged'], JSON.stringify(again.results[0]));
  assert.equal(getOffers(readCatalog(dir)[0]).length, 1, 'una sola oferta tras reimportar');
  assert.equal(readCatalog(dir)[0].extra.offerSeller.id, '634418218148716');
  const other = run([{ ...SAMPLE[0], mallId: '999', mallName: 'Otra tienda', price: 13.9, skus: SAMPLE[0].skus.map((k) => ({ ...k, price: 13.9 })) }], { target });
  assert.equal(other.results[0].outcome, 'linked');
  assert.equal(readCatalog(dir).length, 1);
  assert.equal(getOffers(readCatalog(dir)[0]).length, 2, 'las ofertas de vendedores distintos se conservan por separado');
});

test('lectura de elementos crudos (?raw=1): sólo lectura, requiere autenticación y no expone el token', async () => {
  resetJobs();
  const f = fakeApify({ runStatus: 'SUCCEEDED', items: SAMPLE, itemCount: SAMPLE.length });
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 5 }));
    const posts = runPosts(f).length;
    const res = await route.GET({ request: apiRequest('/api/admin/category-extract?id=' + started.job.id + '&raw=1', { method: 'GET', token: true }), url: new URL('http://localhost/api/admin/category-extract?id=' + started.job.id + '&raw=1') });
    const body = await jsonOf(res);
    assert.equal(body.items.length, 5, 'limitado al tamaño de la extracción');
    assert.equal(body.items[0].goodsId, SAMPLE[0].goodsId, 'sin adaptar');
    assert.equal(runPosts(f).length, posts, 'leer no lanza ejecuciones');
    assert.doesNotMatch(JSON.stringify(body), new RegExp(TOKEN));
    const anon = await route.GET({ request: apiRequest('/api/admin/category-extract?id=' + started.job.id + '&raw=1', { method: 'GET' }), url: new URL('http://localhost/api/admin/category-extract?id=' + started.job.id + '&raw=1') });
    assert.equal(anon.status, 401);
  } finally { f.restore(); }
});

/* ───────────── Muestra REAL adjunta por el usuario (categoría 1893, mercado EE. UU.; no se importa) ───────────── */

const REAL_1893 = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'temu-real-sample-us-category-1893.json'), 'utf8'));

test('muestra real categoría 1893 (sin /es/): 10 productos en USD → adaptación sin errores, todos a revisión, nada se importa', () => {
  assert.equal(REAL_1893.length, 10);
  assert.ok(REAL_1893.every((o) => temu.isApifyTemuItem(o)));
  const adapted = REAL_1893.map((o) => temu.adaptApifyTemuItem(o, { resolveCategory: () => ({}) }));
  assert.ok(adapted.every((r) => r.__import.errors.length === 0));
  assert.ok(adapted.every((r) => r.__import.review.length === 1 && r.__import.review[0] === 'moneda_no_euro:USD'), 'el único motivo es la moneda: ni «desde» ni variantes con precio distinto ni cupones');
  // marketPrice 0 (precio de referencia ausente) no se presenta como «precio anterior»
  assert.ok(adapted.every((r) => r.offer.originalPrice === undefined || r.offer.originalPrice > r.offer.price));
  assert.equal(adapted[1].offer.originalPrice, undefined);
  assert.equal(adapted[9].offer.originalPrice, 149.3);
  // lo que la fuente no trae no se inventa (ninguna trae vendedor ni afiliado); la valoración es la de la fuente
  assert.ok(adapted.every((r, i) => r.product.rating === REAL_1893[i].rating && r.product.reviewsCount === REAL_1893[i].reviewCount));
  assert.ok(adapted.every((r) => r.offer.sellerName === undefined && r.offer.affiliateUrl === undefined));
  // variantes: el primer producto trae 4 SKUs (dos con el mismo skuId) → se avisa, no se importan ni heredan precio
  assert.ok(adapted[0].__import.warnings.includes('variantes_no_importadas:4'));
  assert.deepEqual(adapted[0].variant, {});
  // envío «Free Shipping» incondicional → gratis; sin texto → desconocido
  assert.equal(adapted[0].offer.shipping.free, true);
  assert.equal(adapted[2].offer.shipping, undefined);
  // las imágenes de los SKUs que no están en la galería no se añaden (aquí todas coinciden con galleryImages)
  adapted.forEach((r, i) => { const own = new Set([REAL_1893[i].imageUrl, ...REAL_1893[i].galleryImages]); assert.ok(r.product.images.every((u) => own.has(u))); });
  // enlaces: URL de origen canónica de Temu
  assert.ok(adapted.every((r, i) => r.offer.url === REAL_1893[i].productUrl && /-g-\d{6,20}\.html$/.test(r.offer.url)));
  writeCatalog(dir, []);
  const out = run(REAL_1893, { target: { category: 'Hogar', categoryId: 'c-hogar' } });
  assert.deepEqual(out.results.map((r) => r.outcome), Array(10).fill('review'));
  assert.equal(readCatalog(dir).length, 0);
});

test('muestra real 1893 con moneda EUR y /es/ simulados: la estructura real se importa limpia (10 fichas, sin duplicados al reimportar)', () => {
  const es = REAL_1893.map((o) => ({ ...o, currency: 'EUR', sourceUrl: o.sourceUrl.replace('temu.com/', 'temu.com/es/'), skus: o.skus.map((s) => ({ ...s })) }));
  writeCatalog(dir, []);
  const target = { category: 'Hogar', categoryId: 'c-hogar' };
  const out = run(es, { target });
  assert.deepEqual(out.results.map((r) => r.outcome), Array(10).fill('created'), JSON.stringify(out.results.filter((r) => r.outcome !== 'created')));
  assert.equal(readCatalog(dir).length, 10);
  assert.equal(run(es, { target }).results.filter((r) => r.outcome === 'created').length, 0);
  assert.equal(readCatalog(dir).length, 10);
});

/* ───────────── URL realmente enviada y mercado de la respuesta ───────────── */

test('la URL de Temu se envía LIMPIA: sin parámetros de seguimiento ni fragmento; conserva /es/ y el id', () => {
  const dirty = 'https://www.temu.com/es/calefaccion-o3-1893.html?opt_level=2&title=Equipo%20de%20calefacci%C3%B3n&_x_enter_scene_type=cate_tab&_x_sessn_id=vy89qyn4fm&refer_page_name=category&refer_page_sn=10012#top';
  const out = lib.validateTemuUrl(dirty);
  assert.equal(out.url, 'https://www.temu.com/es/calefaccion-o3-1893.html');
  assert.equal(out.kind, 'category');
  assert.doesNotMatch(out.url, /[?#]/);
});

test('la URL que se manda a Apify es la normalizada (comprobado en la petición)', async () => {
  resetJobs();
  const f = fakeApify();
  try {
    await post({ source: 'temu', url: 'https://www.temu.com/es/calefaccion-o3-1893.html?_x_sessn_id=abc&refer_page_sn=1', limit: 10 });
    assert.deepEqual(JSON.parse(runPosts(f)[0].body).startUrls, [{ url: 'https://www.temu.com/es/calefaccion-o3-1893.html' }]);
  } finally { f.restore(); }
});

/* ───────────── Producto de la categoría 1893 por su URL individual española (ejecución real, 7-nov-2026) ───────────── */

test('URL individual /es/ de un producto de la categoría 1893: mismo goodsId que el lote USD, ahora en EUR y mercado español → se importa; el lote USD sigue bloqueado', () => {
  const pdp = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'temu-real-sample-es-pdp-1893.json'), 'utf8'));
  assert.equal(pdp.length, 1);
  const usdTwin = REAL_1893.find((o) => o.goodsId === pdp[0].goodsId);
  assert.ok(usdTwin, 'el producto existe en el lote USD de la misma categoría');
  assert.equal(usdTwin.currency, 'USD');
  assert.equal(pdp[0].currency, 'EUR');
  assert.equal(pdp[0].sourcePageType, 'pdp');
  assert.match(pdp[0].sourceUrl, /^https:\/\/www\.temu\.com\/es\/-g-\d+\.html$/);
  const a = temu.adaptApifyTemuItem(pdp[0], { resolveCategory: () => ({}) });
  assert.deepEqual(a.__import.review, [], JSON.stringify(a.__import));
  assert.deepEqual(a.__import.errors, []);
  assert.equal(a.offer.currency, 'EUR');
  assert.equal(a.offer.price, pdp[0].price);
  // el gemelo USD sigue yendo a revisión: no se convierte ni se reetiqueta
  assert.ok(temu.adaptApifyTemuItem(usdTwin).__import.review.includes('moneda_no_euro:USD'));
  writeCatalog(dir, []);
  const out = run(pdp, { target: { category: 'Hogar', categoryId: 'c-hogar' } });
  assert.deepEqual(out.results.map((r) => r.outcome), ['created']);
  assert.equal(readCatalog(dir)[0].currency, 'EUR');
});


/* ───────────── Categorías de Temu en DOS FASES: descubrir ids → fichas españolas /es/-g-<id>.html en una sola ejecución ───────────── */

/** Apify simulado con dos (o tres) ejecuciones: la 1.ª es el descubrimiento; las siguientes, fichas españolas. */
function fakeTwoPhase(opts = {}) {
  const st = { calls: [], runs: [], aborts: [], discovery: { status: 'RUNNING', items: [], usage: 0.09 }, detail: { status: 'RUNNING', items: [], usage: 0.19 }, finishedAt: '2026-11-07T10:05:00.000Z', ...opts };
  const restore = mockFetch(async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    st.calls.push({ method, path: u.pathname, search: u.search });
    const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.hostname !== 'api.apify.com') throw new Error('petición inesperada: ' + u.hostname);
    const phaseOf = (n) => (n === '1' ? st.discovery : st.detail);
    if (method === 'POST' && /\/v2\/actors\/[^/]+\/runs$/.test(u.pathname)) {
      st.runs.push({ path: u.pathname, search: u.search, body: JSON.parse(init.body) });
      const n = st.runs.length;
      return ok({ data: { id: 'RUNP' + n, defaultDatasetId: 'DSP' + n, status: 'READY' } }, 201);
    }
    let m = u.pathname.match(/\/v2\/actor-runs\/RUNP(\d+)\/abort$/);
    if (method === 'POST' && m) { st.aborts.push(m[1]); return ok({ data: { status: 'ABORTING' } }); }
    m = u.pathname.match(/\/v2\/actor-runs\/RUNP(\d+)$/);
    if (method === 'GET' && m) { const p = phaseOf(m[1]); return ok({ data: { id: 'RUNP' + m[1], status: p.status, defaultDatasetId: 'DSP' + m[1], usageTotalUsd: p.usage, finishedAt: st.finishedAt, defaultKeyValueStoreId: 'KV' + m[1], startedAt: '2026-11-07T10:00:00.000Z', options: { memoryMbytes: 1024, timeoutSecs: 900, maxTotalChargeUsd: 0.375 } } }); }
    m = u.pathname.match(/\/v2\/datasets\/DSP(\d+)$/);
    if (method === 'GET' && u.pathname.includes('/key-value-stores/KV') && u.pathname.endsWith('/records/SOURCE_SUMMARY')) {
      return ok(st.sourceSummary ?? { outcomes: { ok: 1, unavailable: 2 }, samples: [{ requestedUrl: 'https://www.temu.com/es/-g-601000000000003.html', outcome: 'unavailable' }] });
    }
    if (method === 'GET' && m) return ok({ data: { itemCount: phaseOf(m[1]).items.length } });
    m = u.pathname.match(/\/v2\/datasets\/DSP(\d+)\/items$/);
    if (method === 'GET' && m) {
      st.itemsQueries = [...(st.itemsQueries ?? []), u.search];
      return ok(phaseOf(m[1]).items.slice(0, Number(u.searchParams.get('limit') || 100)));
    }
    return ok({}, 404);
  });
  return { st, restore };
}
const listing = (id, extra = {}) => ({ goodsId: String(id), title: 'PRECIO-USD-NO-GUARDAR', price: 9.99, currency: 'USD', sourcePageType: 'category', ...extra });
const esItem = (id, over = {}) => ({ ...REAL_ES[0], goodsId: String(id), title: 'Ficha española ' + id, price: 20 + (Number(String(id).slice(-1)) || 0), skus: [{ skuId: id + '_a', price: 20 + (Number(String(id).slice(-1)) || 0), inStock: true }], priceText: '€20', currency: 'EUR', sourcePageType: 'pdp', sourceUrl: 'https://www.temu.com/es/-g-' + id + '.html', productUrl: 'https://www.temu.com/es/ficha-g-' + id + '.html', inStock: true, ...over });
const IDS = ['601000000000001', '601000000000002', '601000000000003', '601000000000004', '601000000000005'];
const jobOf = async (id) => (await jsonOf(await get('?id=' + id)));

test('dos fases (1/2): «Descubriendo productos» sólo guarda ids, conserva el límite, elimina repetidos y NO guarda precios ni datos comerciales', async () => {
  resetJobs();
  const f = fakeTwoPhase();
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 5 }));
    assert.equal(started.job.runsReserved, 2, 'las dos fases se reservan en la cuota');
    f.st.discovery.status = 'SUCCEEDED';
    f.st.discovery.items = [listing(IDS[0]), listing(IDS[1]), listing(IDS[1]), listing(IDS[2]), listing('abc'), listing(IDS[3]), listing(IDS[4]), listing('601000000000099')];
    const out = await jobOf(started.job.id);
    assert.equal(f.st.runs.length, 2, 'se lanzó la fase 2');
    assert.deepEqual(out.job.discovery.ids, [IDS[0], IDS[1], IDS[2]], 'del tope de 5 filas leídas: sin repetidos y sin ids inválidos');
    assert.equal(out.job.discovery.fetched, 5, 'sólo se leen limit filas (la 6.ª sólo detecta el exceso)');
    assert.equal(out.job.discovery.duplicatesRemoved, 1);
    assert.equal(out.job.discovery.invalidIds, 1);
    assert.ok(out.job.discovery.ids.length <= 5, 'límite conservado');
    assert.ok(f.st.itemsQueries[0].includes('fields=goodsId'), 'sólo se piden los identificadores');
    assert.doesNotMatch(fs.readFileSync(jobsFile, 'utf8'), /PRECIO-USD-NO-GUARDAR|9\.99/, 'ningún precio ni título de la fase 1 se guarda');
    // fase 2: UNA ejecución con una URL /es/-g-<id>.html por id y maxItems = nº de ids
    const body = f.st.runs[1].body;
    assert.deepEqual(body.startUrls.map((x) => x.url), out.job.discovery.ids.map((id) => 'https://www.temu.com/es/-g-' + id + '.html'));
    assert.equal(body.maxItems, out.job.discovery.ids.length);
    assert.equal(body.getProductDetails, true);
    assert.match(f.st.runs[1].search, /memory=1024/);
    assert.equal(out.job.phase, 'detail');
    assert.equal(out.job.runsStarted, 2);
    assert.equal(out.job.detailUrlsSent, out.job.discovery.ids.length, 'queda registrado cuántas URL recibió la fase 2');
  } finally { f.restore(); }
});

test('dos fases (2/2): fichas españolas con identidad, EUR, mercado /es/, agotados conservados, ausentes explicados y coste de ambas fases', async () => {
  resetJobs();
  const f = fakeTwoPhase();
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 5 }));
    f.st.discovery.status = 'SUCCEEDED';
    f.st.discovery.items = IDS.map((id) => listing(id));
    await jobOf(started.job.id); // transición a la fase 2
    f.st.detail.status = 'SUCCEEDED';
    f.st.detail.items = [esItem(IDS[0]), esItem(IDS[1], { inStock: false }), esItem(IDS[3]), esItem(IDS[3]), esItem('609999999999999')];
    const out = await jobOf(started.job.id);
    assert.equal(out.job.status, 'succeeded');
    const p = out.job.summary.phases;
    assert.deepEqual({ discovered: p.discovered, obtained: p.obtained, unavailable: p.unavailable, outOfStock: p.outOfStock }, { discovered: 5, obtained: 3, unavailable: 2, outOfStock: 1 });
    assert.deepEqual(p.missing.map((m) => m.id), [IDS[2], IDS[4]], 'ausentes explicados, sin sustituirlos');
    assert.ok(p.missing.every((m) => /no devolvió la ficha española/.test(m.reason)));
    assert.ok(out.job.summary.warnings.includes('fichas_repetidas_descartadas:1'));
    assert.ok(out.job.summary.warnings.includes('fichas_de_ids_no_solicitados_descartadas:1'), 'un id no pedido no entra');
    assert.deepEqual(out.records.map((r) => r.offer.externalId), [IDS[0], IDS[1], IDS[3]], 'identidad = ids descubiertos, en el orden de la categoría');
    assert.ok(out.records.every((r) => r.offer.currency === 'EUR' && /\/es\//.test(r.offer.url)));
    assert.equal(out.records[1].offer.availability, false, 'el agotado conserva su estado');
    assert.ok(out.records.every((r) => r.__import.review.length === 0));
    assert.deepEqual(out.job.summary.currencies, { EUR: 3 });
    assert.equal(out.job.summary.marketMismatch, false);
    assert.equal(out.job.costUsd, 0.28, 'coste del trabajo = fase 1 + fase 2 (reportado por Apify)');
    assert.equal(p.discoveryCostUsd, 0.09);
    assert.equal(p.detailCostUsd, 0.19);
    assert.ok(!out.records.some((r) => /PRECIO-USD-NO-GUARDAR/.test(JSON.stringify(r))), 'ningún dato de la fase 1 entra en los registros');
  } finally { f.restore(); }
});

test('dos fases: si la fase 2 devuelve USD no se convierte ni se reetiqueta: revisión y aviso de mercado', async () => {
  resetJobs();
  const f = fakeTwoPhase();
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 2 }));
    f.st.discovery.status = 'SUCCEEDED'; f.st.discovery.items = IDS.slice(0, 2).map((id) => listing(id));
    await jobOf(started.job.id);
    f.st.detail.status = 'SUCCEEDED';
    f.st.detail.items = IDS.slice(0, 2).map((id) => esItem(id, { currency: 'USD', priceText: '$20', sourceUrl: 'https://www.temu.com/category-o3-1893.html' }));
    const out = await jobOf(started.job.id);
    assert.ok(out.records.every((r) => r.offer.currency === 'USD' && r.__import.review.includes('moneda_no_euro:USD')));
    assert.deepEqual(out.job.summary.currencies, { USD: 2 });
    assert.equal(out.job.summary.marketMismatch, true);
  } finally { f.restore(); }
});

test('dos fases: consultas simultáneas lanzan la fase 2 UNA sola vez', async () => {
  resetJobs();
  const f = fakeTwoPhase();
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 3 }));
    f.st.discovery.status = 'SUCCEEDED'; f.st.discovery.items = IDS.slice(0, 3).map((id) => listing(id));
    await Promise.all([1, 2, 3, 4, 5].map(() => jobOf(started.job.id)));
    assert.equal(f.st.runs.length, 2, 'fase 1 + una sola fase 2');
  } finally { f.restore(); }
});

test('dos fases: sin identificadores válidos no se lanza la fase 2 ni se gasta más; el resultado vacío se explica', async () => {
  resetJobs();
  const f = fakeTwoPhase();
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 3 }));
    f.st.discovery.status = 'SUCCEEDED'; f.st.discovery.items = [];
    const out = await jobOf(started.job.id);
    assert.equal(f.st.runs.length, 1);
    assert.equal(out.job.status, 'succeeded');
    assert.equal(out.job.summary.phases.discovered, 0);
    assert.ok(out.job.summary.warnings.includes('sin_resultados_no_prueba_que_la_categoria_este_vacia'));
    assert.deepEqual(out.records, []);
  } finally { f.restore(); }
});

test('cancelar el proceso completo: durante «Descubriendo productos» aborta y no lanza la fase 2; durante la fase 2 aborta y conserva lo obtenido', async () => {
  resetJobs();
  let f = fakeTwoPhase();
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 3 }));
    const res = await jsonOf(await post({ action: 'cancel', id: started.job.id }));
    assert.equal(res.success, true);
    assert.deepEqual(f.st.aborts, ['1'], 'se aborta la ejecución de descubrimiento');
    f.st.discovery.status = 'ABORTED';
    const out = await jobOf(started.job.id);
    assert.equal(out.job.status, 'aborted');
    assert.equal(f.st.runs.length, 1, 'no se lanzó la fase 2');
    assert.match(out.job.error, /Cancelado durante «Descubriendo productos»/);
    assert.deepEqual(out.records, []);
  } finally { f.restore(); }
  resetJobs();
  f = fakeTwoPhase();
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 3 }));
    f.st.discovery.status = 'SUCCEEDED'; f.st.discovery.items = IDS.slice(0, 3).map((id) => listing(id));
    await jobOf(started.job.id);
    await post({ action: 'cancel', id: started.job.id });
    assert.deepEqual(f.st.aborts, ['2'], 'se aborta la ejecución de fichas');
    f.st.detail.status = 'ABORTED'; f.st.detail.items = [esItem(IDS[0])];
    const out = await jobOf(started.job.id);
    assert.equal(out.job.status, 'aborted');
    assert.equal(out.records.length, 1);
    assert.equal(out.job.summary.partial, true);
    assert.equal(out.job.summary.phases.unavailable, 2);
    assert.ok(out.job.summary.phases.missing.every((m) => /interrumpió/.test(m.reason)));
  } finally { f.restore(); }
});

test('cancelar entre fases (mientras se descubre) no lanza la fase 2 aunque el descubrimiento termine', async () => {
  resetJobs();
  const f = fakeTwoPhase();
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 3 }));
    await post({ action: 'cancel', id: started.job.id });
    f.st.discovery.status = 'SUCCEEDED'; f.st.discovery.items = IDS.slice(0, 3).map((id) => listing(id));
    const out = await jobOf(started.job.id);
    assert.equal(f.st.runs.length, 1, 'cancelado: no se lanza la fase 2');
    assert.equal(out.job.status, 'aborted');
  } finally { f.restore(); }
});

test('reintentar tras un fallo de la fase 2 NO repite el descubrimiento y sólo cuenta 1 ejecución más en la cuota', async () => {
  resetJobs();
  process.env.APIFY_MAX_RUNS_PER_DAY = '3';
  const f = fakeTwoPhase();
  try {
    const first = await jsonOf(await post({ source: 'temu', url: CAT, limit: 3 }));
    f.st.discovery.status = 'SUCCEEDED'; f.st.discovery.items = IDS.slice(0, 3).map((id) => listing(id));
    await jobOf(first.job.id);
    f.st.detail.status = 'FAILED';
    const failed = await jobOf(first.job.id);
    assert.equal(failed.job.status, 'failed');
    assert.equal(f.st.runs.length, 2);
    // reintento: sólo la fase 2, con los mismos ids
    f.st.detail.status = 'RUNNING';
    const retry = await jsonOf(await post({ source: 'temu', url: CAT, limit: 3 }));
    assert.equal(f.st.runs.length, 3, 'una sola ejecución nueva (la fase 2)');
    assert.deepEqual(f.st.runs[2].body.startUrls, f.st.runs[1].body.startUrls);
    assert.equal(f.st.runs[2].body.getProductDetails, true);
    assert.equal(retry.job.discovery.reused, true);
    assert.equal(retry.job.discovery.costUsd, 0, 'la fase 1 no se vuelve a cobrar');
    assert.equal(retry.job.runsReserved, 1);
    f.st.detail.status = 'SUCCEEDED'; f.st.detail.items = IDS.slice(0, 3).map((id) => esItem(id));
    const done = await jobOf(retry.job.id);
    assert.equal(done.job.status, 'succeeded');
    assert.equal(done.job.summary.phases.reusedDiscovery, true);
    assert.equal(done.records.length, 3);
    // cuota: 2 (primer trabajo) + 1 (reintento) = 3 de 3 → otro trabajo de dos fases se rechaza, indicando lo que necesita
    const blocked = await post({ source: 'temu', url: 'https://www.temu.com/es/category-o3-300.html', limit: 3 });
    assert.equal(blocked.status, 429);
    assert.match((await jsonOf(blocked)).message, /necesita 2; hoy hay 3/);
    assert.equal(f.st.runs.length, 3, 'rechazado sin llamar a Apify');
  } finally { f.restore(); delete process.env.APIFY_MAX_RUNS_PER_DAY; }
});

test('cuota: una categoría de dos fases reserva 2 ejecuciones; una ficha individual o Amazon, 1', async () => {
  resetJobs();
  process.env.APIFY_MAX_RUNS_PER_DAY = '3';
  const f = fakeTwoPhase();
  try {
    const first = await jsonOf(await post({ source: 'temu', url: CAT, limit: 2 }));
    assert.equal(first.job.runsReserved, 2);
    f.st.discovery.status = 'SUCCEEDED'; f.st.discovery.items = IDS.slice(0, 2).map((id) => listing(id));
    await jobOf(first.job.id);
    f.st.detail.status = 'SUCCEEDED'; f.st.detail.items = IDS.slice(0, 2).map((id) => esItem(id));
    await jobOf(first.job.id);
    const product = await jsonOf(await post({ source: 'temu', url: PROD, limit: 1 }));
    assert.equal(product.job.runsReserved, 1);
    assert.equal(product.job.twoPhase, undefined, 'las URL de producto siguen en una sola fase');
  } finally { f.restore(); delete process.env.APIFY_MAX_RUNS_PER_DAY; }
});

test('presupuesto máximo explícito: se valida, limita cada ejecución y el trabajo entero', async () => {
  resetJobs();
  const f = fakeTwoPhase();
  try {
    for (const bad of [0.01, 5, 'abc', -1]) assert.equal((await post({ source: 'temu', url: CAT, limit: 2, budgetUsd: bad })).status, 400, String(bad));
    assert.equal(f.st.runs.length, 0, 'un presupuesto inválido no lanza nada');
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 2, budgetUsd: 0.2 }));
    assert.equal(started.job.budgetUsd, 0.2);
    assert.equal(started.job.maxCostUsd, 0.2);
    assert.match(f.st.runs[0].search, /maxTotalChargeUsd=0\.0?\d+/);
    f.st.discovery.status = 'SUCCEEDED'; f.st.discovery.items = IDS.slice(0, 2).map((id) => listing(id));
    await jobOf(started.job.id);
    const cap = Number(f.st.runs[1].search.match(/maxTotalChargeUsd=([0-9.]+)/)[1]);
    assert.ok(cap <= 0.2 - 0.09 + 1e-9, 'la fase 2 sólo puede gastar lo que queda del presupuesto: ' + cap);
    assert.ok(0.09 + cap <= 0.2 + 1e-9);
  } finally { f.restore(); }
});

test('Amazon y las URL de producto de Temu no cambian: una sola ejecución', async () => {
  resetJobs();
  const f = fakeTwoPhase();
  try {
    const p = await jsonOf(await post({ source: 'temu', url: PROD, limit: 10 }));
    assert.equal(p.job.twoPhase, undefined);
    assert.equal(f.st.runs[0].body.maxItems, 1);
    assert.equal(f.st.runs[0].body.getProductDetails, true);
    assert.deepEqual(f.st.runs[0].body.startUrls, [{ url: PROD }]);
  } finally { f.restore(); }
});

test('coste real: Apify puede cerrar el uso tarde; pasado el margen se vuelve a consultar UNA vez y se marca como consolidado (fase 1 + fase 2)', async () => {
  resetJobs();
  const f = fakeTwoPhase({ finishedAt: new Date().toISOString() });
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 2 }));
    f.st.discovery.status = 'SUCCEEDED'; f.st.discovery.usage = 0.042; f.st.discovery.items = IDS.slice(0, 2).map((id) => listing(id));
    await jobOf(started.job.id);
    f.st.detail.status = 'SUCCEEDED'; f.st.detail.usage = 0.03; f.st.detail.items = IDS.slice(0, 2).map((id) => esItem(id));
    let out = await jobOf(started.job.id);
    assert.equal(out.job.costUsd, 0.072);
    assert.notEqual(out.job.costSettled, true, 'recién terminado: el coste puede estar incompleto');
    // Apify consolida el uso (0,062) y pasa el margen de consolidación
    f.st.detail.usage = 0.062;
    const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
    jobs.find((j) => j.id === started.job.id).finishedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    fs.writeFileSync(jobsFile, JSON.stringify(jobs));
    out = await jobOf(started.job.id);
    assert.equal(out.job.costUsd, 0.104, 'fase 1 (0,042) + fase 2 consolidada (0,062)');
    assert.equal(out.job.summary.phases.detailCostUsd, 0.062);
    assert.equal(out.job.summary.phases.discoveryCostUsd, 0.042);
    assert.equal(out.job.costSettled, true);
    const polls = f.st.calls.filter((c) => c.path.endsWith('/actor-runs/RUNP2')).length;
    await jobOf(started.job.id);
    assert.equal(f.st.calls.filter((c) => c.path.endsWith('/actor-runs/RUNP2')).length, polls, 'consolidado: no se vuelve a consultar');
  } finally { f.restore(); }
});

/* ───────────── Validación REAL de las dos fases (categoría 1893, 2 productos, presupuesto 0,20 USD; 7-nov-2026) ───────────── */

test('muestra real de las dos fases (2 productos de la categoría 1893): identidad con el lote USD, EUR y /es/, agotado conservado; se crean sin convertir nada', () => {
  const real = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'temu-real-sample-es-twophase-1893.json'), 'utf8'));
  assert.deepEqual(real.map((o) => o.goodsId), ['601101683713758', '601100230893976'], 'los ids descubiertos en la categoría (mismo orden)');
  // identidad: son los dos primeros productos del lote USD de la misma categoría
  assert.deepEqual(REAL_1893.slice(0, 2).map((o) => o.goodsId), real.map((o) => o.goodsId));
  assert.ok(real.every((o) => o.currency === 'EUR' && o.sourcePageType === 'pdp' && /^https:\/\/www\.temu\.com\/es\/-g-\d+\.html$/.test(o.sourceUrl)));
  assert.ok(real.every((o) => o.inStock === false), 'el actor las devolvió agotadas para España');
  const a = real.map((o) => temu.adaptApifyTemuItem(o, { resolveCategory: () => ({}) }));
  assert.ok(a.every((r) => r.__import.review.length === 0 && r.__import.errors.length === 0));
  assert.ok(a.every((r) => r.offer.availability === false && r.offer.currency === 'EUR'));
  // el precio español NO es el estadounidense reutilizado ni convertido
  assert.ok(a.every((r, i) => r.offer.price === real[i].price && r.offer.price !== REAL_1893[i].price));
  writeCatalog(dir, []);
  const out = run(real, { target: { category: 'Hogar', categoryId: 'c-hogar' } });
  assert.deepEqual(out.results.map((r) => r.outcome), ['created', 'created']);
  assert.ok(readCatalog(dir).every((p) => p.currency === 'EUR' && p.inStock === false), 'agotado conservado en la ficha');
});

test('coste real de la FASE 1: si Apify la cerró tarde (sólo el arranque), se vuelve a consultar y se corrige sin repetir ejecuciones', async () => {
  resetJobs();
  const f = fakeTwoPhase({ finishedAt: new Date().toISOString() });
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 10 }));
    f.st.discovery.status = 'SUCCEEDED'; f.st.discovery.usage = 0.03; // lectura incompleta: sólo el arranque
    f.st.discovery.items = IDS.map((id) => listing(id));
    await jobOf(started.job.id);
    f.st.detail.status = 'SUCCEEDED'; f.st.detail.usage = 0.094; f.st.detail.items = IDS.slice(0, 4).map((id) => esItem(id));
    let out = await jobOf(started.job.id);
    assert.equal(out.job.costUsd, 0.124, 'primera lectura (incompleta)');
    f.st.discovery.usage = 0.06; // Apify consolida: 0,03 + 5 × 0,006
    const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
    jobs.find((j) => j.id === started.job.id).finishedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    fs.writeFileSync(jobsFile, JSON.stringify(jobs));
    const runsBefore = f.st.runs.length;
    out = await jobOf(started.job.id);
    assert.equal(out.job.discovery.costUsd, 0.06);
    assert.equal(out.job.summary.phases.discoveryCostUsd, 0.06);
    assert.equal(out.job.summary.phases.detailCostUsd, 0.094);
    assert.equal(out.job.costUsd, 0.154, 'fase 1 consolidada + fase 2');
    assert.equal(out.job.discovery.costSettled, true);
    assert.equal(f.st.runs.length, runsBefore, 'sólo lecturas: ninguna ejecución nueva');
  } finally { f.restore(); }
});

test('diagnóstico de sólo lectura (?diag=1): devuelve el SOURCE_SUMMARY del actor y el uso de cada fase, sin gastar ni exponer el token', async () => {
  resetJobs();
  const f = fakeTwoPhase();
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 3 }));
    f.st.discovery.status = 'SUCCEEDED'; f.st.discovery.items = IDS.slice(0, 3).map((id) => listing(id));
    await jobOf(started.job.id);
    f.st.detail.status = 'SUCCEEDED'; f.st.detail.items = [esItem(IDS[0])];
    await jobOf(started.job.id);
    const runsBefore = f.st.runs.length;
    const q = '/api/admin/category-extract?id=' + started.job.id + '&diag=1';
    const res = await route.GET({ request: apiRequest(q, { method: 'GET', token: true }), url: new URL('http://localhost' + q) });
    const body = await jsonOf(res);
    assert.deepEqual(body.runs.map((r) => r.phase), ['discovery', 'detail']);
    assert.equal(body.runs[1].sourceSummary.outcomes.unavailable, 2);
    assert.equal(body.runs[1].options.memoryMbytes, 1024);
    assert.equal(f.st.runs.length, runsBefore);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(TOKEN));
    const anon = await route.GET({ request: apiRequest(q, { method: 'GET' }), url: new URL('http://localhost' + q) });
    assert.equal(anon.status, 401);
  } finally { f.restore(); }
});

/* ───────────── Diferencia hasta los N solicitados: cada ausente se explica con el diagnóstico del propio actor ───────────── */

const sourceSummaryFor = (rows) => ({
  total: rows.length,
  counts: {},
  samples: rows.map(([id, code, status, reason]) => ({ requestedUrl: 'https://www.temu.com/es/-g-' + id + '.html', canonicalUrl: 'https://www.temu.com/es/-g-' + id + '.html', pageType: 'pdp', code, status, reason, outputCount: code === 'SUCCESS' ? 1 : 0 })),
});

test('ausentes explicados con el SOURCE_SUMMARY del actor: inexistentes/retirados en España vs error del origen; cuenta hasta lo solicitado', async () => {
  resetJobs();
  const f = fakeTwoPhase({
    sourceSummary: sourceSummaryFor([
      [IDS[0], 'SUCCESS', null, 'SUCCESS'],
      [IDS[1], 'EMPTY_RESULT', 404, 'GOODS_NOT_EXIST: Product has been delisted or does not exist on Temu'],
      [IDS[2], 'EMPTY_RESULT', 404, 'GOODS_NOT_EXIST: Product has been delisted or does not exist on Temu'],
      [IDS[3], 'SOURCE_ERROR', 200, 'PDP data unavailable'],
      [IDS[4], 'SUCCESS', null, 'SUCCESS'],
    ]),
  });
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 10 }));
    f.st.discovery.status = 'SUCCEEDED';
    f.st.discovery.items = IDS.map((id) => listing(id));
    await jobOf(started.job.id);
    f.st.detail.status = 'SUCCEEDED';
    f.st.detail.items = [esItem(IDS[0]), esItem(IDS[4])];
    const out = await jobOf(started.job.id);
    const p = out.job.summary.phases;
    assert.equal(p.requested, 10);
    assert.equal(p.discoveryRows, 5, 'la categoría listó sólo 5 de los 10 pedidos');
    assert.equal(p.discovered, 5);
    assert.equal(p.obtained, 2);
    assert.equal(p.unavailable, 3);
    assert.equal(p.notInSpain, 2);
    assert.equal(p.sourceErrors, 1);
    assert.equal(p.explained, true);
    const byId = Object.fromEntries(p.missing.map((m) => [m.id, m]));
    assert.equal(byId[IDS[1]].code, 'GOODS_NOT_EXIST');
    assert.match(byId[IDS[1]].reason, /No existe o está retirado en el mercado español/);
    assert.equal(byId[IDS[3]].code, 'SOURCE_ERROR');
    assert.match(byId[IDS[3]].reason, /Puede ser transitorio/);
    // cuenta: 10 solicitados = 5 listados + 5 que la categoría no listó; 5 listados = 2 obtenidos + 2 inexistentes + 1 error del origen
    assert.equal(p.requested - p.discoveryRows + p.obtained + p.notInSpain + p.sourceErrors, p.requested);
  } finally { f.restore(); }
});

test('trabajos ya terminados sin explicar: se explican UNA vez con el diagnóstico (lectura) y sin lanzar ejecuciones', async () => {
  resetJobs();
  const f = fakeTwoPhase({
    sourceSummary: sourceSummaryFor([
      [IDS[0], 'SUCCESS', null, 'SUCCESS'],
      [IDS[1], 'EMPTY_RESULT', 404, 'GOODS_NOT_EXIST: Product has been delisted or does not exist on Temu'],
    ]),
  });
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 2 }));
    f.st.discovery.status = 'SUCCEEDED'; f.st.discovery.items = IDS.slice(0, 2).map((id) => listing(id));
    await jobOf(started.job.id);
    f.st.detail.status = 'SUCCEEDED'; f.st.detail.items = [esItem(IDS[0])];
    await jobOf(started.job.id);
    // Simula un trabajo anterior a este diagnóstico: motivo genérico y sin «explained»
    const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
    const j = jobs.find((x) => x.id === started.job.id);
    j.summary.phases.missing = [{ id: IDS[1], reason: 'El actor no devolvió la ficha española de este producto (no disponible en España, retirada o bloqueada)' }];
    delete j.summary.phases.explained; delete j.summary.phases.requested; delete j.summary.phases.notInSpain;
    fs.writeFileSync(jobsFile, JSON.stringify(jobs));
    const runsBefore = f.st.runs.length;
    const out = await jobOf(started.job.id);
    assert.equal(out.job.summary.phases.missing[0].code, 'GOODS_NOT_EXIST');
    assert.equal(out.job.summary.phases.notInSpain, 1);
    assert.equal(out.job.summary.phases.requested, 2);
    assert.equal(out.job.summary.phases.explained, true);
    assert.equal(f.st.runs.length, runsBefore, 'sólo lecturas');
    const kvReads = () => f.st.calls.filter((c) => c.path.includes('/records/SOURCE_SUMMARY')).length;
    const before = kvReads();
    await jobOf(started.job.id);
    assert.equal(kvReads(), before, 'explicado una vez: no se vuelve a leer');
  } finally { f.restore(); }
});

test('el resumen del panel muestra la cuenta hasta los N solicitados y los motivos de los ausentes', () => {
  const panel = fs.readFileSync(path.join('d:/AXEL/WEBS/TRADYLOR/tradylor_web', 'src/pages/upayp1b4.astro'), 'utf8');
  assert.ok(panel.includes("'Solicitados ' + job.limit + ' → la categoría listó '"));
  assert.ok(panel.includes("'Diferencia hasta ' + job.limit + ': '"));
});
