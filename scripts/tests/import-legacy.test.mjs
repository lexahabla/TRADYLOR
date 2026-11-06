// Fichas ANTIGUAS (creadas antes de `extra.offerSeller`) y conservación de identificadores y atributos de variante
// al reimportar, actualizar o vincular ofertas. Sólo lectura/escritura del catálogo aislado de prueba (sin red ni IA).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedData, readCatalog, writeCatalog, jsonRecord, GTIN } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-legacy-');
const service = await import('../../src/lib/jsonImport/service.ts');
const { getOffers } = await import('../../src/lib/catalogOffers.ts');
let seq = 0;
const run = (records, defaults = { category: 'Audio' }) =>
  service.processChunk({ batchId: `legacy-${++seq}-${Date.now()}`, records, defaults, dryRun: false, indexOffset: 0 });
const outcome = (out) => out.results.map((r) => r.outcome);

/** Ficha ANTIGUA: sin `extra.offerSeller` (así eran todas antes de recordar el vendedor de la oferta principal). */
function legacyFicha(over = {}) {
  run([jsonRecord(1, { platform: 'temu', externalId: '701000000000001', url: 'https://www.temu.com/es/-g-701000000000001.html', price: 20, ...over })]);
  const [p] = readCatalog(dir);
  delete p.extra.offerSeller;
  writeCatalog(dir, [p]);
  return p;
}

test('ficha antigua sin offerSeller: reimportar el mismo registro SIN vendedor no la toca ni duplica la oferta', () => {
  writeCatalog(dir, []);
  const before = legacyFicha();
  const again = run([jsonRecord(1, { platform: 'temu', externalId: '701000000000001', url: 'https://www.temu.com/es/-g-701000000000001.html', price: 20 })]);
  assert.deepEqual(outcome(again), ['unchanged']);
  const after = readCatalog(dir);
  assert.equal(after.length, 1);
  assert.equal(getOffers(after[0]).length, 1);
  assert.equal(after[0].price, before.price);
});

test('ficha antigua sin offerSeller: actualizar su precio (sin vendedor) actualiza la oferta existente, no crea otra', () => {
  writeCatalog(dir, []);
  legacyFicha();
  const upd = run([jsonRecord(1, { platform: 'temu', externalId: '701000000000001', url: 'https://www.temu.com/es/-g-701000000000001.html', price: 17.5, capturedAt: '2026-10-07T10:00:00Z' })]);
  assert.deepEqual(outcome(upd), ['updated']);
  const [p] = readCatalog(dir);
  assert.equal(p.price, 17.5);
  assert.equal(getOffers(p).length, 1);
});

test('ficha antigua sin offerSeller: reimportar el anuncio CON vendedor conserva la oferta antigua intacta y añade la del vendedor (decisión conservadora, sin fusiones inseguras)', () => {
  writeCatalog(dir, []);
  const before = legacyFicha();
  const withSeller = run([jsonRecord(1, { platform: 'temu', externalId: '701000000000001', url: 'https://www.temu.com/es/-g-701000000000001.html', price: 22, sellerName: 'Tienda Oficial', sellerId: 'S1', capturedAt: '2026-10-07T10:00:00Z' })]);
  assert.deepEqual(outcome(withSeller), ['linked']);
  assert.deepEqual(withSeller.results[0].reasons, ['mismo_anuncio_otro_vendedor']);
  const [p] = readCatalog(dir);
  assert.equal(readCatalog(dir).length, 1, 'misma ficha, sin duplicar fichas');
  assert.equal(p.price, before.price, 'la oferta antigua (campos planos) no se modifica');
  assert.equal(p.title, before.title);
  const offers = getOffers(p);
  assert.equal(offers.length, 2);
  assert.ok(offers.some((o) => o.implicit && o.price === 20), 'la oferta antigua sigue ahí');
  assert.ok(offers.some((o) => o.sellerName === 'Tienda Oficial' && o.price === 22));
  // y reimportar esa misma oferta con vendedor ya NO la duplica
  const again = run([jsonRecord(1, { platform: 'temu', externalId: '701000000000001', url: 'https://www.temu.com/es/-g-701000000000001.html', price: 22, sellerName: 'Tienda Oficial', sellerId: 'S1', capturedAt: '2026-10-07T10:00:00Z' })]);
  assert.deepEqual(outcome(again), ['unchanged']);
  assert.equal(getOffers(readCatalog(dir)[0]).length, 2);
});

