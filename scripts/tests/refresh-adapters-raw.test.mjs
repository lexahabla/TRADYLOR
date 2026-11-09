// Adaptadores de actualización con RESPUESTAS SIMULADAS representativas de cada API (eBay Browse, AliExpress afiliados, ScraperAPI/Amazon):
// lectura correcta, producto retirado, autenticación, cuota y moneda distinta. Ninguna prueba sale a Internet ni gasta créditos.
// Estas pruebas NO sustituyen a una validación con la API real (eBay sí se validó en producción; AliExpress, Amazon y Temu no).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedData, mockFetch } from './_helpers.mjs';

setupIsolatedData('treidilor-adapters-raw-');
process.env.SCRAPER_API_KEY = 'clave-de-prueba-0123456789abcdef';
process.env.ALIEXPRESS_APP_KEY = '123456';
process.env.ALIEXPRESS_APP_SECRET = 'secreto-de-prueba-0123456789abcdef';
delete process.env.SCRAPER_API_TLD;
delete process.env.SCRAPER_API_COUNTRY_CODE;

const refresh = await import('../../src/lib/offerRefresh.ts');
const extra = await import('../../src/lib/offerRefreshExtra.ts');
(await import('../../src/lib/networks/credentials.ts')).saveCredentials('ebay', { clientId: 'cliente-de-prueba', clientSecret: 'secreto-de-prueba', campaignId: '5338000000' });

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let restore = () => {};
const net = (handler) => { restore(); restore = mockFetch(async (u, init) => handler(String(u), init)); };
test.afterEach(() => restore());

/* ───────── eBay (Browse API) ───────── */
const EBAY_ITEM = { title: 'CARGADOR HP SPECTRE 13-V 65W', price: { value: '20.99', currency: 'EUR' }, estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK' }], shippingOptions: [{ shippingCost: { value: '0.00', currency: 'EUR' } }], condition: 'Nuevo', seller: { username: 'portatilmovil' } };
const ebayNet = (itemResponse) => net((u) => (u.includes('/identity/v1/oauth2/token') ? json(200, { access_token: 'tok-simulado' }) : itemResponse(u)));
const ebayProduct = { id: 'e1', network: 'ebay', sourceId: 'v1|327196281174|0' };
const ebaySource = extra.ebayAdapter.resolveSource(ebayProduct);

test('eBay: precio, moneda, stock y envío de una respuesta Browse real', async () => {
  ebayNet(() => json(200, EBAY_ITEM));
  const r = await extra.ebayAdapter.fetch(ebayProduct, ebaySource);
  assert.deepEqual({ price: r.price, currency: r.currency, inStock: r.inStock, shippingCost: r.shippingCost }, { price: 20.99, currency: 'EUR', inStock: true, shippingCost: 0 });
});

test('eBay: envío de pago, agotado y sin precio no se inventan datos', async () => {
  ebayNet(() => json(200, { ...EBAY_ITEM, estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'OUT_OF_STOCK' }], shippingOptions: [{ shippingCost: { value: '4.49', currency: 'EUR' } }] }));
  const a = await extra.ebayAdapter.fetch(ebayProduct, ebaySource);
  assert.equal(a.inStock, false);
  assert.equal(a.shippingCost, 4.49);
  ebayNet(() => json(200, { title: 'x', estimatedAvailabilities: [] }));
  const b = await extra.ebayAdapter.fetch(ebayProduct, ebaySource);
  assert.equal(b.price, null);
  assert.equal(b.inStock, null, 'sin dato de disponibilidad = desconocido, no «agotado»');
  assert.equal(b.shippingCost, null);
});

