// ETAPA 1 · Capa de lectura de ofertas comparables (sólo lectura). Datos aislados y sintéticos; el único dato «real» es el fixture público
// del Fineblue F920. Sin red, sin IA, sin escribir en catálogos, sin importaciones reales y con linkOffers DESACTIVADA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-comparable-offers-');
const lib = await import('../../src/lib/comparableOffers.ts');
const engine = await import('../../src/lib/jsonImport/engine.ts');
const { getComparableOffers, groupByCommercialIdentity, commercialIdentityOf, resolveSeller, sellerRejection, sameSeller, SELLER_UNKNOWN_LABEL, NOT_INDICATED_LABEL } = lib;

const FINEBLUE = JSON.parse(fs.readFileSync(new URL('./fixtures/fineblue-f920.json', import.meta.url), 'utf8'));
const clone = (v) => structuredClone(v);
const fine = (over = {}) => ({ ...clone(FINEBLUE), ...over });
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const AE = '1005005704532450';

/** Oferta explícita con la forma real de `extra.offers` (la que guarda el importador). */
const explicitOffer = (over = {}) => {
  const platform = over.platform ?? 'aliexpress';
  const externalId = over.externalId ?? AE;
  const sellerName = over.sellerName;
  return {
    offerId: over.offerId ?? 'o' + Math.random().toString(36).slice(2, 10),
    offerKey: over.offerKey ?? `${platform}:${externalId}${sellerName ? ':' + sellerName.toLowerCase() : ''}`,
    platform, externalId, sellerName, sellerId: over.sellerId,
    url: over.url ?? `https://es.aliexpress.com/item/${externalId}.html`,
    canonicalUrl: over.canonicalUrl ?? `es.aliexpress.com/item/${externalId}.html`,
    price: over.price ?? 10.49, currency: over.currency ?? 'EUR', availability: over.availability ?? 'in_stock',
    shipping: over.shipping ?? { cost: null, free: null, days: null },
    condition: over.condition ?? 'unknown', capturedAt: '2026-11-09T09:00:00Z', receivedAt: '2026-11-09T10:00:00Z',
    verifiedAt: over.verifiedAt ?? '', source: { channel: 'json', batchId: 'b', adapter: 'json-import' }, status: over.status ?? 'active',
    ...(over.variant ? { variant: over.variant } : {}), ...(over.quantity ? { quantity: over.quantity } : {}),
  };
};
const withOffers = (p, offers) => ({ ...p, extra: { ...(p.extra ?? {}), offers } });
const reasons = (r) => r.excluded.map((e) => e.reason);

/* ───────────── Fineblue F920: una oferta ───────────── */

test('Fineblue F920 · UNA oferta válida: AliExpress, vendedor E-muzic Store, 9,79 EUR, y todo lo demás «no confirmado»', () => {
  const r = getComparableOffers(fine());
  assert.equal(r.state, 'single');
  assert.equal(r.offers.length, 1);
  const o = r.offers[0];
  assert.equal(o.platform, 'aliexpress');
  assert.equal(o.listingId, `aliexpress:${AE}`);
  assert.equal(o.seller.name, 'E-muzic Store');
  assert.equal(o.seller.source, 'Tienda');
  assert.equal(o.sellerLabel, 'E-muzic Store');
  assert.equal(o.price, 9.79);
  assert.equal(o.currency, 'EUR');
  assert.equal(o.currencyAssumed, false);
  assert.equal(o.availability, 'in_stock');
  // Envío, pago, devolución y entrega: información no confirmada.
  assert.equal(o.shipping.confirmed, false);
  assert.equal(o.shipping.cost, null);
  assert.equal(o.shipping.days, null);
  assert.equal(o.totalPrice, null, 'sin envío conocido no se afirma un total');
  assert.equal(o.payment, null);
  assert.equal(o.returns, null);
  assert.equal(o.delivery, null);
  assert.equal(NOT_INDICATED_LABEL, 'No indicado');
  assert.equal(o.verified, false, 'una importación no acredita verificación');
  assert.equal(r.cheapest, null);
  assert.equal(r.comparisonReady, false);
  assert.deepEqual(r.needsReview, []);
  assert.deepEqual(r.otherVersions, []);
});

