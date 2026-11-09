// CARACTERIZACIÓN: cómo interactúan offerIdentity, reimportMerge, offerObservations y offerRefresh
// con `extra.offers`. Conservar las ofertas al guardar NO demuestra que su refresco, histórico o
// alertas estén integrados: estas pruebas documentan lo que FUNCIONA y lo que está PENDIENTE
// (las pruebas «LIMITACIÓN» fijan el comportamiento actual; no amplían ninguna función).
// Servicios externos simulados: sin red, sin claves, sin créditos; datos aislados.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, writeCatalog, readCatalog, jsonRecord, importRecords, GTIN } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-offint-');
delete process.env.OFFER_REFRESH_ENABLED;
const importer = await import('../../src/lib/jsonImport/service.ts');
const identity = await import('../../src/lib/offerIdentity.ts');
const merge = await import('../../src/lib/reimportMerge.ts');
const observations = await import('../../src/lib/offerObservations.ts');
const refresh = await import('../../src/lib/offerRefresh.ts');
const history = await import('../../src/lib/priceHistory.ts');
const catalogOffers = await import('../../src/lib/catalogOffers.ts');

const sync = (records, defaults = { category: 'Audio' }) =>
  importer.processChunk({ batchId: 'oi-' + Math.random().toString(36).slice(2, 9), records, defaults, dryRun: false, indexOffset: 0 });
const ficha = () => readCatalog(dir)[0];
const noSleep = async () => {};

/** Ficha de Amazon (oferta principal) + oferta adicional de otro comercio. */
function seedAmazon() {
  writeCatalog(dir, []);
  sync([jsonRecord(1, { gtin: GTIN, platform: 'amazon', externalId: 'B0INTEG001', url: 'https://www.amazon.es/dp/B0INTEG001', brand: 'Zeta', price: 50 })]);
  sync([jsonRecord(1, { gtin: GTIN, platform: 'otra', externalId: 'OTRA-1', url: 'https://otra.invalid/p/o1', sellerName: 'OtraShop', price: 45, capturedAt: '2026-10-06T10:00:00Z' })]);
  assert.equal(ficha().extra.offers.length, 1);
  return ficha();
}

const fakeAdapter = (readings, calls = { n: 0 }) => ({
  calls,
  adapter: {
    id: 'fake', networks: ['amazon'],
    resolveSource: (p) => (p.asin ? { type: 'asin', id: p.asin } : null),
    fetch: async () => { const r = readings[Math.min(calls.n, readings.length - 1)]; calls.n++; return r; },
  },
});
const reading = (price) => ({ price, currency: 'EUR', inStock: true, shippingCost: 0, identity: { sourceId: 'B0INTEG001', brand: 'Zeta' } });

/* ───────────────────────── offerIdentity ───────────────────────── */

test('FUNCIONA · offerIdentity: la misma oferta recibida por API o por JSON tiene la misma clave', () => {
  const key = (o) => catalogOffers.computeOfferKey(o);
  assert.equal(key({ platform: 'aliexpress', externalId: 'AE-100500123' }), key({ platform: 'aliexpress', externalId: '100500123' }), 'AE- ≡ id numérico');
  assert.equal(key({ platform: 'ebay', externalId: 'v1|123456789012|0' }), key({ platform: 'ebay', externalId: '123456789012' }), 'itemId de eBay');
  assert.notEqual(key({ platform: 'amazon', externalId: 'B0X', sellerName: 'FooShop' }), key({ platform: 'amazon', externalId: 'B0X' }), 'vendedor distinto = oferta distinta');
  assert.equal(key({ platform: 'amazon', externalId: 'B0X', sellerName: 'Amazon' }), key({ platform: 'amazon', externalId: 'B0X' }), 'el vendedor «Amazon» es la plataforma');
  assert.equal(identity.offerKey({ network: 'amazon', externalId: 'B0X' }), key({ platform: 'amazon', externalId: 'B0X' }), 'misma función base');
});

test('LIMITACIÓN · offerIdentity.offerKey devuelve «» sin id externo; las ofertas sin id usan una clave por URL definida en catalogOffers', () => {
  assert.equal(identity.offerKey({ network: 'tienda', externalId: '' }), '');
  assert.match(catalogOffers.computeOfferKey({ platform: 'tienda', canonicalUrl: 'tienda.invalid/p/1' }), /^tienda:url:tienda\.invalid\/p\/1$/);
});

/* ───────────────────────── reimportMerge ───────────────────────── */