test('eBay: artículo retirado (404), autenticación (401 / OAuth) y cuota (429) se clasifican y no se reintentan a ciegas', async () => {
  ebayNet(() => json(404, { errors: [{ message: 'not found' }] }));
  await assert.rejects(() => extra.ebayAdapter.fetch(ebayProduct, ebaySource), (e) => e.retryable === false && /retirado|finalizado/i.test(e.message));
  ebayNet(() => json(401, { errors: [{ message: 'Invalid access token' }] }));
  await assert.rejects(() => extra.ebayAdapter.fetch(ebayProduct, ebaySource), (e) => e.retryable === false && refresh.classifyFailure(e.message) === 'auth');
  net(() => json(401, { error: 'invalid_client' }));
  await assert.rejects(() => extra.ebayAdapter.fetch(ebayProduct, ebaySource), (e) => e.retryable === false && refresh.classifyFailure(e.message) === 'auth');
  ebayNet(() => json(429, { errors: [{ message: 'Too many requests' }] }));
  await assert.rejects(() => extra.ebayAdapter.fetch(ebayProduct, ebaySource), (e) => refresh.classifyFailure(e.message) === 'quota');
});

/* ───────── AliExpress (API de afiliados) ───────── */
const aliBody = (products, code = 200, msg = 'call succeeded') => ({ aliexpress_affiliate_productdetail_get_response: { resp_result: { resp_code: code, resp_msg: msg, result: { products: { product: products } } } } });
const aliProduct = { id: 'a1', network: 'aliexpress', sourceId: '1005005981278915' };
const aliSource = extra.aliexpressAdapter.resolveSource(aliProduct);

test('AliExpress: precio en EUR del anuncio pedido (y sólo de ése)', async () => {
  net(() => json(200, aliBody([{ product_id: '999', target_sale_price: '1.00' }, { product_id: '1005005981278915', product_title: 'Cable USB-C', target_sale_price: '2.99', target_original_price: '5.00' }])));
  const r = await extra.aliexpressAdapter.fetch(aliProduct, aliSource);
  assert.deepEqual({ price: r.price, originalPrice: r.originalPrice, currency: r.currency, inStock: r.inStock, shippingCost: r.shippingCost }, { price: 2.99, originalPrice: 5, currency: 'EUR', inStock: null, shippingCost: null });
});

test('AliExpress: «This publisher is not registered» (401) = autenticación, sin reintentos; anuncio ausente = retirado', async () => {
  net(() => json(200, aliBody([], 401, 'This publisher is not registered')));
  await assert.rejects(() => extra.aliexpressAdapter.fetch(aliProduct, aliSource), (e) => e.retryable === false && refresh.classifyFailure(e.message) === 'auth' && /401/.test(e.message));
  net(() => json(200, aliBody([{ product_id: '111', target_sale_price: '3.00' }])));
  await assert.rejects(() => extra.aliexpressAdapter.fetch(aliProduct, aliSource), (e) => e.retryable === false && /retirado/i.test(e.message));
  net(() => json(200, { error_response: { code: 29, msg: 'Invalid app Key' } }));
  await assert.rejects(() => extra.aliexpressAdapter.fetch(aliProduct, aliSource), (e) => e.retryable === false && refresh.classifyFailure(e.message) === 'auth');
});

/* ───────── Amazon (ScraperAPI) ───────── */
const amzProduct = { id: 'm1', network: 'amazon', asin: 'B0GR1FC3TR', sourceId: 'B0GR1FC3TR' };
const amzSource = refresh.amazonAdapter.resolveSource(amzProduct);

test('Amazon: precio europeo con miles, disponibilidad y una sola petición a amazon.es', async () => {
  const calls = [];
  net((u) => { calls.push(u); return json(200, { name: 'Portátil Apple MacBook Pro', pricing: '3.089,00€', availability_status: 'In Stock', asin: 'B0GR1FC3TR' }); });
  const r = await refresh.amazonAdapter.fetch(amzProduct, amzSource);
  assert.equal(r.price, 3089);
  assert.equal(r.inStock, true);
  assert.equal(r.shippingCost, null, 'ScraperAPI no entrega el envío de forma fiable: desconocido');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).searchParams.get('tld'), 'es');
});

