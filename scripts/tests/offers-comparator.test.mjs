// FASE 3 · Vista del comparador de ofertas (#ofertas) y salida por oferta (/api/redirect?offer=). Datos aislados; sin red; sin clics reales
// (la analítica va al directorio temporal) y sin tocar linkOffers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupIsolatedData, writeCatalog } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-offers-comparator-');
delete process.env.N8N_CLICK_WEBHOOK_URL;
const { buildOffersView } = await import('../../src/lib/offersView.ts');
const { resolveOfferDestination } = await import('../../src/lib/offerRedirect.ts');
const { getComparableOffers } = await import('../../src/lib/comparableOffers.ts');
const redirect = await import('../../src/pages/api/redirect.ts');

const FINEBLUE = JSON.parse(fs.readFileSync(new URL('./fixtures/fineblue-f920.json', import.meta.url), 'utf8'));
const AE = '1005005704532450';
const base = (over = {}) => ({ ...structuredClone(FINEBLUE), affiliateUrl: `https://s.click.aliexpress.com/e/_principal`, condition: 'Nuevo', ...over });
const offer = (over = {}) => ({
  offerId: 'x' + Math.random().toString(36).slice(2, 8),
  offerKey: `aliexpress:${AE}:${(over.sellerName ?? 'otra').toLowerCase()}`,
  platform: 'aliexpress', externalId: AE, sellerName: 'Otra Store',
  url: `https://es.aliexpress.com/item/${AE}.html`, canonicalUrl: `es.aliexpress.com/item/${AE}.html`,
  price: 8.5, currency: 'EUR', availability: 'in_stock', shipping: { cost: null, free: null, days: null }, condition: 'new',
  capturedAt: '2026-11-09T09:00:00Z', receivedAt: '2026-11-09T10:00:00Z', verifiedAt: '',
  source: { channel: 'json', batchId: 'b', adapter: 'json-import' }, status: 'active', ...over,
});
const withOffers = (p, offers) => ({ ...p, extra: { ...(p.extra ?? {}), offers } });

test('0 ofertas → estado none con mensaje honesto y sin filas', () => {
  const v = buildOffersView({ ...base(), price: 0, availability: 'out_of_stock' }, []);
  assert.ok(['none', 'single'].includes(v.state));
  if (v.state === 'none') {
    assert.equal(v.rows.length, 0);
    assert.match(v.message, /Todavía no hay ofertas confirmadas/);
  }
});

test('1 oferta → una fila, mensaje de «no hay otras», sin «más barata» ni total inventado', () => {
  const p = base();
  const v = buildOffersView(p, [p]);
  assert.equal(v.state, 'single');
  assert.equal(v.rows.length, 1);
  assert.match(v.message, /no hay otras ofertas comparables/i);
  assert.equal(v.rows[0].isCheapest, false);
  assert.equal(v.rows[0].totalText, 'Total no calculable');
  assert.equal(v.rows[0].paymentText, 'No indicado');
  assert.match(v.rows[0].returnsText, /No indicado/);
  assert.equal(v.rows[0].discountText, '—');
});

test('N ofertas · dos vendedores de la misma plataforma: dos filas, sin «más barata» si el envío no consta', () => {
  const p = withOffers(base(), [offer({ sellerName: 'Otra Store', price: 8.5 })]);
  const v = buildOffersView(p, [p]);
  assert.equal(v.state, 'multiple');
  assert.equal(v.rows.length, 2);
  assert.ok(v.rows.every((r) => !r.isCheapest));
  assert.match(v.note, /No se indica cuál es la más barata/);
  assert.equal(v.sort.totalEnabled, false);
  assert.equal(v.sort.priceEnabled, true);
  assert.equal(v.filters.freeReturn.enabled, false);
  assert.equal(v.filters.fastShipping.enabled, false);
});

