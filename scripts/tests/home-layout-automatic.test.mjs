// Portada editable · etapa 5: motor de la modalidad Automática (puro, determinista, sin escribir), su integración opt-in en el resolvedor,
// la API de previsualización con datos reales y el rendimiento con 2.000 productos. Datos aislados, sin red.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-auto-');
delete process.env.HOME_LAYOUT_ENABLED;
const A = await import('../../src/lib/homeLayout/automatic.ts');
const R = await import('../../src/lib/homeLayout/resolve.ts');
const S = await import('../../src/lib/homeLayout/sources.ts');
const preview = await import('../../src/pages/api/admin/home-layout/preview.ts');
const resolveRoute = await import('../../src/pages/api/admin/home-layout/resolve.ts');
const auth = await import('../../src/lib/adminAuth.ts');
const users = await import('../../src/lib/userStore.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const f = (n) => path.join(dir, n);
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);

/* ───────── Fuentes sintéticas ───────── */
const cat = (id, name, parentId = null) => ({ id, name, slug: id, parentId });
const prod = (id, over = {}) => ({ id, title: `Producto ${id}`, price: 10, hasImage: true, inStock: true, network: 'amazon', category: 'Sonido', linkStatus: '', image: `/images/${id}.jpg`, addedAt: null, ...over });
const sources = (products, { retired = [], categories } = {}) => {
  const cats = categories ?? [cat('sonido', 'Sonido'), cat('informatica', 'Informática'), cat('portatiles', 'Portátiles', 'informatica'), cat('vacia', 'Vacía')];
  const networks = new Map();
  for (const p of products) if (p.network) networks.set(p.network, (networks.get(p.network) ?? 0) + 1);
  return {
    products: new Map(products.map((p) => [p.id, p])),
    retiredIds: new Set(retired),
    categories: new Map(cats.map((c) => [c.id, c])),
    networks,
    sections: new Map(),
    sectionList: [],
    status: { products: { status: 'ok', count: products.length }, categories: { status: 'ok', count: cats.length, origin: 'file' }, sections: { status: 'ok', count: 0, invalidEntries: 0 } },
  };
};
const rules = (over = {}) => ({ order: 'precio_asc', limit: 6, ...over });
const snap = (src) => JSON.stringify([[...src.products], [...src.retiredIds], [...src.categories]]);

const base = () => [
  prod('a', { price: 30, category: 'Sonido', categoryId: 'sonido' }),
  prod('b', { price: 10, category: 'Sonido', categoryId: 'sonido' }),
  prod('c', { price: 20, category: 'Sonido', categoryId: 'sonido', network: 'ebay' }),
  prod('d', { price: null, category: 'Sonido', categoryId: 'sonido' }),
  prod('e', { price: 500, category: 'Informática', categoryId: 'informatica', subcategoryId: 'portatiles' }),
  prod('f', { price: 800, category: 'Informática', categoryId: 'informatica' }),
  prod('g', { price: 15, category: 'Informática' }), // sin ids: por nombre
];

test('orden por precio: ascendente y descendente, los sin precio al final, desempate por id y resultado determinista', () => {
  const src = sources(base());
  const asc = A.runAutomatic(rules({ categoryId: 'sonido' }), src);
  assert.equal(asc.status, 'ok');
  assert.deepEqual(asc.ids, ['b', 'c', 'a', 'd']);
  assert.deepEqual(A.runAutomatic(rules({ categoryId: 'sonido', order: 'precio_desc' }), src).ids, ['a', 'c', 'b', 'd']);
  const ties = sources([prod('z', { price: 5 }), prod('m', { price: 5 }), prod('b', { price: 5 })]);
  assert.deepEqual(A.runAutomatic(rules(), ties).ids, ['b', 'm', 'z'], 'empate de precio → por id');
  // El orden de entrada no influye
  const shuffled = sources([...base()].reverse());
  assert.deepEqual(A.runAutomatic(rules({ categoryId: 'sonido' }), shuffled).ids, asc.ids);
  for (let i = 0; i < 5; i++) assert.deepEqual(A.runAutomatic(rules({ categoryId: 'sonido' }), src).ids, asc.ids);
});

