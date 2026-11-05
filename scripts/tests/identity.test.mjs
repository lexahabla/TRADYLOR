import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSourceId,
  sameSourceId,
  offerKey,
  parseEbayItemId,
  normalizeBrand,
  brandIsMerchant,
} from '../../src/lib/offerIdentity.ts';
import { mergeReimport, lockFields, diffEditorialFields } from '../../src/lib/reimportMerge.ts';

test('mismo id por API (plano) y por URL (prefijo AE-)', () => {
  assert.equal(sameSourceId('100500123', 'AE-100500123'), true);
  assert.equal(sameSourceId('', ''), false);
  assert.equal(sameSourceId('100500123', '100500124'), false);
});

test('itemId de eBay con envoltorio v1|id|variación', () => {
  assert.deepEqual(parseEbayItemId('v1|123456789012|0'), { itemId: '123456789012', variationId: undefined });
  assert.deepEqual(parseEbayItemId('v1|123456789012|987'), { itemId: '123456789012', variationId: '987' });
  assert.equal(sameSourceId('v1|123456789012|0', '123456789012'), true);
});

test('ASIN se compara sin importar mayúsculas', () => {
  assert.equal(normalizeSourceId('b01exdg2mo'), 'B01EXDG2MO');
});

test('vendedores distintos de una plataforma = ofertas distintas', () => {
  const a = offerKey({ network: 'ebay', externalId: 'v1|1|0', merchantId: 'vendedorA' });
  const b = offerKey({ network: 'ebay', externalId: 'v1|1|0', merchantId: 'vendedorB' });
  assert.notEqual(a, b);
  assert.equal(offerKey({ network: 'aliexpress', externalId: 'AE-9' }), offerKey({ network: 'AliExpress', externalId: '9' }));
});

test('marcas: ruido del comercio, acentos y mayúsculas sin fusionar marcas distintas', () => {
  assert.equal(normalizeBrand('Visit the Fineblue Store').key, 'fineblue');
  assert.equal(normalizeBrand('FINEBLUE').key, normalizeBrand('fineblue').key);
  assert.equal(normalizeBrand('Marca: Sónix').key, 'sonix');
  assert.notEqual(normalizeBrand('Sonix').key, normalizeBrand('Sonic').key);
  assert.equal(normalizeBrand('Hewlett Packard').display, 'HP');
  assert.equal(normalizeBrand('—').key, '');
  assert.equal(brandIsMerchant('Amazon', 'amazon'), true);
});

test('reimportación conserva histórico, slug, variantes y marca válida', () => {
  const existing = {
    id: 'amazon-b01', title: 'Mi título editado', brand: 'Fineblue', merchant: 'Amazon', price: 50,
    slug: 'mi-slug', variantGroup: 'g1', variantFeature: '2 TB',
    priceHistory: [{ date: '2026-11-01', price: 55 }],
    verdict: 'Veredicto revisado',
    extra: { lockedFields: ['title'], observations: [{ x: 1 }], antigua: 'sí' },
  };
  const incoming = {
    id: 'amazon-b01', title: 'Título nuevo del proveedor', brand: 'Amazon', merchant: 'Amazon', price: 45,
    extra: { importSource: 'json' },
  };
  const merged = mergeReimport(existing, incoming);
  assert.equal(merged.price, 45, 'el precio del proveedor gana');
  assert.equal(merged.title, 'Mi título editado', 'campo bloqueado se conserva');
  assert.equal(merged.brand, 'Fineblue', 'la marca no se degrada a la tienda');
  assert.equal(merged.slug, 'mi-slug');
  assert.equal(merged.variantGroup, 'g1');
  assert.deepEqual(merged.priceHistory, existing.priceHistory);
  assert.equal(merged.verdict, 'Veredicto revisado');
  assert.deepEqual(merged.extra.observations, [{ x: 1 }]);
  assert.equal(merged.extra.importSource, 'json');
  assert.equal(merged.extra.antigua, 'sí');
});

test('edición manual: se detectan y bloquean los campos editoriales', () => {
  const before = { title: 'A', pros: ['x'], price: 1 };
  const after = { title: 'B', pros: ['x'], price: 2 };
  const changed = diffEditorialFields(before, after);
  assert.deepEqual(changed, ['title']);
  assert.deepEqual(lockFields(after, changed).extra.lockedFields, ['title']);
});

test('reimportar dos veces el mismo JSON es idempotente', () => {
  const incoming = { id: 'a', title: 'T', brand: 'Marca', merchant: 'Amazon', price: 10, extra: { importSource: 'json' } };
  const once = mergeReimport(null, incoming);
  const twice = mergeReimport(once, incoming);
  assert.deepEqual(twice, once);
});
