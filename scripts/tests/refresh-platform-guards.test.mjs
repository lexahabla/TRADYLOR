// Protecciones de la automatización por plataforma: parada por autenticación/cuota, lista blanca del programador (activar eBay no consulta Amazon ni Temu),
// estado por plataforma para el panel y su endpoint. Sin red, sin créditos, datos aislados.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, writeCatalog, adminCookie, apiRequest, jsonOf, mockFetch } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-platform-guards-');
delete process.env.SCRAPER_API_KEY;
delete process.env.APIFY_TOKEN;
delete process.env.OFFER_REFRESH_SOURCES;
delete process.env.OFFER_REFRESH_ENABLED;
const restoreNet = mockFetch(() => { throw new Error('PRUEBA: no debe haber ninguna petición de red'); });
test.after(() => restoreNet());

const refresh = await import('../../src/lib/offerRefresh.ts');
const platforms = await import('../../src/lib/refreshPlatforms.ts');
const route = await import('../../src/pages/api/admin/offers/refresh.ts');

const prod = (net, i) => ({ id: `${net}-${i}`, slug: `${net}-${i}`, title: `P ${net} ${i}`, price: 10 + i, category: 'X', network: net, merchant: net, currency: 'EUR', inStock: true, image: '/x.jpg', affiliateUrl: `https://x.invalid/${net}/${i}`, sourceId: `${net}${i}0000000`, extra: {} });
const T0 = new Date('2026-11-10T08:00:00Z');
const sched = (over = {}) => ({ amazon: { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72, ...over } });

test('classifyFailure: autenticación y cuota detienen la fuente; un producto retirado o un precio dudoso no', () => {
  for (const m of ['AliExpress: This publisher is not registered (código 401).', 'ScraperAPI respondió 403: Forbidden', 'Browse API HTTP 401: invalid token', 'Faltan credenciales de eBay', 'Invalid app Key', 'La extracción de categorías no está configurada: falta APIFY_TOKEN en el servidor.', 'ScraperAPI respondió 401 (clave de API inválida — revisa SCRAPER_API_KEY)']) {
    assert.equal(refresh.classifyFailure(m), 'auth', m);
  }
  for (const m of ['ScraperAPI respondió 429 (cuota/límite de peticiones agotado)', 'Se alcanzó el máximo de 20 ejecuciones de Apify al día', 'rate limit']) assert.equal(refresh.classifyFailure(m), 'quota', m);
  for (const m of ['Page Not Found', 'eBay no encuentra este artículo (¿finalizado o retirado?).', 'Precio de Temu no fiable, no se aplica: precio_desde.', 'timeout']) assert.equal(refresh.classifyFailure(m), null, m);
});

test('una fallo de autenticación detiene la fuente: no se insiste con las demás fichas y el programador la deja desactivada con su motivo', async () => {
  writeCatalog(dir, [1, 2, 3].map((i) => prod('amazon', i)));
  fs.rmSync(path.join(dir, 'offer-refresh-runs.json'), { force: true });
  const calls = [];
  const adapter = { id: 'x', networks: ['amazon'], resolveSource: (p) => ({ type: 't', id: p.sourceId }), fetch: async (p) => { calls.push(p.sourceId); throw new refresh.RefreshError('ScraperAPI respondió 401 (clave de API inválida — revisa SCRAPER_API_KEY): api_key=SECRETO', false); } };
  const rep = await refresh.refreshOffers({ onlyDue: true, mode: 'scheduled', schedule: sched(), adapters: [adapter], now: () => T0, sleep: async () => {}, baseDelayMs: 0, betweenMs: 0, evaluateAlerts: false });
  assert.equal(calls.length, 1, 'sólo se llama una vez: el resto de fichas de esa fuente se omite');
  assert.equal(rep.results.length, 3);
  assert.equal(rep.results.filter((r) => r.attempts === 0).length, 2);
  assert.ok(rep.haltedSources.amazon.startsWith('autenticación'));
  assert.doesNotMatch(JSON.stringify(rep.haltedSources), /SECRETO/);
  const cfg = (await refresh.readScheduleConfig()).amazon;
  assert.equal(cfg.enabled, false, 'el programador deja la fuente desactivada');
  assert.match(cfg.pausedReason, /autenticación/);
  assert.ok(cfg.pausedAt);
  assert.deepEqual(refresh.readRunLog().at(-1).byNetwork.amazon, { attempts: 1, ok: 0, errors: 1 }, 'las omitidas no cuentan como consultas');
  assert.doesNotMatch(JSON.stringify(refresh.readRunLog()), /SECRETO/);
  // Volver a habilitarla en el panel limpia la parada.
  const again = await refresh.writeScheduleConfig('amazon', { enabled: true });
  assert.equal(again.amazon.pausedReason, undefined);
  assert.equal(again.amazon.enabled, true);
});

