// Regresión: un precio introducido o cambiado por JSON NO se anuncia como verificado ni dispara alertas apoyándose en la
// verificación de un precio anterior; se conserva el histórico de verificación; reimportar sin cambios no invalida una
// verificación vigente; las ofertas adicionales no se tocan. Sin red, sin claves, datos aislados.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedData, readCatalog, writeCatalog, jsonRecord, GTIN } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-verif-');
const importer = await import('../../src/lib/jsonImport/service.ts');
const refresh = await import('../../src/lib/offerRefresh.ts');
const alerts = await import('../../src/lib/priceAlerts.ts');
const { toStructuredProduct } = await import('../../src/data/products.ts');
const { invalidateCatalogCache } = await import('../../src/lib/catalog.ts');

const ago = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const sync = (records) => importer.processChunk({ batchId: 'pv-' + Math.random().toString(36).slice(2, 9), records, defaults: { category: 'Audio' }, dryRun: false, indexOffset: 0 });
const ficha = () => readCatalog(dir)[0];
const main = (over = {}) => jsonRecord(1, { gtin: GTIN, platform: 'amazon', externalId: 'B0VERIF001', url: 'https://www.amazon.es/dp/B0VERIF001', price: 50, capturedAt: ago(30), ...over });
const adapter = (price) => ({ id: 'fake', networks: ['amazon'], resolveSource: (p) => ({ type: 'asin', id: p.asin }), fetch: async () => ({ price, currency: 'EUR', inStock: true, shippingCost: 0, identity: { sourceId: 'B0VERIF001', brand: 'Zeta' } }) });
const verify = (price, iso = null) => refresh.refreshOffers({ ids: [ficha().id], adapters: [adapter(price)], sleep: async () => {}, evaluateAlerts: false, baseDelayMs: 0, runId: 'v-' + Math.random().toString(36).slice(2, 8), now: () => (iso ? new Date(iso) : new Date()) });
const watch = (id) => ({ id, store: 'amazon', title: 'x' });
const currentFor = (id) => { invalidateCatalogCache(); return alerts.resolveCurrentPrice(watch(id)); };

let VERIFIED_AT = '';
/** Ficha de ORIGEN API (sin importMeta ni priceReading) ya verificada por el servicio de actualización. */
async function apiFichaVerified() {
  writeCatalog(dir, [{
    id: 'amazon-b0verif001', title: 'Altavoz Zeta de origen API', description: 'd', price: 50, currency: 'EUR', image: 'https://i.invalid/a.jpg', category: 'Audio', merchant: 'Amazon',
    network: 'amazon', sourceId: 'B0VERIF001', asin: 'B0VERIF001', affiliateUrl: 'https://www.amazon.es/dp/B0VERIF001', pros: [], cons: [], brand: 'Zeta', inStock: true,
  }]);
  VERIFIED_AT = ago(10);
  await verify(50, VERIFIED_AT);
  assert.equal(ficha().lastPriceSync, VERIFIED_AT);
  return ficha();
}

test('ficha NUEVA por JSON: no se anuncia verificada (ni en la web ni en las alertas) hasta que el refresco la verifique', async () => {
  writeCatalog(dir, []);
  sync([main()]);
  const f = ficha();
  assert.equal(f.lastPriceSync, undefined);
  assert.equal(f.extra.refresh, undefined);
  assert.equal(toStructuredProduct(f).pricing.priceLastChecked, undefined, 'la ficha pública no muestra «Precio verificado»');
  assert.equal(currentFor(f.id), null, 'las alertas no se apoyan en un precio sólo recibido por JSON');
  await verify(50); // ahora sí se verifica contra la tienda (después de recibir el JSON)
  assert.equal(toStructuredProduct(ficha()).pricing.priceLastChecked, today());
  assert.ok(currentFor(f.id), 'tras la verificación posterior a la recepción, las alertas pueden usarlo');
  assert.equal(currentFor(f.id).price, 50);
});

test('ficha EXISTENTE de origen API y verificada: un cambio de precio por JSON retira la verificación pública y el apoyo de las alertas, y la conserva como histórico', async () => {
  const f0 = await apiFichaVerified();
  assert.ok(currentFor(f0.id), 'antes del JSON: verificada y apta para alertas');
  const out = sync([main({ price: 30, capturedAt: ago(6) })]);
  assert.equal(out.results[0].outcome, 'updated');
  const f = ficha();
  assert.equal(f.price, 30);
  assert.equal(f.lastPriceSync, undefined, 'el precio nuevo no hereda la fecha de verificación del anterior');
  assert.equal(f.extra.refresh.lastVerifiedAt, undefined);
  assert.equal(toStructuredProduct(f).pricing.priceLastChecked, undefined);
  assert.equal(currentFor(f.id), null, 'alertas: no se apoyan en la verificación del precio anterior (50)');
  // histórico de verificación: conservado, con el precio al que correspondía
  const [before] = f.extra.priceReading.verifiedBefore;
  assert.equal(before.verifiedAt, VERIFIED_AT);
  assert.equal(before.price, 50);
  assert.equal(before.currency, 'EUR');
  assert.equal(f.extra.refresh.status, f0.extra.refresh.status, 'el resto de metadatos del refresco se conserva');
  assert.ok(f.extra.observations.length >= 1, 'las observaciones históricas siguen ahí');
  // el refresco verifica de nuevo: vuelve la verificación pública y las alertas
  await verify(30);
  assert.equal(toStructuredProduct(ficha()).pricing.priceLastChecked, today());
  assert.equal(currentFor(f.id).price, 30);
  assert.equal(ficha().extra.priceReading.verifiedBefore.length, 1, 'el histórico no se pierde');
});

