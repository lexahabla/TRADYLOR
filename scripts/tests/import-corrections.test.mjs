// CORRECCIÓN CONTROLADA DEL IMPORTADOR (09/11/2026): regresión de los seis problemas diagnosticados + fecha de referencia del envío.
// Datos sintéticos aislados, sin red. No se modifican fichas existentes ni el esquema (todo aditivo en `extra`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedData, writeCatalog, readCatalog, jsonRecord, importRecords } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-import-corrections-');
const { normalizeCondition } = await import('../../src/lib/jsonImport/normalize.ts');
const { explainReason } = await import('../../src/lib/jsonImport/reasonLabels.ts');
const { getComparableOffers } = await import('../../src/lib/comparableOffers.ts');
const base = (over = {}) => jsonRecord(1, { externalId: 'A1', url: 'https://tienda.invalid/z/A1', condition: 'new', color: 'negro', capturedAt: '2026-11-01T10:00:00Z', ...over });
const fresh = async (seed = []) => { writeCatalog(dir, []); if (seed.length) await importRecords(seed); };
const tag = (r) => r.outcome + ':' + r.reasons.join('+');

test('1 · «Abierto, sin usar» y «Open box» son una condición propia (ni nuevo ni usado)', () => {
  assert.equal(normalizeCondition('Abierto, sin usar'), 'open_box');
  assert.equal(normalizeCondition('Open box'), 'open_box');
  assert.equal(normalizeCondition('Caja abierta'), 'open_box');
  assert.equal(normalizeCondition('Nuevo'), 'new');
  assert.equal(normalizeCondition('Usado'), 'used');
  assert.equal(normalizeCondition('Reacondicionado'), 'refurbished');
});

test('1b · una ficha creada «abierto, sin usar» guarda esa condición y no se actualiza con un registro «nuevo»', async () => {
  await fresh();
  await importRecords([base({ externalId: 'OB1', url: 'https://tienda.invalid/z/OB1', condition: 'Abierto, sin usar' })]);
  assert.equal(readCatalog(dir)[0].condition, 'Abierto, sin usar');
  const r = await importRecords([base({ externalId: 'OB1', url: 'https://tienda.invalid/z/OB1', condition: 'new', price: 20 })]);
  assert.equal(r.results[0].outcome, 'review');
  assert.match(r.results[0].reasons[0], /^condicion_distinta:open_box≠new/);
});

test('2 · un registro de otra condición, o sin condición, no actualiza el precio de una ficha con condición conocida', async () => {
  await fresh([base()]);
  const open = await importRecords([base({ condition: 'Abierto, sin usar', price: 25 })]);
  assert.match(tag(open.results[0]), /^review:condicion_distinta:new≠open_box/);
  const none = await importRecords([base({ condition: undefined, price: 25 })]);
  assert.equal(none.results[0].outcome, 'review');
  assert.deepEqual(none.results[0].reasons, ['condicion_no_verificable']);
  assert.equal(readCatalog(dir)[0].price, 31, 'el precio original no se tocó');
  const same = await importRecords([base({ price: 29 })]);
  assert.match(tag(same.results[0]), /^updated:precio/);
});

test('2b · una ficha sin condición no acepta de forma automática un registro usado, pero sí uno nuevo', async () => {
  await fresh([base({ condition: undefined })]);
  assert.equal((await importRecords([base({ condition: 'used', price: 12 })])).results[0].outcome, 'review');
  assert.equal((await importRecords([base({ condition: 'new', price: 29 })])).results[0].outcome, 'updated');
});

test('3 · al crear se conservan el coste de envío, «gratis», el plazo y la fecha de referencia', async () => {
  await fresh();
  await importRecords([base({ externalId: 'E6', url: 'https://tienda.invalid/z/E6', shipping: { cost: 3.5, free: false, days: 4 } })]);
  const p = readCatalog(dir)[0];
  assert.equal(p.shippingDays, 4);
  assert.deepEqual(p.extra.priceReading.shipping, { cost: 3.5, free: false, days: 4, asOf: '2026-11-01T10:00:00.000Z' });
  const s = getComparableOffers(p).offers[0].shipping;
  assert.equal(s.cost, 3.5);
  assert.equal(s.free, null, 'free:false no afirma nada');
  assert.equal(s.asOf, '2026-11-01T10:00:00.000Z');
  assert.equal(getComparableOffers(p).offers[0].totalPrice, Math.round((p.price + 3.5) * 100) / 100);
  await fresh();
  await importRecords([base({ externalId: 'E7', url: 'https://tienda.invalid/z/E7', shipping: { free: true } })]);
  const g = readCatalog(dir)[0];
  assert.equal(g.freeShipping, true);
  assert.equal(getComparableOffers(g).offers[0].shipping.free, true);
});

