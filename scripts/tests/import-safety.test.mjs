// ETAPA 1.5 · Seguridad del importador JSON. Motor PURO en memoria (`runImport`) con catálogos sintéticos y el fixture del Fineblue F920:
// no hay disco de producción, red, IA ni servicios de pago. Además de «no duplica», cada prueba de bloqueo comprueba que NO se actualiza
// otra ficha, NO se modifica una oferta ya guardada, NO se crea una ficha y NO se pierde información (el catálogo sale idéntico, byte a byte).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData } from './_helpers.mjs';

setupIsolatedData('treidilor-import-safety-');
const engine = await import('../../src/lib/jsonImport/engine.ts');
const { getComparableOffers } = await import('../../src/lib/comparableOffers.ts');
const { getOffers } = await import('../../src/lib/catalogOffers.ts');

const FINEBLUE = JSON.parse(fs.readFileSync(new URL('./fixtures/fineblue-f920.json', import.meta.url), 'utf8'));
const AE = FINEBLUE.sourceId;
const NOW = '2026-11-09T10:00:00.000Z';
const clone = (v) => structuredClone(v);
const snap = (v) => JSON.stringify(v);
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

const run = (catalog, records, opts = {}, defaults = { category: 'Sonido' }) =>
  engine.runImport(catalog, records, defaults, { batchId: 'safety', nowIso: NOW, deletedIds: new Set(), ...opts });

/** Registro JSON del Fineblue F920 (AliExpress). */
const ae = (over = {}) => ({
  platform: 'aliexpress', externalId: AE, url: `https://es.aliexpress.com/item/${AE}.html`, title: FINEBLUE.title, brand: 'Fineblue',
  image: 'https://img.invalid/f.jpg', price: 9.79, currency: 'EUR', category: 'Sonido', capturedAt: '2026-11-09T09:00:00Z', ...over,
});
const fine = (over = {}) => ({ ...clone(FINEBLUE), ...over });

const amazonFicha = (over = {}) => ({
  id: 'amazon-b0test0001', title: 'Portátil de prueba Zeta 15', price: 500, currency: 'EUR', network: 'amazon', merchant: 'Amazon', asin: 'B0TEST0001', sourceId: 'B0TEST0001',
  brand: 'Zeta', category: 'Informática', affiliateUrl: 'https://www.amazon.es/dp/B0TEST0001', condition: 'Nuevo', extra: { variantAttributes: { color: 'Gris', capacity: '512GB' } }, ...over,
});
const amz = (over = {}) => ({
  platform: 'amazon', externalId: 'B0TEST0001', url: 'https://www.amazon.es/dp/B0TEST0001', title: 'Portátil de prueba Zeta 15', brand: 'Zeta', image: 'https://img.invalid/a.jpg',
  price: 510, currency: 'EUR', category: 'Informática', color: 'Gris', capacity: '512GB', condition: 'new', capturedAt: '2026-11-09T09:00:00Z', ...over,
});

/** El motor NO escribió nada: nada creado, ninguna ficha ni oferta modificada, el catálogo de salida es idéntico al de entrada. */
function assertUntouched(before, out, why) {
  assert.equal(out.changed, false, `${why}: no debe cambiar nada`);
  assert.equal(snap(out.products), snap(before), `${why}: el catálogo debe salir idéntico`);
  assert.equal(out.products.length, before.length, `${why}: no se crea ninguna ficha`);
  for (const r of out.results) assert.deepEqual(r.entities, { productsCreated: 0, offersCreated: 0, offersUpdated: 0 }, why + ': sin entidades creadas ni actualizadas');
}
function assertReview(before, out, reasonStart, why) {
  assert.equal(out.results[0].outcome, 'review', `${why}: ${JSON.stringify(out.results[0])}`);
  assert.ok(out.results[0].reasons.some((r) => r.startsWith(reasonStart)), `${why}: motivos ${JSON.stringify(out.results[0].reasons)}`);
  assertUntouched(before, out, why);
}

/* ───────────── Fineblue F920: mismo anuncio por API y por JSON ───────────── */

