// Presentación veraz de datos comerciales (ficha y checkout) y aprovechamiento, en la capa de lectura, de los datos ya almacenados.
// Sólo funciones puras y fuentes locales; datos sintéticos; sin red, sin IA, sin escribir catálogos ni consultar producción.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-claims-');
const claims = await import('../../src/lib/commercialClaims.ts');
const lib = await import('../../src/lib/comparableOffers.ts');
const { resolveProductShipping } = await import('../../src/lib/shipping.ts');
const { getComparableOffers, groupByCommercialIdentity } = lib;

const read = (p) => fs.readFileSync('d:/AXEL/WEBS/TRADYLOR/tradylor_web/' + p, 'utf8');
const clone = (v) => structuredClone(v);
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const SYNC = '2026-10-28T22:27:35.731Z';

/** Ficha de eBay sintética con la forma de las 12 históricas (coste en specs, días, texto, Sincronizado). */
const ebay = (over = {}) => ({
  id: 'ebay-1', title: 'Móvil de prueba Zeta', price: 100, currency: 'EUR', network: 'ebay', merchant: 'ebay', brand: 'Zeta',
  sourceId: '123456789012', affiliateUrl: 'https://www.ebay.es/itm/123456789012', category: 'Móviles', condition: 'Nuevo',
  freeShipping: false, shippingDays: 5, shippingInfo: 'Envío en 5 días', rating: 5, reviewsCount: 2097,
  specs: { 'Coste de envío': 'Gratis', Estado: 'Nuevo' }, fulfillmentProvider: 'movitel-shop',
  extra: { Tienda: 'movitel-shop', 'ID externo': '123456789012', Sincronizado: SYNC }, ...over,
});
const offerOf = (p) => getComparableOffers(p).offers[0];

/* ───────────── Coste de envío de eBay (specs) ───────────── */

test('parseEbayShippingCost: sólo textos INEQUÍVOCOS («Gratis» o importe en EUR) y sólo en eBay', () => {
  const p = (cost, network = 'ebay') => ({ network, specs: { 'Coste de envío': cost } });
  assert.deepEqual(claims.parseEbayShippingCost(p('Gratis')), { kind: 'free' });
  assert.deepEqual(claims.parseEbayShippingCost(p('gratis')), { kind: 'free' });
  assert.deepEqual(claims.parseEbayShippingCost(p('4.49 EUR')), { kind: 'paid', amount: 4.49 });
  assert.deepEqual(claims.parseEbayShippingCost(p('1,99 EUR')), { kind: 'paid', amount: 1.99 });
  for (const ambiguous of ['Gratis a partir de 50 €', '12 USD', '0.00 EUR', 'Envío gratis y rápido', '4.49', 'varía', '']) {
    assert.equal(claims.parseEbayShippingCost(p(ambiguous)), null, ambiguous);
  }
  assert.equal(claims.parseEbayShippingCost(p('Gratis', 'aliexpress')), null, 'sólo se interpreta en fichas de eBay');
  assert.equal(claims.parseEbayShippingCost({ network: 'ebay', specs: {} }), null);
});

test('eBay GRATIS en specs: la capa de lectura lo recibe como envío gratis confirmado, con su fecha de captura y sin llamarlo vigente', () => {
  const o = offerOf(ebay());
  assert.equal(o.shipping.free, true);
  assert.equal(o.shipping.cost, 0);
  assert.equal(o.shipping.confirmed, true);
  assert.equal(o.totalPrice, 100);
  assert.equal(o.shipping.source, 'specs_ebay');
  assert.equal(o.shipping.asOf, SYNC, 'fecha de captura (Sincronizado), no «hoy»');
  assert.equal(o.verified, false, 'no está verificado contra la tienda');
  assert.equal(o.delivery, null);
});

test('eBay de PAGO en specs: coste conocido y total calculado; un importe en otra moneda o un texto libre queda como desconocido', () => {
  const paid = offerOf(ebay({ specs: { 'Coste de envío': '4.49 EUR' } }));
  assert.deepEqual([paid.shipping.cost, paid.shipping.free, paid.shipping.confirmed, paid.totalPrice], [4.49, null, true, 104.49]);
  for (const text of ['12 USD', 'Gratis a partir de 50 €', 'consultar']) {
    const o = offerOf(ebay({ specs: { 'Coste de envío': text } }));
    assert.deepEqual([o.shipping.cost, o.shipping.free, o.shipping.confirmed, o.totalPrice], [null, null, false, null], text);
  }
});

