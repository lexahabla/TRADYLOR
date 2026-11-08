// Búsqueda y filtros del catálogo público: marca real del fabricante, búsqueda limitada a título/marca/categoría (sin tildes),
// filtros OR/AND, Bluetooth sólo si lo declaran las especificaciones, gangas con precio anterior verificado, categorías unificadas,
// estado en la URL y recuentos reales. Sin red ni IA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupIsolatedData, readCatalog, writeCatalog } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-listing-');
const { resolveBrand, withResolvedBrand, brandFromSpecs, isMerchantOrPlaceholderBrand } = await import('../../src/lib/brandResolve.ts');
const L = await import('../../src/lib/catalogListing.ts');
const facets = await import('../../src/lib/catalogFacets.ts');
const store = await import('../../src/lib/productStore.ts');
const facetsRoute = await import('../../src/pages/api/catalogo/facets.ts');
const searchRoute = await import('../../src/pages/api/search.ts');

const CATS = [
  { id: 'informatica', name: 'Informática', slug: 'informatica', icon: '', keywords: [] },
  { id: 'portatiles', name: 'Portátiles', slug: 'informatica--portatiles', icon: '', keywords: [], parentId: 'informatica' },
  { id: 'sonido', name: 'Sonido', slug: 'sonido', icon: '', keywords: [] },
  { id: 'hogar', name: 'Hogar', slug: 'hogar', icon: '', keywords: [] },
];
const resolver = L.makeCategoryResolver(CATS);
const NOW = new Date('2026-11-08T12:00:00.000Z');

const mk = (id, over = {}) => ({
  id, title: id, description: '', price: 40, currency: 'EUR', network: 'amazon', merchant: 'Amazon', affiliateUrl: 'https://www.amazon.es/dp/B0TEST' + id.replace(/[^a-z0-9]/gi, '').toUpperCase().padEnd(4, 'X').slice(0, 4), inStock: true, category: 'Sonido', category_id: 'sonido', specs: {}, extra: {}, ...over,
});
const run = (products, qs) => L.buildListing(products, L.parseListingParams(new URLSearchParams(qs)), { resolver, now: NOW });
const ids = (listing) => listing.filtered.map((p) => p.id).sort();
const group = (listing, key) => listing.groups.find((g) => g.key === key);

/* ───────────── Marca real del fabricante ───────────── */

test('una tienda NO es una marca: AliExpress, eBay, Amazon, Temu y [object Object] se descartan', () => {
  for (const bad of ['AliExpress', 'aliexpress', 'ebay', 'Amazon', 'Temu', 'Vendedor', '[object Object]', '', '—', null, undefined, {}]) {
    assert.equal(isMerchantOrPlaceholderBrand(bad), true, String(bad));
  }
  assert.equal(isMerchantOrPlaceholderBrand('Sony'), false);
  assert.equal(isMerchantOrPlaceholderBrand('Baseus'), false);
  assert.equal(isMerchantOrPlaceholderBrand('Mi Tienda Oficial', 'Mi Tienda Oficial'), true, 'igual que el comerciante');
});

test('la marca real se extrae de las especificaciones (Marca, Brand, Fabricante…) cuando la cabecera es la tienda', () => {
  assert.equal(resolveBrand({ brand: 'AliExpress', merchant: 'aliexpress', specs: { Marca: 'Baseus' } }), 'Baseus');
  assert.equal(resolveBrand({ brand: 'ebay', merchant: 'ebay', specs: { Brand: 'Logitech' } }), 'Logitech');
  assert.equal(resolveBrand({ brand: '', merchant: 'Temu', specs: { fabricante: 'QCY' } }), 'QCY');
  assert.equal(resolveBrand({ brand: 'Sony', merchant: 'Amazon', specs: { Marca: 'Otra' } }), 'Sony', 'una marca válida se conserva');
  assert.equal(brandFromSpecs({ Marca: 'AliExpress' }, 'aliexpress'), '', 'una «Marca» que es la tienda tampoco vale');
  assert.equal(brandFromSpecs({ Color: 'Negro' }), '');
});