test('la oferta devuelta conserva el offerId, la clave y las URL EXISTENTES (no se reescribe nada) y el enlace de afiliado', () => {
  const p = fine();
  const existing = engine.getOffers(p)[0];
  const o = getComparableOffers(p).offers[0];
  assert.equal(o.offerId, existing.offerId);
  assert.equal(o.offerKey, existing.offerKey);
  assert.equal(o.url, existing.url);
  assert.equal(o.affiliateUrl, p.affiliateUrl, 'la atribución del enlace de afiliado se conserva');
});

/* ───────────── Cero ofertas válidas ───────────── */

test('CERO ofertas válidas: sin precio, sin enlace, agotada, moneda no EUR o sin identidad de anuncio', () => {
  const cases = [
    [{ price: 0 }, 'sin_precio'],
    [{ affiliateUrl: '', buyNowUrl: '' }, 'sin_identidad_de_anuncio'],
    [{ inStock: false }, 'agotada'],
    [{ currency: 'USD' }, 'moneda_incompatible'],
  ];
  for (const [over, reason] of cases) {
    const p = fine(over);
    if (reason === 'sin_identidad_de_anuncio') { delete p.sourceId; p.extra = { ...p.extra }; delete p.extra['ID externo']; }
    const r = getComparableOffers(p);
    assert.equal(r.state, 'none', JSON.stringify(over));
    assert.equal(r.offers.length, 0);
    assert.ok(reasons(r).includes(reason), `${JSON.stringify(over)} → ${JSON.stringify(reasons(r))}`);
    assert.equal(r.cheapest, null);
  }
});

/* ───────────── Varias ofertas ───────────── */

test('VARIAS ofertas del mismo producto: dos vendedores del mismo anuncio, ordenadas y sin «la más barata» si falta el envío', () => {
  const p = withOffers(fine(), [explicitOffer({ sellerName: 'Tienda B', price: 10.49 })]);
  const r = getComparableOffers(p);
  assert.equal(r.state, 'multiple');
  assert.deepEqual(r.offers.map((o) => o.sellerLabel), ['E-muzic Store', 'Tienda B']);
  assert.deepEqual(r.offers.map((o) => o.price), [9.79, 10.49]);
  assert.equal(r.cheapest, null, 'los totales con envío son desconocidos');
  assert.equal(r.comparisonReady, false, 'ninguna está verificada');
});

test('«la más barata» sólo con todos los totales conocidos; un empate no se presenta como ganadora; verificación → comparisonReady', () => {
  const known = (cost) => ({ cost, free: cost === 0 ? true : null, days: null });
  const base = fine({ freeShipping: false });
  // El envío de la oferta principal se conoce con `extra.offers`? No: la implícita sólo lo tiene si la ficha lo declara.
  const p = { ...base, shippingDays: 5, extra: { ...base.extra } };
  const two = withOffers(p, [explicitOffer({ sellerName: 'Tienda B', price: 5, shipping: known(0), verifiedAt: '2026-11-09T08:00:00Z' })]);
  assert.equal(getComparableOffers(two).cheapest, null, 'la oferta principal no tiene envío conocido');
  const free = { ...p, freeShipping: true };
  const r = getComparableOffers(withOffers(free, [explicitOffer({ sellerName: 'Tienda B', price: 5, shipping: known(4.8), verifiedAt: '2026-11-09T08:00:00Z' })]));
  assert.equal(r.offers.length, 2);
  assert.equal(r.cheapest?.sellerLabel, 'E-muzic Store', '9,79 € con envío gratis < 5 € + 4,80 € de envío = 9,80 €');
  assert.equal(r.cheapest.totalPrice, 9.79);
  const tie = getComparableOffers(withOffers({ ...free, price: 9.8 }, [explicitOffer({ sellerName: 'Tienda B', price: 5, shipping: known(4.8) })]));
  assert.equal(tie.cheapest, null, 'empate a 9,80 €');
  const verified = getComparableOffers(withOffers({ ...free, lastPriceSync: '2026-11-09T07:00:00Z' }, [explicitOffer({ sellerName: 'Tienda B', price: 5, verifiedAt: '2026-11-09T08:00:00Z' })]));
  assert.equal(verified.verifiedCount, 2);
  assert.equal(verified.comparisonReady, true);
});