test('filtros: categoría principal incluye subcategorías, subcategoría, comercio, sólo con precio y límite', () => {
  const src = sources(base());
  assert.deepEqual(A.runAutomatic(rules({ categoryId: 'informatica' }), src).ids, ['g', 'e', 'f'], 'incluye la subcategoría y los productos sin ids (por nombre)');
  assert.deepEqual(A.runAutomatic(rules({ categoryId: 'informatica', subcategoryId: 'portatiles' }), src).ids, ['e']);
  assert.deepEqual(A.runAutomatic(rules({ merchant: 'ebay' }), src).ids, ['c']);
  assert.deepEqual(A.runAutomatic(rules({ merchant: 'EBAY' }), src).ids, ['c'], 'sin distinguir mayúsculas');
  assert.ok(!A.runAutomatic(rules({ categoryId: 'sonido', onlyWithPrice: true }), src).ids.includes('d'));
  assert.equal(A.runAutomatic(rules({ limit: 2 }), src).ids.length, 2);
  assert.equal(A.runAutomatic(rules({ limit: 999 }), sources(Array.from({ length: 40 }, (_, i) => prod(`p${String(i).padStart(2, '0')}`)))).ids.length, A.MAX_AUTO_ITEMS, 'tope duro');
});

test('retirados e inexistentes: nunca entran; las referencias inválidas de las reglas se explican', () => {
  const src = sources(base(), { retired: ['b'] });
  assert.ok(!A.runAutomatic(rules({ categoryId: 'sonido' }), src).ids.includes('b'));
  const withRetiredInMap = sources([...base(), prod('x', { price: 1 })], { retired: ['x'] });
  assert.ok(!A.runAutomatic(rules(), withRetiredInMap).ids.includes('x'), 'un tombstone que sigue en el mapa tampoco entra');
  assert.ok(!A.runAutomatic(rules(), sources([prod('sin', { title: '' })])).ids.includes('sin'), 'sin título no entra');
  let r = A.runAutomatic(rules({ categoryId: 'no-existe' }), src);
  assert.deepEqual([r.status, r.reason], ['reglas_invalidas', 'categoria_no_existe']);
  r = A.runAutomatic(rules({ categoryId: 'sonido', subcategoryId: 'portatiles' }), src);
  assert.deepEqual([r.status, r.reason], ['reglas_invalidas', 'subcategoria_no_valida'], 'subcategoría de otra categoría');
  r = A.runAutomatic(rules({ subcategoryId: 'sonido' }), src);
  assert.equal(r.reason, 'subcategoria_no_valida', 'una categoría principal no es subcategoría');
});

test('resultados vacíos: cada causa tiene su explicación y sus recuentos', () => {
  let r = A.runAutomatic(rules({ categoryId: 'vacia' }), sources(base()));
  assert.deepEqual([r.status, r.reason], ['vacio', 'categoria_sin_productos']);
  assert.match(r.message, /«Vacía»/);
  r = A.runAutomatic(rules({ categoryId: 'sonido', merchant: 'temu' }), sources(base()));
  assert.equal(r.reason, 'comercio_sin_productos');
  assert.match(r.message, /temu/);
  r = A.runAutomatic(rules({ onlyWithPrice: true }), sources([prod('n1', { price: null }), prod('n2', { price: null })]));
  assert.equal(r.reason, 'sin_productos_con_precio');
  r = A.runAutomatic(rules(), sources([]));
  assert.equal(r.reason, 'catalogo_vacio');
  assert.deepEqual(r.ids, []);
  const stats = A.runAutomatic(rules({ categoryId: 'sonido', merchant: 'ebay', onlyWithPrice: true }), sources(base())).stats;
  assert.deepEqual([stats.catalog, stats.afterCategory, stats.afterMerchant, stats.afterPrice], [7, 4, 1, 1]);
});