test('sin dato fiable la ficha queda SIN marca: nunca se deduce del título', () => {
  const p = { brand: 'AliExpress', merchant: 'aliexpress', title: 'Auriculares originales Sony A7pro', specs: { Conectividad: 'Bluetooth' } };
  assert.equal(resolveBrand(p), '');
  const fixed = withResolvedBrand(p);
  assert.equal(fixed.brand, undefined);
  assert.equal(p.brand, 'AliExpress', 'no muta la ficha original');
});

test('un campo «brand» bloqueado por el usuario no se toca', () => {
  const p = { brand: 'AliExpress', merchant: 'aliexpress', specs: { Marca: 'Baseus' }, extra: { lockedFields: ['brand'] } };
  assert.equal(withResolvedBrand(p), p);
});

test('punto único de escritura: cualquier alta o actualización guarda la marca real, no la tienda', () => {
  writeCatalog(dir, []);
  store.upsertProduct({ id: 'ali-1', title: 'Cargador', price: 9, category: 'Sonido', merchant: 'aliexpress', brand: 'AliExpress', specs: { Marca: 'Toocki' } });
  store.upsertProduct({ id: 'ali-2', title: 'Cable', price: 3, category: 'Sonido', merchant: 'aliexpress', brand: 'AliExpress', specs: { Tipo: 'USB' } });
  const saved = Object.fromEntries(readCatalog(dir).map((p) => [p.id, p]));
  assert.equal(saved['ali-1'].brand, 'Toocki');
  assert.equal(saved['ali-2'].brand, undefined);
});

/* ───────────── Búsqueda ───────────── */

test('la búsqueda mira SÓLO título, marca y categoría, sin tildes ni mayúsculas (la descripción no cuenta)', () => {
  const products = [
    mk('a', { title: 'Auriculares inalámbricos TWS', description: 'Un regalo perfecto' }),
    mk('b', { title: 'Funda de cuero', description: 'Compatible con auriculares y AirPods' }),
    mk('c', { title: 'Reloj', brand: 'Sónico', category: 'Relojería', category_id: undefined }),
    mk('d', { title: 'Altavoz', category: 'Sonido' }),
  ];
  assert.deepEqual(ids(run(products, 'q=AURICULARES')), ['a'], 'el texto de la descripción no cuenta');
  assert.deepEqual(ids(run(products, 'q=sonico')), ['c'], 'marca «Sónico» encontrada sin tildes');
  assert.deepEqual(ids(run(products, 'q=sonid')), ['a', 'b', 'd'], 'la categoría «Sonido» también se busca (a, b y d la tienen; c es «Relojería»)');
  assert.deepEqual(ids(run(products, 'q=inalambricos auricular')), ['a'], 'todas las palabras deben aparecer');
  assert.deepEqual(ids(run(products, 'q=zzz')), []);
});

test('el desplegable /api/search tampoco puntúa por descripción (misma regla que el listado)', async () => {
  writeCatalog(dir, [
    mk('s1', { title: 'Auriculares Bluetooth', price: 20 }),
    mk('s2', { title: 'Funda de cuero', price: 5, description: 'Para auriculares y más' }),
  ]);
  const res = await searchRoute.GET({ request: new Request('http://localhost/api/search?q=auriculares') });
  const body = await res.json();
  assert.deepEqual(body.products.map((p) => p.id), ['s1']);
});

/* ───────────── Categorías unificadas ───────────── */

