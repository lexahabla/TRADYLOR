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

/* ───────────── Tarjetas de cabecera (diseño Product Card) ───────────── */

test('tarjeta: foto, precio, valoración y barra salen del PROPIO producto del catálogo (nunca de otro modelo)', async () => {
  const { satisfactionPercent } = await import('../../src/lib/satisfaction.ts');
  const a = mk('ta', 'Portátil Alfa 15', 500, { image: 'https://img.invalid/alfa.jpg' });
  const b = mk('tb', 'Portátil Beta 15', 520, { image: 'https://img.invalid/beta.jpg' });
  const c = buildModelComparison(a, [a, b]);
  assert.equal(c.columns[0].image, 'https://img.invalid/alfa.jpg');
  assert.equal(c.columns[1].image, 'https://img.invalid/beta.jpg');
  assert.match(c.columns[0].priceText, /500,00/);
  assert.equal(c.columns[1].satisfaction, satisfactionPercent(b));
  assert.match(c.columns[0].ratingText, /^★ 4,5 · 40 valoraciones/);
});

test('tarjeta: sin descuento verificado no hay porcentaje ni precio anterior; con él, sí (y coincide con el catálogo)', () => {
  const plain = mk('d1', 'Portátil Gamma 15', 400, { originalPrice: 600 });
  const verified = mk('d2', 'Portátil Delta 15', 400, { originalPrice: 600, extra: { Tienda: 'T', externalId: 'd2', observations: [{ price: 400, originalPrice: 500, verifiedAt: '2026-11-08T10:00:00Z', context: { currency: 'EUR' } }] } });
  const c = buildModelComparison(plain, [plain, verified]);
  assert.equal(c.columns[0].discountPct, null, 'originalPrice declarado sin verificar no es descuento');
  assert.equal(c.columns[0].previousPriceText, null);
  assert.equal(c.columns[1].discountPct, 20);
  assert.match(c.columns[1].previousPriceText, /500,00/);
});

test('tarjeta: sin valoración fiable no se muestra valoración; la de AliExpress por defecto (4,8★/100) no cuenta', () => {
  const a = mk('r1', 'Portátil Épsilon 15', 400, { rating: undefined, reviewsCount: undefined });
  const b = mk('r2', 'Portátil Zeta 15', 410, { rating: 4.8, reviewsCount: 100 });
  const c = buildModelComparison(a, [a, b]);
  assert.equal(c.columns[0].ratingText, null);
  assert.equal(c.columns[1].ratingText, null, 'valor por defecto del alta: oculto');
});


test('las etiquetas de característica se muestran legibles (sin guiones ni acentos perdidos)', () => {
  const a = mk('l1', 'Portátil Lambda 15', 500, { specs: { 'Tamano-del-disco-duro': '512 GB', 'Nombre-del-modelo': 'L1' } });
  const b = mk('l2', 'Portátil Mu 15', 520, { specs: { 'Tamano-del-disco-duro': '1 TB', 'Nombre-del-modelo': 'M2' } });
  const labels = buildModelComparison(a, [a, b]).rows.map((r) => r.label);
  assert.ok(!labels.some((l) => /-/.test(l)), labels.join('|'));
});

/* ───────────── Ajuste de diseño (referencia visual): especificaciones agrupadas, barra de ProductCard, botón a la ficha ───────────── */

const laptop = (id, title, price, specs, over = {}) => mk(id, title, price, { specs, ...over });

test('UNA fila «Especificaciones técnicas» agrupa almacenamiento, RAM, procesador, GPU y pantalla en el mismo orden; sin fila de color', () => {
  const a = laptop('s1', 'Portátil Sigma 15', 800, { Color: 'Gris', 'Memoria RAM': '16 GB', Almacenamiento: '512 GB', 'Modelo de CPU': 'Core i5', GPU: 'Iris Xe', 'Tamaño de pantalla': '15.6 pulgadas' });
  const b = laptop('s2', 'Portátil Tau 15', 900, { Color: 'Azul', 'Memoria RAM': '32 GB', Almacenamiento: '1 TB', 'Modelo de CPU': 'Core i7', GPU: 'RTX 3050', 'Tamaño de pantalla': '16 pulgadas' });
  const c = buildModelComparison(a, [a, b]);
  const labels = c.rows.map((r) => r.label);
  assert.equal(labels.filter((l) => l === 'Especificaciones técnicas').length, 1);
  assert.ok(!labels.some((l) => /^color/i.test(l)), labels.join('|'));
  const spec = c.rows.find((r) => r.label === 'Especificaciones técnicas');
  assert.equal(spec.items.length, 2);
  const order = spec.items[0].map((i) => i.label);
  assert.deepEqual(spec.items[1].map((i) => i.label), order, 'mismas características, mismo orden en todas las columnas');
  assert.ok(order.indexOf('Almacenamiento') < order.indexOf('RAM'));
  assert.ok(order.indexOf('RAM') < order.indexOf('Procesador'));
  assert.ok(order.indexOf('Procesador') < order.indexOf('GPU'));
  assert.ok(order.indexOf('GPU') < order.indexOf('Pantalla'));
  assert.ok(!order.includes('Color'));
  assert.match(spec.cells[0], /RAM: 16 GB/);
});