test('Fineblue · mismo anuncio y MISMO vendedor (API → JSON): no se duplica la oferta ni se vincula como «otro vendedor»', () => {
  const before = [fine()];
  const out = run(deepFreeze(clone(before)), [ae({ sellerName: 'E-muzic Store' })]);
  assert.notEqual(out.results[0].outcome, 'linked');
  assert.ok(['unchanged', 'updated'].includes(out.results[0].outcome), JSON.stringify(out.results[0]));
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].extra.offers, undefined, 'ninguna oferta explícita duplicada');
  assert.equal(getOffers(out.products[0]).length, 1);
  assert.equal(out.products[0].price, 9.79);
  assert.equal(getComparableOffers(out.products[0]).offers.length, 1);
});

test('Fineblue · el vendedor sólo en fulfillmentProvider (26 fichas de producción) también se reconoce: misma oferta, sin duplicar', () => {
  const p = fine(); delete p.extra.Tienda; delete p.extra.Distribuidor;
  const out = run([p], [ae({ sellerName: 'E-muzic Store' })]);
  assert.notEqual(out.results[0].outcome, 'linked');
  assert.equal(out.products[0].extra.offers, undefined);
  assert.equal(getOffers(out.products[0]).length, 1);
});

test('Fineblue · VENDEDOR DIFERENTE en un anuncio de AliExpress (un vendedor por anuncio): revisión; no vincula, no actualiza y no crea', () => {
  const before = [fine()];
  const out = run(clone(before), [ae({ sellerName: 'Tienda B', price: 10.49 })]);
  assertReview(before, out, 'anuncio_con_vendedor_distinto', 'otro vendedor');
  assert.match(out.results[0].reasons[0], /E-muzic Store≠Tienda B/);
  assert.equal(out.results[0].candidates[0].productId, FINEBLUE.id, 'el diagnóstico indica la ficha afectada');
});

test('vendedor DESCONOCIDO en el registro: una ficha con UNA sola oferta se actualiza como siempre; con otras ofertas no se asume nada', () => {
  const upd = run([fine()], [ae({ price: 9.5 })]);
  assert.equal(upd.results[0].outcome, 'updated', 'comportamiento actual conservado');
  assert.equal(getOffers(upd.products[0]).length, 1);
  // Amazon con una oferta de vendedor conocido: un registro sin vendedor no puede asumirse igual
  const before = [amazonFicha({ extra: { variantAttributes: { color: 'Gris', capacity: '512GB' }, offerSeller: { id: 'A1', name: 'TiendaCPU' } } })];
  assertReview(before, run(clone(before), [amz()]), 'vendedor_no_confirmado', 'sin vendedor frente a vendedor conocido');
  // dos ofertas del mismo anuncio y registro sin vendedor: ambiguo
  const two = [amazonFicha({ extra: { variantAttributes: { color: 'Gris', capacity: '512GB' }, offers: [{
    offerId: 'x1', offerKey: 'amazon:B0TEST0001:foo', platform: 'amazon', externalId: 'B0TEST0001', sellerName: 'Foo', url: 'https://www.amazon.es/dp/B0TEST0001', canonicalUrl: 'amazon.es/dp/B0TEST0001',
    price: 520, currency: 'EUR', availability: 'in_stock', shipping: { cost: null, free: null, days: null }, condition: 'new', capturedAt: '', receivedAt: '', verifiedAt: '', source: { channel: 'json', batchId: 'b', adapter: 'json-import' }, status: 'active' }] } })];
  assertReview(two, run(clone(two), [amz()]), 'vendedor_no_confirmado_varias_ofertas', 'varias ofertas y sin vendedor');
});

test('vendedor MALFORMADO o logístico en el registro: se RECHAZA el valor (con aviso) y no se usa como vendedor', () => {
  for (const [bad, reason] of [['[object Object]', 'malformado'], ['undefined', 'malformado'], ['Amazon Logistics', 'logistica'], ['DHL', 'logistica']]) {
    const out = run([], [ae({ externalId: '1005009999999991', url: 'https://es.aliexpress.com/item/1005009999999991.html', sellerName: bad })]);
    assert.equal(out.results[0].outcome, 'created');
    assert.ok(out.results[0].warnings.includes(`vendedor_descartado:${reason}`), bad);
    assert.equal(out.products[0].extra.offerSeller, undefined, 'no se guarda como vendedor');
  }
  const ok = run([], [ae({ externalId: '1005009999999992', url: 'https://es.aliexpress.com/item/1005009999999992.html', sellerName: 'E-muzic Store' })]);
  assert.deepEqual(ok.products[0].extra.offerSeller, { name: 'E-muzic Store' });
  assert.ok(!ok.results[0].warnings.some((w) => w.startsWith('vendedor_descartado')));
});

