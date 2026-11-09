// Guardas estáticas de las páginas editadas en las fases comerciales: nada de afirmaciones sin respaldo y ningún identificador usado sin declarar
// (un `const` borrado por una edición provocó un 500 en el checkout que ninguna prueba unitaria detectaba).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const CHECKOUT = read('src/pages/checkout/[id].astro');
const FICHA = read('src/pages/producto/[slug].astro');
const LAYOUT = read('src/layouts/Layout.astro');
const CARD = read('src/components/ProductCard.astro');

test('checkout declara todo lo que usa en la plantilla', () => {
  for (const name of ['shortTitle', 'exitUrl', 'specsPreview', 'cleanMarketplaceSuffix', 'shippingFeeLabel', 'shippingIsFree', 'isSoldOut', 'provider']) {
    assert.match(CHECKOUT, new RegExp(`const ${name}\\b`), `falta la declaración de ${name}`);
  }
});

test('ninguna superficie pública afirma SSL 256-bit ni «Compra oficial protegida»', () => {
  for (const [name, src] of [['checkout', CHECKOUT], ['ficha', FICHA], ['layout', LAYOUT], ['tarjeta', CARD]]) {
    assert.doesNotMatch(src, /SSL\s*256/i, `${name}: SSL 256`);
    assert.doesNotMatch(src, /Compra oficial protegida/i, `${name}: compra protegida`);
  }
});

test('la ficha no publica el enlace de afiliado en el HTML (JSON-LD con la URL de la ficha)', () => {
  assert.doesNotMatch(FICHA, /url:\s*product\.affiliateUrl/);
});

test('la ficha integra #ofertas y #comparativa y los componentes existen', () => {
  assert.match(FICHA, /<OffersComparator\b/);
  assert.match(FICHA, /<ModelComparison\b/);
  assert.match(FICHA, /id="comparativa"/);
  assert.ok(fs.existsSync(new URL('../../src/components/OffersComparator.astro', import.meta.url)));
  assert.match(read('src/components/OffersComparator.astro'), /id="ofertas"/);
});

test('linkOffers no existe en ningún fichero de src', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
  const hits = walk(new URL('../../src', import.meta.url).pathname.replace(/^\//, '')).filter((f) => /\.(ts|astro|mjs)$/.test(f) && /export (async )?function linkOffers\b/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});

test('tarjetas del catálogo: sin «Auditado», puntuaciones internas ni reputación inventada; usan publicClaims', () => {
  const badge = read('src/components/TestProofBadge.astro');
  const visible = badge.replace(/\/\/[^\n]*/g, ''); // los comentarios del código no cuentan
  assert.doesNotMatch(visible, /Proof Auditado|Conversion score|buena reputación|respuestas verificadas|sin inflado/i);
  assert.match(badge, /publicText/);
  assert.match(CARD, /publicText\(product\)\.description/);
});

test('editorial: sin independencia absoluta, precios «exactos» ni patrocinios no acreditables; aviso de afiliación completo', () => {
  const layout = read('src/layouts/Layout.astro');
  for (const [name, src] of [['layout', layout], ['ficha', FICHA], ['portada', read('src/pages/index.astro')], ['metodologia', read('src/pages/metodologia.astro')], ['trust', read('src/components/common/TrustMetrics.astro')]]) {
    const visible = src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(visible, /100% autónomos|siempre independientes|Análisis independientes? |sin patrocin|total seguridad|son exactos a la fecha|Portal independiente|Política de Imparcialidad/i, name);
  }
  // El aviso no se limita a Amazon, distingue importador de acuerdo y reparte las responsabilidades correctamente.
  assert.match(layout, /Amazon EU Associates/);
  assert.match(layout, /AliExpress/);
  assert.match(layout, /no implica que exista un acuerdo de afiliación/);
  assert.match(layout, /Treidilor añada un coste propio a la compra/);
  assert.match(layout, /los precios y las condiciones finales los determina el vendedor/);
  assert.match(layout, /Comprueba siempre el importe final en la tienda/);
  assert.doesNotMatch(layout, /PcComponentes, Awin/);
});

test('«0 €» enlaza siempre al aviso de afiliación (que existe como ancla en el Layout) y la metodología se llama «Metodología Editorial»', () => {
  assert.match(read('src/pages/index.astro'), /0 €[\s\S]{0,400}href="#aviso-afiliacion"/);
  assert.match(read('src/pages/metodologia.astro'), /0 €[\s\S]{0,300}href="\/#aviso-afiliacion"/);
  assert.match(read('src/components/common/TrustMetrics.astro'), /href: '\/#aviso-afiliacion'/);
  assert.match(read('src/layouts/Layout.astro'), /id="aviso-afiliacion"/);
  const meto = read('src/pages/metodologia.astro');
  assert.match(meto, /Metodología Editorial \| Treidilor/);
  assert.match(meto, /Metodología Editorial:/);
  assert.doesNotMatch(meto.replace(/\/\/[^\n]*/g, ''), /Test &amp; Proof|Test & Proof|pruebas de estr|auditor/i);
  assert.match(FICHA, /href="\/#aviso-afiliacion"/);
});

test('tarjeta: no atribuye al vendedor la condición de «distribuidor oficial»', () => {
  assert.doesNotMatch(CARD, /gestionados por el distribuidor oficial/);
  assert.match(CARD, /El pago y el envío los gestiona la tienda vendedora/);
});

test('ficha: sin «distribuidor oficial» ni promesa de garantía; la tienda vendedora gestiona cobro y condiciones', () => {
  assert.doesNotMatch(FICHA.replace(/\/\/[^\n]*/g, ''), /distribuidor oficial/i);
  assert.match(FICHA, /La tienda vendedora gestiona el cobro y el envío/);
  assert.doesNotMatch(FICHA, /garantía los administrará/);
});

test('checkout: sin «oficial», «pago seguro» ni pasarelas concretas; la tienda vendedora gestiona pago y envío', () => {
  const visible = CHECKOUT.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(visible, /distribuidor oficial|pasarela oficial|pasarela de pago oficial|almacén oficial|pago seguro|enlace seguro|de forma segura/i);
  assert.doesNotMatch(visible, /en su pasarela/i);
  assert.match(CHECKOUT, /Tienda vendedora/);
  assert.match(CHECKOUT, /El pago y el envío los gestiona la tienda vendedora/);
  // La lógica de salida no cambia: el botón y el enlace de respaldo siguen yendo a /api/redirect con su id.
  assert.match(CHECKOUT, /exitUrl = `\/api\/redirect\?id=\$\{encodeURIComponent\(productKey\(product\)\)\}&src=checkout`/);
  assert.match(CHECKOUT, /id="exitBtn"/);
  assert.match(CHECKOUT, /id="exitFallback"/);
});