test('FUNCIONA · reimportMerge conserva extra.offers (por la fusión de extra, no por una lista protegida)', () => {
  assert.equal(merge.TRACKING_EXTRA_KEYS.includes('offers'), false, '`offers` no está entre las claves de seguimiento protegidas');
  const old = { id: 'a', price: 1, extra: { offers: [{ offerKey: 'x:1' }], observations: [{ p: 1 }], lockedFields: ['verdict'] } };
  const merged = merge.mergeReimport(old, { id: 'a', price: 2, extra: { 'Campo propio': 'v' } });
  assert.deepEqual(merged.extra.offers, [{ offerKey: 'x:1' }]);
  assert.deepEqual(merged.extra.observations, [{ p: 1 }]);
  assert.equal(merged.price, 2);
});

test('LIMITACIÓN · si un canal enviara su propio extra.offers, mergeReimport lo SUSTITUIRÍA (ningún canal actual lo hace)', () => {
  const old = { id: 'a', extra: { offers: [{ offerKey: 'x:1' }] } };
  const merged = merge.mergeReimport(old, { id: 'a', extra: { offers: [{ offerKey: 'y:2' }] } });
  assert.deepEqual(merged.extra.offers, [{ offerKey: 'y:2' }], 'sin protección específica');
});

test('FUNCIONA · un campo bloqueado (lockedFields) frena la actualización de precio de la oferta principal y se informa', () => {
  const f = seedAmazon();
  writeCatalog(dir, [{ ...f, extra: { ...f.extra, lockedFields: ['price'] } }]);
  const out = sync([jsonRecord(1, { gtin: GTIN, platform: 'amazon', externalId: 'B0INTEG001', url: 'https://www.amazon.es/dp/B0INTEG001', price: 10, capturedAt: '2026-10-08T10:00:00Z' })]);
  assert.ok(out.results[0].reasons.includes('campo_bloqueado_price'));
  assert.equal(ficha().price, 50, 'el precio bloqueado no cambia');
});

test('FUNCIONA · recepción ≠ observación ≠ verificación: el importador NO escribe lastPriceSync (fecha de VERIFICACIÓN que muestran la ficha y el checkout)', async () => {
  const { toStructuredProduct } = await import('../../src/data/products.ts');
  writeCatalog(dir, []);
  sync([jsonRecord(1, { gtin: GTIN, platform: 'amazon', externalId: 'B0INTEG001', url: 'https://www.amazon.es/dp/B0INTEG001', price: 50, capturedAt: '2026-10-01T10:00:00Z' })]);
  assert.equal(ficha().lastPriceSync, undefined, 'al crear la ficha no se afirma ninguna verificación');
  assert.equal(toStructuredProduct(ficha()).pricing.priceLastChecked, undefined, 'la capa pública no muestra «Precio verificado»');
  sync([jsonRecord(1, { gtin: GTIN, platform: 'amazon', externalId: 'B0INTEG001', url: 'https://www.amazon.es/dp/B0INTEG001', price: 40, capturedAt: '2026-10-09T10:00:00Z' })]);
  assert.equal(ficha().price, 40);
  assert.equal(ficha().lastPriceSync, undefined, 'tampoco al actualizar el precio por JSON');
  // Ofertas adicionales: tres fechas distintas
  sync([jsonRecord(1, { gtin: GTIN, platform: 'otra', externalId: 'OTRA-1', url: 'https://otra.invalid/p/o1', capturedAt: '2026-10-05T10:00:00Z' })]);
  const offer = ficha().extra.offers[0];
  assert.equal(new Date(offer.capturedAt).toISOString(), '2026-10-05T10:00:00.000Z', 'OBSERVACIÓN: la fecha que da la fuente');
  assert.ok(offer.receivedAt && Date.parse(offer.receivedAt) > Date.parse('2026-10-06'), 'RECEPCIÓN: cuándo la recibió Treidilor');
  assert.equal(offer.verifiedAt, '', 'VERIFICACIÓN: vacía; sólo la fijará el servicio de actualización');
});

test('FUNCIONA · sin fecha en el JSON, la observación se marca como INFERIDA (= recepción) y sigue sin haber verificación', () => {
  writeCatalog(dir, []);
  sync([jsonRecord(1, { gtin: GTIN })]);
  sync([jsonRecord(1, { gtin: GTIN, platform: 'otra', externalId: 'OTRA-1', url: 'https://otra.invalid/p/o1', capturedAt: undefined })]);
  const offer = ficha().extra.offers[0];
  assert.equal(offer.capturedAtInferred, true);
  assert.equal(offer.verifiedAt, '');
  assert.equal(ficha().lastPriceSync, undefined);
});

