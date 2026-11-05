import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAttribute, buildFacets, applyFilters, offersOf, offerMatches, productAttributes } from '../../src/lib/catalogFacets.ts';

// Catálogo sintético y anonimizado.
const mk = (id, over = {}) => ({ id, title: id, price: 40, currency: 'EUR', network: 'amazon', inStock: true, category: 'Auriculares', specs: {}, extra: {}, ...over });

test('unidades equivalentes se normalizan al mismo valor', () => {
  assert.equal(normalizeAttribute('Capacidad', '1 TB').value, 1000);
  assert.equal(normalizeAttribute('Almacenamiento', '1000 GB').value, 1000);
  assert.equal(normalizeAttribute('Almacenamiento', '1000 GB').key, normalizeAttribute('Capacidad de almacenamiento', '1 TB').key);
  assert.equal(normalizeAttribute('Peso', '1,5 kg').value, 1500);
  assert.equal(normalizeAttribute('Pantalla', '6.7"').unit, 'in');
});

test('ausente ≠ falso ≠ cero', () => {
  assert.equal(normalizeAttribute('Cancelación de ruido', '—'), null);
  assert.equal(normalizeAttribute('Cancelación de ruido', ''), null);
  assert.equal(normalizeAttribute('Cancelación de ruido', 'No').value, false);
  assert.equal(normalizeAttribute('Cancelación de ruido', 'Sí').value, true);
  const zero = normalizeAttribute('Peso', '0 g');
  assert.equal(zero.value, 0);
  assert.equal(zero.type, 'number');
});

test('marcas escritas de distintas formas = una opción; marcas distintas no se fusionan', () => {
  const products = [
    mk('a', { brand: 'FINEBLUE' }),
    mk('b', { brand: 'Fineblue' }),
    mk('c', { brand: 'Visit the Fineblue Store' }),
    mk('d', { brand: 'Sonix' }),
    mk('e', { brand: 'Sonic' }),
    mk('f', {}), // sin marca: no genera opción
  ];
  const brand = buildFacets(products, {}, { categoryKey: 'Auriculares' }).groups.find((g) => g.key === 'brand');
  const byLabel = Object.fromEntries(brand.options.map((o) => [o.value, o.count]));
  assert.equal(byLabel['fineblue'], 3);
  assert.equal(byLabel['sonix'], 1);
  assert.equal(byLabel['sonic'], 1);
  assert.equal(brand.options.length, 3, 'el producto sin marca no crea opción');
});

test('un atributo nuevo aparece automáticamente en las opciones', () => {
  const base = [
    mk('a', { specs: { Conectividad: 'Bluetooth' } }),
    mk('b', { specs: { Conectividad: 'USB-C' } }),
  ];
  const before = buildFacets(base, {}, { categoryKey: 'Auriculares' }).groups.map((g) => g.key);
  assert.ok(before.includes('conectividad'));
  assert.ok(!before.includes('color'));
  const after = buildFacets(
    [...base, mk('c', { specs: { Color: 'Negro' } }), mk('d', { specs: { Colour: 'Blanco' } })],
    {},
    { categoryKey: 'Auriculares' },
  ).groups.map((g) => g.key);
  assert.ok(after.includes('color'), 'Color/Colour comparten clave y aparece sin tocar código');
});

test('recuentos de productos únicos: dos ofertas del mismo producto cuentan una vez', () => {
  const twoOffers = mk('p', {
    brand: 'Fineblue',
    extra: { crossMerchant: { networks: ['amazon', 'ebay'], prices: { amazon: 40, ebay: 38 }, currencies: { amazon: 'EUR', ebay: 'EUR' } } },
  });
  assert.equal(offersOf(twoOffers).length, 2);
  const facets = buildFacets([twoOffers], {}, { categoryKey: 'Auriculares' });
  assert.equal(facets.total, 1);
  assert.equal(facets.groups.find((g) => g.key === 'brand').options[0].count, 1);
});

test('condiciones comerciales combinadas se cumplen en UNA MISMA oferta', () => {
  const p = mk('p', {
    price: 30,
    // principal: barata pero lenta; la otra: rápida pero cara
    shippingDays: 20,
    extra: { crossMerchant: { prices: { amazon: 30, ebay: 90 }, currencies: { amazon: 'EUR', ebay: 'EUR' } } },
  });
  const offers = offersOf(p);
  offers[1].deliveryMaxDays = 2;
  offers[1].shippingCost = 0;
  // Barata (≤50) Y rápida (≤3) a la vez: ninguna oferta lo cumple por separado.
  assert.equal(offers.some((o) => offerMatches(o, { maxPrice: 50, maxDeliveryDays: 3 })), false);
  assert.equal(applyFilters([p], { maxPrice: 50, maxDeliveryDays: 3 }).length, 0, 'no se mezclan condiciones de ofertas distintas');
  assert.equal(offers.some((o) => offerMatches(o, { maxPrice: 50 })), true);
});

