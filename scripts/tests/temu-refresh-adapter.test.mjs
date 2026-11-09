// Adaptador de Temu del servicio de actualización (opt-in, de pago vía Apify): sólo aplica precios fiables y nunca reintenta ni sale a la red sin token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedData, mockFetch } from './_helpers.mjs';

setupIsolatedData('treidilor-temu-refresh-');
delete process.env.APIFY_TOKEN;
const extra = await import('../../src/lib/offerRefreshExtra.ts');
const refresh = await import('../../src/lib/offerRefresh.ts');
const restore = mockFetch(() => { throw new Error('PRUEBA: no debe haber ninguna petición de red'); });
test.after(() => restore());

const GOODS = '601099500000001';
const product = { id: 'temu-x', network: 'temu', sourceId: GOODS };
const item = (over = {}) => ({ goodsId: GOODS, title: 'Ventilador portátil', price: 35.99, priceText: '35,99 €', currency: 'EUR', sourceUrl: `https://www.temu.com/es/-g-${GOODS}.html`, productUrl: `https://www.temu.com/es/-g-${GOODS}.html`, inStock: true, ...over });
const withItem = (raw) => { extra.transports.temuItem = async () => raw; };

test('sólo se carga con OFFER_REFRESH_EXTRA_SOURCES=temu y reconoce el goodsId', () => {
  assert.deepEqual(extra.extraAdaptersFromEnv('ebay').map((a) => a.id), ['ebay-browse-api']);
  assert.deepEqual(extra.extraAdaptersFromEnv('temu').map((a) => a.id), ['temu-apify']);
  assert.equal(extra.temuAdapter.experimental, true);
  assert.deepEqual(extra.temuAdapter.resolveSource(product), { type: 'temu_goods', id: GOODS });
  assert.equal(extra.temuAdapter.resolveSource({ network: 'temu', sourceId: 'abc' }), null);
});

test('un precio claro en EUR del producto pedido se devuelve como lectura', async () => {
  withItem(item());
  const r = await extra.temuAdapter.fetch(product, { type: 'temu_goods', id: GOODS });
  assert.equal(r.price, 35.99);
  assert.equal(r.currency, 'EUR');
  assert.equal(r.inStock, true);
  assert.equal(r.originalPrice, null);
});

test('precio dudoso (desde, relámpago, otra moneda, otro producto, sin dato) NO se aplica y no se reintenta', async () => {
  const bad = [
    item({ priceText: 'Desde 35,99 €' }),
    item({ dealInfo: { isFlashSale: true } }),
    item({ currency: 'USD' }),
    item({ goodsId: '601099500000002' }),
    item({ price: undefined }),
    null,
  ];
  for (const raw of bad) {
    withItem(raw);
    await assert.rejects(() => extra.temuAdapter.fetch(product, { type: 'temu_goods', id: GOODS }), (e) => e instanceof refresh.RefreshError && e.retryable === false, JSON.stringify(raw)?.slice(0, 60));
  }
});

test('sin APIFY_TOKEN ni transporte, falla sin salir a la red (no gasta nada)', async () => {
  delete extra.transports.temuItem;
  await assert.rejects(() => extra.temuAdapter.fetch(product, { type: 'temu_goods', id: GOODS }), /APIFY_TOKEN/);
});

test('Amazon y el resto no cambian: el adaptador de Temu no está en los adaptadores por defecto', () => {
  assert.equal(refresh.DEFAULT_ADAPTERS.some((a) => a.id === 'temu-apify'), false);
});
