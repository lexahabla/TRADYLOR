// Enlaces cortos / de afiliado de Temu (temu.to/k/…, share.temu.com/…): reconocimiento, resolución segura en el servidor, conservación
// como ENLACE DE AFILIADO (separado del de origen /es/-g-<id>) e integración con la extracción y la importación.
// Red SIMULADA: ninguna prueba sale a Internet ni gasta créditos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, readCatalog, writeCatalog, apiRequest, jsonOf, mockFetch } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-shortlink-');
const TOKEN = 'apify_api_TOKEN-SHORTLINK-DE-PRUEBA-0123456789';
process.env.APIFY_TOKEN = TOKEN;
for (const k of ['APIFY_MAX_ITEMS', 'APIFY_MAX_RUNS_PER_DAY', 'APIFY_API_BASE']) delete process.env[k];

const sl = await import('../../src/lib/temuShortLink.ts');
const lib = await import('../../src/lib/apify/categoryExtraction.ts');
const temu = await import('../../src/lib/jsonImport/apifyTemu.ts');
const service = await import('../../src/lib/jsonImport/service.ts');
const route = await import('../../src/pages/api/admin/category-extract/index.ts');
const cats = await import('../../src/lib/categories.ts');
cats.writeCategories([{ id: 'c-hogar', name: 'Hogar', slug: 'hogar', icon: 'H', keywords: [], }]);
cats.invalidateCategoriesCache();

const ID = '601101683713758';
const SHORT = 'https://temu.to/k/gk2abc9xyz';
const jobsFile = path.join(dir, 'category-extractions.json');
const resetJobs = () => { fs.rmSync(jobsFile, { force: true }); fs.rmSync(path.join(dir, 'category-extractions'), { recursive: true, force: true }); };

/** Respuesta de redirección simulada. */
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });
/** fetch simulado de Temu: tabla url(sin query) → Response (o función). */
const temuNet = (table, seen = []) => async (url, init = {}) => {
  const u = new URL(String(url));
  seen.push({ url: String(url), init });
  const key = u.origin + u.pathname;
  const hit = table[key];
  if (!hit) return new Response('nope', { status: 404 });
  return typeof hit === 'function' ? hit(u) : hit.clone();
};

test('isTemuShortLink / cleanShortLink: sólo temu.to y share.temu.com con ruta, https y sin credenciales', () => {
  for (const ok of [SHORT, 'https://temu.to/m/abcdef', 'https://share.temu.com/AbC123', 'https://TEMU.TO/k/xyz']) assert.equal(sl.isTemuShortLink(ok), true, ok);
  for (const bad of ['https://temu.to/', 'https://temu.to', 'http://temu.to/k/abc', 'https://evil.example/temu.to/k/abc', 'https://temu.to.evil.example/k/abc', 'https://user:pw@temu.to/k/abc', 'https://www.temu.com/es/-g-' + ID + '.html', 'javascript:alert(1)', '', null, 5]) assert.equal(sl.isTemuShortLink(bad), false, String(bad));
  assert.equal(sl.cleanShortLink('  https://temu.to/k/gk2abc9xyz#frag '), 'https://temu.to/k/gk2abc9xyz');
  assert.equal(sl.cleanShortLink('http://temu.to/k/abc'), '');
});

test('extractGoodsId: ruta -g-<id>.html, goods_id, goodsId y URLs anidadas/codificadas; nada si no hay id', () => {
  assert.equal(sl.extractGoodsId('https://www.temu.com/es/colchoneta-g-' + ID + '.html?x=1'), ID);
  assert.equal(sl.extractGoodsId('https://www.temu.com/goods.html?_bg_fs=1&goods_id=' + ID + '&refer_page_sn=1'), ID);
  assert.equal(sl.extractGoodsId('https://www.temu.com/x?goodsId=' + ID), ID);
  assert.equal(sl.extractGoodsId('https://static-cross.kwcdn.com/ch5/download-page.html?target=' + encodeURIComponent('https://www.temu.com/es/-g-' + ID + '.html?a=b')), ID, 'URL anidada y codificada');
  assert.equal(sl.extractGoodsId('https://app.temu.com/open?link=' + encodeURIComponent(encodeURIComponent('https://www.temu.com/goods.html?goods_id=' + ID))), ID, 'doble codificación');
  assert.equal(sl.extractGoodsId('https://static-cross.kwcdn.com/ch5/download-page.html?_x_ns_adg_stid=2a530b7dac8441af_njrpriz'), undefined);
  assert.equal(sl.extractGoodsId('https://www.temu.com/'), undefined);
  assert.equal(sl.extractGoodsId('goods_id=12345'), undefined, 'ids demasiado cortos no valen');
});

