// FASE 4 · Comparador de modelos (#comparativa): selección, gemelas, accesorios, «Sin dato». Datos sintéticos aislados; sólo lectura.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedData } from './_helpers.mjs';

setupIsolatedData('treidilor-model-comparison-');
const { buildModelComparison, selectRivals, isAccessory, NO_DATA } = await import('../../src/lib/modelComparison.ts');

const mk = (id, title, price, over = {}) => ({
  id, slug: id, title, brand: 'Samsung', price, category: 'Portátiles', category_id: 'portatiles', subcategory_id: 'sub-port',
  image: '/x.jpg', affiliateUrl: `https://s.click.aliexpress.com/e/_${id}`, currency: 'EUR', availability: 'in_stock', condition: 'Nuevo',
  fulfillmentProvider: 'AliExpress', merchant: 'AliExpress', rating: 4.5, reviewsCount: 40, pros: ['Ligero'], cons: [], specs: {},
  extra: { Tienda: 'Tienda ' + id, externalId: id }, ...over,
});
const withListing = (p, listing) => ({ ...p, affiliateUrl: `https://s.click.aliexpress.com/e/_${listing}`, extra: { ...p.extra, 'ID de producto': listing, externalId: listing }, url: `https://es.aliexpress.com/item/${listing}.html`, sourceUrl: `https://es.aliexpress.com/item/${listing}.html` });

test('Book4 y Book4 Pro son modelos distintos: ambos aparecen, nunca fusionados', () => {
  const book4 = mk('book4', 'Samsung Galaxy Book4 15.6', 700);
  const pro = mk('book4-pro', 'Samsung Galaxy Book4 Pro 14', 1200);
  const c = buildModelComparison(book4, [book4, pro]);
  assert.equal(c.columns.length, 2);
  assert.equal(c.columns[0].isReference, true);
  assert.deepEqual(c.columns.map((x) => x.id), ['book4', 'book4-pro']);
});

test('los accesorios no se comparan con un producto principal', () => {
  const lap = mk('lap', 'Portátil Zeta 14', 500);
  const org = mk('org', 'Organizador de cables para portátil', 9);
  assert.equal(isAccessory(org), true);
  assert.equal(isAccessory(lap), false);
  const { rivals } = selectRivals(lap, [lap, org]);
  assert.equal(rivals.length, 0);
  assert.equal(buildModelComparison(lap, [lap, org]).hasRivals, false);
});

test('fichas gemelas del mismo anuncio: la de referencia no se compara consigo misma y entre rivales queda un representante', () => {
  const ref = withListing(mk('ref', 'Portátil Alfa', 400), '1005000000000001');
  const twin = withListing(mk('twin', 'Portátil Alfa (copia)', 400), '1005000000000001');
  const r1 = withListing(mk('r1', 'Portátil Beta', 450), '1005000000000002');
  const r2 = withListing(mk('r2', 'Portátil Beta otra ficha', 430), '1005000000000002');
  const { rivals, hiddenTwins } = selectRivals(ref, [ref, twin, r1, r2]);
  const ids = rivals.map((p) => p.id);
  assert.ok(!ids.includes('twin'));
  assert.equal(ids.filter((i) => i === 'r1' || i === 'r2').length, 1);
  assert.ok(hiddenTwins >= 2);
});

test('datos ausentes se muestran como «Sin dato» y la comparación no inventa valores', () => {
  const a = mk('a', 'Portátil A', 500, { rating: undefined, reviewsCount: undefined });
  const b = mk('b', 'Portátil B', 0);
  const c = buildModelComparison(a, [a, mk('c', 'Portátil C', 520, { rating: undefined, reviewsCount: undefined }), b]);
  const price = c.rows.find((r) => r.label === 'Precio publicado');
  assert.ok(price);
  const rating = c.rows.find((r) => r.label === 'Valoración');
  assert.ok(rating.cells.every((x) => x === NO_DATA || x.startsWith('★')));
});

test('el indicador de satisfacción es el mismo que usa la tarjeta (lógica compartida)', async () => {
  const { satisfactionPercent } = await import('../../src/lib/satisfaction.ts');
  const a = mk('a1', 'Portátil A', 500);
  const b = mk('b1', 'Portátil B', 520);
  const c = buildModelComparison(a, [a, b]);
  const row = c.rows.find((r) => r.label.startsWith('Indicador de satisfacción'));
  assert.equal(row.cells[0], `${satisfactionPercent(a)} %`);
});

test('sin rivales: estado vacío honesto', () => {
  const a = mk('solo', 'Portátil Solo', 500);
  const c = buildModelComparison(a, [a]);
  assert.equal(c.hasRivals, false);
  assert.match(c.explanation, /No hay otros modelos comparables/);
});

test('es de sólo lectura: no muta el catálogo', () => {
  const a = Object.freeze(mk('f1', 'Portátil F1', 500));
  const b = Object.freeze(mk('f2', 'Portátil F2', 520));
  const snapshot = JSON.stringify([a, b]);
  buildModelComparison(a, [a, b]);
  assert.equal(JSON.stringify([a, b]), snapshot);
});


test('Fineblue F920 (auriculares) no se compara con gafas inteligentes Bluetooth, y se documenta el motivo', () => {
  const noSub = { subcategory_id: undefined };
  const f920 = mk('f920', 'Auriculares inalámbricos Fineblue F920 Bluetooth con clip', 9.79, noSub);
  const gafas = mk('gafas', 'Gafas de sol inteligentes Bluetooth 5.3 con auriculares', 10.99, noSub);
  const tws = mk('tws', 'Auriculares inalámbricos TWS Bluetooth 5.3 con micrófono', 7.79, noSub);
  const c = buildModelComparison(f920, [f920, gafas, tws]);
  assert.deepEqual(c.columns.map((x) => x.id), ['f920', 'tws']);
  assert.match(c.excluded.find((e) => e.id === 'gafas').reason, /función distinta/);
});

test('sin datos para acreditar la función, el candidato se excluye con motivo', () => {
  const noSub = { subcategory_id: undefined };
  const a = mk('a9', 'Auriculares Zeta', 20, noSub);
  const b = mk('b9', 'Dispositivo Omega X1', 22, noSub);
  const c = buildModelComparison(a, [a, b]);
  assert.equal(c.hasRivals, false);
  assert.match(c.excluded[0].reason, /sin datos para acreditar/);
});