test('«más recientes»: sólo se ejecuta con fecha de alta fiable en TODOS los candidatos; nunca se inventa una fecha', () => {
  const dated = sources([prod('a', { addedAt: '2026-11-01T10:00:00.000Z' }), prod('b', { addedAt: '2026-11-05T10:00:00.000Z' }), prod('c', { addedAt: '2026-11-05T10:00:00.000Z' })]);
  const ok = A.runAutomatic(rules({ order: 'recientes' }), dated);
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.ids, ['b', 'c', 'a'], 'más nuevo primero y desempate por id');
  const mixed = sources([prod('a', { addedAt: '2026-11-01T10:00:00.000Z' }), prod('b', { addedAt: null }), prod('c')]);
  const r = A.runAutomatic(rules({ order: 'recientes' }), mixed);
  assert.deepEqual([r.status, r.reason, r.ids], ['no_ejecutable', 'recientes_sin_fecha_fiable', []]);
  assert.deepEqual([r.stats.withDate, r.stats.withoutDate], [1, 2]);
  assert.match(r.message, /no se inventan fechas/);
  // Si el filtro deja sólo productos con fecha, sí se ejecuta
  const partial = sources([prod('a', { addedAt: '2026-11-01T10:00:00.000Z', network: 'ebay' }), prod('b', { addedAt: null })]);
  assert.equal(A.runAutomatic(rules({ order: 'recientes', merchant: 'ebay' }), partial).status, 'ok');
  // La fuente real sólo toma importMeta.importedAt (nada de fechas de modificación)
  const src = code('src/lib/homeLayout/sources.ts');
  assert.match(src, /importMeta\?\.importedAt|importMeta\?: \{ importedAt/);
  assert.doesNotMatch(src.slice(src.indexOf('function reliableAddedAt')).split('\n').slice(0, 9).join('\n'), /updatedAt|lastChecked|verifiedAt|capturedAt/);
});