test('en una ejecución MANUAL la fuente también se detiene, pero no se toca su configuración', async () => {
  writeCatalog(dir, [1, 2].map((i) => prod('amazon', i)));
  await refresh.writeScheduleConfig('amazon', { enabled: true });
  const calls = [];
  const adapter = { id: 'x', networks: ['amazon'], resolveSource: (p) => ({ type: 't', id: p.sourceId }), fetch: async (p) => { calls.push(p.sourceId); throw new refresh.RefreshError('Browse API HTTP 429: Too many requests', false); } };
  const rep = await refresh.refreshOffers({ all: true, mode: 'manual', adapters: [adapter], now: () => T0, sleep: async () => {}, baseDelayMs: 0, betweenMs: 0, evaluateAlerts: false });
  assert.equal(calls.length, 1);
  assert.match(rep.haltedSources.amazon, /^cuota/);
  assert.equal((await refresh.readScheduleConfig()).amazon.enabled, true);
});

test('un fallo normal de un producto (retirado) NO detiene la fuente', async () => {
  writeCatalog(dir, [1, 2, 3].map((i) => prod('amazon', i)));
  const calls = [];
  const adapter = { id: 'x', networks: ['amazon'], resolveSource: (p) => ({ type: 't', id: p.sourceId }), fetch: async (p) => { calls.push(p.sourceId); if (p.sourceId.startsWith('amazon1')) throw new refresh.RefreshError('Page Not Found', false); return { price: p.price, currency: 'EUR' }; } };
  const rep = await refresh.refreshOffers({ all: true, mode: 'manual', adapters: [adapter], now: () => T0, sleep: async () => {}, baseDelayMs: 0, betweenMs: 0, evaluateAlerts: false });
  assert.equal(calls.length, 3);
  assert.equal(rep.haltedSources, undefined);
});

test('lista blanca OFFER_REFRESH_SOURCES: activar eBay deja Amazon y Temu fuera aunque estén habilitados; sin la variable no cambia nada', () => {
  const all = { amazon: { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72 }, ebay: { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72 }, temu: { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72 } };
  assert.equal(refresh.applySourceAllowlist(all, undefined), all);
  assert.equal(refresh.applySourceAllowlist(all, '  '), all);
  const only = refresh.applySourceAllowlist(all, 'ebay');
  assert.deepEqual(Object.fromEntries(Object.entries(only).map(([k, v]) => [k, v.enabled])), { amazon: false, ebay: true, temu: false });
  assert.equal(all.amazon.enabled, true, 'no muta la configuración original');
});

test('con la lista blanca en eBay, el programador no consulta Amazon aunque tenga fichas vencidas', async () => {
  writeCatalog(dir, [1, 2].map((i) => prod('amazon', i)).concat([1].map((i) => prod('ebay', i))));
  const calls = [];
  const mk = (n) => ({ id: n, networks: [n], resolveSource: (p) => ({ type: 't', id: p.sourceId }), fetch: async (p) => { calls.push(n); return { price: p.price, currency: 'EUR' }; } });
  const full = { amazon: { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72 }, ebay: { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72 } };
  await refresh.refreshOffers({ onlyDue: true, mode: 'scheduled', schedule: refresh.applySourceAllowlist(full, 'ebay'), adapters: [mk('amazon'), mk('ebay')], now: () => T0, sleep: async () => {}, baseDelayMs: 0, betweenMs: 0, evaluateAlerts: false, dryRun: true });
  // dryRun también llama a la fuente: sólo debe haberse consultado eBay.
  assert.deepEqual([...new Set(calls)], ['ebay']);
});