test('3b · sin datos de envío no se inventa nada; con fecha de captura inferida no se registra fecha de referencia', async () => {
  await fresh();
  await importRecords([base({ externalId: 'E8', url: 'https://tienda.invalid/z/E8' })]);
  assert.equal(readCatalog(dir)[0].extra.priceReading.shipping, undefined);
  await fresh();
  await importRecords([base({ externalId: 'E9', url: 'https://tienda.invalid/z/E9', capturedAt: undefined, shipping: { cost: 2, days: 3 } })]);
  const sh = readCatalog(dir)[0].extra.priceReading.shipping;
  assert.equal(sh.cost, 2);
  assert.equal(sh.asOf, undefined);
});

test('3c · reimportar con un coste de envío nuevo lo actualiza y renueva la fecha de referencia', async () => {
  await fresh();
  await importRecords([base({ externalId: 'E10', url: 'https://tienda.invalid/z/E10', shipping: { cost: 3.5, days: 4 } })]);
  const r = await importRecords([base({ externalId: 'E10', url: 'https://tienda.invalid/z/E10', capturedAt: '2026-11-05T10:00:00Z', shipping: { cost: 1.99, days: 2 } })]);
  assert.match(tag(r.results[0]), /^updated:.*envio_coste/);
  const p = readCatalog(dir)[0];
  assert.equal(p.extra.priceReading.shipping.cost, 1.99);
  assert.equal(p.extra.priceReading.shipping.asOf, '2026-11-05T10:00:00.000Z');
});

test('4 · mismo anuncio repetido en el lote con precios contradictorios: se conserva el primero y el segundo va a revisión', async () => {
  await fresh();
  const r = await importRecords([base({ externalId: 'B2', url: 'https://tienda.invalid/z/B2', price: 30 }), base({ externalId: 'B2', url: 'https://tienda.invalid/z/B2', price: 20 })]);
  assert.equal(r.results[0].outcome, 'created');
  assert.equal(r.results[1].outcome, 'review');
  assert.equal(r.results[1].reasons[0], 'anuncio_repetido_en_lote_con_precio_distinto:30≠20');
  assert.equal(readCatalog(dir)[0].price, 30);
  assert.equal(readCatalog(dir).length, 1);
});

test('4b · el mismo anuncio repetido con el mismo precio no es contradicción', async () => {
  await fresh();
  const r = await importRecords([base({ externalId: 'B3', url: 'https://tienda.invalid/z/B3', price: 30 }), base({ externalId: 'B3', url: 'https://tienda.invalid/z/B3', price: 30 })]);
  assert.equal(r.results[1].outcome, 'unchanged');
});

test('5 · los motivos de revisión llegan con texto comprensible (y los códigos no cambian)', async () => {
  await fresh([base()]);
  const r = await importRecords([base({ currency: 'USD', price: 35 })]);
  assert.equal(r.results[0].reasons[0], 'moneda_distinta:EUR≠USD');
  assert.match(r.results[0].reasonTexts[0], /Moneda distinta: la ficha está en EUR y el registro en USD/);
  assert.match(explainReason('condicion_distinta:new≠used'), /«nuevo».*«usado»/);
  assert.match(explainReason('anuncio_con_vendedor_distinto:A≠B'), /un solo vendedor/);
  assert.equal(explainReason('codigo_desconocido'), 'codigo_desconocido');
});

test('6 · al crear: título casi idéntico con GTIN contradictorio, o sin marca en ninguna de las dos, no crea una ficha duplicada', async () => {
  await fresh([base({ gtin: '4006381333931' })]);
  const g = await importRecords([base({ externalId: 'A2', url: 'https://tienda.invalid/z/A2', gtin: '4006381333948' })]);
  assert.equal(g.results[0].outcome, 'review');
  assert.equal(g.results[0].reasons[0], 'titulo_parecido_con_identificadores_contradictorios');
  assert.match(g.results[0].reasonTexts[0], /podría ser otro producto/);
  await fresh([base({ brand: undefined })]);
  const nb = await importRecords([base({ brand: undefined, externalId: 'A9', url: 'https://tienda.invalid/z/A9' })]);
  assert.equal(nb.results[0].outcome, 'review');
  assert.equal(readCatalog(dir).length, 1);
});

test('6b · modelos distintos con título diferente siguen pudiéndose crear', async () => {
  await fresh([base()]);
  const r = await importRecords([jsonRecord(7, { externalId: 'Z7', url: 'https://tienda.invalid/z/Z7', title: 'Cafetera de goteo Omega 900 inox' })]);
  assert.equal(r.results[0].outcome, 'created');
});

test('7 · la oferta vinculada (otro vendedor) guarda el envío con su fecha de referencia', async () => {
  await fresh([base({ sellerName: 'Vendedor X' })]);
  const r = await importRecords([base({ sellerName: 'Vendedor Y', price: 28, shipping: { cost: 2.5, days: 3 }, capturedAt: '2026-11-03T10:00:00Z' })]);
  assert.equal(r.results[0].outcome, 'linked');
  const offer = readCatalog(dir)[0].extra.offers[0];
  assert.deepEqual(offer.shipping, { cost: 2.5, free: null, days: 3, asOf: '2026-11-03T10:00:00.000Z' });
});