/* ───────────── Variantes, cantidades, condición y moneda ───────────── */

test('mismo anuncio y vendedor, COLOR diferente → revisión (no actualiza el precio de otra variante)', () => {
  const before = [amazonFicha()];
  assertReview(before, run(clone(before), [amz({ color: 'Negro', price: 530 })]), 'variante_distinta:color', 'color en la misma oferta');
});

test('mismo anuncio, otro vendedor y color diferente o NO verificable → revisión', () => {
  const before = [amazonFicha()];
  assertReview(before, run(clone(before), [amz({ sellerName: 'Vendedor Dos', sellerId: 'A2', color: 'Negro' })]), 'variante_distinta:color', 'otro vendedor, otro color');
  assertReview(before, run(clone(before), [amz({ sellerName: 'Vendedor Dos', sellerId: 'A2', color: undefined })]), 'variante_no_verificable:color', 'otro vendedor, sin color');
  assertReview(before, run(clone(before), [amz({ sellerName: 'Vendedor Dos', sellerId: 'A2', capacity: '1TB' })]), 'variante_distinta:capacity', 'otra capacidad');
});

test('PACK/CANTIDAD: un pack de 3 nunca se compara ni actualiza con una unidad (ni sin dato de cantidad en la ficha)', () => {
  const sinPack = [amazonFicha()];
  assertReview(sinPack, run(clone(sinPack), [amz({ pack: '3', price: 1400 })]), 'cantidad_no_verificable:pack', 'ficha sin cantidad frente a pack de 3');
  const unidad = [amazonFicha({ extra: { variantAttributes: { color: 'Gris', capacity: '512GB', pack: '1' } } })];
  assertReview(unidad, run(clone(unidad), [amz({ pack: '3', price: 1400 })]), 'cantidad_distinta:pack', '1 frente a 3');
  assertReview(unidad, run(clone(unidad), [amz({ pack: '3', sellerName: 'Vendedor Dos', sellerId: 'A2' })]), 'cantidad_distinta:pack', 'otro vendedor con pack de 3');
  const ok = run(clone(unidad), [amz({ pack: '1', price: 505 })]);
  assert.equal(ok.results[0].outcome, 'updated', 'misma cantidad: se actualiza');
});

test('CONDICIÓN diferente (nueva/usada/reacondicionada) → revisión; con información insuficiente al vincular también', () => {
  const before = [amazonFicha()];
  assertReview(before, run(clone(before), [amz({ condition: 'used', price: 300 })]), 'condicion_distinta', 'nueva frente a usada');
  assertReview(before, run(clone(before), [amz({ condition: 'refurbished', sellerName: 'Vendedor Dos', sellerId: 'A2' })]), 'condicion_distinta', 'reacondicionada de otro vendedor');
  assertReview(before, run(clone(before), [amz({ condition: undefined, sellerName: 'Vendedor Dos', sellerId: 'A2' })]), 'condicion_no_verificable', 'condición desconocida al vincular');
});

test('MONEDA diferente → revisión (sin conversión automática), tanto al actualizar como al vincular', () => {
  const before = [amazonFicha()];
  assertReview(before, run(clone(before), [amz({ currency: 'USD', price: 560 })]), 'moneda_distinta:EUR≠USD', 'misma oferta en USD');
  assertReview(before, run(clone(before), [amz({ currency: 'USD', sellerName: 'Vendedor Dos', sellerId: 'A2' })]), 'moneda_distinta:EUR≠USD', 'otro vendedor en USD');
});

/* ───────────── Anuncios repetidos (18 fichas intactas) ───────────── */