test('FUNCIONA · sólo el servicio de actualización fija lastPriceSync (verificación); entonces la capa pública sí muestra la fecha', async () => {
  const { toStructuredProduct } = await import('../../src/data/products.ts');
  const f = seedAmazon();
  assert.equal(f.lastPriceSync, undefined);
  const { adapter } = fakeAdapter([reading(48)]);
  await refresh.refreshOffers({ ids: [f.id], adapters: [adapter], sleep: noSleep, evaluateAlerts: false, baseDelayMs: 0, runId: 'lp-1', now: () => new Date('2026-10-12T10:00:00Z') });
  assert.equal(new Date(ficha().lastPriceSync).toISOString().slice(0, 10), '2026-10-12');
  assert.equal(toStructuredProduct(ficha()).pricing.priceLastChecked, '2026-10-12');
});

/* ───────────────────────── offerObservations ───────────────────────── */

test('LIMITACIÓN · el importador JSON no escribe observaciones ni señal de bajada (ni para la oferta principal ni para las adicionales)', () => {
  seedAmazon();
  sync([jsonRecord(1, { gtin: GTIN, platform: 'amazon', externalId: 'B0INTEG001', url: 'https://www.amazon.es/dp/B0INTEG001', price: 30, capturedAt: '2026-10-10T10:00:00Z' })]);
  sync([jsonRecord(1, { gtin: GTIN, platform: 'otra', externalId: 'OTRA-1', url: 'https://otra.invalid/p/o1', sellerName: 'OtraShop', price: 20, capturedAt: '2026-10-10T10:00:00Z' })]);
  assert.deepEqual(refresh.readObservations(ficha()), []);
  assert.equal(refresh.readSignal(ficha()), null, 'una bajada de precio por JSON no genera «Bajó de X a Y»');
});

test('FUNCIONA · las observaciones son por oferta y contexto (vendedor, variante, estado, moneda): el diseño admite varias ofertas', () => {
  const ctx = (merchantId) => ({ currency: 'EUR', destination: 'ES', merchantId, variantId: null, condition: 'new' });
  assert.notEqual(observations.contextKey(ctx('a')), observations.contextKey(ctx('b')));
  assert.notEqual(observations.contextKey({ ...ctx('a'), condition: 'used' }), observations.contextKey(ctx('a')));
});

/* ───────────────────────── offerRefresh ───────────────────────── */

test('FUNCIONA / LIMITACIÓN · el refresco actualiza SÓLO la oferta principal; extra.offers queda intacto (sin refrescar ni caducar)', async () => {
  const f = seedAmazon();
  const offersBefore = JSON.stringify(f.extra.offers);
  const { adapter, calls } = fakeAdapter([reading(48)]);
  const report = await refresh.refreshOffers({ ids: [f.id], adapters: [adapter], sleep: noSleep, evaluateAlerts: false, baseDelayMs: 0, runId: 'r-1', now: () => new Date('2026-10-12T10:00:00Z') });
  assert.equal(report.updated, 1);
  assert.equal(calls.n, 1, 'una sola consulta por ficha (la de la oferta principal)');
  const after = ficha();
  assert.equal(after.price, 48, 'la oferta principal se refrescó');
  assert.equal(JSON.stringify(after.extra.offers), offersBefore, 'las ofertas adicionales no se tocan: ni precio ni verifiedAt');
  assert.equal(refresh.readObservations(after).length, 1, 'se registra la observación de la oferta principal');
  assert.equal(refresh.readObservations(after)[0].context.merchantId ?? null, null, 'sin relación con el vendedor de las ofertas adicionales');
});