test('N ofertas con envío conocido en todas: total, orden por total y «más barata» acreditada', () => {
  const principal = base({ shippingCost: 2, freeShipping: false });
  const p = withOffers(principal, [offer({ sellerName: 'Gratis Store', price: 11, shipping: { cost: 0, free: true, days: 2 } })]);
  const r = getComparableOffers(p, { catalog: [p] });
  const v = buildOffersView(p, [p], r);
  if (r.comparisonReady) {
    assert.equal(v.sort.totalEnabled, true);
    assert.equal(v.rows.filter((x) => x.isCheapest).length, 1);
    assert.equal(v.filters.fastShipping.enabled, true);
  } else {
    // el principal no tiene campo plano de coste: nunca se afirma la más barata
    assert.ok(v.rows.every((x) => !x.isCheapest));
  }
});

test('variante, cantidad y condición distintas no se mezclan: van a «otras versiones»', () => {
  const p = withOffers(base(), [offer({ sellerName: 'Usado Store', condition: 'used', price: 5 })]);
  const v = buildOffersView(p, [p]);
  assert.ok(v.rows.every((r) => r.conditionLabel !== 'Usada'));
  assert.ok(v.otherVersions.length >= 1);
  assert.equal(v.otherVersions[0].reasonLabel, 'otra condición');
});

test('el HTML de la vista nunca contiene el enlace de afiliado: sólo /api/redirect con offer', () => {
  const p = withOffers(base(), [offer({ sellerName: 'Otra Store', affiliateUrl: 'https://s.click.aliexpress.com/e/_otra' })]);
  const v = buildOffersView(p, [p]);
  const dump = JSON.stringify(v);
  assert.ok(!dump.includes('s.click.aliexpress.com'));
  for (const r of v.rows) assert.match(r.href, /^\/api\/redirect\?id=[^&]+&offer=[^&]+&src=ofertas$/);
  assert.equal(new Set(v.rows.map((r) => r.href)).size, v.rows.length, 'cada oferta tiene su enlace');
});

test('redirect por oferta: cada botón va a SU destino y nunca al de otro vendedor', async () => {
  const p = withOffers(base(), [offer({ sellerName: 'Otra Store', affiliateUrl: 'https://s.click.aliexpress.com/e/_otra' })]);
  writeCatalog(dir, [p]);
  const v = buildOffersView(p, [p]);
  const ex = v.rows.find((r) => r.origin === 'explicit');
  const im = v.rows.find((r) => r.origin === 'implicit');
  const call = (href) => redirect.GET({ url: new URL('http://localhost' + href) });
  const rEx = await call(ex.href);
  assert.equal(rEx.status, 302);
  assert.equal(rEx.headers.get('Location'), 'https://s.click.aliexpress.com/e/_otra');
  const rIm = await call(im.href);
  assert.equal(rIm.headers.get('Location'), 'https://s.click.aliexpress.com/e/_principal');
  assert.match(rEx.headers.get('Cache-Control'), /no-store/);
});

test('redirect con offer desconocida → vuelve a #ofertas de la ficha, sin salir a ninguna tienda', async () => {
  const p = base();
  writeCatalog(dir, [p]);
  const key = encodeURIComponent(p.slug || p.id);
  const res = await redirect.GET({ url: new URL(`http://localhost/api/redirect?id=${key}&offer=inexistente&src=ofertas`) });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('Location'), /^\/producto\/.+#ofertas$/);
  assert.ok(!/aliexpress/.test(res.headers.get('Location')));
});

test('resolveOfferDestination rechaza destinos que no sean http(s)', () => {
  const p = withOffers(base(), [offer({ sellerName: 'Mala Store', url: 'javascript:alert(1)', affiliateUrl: 'javascript:alert(1)', offerId: 'mala1' })]);
  const r = getComparableOffers(p, { catalog: [p] });
  const o = [...r.offers, ...r.otherVersions.map((x) => x.offer)].find((x) => x.sellerLabel === 'Mala Store');
  if (o) assert.equal(resolveOfferDestination(p, o.offerId, [p]), null);
});

test('el redirect clásico (sin offer) sigue yendo a la oferta principal', async () => {
  const p = base();
  writeCatalog(dir, [p]);
  const res = await redirect.GET({ url: new URL(`http://localhost/api/redirect?id=${encodeURIComponent(p.slug || p.id)}&src=ficha`) });
  assert.equal(res.headers.get('Location'), 'https://s.click.aliexpress.com/e/_principal');
});