function repeatedListings() {
  const sizes = [3, 4, 3, 4, 2, 2];
  const stores = ["Stone's Store", 'AUFU 3C Global Store', 'BASEUS Choice Store', 'Toocki Direct Flagship Store', 'Toocki Direct Choice Store', 'Toocki Direct Choice Store'];
  const out = [];
  sizes.forEach((n, g) => {
    for (let i = 1; i <= n; i++) {
      out.push({ id: `grupo${g + 1}-ficha${i}`, title: `Cargador de prueba ${g + 1} título ${i}`, description: `Texto editorial ${g}-${i}`, price: 3.59 + g, network: 'aliexpress', merchant: 'aliexpress', brand: 'AliExpress',
        sourceId: `10050069952392${g}0`, fulfillmentProvider: stores[g], affiliateUrl: `https://s.click.aliexpress.com/s/grupo${g + 1}`, extra: {} });
    }
  });
  return out;
}

test('ANUNCIO EN VARIAS FICHAS (6 anuncios, 18 fichas): cualquier registro va a revisión sin crear otra ficha, sin elegir una al azar y sin tocar ninguna', () => {
  const catalog = repeatedListings();
  assert.equal(catalog.length, 18);
  const before = snap(catalog);
  const variants = [
    { sellerName: undefined, price: 3.59 }, { sellerName: 'Otra Tienda', price: 2 }, { sellerName: "Stone's Store", price: 3.59 }, { sellerName: undefined, price: 99 },
  ];
  for (let g = 0; g < 6; g++) {
    for (const v of variants) {
      const out = run(deepFreeze(clone(catalog)), [ae({ externalId: `10050069952392${g}0`, url: `https://es.aliexpress.com/item/10050069952392${g}0.html`, title: `Cargador de prueba ${g + 1}`, ...v })]);
      assert.equal(out.results[0].outcome, 'review', `grupo ${g + 1} ${JSON.stringify(v)}`);
      assert.deepEqual(out.results[0].reasons, ['anuncio_en_varias_fichas']);
      assert.ok(out.results[0].candidates.length >= 2, 'el diagnóstico lista las fichas implicadas');
      assert.equal(out.changed, false);
      assert.equal(snap(out.products), before, 'las 18 fichas salen idénticas');
    }
  }
});

test('«Solo productos nuevos» + anuncio en varias fichas: se OMITE como «ya existe» (no se crea otra ficha) con el diagnóstico', () => {
  const catalog = repeatedListings();
  const out = run(clone(catalog), [ae({ externalId: '1005006995239200', url: 'https://es.aliexpress.com/item/1005006995239200.html', title: 'Cargador de prueba 1' })], { onlyNew: true });
  assert.deepEqual(out.results.map((r) => r.outcome), ['unchanged']);
  assert.deepEqual(out.results[0].reasons, ['ya_existe_omitido', 'anuncio_en_varias_fichas']);
  assert.equal(snap(out.products), snap(catalog));
});

test('un anuncio NUEVO sigue creándose con normalidad aunque el catálogo contenga anuncios repetidos', () => {
  const catalog = repeatedListings();
  const out = run(clone(catalog), [ae({ externalId: '1005008888888888', url: 'https://es.aliexpress.com/item/1005008888888888.html', title: 'Auriculares totalmente distintos' })]);
  assert.equal(out.results[0].outcome, 'created');
  assert.equal(out.products.length, 19);
  assert.equal(snap(out.products.slice(1)), snap(catalog), 'las 18 existentes intactas');
});

/* ───────────── Identificadores fuertes con datos contradictorios ───────────── */

test('ASIN existente con un producto CONTRADICTORIO → revisión (el identificador fuerte no anula la contradicción)', () => {
  const book4 = amazonFicha({ id: 'amazon-b0dvwddjdp', asin: 'B0DVWDDJDP', sourceId: 'B0DVWDDJDP', affiliateUrl: 'https://www.amazon.es/dp/B0DVWDDJDP', title: 'Ordenador portátil ultrafino Samsung Galaxy Book4 15,6"', brand: 'Samsung', price: 729 });
  const before = [book4];
  const base = { externalId: 'B0DVWDDJDP', url: 'https://www.amazon.es/dp/B0DVWDDJDP', sellerName: 'TiendaX', sellerId: 'AX', price: 1500, brand: 'Samsung' };
  assertReview(before, run(clone(before), [amz({ ...base, title: 'Ordenador portátil Samsung Galaxy Book4 Pro 14"' })]), 'titulo_incompatible', 'Book4 Pro con el ASIN del Book4');
  assertReview(before, run(clone(before), [amz({ ...base, title: book4.title, brand: 'Lenovo' })]), 'marca_contradictoria', 'otra marca');
  const withGtin = [{ ...book4, extra: { ...book4.extra, identifiers: { gtin: '4006381333931' } } }];
  assertReview(withGtin, run(clone(withGtin), [amz({ ...base, title: book4.title, gtin: '5449000000996' })]), 'gtin_contradictorio', 'otro GTIN');
});

