// Fichas ANTIGUAS (creadas antes de `extra.offerSeller`) y conservación de identificadores y atributos de variante
// al reimportar, actualizar o vincular ofertas. Sólo lectura/escritura del catálogo aislado de prueba (sin red ni IA).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

/* ───────────── «Sólo productos nuevos»: lo que ya existe no se vuelve a incluir ni se toca ───────────── */

const runNew = (records, onlyNew = true, extra = {}) =>
  service.processChunk({ batchId: `onlynew-${++seq}-${Date.now()}`, records, defaults: { category: 'Audio' }, dryRun: extra.dryRun ?? false, indexOffset: 0, onlyNew, target: extra.target });

test('sólo nuevos: un producto que ya existe se OMITE (no se actualiza), el nuevo se crea y el catálogo no cambia para el existente', () => {
  writeCatalog(dir, []);
  run([jsonRecord(11, { price: 50 })]);
  const before = JSON.stringify(readCatalog(dir));
  const out = runNew([jsonRecord(11, { price: 12, capturedAt: '2026-10-07T10:00:00Z' }), jsonRecord(12)]);
  assert.deepEqual(outcome(out), ['unchanged', 'created']);
  assert.deepEqual(out.results[0].reasons, ['ya_existe_omitido']);
  const stored = readCatalog(dir);
  assert.equal(stored.length, 2);
  assert.equal(JSON.stringify(stored.find((p) => p.sourceId === 'Z11')), JSON.stringify(JSON.parse(before)[0]), 'la ficha existente no se modifica ni en un byte');
  assert.equal(stored.find((p) => p.sourceId === 'Z11').price, 50, 'ni siquiera el precio');
});

test('sólo nuevos: el mismo anuncio con OTRO vendedor (que vincularía una oferta) también se omite', () => {
  writeCatalog(dir, []);
  run([jsonRecord(13, { platform: 'temu', externalId: '701000000000013', url: 'https://www.temu.com/es/-g-701000000000013.html' })]);
  const link = runNew([jsonRecord(13, { platform: 'temu', externalId: '701000000000013', url: 'https://www.temu.com/es/-g-701000000000013.html', sellerName: 'Otra tienda', sellerId: 'X9', price: 9 })]);
  assert.deepEqual(outcome(link), ['unchanged']);
  assert.deepEqual(link.results[0].reasons, ['ya_existe_omitido']);
  assert.equal(getOffers(readCatalog(dir)[0]).length, 1, 'no se añadió ninguna oferta');
  // sin la opción, el comportamiento anterior (vincular) se conserva
  const old = runNew([jsonRecord(13, { platform: 'temu', externalId: '701000000000013', url: 'https://www.temu.com/es/-g-701000000000013.html', sellerName: 'Otra tienda', sellerId: 'X9', price: 9 })], false);
  assert.deepEqual(outcome(old), ['linked']);
});

test('sólo nuevos: un duplicado dentro del MISMO lote entra una sola vez', () => {
  writeCatalog(dir, []);
  const out = runNew([jsonRecord(14), jsonRecord(14), jsonRecord(15)]);
  assert.deepEqual(outcome(out), ['created', 'unchanged', 'created']);
  assert.equal(out.results[1].reasons[0], 'ya_existe_omitido');
  assert.equal(readCatalog(dir).length, 2);
});

test('sólo nuevos: reenviar el MISMO lote completo no incluye nada y no toca el fichero del catálogo', () => {
  writeCatalog(dir, []);
  const lote = [jsonRecord(21), jsonRecord(22), jsonRecord(23)];
  runNew(lote);
  const before = JSON.stringify(readCatalog(dir));
  const again = runNew(lote.map((r) => ({ ...r, price: r.price + 5, capturedAt: '2026-10-08T10:00:00Z' })));
  assert.deepEqual(outcome(again), ['unchanged', 'unchanged', 'unchanged']);
  assert.ok(again.results.every((r) => r.reasons.includes('ya_existe_omitido')));
  assert.equal(JSON.stringify(readCatalog(dir)), before);
  assert.equal(again.changed, false);
});

test('sólo nuevos no afecta a lo que NO existe: revisión, rechazos y eliminados siguen igual', () => {
  writeCatalog(dir, []);
  const out = service.processChunk({ batchId: 'onlynew-rev-' + Date.now(), records: [jsonRecord(31, { category: undefined }), jsonRecord(32, { price: undefined })], defaults: {}, dryRun: false, indexOffset: 0, onlyNew: true });
  assert.deepEqual(outcome(out), ['review', 'rejected']);
});

test('el endpoint /api/admin/json-import acepta onlyNew (por defecto desactivado) y el panel lo envía activado', async () => {
  const route = await import('../../src/pages/api/admin/json-import/index.ts');
  const { apiRequest, jsonOf } = await import('./_helpers.mjs');
  writeCatalog(dir, []);
  run([jsonRecord(41, { price: 50 })]);
  const post = (body) => route.POST({ request: apiRequest('/api/admin/json-import', { body, token: true }) });
  const a = await jsonOf(await post({ batchId: 'onlynew-api-0001', records: [jsonRecord(41, { price: 20, capturedAt: '2026-10-09T10:00:00Z' })], onlyNew: true }));
  assert.equal(a.results[0].outcome, 'unchanged');
  assert.deepEqual(a.results[0].reasons, ['ya_existe_omitido']);
  assert.equal(readCatalog(dir)[0].price, 50);
  const b = await jsonOf(await post({ batchId: 'onlynew-api-0002', records: [jsonRecord(41, { price: 20, capturedAt: '2026-10-09T10:00:00Z' })] }));
  assert.equal(b.results[0].outcome, 'updated', 'sin onlyNew: actualiza como siempre');
  const panel = fs.readFileSync('d:/AXEL/WEBS/TRADYLOR/tradylor_web/src/pages/upayp1b4.astro', 'utf8');
  assert.ok(panel.includes('id="jsonImpOnlyNew" checked'));
  assert.ok(panel.includes('onlyNew: onlyNewBox.checked'));
});
