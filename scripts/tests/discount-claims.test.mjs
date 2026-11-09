// Descuentos: sólo se muestran si están VERIFICADOS (observación real con fecha, EUR, mismo precio que el publicado). Sólo lectura.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { shownDiscount } = await import('../../src/lib/commercialClaims.ts');

const obs = (over = {}) => ({ price: 80, originalPrice: 100, verifiedAt: '2026-11-08T10:00:00Z', context: { currency: 'EUR' }, ...over });
const P = (over = {}) => ({ price: 80, originalPrice: 100, extra: { observations: [obs()] }, ...over });

test('descuento verificado: porcentaje y precio anterior de la observación', () => {
  const d = shownDiscount(P());
  assert.equal(d.pct, 20);
  assert.equal(d.previousPrice, 100);
  assert.equal(d.asOf, '2026-11-08T10:00:00Z');
});

test('el precio anterior DECLARADO (originalPrice) sin observaciones no es un descuento mostrable', () => {
  assert.equal(shownDiscount({ price: 80, originalPrice: 100 }), null);
  assert.equal(shownDiscount({ price: 80, originalPrice: 100, extra: { observations: [] } }), null);
});

test('observación sin fecha de verificación, en otra moneda o de otro precio: no se muestra', () => {
  assert.equal(shownDiscount(P({ extra: { observations: [obs({ verifiedAt: '' })] } })), null);
  assert.equal(shownDiscount(P({ extra: { observations: [obs({ context: { currency: 'USD' } })] } })), null);
  assert.equal(shownDiscount(P({ extra: { observations: [obs({ price: 70 })] } })), null, 'la observación no corresponde al precio publicado');
  assert.equal(shownDiscount(P({ extra: { observations: [obs({ originalPrice: 80 })] } })), null, 'precio anterior no mayor');
});

test('se usa la ÚLTIMA observación', () => {
  const p = P({ extra: { observations: [obs(), obs({ originalPrice: 90, verifiedAt: '2026-11-09T09:00:00Z' })] } });
  assert.equal(shownDiscount(p).previousPrice, 90);
  assert.equal(shownDiscount(p).pct, 11);
});

test('no muta el producto ni borra el precio original almacenado', () => {
  const p = Object.freeze({ price: 80, originalPrice: 100 });
  shownDiscount(p);
  assert.equal(p.originalPrice, 100);
});

test('ninguna superficie pública calcula un descuento a partir de originalPrice sin verificar', () => {
  const read = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
  for (const f of ['src/components/ProductCard.astro', 'src/pages/producto/[slug].astro', 'src/pages/checkout/[id].astro', 'src/components/ComparisonTable.astro', 'src/pages/herramientas/comparador.astro']) {
    const src = read(f);
    assert.match(src, /shownDiscount/, `${f} debe usar shownDiscount`);
    assert.doesNotMatch(src, /product\.originalPrice - product\.price\) \/ product\.originalPrice\) \* 100/, `${f}: descuento sin verificar`);
  }
  const home = read('src/pages/index.astro');
  assert.doesNotMatch(home, /Ahorrado a nuestros usuarios|\+500h|24\/7/);
});

test('metodología y portada: sin pruebas, auditorías ni horas de test que no existen', () => {
  const read = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
  for (const f of ['src/pages/metodologia.astro', 'src/components/common/TrustMetrics.astro', 'src/components/home/MethodSection.astro', 'src/components/metodologia/MethodologyQuiz.astro', 'src/pages/index.astro']) {
    const visible = read(f).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(visible, /tests? de estr[eé]s|Pruebas de estr[eé]s|Auditor[ií]as peri|\+300h|100% acertadas|Independencia editorial garantizada|sometemos a pruebas|expertos recomiendan|Test &amp; Proof|Test & Proof/i, f);
  }
});