test('FUNCIONA · una lectura de JSON anterior a la última VERIFICACIÓN no pisa el precio verificado; una posterior lo cambia y retira la verificación (conservada como histórico)', async () => {
  const f = seedAmazon();
  const { adapter } = fakeAdapter([reading(48)]);
  await refresh.refreshOffers({ ids: [f.id], adapters: [adapter], sleep: noSleep, evaluateAlerts: false, baseDelayMs: 0, runId: 'r-2', now: () => new Date('2026-10-12T10:00:00Z') });
  const verifiedAt = ficha().lastPriceSync;
  assert.equal(ficha().price, 48);
  const old = sync([jsonRecord(1, { gtin: GTIN, platform: 'amazon', externalId: 'B0INTEG001', url: 'https://www.amazon.es/dp/B0INTEG001', price: 99, capturedAt: '2026-10-11T10:00:00Z' })]);
  assert.equal(old.results[0].outcome, 'unchanged');
  assert.ok(old.results[0].reasons.includes('lectura_anterior_descartada'));
  assert.equal(ficha().price, 48);
  assert.equal(ficha().lastPriceSync, verifiedAt, 'una lectura descartada no invalida la verificación');
  const newer = sync([jsonRecord(1, { gtin: GTIN, platform: 'amazon', externalId: 'B0INTEG001', url: 'https://www.amazon.es/dp/B0INTEG001', price: 44, capturedAt: '2026-10-13T10:00:00Z' })]);
  assert.equal(newer.results[0].outcome, 'updated');
  assert.equal(ficha().price, 44);
  assert.equal(ficha().lastPriceSync, undefined, 'el precio nuevo NO hereda la verificación del anterior');
  assert.equal(ficha().extra.refresh.lastVerifiedAt, undefined);
  const before = ficha().extra.priceReading.verifiedBefore;
  assert.equal(before.length, 1, 'la verificación anterior se conserva como histórico');
  assert.equal(before[0].verifiedAt, verifiedAt);
  assert.equal(before[0].price, 48, 'con el precio al que se refería');
});

test('FUNCIONA / LIMITACIÓN · fichas de otros comercios quedan «sin origen» (no gastan créditos); las de Amazon creadas por JSON SÍ son elegibles para el refresco', async () => {
  writeCatalog(dir, []);
  sync([jsonRecord(1, { platform: 'tienda', externalId: 'T1', url: 'https://tienda.invalid/p/t1' })]);
  sync([jsonRecord(2, { platform: 'amazon', externalId: 'B0INTEG002', url: 'https://www.amazon.es/dp/B0INTEG002' })]);
  const fetched = [];
  const adapter = { id: 'fake', networks: ['amazon'], resolveSource: (p) => (p.asin ? { type: 'asin', id: p.asin } : null), fetch: async (p) => { fetched.push(p.asin); return { price: 20, currency: 'EUR', inStock: true, shippingCost: 0, identity: { sourceId: 'B0INTEG002', brand: 'Zeta' } }; } };
  const report = await refresh.refreshOffers({ all: true, adapters: [adapter], sleep: noSleep, evaluateAlerts: false, baseDelayMs: 0, runId: 'r-3', now: () => new Date('2026-10-12T10:00:00Z') });
  assert.deepEqual(fetched, ['B0INTEG002'], 'sólo la ficha de Amazon se consulta');
  assert.equal(report.noSource, 1, 'la de «tienda» queda sin origen');
});

test('FUNCIONA · el programador automático sigue APAGADO sin OFFER_REFRESH_ENABLED y el importador nunca lo invoca', () => {
  const realTimeout = globalThis.setTimeout, realInterval = globalThis.setInterval;
  let timers = 0;
  globalThis.setTimeout = (...a) => { timers++; return realTimeout(...a); };
  globalThis.setInterval = (...a) => { timers++; return realInterval(...a); };
  try {
    delete process.env.OFFER_REFRESH_ENABLED;
    refresh.startOfferRefreshScheduler();
    assert.equal(timers, 0, 'no se programa nada');
    sync([jsonRecord(9)]);
    assert.equal(refresh.getRefreshStatus().running, false, 'importar no lanza ningún refresco');
  } finally { globalThis.setTimeout = realTimeout; globalThis.setInterval = realInterval; }
});

/* ───────────────────────── histórico y alertas ───────────────────────── */

test('LIMITACIÓN · ningún módulo lee extra.offers fuera del importador: no hay refresco, histórico, alertas ni vista pública de esas ofertas', () => {
  const root = path.resolve(import.meta.dirname, '../../src');
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|astro)$/.test(e.name) && /extra\??\.offers|\.extra\?\.offers|extra\.offers/.test(fs.readFileSync(full, 'utf8'))) hits.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  // Etapa 1 (09/11/2026): lib/comparableOffers.ts es un lector NUEVO y de SÓLO LECTURA (capa del futuro comparador; no escribe ni toca
  // refresco, observaciones o alertas). Se añade aquí de forma explícita para que el aviso siga cumpliendo su función con cualquier otro lector.
  const allowed = ['lib/catalogOffers.ts', 'lib/comparableOffers.ts', 'lib/jsonImport/engine.ts', 'lib/jsonImport/types.ts', 'lib/deletedIdentity.ts'];
  assert.deepEqual(hits.filter((h) => !allowed.includes(h)), [], 'si aparece otro lector, revisar su integración con refresco, observaciones y alertas');
});

