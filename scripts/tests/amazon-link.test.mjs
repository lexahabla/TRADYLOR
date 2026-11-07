// El enlace de afiliado de Amazon debe llevar a la PÁGINA DEL PRODUCTO (/dp/<ASIN>?tag=…) y no a la cesta (/gp/aws/cart/add.html),
// también para las fichas antiguas que ya guardan un enlace de cesta. Sin red ni IA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, readCatalog, writeCatalog, jsonRecord } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-amazon-link-');
process.env.AMAZON_ASSOCIATE_TAG = 'treidilor-test-21';
delete process.env.PUBLIC_AMAZON_ASSOCIATE_TAG;

const amazon = await import('../../src/utils/amazon.ts');
const { buildPurchaseUrl } = await import('../../src/lib/purchaseUrl.ts');
const service = await import('../../src/lib/jsonImport/service.ts');

const ASIN = 'B09B32PCGH';
const PRODUCT = `https://www.amazon.es/dp/${ASIN}?tag=treidilor-test-21`;
const CART = `https://www.amazon.es/gp/aws/cart/add.html?ASIN.1=${ASIN}&Quantity.1=1&AssociateTag=treidilor-test-21`;

test('getAmazonAddToCartUrl ya no construye la cesta: devuelve la ficha del producto con el tag (y vacío si el ASIN no es válido)', () => {
  assert.equal(amazon.getAmazonAddToCartUrl(ASIN, 'treidilor-test-21'), PRODUCT);
  assert.equal(amazon.getAmazonAddToCartUrl(' b09b-32pcgh '), PRODUCT, 'sanea el ASIN y usa el tag de entorno');
  assert.equal(amazon.getAmazonAddToCartUrl('corto'), '');
  assert.equal(amazon.getAmazonAddToCartUrl(ASIN, 'otro-21'), `https://www.amazon.es/dp/${ASIN}?tag=otro-21`);
  assert.equal(amazon.getAmazonAddToCartUrl(ASIN, 'otro-21'), amazon.getAmazonProductUrl(ASIN, 'otro-21'));
});

test('amazonCartToProductUrl: convierte enlaces de cesta (conserva dominio y tag) y deja intactas las demás URL', () => {
  assert.equal(amazon.amazonCartToProductUrl(CART), PRODUCT);
  assert.equal(amazon.amazonCartToProductUrl(`https://www.amazon.de/gp/aws/cart/add.html?ASIN.1=${ASIN}&AssociateTag=de-21`), `https://www.amazon.de/dp/${ASIN}?tag=de-21`, 'respeta el dominio');
  assert.equal(amazon.amazonCartToProductUrl(`https://www.amazon.es/gp/aws/cart/add.html?ASIN.1=${ASIN}`), PRODUCT, 'sin tag usa el de la tienda');
  for (const same of [PRODUCT, 'https://www.amazon.es/s?k=teclado', 'https://www.amazon.es/gp/aws/cart/add.html?ASIN.1=corto', 'https://www.amazon.es/gp/aws/cart/add.html', 'https://www.temu.com/es/-g-601101683713758.html', 'https://temu.to/k/abc', 'https://evil.example/gp/aws/cart/add.html?ASIN.1=' + ASIN, 'no es url', '']) {
    assert.equal(amazon.amazonCartToProductUrl(same), same, same);
  }
});

test('buildPurchaseUrl: la salida de Amazon es la ficha del producto con tag — desde la URL del producto, con o sin tag previo', () => {
  assert.equal(buildPurchaseUrl({ affiliateUrl: `https://www.amazon.es/dp/${ASIN}` }), PRODUCT);
  assert.equal(buildPurchaseUrl({ affiliateUrl: `https://www.amazon.es/Lenovo-IdeaPad/dp/${ASIN}/ref=sr_1_1?th=1&psc=1` }), PRODUCT, 'con slug y parámetros de seguimiento');
  assert.equal(buildPurchaseUrl({ affiliateUrl: `https://www.amazon.es/dp/${ASIN}?tag=mi-tag-21` }), `https://www.amazon.es/dp/${ASIN}?tag=mi-tag-21`, 'respeta un tag ya presente');
  assert.equal(buildPurchaseUrl({ affiliateUrl: `https://www.amazon.es/gp/product/${ASIN}` }), PRODUCT);
  assert.ok(!buildPurchaseUrl({ affiliateUrl: `https://www.amazon.es/dp/${ASIN}` }).includes('cart'), 'nunca la cesta');
});

test('buildPurchaseUrl: una ficha ANTIGUA con enlace de cesta en buyNowUrl también lleva ya a la ficha del producto', () => {
  assert.equal(buildPurchaseUrl({ affiliateUrl: `https://www.amazon.es/dp/${ASIN}`, buyNowUrl: CART }), PRODUCT);
  // un buyNowUrl de Amazon que ya es de producto solo recibe el tag si no lo trae
  assert.equal(buildPurchaseUrl({ affiliateUrl: 'https://x.invalid/a', buyNowUrl: `https://www.amazon.es/dp/${ASIN}` }), PRODUCT);
});

test('buildPurchaseUrl no toca otras plataformas ni el enlace corto de afiliado de Temu', () => {
  const temu = 'https://temu.to/k/gk2abc9xyz';
  assert.equal(buildPurchaseUrl({ affiliateUrl: temu }), temu);
  const ali = 'https://www.aliexpress.com/item/1005001234567890.html';
  assert.equal(buildPurchaseUrl({ affiliateUrl: ali }), ali);
  assert.equal(buildPurchaseUrl({ affiliateUrl: '' }), '');
});

test('una ficha de Amazon importada sale a la ficha del producto (no a la cesta) y sin guardar enlaces de cesta', () => {
  writeCatalog(dir, []);
  const rec = jsonRecord(1, { platform: 'amazon', externalId: undefined, asin: ASIN, url: `https://www.amazon.es/dp/${ASIN}`, category: 'Audio' });
  service.processChunk({ batchId: 'amzlink-' + Date.now(), records: [rec], defaults: { category: 'Audio' }, dryRun: false, indexOffset: 0 });
  const [p] = readCatalog(dir);
  assert.equal(buildPurchaseUrl(p), PRODUCT);
  assert.ok(!JSON.stringify(p).includes('cart/add'), 'no se guarda ningún enlace de cesta');
});

test('no quedan constructores de enlaces de cesta: sólo la conversión de los antiguos', () => {
  const root = 'd:/AXEL/WEBS/TRADYLOR/tradylor_web/src';
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|astro)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('/gp/aws/cart/add.html')) hits.push(path.relative(root, p).replace(/\\/g, '/')); } };
  walk(root);
  assert.deepEqual(hits, ['utils/amazon.ts'], 'sólo comentarios y la conversión en utils/amazon.ts');
  const panel = fs.readFileSync(path.join(root, 'pages/upayp1b4.astro'), 'utf8');
  assert.ok(panel.includes('function buildAmazonProductUrl') && !panel.includes('buildAmazonCartUrl'));
});