test('resolver: sigue las redirecciones de Temu y devuelve el goodsId; sin cookies ni datos de Treidilor', async () => {
  const seen = [];
  const table = {
    'https://temu.to/k/gk2abc9xyz': redirect('https://share.temu.com/AbC123'),
    'https://share.temu.com/AbC123': redirect('https://www.temu.com/es/colchoneta-termica-g-' + ID + '.html?_x_ads_channel=affiliate&refer_page_sn=1'),
  };
  const r = await sl.resolveTemuShortLink(SHORT, { fetchImpl: temuNet(table, seen) });
  assert.equal(r.ok, true);
  assert.equal(r.goodsId, ID);
  assert.deepEqual(r.chain.map((h) => h.url), ['https://temu.to/k/gk2abc9xyz', 'https://share.temu.com/AbC123']);
  assert.ok(r.chain.every((h) => !h.url.includes('?')), 'la cadena guardada no contiene parámetros de seguimiento');
  for (const s of seen) {
    assert.equal(s.init.redirect, 'manual', 'las redirecciones se siguen a mano, una a una');
    assert.deepEqual(Object.keys(s.init.headers).sort(), ['Accept', 'Accept-Language', 'User-Agent']);
    assert.equal(s.init.credentials, undefined);
    assert.doesNotMatch(JSON.stringify(s.init.headers), new RegExp(TOKEN));
  }
});

test('resolver: el id puede venir en una página intermedia (200) o dentro de la URL de descarga de la app', async () => {
  const viaApp = await sl.resolveTemuShortLink(SHORT, { fetchImpl: temuNet({ 'https://temu.to/k/gk2abc9xyz': redirect('https://static-cross.kwcdn.com/ch5/download-page.html?target=' + encodeURIComponent('https://www.temu.com/goods.html?goods_id=' + ID)) }) });
  assert.equal(viaApp.goodsId, ID);
  const viaHtml = await sl.resolveTemuShortLink(SHORT, { fetchImpl: temuNet({ 'https://temu.to/k/gk2abc9xyz': new Response('<html><script>location.href="https://www.temu.com/es/x-g-' + ID + '.html"</script></html>', { status: 200 }) }) });
  assert.equal(viaHtml.goodsId, ID);
});