test('Amazon: clave inválida o 403 = autenticación; 429 = cuota; ASIN inexistente = fallo definitivo de ese producto', async () => {
  net(() => new Response('Invalid API key', { status: 401 }));
  await assert.rejects(() => refresh.amazonAdapter.fetch(amzProduct, amzSource), (e) => e.retryable === false && refresh.classifyFailure(e.message) === 'auth');
  net(() => new Response('Forbidden', { status: 403 }));
  await assert.rejects(() => refresh.amazonAdapter.fetch(amzProduct, amzSource), (e) => e.retryable === false && refresh.classifyFailure(e.message) === 'auth');
  net(() => new Response('Too many requests', { status: 429 }));
  await assert.rejects(() => refresh.amazonAdapter.fetch(amzProduct, amzSource), (e) => refresh.classifyFailure(e.message) === 'quota');
  net(() => json(404, { error: 'Page Not Found' }));
  await assert.rejects(() => refresh.amazonAdapter.fetch(amzProduct, amzSource), (e) => e.retryable === false && refresh.classifyFailure(e.message) === null);
});

/* ───────── Circuito completo con el servicio real (almacén en memoria) ───────── */
const memory = (list) => ({ current: list, store: null });
const mkStore = (m) => ({ read: () => structuredClone(m.current), write: (n) => { m.current = structuredClone(n); return true; } });
const ebayFicha = () => ({ id: 'e1', slug: 'e1', title: 'Cargador HP Spectre', price: 20.99, category: 'Informática', network: 'ebay', merchant: 'ebay', currency: 'EUR', inStock: true, image: '/x.jpg', affiliateUrl: 'https://www.ebay.es/itm/327196281174', sourceId: 'v1|327196281174|0', extra: {} });
const T1 = new Date('2026-11-10T10:00:00Z');
const T2 = new Date('2026-11-11T10:00:00Z');
const runEbay = (m, now, extraOpts = {}) => refresh.refreshOffers({ ids: ['e1'], adapters: [extra.ebayAdapter], store: mkStore(m), now: () => now, sleep: async () => {}, baseDelayMs: 0, evaluateAlerts: false, ...extraOpts });

test('eBay de extremo a extremo: lectura verificada, envío separado, historial sin duplicar y bajada verificada sólo con lectura previa comparable', async () => {
  const m = memory([ebayFicha()]);
  ebayNet(() => json(200, { ...EBAY_ITEM, price: { value: '20.99', currency: 'EUR' } }));
  const r1 = await runEbay(m, T1);
  assert.equal(r1.results[0].dropSignal, false, 'la primera lectura no puede ser una «bajada»');
  assert.equal(m.current[0].extra.observations.length, 1);
  assert.equal(m.current[0].extra.observations[0].shippingCost, 0);
  assert.equal(m.current[0].price, 20.99);
  // misma jornada, misma lectura: se renueva la verificación, no se duplica
  ebayNet(() => json(200, EBAY_ITEM));
  await runEbay(m, new Date(T1.getTime() + 3 * 3600_000));
  assert.equal(m.current[0].extra.observations.length, 1);
  assert.equal(m.current[0].priceHistory.filter((p) => p.date === '2026-11-10').length, 1);
  // al día siguiente baja de precio con una lectura previa comparable → bajada verificada
  ebayNet(() => json(200, { ...EBAY_ITEM, price: { value: '18.99', currency: 'EUR' } }));
  const r3 = await runEbay(m, T2);
  assert.equal(r3.results[0].dropSignal, true);
  assert.equal(m.current[0].price, 18.99);
  assert.ok(m.current[0].extra.priceSignal, 'la señal alimenta el indicador «Ha bajado de precio»');
  assert.deepEqual(m.current[0].priceHistory.map((p) => p.price), [20.99, 18.99]);
});

test('una moneda distinta no se aplica ni genera bajada (va a revisión) y un error conserva el último valor válido', async () => {
  const m = memory([ebayFicha()]);
  ebayNet(() => json(200, { ...EBAY_ITEM, price: { value: '9.99', currency: 'USD' } }));
  const r = await runEbay(m, T1);
  assert.equal(r.results[0].status, 'review');
  assert.equal(m.current[0].price, 20.99);
  assert.equal(m.current[0].extra.priceSignal, undefined);
  ebayNet(() => json(500, { errors: [] }));
  const r2 = await runEbay(m, T2, { maxAttempts: 1 });
  assert.equal(r2.results[0].status, 'error');
  assert.equal(m.current[0].price, 20.99, 'un fallo de la fuente no cambia el precio');
});