test('contradicción «Gratis» en specs frente a freeShipping=false POR DEFECTO: gana el dato explícito y no se escribe nada', () => {
  const p = deepFreeze(ebay({ freeShipping: false }));
  const o = offerOf(p);
  assert.equal(o.shipping.free, true);
  assert.equal(p.freeShipping, false, 'el valor almacenado no se toca');
  // freeShipping=false SIN dato en specs no prueba un coste positivo: sigue desconocido
  const sinSpec = offerOf(ebay({ specs: { Estado: 'Nuevo' }, freeShipping: false }));
  assert.deepEqual([sinSpec.shipping.free, sinSpec.shipping.cost, sinSpec.shipping.confirmed], [null, null, false]);
});

test('contradicción real (freeShipping=true pero specs con coste positivo): el envío queda DESCONOCIDO y marcado como conflicto', () => {
  const o = offerOf(ebay({ freeShipping: true, specs: { 'Coste de envío': '4.49 EUR' } }));
  assert.deepEqual([o.shipping.free, o.shipping.cost, o.shipping.confirmed, o.shipping.conflict, o.totalPrice], [null, null, false, true, null]);
});

test('shippingDays de eBay: plazo ESTIMADO EN LA FECHA DE CAPTURA; no se calcula ninguna fecha futura ni se presenta como promesa desde hoy', () => {
  const o = offerOf(ebay());
  assert.equal(o.shipping.days, 5);
  assert.equal(o.shipping.asOf, SYNC);
  assert.equal(o.delivery, null, 'sin ventana ni fecha de entrega');
  assert.ok(!('deliveryDate' in o.shipping) && !('deliveryMax' in o.shipping));
  const sinFecha = offerOf(ebay({ extra: { Tienda: 'movitel-shop', 'ID externo': '123456789012' } }));
  assert.equal(sinFecha.shipping.days, 5);
  assert.equal(sinFecha.shipping.asOf, null, 'sin fecha base fiable no se afirma desde cuándo');
  // una captura INFERIDA (= recepción) no es fecha de captura
  const inferred = offerOf(ebay({ extra: { Tienda: 'movitel-shop', 'ID externo': '123456789012', priceReading: { capturedAt: SYNC, capturedAtInferred: true, receivedAt: SYNC } } }));
  assert.equal(inferred.shipping.asOf, null);
});

test('texto fijo «Envío estándar eBay (3-5 días)» (fallback del código): no se muestra como información del proveedor; un texto real se conserva', () => {
  const fallback = offerOf(ebay({ shippingInfo: 'Envío estándar eBay (3-5 días)', shippingDays: undefined }));
  assert.equal(fallback.shipping.text, undefined);
  assert.equal(fallback.shipping.days, null);
  assert.equal(claims.isFallbackShippingText('envío estándar ebay (3-5 días)'), true);
  const real = offerOf(ebay({ shippingInfo: 'Envío en 5 días' }));
  assert.equal(real.shipping.text, 'Envío en 5 días');
  assert.equal(claims.isFallbackShippingText('Envío en 5 días'), false);
});

/* ───────────── resolveProductShipping (ficha y checkout) ───────────── */

test('resolveProductShipping: un plazo corto NO prueba envío gratis; freeShipping=false por defecto no se reinterpreta; el fallback se descarta', () => {
  fs.writeFileSync(path.join(dir, 'aliexpress-catalog.json'), JSON.stringify({ syncedAt: '2026-10-28T10:00:00Z', products: [{
    network: 'aliexpress', externalId: '1005000000000001', title: 'Cable', price: 2, productUrl: 'https://s.click.aliexpress.com/s/abc', affiliateUrl: 'https://s.click.aliexpress.com/s/abc',
    extra: { 'Enlace de afiliado': 'https://s.click.aliexpress.com/s/abc', 'Días de envío': '2' }, shippingInfo: 'Envío en 2 días' }] }));
  const base = { id: 'x', title: 'Cable', price: 2, affiliateUrl: 'https://s.click.aliexpress.com/s/abc' };
  const fromSnapshot = resolveProductShipping(base);
  assert.equal(fromSnapshot.shippingDays, 2, 'el plazo declarado sigue disponible');
  assert.equal(fromSnapshot.freeShipping, undefined, '2 días NO implica envío gratis (antes ≤ 3 días ⇒ gratis)');
  assert.equal(resolveProductShipping({ ...base, freeShipping: false }).freeShipping, false, 'el valor guardado se respeta tal cual');
  assert.equal(resolveProductShipping({ ...base, freeShipping: true }).freeShipping, true);
  const fb = resolveProductShipping({ ...base, shippingInfo: 'Envío estándar eBay (3-5 días)', shippingDays: 4 });
  assert.ok(!/estándar ebay/i.test(fb.shippingInfo ?? ''), 'el texto de fallback no se presenta');
  fs.unlinkSync(path.join(dir, 'aliexpress-catalog.json'));
});