test('resolver: seguridad — no sigue destinos fuera de Temu ni http, limita los saltos y explica cada fallo', async () => {
  const seen = [];
  const foreign = await sl.resolveTemuShortLink(SHORT, { fetchImpl: temuNet({ 'https://temu.to/k/gk2abc9xyz': redirect('https://evil.example/steal') }, seen) });
  assert.deepEqual([foreign.ok, foreign.code], [false, 'foreign_host']);
  assert.equal(seen.length, 1, 'no se hizo ninguna petición al destino ajeno');
  const internal = await sl.resolveTemuShortLink(SHORT, { fetchImpl: temuNet({ 'https://temu.to/k/gk2abc9xyz': redirect('https://169.254.169.254/latest/meta-data/') }, seen) });
  assert.equal(internal.code, 'foreign_host');
  const plain = await sl.resolveTemuShortLink(SHORT, { fetchImpl: temuNet({ 'https://temu.to/k/gk2abc9xyz': redirect('http://www.temu.com/es/') }) });
  assert.deepEqual([plain.ok, plain.code], [false, 'foreign_host'], 'una redirección a http no se sigue');
  const loop = await sl.resolveTemuShortLink(SHORT, { fetchImpl: temuNet({ 'https://temu.to/k/gk2abc9xyz': redirect('https://temu.to/k/gk2abc9xyz?n=1') }) });
  assert.equal(loop.code, 'too_many_redirects');
  const blocked = await sl.resolveTemuShortLink(SHORT, { fetchImpl: temuNet({ 'https://temu.to/k/gk2abc9xyz': new Response('{}', { status: 403 }) }) });
  assert.equal(blocked.code, 'blocked');
  const noProduct = await sl.resolveTemuShortLink(SHORT, { fetchImpl: temuNet({ 'https://temu.to/k/gk2abc9xyz': redirect('https://static-cross.kwcdn.com/ch5/download-page.html?_x_ns_adg_stid=abc'), 'https://static-cross.kwcdn.com/ch5/download-page.html': new Response('<html>descarga la app</html>', { status: 200 }) }) });
  assert.equal(noProduct.code, 'no_goods_id');
  assert.match(noProduct.message, /caducado o ser incorrecto/);
  const net = await sl.resolveTemuShortLink(SHORT, { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(net.code, 'network');
  assert.equal((await sl.resolveTemuShortLink('https://www.temu.com/es/-g-' + ID + '.html')).code, 'not_short_link');
});

/* ───────────── Integración: extracción + importación ───────────── */

function fakeApifyAndTemu(opts = {}) {
  const st = { calls: [], posts: [], status: 'RUNNING', temuSeen: [], ...opts };
  const net = temuNet({
    'https://temu.to/k/gk2abc9xyz': redirect('https://www.temu.com/es/colchoneta-g-' + ID + '.html?_x_ads_channel=affiliate'),
    'https://temu.to/k/caducado': redirect('https://static-cross.kwcdn.com/ch5/download-page.html?_x_ns_adg_stid=abc'),
    'https://static-cross.kwcdn.com/ch5/download-page.html': new Response('<html>descarga la app</html>', { status: 200 }),
  }, st.temuSeen);
  const restore = mockFetch(async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== 'api.apify.com') return net(url, init);
    const method = init.method ?? 'GET';
    st.calls.push({ method, path: u.pathname });
    const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (method === 'POST' && /\/v2\/actors\/[^/]+\/runs$/.test(u.pathname)) { st.posts.push(JSON.parse(init.body)); return ok({ data: { id: 'RUNS1', defaultDatasetId: 'DSS1', status: 'READY' } }, 201); }
    if (/\/v2\/actor-runs\/RUNS1$/.test(u.pathname)) return ok({ data: { id: 'RUNS1', status: st.status, defaultDatasetId: 'DSS1', usageTotalUsd: 0.046, finishedAt: new Date().toISOString() } });
    if (/\/v2\/datasets\/DSS1$/.test(u.pathname)) return ok({ data: { itemCount: 1 } });
    if (/\/v2\/datasets\/DSS1\/items$/.test(u.pathname)) return ok(st.items ?? []);
    return ok({}, 404);
  });
  return { st, restore };
}
const esPdp = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'temu-real-sample-es-pdp-1893.json'), 'utf8'));
const post = (body) => route.POST({ request: apiRequest('/api/admin/category-extract', { body, token: true }) });
const get = (qs) => route.GET({ request: apiRequest('/api/admin/category-extract' + qs, { method: 'GET', token: true }), url: new URL('http://localhost/api/admin/category-extract' + qs) });