test('ficha antigua de Amazon: el vendedor «Amazon» (la propia plataforma) sigue siendo la oferta existente, sin duplicar', () => {
  writeCatalog(dir, []);
  run([jsonRecord(2, { platform: 'amazon', externalId: undefined, asin: 'B0LEGACY01', url: 'https://www.amazon.es/dp/B0LEGACY01', price: 50 })]);
  const again = run([jsonRecord(2, { platform: 'amazon', externalId: undefined, asin: 'B0LEGACY01', url: 'https://www.amazon.es/dp/B0LEGACY01', price: 50, sellerName: 'Amazon' })]);
  assert.deepEqual(outcome(again), ['unchanged']);
  assert.equal(getOffers(readCatalog(dir)[0]).length, 1);
});

/* ───────────── Identificadores y atributos de variante ───────────── */

function ficha() {
  writeCatalog(dir, []);
  run([jsonRecord(3, { gtin: GTIN, mpn: 'MPN-ORIGINAL', brand: 'Zeta', color: 'Negro', capacity: '128GB', platform: 'tienda', externalId: 'V3', url: 'https://tienda.invalid/v/3', price: 40 })]);
  const [p] = readCatalog(dir);
  assert.equal(p.extra.identifiers.gtin, GTIN, 'precondición: identificadores guardados');
  assert.equal(p.extra.variantAttributes.color, 'Negro');
  return p;
}

test('identificadores y atributos de variante se conservan al ACTUALIZAR la oferta con datos distintos', () => {
  const before = ficha();
  const out = run([jsonRecord(3, { gtin: GTIN, mpn: 'MPN-OTRO', brand: 'Zeta', color: 'Negro', capacity: '128GB', platform: 'tienda', externalId: 'V3', url: 'https://tienda.invalid/v/3', price: 35, capturedAt: '2026-10-07T10:00:00Z' })]);
  assert.ok(['updated', 'unchanged'].includes(out.results[0].outcome), JSON.stringify(out.results[0]));
  const [p] = readCatalog(dir);
  assert.deepEqual(p.extra.identifiers, before.extra.identifiers, 'el mpn ya guardado no se sustituye');
  assert.deepEqual(p.extra.variantAttributes, before.extra.variantAttributes);
});

test('identificadores y atributos de variante se conservan al VINCULAR otra oferta (otro comercio)', () => {
  const before = ficha();
  const link = run([jsonRecord(3, { gtin: GTIN, mpn: 'MPN-ORIGINAL', brand: 'Zeta', color: 'Negro', capacity: '128GB', platform: 'otra', externalId: 'O3', url: 'https://otra.invalid/3', price: 38 })]);
  assert.equal(link.results[0].outcome, 'linked');
  const [p] = readCatalog(dir);
  assert.equal(readCatalog(dir).length, 1);
  assert.deepEqual(p.extra.identifiers, before.extra.identifiers);
  assert.deepEqual(p.extra.variantAttributes, before.extra.variantAttributes);
  assert.equal(getOffers(p).length, 2);
});

test('una variante distinta (otro color/capacidad) NO sobrescribe ni se fusiona con la ficha: ficha propia o revisión', () => {
  const before = ficha();
  const other = run([jsonRecord(3, { gtin: GTIN, mpn: 'MPN-ORIGINAL', brand: 'Zeta', color: 'Rojo', capacity: '256GB', platform: 'otra', externalId: 'O4', url: 'https://otra.invalid/4', price: 60 })]);
  assert.notEqual(other.results[0].outcome, 'linked', 'mismo GTIN con atributos distintos no se vincula');
  const original = readCatalog(dir).find((x) => x.id === before.id);
  assert.deepEqual(original.extra.variantAttributes, before.extra.variantAttributes);
  assert.deepEqual(original.extra.identifiers, before.extra.identifiers);
});

test('los identificadores AUSENTES se completan sin tocar los presentes; un campo protegido no se pisa', () => {
  writeCatalog(dir, []);
  run([jsonRecord(5, { brand: undefined, platform: 'tienda', externalId: 'V5', url: 'https://tienda.invalid/v/5', price: 10 })]);
  let [p] = readCatalog(dir);
  p.extra.lockedFields = ['brand'];
  writeCatalog(dir, [p]);
  const out = run([jsonRecord(5, { gtin: GTIN, mpn: 'MPN-NUEVO', brand: 'MarcaNueva', platform: 'tienda', externalId: 'V5', url: 'https://tienda.invalid/v/5', price: 10 })]);
  assert.ok(['updated', 'unchanged'].includes(out.results[0].outcome));
  [p] = readCatalog(dir);
  assert.equal(p.extra.identifiers.gtin, GTIN, 'se completa el que faltaba');
  assert.equal(p.extra.identifiers.mpn, 'MPN-NUEVO');
  assert.notEqual(p.brand, 'MarcaNueva', 'la marca está protegida');
});