test('LIMITACIÓN · el histórico de precio (priceHistory) y las alertas usan sólo el precio de la oferta principal', async () => {
  const f = seedAmazon();
  const { mergePoint } = history;
  assert.equal(typeof mergePoint, 'function');
  // recordPricePoint registra el precio plano de la ficha (no el de extra.offers)
  history.recordPricePoint(f.id, ficha().price);
  await history.flushPriceHistory();
  const after = ficha();
  assert.equal(after.priceHistory.at(-1).price, after.price);
  assert.ok(!JSON.stringify(after.priceHistory).includes('45'), 'el precio 45 de la oferta adicional no entra en el histórico');
});

// REGRESIÓN (antes `todo`): flushPriceHistory escribía con `await` y compartía products.json.tmp con el resto de escritores.
test('REGRESIÓN · flushPriceHistory con escritores simultáneos: products.json sigue siendo válido y se conservan el histórico y lo escrito por los demás', async () => {
  writeCatalog(dir, []);
  sync([jsonRecord(1)]);
  const f = ficha();
  history.recordPricePoint(f.id, f.price);
  // 40 escritores síncronos que ceden el turno entre sí (setImmediate) mientras se vuelca el histórico
  const others = Array.from({ length: 40 }, (_, i) => new Promise((resolve) => setImmediate(() => { sync([jsonRecord(200 + i)]); resolve(); })));
  const flushing = history.flushPriceHistory();
  await Promise.all([flushing, ...others]);
  const raw = fs.readFileSync(path.join(dir, 'products.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), 'products.json válido');
  const all = readCatalog(dir);
  assert.equal(all.length, 41, 'ninguna ficha escrita por los demás se pierde');
  assert.equal(all.find((p) => p.id === f.id).priceHistory.at(-1).price, f.price, 'el punto de histórico se conserva');
  assert.equal(fs.existsSync(path.join(dir, 'products.json.tmp')), false, 'no queda temporal huérfano');
});

test('REGRESIÓN · flushPriceHistory sólo toca priceHistory: precio, ofertas y ediciones cambiados mientras el punto esperaba en la cola se conservan', async () => {
  seedAmazon();
  const f = ficha();
  history.recordPricePoint(f.id, f.price); // el visitante vio este precio
  // mientras el punto está en cola: una importación cambia el precio y vincula otra oferta, y alguien edita el título
  sync([jsonRecord(1, { gtin: GTIN, platform: 'amazon', externalId: 'B0INTEG001', url: 'https://www.amazon.es/dp/B0INTEG001', price: 9, capturedAt: '2026-10-20T10:00:00Z' })]);
  sync([jsonRecord(1, { gtin: GTIN, platform: 'cuarta', externalId: 'CUA-1', url: 'https://cuarta.invalid/p/c1' })]);
  writeCatalog(dir, readCatalog(dir).map((p) => (p.id === f.id ? { ...p, title: 'Título editado a mano' } : p)));
  await history.flushPriceHistory();
  const after = ficha();
  assert.equal(after.price, 9, 'el precio actual no se pisa');
  assert.equal(after.extra.offers.length, 2, 'las ofertas se conservan');
  assert.equal(after.title, 'Título editado a mano', 'la edición se conserva');
  assert.equal(after.priceHistory.at(-1).price, f.price, 'y el punto de histórico (precio visto al registrar) se añade');
});

test('REGRESIÓN · ningún otro escritor usa products.json.tmp de forma insegura (sólo jsonStore, síncrono)', () => {
  const root = path.resolve(import.meta.dirname, '../../src');
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|astro)$/.test(e.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (/DATA_FILE_PATH\}\.tmp|products\.json\.tmp|fsp\.(writeFile|rename)\([^)]*DATA_FILE_PATH/.test(text)) hits.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, [], 'sólo jsonStore.writeJsonArrayFile (síncrono) debe producir el temporal del catálogo, y lo hace con la ruta recibida');
  const store = fs.readFileSync(path.join(root, 'lib/jsonStore.ts'), 'utf8');
  assert.match(store, /writeFileSync\(tmpFile/);
  assert.match(store, /renameSync\(tmpFile/);
});