test('un enlace corto de afiliado se reconoce: se pide la ficha ESPAÑOLA del producto, una sola ejecución, y el enlace se guarda como afiliado', async () => {
  resetJobs();
  const f = fakeApifyAndTemu({ items: esPdp });
  try {
    const res = await post({ source: 'temu', url: SHORT, limit: 10 });
    assert.equal(res.status, 201);
    const { job } = await jsonOf(res);
    assert.equal(job.urlKind, 'product');
    assert.equal(job.limit, 1);
    assert.equal(job.url, 'https://www.temu.com/es/-g-' + ID + '.html', 'enlace de ORIGEN normalizado');
    assert.equal(job.affiliateUrl, SHORT, 'enlace de AFILIADO = el corto que pegó el usuario');
    assert.equal(job.affiliateGoodsId, ID);
    assert.equal(job.twoPhase, undefined);
    assert.deepEqual(f.st.posts[0].startUrls, [{ url: 'https://www.temu.com/es/-g-' + ID + '.html' }], 'Apify nunca recibe el enlace corto');
    assert.equal(f.st.posts[0].maxItems, 1);
    assert.doesNotMatch(JSON.stringify(f.st.posts), /temu\.to/);
    assert.doesNotMatch(fs.readFileSync(jobsFile, 'utf8'), new RegExp(TOKEN));
    f.st.status = 'SUCCEEDED';
    const out = await jsonOf(await get('?id=' + job.id));
    const rec = out.records[0];
    assert.equal(rec.offer.affiliateUrl, SHORT);
    assert.equal(rec.offer.url, esPdp[0].productUrl, 'el de origen sigue siendo la ficha española (productUrl del actor)');
    assert.notEqual(rec.offer.url, rec.offer.affiliateUrl);
    assert.ok(rec.__import.warnings.includes('enlace_de_afiliado_corto_de_temu'));
    assert.ok(!rec.__import.warnings.includes('enlace_de_origen_sin_afiliar'));
    assert.deepEqual(rec.__import.review, []);
  } finally { f.restore(); }
});