/* ───────────── Vendedor: jerarquía y validación ───────────── */

test('jerarquía del vendedor: offerSeller → Tienda → fulfillmentProvider', () => {
  const mk = (extra, ful) => ({ ...fine({ fulfillmentProvider: ful }), extra: { ...extra } });
  assert.deepEqual(
    [resolveSeller(mk({ offerSeller: { id: 'A1', name: 'Vendedor Uno' }, Tienda: 'Tienda Dos' }, 'Logística Tres')).name, resolveSeller(mk({ offerSeller: { id: 'A1', name: 'Vendedor Uno' }, Tienda: 'Tienda Dos' }, 'Logística Tres')).id],
    ['Vendedor Uno', 'A1'],
  );
  assert.equal(resolveSeller(mk({ Tienda: 'Tienda Dos' }, 'Tienda Tres')).name, 'Tienda Dos');
  assert.equal(resolveSeller(mk({}, 'Stone\'s Store')).name, "Stone's Store");
  assert.equal(resolveSeller(mk({}, 'Stone\'s Store')).source, 'fulfillmentProvider');
});

test('NO son vendedores válidos: plataformas, proveedores logísticos y valores malformados', () => {
  for (const [value, why] of [
    ['AliExpress', 'plataforma'], ['aliexpress', 'plataforma'], ['Amazon', 'plataforma'], ['eBay', 'plataforma'], ['Temu', 'plataforma'],
    ['Amazon Logistics', 'logistica'], ['DHL', 'logistica'], ['Cainiao', 'logistica'], ['AliExpress Standard Shipping', 'logistica'],
    ['[object Object]', 'malformado'], ['undefined', 'malformado'], ['null', 'malformado'], ['{"a":1}', 'malformado'], ['—', 'malformado'], ['12345', 'malformado'],
    ['', 'vacio'], [null, 'vacio'], [{ x: 1 }, 'malformado'],
  ]) assert.equal(sellerRejection(value), why, JSON.stringify(value));
  for (const ok of ['E-muzic Store', 'TiendaCPU', "Stone's Store", 'BASEUS Choice Store']) assert.equal(sellerRejection(ok), null, ok);
});

test('vendedor DESCONOCIDO: «Vendedor no indicado» (también en Amazon con «Amazon Logistics»)', () => {
  const amazon = { id: 'amazon-b0test0001', title: 'Portátil', price: 500, currency: 'EUR', network: 'amazon', merchant: 'Amazon', asin: 'B0TEST0001', sourceId: 'B0TEST0001', fulfillmentProvider: 'Amazon Logistics', affiliateUrl: 'https://www.amazon.es/dp/B0TEST0001', extra: {} };
  const r = getComparableOffers(amazon);
  assert.equal(r.state, 'single');
  assert.equal(r.offers[0].seller.known, false);
  assert.equal(r.offers[0].sellerLabel, SELLER_UNKNOWN_LABEL);
  assert.equal(SELLER_UNKNOWN_LABEL, 'Vendedor no indicado');
  assert.deepEqual(r.offers[0].seller.rejected.map((x) => x.reason), ['logistica']);
  const noInfo = getComparableOffers({ ...amazon, fulfillmentProvider: undefined });
  assert.equal(noInfo.offers[0].sellerLabel, SELLER_UNKNOWN_LABEL);
});

test('vendedor MALFORMADO ([object Object]): se descarta, se diagnostica y se sigue la jerarquía', () => {
  const p = { ...fine({ fulfillmentProvider: '[object Object]', merchant: '[object Object]' }), extra: { offerSeller: { id: 'X', name: '[object Object]' }, Tienda: { raw: 1 } } };
  const r = getComparableOffers(p);
  assert.equal(r.offers[0].sellerLabel, SELLER_UNKNOWN_LABEL);
  assert.ok(r.offers[0].seller.rejected.every((x) => x.reason === 'malformado'));
  assert.ok(r.offers[0].seller.rejected.length >= 3);
  // un malformado en el primer nivel no impide usar el siguiente válido
  const next = getComparableOffers({ ...fine(), extra: { ...fine().extra, offerSeller: { name: '[object Object]' } } });
  assert.equal(next.offers[0].sellerLabel, 'E-muzic Store');
  assert.equal(next.offers[0].seller.source, 'Tienda');
});

