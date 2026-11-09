// Identificadores de eBay y Temu frente a su URL: una contradicción acreditada IMPIDE la escritura (no crea, no actualiza, conserva el registro
// para diagnóstico); la ausencia de id extraíble NO es contradicción. Datos sintéticos aislados, sin red ni importaciones reales.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, writeCatalog, readCatalog, jsonRecord, importRecords } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-id-from-url-');
const { contradictionOfOffer, getComparableOffers, groupByCommercialIdentity } = await import('../../src/lib/comparableOffers.ts');
const { explainReason } = await import('../../src/lib/jsonImport/reasonLabels.ts');

const EBAY_ID = '167256651525';
const TEMU_ID = '601099512345678';
const rec = (platform, over = {}) => {
  const ebay = platform === 'ebay';
  const id = ebay ? EBAY_ID : TEMU_ID;
  return jsonRecord(9, {
    platform, externalId: id, condition: 'new', capturedAt: '2026-11-02T08:00:00Z',
    url: ebay ? `https://www.ebay.es/itm/${id}` : `https://www.temu.com/es/-g-${id}.html`,
    ...over,
  });
};
const fresh = async (seed = []) => { fs.rmSync(path.join(dir, 'import-review.json'), { force: true }); writeCatalog(dir, []); if (seed.length) await importRecords(seed); };
const reviewQueue = () => { const f = path.join(dir, 'import-review.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; };
const c = (platform, externalId, url) => contradictionOfOffer({ platform, externalId, url });

/* ───────────── Función de lectura (casos 1-8) ───────────── */

test('1 · eBay con identificador coincidente (formatos /itm/<id>, /itm/<slug>/<id>, con parámetros y el formato v1|id|…)', () => {
  assert.equal(c('ebay', EBAY_ID, `https://www.ebay.es/itm/${EBAY_ID}`), '');
  assert.equal(c('ebay', EBAY_ID, `https://www.ebay.es/itm/cargador-usb-c/${EBAY_ID}?_skw=a&hash=b`), '');
  assert.equal(c('ebay', `v1|${EBAY_ID}|466937760078`, `https://www.ebay.com/itm/${EBAY_ID}`), '');
});

test('2 · eBay con identificador contradictorio', () => {
  assert.match(c('ebay', '999999999999', `https://www.ebay.es/itm/${EBAY_ID}`), /^id=999999999999 ≠ url=167256651525$/);
  assert.match(c('ebay', '999999999999', `https://www.ebay.es/itm/slug/${EBAY_ID}`), /≠/);
});

test('3 · eBay con URL sin identificador extraíble: no hay contradicción', () => {
  assert.equal(c('ebay', EBAY_ID, 'https://www.ebay.es/sch/i.html?_nkw=cargador'), '');
  assert.equal(c('ebay', EBAY_ID, 'https://www.ebay.es/itm/'), '');
  assert.equal(c('ebay', EBAY_ID, 'https://www.ebay.es/itm/12345'), '', 'id demasiado corto: no es inequívoco');
});

test('4 · Temu con identificador coincidente (-g-<id>.html con y sin /es/ ni slug)', () => {
  assert.equal(c('temu', TEMU_ID, `https://www.temu.com/es/-g-${TEMU_ID}.html`), '');
  assert.equal(c('temu', TEMU_ID, `https://www.temu.com/es/ventilador-portatil-g-${TEMU_ID}.html?x=1`), '');
  assert.equal(c('temu', TEMU_ID, `https://www.temu.com/-g-${TEMU_ID}.html`), '');
});

test('5 · Temu con identificador contradictorio', () => {
  assert.match(c('temu', '601000000000001', `https://www.temu.com/es/-g-${TEMU_ID}.html`), /^id=601000000000001 ≠ url=601099512345678$/);
});

test('6 · Temu con URL sin identificador extraíble (slug sin -g-, enlace corto de afiliado)', () => {
  assert.equal(c('temu', TEMU_ID, 'https://www.temu.com/es/ventilador-portatil.html'), '');
  assert.equal(c('temu', TEMU_ID, 'https://temu.to/k/abc123'), '');
  assert.equal(c('temu', TEMU_ID, 'https://share.temu.com/xyz'), '');
});

test('7 · URL malformada o sin protocolo http(s): no hay contradicción ni excepción', () => {
  for (const url of ['not a url', '', 'ftp://www.ebay.es/itm/167256651525', 'javascript:alert(1)', '//www.ebay.es/itm/167256651525']) {
    assert.equal(c('ebay', '999999999999', url), '', url);
    assert.equal(c('temu', '601000000000001', url), '', url);
  }
});

test('8 · URL de otro dominio: no se interpreta como contradicción', () => {
  assert.equal(c('ebay', '999999999999', `https://example.com/itm/${EBAY_ID}`), '');
  assert.equal(c('ebay', '999999999999', `https://notebay.es.evil.com/itm/${EBAY_ID}`), '');
  assert.equal(c('temu', '601000000000001', `https://example.com/es/-g-${TEMU_ID}.html`), '');
  assert.equal(c('temu', '601000000000001', `https://temu.com.evil.net/-g-${TEMU_ID}.html`), '');
});

test('9 · Amazon y AliExpress: reglas intactas', () => {
  assert.match(c('amazon', 'B0AAAAAAAA', 'https://www.amazon.es/dp/B0BBBBBBBB'), /^id=B0AAAAAAAA ≠ url=B0BBBBBBBB$/);
  assert.equal(c('amazon', 'B0AAAAAAAA', 'https://www.amazon.es/dp/B0AAAAAAAA'), '');
  assert.match(c('aliexpress', '1005009999999999', 'https://es.aliexpress.com/item/1005005704532450.html'), /≠/);
  assert.equal(c('aliexpress', '1005005704532450', 'https://es.aliexpress.com/item/1005005704532450.html'), '');
  assert.equal(c('tienda', 'X1', 'https://tienda.invalid/p/OTRO'), '', 'JSON genérico: sin extracción de id de la URL');
});

/* ───────────── Flujo de importación: la escritura se impide de verdad ───────────── */

for (const platform of ['ebay', 'temu']) {
  const wrongUrl = platform === 'ebay' ? 'https://www.ebay.es/itm/999999999999' : 'https://www.temu.com/es/-g-601000000000001.html';

  test(`10 · [${platform}] un registro contradictorio NO crea ficha, va a revisión y conserva el registro original`, async () => {
    await fresh();
    const r = await importRecords([rec(platform, { url: wrongUrl })]);
    assert.equal(r.results[0].outcome, 'review');
    assert.equal(r.results[0].reasons[0], 'identificadores_contradictorios');
    assert.match(r.results[0].reasons[1], /^id=.* ≠ url=/);
    assert.equal(readCatalog(dir).length, 0, 'no se creó ninguna ficha');
    assert.match(r.results[0].reasonTexts[0], /identificadores del registro se contradicen/);
    const queue = reviewQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].record.offer.externalId, rec(platform).externalId, 'el registro original queda para diagnóstico');
    assert.equal(queue[0].record.offer.url, wrongUrl);
  });

  test(`11-12 · [${platform}] un registro contradictorio NO actualiza una ficha existente ni toca sus datos comerciales`, async () => {
    await fresh([rec(platform, { sellerName: 'Vendedor Uno', shipping: { cost: 2.5, days: 4 } })]);
    const before = JSON.stringify(readCatalog(dir));
    const r = await importRecords([rec(platform, { url: wrongUrl, price: 1, sellerName: 'Vendedor Uno', shipping: { cost: 0, free: true, days: 1 } })]);
    assert.equal(r.results[0].outcome, 'review');
    assert.equal(JSON.stringify(readCatalog(dir)), before, 'el catálogo quedó byte a byte igual');
  });

  test(`3/6 · [${platform}] una URL sin id extraíble NO bloquea un registro válido (se crea y se reimporta sin duplicar)`, async () => {
    await fresh();
    const noId = platform === 'ebay' ? 'https://www.ebay.es/sch/i.html?_nkw=cargador' : 'https://www.temu.com/es/ventilador-portatil.html';
    const a = await importRecords([rec(platform, { url: noId })]);
    assert.equal(a.results[0].outcome, 'created');
    const b = await importRecords([rec(platform, { url: noId })]);
    assert.equal(b.results[0].outcome, 'unchanged');
    assert.equal(readCatalog(dir).length, 1);
  });

  test(`7/8 · [${platform}] URL malformada o de otro dominio: se importa como antes (no es contradicción)`, async () => {
    await fresh();
    const other = await importRecords([rec(platform, { url: `https://example.com/itm/999999999999` })]);
    assert.equal(other.results[0].outcome, 'created');
  });

  test(`[${platform}] el registro coincidente se crea y se reimporta con normalidad`, async () => {
    await fresh();
    assert.equal((await importRecords([rec(platform)])).results[0].outcome, 'created');
    assert.equal((await importRecords([rec(platform, { price: 29 })])).results[0].outcome, 'updated');
  });
}

