// Matriz de compatibilidad del importador por conector (AliExpress, eBay, Amazon, Temu y JSON genérico). Datos sintéticos aislados, sin red,
// sin APIs de pago. Verifica que las correcciones del 09/11 se comportan igual en todas las plataformas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedData, writeCatalog, readCatalog, jsonRecord, importRecords } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-connector-compat-');
const { getComparableOffers } = await import('../../src/lib/comparableOffers.ts');

const PLATFORMS = {
  aliexpress: { id: '1005000000000011', url: (id) => `https://es.aliexpress.com/item/${id}.html`, singleSeller: true },
  ebay: { id: '123456789012', url: (id) => `https://www.ebay.es/itm/${id}`, singleSeller: true },
  amazon: { id: 'B0CONNECT1', url: (id) => `https://www.amazon.es/dp/${id}`, singleSeller: false },
  temu: { id: '601099512345678', url: (id) => `https://www.temu.com/es/-g-${id}.html`, singleSeller: false },
  tienda: { id: 'TIENDA-77', url: (id) => `https://tienda.invalid/p/${id}`, singleSeller: false },
};
const rec = (platform, over = {}) => {
  const p = PLATFORMS[platform];
  return jsonRecord(5, { platform, externalId: p.id, url: p.url(p.id), condition: 'new', color: 'negro', capturedAt: '2026-11-02T08:00:00Z', ...over });
};
const fresh = async (seed = []) => { writeCatalog(dir, []); if (seed.length) await importRecords(seed); };