test('un nombre de plataforma en un nivel se salta hasta un vendedor real del siguiente', () => {
  const p = { ...fine({ fulfillmentProvider: 'Tienda Real' }), extra: { Tienda: 'AliExpress' } };
  const s = resolveSeller(p);
  assert.equal(s.name, 'Tienda Real');
  assert.deepEqual(s.rejected.map((x) => [x.source, x.reason]), [['Tienda', 'plataforma']]);
});

/* ───────────── API y JSON: la misma oferta ───────────── */

test('oferta repetida por API y JSON (mismo anuncio y vendedor): ya NO se duplica (etapa 1.5) y la capa de lectura cuenta UNA oferta', () => {
  const record = { platform: 'aliexpress', externalId: AE, url: `https://es.aliexpress.com/item/${AE}.html`, title: FINEBLUE.title, brand: 'Fineblue', image: 'https://img.invalid/f.jpg', price: 9.79, currency: 'EUR', category: 'Sonido', sellerName: 'E-muzic Store', capturedAt: '2026-11-09T09:00:00Z' };
  const out = engine.runImport([fine()], [record], { category: 'Sonido' }, { batchId: 'sim', nowIso: '2026-11-09T10:00:00.000Z', deletedIds: new Set() });
  const same = out.products.find((p) => p.id === FINEBLUE.id);
  assert.notEqual(out.results[0].outcome, 'linked', 'antes (etapa 1) el motor la vinculaba como segunda oferta: duplicado');
  assert.equal(same.extra.offers, undefined, 'no se guarda ninguna oferta explícita duplicada');
  const r = getComparableOffers(same);
  assert.equal(r.offers.length, 1);
  assert.equal(r.state, 'single');
});

test('misma oferta con otro vendedor: en AliExpress (un vendedor por anuncio) va a revisión; en Amazon (ASIN multivendedor) se vincula y la capa de lectura ve dos ofertas', () => {
  const record = { platform: 'aliexpress', externalId: AE, url: `https://es.aliexpress.com/item/${AE}.html`, title: FINEBLUE.title, brand: 'Fineblue', image: 'https://img.invalid/f.jpg', price: 10.49, currency: 'EUR', category: 'Sonido', sellerName: 'Tienda B', capturedAt: '2026-11-09T09:00:00Z' };
  const out = engine.runImport([fine()], [record], { category: 'Sonido' }, { batchId: 'sim', nowIso: '2026-11-09T10:00:00.000Z', deletedIds: new Set() });
  assert.equal(out.results[0].outcome, 'review');
  assert.equal(out.changed, false);
  const amazon = { id: 'amazon-b0test0001', title: 'Portátil de prueba', price: 500, currency: 'EUR', network: 'amazon', merchant: 'Amazon', asin: 'B0TEST0001', sourceId: 'B0TEST0001', brand: 'Zeta', affiliateUrl: 'https://www.amazon.es/dp/B0TEST0001', extra: { offerSeller: { id: 'A1', name: 'Vendedor Uno' } } };
  const rec2 = { platform: 'amazon', externalId: 'B0TEST0001', url: 'https://www.amazon.es/dp/B0TEST0001', title: 'Portátil de prueba', brand: 'Zeta', image: 'https://img.invalid/a.jpg', price: 510, currency: 'EUR', category: 'Informática', sellerName: 'Vendedor Dos', sellerId: 'A2', capturedAt: '2026-11-09T09:00:00Z' };
  const out2 = engine.runImport([amazon], [rec2], { category: 'Informática' }, { batchId: 'sim', nowIso: '2026-11-09T10:00:00.000Z', deletedIds: new Set() });
  assert.equal(out2.results[0].outcome, 'linked');
  const r = getComparableOffers(out2.products[0]);
  assert.equal(r.state, 'multiple');
  assert.deepEqual(r.offers.map((o) => o.sellerLabel), ['Vendedor Uno', 'Vendedor Dos']);
});