/* ───────────── Valoraciones ───────────── */

test('valoración con procedencia: eBay = VENDEDOR; Amazon/Temu = producto con su recuento; sin recuentos inventados', () => {
  const e = offerOf(ebay());
  assert.deepEqual([e.rating.origin, e.rating.label, e.rating.value, e.rating.count, e.rating.countLabel], ['vendedor', 'Valoración del vendedor', 5, 2097, 'valoraciones del vendedor']);
  const amazon = { id: 'a1', title: 'Teclado', price: 30, currency: 'EUR', network: 'amazon', merchant: 'Amazon', asin: 'B0TEST0001', sourceId: 'B0TEST0001', affiliateUrl: 'https://www.amazon.es/dp/B0TEST0001', rating: 4.4, reviewsCount: 1234, extra: {} };
  const a = offerOf(amazon);
  assert.deepEqual([a.rating.origin, a.rating.label, a.rating.count], ['producto', 'Valoración del producto', 1234]);
  assert.equal(offerOf({ ...amazon, rating: undefined, reviewsCount: undefined }).rating, undefined, 'sin valoración no se inventa');
  assert.equal(offerOf({ ...amazon, reviewsCount: undefined }).rating.count, undefined);
});

test('valores por defecto: eBay 4,5 ★/15 y la pareja 4,8 ★/100 del alta se OCULTAN (no son dato)', () => {
  assert.equal(offerOf(ebay({ rating: 4.5, reviewsCount: 15 })).rating, undefined);
  const ali = (over = {}) => ({ id: 'ali-1', title: 'Cable', price: 2, currency: 'EUR', network: 'aliexpress', merchant: 'aliexpress', sourceId: '1005000000000001', affiliateUrl: 'https://s.click.aliexpress.com/s/abc', fulfillmentProvider: 'Toocki Store', extra: {}, ...over });
  assert.equal(offerOf(ali({ rating: 4.8, reviewsCount: 100 })).rating, undefined, '4,8/100 = valores por defecto del alta');
});

test('AliExpress y «100 valoraciones»: el recuento viene del alta (el conector no lo da) → se oculta; la valoración declarada se conserva sin recuento', () => {
  const ali = (over = {}) => ({ id: 'ali-1', title: 'Cable', price: 2, currency: 'EUR', network: 'aliexpress', merchant: 'aliexpress', sourceId: '1005000000000001', affiliateUrl: 'https://s.click.aliexpress.com/s/abc', fulfillmentProvider: 'Toocki Store', extra: {}, ...over });
  const s = claims.ratingSupport(ali({ rating: 4.9, reviewsCount: 100 }));
  assert.deepEqual([s.rating, s.count, s.hidden], [4.9, null, 'recuento_por_defecto_del_alta']);
  const o = offerOf(ali({ rating: 4.9, reviewsCount: 100 }));
  assert.equal(o.rating.value, 4.9);
  assert.equal(o.rating.count, undefined);
  assert.equal(o.rating.countLabel, undefined);
  // un recuento DECLARADO por un registro JSON (canal json) sí se conserva
  const json = claims.ratingSupport(ali({ rating: 4.9, reviewsCount: 321, extra: { importMeta: { channel: 'json' } } }));
  assert.equal(json.count, 321);
  // y fuera de AliExpress un 100 real no se toca
  assert.equal(claims.ratingSupport({ network: 'amazon', rating: 4.2, reviewsCount: 100, extra: {} }).count, 100);
});

/* ───────────── Descuento ───────────── */

test('descuento: originalPrice > price es un dato DECLARADO, no verificado; sólo una observación real lo verifica', () => {
  const base = ebay({ originalPrice: 150 });
  const declared = offerOf(base);
  assert.equal(declared.originalPrice, 150, 'el contrato existente se conserva');
  assert.deepEqual([declared.discount.verified, declared.discount.pct, declared.discount.reason], [false, null, 'sin_observaciones_verificadas']);
  const obs = (over = {}) => ({ capturedAt: '2026-11-08T10:00:00Z', verifiedAt: '2026-11-08T10:00:01Z', price: 100, originalPrice: 160, context: { currency: 'EUR' }, ...over });
  const ok = offerOf({ ...base, extra: { ...base.extra, observations: [obs()] } }).discount;
  assert.deepEqual([ok.verified, ok.pct, ok.previousPrice, ok.asOf], [true, 37.5, 160, '2026-11-08T10:00:01Z']);
  for (const [over, reason] of [
    [{ verifiedAt: '' }, 'observacion_sin_fecha_de_verificacion'],
    [{ price: 90 }, 'la_observacion_no_corresponde_al_precio_publicado'],
    [{ originalPrice: 90 }, 'la_observacion_no_trae_precio_anterior_mayor'],
    [{ originalPrice: null }, 'la_observacion_no_trae_precio_anterior_mayor'],
    [{ context: { currency: 'USD' } }, 'observacion_en_otra_moneda'],
  ]) {
    const d = offerOf({ ...base, extra: { ...base.extra, observations: [obs(over)] } }).discount;
    assert.deepEqual([d.verified, d.pct, d.reason], [false, null, reason], JSON.stringify(over));
  }
});