test('«Sonido» y «Audio & Sonido» son la MISMA categoría; los portátiles cuentan en Informática', () => {
  const a = mk('a', { category: 'Sonido', category_id: undefined });
  const b = mk('b', { category: 'Audio & Sonido', category_id: undefined });
  const c = mk('c', { category: 'Informática & Laptops', category_id: undefined });
  const d = mk('d', { category: 'Portátiles', category_id: undefined });
  const e = mk('e', { category: '', category_id: undefined });
  assert.deepEqual(resolver.idsOf(a), ['sonido']);
  assert.deepEqual(resolver.idsOf(b), ['sonido']);
  assert.deepEqual(resolver.idsOf(c), ['informatica']);
  assert.deepEqual(resolver.idsOf(d), ['informatica', 'informatica--portatiles']);
  assert.deepEqual(resolver.idsOf(e), [], 'sin categoría reconocible no se inventa una');
  const listing = run([a, b, c, d, e], 'category=sonido');
  assert.deepEqual(ids(listing), ['a', 'b']);
});

test('category_id manda sobre el texto libre', () => {
  assert.deepEqual(resolver.idsOf(mk('x', { category: 'Cables y Adaptadores', category_id: 'hogar' })), ['hogar']);
});

/* ───────────── Filtros: OR dentro, AND entre grupos ───────────── */

const CATALOG = [
  mk('sony-1', { title: 'Auriculares A', brand: 'Sony', price: 40, specs: { Conectividad: 'Bluetooth 5.3' } }),
  mk('sony-2', { title: 'Auriculares B', brand: 'Sony', price: 90, specs: { Conectividad: 'Bluetooth' } }),
  mk('jbl-1', { title: 'Auriculares C', brand: 'JBL', price: 30, specs: { Conectividad: 'Cable 3.5 mm' } }),
  mk('qcy-1', { title: 'Auriculares D Bluetooth', brand: 'QCY', price: 25, specs: {} }), // «Bluetooth» sólo en el título
  mk('pc-1', { title: 'Portátil', brand: 'HP', price: 700, category: 'Informática', category_id: 'informatica', specs: {} }),
];

test('OR dentro del mismo grupo (varias marcas) y AND entre grupos (marca Y precio Y categoría)', () => {
  assert.deepEqual(ids(run(CATALOG, 'brand=sony&brand=jbl')), ['jbl-1', 'sony-1', 'sony-2']);
  assert.deepEqual(ids(run(CATALOG, 'brand=sony&brand=jbl&max=60')), ['jbl-1', 'sony-1']);
  assert.deepEqual(ids(run(CATALOG, 'brand=sony&brand=hp&category=sonido&max=100')), ['sony-1', 'sony-2'], 'categoría Y marca Y precio');
});

test('«auriculares», máximo 60 € y Bluetooth: sólo cuenta lo que las ESPECIFICACIONES declaran', () => {
  const listing = run(CATALOG, 'q=auriculares&max=60&f_conectividad=bluetooth');
  assert.deepEqual(ids(listing), ['sony-1'], 'qcy-1 menciona Bluetooth sólo en el título: no se deduce');
  const conn = group(run(CATALOG, 'q=auriculares'), 'conectividad');
  assert.ok(conn, 'el filtro existe porque hay datos fiables');
  const bt = conn.options.find((o) => o.value === 'bluetooth');
  assert.equal(bt.count, 2, 'recuento real: sony-1 y sony-2');
  assert.ok(conn.options.some((o) => /cable/i.test(o.label)), 'otros valores declarados se conservan');
});

test('Bluetooth también se reconoce por «Compatible Bluetooth: Sí» y «bluetooth_support: Yes»; «No» no cuenta', () => {
  const products = [
    mk('p1', { specs: { '¿Compatible Bluetooth?': 'Sí' } }),
    mk('p2', { specs: { bluetooth_support: 'Yes' } }),
    mk('p3', { specs: { bluetooth_support: 'No' } }),
    mk('p4', { specs: {} }),
  ];
  assert.deepEqual(ids(run(products, 'f_conectividad=bluetooth')), ['p1', 'p2']);
});

