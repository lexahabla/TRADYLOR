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
    const start = runPosts(f)[0];
    assert.match(start.path, /^\/v2\/actors\/hypebridge~temu-scraper\/runs$/);
    assert.match(start.search, /memory=1024/);
    assert.match(start.search, /maxTotalChargeUsd=0\.375/);
    assert.match(start.search, /timeout=900/);
    assert.doesNotMatch(start.search, new RegExp(TOKEN));
    assert.equal(start.headers.Authorization, `Bearer ${TOKEN}`);
    const sent = JSON.parse(start.body);
    assert.equal(sent.maxItems, 10, 'el límite de Treidilor viaja a Apify como maxItems');
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

test('resultado de Temu: adapta los productos, aplica el límite, informa de parcial y cancela de verdad en Apify', async () => {
  resetJobs();
  let f = fakeApify({ runStatus: 'SUCCEEDED', items: SAMPLE, itemCount: SAMPLE.length });
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 3 }));
    const out = await jsonOf(await get('?id=' + started.job.id));
    assert.equal(out.job.status, 'succeeded');
    assert.equal(out.records.length, 3, 'si el actor devuelve de más se conservan sólo los primeros 3');
    assert.ok(out.job.summary.warnings.some((w) => /devolvio_mas_de_3/.test(w)));
    assert.equal(out.records[0].offer.platform, 'temu');
    assert.equal(out.job.costUsd, 0.25);
    assert.equal(out.job.summary.withReview, 2, 'precio «desde» y precio variable por variante van a revisión');
  } finally { f.restore(); }

  resetJobs();
  f = fakeApify({ runStatus: 'RUNNING', itemCount: 2 });
  try {
    const started = await jsonOf(await post({ source: 'temu', url: CAT, limit: 10 }));
    f.state.items = SAMPLE.slice(0, 2);
    const res = await jsonOf(await post({ action: 'cancel', id: started.job.id }));
    assert.equal(res.success, true);
    f.state.runStatus = 'ABORTED'; // Apify confirma la cancelación
    assert.ok(f.state.calls.some((c) => /actor-runs\/RUNT1\/abort$/.test(c.path)), 'cancelar llama a /abort de Apify');
    const done = await jsonOf(await get('?id=' + started.job.id));
    assert.equal(done.records.length, 2);
    assert.equal(done.job.summary.partial, true);
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

test('el resumen de la extracción informa de las monedas devueltas y detecta que se pidió /es/ pero el actor respondió con otro mercado (muestra real categoría 1893)', async () => {
  resetJobs();
  let f = fakeApify({ runStatus: 'SUCCEEDED', items: REAL_1893, itemCount: 10 });
  try {
    const started = await jsonOf(await post({ source: 'temu', url: 'https://www.temu.com/es/category-o3-1893.html', limit: 10 }));
    const out = await jsonOf(await get('?id=' + started.job.id));
    assert.deepEqual(out.job.summary.currencies, { USD: 10 });
    assert.equal(out.job.summary.marketMismatch, true);
    assert.ok(out.job.summary.warnings.includes('mercado_pedido_es_pero_el_actor_respondio_con_otro'));
    assert.ok(out.records.every((r) => r.__import.review.includes('moneda_no_euro:USD')), 'la validación sigue activa: no se convierte ni se reetiqueta');
    assert.ok(out.records.every((r) => r.offer.currency === 'USD'));
  } finally { f.restore(); }
  resetJobs();
  f = fakeApify({ runStatus: 'SUCCEEDED', items: REAL_ES, itemCount: 3 });
  try {
    const started = await jsonOf(await post({ source: 'temu', url: 'https://www.temu.com/es/category-o3-248.html', limit: 3 }));
    const out = await jsonOf(await get('?id=' + started.job.id));
    assert.deepEqual(out.job.summary.currencies, { EUR: 3 });
    assert.equal(out.job.summary.marketMismatch, false);
  } finally { f.restore(); }
});