test('importación: la ficha queda con el enlace corto como ENLACE DE AFILIADO (activo) y el de origen aparte; un enlace normal sigue pendiente', async () => {
  resetJobs();
  writeCatalog(dir, []);
  const f = fakeApifyAndTemu({ items: esPdp });
  try {
    const { job } = await jsonOf(await post({ source: 'temu', url: SHORT, limit: 1 }));
    f.st.status = 'SUCCEEDED';
    const out = await jsonOf(await get('?id=' + job.id));
    const res = service.processChunk({ batchId: 'short-imp-' + Date.now(), records: out.records, defaults: {}, dryRun: false, indexOffset: 0, target: { category: 'Hogar', categoryId: 'c-hogar' } });
    assert.deepEqual(res.results.map((r) => r.outcome), ['created']);
    const [p] = readCatalog(dir);
    assert.equal(p.affiliateUrl, SHORT);
    assert.equal(p.link_status, 'active', 'con enlace de afiliado real la ficha está activa');
    assert.match(p.extra.sourceUrl, /^https:\/\/www\.temu\.com\/es\//, 'el enlace de origen se conserva aparte');
    assert.notEqual(p.extra.sourceUrl, p.affiliateUrl);
    // sin enlace corto: pendiente, como siempre
    writeCatalog(dir, []);
    const plain = service.processChunk({ batchId: 'short-imp2-' + Date.now(), records: esPdp.map((o) => temu.adaptApifyTemuItem(o, { resolveCategory: () => ({}) })), defaults: {}, dryRun: false, indexOffset: 0, target: { category: 'Hogar', categoryId: 'c-hogar' } });
    assert.deepEqual(plain.results.map((r) => r.outcome), ['created']);
    assert.equal(readCatalog(dir)[0].link_status, 'pending');
  } finally { f.restore(); }
});

test('el mismo producto por su enlace corto otra vez: se detecta que ya existe y, con «solo nuevos», se omite', async () => {
  resetJobs();
  writeCatalog(dir, []);
  const f = fakeApifyAndTemu({ items: esPdp });
  try {
    const first = await jsonOf(await post({ source: 'temu', url: SHORT, limit: 1 }));
    f.st.status = 'SUCCEEDED';
    const out = await jsonOf(await get('?id=' + first.job.id));
    service.processChunk({ batchId: 'short-a-' + Date.now(), records: out.records, defaults: {}, dryRun: false, indexOffset: 0, target: { category: 'Hogar', categoryId: 'c-hogar' } });
    const before = JSON.stringify(readCatalog(dir));
    const again = service.processChunk({ batchId: 'short-b-' + Date.now(), records: out.records, defaults: {}, dryRun: false, indexOffset: 0, onlyNew: true });
    assert.deepEqual(again.results.map((r) => r.reasons[0]), ['ya_existe_omitido']);
    assert.equal(JSON.stringify(readCatalog(dir)), before);
  } finally { f.restore(); }
});

test('enlace corto no reconocible (caducado/incorrecto): 422 con motivo claro, SIN lanzar ninguna ejecución de Apify', async () => {
  resetJobs();
  const f = fakeApifyAndTemu();
  try {
    const res = await post({ source: 'temu', url: 'https://temu.to/k/caducado', limit: 1 });
    assert.equal(res.status, 422);
    const body = await jsonOf(res);
    assert.match(body.message, /No se pudo reconocer el enlace corto de Temu/);
    assert.match(body.message, /caducado o ser incorrecto/);
    assert.match(body.message, /Pega la URL completa del producto/);
    assert.equal(f.st.posts.length, 0, 'no se gastó nada');
  } finally { f.restore(); }
});

test('prueba GRATUITA ?resolve=: dice a qué producto apunta el enlace corto sin llamar a Apify; exige autenticación', async () => {
  const f = fakeApifyAndTemu();
  try {
    const q = '?resolve=' + encodeURIComponent(SHORT);
    const ok = await get(q);
    assert.equal(ok.status, 200);
    const body = await jsonOf(ok);
    assert.deepEqual({ goodsId: body.goodsId, productUrl: body.productUrl, affiliateUrl: body.affiliateUrl }, { goodsId: ID, productUrl: 'https://www.temu.com/es/-g-' + ID + '.html', affiliateUrl: SHORT });
    assert.equal(f.st.calls.length, 0, 'ninguna llamada a Apify');
    const bad = await get('?resolve=' + encodeURIComponent('https://temu.to/k/caducado'));
    assert.equal(bad.status, 422);
    assert.equal((await jsonOf(bad)).code, 'no_goods_id');
    assert.equal((await get('?resolve=' + encodeURIComponent('https://www.amazon.es/dp/B01EXDG2MO'))).status, 422);
    const anon = await route.GET({ request: apiRequest('/api/admin/category-extract' + q, { method: 'GET' }), url: new URL('http://localhost/api/admin/category-extract' + q) });
    assert.equal(anon.status, 401);
  } finally { f.restore(); }
});

test('Amazon, las categorías y las URL de producto normales de Temu no cambian (el enlace corto sólo aplica a temu.to / share.temu.com)', async () => {
  resetJobs();
  const f = fakeApifyAndTemu({ items: esPdp });
  try {
    const { job } = await jsonOf(await post({ source: 'temu', url: 'https://www.temu.com/es/-g-' + ID + '.html', limit: 1 }));
    assert.equal(job.affiliateUrl, undefined);
    f.st.status = 'SUCCEEDED';
    const out = await jsonOf(await get('?id=' + job.id));
    assert.equal(out.records[0].offer.affiliateUrl, undefined);
    assert.ok(out.records[0].__import.warnings.includes('enlace_de_origen_sin_afiliar'));
    assert.equal(f.st.temuSeen.length, 0, 'sin red hacia temu.to');
  } finally { f.restore(); }
});

test('el enlace corto sólo se asigna al producto que resolvió (un id distinto no hereda el enlace)', () => {
  const rec = temu.adaptApifyTemuItem(esPdp[0], { resolveCategory: () => ({}), affiliateUrl: SHORT, affiliateGoodsId: '999999999999999' });
  assert.equal(rec.offer.affiliateUrl, undefined);
  const ok = temu.adaptApifyTemuItem(esPdp[0], { resolveCategory: () => ({}), affiliateUrl: SHORT, affiliateGoodsId: esPdp[0].goodsId });
  assert.equal(ok.offer.affiliateUrl, SHORT);
});