test('reimportar SIN cambios (o con una lectura anterior) no invalida una verificación vigente', async () => {
  const f0 = await apiFichaVerified();
  const keep = () => [ficha().lastPriceSync, ficha().extra.refresh.lastVerifiedAt, ficha().extra.priceReading?.verifiedBefore];
  const before = JSON.stringify(keep());
  // mismo precio, captura posterior
  assert.equal(sync([main({ price: 50, capturedAt: ago(5) })]).results[0].outcome, 'unchanged');
  assert.equal(JSON.stringify(keep()), before);
  // lectura anterior a la verificación (precio distinto): se descarta
  const old = sync([main({ price: 99, capturedAt: ago(12) })]);
  assert.ok(old.results[0].reasons.includes('lectura_anterior_descartada'));
  assert.equal(JSON.stringify(keep()), before);
  // mismo precio repetido varias veces
  for (let i = 0; i < 3; i++) sync([main({ price: 50, capturedAt: ago(5) })]);
  assert.equal(JSON.stringify(keep()), before);
  assert.equal(ficha().price, 50);
  assert.ok(currentFor(f0.id), 'sigue apta para alertas: la verificación vigente no se invalidó');
});

test('un cambio de campos que NO es el precio (disponibilidad/envío) no invalida la verificación; un precio bloqueado por edición manual tampoco', async () => {
  const f0 = await apiFichaVerified();
  const verifiedAt = ficha().lastPriceSync;
  const out = sync([main({ price: 50, availability: 'out_of_stock', shipping: { cost: 3 }, capturedAt: ago(5) })]);
  assert.equal(out.results[0].outcome, 'updated');
  assert.equal(ficha().lastPriceSync, verifiedAt, 'sólo cambió disponibilidad/envío: la verificación del PRECIO sigue vigente');
  // precio bloqueado: la lectura no cambia el precio → nada que invalidar
  writeCatalog(dir, readCatalog(dir).map((p) => ({ ...p, extra: { ...p.extra, lockedFields: ['price'] } })));
  const locked = sync([main({ price: 5, capturedAt: ago(4) })]);
  assert.ok(locked.results[0].reasons.includes('campo_bloqueado_price'));
  assert.equal(ficha().price, 50);
  assert.equal(ficha().lastPriceSync, verifiedAt);
  void f0;
});

test('el histórico de verificación se acumula con cada cambio de precio y se limita a 10 entradas', async () => {
  await apiFichaVerified(); // verificada hace 10 h
  for (let i = 0; i < 12; i++) {
    sync([main({ price: 40 - i, capturedAt: ago(8 - i * 0.5) })]); // cada lectura es posterior a la verificación anterior
    await verify(40 - i, ago(7.75 - i * 0.5));
  }
  const history = ficha().extra.priceReading.verifiedBefore;
  assert.equal(history.length, 10, 'acumulado y acotado a las 10 últimas');
  assert.ok(history.every((h) => h.verifiedAt && Number.isFinite(h.price)));
});

test('las ofertas ADICIONALES no cambian: no usan priceReading ni verificación (fuera de alcance)', () => {
  writeCatalog(dir, []);
  sync([main()]);
  sync([jsonRecord(1, { gtin: GTIN, platform: 'otra', externalId: 'O1', url: 'https://otra.invalid/p/o1', price: 45 })]);
  const f = ficha();
  assert.equal(f.extra.offers.length, 1);
  assert.equal(f.extra.offers[0].verifiedAt, '');
  assert.equal(Object.keys(f.extra.offers[0]).includes('priceReading'), false);
  assert.equal(currentFor(f.id), null, 'la ficha sigue sin verificar (sólo importada)');
});

test('alertas: las fichas SIN priceReading (API, panel, manuales) mantienen su comportamiento actual', () => {
  writeCatalog(dir, [{ id: 'manual-1', title: 'Ficha manual', description: 'd', price: 20, currency: 'EUR', image: 'https://i.invalid/a.jpg', category: 'Audio', merchant: 'Tienda', affiliateUrl: 'https://t.invalid/p', pros: [], cons: [] }]);
  assert.equal(currentFor('manual-1').price, 20);
});