test('IDENTIFICADORES CONTRADICTORIOS en el propio registro (id declarado ≠ id de su URL): revisión sin tocar nada', () => {
  const before = [amazonFicha()];
  const out = run(clone(before), [amz({ externalId: 'B0TEST0001', url: 'https://www.amazon.es/dp/B0CCCCCCCC' })]);
  assert.equal(out.results[0].outcome, 'review');
  assert.equal(out.results[0].reasons[0], 'identificadores_contradictorios');
  assertUntouched(before, out, 'id contra URL');
  const ali = run([fine()], [ae({ url: 'https://es.aliexpress.com/item/1005000000000009.html' })]);
  assert.equal(ali.results[0].reasons[0], 'identificadores_contradictorios');
});

test('Samsung Galaxy Book4 frente a Book4 Pro: marca y «Nombre del modelo» iguales NO los unen; cada uno conserva su ficha', () => {
  const specs = { Marca: 'Samsung', 'Nombre Del Modelo': 'Samsung Galaxy Book4' };
  const book4 = amazonFicha({ id: 'amazon-b0dvwddjdp', asin: 'B0DVWDDJDP', sourceId: 'B0DVWDDJDP', affiliateUrl: 'https://www.amazon.es/dp/B0DVWDDJDP', title: 'Ordenador portátil ultrafino Samsung Galaxy Book4 15,6"', brand: 'Samsung', price: 729, specs });
  const pro = { platform: 'amazon', externalId: 'B0D4WQZSXD', url: 'https://www.amazon.es/dp/B0D4WQZSXD', title: 'Ordenador portátil Samsung Galaxy Book4 Pro 14"', brand: 'Samsung', specs, image: 'https://img.invalid/s.jpg', price: 1599.99, currency: 'EUR', category: 'Informática', sellerName: 'TiendaCPU', sellerId: 'A3GU', capturedAt: '2026-11-09T09:00:00Z' };
  const out = run([book4], [pro]);
  assert.equal(out.results[0].outcome, 'created', 'ficha propia, no se une al Book4');
  assert.equal(out.products.length, 2);
  assert.equal(snap(out.products[1]), snap(book4), 'el Book4 queda intacto');
  assert.equal(getOffers(out.products[1]).length, 1);
  // Sin identificador fuerte y con el mismo marca+modelo: tampoco se vincula.
  const noId = run([book4], [{ ...pro, platform: 'tienda', externalId: 'SB4', url: 'https://t.invalid/sb4', title: 'Samsung Galaxy Book4', sellerName: undefined, sellerId: undefined }]);
  assert.notEqual(noId.results[0].outcome, 'linked');
  assert.notEqual(noId.results[0].outcome, 'updated');
  assert.equal(snap(noId.products.find((p) => p.id === book4.id)), snap(book4));
});

test('TÍTULO SIMILAR sin identificador fuerte: no se vincula (revisión) y la ficha no cambia', () => {
  const before = [fine()];
  const out = run(clone(before), [ae({ externalId: '1005007777777777', url: 'https://es.aliexpress.com/item/1005007777777777.html' })]);
  assertReview(before, out, 'titulo_parecido_sin_identificador_fuerte', 'mismo título, otro anuncio');
});

/* ───────────── Variante, cantidad, condición y moneda se CONSERVAN en las ofertas nuevas; lo antiguo no se toca ───────────── */

const oldOffer = {
  offerId: 'old1', offerKey: 'amazon:B0TEST0001:viejo', platform: 'amazon', externalId: 'B0TEST0001', sellerName: 'Viejo', url: 'https://www.amazon.es/dp/B0TEST0001', canonicalUrl: 'amazon.es/dp/B0TEST0001',
  price: 520, currency: 'EUR', availability: 'in_stock', shipping: { cost: null, free: null, days: null }, condition: 'new', capturedAt: '2026-10-01T00:00:00Z', receivedAt: '2026-10-01T00:00:00Z', verifiedAt: '',
  source: { channel: 'json', batchId: 'old', adapter: 'json-import' }, status: 'active',
};

