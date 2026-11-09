// Ficha técnica desplegable (6 principales según categoría), historial de precios por periodos (sólo datos reales) y guardas de integración.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupIsolatedData } from './_helpers.mjs';

setupIsolatedData('treidilor-ficha-specs-history-');
const { buildSpecsView, FEATURED_MAX } = await import('../../src/lib/specsView.ts');
const { buildHistoryView, collectPoints, PERIODS } = await import('../../src/lib/priceHistoryView.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

/* ───────────── Ficha técnica desplegable ───────────── */

test('un ordenador destaca procesador, RAM, almacenamiento y pantalla entre sus 6 primeras características; el resto queda tras el control', () => {
  const specs = { Color: 'Gris', Peso: '1,4 kg', Marca: 'Zeta', 'Tamaño de pantalla': '15,6 pulgadas', Almacenamiento: '512 GB SSD', 'Memoria RAM': '16 GB', Procesador: 'Core i5', Garantía: '2 años', 'Sistema operativo': 'Windows 11', Puertos: '2 USB', Cámara: 'HD', Teclado: 'Español', Batería: '50 Wh' };
  const v = buildSpecsView({ title: 'Portátil Zeta 15 Core i5', specs });
  assert.equal(v.featured.length, FEATURED_MAX);
  const labels = v.featured.map((e) => e.label);
  for (const wanted of ['Procesador', 'Memoria RAM', 'Almacenamiento', 'Tamaño de pantalla']) assert.ok(labels.includes(wanted), `${wanted} debe estar entre las principales: ${labels}`);
  assert.equal(v.featured.length + v.rest.length, Object.keys(specs).length, 'no se elimina ninguna característica');
  assert.ok(v.rest.some((e) => e.label === 'Color'));
});

test('unos auriculares destacan autonomía y conectividad (no RAM ni GPU)', () => {
  const specs = { Color: 'Negro', Peso: '40 g', Conectividad: 'Bluetooth 5.3', Autonomía: '20 h', Micrófono: 'Integrado', Estuche: 'Sí', Material: 'ABS', Impermeabilidad: 'IPX4', Garantía: '1 año', Cable: 'USB-C', Alcance: '10 m', Códec: 'AAC', Carga: 'USB-C' };
  const v = buildSpecsView({ title: 'Auriculares inalámbricos Zeta TWS', specs });
  const labels = v.featured.map((e) => e.label);
  assert.equal(v.family, 'auriculares');
  assert.ok(labels.includes('Autonomía') && labels.includes('Conectividad'), labels.join('|'));
  assert.ok(labels.indexOf('Autonomía') < labels.indexOf('Color') || !labels.includes('Color'));
});

test('el desplegable sólo existe con 12 o más características (se ven 6, la mitad de 12); con menos se muestran todas; las vacías se omiten', () => {
  const few = buildSpecsView({ title: 'Producto raro', specs: Object.fromEntries('ABCDEFGHIJK'.split('').map((k, i) => [k, String(i + 1)])) });
  assert.equal(few.rest.length, 0, '11 características: todas visibles, sin control');
  assert.equal(few.featured.length, 11);
  const twelve = buildSpecsView({ title: 'Producto raro', specs: Object.fromEntries('ABCDEFGHIJKL'.split('').map((k, i) => [k, String(i + 1)])) });
  assert.equal(twelve.featured.length, 6, '12 características: la mitad visible');
  assert.equal(twelve.rest.length, 6);
  const many = buildSpecsView({ title: 'Producto raro', specs: Object.fromEntries('ABCDEFGHIJKLM'.split('').map((k, i) => [k, String(i + 1)])) });
  assert.deepEqual(many.featured.map((e) => e.label), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.deepEqual(many.rest.map((e) => e.label), ['G', 'H', 'I', 'J', 'K', 'L', 'M']);
  assert.equal(buildSpecsView({ title: 'x', specs: { A: '', B: '  ' } }).featured.length, 0);
});

test('la ficha usa <details> accesible con los textos pedidos y conserva el ancla #ficha-tecnica', () => {
  const ficha = read('src/pages/producto/[slug].astro');
  assert.match(ficha, /id="ficha-tecnica"/);
  assert.match(ficha, /<details class="specs-more"/);
  assert.match(ficha, /Ver todas las características/);
  assert.match(ficha, /Mostrar menos/);
  assert.match(ficha, /specs-more-toggle:focus-visible/);
  assert.match(ficha, /.specs-more { margin-top: 1.5rem; }/, 'margen entre la ficha y el desplegable');
});

/* ───────────── Historial de precios ───────────── */

const NOW = new Date('2026-11-09T12:00:00Z');
const day = (offset) => new Date(NOW.getTime() - offset * 86_400_000).toISOString().slice(0, 10);

test('cuatro periodos (1, 3, 6 y 12 meses) con mínimo, máximo y fechas reales; sin puntos inventados', () => {
  assert.deepEqual(PERIODS.map((p) => p.key), ['1m', '3m', '6m', '12m']);
  const priceHistory = [{ date: day(300), price: 140 }, { date: day(150), price: 130 }, { date: day(60), price: 120 }, { date: day(20), price: 99 }, { date: day(5), price: 110 }];
  const v = buildHistoryView({ priceHistory }, NOW);
  const byKey = Object.fromEntries(v.periods.map((p) => [p.key, p]));
  assert.equal(byKey['1m'].points.length, 2);
  assert.equal(byKey['3m'].points.length, 3);
  assert.equal(byKey['6m'].points.length, 4);
  assert.equal(byKey['12m'].points.length, 5);
  assert.equal(byKey['12m'].min.price, 99);
  assert.equal(byKey['12m'].min.date, day(20));
  assert.equal(byKey['12m'].max.price, 140);
  assert.equal(byKey['12m'].max.date, day(300));
  // Sólo hay marcas en fechas realmente observadas (nada interpolado).
  assert.equal(byKey['12m'].chart.markers.length, 5);
  assert.deepEqual(byKey['12m'].chart.markers.map((m) => m.date), priceHistory.map((p) => p.date));
  assert.equal(v.total, 5);
});

test('sin historial suficiente se declara (menos de 2 lecturas): no hay gráfico ni valores', () => {
  const v = buildHistoryView({ priceHistory: [{ date: day(2), price: 50 }] }, NOW);
  assert.ok(v.periods.every((p) => !p.sufficient && p.chart === null));
  assert.equal(buildHistoryView({}, NOW).total, 0);
  assert.equal(buildHistoryView({ priceHistory: [{ date: 'no-fecha', price: 5 }, { date: day(3), price: -4 }, { date: day(4), price: 'x' }] }, NOW).total, 0);
});

test('las observaciones verificadas se incluyen con su fecha de captura y mandan sobre la visita del mismo día; otra moneda se descarta', () => {
  const pts = collectPoints({
    priceHistory: [{ date: day(10), price: 100 }, { date: day(3), price: 90 }],
    extra: { observations: [
      { capturedAt: `${day(10)}T08:00:00Z`, verifiedAt: `${day(10)}T09:00:00Z`, price: 98, context: { currency: 'EUR' } },
      { capturedAt: `${day(6)}T08:00:00Z`, verifiedAt: `${day(6)}T09:00:00Z`, price: 95, context: { currency: 'USD' } },
      { capturedAt: `${day(5)}T08:00:00Z`, price: 94, context: { currency: 'EUR' } },
    ] },
  });
  assert.deepEqual(pts.map((p) => [p.date, p.price, p.source]), [[day(10), 98, 'verificada'], [day(3), 90, 'visita']]);
});

test('el gráfico es en escalón (mantiene el último precio hasta la siguiente lectura), distinguiendo el precio del producto del envío', () => {
  const v = buildHistoryView({ priceHistory: [{ date: day(10), price: 100 }, { date: day(5), price: 80 }] }, NOW);
  const chart = v.periods.find((p) => p.key === '1m').chart;
  assert.match(chart.path, /^M[\d.]+,[\d.]+ H[\d.]+ V[\d.]+$/);
  const comp = read('src/components/PriceHistoryChart.astro');
  assert.match(comp, /Gastos de envío \(aparte\)/);
  assert.match(comp, /sin gastos de envío/i);
  assert.match(comp, /No hay una actualización diaria automática/);
  assert.match(comp, /Sin historial suficiente en este periodo/);
  assert.doesNotMatch(comp, /actualizad[oa] automáticamente|lectura diaria automática/i);
});

test('el control del historial es accesible (pestañas con aria) y la caja de alerta ofrece precio objetivo, deslizador, envío y botón', () => {
  const comp = read('src/components/PriceHistoryChart.astro');
  assert.match(comp, /role="tablist"/);
  assert.match(comp, /role="tab"/);
  assert.match(comp, /aria-selected/);
  assert.match(comp, /Activar alerta de precio/);
  assert.match(comp, /phc-zonebar/);
  assert.match(comp, /Precio recomendado/);
  assert.match(comp, /data-alert-use-recommended/);
  assert.match(comp, /data-alert-ship/);
  assert.match(comp, /href="\/alertas-precio"/);
});

test('(ficha y tarjetas) la etiqueta pública de bajada dice «Ha bajado de precio» y sigue exigiendo una señal verificada', () => {
  const card = read('src/components/ProductCard.astro');
  assert.match(card, /Ha bajado de precio/);
  assert.match(card, /activeSignal\(rawSignal/);
});