test('sin ningún dato de conectividad NO se ofrece el filtro (nada de opciones ni recuentos ficticios)', () => {
  const products = [mk('a'), mk('b')];
  assert.equal(group(run(products, ''), 'conectividad'), undefined);
});

test('«Sony» abarca varias categorías a la vez (la categoría es un filtro más, no una condición previa)', () => {
  const products = [
    mk('s1', { title: 'Auriculares Sony', brand: 'Sony' }),
    mk('s2', { title: 'Portátil Sony Vaio', brand: 'Sony', category: 'Informática', category_id: 'informatica' }),
    mk('o1', { title: 'Auriculares JBL', brand: 'JBL' }),
  ];
  const listing = run(products, 'q=sony');
  assert.deepEqual(ids(listing), ['s1', 's2']);
  const cat = group(listing, 'category');
  assert.deepEqual(cat.options.filter((o) => o.count > 0).map((o) => o.value).sort(), ['informatica', 'sonido']);
});

test('recuentos de facetas con el resto de filtros aplicados y sin contar dos veces un producto', () => {
  const listing = run(CATALOG, 'brand=sony&max=60');
  const brands = Object.fromEntries(group(listing, 'brand').options.map((o) => [o.value, o.count]));
  assert.equal(brands.sony, 1, 'la marca Sony se cuenta con el filtro de precio aplicado');
  assert.equal(brands.jbl, 1, 'JBL sigue disponible (los filtros del propio grupo no se aplican a sus recuentos)');
  assert.equal(listing.filtered.length, 1);
});

test('el precio no excluye una ficha por tener una lectura antigua (el público ve el precio publicado)', () => {
  const stale = mk('old', { price: 30, extra: { refresh: { lastVerifiedAt: '2025-01-01T00:00:00.000Z' } } });
  assert.deepEqual(ids(run([stale], 'max=60')), ['old']);
});

/* ───────────── Gangas ───────────── */

const obs = (price, originalPrice, verifiedAt) => ({ price, originalPrice, verifiedAt, capturedAt: verifiedAt });

test('Gangas: descuento ≥ 20 % con precio anterior VERIFICADO, vigente y coherente con el precio publicado', () => {
  const ok = mk('ok', { price: 70, originalPrice: 100, extra: { observations: [obs(70, 100, '2026-11-07T10:00:00.000Z')] } });
  const low = mk('low', { price: 90, originalPrice: 100, extra: { observations: [obs(90, 100, '2026-11-07T10:00:00.000Z')] } });
  const declared = mk('declared', { price: 50, originalPrice: 100, extra: {} }); // precio de lista sin verificar
  const old = mk('old', { price: 70, originalPrice: 100, extra: { observations: [obs(70, 100, '2026-10-01T10:00:00.000Z')] } });
  const moved = mk('moved', { price: 60, originalPrice: 100, extra: { observations: [obs(70, 100, '2026-11-07T10:00:00.000Z')] } });
  assert.equal(facets.verifiedDealPct(ok, NOW), 30);
  for (const p of [low, declared, old, moved]) assert.equal(facets.verifiedDealPct(p, NOW), null, p.id);
  const all = [ok, low, declared, old, moved];
  assert.deepEqual(ids(run(all, 'deal=1')), ['ok']);
  assert.equal(run(all, '').deals, 1, 'el recuento de gangas es real');
  assert.equal(run([declared, low], '').deals, 0);
});

/* ───────────── URL, chips y sin coincidencias ───────────── */

