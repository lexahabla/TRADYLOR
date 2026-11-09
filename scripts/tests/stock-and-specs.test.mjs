// Stock imprescindible (tarjeta, ficha, checkout, comparador), aviso de vuelta a stock en Mi Radar, encabezado por subcategoría/categoría y
// especificaciones del comparador extraídas del título cuando la ficha no las trae. Datos sintéticos aislados.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-stock-specs-');
const { stockOf } = await import('../../src/lib/stock.ts');
const X = await import('../../src/lib/specExtract.ts');
const { buildModelComparison, comparisonHeading } = await import('../../src/lib/modelComparison.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

/* ───────────── Stock ───────────── */

test('stock: sólo se afirma lo que declara la fuente; sin dato es «Stock no indicado» y nunca «En stock»', () => {
  assert.equal(stockOf({ inStock: true }).label, 'En stock');
  assert.equal(stockOf({ inStock: false }).label, 'Agotado');
  assert.equal(stockOf({}).label, 'Stock no indicado');
  assert.equal(stockOf({ inStock: undefined }).state, 'unknown');
  assert.equal(stockOf({ inStock: true, pricing: { stockStatus: 'Pocas unidades' } }).label, 'Pocas unidades');
  assert.equal(stockOf({ inStock: false, pricing: { stockStatus: 'Pocas unidades' } }).state, 'out_of_stock', 'agotado manda sobre «pocas unidades»');
});

test('el aviso de vuelta a stock sólo se ofrece si la fuente declara AGOTADO (no con stock desconocido)', () => {
  assert.equal(stockOf({ inStock: false }).canNotify, true);
  assert.equal(stockOf({ inStock: true }).canNotify, false);
  assert.equal(stockOf({}).canNotify, false);
});

test('el dato de stock lleva su fecha de captura cuando existe (no se presenta como «ahora»)', () => {
  const s = stockOf({ inStock: true, extra: { priceReading: { capturedAt: '2026-11-02T08:00:00Z', capturedAtInferred: false } } });
  assert.match(s.hint, /fecha de captura \(02\/11\/2026\)/);
  assert.match(stockOf({}).hint, /no ha indicado la disponibilidad/);
});

test('el stock está a la vista en la tarjeta, la ficha, el checkout y el comparador de modelos', () => {
  assert.match(read('src/components/ProductCard.astro'), /<StockBadge product=\{product as any\} \/>/);
  assert.match(read('src/pages/producto/[slug].astro'), /<StockBadge product=\{product as any\} size="md" \/>/);
  assert.match(read('src/pages/checkout/[id].astro'), /<StockBadge product=\{product as any\} size="md" \/>/);
  assert.match(read('src/components/ModelComparison.astro'), /<StockBadge stock=\{c\.stock\} \/>/);
  assert.match(read('src/components/StockBadge.astro'), /stock-badge-text/); // texto, no sólo color
});

test('aviso de stock: botón en tarjeta, ficha, checkout y comparador; se guarda en Mi Radar con notifyStock y exige sesión', () => {
  assert.match(read('src/components/ProductCard.astro'), /<StockAlert product=\{product as any\} compact \/>/);
  assert.match(read('src/pages/producto/[slug].astro'), /<StockAlert product=\{product as any\} \/>/);
  assert.match(read('src/pages/checkout/[id].astro'), /<StockAlert product=\{product as any\} \/>/);
  assert.match(read('src/components/ModelComparison.astro'), /<StockAlert product=\{c\.alertProduct\} compact \/>/);
  const layout = read('src/layouts/Layout.astro');
  assert.match(layout, /\[data-stock-alert\]/);
  assert.match(layout, /setProductAlert\(\{ productId: radarId, notifyStock: true \}\)/);
  assert.match(layout, /Inicia sesión para recibir el aviso de stock en Mi Radar/);
  assert.match(read('src/components/StockAlert.astro'), /stock\.canNotify/);
  // El worker de Mi Radar ya vigila `notifyStock` (aviso de vuelta a stock): no se duplica su lógica.
  const worker = read('src/lib/priceAlerts.ts');
  assert.match(worker, /product\.notifyStock === true/);
  assert.match(worker, /lastInStock === false/);
  assert.doesNotMatch(read('src/lib/priceAlertCenter.ts'), /notifyStock/);
});

/* ───────────── Encabezado por subcategoría y categoría ───────────── */

const cats = [
  { id: 'informatica', slug: 'informatica', name: 'Informática', icon: '💻', parentId: null },
  { id: 'informatica--portatiles', slug: 'informatica--portatiles', name: 'Portátiles', icon: '', parentId: 'informatica' },
  { id: 'sonido', slug: 'sonido', name: 'Sonido', icon: '🎧', parentId: null },
];
fs.writeFileSync(path.join(dir, 'categories.json'), JSON.stringify(cats));
const { invalidateCategoriesCache } = await import('../../src/lib/categories.ts');
invalidateCategoriesCache();

test('encabezado: «Comparar Portátiles de Informática» con subcategoría asignada y también deducido de la familia sin subcategoría', () => {
  assert.equal(comparisonHeading({ title: 'Portátil X', category: 'Informática', category_id: 'informatica', subcategory_id: 'informatica--portatiles' }), 'Comparar Portátiles de Informática');
  assert.equal(comparisonHeading({ title: 'Ordenador portátil HP 15', category: 'Informática', category_id: 'informatica' }), 'Comparar Portátiles de Informática');
  assert.equal(comparisonHeading({ title: 'Auriculares inalámbricos Zeta', category: 'Sonido', category_id: 'sonido' }), 'Comparar Auriculares de Sonido');
  assert.equal(comparisonHeading({ title: 'Cosa rara', category: 'Sonido' }), 'Comparar modelos: Sonido');
});

/* ───────────── Especificaciones desde el título ───────────── */

test('extractores del título: RAM, almacenamiento, procesador, pantalla, GPU', () => {
  const t = 'Lenovo IdeaPad Slim 3, Ordenador Portátil, Intel Core i5-13420H, 16GB, 1TB SSD, 15,6" FHD, RTX 3050, W11';
  assert.equal(X.ramFromTitle(t), '16 GB');
  assert.equal(X.storageFromTitle(t), '1 TB SSD');
  assert.equal(X.cpuFromTitle(t), 'Intel Core i5-13420H');
  assert.equal(X.screenFromTitle(t), '15,6"');
  assert.equal(X.gpuFromTitle(t), 'RTX 3050');
  assert.equal(X.storageFromTitle('Portátil 8GB RAM 512GB'), '512 GB');
  assert.equal(X.ramFromTitle('Portátil 8GB RAM 512GB'), '8 GB');
  assert.equal(X.cpuFromTitle('MacBook Air 13" M4 16GB 512GB'), 'M4');
  assert.equal(X.cpuFromTitle('Portátil AMD Ryzen 5 7520U'), 'AMD Ryzen 5 7520U');
  assert.equal(X.screenFromTitle('Portátil ASUS Vivobook 16 pulgadas'), '16"');
});

test('los extractores no inventan: sin patrón claro devuelven null', () => {
  for (const f of [X.ramFromTitle, X.storageFromTitle, X.cpuFromTitle, X.screenFromTitle, X.gpuFromTitle, X.bluetoothFromTitle, X.autonomyFromTitle]) {
    assert.equal(f('Producto genérico sin datos'), null);
  }
  assert.equal(X.screenFromTitle('Ratón 2000 DPI'), null);
  assert.equal(X.autonomyFromTitle('Cargador 5 W'), null);
  assert.equal(X.autonomyFromTitle('Auriculares OneOdio A70 72H'), '72 h');
  assert.equal(X.bluetoothFromTitle('Auriculares Bluetooth 5.3 TWS'), 'Bluetooth 5.3');
});

const mk = (id, title, price, specs, over = {}) => ({ id, slug: id, title, brand: 'Zeta', price, category: 'Informática', category_id: 'informatica', image: `/${id}.jpg`, merchant: 'Amazon', currency: 'EUR', inStock: true, pros: [], cons: [], specs, extra: { Tienda: id, externalId: id }, ...over });

test('el comparador completa las especificaciones vacías con el título y lo marca como «del título»; la ficha manda si trae un valor utilizable', () => {
  const a = mk('a', 'Portátil Alfa Intel Core i5-1235U 16GB 512GB SSD 15,6"', 800, {});
  const b = mk('b', 'Portátil Beta', 900, { 'Memoria RAM': '32 GB', Almacenamiento: '1 TB', Procesador: 'Ryzen 7 7735U', Pantalla: '16 pulgadas' });
  const c = buildModelComparison(a, [a, b]);
  const spec = c.rows.find((r) => r.label === 'Especificaciones técnicas');
  assert.ok(spec, 'hay fila de especificaciones');
  const get = (col, label) => spec.items[col].find((i) => i.label === label);
  assert.equal(get(0, 'RAM').value, '16 GB');
  assert.equal(get(0, 'RAM').fromTitle, true);
  assert.equal(get(0, 'Procesador').value, 'Intel Core i5-1235U');
  assert.equal(get(0, 'Almacenamiento').value, '512 GB SSD');
  assert.equal(get(0, 'Pantalla').value, '15,6"');
  assert.equal(get(1, 'RAM').value, '32 GB');
  assert.equal(get(1, 'RAM').fromTitle, undefined);
});

test('valores inservibles de la ficha («330» como procesador, «SSD» sin capacidad, «DDR5» como RAM) no ganan al título', () => {
  const a = mk('c', 'Portátil Gamma Intel Core i7-13700H 16GB 1TB', 1000, { Procesador: '330', Almacenamiento: 'SSD', 'Memoria RAM': 'DDR5, SO-DIMM' });
  const b = mk('d', 'Portátil Delta', 1100, { Procesador: 'Core i9', Almacenamiento: '2 TB', 'Memoria RAM': '64 GB' });
  const spec = buildModelComparison(a, [a, b]).rows.find((r) => r.label === 'Especificaciones técnicas');
  const item = (label) => spec.items[0].find((i) => i.label === label);
  assert.equal(item('Procesador').value, 'Intel Core i7-13700H');
  assert.equal(item('Almacenamiento').value, '1 TB');
  assert.equal(item('RAM').value, '16 GB');
});

test('entre varias claves de procesador se elige la descriptiva (no la velocidad ni el nº de procesadores)', () => {
  const a = mk('e', 'Portátil Épsilon', 700, { 'Tipo De Procesador': 'Core i5', 'Velocidad Del Procesador': '2,1 GHz', 'Nº De Procesadores': '8', 'Marca Del Procesador': 'Intel', 'Modelo De Cpu': '330' });
  const b = mk('f', 'Portátil Zeta Core i7', 800, { 'Tipo De Procesador': 'Core i7' });
  const spec = buildModelComparison(a, [a, b]).rows.find((r) => r.label === 'Especificaciones técnicas');
  assert.equal(spec.items[0].find((i) => i.label === 'Procesador').value, 'Core i5');
});

test('en un portátil no se listan conectividad ni color; unos auriculares no muestran RAM ni GPU', () => {
  const a = mk('g', 'Portátil Eta Core i5 16GB 512GB', 700, { Conectividad: 'Bluetooth', Color: 'Gris', 'Memoria RAM': '16 GB' });
  const b = mk('h', 'Portátil Theta Core i5 8GB 256GB', 600, { Conectividad: 'Bluetooth', Color: 'Azul', 'Memoria RAM': '8 GB' });
  const labels = buildModelComparison(a, [a, b]).rows.find((r) => r.label === 'Especificaciones técnicas').items[0].map((i) => i.label);
  assert.ok(!labels.includes('Conectividad') && !labels.includes('Color'), labels.join('|'));
  const h1 = mk('i', 'Auriculares inalámbricos Iota Bluetooth 5.3 40H', 30, {}, { category: 'Sonido', category_id: 'sonido' });
  const h2 = mk('j', 'Auriculares inalámbricos Kappa Bluetooth 5.2 20H', 25, {}, { category: 'Sonido', category_id: 'sonido' });
  const hl = buildModelComparison(h1, [h1, h2]).rows.find((r) => r.label === 'Especificaciones técnicas').items[0];
  assert.ok(hl.some((i) => i.label === 'Autonomía' && i.value === '40 h'));
  assert.ok(hl.some((i) => i.label === 'Conectividad' && i.value === 'Bluetooth 5.3'));
  assert.ok(!hl.some((i) => /RAM|GPU/.test(i.label)));
});

test('cada columna del comparador trae su stock y los datos para el aviso; el comparador usa el encabezado por categoría', () => {
  const a = mk('k', 'Portátil Lambda', 700, {}, { inStock: false });
  const b = mk('l', 'Portátil Mu', 800, {}, { inStock: undefined });
  const c = buildModelComparison(a, [a, b]);
  assert.equal(c.columns[0].stock.state, 'out_of_stock');
  assert.equal(c.columns[0].stock.canNotify, true);
  assert.equal(c.columns[1].stock.state, 'unknown');
  assert.equal(c.columns[1].stock.canNotify, false);
  assert.equal(c.columns[0].alertProduct.id, 'k');
  assert.equal(c.heading, 'Comparar Portátiles de Informática');
  assert.match(read('src/pages/producto/[slug].astro'), /<ModelComparison comparison=\{modelComparison\} \/>/);
});