test('envío/plazo desconocidos no cuentan como cero', () => {
  const p = mk('p', {}); // sin shippingCost ni shippingDays
  assert.equal(applyFilters([p], { maxShippingCost: 0 }).length, 0, 'desconocido no es envío gratis');
  assert.equal(applyFilters([p], { maxDeliveryDays: 5 }).length, 0, 'plazo desconocido no cumple');
  const free = mk('q', { freeShipping: true, shippingDays: 3 });
  assert.equal(applyFilters([free], { maxShippingCost: 0, maxDeliveryDays: 5 }).length, 1);
});

test('mismo filtro = O; filtros distintos = Y; las selecciones activas se conservan', () => {
  const products = [
    mk('a', { brand: 'Alfa', specs: { Color: 'Negro' } }),
    mk('b', { brand: 'Beta', specs: { Color: 'Negro' } }),
    mk('c', { brand: 'Alfa', specs: { Color: 'Blanco' } }),
    mk('d', { brand: 'Gamma', specs: { Color: 'Blanco' } }),
  ];
  assert.deepEqual(applyFilters(products, { brand: ['Alfa', 'Beta'] }).map((p) => p.id), ['a', 'b', 'c']);
  assert.deepEqual(applyFilters(products, { brand: ['Alfa', 'Beta'], attrs: { color: ['negro'] } }).map((p) => p.id), ['a', 'b']);
  // Disyuntiva: al elegir color=negro, la marca Gamma sigue listada con 0 y Alfa cuenta 1.
  const facets = buildFacets(products, { attrs: { color: ['negro'] }, brand: ['Gamma'] }, { categoryKey: 'Auriculares' });
  const brand = facets.groups.find((g) => g.key === 'brand');
  const gamma = brand.options.find((o) => o.value === 'gamma');
  assert.ok(gamma.selected, 'la selección activa se conserva');
  assert.equal(gamma.count, 0);
  assert.equal(brand.options.find((o) => o.value === 'alfa').count, 1);
});

test('cambios de disponibilidad actualizan opciones y resultados', () => {
  const products = [mk('a', { brand: 'Alfa' }), mk('b', { brand: 'Beta' })];
  assert.equal(applyFilters(products, { onlyInStock: true }).length, 2);
  products[1].inStock = false;
  assert.equal(applyFilters(products, { onlyInStock: true }).length, 1);
  products[1].inStock = undefined; // desconocido
  assert.equal(applyFilters(products, { onlyInStock: true }).length, 1, 'desconocido no se afirma como en stock');
});

test('una lectura caducada no cuenta como oferta vigente en filtros comerciales', () => {
  const stale = mk('s', { extra: { refresh: { lastVerifiedAt: '2026-01-01T00:00:00.000Z' } } });
  const fresh = mk('f', { extra: { refresh: { lastVerifiedAt: '2026-11-05T00:00:00.000Z' } } });
  const ctx = { now: new Date('2026-11-06T00:00:00.000Z') };
  assert.deepEqual(applyFilters([stale, fresh], { maxPrice: 100 }, ctx).map((p) => p.id), ['f']);
});

test('misma regla para API y JSON: los atributos salen del producto publicado, no de la fuente', () => {
  const fromApi = mk('api', { brand: 'Fineblue', specs: { Almacenamiento: '1 TB' }, extra: { fieldSources: { specs: 'provider+ai' } } });
  const fromJson = mk('json', { brand: 'Visit the Fineblue Store', specs: { Capacidad: '1000 GB' } });
  const attrs = (p) => productAttributes(p).find((a) => a.key === 'almacenamiento').value;
  assert.equal(attrs(fromApi), attrs(fromJson));
  const facets = buildFacets([fromApi, fromJson], {}, { categoryKey: 'Almacenamiento' });
  assert.equal(facets.groups.find((g) => g.key === 'almacenamiento').options[0].count, 2);
  assert.equal(facets.groups.find((g) => g.key === 'brand').options[0].count, 2);
});