test('la URL es la única fuente de verdad: parseo tolerante y enlaces reproducibles', () => {
  const p = L.parseListingParams(new URLSearchParams('q=%20auriculares%20&category=Sonido&category=sonido&brand=Sony&brand=JBL&min=10&max=abc&deal=1&f_conectividad=Bluetooth&f_inventado=x&sort=Precio_Asc&page=-3'));
  assert.equal(p.q, 'auriculares');
  assert.deepEqual(p.category, ['sonido']);
  assert.deepEqual(p.brand, ['sony', 'jbl']);
  assert.equal(p.min, 10);
  assert.equal(p.max, undefined, 'un número inválido se ignora');
  assert.equal(p.deal, true);
  assert.deepEqual(p.attrs, { conectividad: ['bluetooth'] }, 'sólo atributos permitidos');
  assert.equal(p.sort, 'precio_asc');
  assert.equal(p.page, 1);
  const href = L.listingHref(p, { page: 2 });
  assert.equal(href, '/?q=auriculares&category=sonido&brand=sony&brand=jbl&f_conectividad=bluetooth&min=10&deal=1&sort=precio_asc&page=2#catalogo');
  const back = L.parseListingParams(new URL(href.replace('#catalogo', ''), 'http://x').searchParams);
  assert.deepEqual({ ...back, page: 1 }, { ...p, page: 1 });
  assert.equal(L.hasActiveFilters(L.parseListingParams(new URLSearchParams('q=hola&sort=score'))), false, 'búsqueda y orden no son filtros');
});

test('un rango de precio invertido se corrige y el orden sólo viaja si venía en la URL', () => {
  const p = L.parseListingParams(new URLSearchParams('min=50&max=10'));
  assert.deepEqual([p.min, p.max], [10, 50]);
  assert.equal(L.listingHref(L.parseListingParams(new URLSearchParams('q=a'))), '/?q=a#catalogo');
});

test('sin coincidencias: se conserva la consulta y cada chip lleva al listado SIN ese filtro', () => {
  const params = L.parseListingParams(new URLSearchParams('q=auriculares&max=5&brand=sony'));
  const listing = L.buildListing(CATALOG, params, { resolver, now: NOW });
  assert.equal(listing.filtered.length, 0);
  assert.equal(listing.chips.length, 2);
  const byLabel = Object.fromEntries(listing.chips.map((c) => [c.key, c.href]));
  assert.equal(byLabel['price'], '/?q=auriculares&brand=sony#catalogo');
  assert.equal(byLabel['brand:sony'], '/?q=auriculares&max=5#catalogo');
  for (const href of Object.values(byLabel)) assert.ok(href.includes('q=auriculares'), 'la consulta se conserva');
  const relaxed = L.buildListing(CATALOG, L.parseListingParams(new URL('http://x' + byLabel['price'].replace('#catalogo', '')).searchParams), { resolver, now: NOW });
  assert.ok(relaxed.filtered.length > 0, 'quitar el filtro restrictivo recupera resultados');
});

test('tramos de precio: sólo con productos reales (sin tramos vacíos) y sumando todos los resultados', () => {
  const products = [5, 8, 12, 18, 25, 40, 60, 90, 150, 300].map((price, i) => mk('p' + i, { price }));
  const listing = run(products, '');
  assert.ok(listing.price.ranges.length >= 2);
  assert.ok(listing.price.ranges.every((r) => r.count > 0));
  assert.equal(listing.price.ranges.reduce((n, r) => n + r.count, 0), products.length);
  assert.equal(listing.price.min, 5);
  assert.equal(listing.price.max, 300);
});

/* ───────────── API de recuentos ───────────── */

test('/api/catalogo/facets devuelve el mismo total que el listado', async () => {
  writeCatalog(dir, CATALOG.map((p) => ({ ...p })));
  const res = await facetsRoute.GET({ url: new URL('http://localhost/api/catalogo/facets?q=auriculares&max=60&f_conectividad=bluetooth') });
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.total, 1);
  assert.ok(Array.isArray(body.groups));
});

/* ───────────── Interfaz y navegación (comprobación sobre el código fuente) ───────────── */

const read = (p) => fs.readFileSync('d:/AXEL/WEBS/TRADYLOR/tradylor_web/' + p, 'utf8');