test('una oferta NUEVA conserva variante, cantidad, condición, moneda, identificador comercial y vendedor; la oferta antigua queda byte a byte igual', () => {
  const ficha = amazonFicha({ extra: { variantAttributes: { color: 'Gris', capacity: '512GB', pack: '1' }, offers: [oldOffer] } });
  const out = run(deepFreeze(clone([ficha])), [amz({ sellerName: 'Vendedor Dos', sellerId: 'A2', pack: '1', price: 515 })]);
  assert.equal(out.results[0].outcome, 'linked', JSON.stringify(out.results[0]));
  const offers = out.products[0].extra.offers;
  assert.equal(offers.length, 2);
  assert.equal(snap(offers[0]), snap(oldOffer), 'la oferta antigua NO se modifica ni se completa');
  assert.equal(offers[0].variant, undefined);
  const added = offers[1];
  assert.deepEqual(added.variant, { color: 'Gris', capacity: '512GB', pack: '1' });
  assert.equal(added.quantity, '1');
  assert.equal(added.condition, 'new');
  assert.equal(added.currency, 'EUR');
  assert.equal(added.externalId, 'B0TEST0001');
  assert.equal(added.sellerName, 'Vendedor Dos');
  assert.equal(added.sellerId, 'A2');
  // La capa de lectura entiende los atributos guardados: la nueva es comparable; la antigua (sin variante) queda en revisión.
  const r = getComparableOffers(out.products[0]);
  assert.deepEqual(r.offers.map((o) => o.sellerLabel), ['Vendedor no indicado', 'Vendedor Dos'], 'la oferta principal y la nueva');
  assert.deepEqual(r.needsReview.map((x) => x.reason), ['variante_no_verificable']);
});

test('no se INVENTAN valores ausentes: sin variante ni cantidad en el registro, la oferta nueva no guarda esos campos', () => {
  const ficha = amazonFicha({ extra: {} , condition: undefined });
  const out = run([ficha], [amz({ sellerName: 'Vendedor Dos', sellerId: 'A2', color: undefined, capacity: undefined, condition: undefined })]);
  assert.equal(out.results[0].outcome, 'linked', JSON.stringify(out.results[0]));
  const added = out.products[0].extra.offers[0];
  assert.equal(added.variant, undefined);
  assert.equal(added.quantity, undefined);
  assert.equal(added.condition, 'unknown');
});

test('actualizar una oferta ANTIGUA sin variante no le añade atributos (no se completa artificialmente) y no pierde nada', () => {
  const ficha = amazonFicha({ extra: { offers: [oldOffer] } , condition: undefined });
  const out = run([ficha], [amz({ sellerName: 'Viejo', color: 'Gris', condition: 'Nuevo', price: 480, capturedAt: '2026-11-09T09:00:00Z' })]);
  assert.equal(out.results[0].outcome, 'updated', JSON.stringify(out.results[0]));
  const stored = out.products[0].extra.offers[0];
  assert.equal(stored.price, 480);
  assert.equal(stored.variant, undefined, 'sigue sin variante');
  assert.equal(stored.sellerName, 'Viejo');
  assert.equal(stored.offerKey, oldOffer.offerKey, 'la clave no se reescribe');
  assert.equal(stored.offerId, oldOffer.offerId);
});

test('sin pérdida de información: vincular o actualizar conserva texto enriquecido, bloqueos, specs e identificadores de la ficha', () => {
  const ficha = amazonFicha({ extra: { variantAttributes: { color: 'Gris', capacity: '512GB' }, lockedFields: ['verdict', 'title'], identifiers: { asin: 'B0TEST0001' } }, verdict: 'Veredicto editado a mano', specs: { Marca: 'Zeta' }, pros: ['a'], cons: ['b'] });
  const linked = run([ficha], [amz({ sellerName: 'Vendedor Dos', sellerId: 'A2' })]);
  const updated = run([ficha], [amz({ price: 495 })]);
  for (const out of [linked, updated]) {
    const p = out.products[0];
    assert.equal(p.verdict, 'Veredicto editado a mano');
    assert.deepEqual(p.extra.lockedFields, ['verdict', 'title']);
    assert.deepEqual(p.extra.identifiers, { asin: 'B0TEST0001' });
    assert.deepEqual(p.extra.variantAttributes, { color: 'Gris', capacity: '512GB' });
    assert.equal(p.specs.Marca, 'Zeta');
    assert.deepEqual(p.pros, ['a']);
    assert.equal(p.title, ficha.title);
  }
});