test('las especificaciones se adaptan a la categoría: unos auriculares no muestran GPU ni RAM', () => {
  const noSub = { subcategory_id: undefined, category: 'Sonido' };
  const a = mk('h1', 'Auriculares inalámbricos Alfa', 30, { ...noSub, specs: { Conectividad: 'Bluetooth 5.3', Autonomía: '20 h', Color: 'Negro' } });
  const b = mk('h2', 'Auriculares inalámbricos Beta', 35, { ...noSub, specs: { Conectividad: 'Bluetooth 5.2', Autonomía: '30 h', Color: 'Blanco' } });
  const spec = buildModelComparison(a, [a, b]).rows.find((r) => r.label === 'Especificaciones técnicas');
  const labels = spec.items[0].map((i) => i.label).join('|');
  assert.doesNotMatch(labels, /GPU|RAM|Procesador|Color/);
  assert.match(labels, /Conectividad/);
});

test('lo que un modelo no declara sale como «Sin dato» dentro de su celda, sin inventar valores', () => {
  const a = laptop('m1', 'Portátil Ómicron 15', 800, { 'Memoria RAM': '16 GB', Almacenamiento: '512 GB' });
  const b = laptop('m2', 'Portátil Pi 15', 820, { 'Memoria RAM': '8 GB' });
  const spec = buildModelComparison(a, [a, b]).rows.find((r) => r.label === 'Especificaciones técnicas');
  const miss = spec.items[1].find((i) => i.label === 'RAM');
  assert.equal(miss.value, '8 GB');
});

test('descripción breve: depurada de afirmaciones sin respaldo, sin sufijo de tienda y recortada', () => {
  const a = mk('b1', 'Portátil Rho 15', 500, { description: 'Pantalla de 15 pulgadas con buena luminosidad. Valoración media de 4,8 estrellas en 25 reseñas. - AliExpress' });
  const b = mk('b2', 'Portátil Sigma 16', 520, { description: 'x'.repeat(300) });
  const c = buildModelComparison(a, [a, b]);
  assert.match(c.columns[0].description, /Pantalla de 15 pulgadas/);
  assert.doesNotMatch(c.columns[0].description, /reseñas|AliExpress/);
  assert.ok(c.columns[1].description.length <= 111);
});

test('componente: foto y título a la ficha, botón «Ver ficha del producto», pastilla verde, barra con las reglas de ProductCard y sin distintivos editoriales', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const src = read('src/components/ModelComparison.astro');
  assert.match(src, /class="mc-img-link"[^>]*aria-label/);
  assert.match(src, /mc-title"><a href=\{c\.href\}/);
  assert.match(src, /Ver ficha del producto<\/a>/);
  assert.match(src, /mc-pill-green/);
  assert.match(src, /#059669/);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /Elección del editor|Mejor valorado/i);
  assert.match(src, /focus-visible/);
  assert.match(src, /prefers-reduced-motion/);
  assert.match(src, /loading="lazy"/);
  assert.match(src, /IN_CARD = new Set\(\['Precio publicado', 'Valoración'/);
  assert.doesNotMatch(src, /affiliateUrl|\/api\/redirect|buildPurchaseUrl/, 'sin enlaces de afiliación');
  // Barra: mismas reglas CSS que ProductCard (misma proporción, colores y alturas).
  const card = read('src/components/ProductCard.astro');
  const rule = (css, sel) => css.match(new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1].replace(/\s+/g, ' ').trim();
  for (const sel of ['.sat-positive', '.sat-negative', '.satisfaction-track', '.satisfaction-fill', '.satisfaction-label']) {
    const a = rule(card, sel);
    const b = rule(src, sel);
    assert.ok(a && b, sel);
    assert.equal(b.replace(/\s/g, ''), a.replace(/\s/g, ''), `${sel} difiere de ProductCard`);
  }
  assert.match(src, /SATISFACTION_NOTE/);
  assert.match(read('src/pages/producto/[slug].astro'), /id="comparativa"/);
});