test('portada: filtros en la URL, diversidad desactivada con filtros, sin módulos editoriales sobre los resultados y orden de la URL sobre la cookie', () => {
  const index = read('src/pages/index.astro');
  assert.ok(index.includes('activeCategory || filtersActive'), 'la diversidad se omite con filtros');
  assert.ok(index.includes('listingMode ? [] : aboveCatalogSectionsAll'), 'resultados antes que módulos editoriales');
  assert.ok(index.includes('const userSortQuery = listingParams.sort;') && index.includes('userSortQuery || cookieSessionSort'), 'la URL manda sobre la cookie');
  assert.ok(index.includes('<CatalogFilters') && index.includes('Quitar filtro: '));
  assert.ok(index.includes("history.scrollRestoration = 'manual'") && index.includes('back_forward'));
});

test('el panel sólo aparece con búsqueda o categoría y en escritorio no es fijo (se desplaza con la página)', () => {
  const index = read('src/pages/index.astro');
  assert.ok(index.includes('const showFilters = Boolean(queryParam) || listingParams.category.length > 0 || filtersActive;'));
  assert.ok(index.includes('{showFilters && <CatalogFilters'));
  const panel = read('src/components/CatalogFilters.astro');
  const base = panel.slice(panel.indexOf('.cf-panel {'), panel.indexOf('.cf-head {'));
  assert.ok(base.includes('position: static') && !base.includes('sticky') && !base.includes('overflow-y'), 'sin sticky ni scroll propio en escritorio');
});

test('el borde superior del panel coincide con el de las tarjetas (panel y rejilla en la misma fila de la cuadrícula)', () => {
  const index = read('src/pages/index.astro');
  assert.ok(index.includes('.catalog-layout.has-filters .catalog-main { grid-column: 2; grid-row: 2; }'));
  assert.ok(index.includes('.catalog-layout.has-filters .catalog-top { grid-column: 1 / -1; grid-row: 1;'), 'la fila superior ocupa todo el ancho');
  assert.ok(index.includes('class="catalog-top-row"') && index.indexOf('class="cf-chips"') < index.indexOf('class="catalog-sort-bar"'), 'chips y orden en la misma fila');
  const cf = read('src/components/CatalogFilters.astro');
  assert.ok(cf.includes('grid-column: 1;') && cf.includes('grid-row: 2;'));
});

test('migas «INICIO / CATEGORÍA» en la cabecera del listado con enlace a la portada', () => {
  const index = read('src/pages/index.astro');
  assert.ok(index.includes('<a href="/" class="section-crumb-link">Inicio</a>') && index.includes('aria-current="page">Categoría</span>'));
});

test('panel: drawer modal accesible en móvil con retorno del foco al botón «Filtrar», acordeones, buscadores internos y doble tirador', () => {
  const panel = read('src/components/CatalogFilters.astro');
  assert.ok(panel.includes("aria-haspopup=\"dialog\"") && panel.includes("setAttribute('aria-modal', 'true')"));
  assert.ok(panel.includes('(openBtn ?? lastFocus)?.focus()'), 'al cerrar, el foco vuelve al botón que abrió el panel');
  assert.ok(panel.includes("event.key === 'Escape'") && panel.includes("event.key === 'Tab'"), 'Esc cierra y el foco queda atrapado');
  assert.ok(panel.includes('SEARCH_THRESHOLD = 8') && panel.includes('data-cf-search'));
  assert.ok(panel.includes('cf-range-min') && panel.includes('cf-range-max') && panel.includes('＞'));
  const listRule = panel.slice(panel.indexOf('.cf-list {'), panel.indexOf('}', panel.indexOf('.cf-list {')));
  assert.ok(!/max-height|overflow|overscroll/.test(listRule), 'las listas no tienen scroll vertical propio (no atrapan la rueda del ratón)');
  assert.ok(panel.includes('Gangas') && panel.includes('20 %'));
  assert.ok(panel.includes('min-height: 44px'), 'objetivos táctiles de 44 px');
  assert.ok(panel.includes('inert'), 'panel cerrado fuera del orden de tabulación');
});