/* ───────────── Condición ───────────── */

test('«Abierto, sin usar» es una condición PROPIA: no es «Nuevo» ni «Usado», y no se mezcla con ellas', () => {
  assert.equal(claims.readCondition({ condition: 'Abierto, sin usar' }), 'open_box');
  assert.equal(claims.readCondition({ condition: 'Open box' }), 'open_box');
  assert.equal(claims.readCondition({ condition: 'Nuevo' }), 'new');
  assert.equal(claims.readCondition({ condition: 'Usado' }), 'used');
  assert.equal(claims.readCondition({ condition: 'Reacondicionado' }), 'refurbished');
  assert.equal(claims.readCondition({}), 'unknown');
  const base = ebay({ condition: 'Abierto, sin usar' });
  assert.equal(offerOf(base).condition, 'open_box');
  const mk = (condition) => ({
    offerId: 'o' + condition, offerKey: 'ebay:123456789012:otro', platform: 'ebay', externalId: '123456789012', sellerName: 'otro', url: 'https://www.ebay.es/itm/123456789012', canonicalUrl: 'ebay.es/itm/123456789012',
    price: 90, currency: 'EUR', availability: 'in_stock', shipping: { cost: null, free: null, days: null }, condition, capturedAt: '', receivedAt: '', verifiedAt: '',
    source: { channel: 'json', batchId: 'b', adapter: 'json-import' }, status: 'active',
  });
  const withNew = getComparableOffers({ ...base, extra: { ...base.extra, offers: [mk('new')] } });
  assert.deepEqual(withNew.otherVersions.map((v) => v.reason), ['condicion_distinta'], '«abierta» ≠ «nueva»');
  const withUsed = getComparableOffers({ ...base, extra: { ...base.extra, offers: [mk('used')] } });
  assert.deepEqual(withUsed.otherVersions.map((v) => v.reason), ['condicion_distinta'], '«abierta» ≠ «usada»');
  const nuevo = ebay({ condition: 'Nuevo' });
  assert.equal(getComparableOffers({ ...nuevo, extra: { ...nuevo.extra, offers: [mk('new')] } }).offers.length, 2);
});

/* ───────────── Cero / una / varias, cheapest, identidades, no mutación ───────────── */

test('cero, una y varias ofertas siguen igual; «la más barata» sólo con 2+ ofertas y todos los totales conocidos', () => {
  const none = getComparableOffers(ebay({ price: 0 }));
  assert.equal(none.state, 'none');
  const one = getComparableOffers(ebay());
  assert.equal(one.state, 'single');
  assert.equal(one.cheapest, null);
  const mk = (cost, name) => ({
    offerId: 'o' + name, offerKey: 'ebay:123456789012:' + name, platform: 'ebay', externalId: '123456789012', sellerName: name, url: 'https://www.ebay.es/itm/123456789012', canonicalUrl: 'ebay.es/itm/123456789012',
    price: 98, currency: 'EUR', availability: 'in_stock', shipping: { cost, free: cost === 0 ? true : null, days: null }, condition: 'new', capturedAt: '', receivedAt: '', verifiedAt: '',
    source: { channel: 'json', batchId: 'b', adapter: 'json-import' }, status: 'active',
  });
  const base = ebay();
  const unknown = getComparableOffers({ ...base, extra: { ...base.extra, offers: [mk(null, 'otro')] } });
  assert.equal(unknown.state, 'multiple');
  assert.equal(unknown.cheapest, null, 'un total desconocido impide «la más barata»');
  const known = getComparableOffers({ ...base, extra: { ...base.extra, offers: [mk(7, 'otro')] } });
  assert.equal(known.cheapest?.sellerLabel, 'movitel-shop', '100 € con envío gratis < 98 + 7');
});