test('el mismo vendedor por id y por nombre se reconoce; ids distintos no se fusionan por nombre', () => {
  const a = { name: 'TiendaCPU', id: 'A3GU', source: 'offerSeller', known: true, rejected: [] };
  assert.equal(sameSeller(a, { name: 'tiendacpu', source: 'oferta', known: true, rejected: [] }), true);
  assert.equal(sameSeller(a, { name: 'Otro', id: 'A3GU', source: 'oferta', known: true, rejected: [] }), true, 'mismo id');
  assert.equal(sameSeller(a, { name: 'TiendaCPU', id: 'AZZZ', source: 'oferta', known: true, rejected: [] }), false, 'ids distintos');
  assert.equal(sameSeller(a, { source: 'ninguna', known: false, rejected: [] }), false);
});

/* ───────────── Variantes, cantidades, condiciones, monedas ───────────── */

test('VARIANTES: distinta → otra versión; sin dato en un lado → revisión; ambas sin dato → comparable', () => {
  const withColor = fine();
  withColor.extra = { ...withColor.extra, variantAttributes: { color: 'Gris' } };
  const r1 = getComparableOffers(withOffers(withColor, [explicitOffer({ sellerName: 'T1', variant: { color: 'Negro' } })]));
  assert.deepEqual(r1.otherVersions.map((v) => v.reason), ['variante_distinta']);
  assert.equal(r1.offers.length, 1);
  const r2 = getComparableOffers(withOffers(withColor, [explicitOffer({ sellerName: 'T2' })]));
  assert.deepEqual(r2.needsReview.map((v) => v.reason), ['variante_no_verificable']);
  assert.equal(r2.offers.length, 1, 'no se vincula automáticamente');
  const r3 = getComparableOffers(withOffers(withColor, [explicitOffer({ sellerName: 'T3', variant: { color: 'gris' } })]));
  assert.equal(r3.offers.length, 2, 'mismo color (sin distinguir mayúsculas)');
  const none = getComparableOffers(withOffers(fine(), [explicitOffer({ sellerName: 'T4' })]));
  assert.equal(none.offers.length, 2, 'ni la ficha ni la oferta declaran variante');
});

test('PACKS y CANTIDADES diferentes: nunca se mezclan', () => {
  const pack1 = fine();
  pack1.extra = { ...pack1.extra, variantAttributes: { pack: '1' } };
  const r1 = getComparableOffers(withOffers(pack1, [explicitOffer({ sellerName: 'T1', quantity: '3' })]));
  assert.deepEqual(r1.otherVersions.map((v) => v.reason), ['cantidad_distinta']);
  const r2 = getComparableOffers(withOffers(pack1, [explicitOffer({ sellerName: 'T2' })]));
  assert.deepEqual(r2.needsReview.map((v) => v.reason), ['cantidad_no_verificable']);
  const r3 = getComparableOffers(withOffers(pack1, [explicitOffer({ sellerName: 'T3', variant: { pack: '1' } })]));
  assert.equal(r3.offers.length, 2);
});

test('CONDICIONES diferentes (nueva, usada, reacondicionada): no se tratan como equivalentes', () => {
  const nuevo = fine({ condition: 'Nuevo' });
  const r1 = getComparableOffers(withOffers(nuevo, [explicitOffer({ sellerName: 'T1', condition: 'used' }), explicitOffer({ sellerName: 'T2', condition: 'refurbished' })]));
  assert.deepEqual(r1.otherVersions.map((v) => v.reason), ['condicion_distinta', 'condicion_distinta']);
  assert.equal(r1.offers.length, 1);
  const r2 = getComparableOffers(withOffers(nuevo, [explicitOffer({ sellerName: 'T3', condition: 'unknown' })]));
  assert.deepEqual(r2.needsReview.map((v) => v.reason), ['condicion_no_verificable']);
  const r3 = getComparableOffers(withOffers(nuevo, [explicitOffer({ sellerName: 'T4', condition: 'new' })]));
  assert.equal(r3.offers.length, 2);
  const r4 = getComparableOffers(withOffers(fine(), [explicitOffer({ sellerName: 'T5', condition: 'unknown' })]));
  assert.equal(r4.offers.length, 2, 'ambas desconocidas');
});