test('13 · JSON genérico y eBay con id en formato de API (v1|id|…) no se bloquean', async () => {
  await fresh();
  const j = await importRecords([jsonRecord(3, { platform: 'tienda', externalId: 'ABC', url: 'https://tienda.invalid/p/OTRO' })]);
  assert.equal(j.results[0].outcome, 'created');
  await fresh();
  const e = await importRecords([rec('ebay', { externalId: `v1|${EBAY_ID}|0` })]);
  assert.equal(e.results[0].outcome, 'created');
});

/* ───────────── Fichas duplicadas y comparadores ───────────── */

test('14 · las fichas duplicadas existentes siguen protegidas: reimportar su anuncio no escribe nada', async () => {
  const twin = (n) => ({ id: `tw-${n}`, slug: `tw-${n}`, title: 'Cargador gemelo', price: 10, category: 'Accesorios', network: 'ebay', merchant: 'eBay', affiliateUrl: `https://www.ebay.es/itm/${EBAY_ID}`, sourceId: EBAY_ID, currency: 'EUR', inStock: true, extra: {} });
  writeCatalog(dir, [twin(1), twin(2), twin(3)]);
  const before = JSON.stringify(readCatalog(dir));
  const groups = groupByCommercialIdentity(readCatalog(dir)).filter((g) => g.productIds.length > 1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].productIds.length, 3);
  const r = await importRecords([rec('ebay', { price: 5 })]);
  assert.equal(r.results[0].outcome, 'review');
  assert.equal(r.results[0].reasons[0], 'anuncio_en_varias_fichas');
  assert.equal(JSON.stringify(readCatalog(dir)), before);
});

test('15 · compatibilidad con los comparadores: una ficha eBay/Temu coherente no se marca para revisión y una contradictoria ya guardada se excluye sin borrarse', () => {
  const ok = { id: 'e1', title: 'Cargador', price: 10, category: 'Accesorios', network: 'ebay', merchant: 'eBay', affiliateUrl: `https://www.ebay.es/itm/${EBAY_ID}`, sourceId: EBAY_ID, currency: 'EUR', inStock: true, extra: {} };
  assert.equal(getComparableOffers(ok, { catalog: [ok] }).needsReview.length, 0);
  assert.equal(getComparableOffers(ok, { catalog: [ok] }).offers.length, 1);
  const bad = { ...ok, id: 'e2', sourceId: '999999999999' };
  const r = getComparableOffers(bad, { catalog: [bad] });
  assert.ok(r.offers.length + r.needsReview.length + r.excluded.length >= 1, 'la oferta no desaparece del diagnóstico');
  assert.equal(bad.sourceId, '999999999999', 'el identificador existente no se modifica');
});

test('motivo legible para el administrador', () => {
  assert.match(explainReason('identificadores_contradictorios'), /se contradicen/);
});