test('los seis anuncios repetidos (18 fichas) siguen siendo seis identidades y la lectura no muta el catálogo', () => {
  const sizes = [3, 4, 3, 4, 2, 2];
  const catalog = [];
  sizes.forEach((n, g) => { for (let i = 1; i <= n; i++) catalog.push({ id: `g${g}-${i}`, title: `Cargador ${g} ${i}`, price: 3 + g, network: 'aliexpress', merchant: 'aliexpress', sourceId: `100500000000000${g}`, fulfillmentProvider: `Tienda ${g}`, affiliateUrl: `https://s.click.aliexpress.com/s/${g}`, extra: {} }); });
  deepFreeze(catalog);
  const before = JSON.stringify(catalog);
  assert.equal(groupByCommercialIdentity(catalog).length, 6);
  for (const p of catalog) assert.equal(getComparableOffers(p, { catalog }).offers.length, 1);
  assert.equal(JSON.stringify(catalog), before);
});

test('la capa de lectura no muta la ficha (objeto congelado) con todos los datos comerciales nuevos', () => {
  const p = deepFreeze(ebay({ originalPrice: 150, extra: { Tienda: 'movitel-shop', 'ID externo': '123456789012', Sincronizado: SYNC, observations: [{ verifiedAt: SYNC, price: 100, originalPrice: 150, context: { currency: 'EUR' } }] } }));
  assert.doesNotThrow(() => getComparableOffers(p));
});

/* ───────────── Presentación en ficha y checkout (fuentes) ───────────── */

test('checkout: ya no afirma devolución a 30 días, plazos inventados ni «verificados hoy»; usa «No indicado» / «no verificados» y la disponibilidad declarada', () => {
  const c = read('src/pages/checkout/[id].astro');
  for (const forbidden of ['Devolución hasta {returnDays}', "'2 – 4 días laborables'", "'24 – 48 h'", "'3 – 5 días laborables'", 'Precio y disponibilidad verificados hoy\n', 'returnPolicyDays ?? 30']) {
    assert.ok(!c.includes(forbidden), forbidden);
  }
  assert.ok(c.includes('Devolución: No indicado'));
  assert.ok(c.includes("'No indicado'") && c.includes('Precio y disponibilidad no verificados'));
  assert.ok(c.includes('Precio verificado el ${verifiedDate}'));
  assert.ok(c.includes("product.inStock === true ? 'En stock'") && c.includes("'Disponibilidad no indicada'"));
  assert.ok(c.includes('ratingSupport(product)') && !c.includes('product.reviewsCount.toLocaleString'));
  assert.ok(!c.includes('shippingResolved.shippingInfo ?? product.shippingInfo'), 'el texto de fallback no se relee en bruto');
});

test('ficha: sin «Precio verificado hoy» incondicional, sin «10 h de análisis», sin recuentos por defecto ni «lectura diaria automática»; JSON-LD sin datos inventados', () => {
  const f = read('src/pages/producto/[slug].astro');
  assert.ok(!f.includes('<span>Precio verificado hoy</span>'));
  assert.ok(!f.includes('{investigation!.hoursInvestigated}h de análisis'));
  assert.ok(f.includes("verifiedDate ? `Precio verificado el ${verifiedDate}` : 'Precio sin verificar con la tienda'"));
  assert.ok(f.includes('ratingSupport(product)') && !f.includes('product.reviewsCount.toLocaleString'));
  assert.ok(!f.includes('reviewCount: product.reviewsCount ?? 1'));
  assert.ok(f.includes('ratingInfo.rating && ratingInfo.count && ratingInfo.origin'));
  assert.ok(f.includes("product.inStock === true ? { availability: 'https://schema.org/InStock' }"));
  assert.ok(f.includes('Plazo declarado por la tienda') && f.includes('puede haber cambiado'));
  assert.ok(f.includes('shipping.freeShipping === true'));
  const chart = read('src/components/PriceHistoryChart.astro');
  assert.ok(!chart.includes('Precio verificado hoy') && !chart.includes('Lectura diaria automática'));
  assert.ok(chart.includes('no verificado con la tienda'));
  const table = read('src/components/ComparisonTable.astro');
  assert.ok(!table.includes('>Precio verificado<') && table.includes('ratingSupport(p)'));
});

test('alcance: linkOffers sigue inexistente y commercialClaims es sólo lectura', () => {
  const root = 'd:/AXEL/WEBS/TRADYLOR/tradylor_web/src';
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|astro|mjs)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('linkOffers')) hits.push(p); } };
  walk(root);
  assert.deepEqual(hits, []);
  const source = read('src/lib/commercialClaims.ts');
  assert.ok(!/from ['"]node:fs['"]|writeProductsToFile|updateCatalog|upsertProduct/.test(source), 'sólo lectura');
});