test('MONEDAS incompatibles: una oferta en USD no entra en la comparativa', () => {
  const r = getComparableOffers(withOffers(fine(), [explicitOffer({ sellerName: 'T1', price: 11, currency: 'USD' })]));
  assert.equal(r.offers.length, 1);
  assert.deepEqual(r.excluded.map((e) => [e.reason, e.detail]), [['moneda_incompatible', 'USD (ficha: EUR)']]);
});

test('una oferta explícita inactiva, sin precio, agotada o sin enlace se excluye con motivo', () => {
  const r = getComparableOffers(withOffers(fine(), [
    explicitOffer({ sellerName: 'A', status: 'archived' }), explicitOffer({ sellerName: 'B', price: 0 }),
    explicitOffer({ sellerName: 'C', availability: 'out_of_stock' }), explicitOffer({ sellerName: 'D', url: '' }),
  ]));
  assert.deepEqual(reasons(r).sort(), ['agotada', 'oferta_inactiva', 'sin_enlace', 'sin_precio']);
  assert.equal(r.offers.length, 1);
});

/* ───────────── Anuncios repetidos y colisiones ───────────── */

/** Réplica sintética de los 6 anuncios de AliExpress repetidos en 18 fichas (3+4+3+4+2+2). */
function repeatedListings() {
  const sizes = [3, 4, 3, 4, 2, 2];
  const stores = ["Stone's Store", 'AUFU 3C Global Store', 'BASEUS Choice Store', 'Toocki Direct Flagship Store', 'Toocki Direct Choice Store', 'Toocki Direct Choice Store'];
  const out = [];
  sizes.forEach((n, g) => {
    const id = `10050069952392${g}0`;
    for (let i = 1; i <= n; i++) {
      out.push({
        id: `grupo${g + 1}-ficha${i}`, title: `Cargador de prueba ${g + 1} variante de título ${i}`, price: 3.59 + g, currency: undefined, network: 'aliexpress', merchant: 'aliexpress', brand: 'AliExpress',
        sourceId: id, fulfillmentProvider: stores[g], affiliateUrl: `https://s.click.aliexpress.com/s/grupo${g + 1}`, extra: {},
      });
    }
  });
  return out;
}

test('los SEIS anuncios repetidos (18 fichas) son SEIS identidades comerciales, no dieciocho ofertas', () => {
  const catalog = repeatedListings();
  assert.equal(catalog.length, 18);
  const frozen = JSON.stringify(catalog);
  const groups = groupByCommercialIdentity(catalog);
  assert.equal(groups.length, 6);
  assert.deepEqual(groups.map((g) => g.productIds.length), [3, 4, 3, 4, 2, 2]);
  // Cada ficha ve UNA oferta, y las gemelas quedan anotadas como la misma oferta (sin fusionar ni tocar nada).
  const seen = new Set();
  for (const p of catalog) {
    const r = getComparableOffers(p, { catalog });
    assert.equal(r.state, 'single');
    assert.equal(r.offers.length, 1);
    assert.equal(r.needsReview.length, 0);
    seen.add(r.offers[0].identityKey);
    assert.equal(r.offers[0].collapsedProductIds.length, groups.find((g) => g.productIds.includes(p.id)).productIds.length - 1);
    assert.ok(!r.offers[0].collapsedProductIds.includes(p.id));
  }
  assert.equal(seen.size, 6, 'seis identidades distintas');
  assert.equal(JSON.stringify(catalog), frozen, 'el catálogo no se modifica');
});

