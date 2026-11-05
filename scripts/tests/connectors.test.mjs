import test from 'node:test';
import assert from 'node:assert/strict';
import { EbayProductAdapter } from '../../src/lib/networks/connectors/adapters/ebayProductAdapter.ts';
import { canonicalToUnified } from '../../src/lib/networks/connectors/base.ts';
import { extractSourceId } from '../../src/lib/curation.ts';
import { sameSourceId } from '../../src/lib/offerIdentity.ts';

// Muestra SINTÉTICA y anonimizada con la forma de la Browse API de eBay.
const ebayItem = {
  itemId: 'v1|123456789012|0',
  legacyItemId: '123456789012',
  title: 'Auriculares Fineblue F920 inalámbricos',
  price: { value: '39.90', currency: 'EUR' },
  image: { imageUrl: 'https://example.invalid/i1.jpg' },
  additionalImages: [{ imageUrl: 'https://example.invalid/i2.jpg' }],
  itemWebUrl: 'https://www.ebay.es/itm/123456789012',
  condition: 'Nuevo',
  buyingOptions: ['FIXED_PRICE'],
  shippingOptions: [{ shippingCost: { value: '0.00', currency: 'EUR' }, maxEstimatedDeliveryDate: '2099-01-01T00:00:00.000Z', minEstimatedDeliveryDate: '2098-12-25T00:00:00.000Z' }],
  seller: { username: 'vendedor_a' },
  categories: [{ categoryId: '112233', categoryName: 'Auriculares' }],
  product: { brand: 'Fineblue', mpn: 'F920', gtin: '0123456789012', ean: ['0123456789012'], productId: 'EPID-1' },
  itemGroupId: 'G-1',
};

test('eBay: no inventa valoración, conserva identificadores y marca disponibilidad', () => {
  const [p] = new EbayProductAdapter('CAMP', {}).adaptCanonical([ebayItem]);
  assert.equal(p.rating, 0, 'sin feedback → desconocido, no 4,5');
  assert.equal(p.reviewCount, 0, 'sin feedback → sin opiniones inventadas');
  assert.equal(p.availability, 'in_stock');
  assert.equal(p.extra['MPN'], 'F920');
  assert.equal(p.extra['GTIN'], '0123456789012');
  assert.equal(p.extra['ID grupo variantes'], 'G-1');
  assert.equal(p.extra['ID anuncio (legado)'], '123456789012');
  assert.equal(p.technicalSpecs['Coste de envío'], 'Gratis', 'coste 0 conocido');
  assert.equal(p.brand, 'Fineblue');
  const u = canonicalToUnified(p);
  assert.equal(u.rating, undefined);
  assert.equal(u.reviewsCount, undefined);
  assert.equal(u.extra['Disponibilidad'], 'en stock');
});

test('eBay: sin coste de envío informado queda desconocido (no gratis)', () => {
  const item = { ...ebayItem, shippingOptions: [{}] };
  const [p] = new EbayProductAdapter('', {}).adaptCanonical([item]);
  assert.equal(p.technicalSpecs?.['Coste de envío'], undefined);
});

test('eBay: modalidad no comprable (subasta) → disponibilidad desconocida, no agotado', () => {
  const [p] = new EbayProductAdapter('', {}).adaptCanonical([{ ...ebayItem, buyingOptions: ['AUCTION'] }]);
  assert.equal(p.availability, 'unknown');
});

test('mismo anuncio por API (v1|id|0) y por URL (/itm/id)', () => {
  const fromUrl = extractSourceId({ affiliateUrl: 'https://www.ebay.es/itm/titulo-largo/123456789012?mkmk=1' });
  assert.equal(fromUrl, '123456789012');
  assert.equal(sameSourceId(ebayItem.itemId, fromUrl), true);
});

test('AliExpress: id por API y por URL se reconocen como el mismo anuncio', () => {
  const fromUrl = extractSourceId({ affiliateUrl: 'https://es.aliexpress.com/item/100500123.html' });
  assert.equal(fromUrl, 'AE-100500123');
  assert.equal(sameSourceId('100500123', fromUrl), true);
});