/* ───────────── onlyNew y linkOffers ───────────── */

test('«Solo productos nuevos» conserva su comportamiento: omite lo que existe, también si el registro habría ido a revisión por seguridad; crea lo nuevo', () => {
  const catalog = [amazonFicha()];
  const same = run(clone(catalog), [amz()], { onlyNew: true });
  assert.deepEqual([same.results[0].outcome, same.results[0].reasons], ['unchanged', ['ya_existe_omitido']]);
  const colour = run(clone(catalog), [amz({ color: 'Negro' })], { onlyNew: true });
  assert.deepEqual([colour.results[0].outcome, colour.results[0].reasons], ['unchanged', ['ya_existe_omitido', 'variante_distinta:color']]);
  const link = run(clone(catalog), [amz({ sellerName: 'Vendedor Dos', sellerId: 'A2' })], { onlyNew: true });
  assert.deepEqual([link.results[0].outcome, link.results[0].reasons], ['unchanged', ['ya_existe_omitido']], 'vincular sigue bloqueado');
  for (const out of [same, colour, link]) assert.equal(snap(out.products), snap(catalog));
  const fresh = run(clone(catalog), [ae({ externalId: '1005006666666666', url: 'https://es.aliexpress.com/item/1005006666666666.html', title: 'Cosa nueva distinta' })], { onlyNew: true });
  assert.equal(fresh.results[0].outcome, 'created');
});

test('linkOffers sigue INEXISTENTE y desactivada: ni el motor, ni su servicio, ni las opciones la mencionan', () => {
  const root = path.resolve(import.meta.dirname, '../../src');
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|astro|mjs)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('linkOffers')) hits.push(path.relative(root, p)); } };
  walk(root);
  assert.deepEqual(hits, []);
});

/* ───────────── Regresión por plataforma ───────────── */

test('REGRESIÓN AliExpress: crear, reimportar sin cambios (no duplica) y actualizar precio', () => {
  const rec = ae({ externalId: '1005001111111111', url: 'https://es.aliexpress.com/item/1005001111111111.html', title: 'Cable de prueba Toocki', sellerName: 'Toocki Store', price: 2 });
  const created = run([], [rec]);
  assert.equal(created.results[0].outcome, 'created');
  assert.deepEqual(created.products[0].extra.offerSeller, { name: 'Toocki Store' });
  const again = run(clone(created.products), [rec]);
  assert.equal(again.results[0].outcome, 'unchanged');
  assert.equal(getOffers(again.products[0]).length, 1);
  const upd = run(clone(created.products), [{ ...rec, price: 1.8, capturedAt: '2026-11-09T09:30:00Z' }]);
  assert.equal(upd.results[0].outcome, 'updated');
  assert.equal(upd.products[0].price, 1.8);
});

test('REGRESIÓN eBay: crear con vendedor y condición; reimportar igual no duplica; otro vendedor o condición distinta → revisión', () => {
  const rec = { platform: 'ebay', externalId: '123456789012', url: 'https://www.ebay.es/itm/123456789012', title: 'Móvil de prueba Zeta', brand: 'Zeta', image: 'https://img.invalid/e.jpg', price: 100, currency: 'EUR', category: 'Móviles', sellerName: 'movitel-shop', condition: 'used', capturedAt: '2026-11-09T09:00:00Z' };
  const created = run([], [rec], {}, { category: 'Móviles' });
  assert.equal(created.results[0].outcome, 'created');
  const again = run(clone(created.products), [rec], {}, { category: 'Móviles' });
  assert.equal(again.results[0].outcome, 'unchanged');
  assert.equal(getOffers(again.products[0]).length, 1);
  assertReview(created.products, run(clone(created.products), [{ ...rec, sellerName: 'otra-tienda' }], {}, { category: 'Móviles' }), 'anuncio_con_vendedor_distinto', 'eBay otro vendedor');
  assertReview(created.products, run(clone(created.products), [{ ...rec, condition: 'new' }], {}, { category: 'Móviles' }), 'condicion_distinta', 'eBay otra condición');
});