test('el mismo anuncio en otra ficha con OTRO vendedor, otra variante o sin vendedor y datos distintos NO se une: revisión', () => {
  const a = { id: 'a', title: 'A', price: 5, network: 'aliexpress', merchant: 'aliexpress', sourceId: '1005000000000001', fulfillmentProvider: 'Tienda Uno', affiliateUrl: 'https://s.click.aliexpress.com/s/a', extra: {} };
  const otroVendedor = { ...a, id: 'b', fulfillmentProvider: 'Tienda Dos' };
  const otraVariante = { ...a, id: 'c', extra: { variantAttributes: { color: 'Rojo' } } };
  const sinVendedorA = { ...a, id: 'd', fulfillmentProvider: undefined };
  const sinVendedorB = { ...sinVendedorA, id: 'e', price: 9 };
  const r = getComparableOffers(a, { catalog: [a, otroVendedor, otraVariante] });
  assert.equal(r.offers.length, 1);
  assert.deepEqual(r.offers[0].collapsedProductIds, []);
  assert.deepEqual(r.needsReview.map((x) => [x.reason, x.productId]), [['anuncio_en_varias_fichas', 'b'], ['anuncio_en_varias_fichas', 'c']]);
  const s = getComparableOffers(sinVendedorA, { catalog: [sinVendedorA, sinVendedorB] });
  assert.equal(s.needsReview[0].reason, 'anuncio_en_varias_fichas');
  assert.equal(s.offers[0].collapsedProductIds.length, 0);
  const sameData = getComparableOffers(sinVendedorA, { catalog: [sinVendedorA, { ...sinVendedorA, id: 'f' }] });
  assert.deepEqual(sameData.offers[0].collapsedProductIds, ['f'], 'sin vendedor pero con los mismos datos, se cuentan una vez');
});

test('IDENTIFICADORES CONTRADICTORIOS (ficha o URL de la oferta): no se usan como oferta', () => {
  const contradictory = { id: 'x', title: 'X', price: 100, network: 'amazon', merchant: 'Amazon', asin: 'B0AAAAAAAA', sourceId: 'B0BBBBBBBB', affiliateUrl: 'https://www.amazon.es/dp/B0AAAAAAAA', extra: {} };
  const r = getComparableOffers(contradictory);
  assert.equal(r.state, 'none');
  assert.equal(r.excluded[0].reason, 'identificadores_contradictorios');
  const ok = { ...contradictory, id: 'y', sourceId: 'B0AAAAAAAA' };
  const withBadOffer = withOffers(ok, [explicitOffer({ platform: 'amazon', externalId: 'B0AAAAAAAA', url: 'https://www.amazon.es/dp/B0CCCCCCCC', canonicalUrl: 'amazon.es/dp/B0CCCCCCCC', sellerName: 'Otro' })]);
  const r2 = getComparableOffers(withBadOffer);
  assert.equal(r2.offers.length, 1);
  assert.equal(r2.excluded[0].reason, 'identificadores_contradictorios');
  assert.match(r2.excluded[0].detail, /B0AAAAAAAA.*B0CCCCCCCC/i);
});

test('Samsung Galaxy Book4 y Book4 Pro: marca y «Nombre del modelo» iguales, identidades DISTINTAS (no se une por marca+modelo)', () => {
  const book4 = { id: 'amazon-b0dvwddjdp', title: 'Ordenador portátil ultrafino Samsung Galaxy Book4 15,6"', price: 729, network: 'amazon', merchant: 'Amazon', asin: 'B0DVWDDJDP', sourceId: 'B0DVWDDJDP', brand: 'Samsung', specs: { Marca: 'Samsung', 'Nombre Del Modelo': 'Samsung Galaxy Book4' }, affiliateUrl: 'https://www.amazon.es/dp/B0DVWDDJDP', extra: { variantAttributes: { color: 'Gris' } } };
  const pro = { id: 'amazon-b0d4wqzsxd', title: 'Ordenador portátil Samsung Galaxy Book4 Pro 14"', price: 1599.99, network: 'amazon', merchant: 'Amazon', asin: 'B0D4WQZSXD', sourceId: 'B0D4WQZSXD', brand: 'Samsung', specs: { Marca: 'Samsung', 'Nombre Del Modelo': 'Samsung Galaxy Book4' }, affiliateUrl: 'https://www.amazon.es/dp/B0D4WQZSXD', extra: { offerSeller: { id: 'A3GUFLTOAAE00V', name: 'TiendaCPU' }, variantAttributes: { color: 'Gris' } } };
  const catalog = [book4, pro];
  assert.notEqual(commercialIdentityOf(book4), commercialIdentityOf(pro));
  assert.equal(groupByCommercialIdentity(catalog).length, 2);
  for (const p of catalog) {
    const r = getComparableOffers(p, { catalog });
    assert.equal(r.state, 'single');
    assert.deepEqual(r.offers[0].collapsedProductIds, []);
    assert.deepEqual(r.needsReview, []);
  }
  assert.equal(getComparableOffers(pro, { catalog }).offers[0].sellerLabel, 'TiendaCPU');
  assert.equal(getComparableOffers(book4, { catalog }).offers[0].sellerLabel, SELLER_UNKNOWN_LABEL);
});