test('el motor no muta las fuentes ni escribe nada (purezas)', () => {
  const src = sources(base());
  const before = snap(src);
  A.runAutomatic(rules({ categoryId: 'informatica', order: 'precio_desc' }), src);
  assert.equal(snap(src), before);
  const text = code('src/lib/homeLayout/automatic.ts');
  assert.doesNotMatch(text, /node:fs|writeFile|fetch\(|process\.env|Date\.now|new Date\(/, 'sin disco, red, entorno ni reloj (determinista)');
});

test('rendimiento: 2.000 productos, una selección en pocos milisegundos y sin mutar las fuentes', () => {
  const cats = ['sonido', 'informatica', 'portatiles', 'vacia'];
  const big = Array.from({ length: 2000 }, (_, i) => prod(`p${String(i).padStart(4, '0')}`, {
    price: i % 7 === 0 ? null : 5 + ((i * 37) % 900),
    network: ['amazon', 'aliexpress', 'ebay', 'temu'][i % 4],
    category: ['Sonido', 'Informática'][i % 2],
    categoryId: cats[i % 2],
    addedAt: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
  }));
  const src = sources(big);
  const before = snap(src);
  const t0 = performance.now();
  let last;
  for (let i = 0; i < 50; i++) {
    for (const order of ['precio_asc', 'precio_desc', 'recientes']) last = A.runAutomatic(rules({ order, categoryId: 'sonido', onlyWithPrice: true, limit: 12 }), src);
  }
  const perRun = (performance.now() - t0) / 150;
  assert.equal(last.status, 'ok');
  assert.equal(last.ids.length, 12);
  assert.ok(perRun < 25, `cada selección con 2.000 productos tarda ${perRun.toFixed(2)} ms (< 25 ms)`);
  assert.equal(snap(src), before);
  console.log(`  [rendimiento] ${perRun.toFixed(2)} ms por selección con 2.000 productos`);
});

/* ───────── Resolvedor (opt-in) ───────── */
const autoBlock = (over = {}, r = {}) => ({ id: 'au', modality: 'automatica', format: 'carrusel', width: 12, title: 'Auto', card: 'producto', config: { rules: rules(r) }, refs: [], visible: true, ...over });

test('resolvedor: sin la opción conserva la etapa 2 (visible null); con la opción ejecuta la selección y explica los resultados', () => {
  const src = sources(base());
  const legacy = R.resolveBlock(autoBlock(), src);
  assert.equal(legacy.visible, null);
  assert.ok(legacy.issues.some((i) => i.code === 'auto_selection_not_evaluated'));
  assert.equal(legacy.selection, undefined);

  const ok = R.resolveBlock(autoBlock({}, { categoryId: 'sonido' }), src, { runAutomatic: true });
  assert.equal(ok.visible, true);
  assert.deepEqual([ok.items, ok.valid], [4, 3], 'el producto sin precio no cuenta como presentable');
  assert.deepEqual(ok.selection.ids, ['b', 'c', 'a', 'd']);

  const grid = R.resolveBlock(autoBlock({ format: 'cuadricula2x2' }, { categoryId: 'sonido' }), src, { runAutomatic: true });
  assert.equal(grid.visible, false, 'la 2×2 necesita 4 presentables y hay 3');
  assert.ok(grid.issues.some((i) => i.code === 'below_format_minimum'));

  const empty = R.resolveBlock(autoBlock({}, { categoryId: 'vacia' }), src, { runAutomatic: true });
  assert.equal(empty.visible, false);
  const w = empty.issues.find((i) => i.code === 'auto_selection_empty');
  assert.equal(w.severity, 'warning');
  assert.match(w.message, /Vacía/);

  const recent = R.resolveBlock(autoBlock({}, { order: 'recientes' }), src, { runAutomatic: true });
  assert.equal(recent.visible, null, 'sin fecha fiable la visibilidad sigue siendo desconocida');
  assert.ok(recent.issues.some((i) => i.code === 'auto_selection_not_executable'));

  const bad = R.resolveBlock(autoBlock({}, { categoryId: 'ya-no-existe' }), src, { runAutomatic: true });
  assert.equal(bad.visible, false);
  assert.equal(bad.issues.filter((i) => i.code === 'category_not_found').length, 1, 'el error de la regla no se duplica');

  const hidden = R.resolveBlock(autoBlock({ visible: false }, { categoryId: 'sonido' }), src, { runAutomatic: true });
  assert.equal(hidden.visible, false);
});

/* ───────── API ───────── */
let adminC; let common;
const URL_ = 'http://localhost/api/admin/home-layout/';
const getPrev = (qs = '', cookie) => preview.GET({ request: new Request(`${URL_}preview${qs}`, { headers: cookie ? { Cookie: cookie } : {} }) });
const getRes = (qs = '', cookie = adminC) => resolveRoute.GET({ request: new Request(`${URL_}resolve${qs}`, { headers: { Cookie: cookie } }) });
const json = (r) => r.json();
const seedFiles = () => {
  fs.writeFileSync(f('products.json'), JSON.stringify([
    { id: 'p1', slug: 'p1', title: 'Auricular uno', price: 30, category: 'Sonido', network: 'amazon', merchant: 'Amazon', currency: 'EUR', inStock: true, image: '/images/products/p1.jpg', affiliateUrl: 'https://afiliado.example/secreto', sourceId: 'P1', extra: {} },
    { id: 'p2', slug: 'p2', title: 'Auricular dos', price: 10, category: 'Sonido', network: 'amazon', merchant: 'Amazon', currency: 'EUR', inStock: true, image: 'javascript:alert(1)', affiliateUrl: 'https://afiliado.example/secreto', sourceId: 'P2', commissionRate: 7, extra: {} },
    { id: 'p3', slug: 'p3', title: 'Portátil', price: 600, category: 'Informática', network: 'amazon', merchant: 'Amazon', currency: 'EUR', inStock: true, image: 'https://img.example/p3.jpg', affiliateUrl: 'https://afiliado.example/secreto', sourceId: 'P3', extra: { importMeta: { channel: 'json', importedAt: '2026-11-03T10:00:00.000Z' } } },
  ]));
  fs.writeFileSync(f('categories.json'), JSON.stringify([{ id: 'sonido', name: 'Sonido', slug: 'sonido', icon: '🎧', keywords: [] }, { id: 'informatica', name: 'Informática', slug: 'informatica', icon: '💻', keywords: [] }]));
  fs.writeFileSync(f('sections.json'), JSON.stringify([{ id: 's1', title: 'S1', productIds: ['p1', 'p3'], published: true, order: 0, position: 'below', speed: 'normal', createdAt: '2026-11-01' }]));
  fs.writeFileSync(f('deleted-product-ids.json'), '[]');
};
seedFiles();
const OTHER = ['products.json', 'deleted-product-ids.json', 'categories.json', 'sections.json'];
const snapOther = () => Object.fromEntries(OTHER.map((n) => [n, sha(f(n))]));

test('API preview: permisos, parámetros estrictos y datos públicos reales (sin enlaces de afiliado ni comisiones)', async () => {
  adminC = await adminCookie();
  const master = auth.authenticateUser('tester', 'Test-pass-123');
  users.createUser({ username: 'comun5', password: 'Clave-comun-123', name: 'Común', role: 'user' }, users.toPublicUser(users.findUserById(master.id)));
  common = auth.createAdminSession(auth.authenticateUser('comun5', 'Clave-comun-123')).split(';')[0];
  for (const c of [undefined, 'tradylor_admin_session=falsa.1.x', common]) assert.equal((await getPrev('', c)).status, 401);
  const before = snapOther();
  const r = await getPrev('', adminC);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  for (const qs of ['?x=1', '?source=draft&source=published', '?source=otro', '?version=0', '?version=abc', '?source=draft&version=1', '?auto=no-json']) assert.equal((await getPrev(qs, adminC)).status, 400, qs);
  assert.equal((await getPrev('?version=9', adminC)).status, 404);
  assert.equal((await getPrev('', adminC)).status, 200);
  assert.deepEqual(snapOther(), before);
  assert.equal(fs.existsSync(f('home-layout.json')), false, 'no crea archivos');
});

test('API preview ?auto=: ejecuta una regla sin guardar, valida la regla y expone sólo campos públicos', async () => {
  const q = (o) => `?auto=${encodeURIComponent(JSON.stringify(o))}`;
  const r = await getPrev(q({ format: 'carrusel', rules: { categoryId: 'sonido', order: 'precio_asc', limit: 6 } }), adminC);
  const b = await json(r);
  assert.equal(r.status, 200);
  assert.deepEqual(b.auto.items.map((i) => i.id), ['p2', 'p1']);
  assert.equal(b.auto.items[0].image, null, 'una imagen no segura (javascript:) no se expone');
  assert.equal(b.auto.items[1].image, '/images/products/p1.jpg');
  const text = JSON.stringify(b);
  assert.doesNotMatch(text, /afiliado\.example|secreto|commission|affiliateUrl|sourceId/i);
  const none = await json(await getPrev(q({ rules: { categoryId: 'sonido', order: 'recientes', limit: 4 } }), adminC));
  assert.equal(none.auto.status, 'no_ejecutable');
  const dated = await json(await getPrev(q({ rules: { categoryId: 'informatica', order: 'recientes', limit: 4 } }), adminC));
  assert.equal(dated.auto.status, 'ok', 'p3 tiene fecha de alta fiable (importMeta.importedAt)');
  for (const bad of [{ rules: { order: 'descuento', limit: 4 } }, { rules: { order: 'precio_asc', limit: 999 } }, { rules: { order: 'precio_asc', limit: 4, popularidad: 1 } }, {}]) {
    assert.equal((await getPrev(q(bad), adminC)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await getPrev(`?auto=${'x'.repeat(2100)}`, adminC)).status, 400);
});

test('API resolve ?auto=1 es opt-in: sin él, igual que la etapa 2; con él, los bloques automáticos traen su selección', async () => {
  const S2 = await import('../../src/lib/homeLayout/store.ts');
  const blocks = [autoBlock({ id: 'au1' }, { categoryId: 'sonido' })];
  assert.equal(S2.writeHomeLayout({ schemaVersion: 1, activation: { enabled: false }, draft: { blocks, updatedAt: '2026-11-10T10:00:00.000Z' }, published: null, versions: [] }).ok, true);
  const a = await json(await getRes());
  assert.equal(a.blocks[0].visible, null);
  assert.equal(a.blocks[0].selection, undefined);
  const b = await json(await getRes('?auto=1'));
  assert.equal(b.blocks[0].visible, true);
  assert.deepEqual(b.blocks[0].selection.ids, ['p2', 'p1']);
  assert.equal((await getRes('?auto=2')).status, 400);
  assert.equal((await getRes('?auto=1&auto=1')).status, 400);
  const prev = await json(await getPrev('', adminC));
  assert.deepEqual(prev.blocks.au1.items.map((i) => i.id), ['p2', 'p1']);
  assert.equal(S2.resolveHomeMode(), 'legacy');
});

test('API preview con bloques manuales, de sección y de categoría; versiones publicadas', async () => {
  const S2 = await import('../../src/lib/homeLayout/store.ts');
  const ref = (kind, id) => ({ kind, id });
  const blocks = [
    { id: 'm1', modality: 'manual', format: 'carrusel', width: 12, title: 'M', card: 'producto', config: {}, refs: [ref('product', 'p3'), ref('product', 'ya-no-existe')], visible: true },
    { id: 'm2', modality: 'manual', format: 'carrusel', width: 12, title: 'C', card: 'categoria', config: {}, refs: [ref('category', 'sonido')], visible: true },
    { id: 's1', modality: 'seccion', format: 'carrusel', width: 12, title: 'S', card: 'producto', config: {}, refs: [ref('section', 's1')], visible: true },
    { id: 'e1', modality: 'editorial', format: 'banner', width: 6, title: 'E', card: 'promocion', config: { headline: 'Hola' }, refs: [], visible: true },
  ];
  const doc = S2.readHomeLayout().doc;
  assert.equal(S2.writeHomeLayout({ ...doc, draft: { blocks, updatedAt: '2026-11-10T11:00:00.000Z' }, published: { version: 4, publishedAt: '2026-11-10T11:30:00.000Z', blocks } }).ok, true);
  const b = (await json(await getPrev('', adminC))).blocks;
  assert.equal(b.m1.items[0].title, 'Portátil');
  assert.equal(b.m1.items[1].missing, true);
  assert.deepEqual(b.m2.items.map((i) => [i.kind, i.title]), [['category', 'Sonido']]);
  assert.deepEqual(b.s1.items.map((i) => i.id), ['p1', 'p3']);
  assert.deepEqual(b.e1.items, []);
  assert.deepEqual(Object.keys((await json(await getPrev('?source=published', adminC))).blocks), ['m1', 'm2', 's1', 'e1']);
  assert.equal((await json(await getPrev('?version=4', adminC))).source, 'version:4');
  fs.rmSync(f('home-layout.json'), { force: true });
});

const postPrev = (body, { cookie = adminC, headers = {}, raw } = {}) => preview.POST({ request: new Request(`${URL_}preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? JSON.stringify(body) }) });

test('POST preview (bloques SIN GUARDAR): permisos, CSRF, límites y resolución parcial de bloques incompletos', async () => {
  seedFiles();
  const ref = (kind, id) => ({ kind, id });
  const blocks = [
    { id: 'ok1', modality: 'manual', format: 'carrusel', width: 12, title: 'M', card: 'producto', config: {}, refs: [ref('product', 'p1')], visible: true },
    { id: 'roto', modality: 'manual', format: 'carrusel', width: 12, title: 'Vacío', card: 'producto', config: {}, refs: [], visible: true },
    { id: 'au', modality: 'automatica', format: 'carrusel', width: 12, title: 'A', card: 'producto', config: { rules: { categoryId: 'sonido', order: 'precio_asc', limit: 4 } }, refs: [], visible: true },
  ];
  for (const c of [null, 'tradylor_admin_session=falsa.1.x', common]) assert.equal((await postPrev({ blocks }, { cookie: c })).status, 401);
  assert.equal((await postPrev({ blocks }, { headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await postPrev({ blocks }, { headers: { 'X-Home-Layout-Editor': '' } })).status, 403);
  assert.equal((await postPrev({ blocks }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await postPrev(null, { raw: '{ no json' })).status, 400);
  assert.equal((await postPrev(null, { raw: JSON.stringify({ blocks: [], relleno: 'x'.repeat(262144) }) })).status, 413);
  for (const bad of [{}, { blocks: 'x' }, { blocks, extra: 1 }, { blocks: Array.from({ length: 61 }, (_, i) => ({ ...blocks[0], id: 'b' + i })) }]) assert.equal((await postPrev(bad)).status, 400);
  const before = snapOther();
  const r = await postPrev({ blocks });
  const b = await json(r);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(b.blocks).sort(), ['au', 'ok1']);
  assert.ok(b.invalid.roto.length >= 1, 'el bloque incompleto se informa y no impide los demás');
  assert.equal(b.resolved.blocks.find((x) => x.id === 'au').visible, true);
  assert.equal(b.blocks.ok1.items[0].title, 'Auricular uno');
  assert.doesNotMatch(JSON.stringify(b), /afiliado.example|secreto|commission|affiliateUrl/i);
  assert.deepEqual(snapOther(), before);
  assert.equal(fs.existsSync(f('home-layout.json')), false, 'no escribe nada');
  assert.equal((await preview.ALL({ request: new Request(`${URL_}preview`, { method: 'DELETE', headers: { Cookie: adminC } }) })).headers.get('Allow'), 'GET, POST');
});

test('GET preview ?catalog=: búsqueda por título sólo con imágenes seguras, límites y parámetros estrictos', async () => {
  const ok = await json(await getPrev('?catalog=auricular', adminC));
  assert.deepEqual(ok.items.map((i) => i.id), ['p1'], 'p2 tiene una imagen no segura y se excluye');
  assert.equal((await json(await getPrev('?catalog=', adminC))).items.length, 2, 'sin texto: los que tienen imagen segura');
  assert.equal((await getPrev('?catalog=a&limit=0', adminC)).status, 400);
  assert.equal((await getPrev('?catalog=a&limit=25', adminC)).status, 400);
  assert.equal((await getPrev('?limit=5', adminC)).status, 400);
  assert.equal((await getPrev(`?catalog=${'x'.repeat(81)}`, adminC)).status, 400);
  assert.equal((await getPrev('?catalog=a&source=draft', adminC)).status, 400);
});

test('estático: el motor y la previsualización son de sólo lectura y no tocan la portada pública', () => {
  for (const p of ['src/lib/homeLayout/automatic.ts', 'src/pages/api/admin/home-layout/preview.ts']) {
    assert.doesNotMatch(code(p), /writeFileSync|writeHomeLayout|writeStories|fs\.rename|unlinkSync|fetch\(/, p);
  }
  const idx = code('src/pages/index.astro'); assert.match(idx, /lib\/homeLayout\/public/, 'usa el plan público'); assert.doesNotMatch(idx, /writeHomeLayout|writeStories|writeActivation|readHomeLayout|readStories|readActivation|prepareDraftSave|homeLayout\/(draft|publish|store|storiesStore|activationStore|activation)'|upload-image/, 'sólo el plan público de solo lectura');
  assert.doesNotMatch(code('src/pages/index.astro'), /runAutomatic|automatic'/, 'index.astro no ejecuta el motor: lo hace public.ts');
  assert.doesNotMatch(code('src/layouts/Layout.astro'), /homeLayout/);
  assert.equal(typeof preview.PUT, 'undefined');
  const post = code('src/pages/api/admin/home-layout/preview.ts');
  assert.match(post, /sameOrigin/);
  assert.match(post, /x-home-layout-editor/);
});

test('rendimiento de extremo a extremo: la API de previsualización con 2.000 fichas reales en products.json', async () => {
  const big = Array.from({ length: 2000 }, (_, i) => ({ id: `q${String(i).padStart(4, '0')}`, slug: `q${i}`, title: `Producto ${i}`, price: i % 9 === 0 ? 0 : 5 + ((i * 53) % 700), category: i % 2 ? 'Sonido' : 'Informática', network: ['amazon', 'ebay', 'aliexpress', 'temu'][i % 4], merchant: 'X', currency: 'EUR', inStock: true, image: `/images/products/q${i}.jpg`, affiliateUrl: 'https://afiliado.example/x', sourceId: `Q${i}`, extra: {} }));
  fs.writeFileSync(f('products.json'), JSON.stringify(big));
  const before = sha(f('products.json'));
  const q = encodeURIComponent(JSON.stringify({ format: 'carrusel', rules: { categoryId: 'sonido', order: 'precio_desc', limit: 12, onlyWithPrice: true } }));
  const times = [];
  let body;
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    const r = await preview.GET({ request: new Request(`${URL_}preview?auto=${q}`, { headers: { Cookie: adminC } }) });
    body = await r.json();
    times.push(performance.now() - t0);
    assert.equal(r.status, 200);
  }
  assert.equal(body.auto.status, 'ok');
  assert.equal(body.auto.items.length, 12);
  const prices = body.auto.items.map((i) => i.price);
  assert.deepEqual([...prices].sort((a, b) => b - a), prices, 'orden descendente');
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`  [rendimiento] API preview con 2.000 fichas: ${avg.toFixed(1)} ms de media (máx. ${Math.max(...times).toFixed(1)} ms)`);
  assert.ok(avg < 400, `media ${avg.toFixed(1)} ms (< 400 ms)`);
  assert.equal(sha(f('products.json')), before, 'los productos originales no se modifican');
});