for (const platform of Object.keys(PLATFORMS)) {
  const single = PLATFORMS[platform].singleSeller;

  test(`[${platform}] condiciones new / used / open_box: se crean con su condición y no se mezclan al reimportar`, async () => {
    for (const [cond, label] of [['new', 'Nuevo'], ['used', 'Usado'], ['Abierto, sin usar', 'Abierto, sin usar']]) {
      await fresh();
      await importRecords([rec(platform, { condition: cond })]);
      assert.equal(readCatalog(dir)[0].condition, label);
      const other = cond === 'new' ? 'Abierto, sin usar' : 'new';
      const r = await importRecords([rec(platform, { condition: other, price: 20 })]);
      assert.equal(r.results[0].outcome, 'review', `${platform} ${cond}→${other}`);
      assert.match(r.results[0].reasons[0], /^condicion_distinta/);
      assert.ok(r.results[0].reasonTexts[0].length > 10);
    }
  });

  test(`[${platform}] sin condición declarada: no actualiza una ficha con condición, no inventa ninguna al crear`, async () => {
    await fresh();
    await importRecords([rec(platform, { condition: undefined })]);
    assert.equal(readCatalog(dir)[0].condition, undefined);
    await fresh([rec(platform)]);
    const r = await importRecords([rec(platform, { condition: undefined, price: 20 })]);
    assert.equal(r.results[0].outcome, 'review');
    assert.deepEqual(r.results[0].reasons, ['condicion_no_verificable']);
    assert.equal(readCatalog(dir)[0].price, 35);
  });

  test(`[${platform}] variantes y cantidades distintas van a revisión`, async () => {
    await fresh([rec(platform)]);
    assert.match((await importRecords([rec(platform, { color: 'rojo', price: 20 })])).results[0].reasons[0], /^variante_distinta/);
    assert.match((await importRecords([rec(platform, { quantity: 2, price: 60 })])).results[0].reasons[0], /^cantidad_no_verificable/);
  });

  test(`[${platform}] anuncio repetido en el lote: mismo precio no es conflicto; precio distinto → revisión, se conserva el primero`, async () => {
    await fresh();
    const same = await importRecords([rec(platform), rec(platform)]);
    assert.equal(same.results[1].outcome, 'unchanged');
    await fresh();
    const diff = await importRecords([rec(platform, { price: 40 }), rec(platform, { price: 30 })]);
    assert.equal(diff.results[1].outcome, 'review');
    assert.match(diff.results[1].reasons[0], /^anuncio_repetido_en_lote_con_precio_distinto:40≠30/);
    assert.equal(readCatalog(dir)[0].price, 40);
  });

  test(`[${platform}] otro vendedor del mismo anuncio: ${single ? 'revisión (un anuncio, un vendedor)' : 'se vincula como oferta nueva'}`, async () => {
    await fresh([rec(platform, { sellerName: 'Vendedor Uno' })]);
    const r = await importRecords([rec(platform, { sellerName: 'Vendedor Dos', price: 30 })]);
    if (single) {
      assert.equal(r.results[0].outcome, 'review');
      assert.match(r.results[0].reasons[0], /^anuncio_con_vendedor_distinto/);
    } else {
      assert.equal(r.results[0].outcome, 'linked');
      assert.equal(readCatalog(dir)[0].extra.offers.length, 1);
    }
  });

  test(`[${platform}] envío y fecha real de captura: coste y plazo se guardan con su fecha; una captura inferida no genera fecha`, async () => {
    await fresh();
    await importRecords([rec(platform, { shipping: { cost: 2.95, days: 5 } })]);
    const p = readCatalog(dir)[0];
    assert.equal(p.extra.priceReading.shipping.cost, 2.95);
    assert.equal(p.extra.priceReading.shipping.asOf, '2026-11-02T08:00:00.000Z');
    assert.equal(getComparableOffers(p).offers[0].shipping.cost, 2.95);
    await fresh();
    await importRecords([rec(platform, { capturedAt: undefined, shipping: { cost: 1.5 } })]);
    assert.equal(readCatalog(dir)[0].extra.priceReading.shipping.asOf, undefined);
  });

  test(`[${platform}] identificadores contradictorios (id ≠ URL) no se importan y se explican`, async () => {
    await fresh();
    const p = PLATFORMS[platform];
    const wrong = platform === 'amazon' ? 'B0OTRO0001' : platform === 'aliexpress' ? '1005009999999999' : platform === 'ebay' ? '999999999999' : platform === 'temu' ? '601000000000001' : null;
    if (!wrong) return; // el JSON genérico no deduce el id de la URL (ver id-from-url.test.mjs)
    const r = await importRecords([rec(platform, { url: p.url(wrong) })]);
    assert.equal(r.results[0].outcome, 'review');
    assert.equal(r.results[0].reasons[0], 'identificadores_contradictorios');
    assert.equal(readCatalog(dir).length, 0);
  });

  test(`[${platform}] los datos enriquecidos o editados a mano no se pierden al reimportar`, async () => {
    await fresh([rec(platform)]);
    const cat = readCatalog(dir);
    cat[0].verdict = 'Veredicto editado a mano';
    cat[0].pros = ['Ventaja redactada'];
    cat[0].extra = { ...cat[0].extra, lockedFields: ['verdict', 'pros'] };
    writeCatalog(dir, cat);
    await importRecords([rec(platform, { price: 33 })]);
    const p = readCatalog(dir)[0];
    assert.equal(p.verdict, 'Veredicto editado a mano');
    assert.deepEqual(p.pros, ['Ventaja redactada']);
    assert.equal(p.price, 33);
  });
}

test('todo review de la matriz trae reasonTexts con la misma longitud que reasons y sin códigos crudos conocidos', async () => {
  await fresh([rec('amazon')]);
  const r = await importRecords([rec('amazon', { currency: 'USD', price: 30 }), rec('amazon', { color: 'rojo' }), rec('amazon', { condition: 'used' })]);
  for (const x of r.results) {
    assert.equal(x.outcome, 'review');
    assert.equal(x.reasonTexts.length, x.reasons.length);
    assert.ok(!/^[a-z_]+:/.test(x.reasonTexts[0]), x.reasonTexts[0]);
  }
});