test('productos parecidos (mismo título/marca/modelo, otro anuncio) NO se vinculan ni se cuentan como la misma oferta', () => {
  const a = { id: 'a', title: 'Auriculares Fineblue F920', brand: 'Fineblue', price: 9.79, network: 'aliexpress', merchant: 'aliexpress', sourceId: '1005000000000001', fulfillmentProvider: 'T1', affiliateUrl: 'https://s.click.aliexpress.com/s/a', specs: { Marca: 'Fineblue', Modelo: 'F920' }, extra: {} };
  const b = { ...a, id: 'b', sourceId: '1005000000000002', affiliateUrl: 'https://s.click.aliexpress.com/s/b', fulfillmentProvider: 'T2' };
  const amazon = { ...a, id: 'c', network: 'amazon', merchant: 'Amazon', asin: 'B0TEST0002', sourceId: 'B0TEST0002', affiliateUrl: 'https://www.amazon.es/dp/B0TEST0002' };
  const r = getComparableOffers(a, { catalog: [a, b, amazon] });
  assert.equal(r.offers.length, 1);
  assert.deepEqual(r.offers[0].collapsedProductIds, []);
  assert.deepEqual(r.needsReview, []);
  assert.equal(groupByCommercialIdentity([a, b, amazon]).length, 3);
});

/* ───────────── Garantías de sólo lectura y alcance ───────────── */

test('SÓLO LECTURA: no muta la ficha ni el catálogo (objetos congelados) y no crea archivos', () => {
  const catalog = repeatedListings();
  const product = withOffers(fine(), [explicitOffer({ sellerName: 'Tienda B' }), explicitOffer({ sellerName: 'Tienda C', currency: 'USD' })]);
  deepFreeze(catalog);
  deepFreeze(product);
  const before = JSON.stringify([catalog, product]);
  const filesBefore = fs.readdirSync(dir).sort().join(',');
  const r = getComparableOffers(product, { catalog });
  getComparableOffers(catalog[0], { catalog });
  groupByCommercialIdentity(catalog);
  assert.equal(r.state, 'multiple');
  assert.equal(JSON.stringify([catalog, product]), before);
  assert.equal(fs.readdirSync(dir).sort().join(','), filesBefore, 'el directorio de datos aislado no cambia');
});

test('`extra.crossMerchant` (agrupación por similitud de título) NO se usa como identidad: se ignora y se informa', () => {
  const p = fine();
  p.extra = { ...p.extra, crossMerchant: { networks: ['aliexpress', 'amazon'], affiliateUrls: { aliexpress: 'https://x/a', amazon: 'https://x/b' }, prices: { aliexpress: 9.79, amazon: 8 } } };
  const r = getComparableOffers(p);
  assert.equal(r.offers.length, 1);
  assert.deepEqual(r.legacyCrossMerchantIgnored, ['aliexpress', 'amazon']);
});

test('alcance de la etapa 1: linkOffers sigue DESACTIVADA y el motor de importación y su servicio no la mencionan', () => {
  const root = path.resolve(import.meta.dirname, '../../src');
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|astro|mjs)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('linkOffers')) hits.push(path.relative(root, p)); } };
  walk(root);
  assert.deepEqual(hits, [], 'ningún archivo de src/ implementa ni referencia linkOffers');
  // La capa de lectura no importa el motor de importación ni escribe (sin fs ni almacenes de escritura).
  const source = fs.readFileSync(path.join(root, 'lib/comparableOffers.ts'), 'utf8');
  assert.ok(!/from ['"]node:fs['"]|writeProductsToFile|updateCatalog|upsertProduct|from '\.\/jsonImport\/engine'/.test(source));
});