test('estado por plataforma: pendiente de credenciales, error de autorización, adaptador no cargado, desactivada, detenida y activa', () => {
  const products = [prod('amazon', 1), prod('amazon', 2), prod('aliexpress', 1), prod('ebay', 1), prod('temu', 1)].map((p) => (p.network === 'temu' ? { ...p, sourceId: '601099500000001' } : p));
  const ad = (n) => ({ id: n, networks: [n], resolveSource: (p) => (p.network === n ? { type: 't', id: p.sourceId } : null), fetch: async () => ({}) });
  const base = { products, adapters: [ad('amazon'), ad('ebay'), ad('aliexpress')], runs: [{ runId: 'r', mode: 'scheduled', startedAt: T0.toISOString(), total: 1, updated: 0, verified: 0, errors: 1, noSource: 0, review: 0, byNetwork: {}, errorSamples: ['ebay: Browse API HTTP 500: api_key=SECRETO'] }], attemptsToday: { amazon: 4 }, schedulerEnabled: false };
  const s = (over) => Object.fromEntries(platforms.buildPlatformStatuses({ ...base, ...over }).map((p) => [p.network, p]));
  const cfg = (en, extra = {}) => ({ enabled: en, everyHours: 24, batchSize: 10, maxAgeHours: 72, ...extra });
  const r = s({
    schedule: { amazon: cfg(true, { maxPerDay: 10 }), ebay: cfg(false), aliexpress: cfg(false), temu: cfg(false) },
    connections: { amazon: { status: 'connected' }, ebay: { status: 'connected' }, aliexpress: { status: 'error', detail: 'AliExpress: This publisher is not registered (código 401).' }, temu: { status: 'pending' } },
  });
  assert.equal(r.amazon.stateLabel, 'Conectada (programador apagado)');
  assert.equal(r.amazon.attemptsToday, 4);
  assert.equal(r.amazon.consumedToday, 20, '4 consultas × 5 créditos (estimación)');
  assert.equal(r.amazon.withSource, 2);
  assert.equal(r.ebay.stateLabel, 'Desactivada');
  assert.equal(r.aliexpress.stateLabel, 'Error de autorización');
  assert.match(r.aliexpress.needs.join(' '), /publisher/);
  assert.equal(r.temu.stateLabel, 'Pendiente de credenciales');
  assert.match(r.temu.needs.join(' '), /APIFY_TOKEN/);
  assert.match(r.temu.needs.join(' '), /OFFER_REFRESH_EXTRA_SOURCES=temu/, 'adaptador no cargado');
  assert.deepEqual(r.ebay.recentErrors, ['ebay: Browse API HTTP 500: api_key=***'], 'errores recientes saneados');
  const active = s({ schedule: { amazon: cfg(true), ebay: cfg(true), aliexpress: cfg(false), temu: cfg(false) }, connections: { amazon: { status: 'connected' }, ebay: { status: 'connected' } }, schedulerEnabled: true });
  assert.equal(active.ebay.stateLabel, 'Activa');
  const paused = s({ schedule: { amazon: cfg(false, { pausedReason: 'autenticación: clave inválida' }), ebay: cfg(true), aliexpress: cfg(false), temu: cfg(false) }, connections: { amazon: { status: 'connected' }, ebay: { status: 'connected' } } });
  assert.equal(paused.amazon.stateLabel, 'Detenida: autenticación: clave inválida');
  const noAdapter = s({ schedule: { amazon: cfg(true), ebay: cfg(true), aliexpress: cfg(false), temu: cfg(false) }, adapters: [ad('amazon')], connections: { amazon: { status: 'connected' }, ebay: { status: 'connected' } } });
  assert.equal(noAdapter.ebay.stateLabel, 'Desactivada (adaptador no cargado)');
  assert.match(noAdapter.ebay.needs.join(' '), /OFFER_REFRESH_EXTRA_SOURCES=ebay/);
});

test('GET /api/admin/offers/refresh devuelve las cuatro plataformas, el consumo y la lista blanca, sólo a administradores', async () => {
  writeCatalog(dir, [prod('amazon', 1), prod('ebay', 1)]);
  const denied = await route.GET({ request: apiRequest('/api/admin/offers/refresh', { method: 'GET' }) });
  assert.equal(denied.status, 401);
  process.env.OFFER_REFRESH_SOURCES = 'ebay';
  const res = await route.GET({ request: apiRequest('/api/admin/offers/refresh', { method: 'GET', cookie: await adminCookie() }) });
  delete process.env.OFFER_REFRESH_SOURCES;
  const body = await jsonOf(res);
  assert.equal(res.status, 200);
  assert.deepEqual(body.platforms.map((p) => p.network), ['amazon', 'aliexpress', 'ebay', 'temu']);
  assert.equal(body.allowlist, 'ebay');
  assert.equal(body.platforms[0].connection, 'pendiente_credenciales', 'sin SCRAPER_API_KEY');
  assert.equal(body.schedulerEnabled, false);
  assert.doesNotMatch(JSON.stringify(body), /clave-de-prueba|secreto/i);
});

test('el panel pinta la tabla por plataforma con textContent (sin HTML dinámico) y ya no hay un selector sólo de Amazon', () => {
  const src = fs.readFileSync(new URL('../../src/pages/upayp1b4.astro', import.meta.url), 'utf8');
  assert.match(src, /id="offerRefreshPlatforms"/);
  assert.match(src, /function renderOfferRefreshPlatforms\(data\)/);
  assert.doesNotMatch(src, /selRefreshEvery/);
  const block = src.slice(src.indexOf('function renderOfferRefreshPlatforms'), src.indexOf('async function loadOfferRefreshStatus'));
  assert.doesNotMatch(block, /innerHTML/);
});
