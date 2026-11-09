// Recomendación de precio objetivo: zonas realista / posible / poco probable según el historial REAL (o una referencia orientativa rotulada como tal).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupIsolatedData } from './_helpers.mjs';

setupIsolatedData('treidilor-alert-advice-');
const A = await import('../../src/lib/priceAlertAdvice.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const NOW = new Date('2026-06-15T12:00:00Z'); // lejos del Black Friday
const day = (o) => new Date(NOW.getTime() - o * 86_400_000).toISOString().slice(0, 10);
const hist = (prices) => ({ priceHistory: prices.map((p, i) => ({ date: day(prices.length * 5 - i * 5), price: p })) });

test('con historial real (≥ 3 lecturas) la guía es «del historial» y se apoya en el mínimo, el máximo y la volatilidad observados', () => {
  const adv = A.buildAdvice(hist([200, 190, 180, 170, 160]), 160, NOW);
  assert.equal(adv.basis, 'historial');
  assert.equal(adv.lowestRecorded, 160);
  assert.equal(adv.points, 5);
  assert.match(adv.basisText, /historial real de esta ficha \(5 lecturas: mínimo 160,00\s€, máximo 200,00\s€\)/);
  assert.match(adv.basisText, /No es una predicción/);
  // volatilidad = 20 % → realista ≤ 10 %, posible ≤ 20 % (y nunca por debajo del mínimo −2 %)
  assert.equal(adv.realistFrom, 144);
  assert.equal(adv.possibleFrom, 128);
});

test('las zonas están ordenadas, cubren el control y clasifican bien un precio objetivo', () => {
  const adv = A.buildAdvice(hist([300, 280, 260, 250]), 290, NOW);
  assert.deepEqual(adv.zones.map((z) => z.key), ['realista', 'posible', 'poco_probable']);
  assert.ok(adv.possibleFrom <= adv.realistFrom && adv.realistFrom <= adv.current);
  assert.equal(adv.zones[0].to, adv.sliderMax);
  assert.equal(adv.zones[2].from, adv.sliderMin);
  assert.equal(A.zoneOf(adv, adv.current), 'realista');
  assert.equal(A.zoneOf(adv, adv.realistFrom), 'realista');
  assert.equal(A.zoneOf(adv, adv.sliderMin), 'poco_probable');
  assert.equal(A.zoneOf(adv, (adv.realistFrom + adv.possibleFrom) / 2), adv.realistFrom > adv.possibleFrom ? 'posible' : 'realista');
});

test('sin historial suficiente la guía es ORIENTATIVA y lo dice (no se presenta como dato)', () => {
  for (const p of [{}, hist([100]), hist([100, 99])]) {
    const adv = A.buildAdvice(p, 100, NOW);
    assert.equal(adv.basis, 'orientativa');
    assert.equal(adv.realistFrom, 95);
    assert.equal(adv.possibleFrom, 88);
    assert.match(adv.basisText, /Referencia orientativa/);
    assert.match(adv.basisText, /No es un dato ni una predicción/);
  }
});

test('un precio más bajo del que nunca se ha visto es «poco probable»; el mínimo histórico por debajo de la zona realista es «posible»', () => {
  const adv = A.buildAdvice(hist([120, 118, 116, 114, 112]), 120, NOW); // volatilidad ≈ 6,7 %
  assert.equal(A.zoneOf(adv, 90), 'poco_probable');
  assert.equal(A.zoneOf(adv, 112), 'posible', 'el mínimo registrado ya se ha visto: posible, no habitual');
  assert.equal(adv.recommended, adv.realistFrom, 'se recomienda el inicio de la zona realista');
});

test('el precio actual ya es el mínimo registrado: se recomienda algo por debajo de él, nunca por encima', () => {
  const adv = A.buildAdvice(hist([150, 140, 130, 120]), 120, NOW);
  assert.ok(adv.recommended <= adv.current);
  assert.ok(adv.recommended >= adv.possibleFrom);
});

test('Black Friday: en su ventana la zona «posible» se amplía y se dice; fuera de ella no hay nota', () => {
  assert.equal(A.blackFriday(2026).toISOString().slice(0, 10), '2026-11-27');
  const outside = A.buildAdvice({}, 100, new Date('2026-06-15T12:00:00Z'));
  const inside = A.buildAdvice({}, 100, new Date('2026-11-20T12:00:00Z'));
  assert.equal(outside.eventNote, null);
  assert.match(inside.eventNote, /Black Friday \(27\/11\/2026\)/);
  assert.ok(inside.possibleFrom < outside.possibleFrom, 'más amplia que fuera de la ventana');
  assert.equal(A.nearBlackFriday(new Date('2026-12-05T12:00:00Z')), null);
});

test('el degradado de la barra tiene las tres zonas con sus colores (rojo → ámbar → verde)', () => {
  const adv = A.buildAdvice(hist([200, 190, 180, 170]), 190, NOW);
  const g = A.gradientOf(adv);
  assert.match(g, /^linear-gradient\(90deg, #ef4444 0%/);
  assert.ok(g.indexOf('#ef4444') < g.indexOf('#f59e0b') && g.indexOf('#f59e0b') < g.indexOf('#10b981'));
  assert.match(g, /#10b981 [\d.]+%, #10b981 100%\)$/);
});

test('es de sólo lectura (no muta la ficha) y no inventa datos: sin precios válidos no usa historial', () => {
  const product = Object.freeze({ priceHistory: Object.freeze([{ date: 'x', price: -3 }, { date: day(3), price: 'abc' }]) });
  const adv = A.buildAdvice(product, 50, NOW);
  assert.equal(adv.basis, 'orientativa');
  assert.equal(adv.points, 0);
  assert.equal(adv.lowestRecorded, null);
});

test('la ficha muestra la barra de zonas coloreada, la leyenda, el precio recomendado y la base de la guía', () => {
  const comp = read('src/components/PriceHistoryChart.astro');
  assert.match(comp, /buildAdvice\(product, currentPrice\)/);
  assert.match(comp, /class="phc-zonebar" style=\{`background: \$\{gradientOf\(advice\)\}`\}/);
  assert.match(comp, /aria-label="Zonas de precio"/);
  assert.match(comp, /Precio recomendado/);
  assert.match(comp, /advice\.basisText/);
  assert.match(comp, /data-zone-label/);
  assert.match(comp, /Es un precio que se ha visto rara vez o nunca/);
  assert.match(comp, /phc-zone-now strong\.is-poco_probable \{ background: #ef4444/);
  // Nunca se afirma una probabilidad numérica.
  assert.doesNotMatch(comp, /probabilidad del \d|% de probabilidad/i);
});