test('REGRESIÓN Amazon: ASIN nuevo se crea; el vendedor «Amazon» es la propia plataforma (misma oferta); un tercero se vincula', () => {
  const created = run([], [amz({ externalId: 'B0TEST0002', url: 'https://www.amazon.es/dp/B0TEST0002', title: 'Teclado de prueba Zeta', color: undefined, capacity: undefined, condition: undefined })]);
  assert.equal(created.results[0].outcome, 'created');
  const ownSeller = run(clone(created.products), [amz({ externalId: 'B0TEST0002', url: 'https://www.amazon.es/dp/B0TEST0002', title: 'Teclado de prueba Zeta', color: undefined, capacity: undefined, condition: undefined, sellerName: 'Amazon' })]);
  assert.equal(ownSeller.results[0].outcome, 'unchanged');
  const third = run(clone(created.products), [amz({ externalId: 'B0TEST0002', url: 'https://www.amazon.es/dp/B0TEST0002', title: 'Teclado de prueba Zeta', color: undefined, capacity: undefined, condition: undefined, sellerName: 'Tercero SL', sellerId: 'AT', price: 30 })]);
  assert.equal(third.results[0].outcome, 'linked');
  assert.equal(getOffers(third.products[0]).length, 2);
});

test('REGRESIÓN Temu (multivendedor por anuncio): otro vendedor del mismo anuncio se vincula y se conserva la oferta existente; reimportar no duplica', () => {
  const temu = (over = {}) => ({ platform: 'temu', externalId: '701000000000001', url: 'https://www.temu.com/es/-g-701000000000001.html', title: 'Organizador de prueba', brand: 'Zeta', image: 'https://img.invalid/t.jpg', price: 5, currency: 'EUR', category: 'Hogar', capturedAt: '2026-11-09T09:00:00Z', ...over });
  const first = run([], [temu({ sellerName: 'Mall Uno', sellerId: 'M1' })], {}, { category: 'Hogar' });
  assert.equal(first.results[0].outcome, 'created');
  const second = run(clone(first.products), [temu({ sellerName: 'Mall Dos', sellerId: 'M2', price: 4.5 })], {}, { category: 'Hogar' });
  assert.equal(second.results[0].outcome, 'linked');
  assert.equal(getOffers(second.products[0]).length, 2);
  const again = run(clone(second.products), [temu({ sellerName: 'Mall Dos', sellerId: 'M2', price: 4.5 })], {}, { category: 'Hogar' });
  assert.equal(again.results[0].outcome, 'unchanged');
  assert.equal(getOffers(again.products[0]).length, 2, 'no se duplica');
});

test('REGRESIÓN JSON plano sin vendedor: crea, y reimportar el mismo registro no duplica ni cambia nada', () => {
  const flat = { title: 'Altavoz Zeta plano', brand: 'Zeta', image: 'https://img.invalid/z.jpg', platform: 'tienda', externalId: 'Z99', url: 'https://tienda.invalid/z/99', price: 30, currency: 'EUR', category: 'Audio', capturedAt: '2026-11-09T09:00:00Z' };
  const created = run([], [flat], {}, { category: 'Audio' });
  assert.equal(created.results[0].outcome, 'created');
  const again = run(clone(created.products), [flat], {}, { category: 'Audio' });
  assert.equal(again.results[0].outcome, 'unchanged');
  assert.equal(getOffers(again.products[0]).length, 1);
});

test('el motor no muta el catálogo de entrada (objetos congelados) en ningún flujo', () => {
  const catalog = deepFreeze([amazonFicha({ extra: { variantAttributes: { color: 'Gris', capacity: '512GB' }, offers: [oldOffer] } })]);
  const records = [amz({ sellerName: 'Vendedor Dos', sellerId: 'A2' }), amz({ color: 'Negro' }), amz({ currency: 'USD' }), amz({ price: 600 }), ae(), amz({ externalId: 'B0NUEVO001', url: 'https://www.amazon.es/dp/B0NUEVO001', title: 'Otro producto' })];
  assert.doesNotThrow(() => run(catalog, records));
});
