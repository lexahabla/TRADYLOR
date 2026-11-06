// Regresión del 404 «ScraperAPI respondió con el estado 404» en «Obtener JSON»: el dominio de Amazon (tld) debe viajar
// SIEMPRE explícito y alineado con el país; los errores del proveedor se traducen sin reenviar HTML ni la clave.
// Proveedor SIMULADO (ninguna prueba sale a Internet ni gasta créditos). La verificación real se hizo aparte, a mano.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedData, apiRequest, jsonOf, mockFetch } from './_helpers.mjs';

setupIsolatedData('treidilor-scrape-');
process.env.SCRAPER_API_KEY = 'clave-de-prueba-0123456789abcdef';
delete process.env.SCRAPER_API_COUNTRY_CODE;
delete process.env.SCRAPER_API_TLD;

const route = await import('../../src/pages/api/scrape.ts');
const { resolveAmazonMarket } = await import('../../src/lib/scraperMarket.ts');
const { scrapeAmazonProduct } = await import('../../src/lib/amazonImport.ts');

const get = (asin = 'B01EXDG2MO') => route.GET({ request: apiRequest('/api/scrape?asin=' + asin, { method: 'GET', token: true }), url: new URL('http://localhost/api/scrape?asin=' + asin) });
const provider = (status, body, isJson = true) => new Response(isJson ? JSON.stringify(body) : body, { status, headers: { 'Content-Type': isJson ? 'application/json' : 'text/html' } });

function capture(response) {
  const calls = [];
  const restore = mockFetch(async (u) => { calls.push(String(u)); return typeof response === 'function' ? response(String(u)) : response; });
  return { calls, restore };
}
const query = (u) => new URL(u).searchParams;

test('sin variables: tld=es y country_code=es explícitos, retry_404 y el ASIN validado', async () => {
  const c = capture(provider(200, { name: 'TP-Link', pricing: '24,99€' }));
  try {
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal((await jsonOf(res)).name, 'TP-Link');
  } finally { c.restore(); }
  assert.equal(c.calls.length, 1);
  const q = query(c.calls[0]);
  assert.equal(new URL(c.calls[0]).pathname, '/structured/amazon/product/v1');
  assert.equal(q.get('asin'), 'B01EXDG2MO');
  assert.equal(q.get('tld'), 'es');
  assert.equal(q.get('country_code'), 'es');
  assert.equal(q.get('retry_404'), 'true');
});

test('CAUSA RAÍZ: con SCRAPER_API_COUNTRY_CODE=us la petición sigue yendo a amazon.es (tld=es) y alinea el país', async () => {
  process.env.SCRAPER_API_COUNTRY_CODE = 'us';
  const c = capture(provider(200, { name: 'x' }));
  try { await get(); } finally { c.restore(); delete process.env.SCRAPER_API_COUNTRY_CODE; }
  const q = query(c.calls[0]);
  assert.equal(q.get('tld'), 'es', 'sin tld explícito ScraperAPI usaría amazon.com para country_code=us (404 «Page Not Found»)');
  assert.equal(q.get('country_code'), 'es', 'país del proxy coherente con la tienda (el precio varía según el país)');
});

test('SCRAPER_API_TLD configurable y override de país por llamada', () => {
  process.env.SCRAPER_API_TLD = 'de';
  assert.deepEqual(resolveAmazonMarket(), { tld: 'de', countryCode: 'de' });
  delete process.env.SCRAPER_API_TLD;
  assert.deepEqual(resolveAmazonMarket('us'), { tld: 'com', countryCode: 'us' });
  assert.deepEqual(resolveAmazonMarket('uk'), { tld: 'co.uk', countryCode: 'uk' });
  assert.deepEqual(resolveAmazonMarket(), { tld: 'es', countryCode: 'es' });
});

test('404 del proveedor (página «Page Not Found» de Amazon): mensaje claro, sin HTML ni clave, con dominio y estado', async () => {
  const html = '<!doctype html><html><head><title> Page Not Found </title></head><body>api_key=clave-de-prueba-0123456789abcdef</body></html>';
  const c = capture(provider(404, { message: html }));
  let res; try { res = await get('B09B8V1LZ3'); } finally { c.restore(); }
  assert.equal(res.status, 404);
  const text = JSON.stringify(await jsonOf(res));
  const body = JSON.parse(text);
  assert.match(body.error, /Amazon no encontró el ASIN B09B8V1LZ3 en amazon\.es/);
  assert.equal(body.providerStatus, 404);
  assert.equal(body.domain, 'amazon.es');
  assert.doesNotMatch(text, /<html|doctype|clave-de-prueba/i, 'ni HTML del proveedor ni la clave');
  assert.equal(c.calls.length, 1, 'una sola llamada: sin reintentos que gasten créditos');
});

test('otros errores del proveedor: clave rechazada, cuota, bloqueo y red; nunca se filtra la clave', async () => {
  for (const [status, re, expected] of [[401, /rechazó la clave/, 502], [403, /rechazó la clave/, 502], [429, /límite|créditos/, 429], [500, /estado 500/, 502]]) {
    const c = capture(provider(status, 'oops', false));
    let res; try { res = await get(); } finally { c.restore(); }
    assert.equal(res.status, expected);
    const body = await jsonOf(res);
    assert.match(body.error, re);
    assert.equal(c.calls.length, 1);
  }
  const c = capture(async (u) => { throw new Error('ECONNRESET ' + u); });
  let res; try { res = await get(); } finally { c.restore(); }
  assert.equal(res.status, 502);
  const text = JSON.stringify(await jsonOf(res));
  assert.match(text, /No se pudo contactar con ScraperAPI/);
  assert.doesNotMatch(text, /clave-de-prueba/);
  const ok = capture(provider(200, 'no-json', false));
  try { res = await get(); } finally { ok.restore(); }
  assert.equal(res.status, 502, '200 sin JSON = página de bloqueo');
});

test('auth y validación previas: sin token 401 y ASIN inválido 400, sin llamar al proveedor', async () => {
  const c = capture(provider(200, {}));
  try {
    const noAuth = await route.GET({ request: apiRequest('/api/scrape?asin=B01EXDG2MO', { method: 'GET' }), url: new URL('http://localhost/api/scrape?asin=B01EXDG2MO') });
    assert.equal(noAuth.status, 401);
    const bad = await get('corto');
    assert.equal(bad.status, 400);
  } finally { c.restore(); }
  assert.equal(c.calls.length, 0);
});

test('la importación existente (scrapeAmazonProduct) usa el mismo dominio explícito', async () => {
  process.env.SCRAPER_API_COUNTRY_CODE = 'us';
  const c = capture(provider(200, { name: 'x', pricing: '1,00€' }));
  try { await scrapeAmazonProduct('B01EXDG2MO', { maxRetries: 1 }); } finally { c.restore(); delete process.env.SCRAPER_API_COUNTRY_CODE; }
  assert.equal(c.calls.length, 1);
  const q = query(c.calls[0]);
  assert.equal(q.get('tld'), 'es');
  assert.equal(q.get('country_code'), 'es');
});
