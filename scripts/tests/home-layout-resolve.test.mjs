// Portada editable · etapa 2: resolución de referencias de SOLO LECTURA (catálogo, categorías, comercios, secciones), propuesta en memoria desde
// «Crear sección», endpoints de lectura, rendimiento con 2.000 productos y garantía de que ninguna lectura escribe. Datos aislados, sin red.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie, apiRequest, jsonOf } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-resolve-');
delete process.env.HOME_LAYOUT_ENABLED;
const Sources = await import('../../src/lib/homeLayout/sources.ts');
const R = await import('../../src/lib/homeLayout/resolve.ts');
const P = await import('../../src/lib/homeLayout/sectionsProposal.ts');
const V = await import('../../src/lib/homeLayout/validate.ts');
const catalog = await import('../../src/lib/catalog.ts');
const resolveRoute = await import('../../src/pages/api/admin/home-layout/resolve.ts');
const optionsRoute = await import('../../src/pages/api/admin/home-layout/options.ts');
const auth = await import('../../src/lib/adminAuth.ts');
const users = await import('../../src/lib/userStore.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const f = (name) => path.join(dir, name);
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const DATA_FILES = ['products.json', 'deleted-product-ids.json', 'categories.json', 'sections.json', 'home-layout.json', 'home-layout.json.bak'];
const snapshotFiles = () => Object.fromEntries(DATA_FILES.map((n) => [n, sha(f(n))]));
const listing = () => fs.readdirSync(dir).sort().join('|');

/* ───────── Fixtures ───────── */
const prod = (id, over = {}) => ({ id, slug: id, title: `Producto ${id}`, price: 20, category: 'Sonido', network: 'amazon', merchant: 'Amazon', currency: 'EUR', inStock: true, image: `/img/${id}.jpg`, affiliateUrl: `https://www.amazon.es/dp/${id.toUpperCase()}?tag=secreto-21`, sourceId: id.toUpperCase(), asin: id.toUpperCase(), extra: { comision: 'SECRETA-9%' }, ...over });
const writeProducts = (list) => { fs.writeFileSync(f('products.json'), JSON.stringify(list)); catalog.invalidateCatalogCache(); };
const section = (id, productIds, over = {}) => ({ id, title: `Sección ${id}`, description: '', productIds, published: true, order: 0, position: 'below', speed: 'normal', createdAt: '2026-11-01T00:00:00.000Z', ...over });
const writeSections = (list) => fs.writeFileSync(f('sections.json'), JSON.stringify(list, null, 2));
const CATS = [
  { id: 'sonido', name: 'Sonido', slug: 'sonido', icon: '🎧', keywords: [] },
  { id: 'informatica', name: 'Informática', slug: 'informatica', icon: '💻', keywords: [] },
  { id: 'portatiles', name: 'Portátiles', slug: 'portatiles', icon: '💻', keywords: [], parentId: 'informatica' },
  { id: 'calefaccion', name: 'Calefacción', slug: 'calefaccion', icon: '🔥', keywords: [], parentId: 'hogar' },
  { id: 'hogar', name: 'Hogar', slug: 'hogar', icon: '🏠', keywords: [] },
];
const writeCats = (list) => fs.writeFileSync(f('categories.json'), JSON.stringify(list, null, 2));

/** Instantánea sintética (funciones puras): sin archivos. */
function mk({ products = [], retired = [], categories = CATS, sections = [] } = {}) {
  const pm = new Map(products.map((p) => [p.id, { id: p.id, title: 'title' in p ? p.title : `P ${p.id}`, price: 'price' in p ? p.price : 10, hasImage: 'hasImage' in p ? p.hasImage : true, inStock: 'inStock' in p ? p.inStock : true, network: p.network ?? 'amazon', category: p.category ?? 'Sonido', linkStatus: p.linkStatus ?? '' }]));
  const networks = new Map([['amazon', 0], ['aliexpress', 0], ['ebay', 0], ['temu', 0]]);
  for (const p of pm.values()) networks.set(p.network, (networks.get(p.network) ?? 0) + 1);
  const sl = sections.map((s) => ({ order: 0, position: 'below', speed: 'normal', published: true, title: s.id, ...s }));
  return { products: pm, retiredIds: new Set(retired), categories: new Map(categories.map((c) => [c.id, { parentId: null, slug: c.id, ...c }])), networks, sections: new Map(sl.map((s) => [s.id, s])), sectionList: sl, status: { products: { status: 'ok', count: pm.size }, categories: { status: 'ok', count: categories.length, origin: 'file' }, sections: { status: 'ok', count: sl.length, invalidEntries: 0 } } };
}
const B = (over) => ({ id: 'b1', modality: 'manual', format: 'carrusel', width: 12, title: 'T', card: 'producto', config: {}, refs: [{ kind: 'product', id: 'p1' }], visible: true, ...over });
const blk = (over) => { const r = V.validateBlock(B(over)); assert.ok(r.ok, JSON.stringify(r.errors)); return r.value; };
const codes = (rb) => rb.issues.map((i) => i.code);
const sev = (rb, code) => rb.issues.find((i) => i.code === code)?.severity;

/* ───────── Productos ───────── */
test('productos: existentes, inexistentes y retirados (tombstone) se distinguen con su gravedad', () => {
  const src = mk({ products: [{ id: 'p1' }], retired: ['p3'] });
  const rb = R.resolveBlock(blk({ refs: [{ kind: 'product', id: 'p1' }, { kind: 'product', id: 'p2' }, { kind: 'product', id: 'p3' }] }), src);
  assert.deepEqual(rb.refs.map((r) => r.status), ['ok', 'missing', 'retired']);
  assert.equal(sev(rb, 'product_not_found'), 'error');
  assert.equal(sev(rb, 'product_retired'), 'error');
  assert.equal(rb.valid, 1);
  assert.equal(rb.visible, true, 'con un elemento presentable el carrusel se muestra aunque otras referencias estén rotas');
});

test('productos sin información: sin precio o sin título no son presentables; sin imagen sólo avisa; sin stock es información y nunca oculta', () => {
  const src = mk({ products: [{ id: 'p1', price: null }, { id: 'p2', title: '' }, { id: 'p3', hasImage: false }, { id: 'p4', inStock: false }, { id: 'p5', inStock: null }, { id: 'p6', linkStatus: 'broken' }] });
  const rb = R.resolveBlock(blk({ refs: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id) => ({ kind: 'product', id })) }), src);
  assert.equal(sev(rb, 'product_without_price'), 'warning');
  assert.equal(sev(rb, 'product_without_title'), 'warning');
  assert.equal(sev(rb, 'product_without_image'), 'warning');
  assert.equal(sev(rb, 'product_out_of_stock'), 'info');
  assert.equal(sev(rb, 'product_link_inactive'), 'warning');
  assert.equal(rb.valid, 4, 'presentables: p3, p4, p5, p6 (sin precio/título no cuentan)');
  assert.equal(rb.visible, true);
  // sólo sin stock → sigue visible
  const only = R.resolveBlock(blk({ refs: [{ kind: 'product', id: 'p4' }] }), src);
  assert.equal(only.visible, true, 'la falta de stock no oculta');
  // sin dato de stock tampoco genera ningún aviso
  assert.deepEqual(codes(R.resolveBlock(blk({ refs: [{ kind: 'product', id: 'p5' }] }), src)), []);
});

/* ───────── Requisitos mínimos de formato y visible ───────── */
test('visible combina validez y mínimo del formato: banner 1, carrusel 1, cuadrícula 2×2 → 4; oculto por el administrador; sin contenido', () => {
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const src = mk({ products: ids.map((id) => ({ id })) });
  const refs = (list) => list.map((id) => ({ kind: 'product', id }));
  assert.equal(R.FORMAT_MIN_ITEMS.cuadricula2x2, 4);
  const grid4 = R.resolveBlock(blk({ format: 'cuadricula2x2', refs: refs(ids) }), src);
  assert.equal(grid4.visible, true);
  const grid3 = R.resolveBlock(blk({ format: 'cuadricula2x2', refs: refs(['p1', 'p2', 'p3']) }), src);
  assert.equal(grid3.visible, false);
  assert.equal(sev(grid3, 'below_format_minimum'), 'warning');
  const gridBroken = R.resolveBlock(blk({ format: 'cuadricula2x2', refs: refs(['p1', 'p2', 'p3', 'nope']) }), src);
  assert.equal(gridBroken.visible, false, 'una referencia rota deja la cuadrícula por debajo del mínimo');
  assert.equal(R.resolveBlock(blk({ format: 'banner', refs: refs(['p1']) }), src).visible, true);
  assert.equal(R.resolveBlock(blk({ refs: refs(['nope']) }), src).visible, false);
  assert.equal(sev(R.resolveBlock(blk({ refs: refs(['nope']) }), src), 'block_without_valid_content'), 'error');
  const hidden = R.resolveBlock(blk({ visible: false, refs: refs(['p1']) }), src);
  assert.equal(hidden.visible, false);
  assert.equal(sev(hidden, 'block_hidden_by_admin'), 'info');
});

/* ───────── Categorías, subcategorías y comercios ───────── */
test('categorías: existente, inexistente y por slug; tarjeta de categoría en modalidad manual', () => {
  const src = mk();
  const rb = R.resolveBlock(blk({ card: 'categoria', refs: [{ kind: 'category', id: 'sonido' }, { kind: 'category', id: 'no-existe' }] }), src);
  assert.deepEqual(rb.refs.map((r) => r.status), ['ok', 'missing']);
  assert.equal(sev(rb, 'category_not_found'), 'error');
  assert.equal(rb.refs[0].label, 'Sonido');
  assert.equal(R.resolveBlock(blk({ card: 'categoria', refs: [{ kind: 'category', id: 'Portatiles' }] }), mk({ categories: [{ id: 'x1', name: 'Portátiles', slug: 'portatiles' }] })).refs[0].status, 'ok', 'por slug');
});

test('automática: valida categoría, subcategoría (padre correcto) y comercio sin ejecutar la selección; visible=null si todo es válido', () => {
  const src = mk({ products: [{ id: 'p1', network: 'ebay' }] });
  const auto = (rules) => blk({ modality: 'automatica', format: 'carrusel', refs: [], config: { rules: { order: 'recientes', limit: 6, ...rules } } });
  const ok = R.resolveBlock(auto({ categoryId: 'informatica', subcategoryId: 'portatiles', merchant: 'ebay' }), src);
  assert.equal(ok.visible, null);
  assert.equal(sev(ok, 'auto_selection_not_evaluated'), 'info');
  assert.equal(ok.issues.filter((i) => i.severity === 'error').length, 0);
  const noCat = R.resolveBlock(auto({ categoryId: 'fantasma' }), src);
  assert.equal(noCat.visible, false);
  assert.equal(sev(noCat, 'category_not_found'), 'error');
  const mismatch = R.resolveBlock(auto({ categoryId: 'sonido', subcategoryId: 'portatiles' }), src);
  assert.equal(sev(mismatch, 'subcategory_parent_mismatch'), 'error');
  assert.equal(mismatch.visible, false);
  assert.equal(sev(R.resolveBlock(auto({ categoryId: 'informatica', subcategoryId: 'sonido' }), src), 'subcategory_not_a_subcategory'), 'error');
  assert.equal(sev(R.resolveBlock(auto({ categoryId: 'informatica', subcategoryId: 'nada' }), src), 'subcategory_not_found'), 'error');
  const noMerchant = R.resolveBlock(auto({ merchant: 'temu' }), src);
  assert.equal(sev(noMerchant, 'merchant_without_products'), 'warning');
  assert.equal(noMerchant.visible, null, 'un comercio sin productos sólo avisa');
});

/* ───────── Secciones ───────── */
test('secciones: eliminada, no publicada, vacía, con productos rotos y correcta', () => {
  const src = mk({
    products: [{ id: 'a' }, { id: 'b' }, { id: 'c', price: null }],
    sections: [section('ok', ['a', 'b']), section('off', ['a'], { published: false }), section('vacia', ['x', 'y']), section('sinids', []), section('parcial', ['a', 'zz', 'c'])],
  });
  const one = (id) => R.resolveBlock(blk({ modality: 'seccion', refs: [{ kind: 'section', id }] }), src);
  assert.equal(one('ok').visible, true);
  assert.equal(one('ok').issues.length, 0);
  assert.equal(sev(one('borrada'), 'section_not_found'), 'error');
  assert.equal(one('borrada').visible, false);
  assert.equal(sev(one('off'), 'section_unpublished'), 'error');
  assert.equal(one('off').visible, false);
  assert.equal(sev(one('vacia'), 'section_empty'), 'error');
  assert.equal(sev(one('sinids'), 'section_empty'), 'error');
  const parcial = one('parcial');
  assert.equal(parcial.visible, true);
  assert.equal(sev(parcial, 'section_products_missing'), 'warning');
  assert.equal(sev(parcial, 'section_products_incomplete'), 'warning');
  assert.equal(parcial.valid, 1);
  // una sección cuyos productos existen pero ninguno es presentable no se mostraría
  const unpresentable = R.resolveBlock(blk({ modality: 'seccion', refs: [{ kind: 'section', id: 'p' }] }), mk({ products: [{ id: 'c', price: null }], sections: [section('p', ['c'])] }));
  assert.equal(unpresentable.visible, false);
});

test('editorial: enlaces a productos, categorías y secciones inexistentes o no publicadas son errores; rutas y URLs no necesitan resolución', () => {
  const src = mk({ products: [{ id: 'p1' }], sections: [section('s1', ['p1']), section('s2', ['p1'], { published: false })] });
  const ed = (link) => blk({ modality: 'editorial', format: 'banner', card: 'promocion', refs: [], config: { headline: 'Campaña', buttonLabel: 'Ver', ...(link ? { link } : {}) } });
  assert.equal(R.resolveBlock(ed(null), src).visible, true);
  assert.equal(R.resolveBlock(ed({ type: 'path', target: '/?category=sonido' }), src).visible, true);
  assert.equal(R.resolveBlock(ed({ type: 'url', target: 'https://example.com/x' }), src).visible, true);
  assert.equal(R.resolveBlock(ed({ type: 'product', target: 'p1' }), src).visible, true);
  for (const link of [{ type: 'product', target: 'fantasma' }, { type: 'category', target: 'fantasma' }, { type: 'section', target: 'fantasma' }, { type: 'section', target: 's2' }]) {
    const rb = R.resolveBlock(ed(link), src);
    assert.equal(rb.visible, false, JSON.stringify(link));
    assert.ok(rb.issues.some((i) => i.severity === 'error' && i.code.startsWith('editorial_link_target')), JSON.stringify(link));
  }
});

test('promociones: aún sin fuente de datos → error explícito (no se inventa ninguna)', () => {
  const rb = R.resolveBlock(blk({ card: 'promocion', refs: [{ kind: 'promotion', id: 'black-friday' }] }), mk());
  assert.equal(sev(rb, 'promotion_source_unavailable'), 'error');
  assert.equal(rb.visible, false);
});

test('resolveBlocks totaliza visibles, ocultos, desconocidos y gravedades', () => {
  const src = mk({ products: [{ id: 'p1' }] });
  const { totals, blocks } = R.resolveBlocks([blk({ id: 'a' }), blk({ id: 'b', refs: [{ kind: 'product', id: 'no' }] }), blk({ id: 'c', modality: 'automatica', refs: [], config: { rules: { order: 'recientes', limit: 3 } } })], src);
  assert.deepEqual({ b: totals.blocks, v: totals.visible, h: totals.hidden, u: totals.unknown }, { b: 3, v: 1, h: 1, u: 1 });
  assert.ok(totals.errors >= 2 && totals.info >= 1);
  assert.equal(blocks.length, 3);
});

/* ───────── Fuentes reales de solo lectura ───────── */
test('fuentes reales: leen catálogo, tombstones, categorías y secciones SIN escribir ni crear archivos', () => {
  writeProducts([prod('p1'), prod('p2', { network: 'ebay', merchant: 'eBay' }), prod('p3')]);
  fs.writeFileSync(f('deleted-product-ids.json'), JSON.stringify(['p3']));
  catalog.invalidateCatalogCache();
  writeCats(CATS);
  writeSections([section('s1', ['p1', 'p2', 'borrado'])]);
  const before = snapshotFiles();
  const names = listing();
  const src = Sources.loadSources();
  assert.deepEqual([...src.products.keys()].sort(), ['p1', 'p2'], 'p3 está retirado (tombstone)');
  assert.ok(src.retiredIds.has('p3'));
  assert.equal(src.networks.get('amazon'), 1);
  assert.equal(src.networks.get('ebay'), 1);
  assert.equal(src.networks.get('temu'), 0, 'plataforma conocida sin productos');
  assert.equal(src.categories.size, 5);
  assert.equal(src.categories.get('portatiles').parentId, 'informatica');
  assert.deepEqual(src.status.sections, { status: 'ok', count: 1, invalidEntries: 0 });
  const rb = R.resolveBlock(blk({ refs: [{ kind: 'product', id: 'p3' }] }), src);
  assert.equal(sev(rb, 'product_retired'), 'error');
  assert.deepEqual(snapshotFiles(), before, 'ningún archivo de datos cambió');
  assert.equal(listing(), names, 'no se creó ningún archivo');
});

test('categorías: si categories.json falta se usan las base EN MEMORIA y NO se crea el archivo (getCategories sí lo haría)', () => {
  fs.rmSync(f('categories.json'), { force: true });
  const names = listing();
  const src = Sources.loadSources();
  assert.equal(src.status.categories.origin, 'defaults');
  assert.equal(src.status.categories.status, 'missing');
  assert.ok(src.categories.size > 0);
  assert.equal(fs.existsSync(f('categories.json')), false);
  assert.equal(listing(), names);
});

test('categorías: esquema legado (array de nombres) y archivo corrupto se interpretan sin reescribirlos', () => {
  fs.writeFileSync(f('categories.json'), JSON.stringify(['Sonido', 'Informática']));
  let h = sha(f('categories.json'));
  let src = Sources.loadSources();
  assert.deepEqual([...src.categories.keys()].sort(), ['informatica', 'sonido']);
  assert.equal(sha(f('categories.json')), h, 'el archivo legado no se migra');
  fs.writeFileSync(f('categories.json'), '{ roto');
  h = sha(f('categories.json'));
  src = Sources.loadSources();
  assert.equal(src.status.categories.status, 'corrupt');
  assert.ok(src.categories.size > 0, 'usa las base en memoria');
  assert.equal(sha(f('categories.json')), h, 'el archivo corrupto se conserva');
  writeCats(CATS);
});

test('secciones: archivo ausente o corrupto se informa como estado y no se toca', () => {
  fs.rmSync(f('sections.json'), { force: true });
  assert.equal(Sources.loadSources().status.sections.status, 'missing');
  assert.equal(fs.existsSync(f('sections.json')), false);
  fs.writeFileSync(f('sections.json'), '[ {');
  const h = sha(f('sections.json'));
  const s = Sources.loadSources();
  assert.equal(s.status.sections.status, 'corrupt');
  assert.equal(s.sectionList.length, 0);
  assert.equal(sha(f('sections.json')), h);
  fs.writeFileSync(f('sections.json'), JSON.stringify([{ id: 'x' }, section('buena', ['p1']), 5]));
  const t = Sources.loadSources();
  assert.deepEqual(t.status.sections, { status: 'ok', count: 1, invalidEntries: 2 });
});

/* ───────── Propuesta desde las secciones (en memoria) ───────── */
/** Réplica de la lógica de `index.astro` para comparar. */
function indexLogic(sections, products) {
  const pub = sections.filter((s) => s.published).sort((a, b) => a.order - b.order).map((s) => ({ ...s, position: s.position === 'above' ? 'above' : 'below', speed: s.speed || 'normal', products: s.productIds.map((id) => products.find((p) => p.id === id)).filter(Boolean) })).filter((s) => s.products.length > 0);
  return { above: pub.filter((s) => s.position === 'above'), below: pub.filter((s) => s.position !== 'above') };
}

test('la propuesta reproduce la portada actual: publicadas, orden, posición, velocidad y productos válidos; descarta vacías y no publicadas', () => {
  const products = ['p1', 'p2', 'p3', 'p4'].map((id) => prod(id));
  writeProducts(products);
  fs.rmSync(f('deleted-product-ids.json'), { force: true });
  catalog.invalidateCatalogCache();
  const sections = [
    section('c-tercera', ['p3'], { order: 5, position: 'above', speed: 'fast' }),
    section('a-primera', ['p1', 'zz', 'p2'], { order: 1, position: 'below', speed: 'slow' }),
    section('oculta', ['p1'], { order: 2, published: false }),
    section('vacia', ['nada', 'tampoco'], { order: 3 }),
    section('b-segunda', ['p4'], { order: 2, position: 'raro', speed: undefined }),
    section('d-arriba', ['p1', 'p4'], { order: 0, position: 'above', speed: 'none' }),
  ];
  writeSections(sections);
  const h = sha(f('sections.json'));
  const expected = indexLogic(sections, catalog.getCatalogProducts());
  const proposal = P.buildSectionsProposal(Sources.loadSources());
  assert.deepEqual(proposal.above.map((p) => p.section.id), expected.above.map((s) => s.id));
  assert.deepEqual(proposal.below.map((p) => p.section.id), expected.below.map((s) => s.id));
  assert.deepEqual(proposal.above.map((p) => p.section.id), ['d-arriba', 'c-tercera']);
  assert.deepEqual(proposal.below.map((p) => p.section.id), ['a-primera', 'b-segunda']);
  for (const p of proposal.proposed) {
    const e = [...expected.above, ...expected.below].find((s) => s.id === p.section.id);
    assert.deepEqual(p.validProductIds, e.products.map((x) => x.id), `${p.section.id}: productos válidos y orden`);
    assert.equal(p.section.speed, e.speed);
    assert.equal(p.section.order, e.order);
    assert.equal(p.section.position, e.position);
  }
  assert.deepEqual(proposal.proposed.find((p) => p.section.id === 'a-primera').invalidProductIds, ['zz']);
  assert.deepEqual(proposal.skipped.map((s) => [s.sectionId, s.reason]).sort(), [['oculta', 'no_publicada'], ['vacia', 'sin_productos']]);
  assert.equal(proposal.proposed.find((p) => p.section.id === 'b-segunda').section.speed, 'normal', 'sin velocidad = normal');
  assert.equal(sha(f('sections.json')), h, 'sections.json intacto');
  assert.equal(fs.existsSync(f('home-layout.json')), false, 'la propuesta no se guarda');
});

test('los bloques propuestos cumplen el modelo (modalidad Sección, por id, sin copiar productos) y sus ids son únicos y válidos', () => {
  const src = Sources.loadSources();
  const p = P.buildSectionsProposal(src);
  const ids = p.proposed.map((x) => x.block.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const x of p.proposed) {
    assert.ok(V.validateBlock(x.block).ok);
    assert.equal(x.block.modality, 'seccion');
    assert.deepEqual(x.block.refs, [{ kind: 'section', id: x.section.id }]);
    assert.doesNotMatch(JSON.stringify(x.block), /productIds|"p[0-9]"/);
  }
  assert.ok(V.validateBlocks(p.proposed.map((x) => x.block)).ok);
  // ids de sección extraños o repetidos tras sanear no colisionan
  const used = new Set();
  assert.notEqual(P.blockIdForSection('Ofertas Ñ!', used), P.blockIdForSection('Ofertas Ñ?', used));
});

test('la lógica de index.astro que reproduce la propuesta sigue siendo la misma (guarda de fidelidad)', () => {
  const index = read('src/pages/index.astro');
  assert.match(index, /\.filter\(\(s\) => s\.published\)/);
  assert.match(index, /\.sort\(\(a, b\) => a\.order - b\.order\)/);
  assert.match(index, /position: s\.position === 'above' \? 'above' : 'below'/);
  assert.match(index, /speed: s\.speed \|\| 'normal'/);
  assert.match(index, /s\.productIds\.map\(\(id\) => allProducts\.find\(\(p\) => p\.id === id\)\)\.filter\(Boolean\)/);
  assert.match(index, /\.filter\(\(s\) => s\.products\.length > 0\)/);
  assert.doesNotMatch(index, /homeLayout|home-layout/);
});

/* ───────── Endpoints ───────── */
const get = (route, url, cookie) => route.GET({ request: apiRequest(url, { method: 'GET', cookie }) });
let adminC;
test('permisos: ambos endpoints rechazan sin sesión, con cookie falsa y con un usuario sin rol admin', async () => {
  adminC = await adminCookie();
  const master = auth.authenticateUser('tester', 'Test-pass-123');
  const actor = users.toPublicUser(users.findUserById(master.id));
  users.createUser({ username: 'comun2', password: 'Clave-comun-123', name: 'Común', role: 'user' }, actor);
  const common = auth.createAdminSession(auth.authenticateUser('comun2', 'Clave-comun-123')).split(';')[0];
  for (const [route, url] of [[resolveRoute, '/api/admin/home-layout/resolve'], [optionsRoute, '/api/admin/home-layout/options?kind=product']]) {
    assert.equal((await get(route, url)).status, 401, `${url} sin sesión`);
    assert.equal((await get(route, url, 'tradylor_admin_session=falsa.1.x')).status, 401, `${url} cookie falsa`);
    assert.equal((await get(route, url, common)).status, 401, `${url} usuario común`);
    assert.equal((await get(route, url, adminC)).status, 200, `${url} admin`);
    const post = await route.ALL({ request: apiRequest(url, { method: 'POST', body: {}, cookie: adminC }) });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('Allow'), 'GET');
    assert.equal((await route.ALL({ request: apiRequest(url, { method: 'POST', body: {} }) })).status, 401, 'sin permisos no se revela el 405');
  }
});

test('resolve: parámetros admitidos, valores permitidos y errores documentados', async () => {
  const U = '/api/admin/home-layout/resolve';
  const bad = async (qs) => { const r = await get(resolveRoute, U + qs, adminC); return [r.status, (await jsonOf(r)).code]; };
  assert.deepEqual(await bad('?source=otro'), [400, 'source_no_valido']);
  assert.deepEqual(await bad('?source='), [400, 'source_no_valido']);
  assert.deepEqual(await bad('?foo=1'), [400, 'parametro_desconocido']);
  assert.deepEqual(await bad('?source=draft&x=1'), [400, 'parametro_desconocido']);
  assert.deepEqual(await bad('?source=draft&source=proposal'), [400, 'parametro_duplicado']);
  for (const s of ['', '?source=draft', '?source=published', '?source=proposal']) {
    const r = await get(resolveRoute, U + s, adminC);
    const body = await jsonOf(r);
    assert.equal(r.status, 200, s);
    assert.equal(body.success, true);
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
    assert.ok(body.totals && Array.isArray(body.blocks) && body.sources && body.storage);
  }
  const pub = await jsonOf(await get(resolveRoute, U + '?source=published', adminC));
  assert.equal(pub.blocks.length, 0);
  assert.match(pub.note, /No hay ninguna portada publicada/);
});

test('resolve?source=proposal: bloques «Sección» desde las secciones actuales, con posición y velocidad, y sin guardar nada', async () => {
  const before = snapshotFiles();
  const names = listing();
  const body = await jsonOf(await get(resolveRoute, '/api/admin/home-layout/resolve?source=proposal', adminC));
  assert.equal(body.source, 'proposal');
  assert.deepEqual(body.proposal.above.length + body.proposal.below.length, body.blocks.length);
  assert.ok(body.proposal.sections.every((s) => ['above', 'below'].includes(s.position) && ['slow', 'normal', 'fast', 'none'].includes(s.speed)));
  assert.equal(body.blocks.every((b) => b.modality === 'seccion'), true);
  assert.deepEqual(body.proposal.skipped.map((s) => s.reason).sort(), ['no_publicada', 'sin_productos']);
  assert.deepEqual(snapshotFiles(), before);
  assert.equal(listing(), names);
});

test('resolve?source=draft: detecta referencias inválidas del borrador guardado', async () => {
  const store = await import('../../src/lib/homeLayout/store.ts');
  const doc = V.emptyDocument();
  doc.draft.blocks = [blk({ id: 'ok', refs: [{ kind: 'product', id: 'p1' }] }), blk({ id: 'roto', refs: [{ kind: 'product', id: 'no-existe' }] }), blk({ id: 'sec', modality: 'seccion', refs: [{ kind: 'section', id: 'borrada' }] })];
  assert.deepEqual(store.writeHomeLayout(doc), { ok: true });
  const body = await jsonOf(await get(resolveRoute, '/api/admin/home-layout/resolve?source=draft', adminC));
  assert.deepEqual(body.blocks.map((b) => [b.id, b.visible]), [['ok', true], ['roto', false], ['sec', false]]);
  assert.ok(body.totals.errors >= 2);
  assert.equal(body.storage.status, 'ok');
  fs.rmSync(f('home-layout.json'), { force: true });
  fs.rmSync(f('home-layout.json.bak'), { force: true });
});

test('options: kind obligatorio, límites, paginación y búsqueda sin tildes; errores documentados', async () => {
  const U = '/api/admin/home-layout/options';
  const bad = async (qs) => { const r = await get(optionsRoute, U + qs, adminC); return [r.status, (await jsonOf(r)).code]; };
  assert.deepEqual(await bad(''), [400, 'kind_no_valido']);
  assert.deepEqual(await bad('?kind=ofertas'), [400, 'kind_no_valido']);
  assert.deepEqual(await bad('?kind=product&limit=0'), [400, 'limit_no_valido']);
  assert.deepEqual(await bad('?kind=product&limit=51'), [400, 'limit_no_valido']);
  assert.deepEqual(await bad('?kind=product&limit=abc'), [400, 'limit_no_valido']);
  assert.deepEqual(await bad('?kind=product&limit=-1'), [400, 'limit_no_valido']);
  assert.deepEqual(await bad('?kind=product&offset=10001'), [400, 'offset_no_valido']);
  assert.deepEqual(await bad('?kind=product&offset=x'), [400, 'offset_no_valido']);
  assert.deepEqual(await bad('?kind=product&q=' + 'a'.repeat(81)), [400, 'q_no_valido']);
  assert.deepEqual(await bad('?kind=product&zz=1'), [400, 'parametro_desconocido']);
  assert.deepEqual(await bad('?kind=product&kind=section'), [400, 'parametro_duplicado']);
  const ok = await jsonOf(await get(optionsRoute, U + '?kind=product', adminC));
  assert.equal(ok.limit, 20);
  assert.equal(ok.offset, 0);
  assert.equal(ok.total, 4);
  const page = await jsonOf(await get(optionsRoute, U + '?kind=product&limit=2&offset=1', adminC));
  assert.equal(page.items.length, 2);
  assert.equal(page.total, 4);
  assert.deepEqual((await jsonOf(await get(optionsRoute, U + '?kind=product&offset=100', adminC))).items, []);
  assert.deepEqual((await jsonOf(await get(optionsRoute, U + '?kind=product&q=PRODUCTO%20P2', adminC))).items.map((i) => i.id), ['p2']);
  const cats = await jsonOf(await get(optionsRoute, U + '?kind=category&q=informatica', adminC));
  assert.deepEqual(cats.items.map((c) => [c.id, c.level]), [['informatica', 'category'], ['portatiles', 'subcategory']].slice(0, 1));
  const tree = await jsonOf(await get(optionsRoute, U + '?kind=category', adminC));
  assert.deepEqual(tree.items.map((c) => c.id), ['sonido', 'informatica', 'portatiles', 'hogar', 'calefaccion'], 'raíces seguidas de sus subcategorías');
  const secs = await jsonOf(await get(optionsRoute, U + '?kind=section', adminC));
  assert.ok(secs.items.every((s) => typeof s.published === 'boolean' && typeof s.validProductCount === 'number'));
  assert.deepEqual(secs.items.map((s) => s.id).slice(0, 2), ['d-arriba', 'a-primera'], 'orden de «Crear sección»');
  const merch = await jsonOf(await get(optionsRoute, U + '?kind=merchant', adminC));
  assert.deepEqual(merch.items.map((m) => m.id).sort(), ['aliexpress', 'amazon', 'ebay', 'temu']);
});

test('options y resolve NO exponen enlaces de afiliado, comisiones ni datos internos', async () => {
  const dumps = [];
  for (const k of ['product', 'category', 'section', 'merchant']) dumps.push(JSON.stringify(await jsonOf(await get(optionsRoute, `/api/admin/home-layout/options?kind=${k}`, adminC))));
  for (const s of ['draft', 'published', 'proposal']) dumps.push(JSON.stringify(await jsonOf(await get(resolveRoute, `/api/admin/home-layout/resolve?source=${s}`, adminC))));
  const all = dumps.join('\n');
  assert.doesNotMatch(all, /secreto-21|SECRETA|affiliateUrl|amazon\.es\/dp|comision|commission|password|token|credentials/i);
  assert.doesNotMatch(all, /[A-Za-z]:\\|treidilor-home-resolve|\/tmp\//);
  const prodItem = JSON.parse(dumps[0]).items[0];
  assert.deepEqual(Object.keys(prodItem).sort(), ['category', 'hasImage', 'id', 'inStock', 'network', 'price', 'title']);
});

test('ninguna petición GET escribe: hashes de los datos y listado del directorio idénticos tras recorrer todos los endpoints', async () => {
  const before = snapshotFiles();
  const names = listing();
  for (const u of ['/api/admin/home-layout', '/api/admin/home-layout/resolve', '/api/admin/home-layout/resolve?source=published', '/api/admin/home-layout/resolve?source=proposal', '/api/admin/home-layout/options?kind=product&q=prod', '/api/admin/home-layout/options?kind=category', '/api/admin/home-layout/options?kind=section', '/api/admin/home-layout/options?kind=merchant']) {
    const route = u.endsWith('home-layout') ? await import('../../src/pages/api/admin/home-layout/index.ts') : u.includes('/resolve') ? resolveRoute : optionsRoute;
    assert.equal((await get(route, u, adminC)).status, 200, u);
  }
  assert.deepEqual(snapshotFiles(), before);
  assert.equal(listing(), names);
  assert.equal(fs.existsSync(f('home-layout.json')), false);
});

/* ───────── Estático: sólo lectura y protección ───────── */
test('los módulos de la etapa 2 no importan ni llaman a nada que escriba o inicialice datos', () => {
  const files = ['src/lib/homeLayout/sources.ts', 'src/lib/homeLayout/resolve.ts', 'src/lib/homeLayout/sectionsProposal.ts', 'src/pages/api/admin/home-layout/resolve.ts', 'src/pages/api/admin/home-layout/options.ts'];
  for (const p of files) {
    const src = code(p);
    assert.doesNotMatch(src, /writeFileSync|writeFile\(|renameSync|copyFileSync|mkdirSync|unlinkSync|rmSync|appendFile/, `${p}: escritura directa`);
    assert.doesNotMatch(src, /\bgetCategories\b|ensureCategoriesFile|writeCategories|from '(\.\.\/)+lib\/sections'|from '\.\.\/sections'|writeSections|upsertSection|deleteSection|writeHomeLayout|recoverHomeLayoutFromBackup|writeProductsToFile|upsertProduct/, `${p}: función que escribe o inicializa`);
    assert.doesNotMatch(src, /\bfetch\(|process\.env\.[A-Z_]*KEY|credentials/, `${p}: red o credenciales`);
  }
  for (const p of ['src/pages/api/admin/home-layout/resolve.ts', 'src/pages/api/admin/home-layout/options.ts']) {
    assert.match(code(p), /requireAdminAuth\(request\)/, p);
    assert.doesNotMatch(code(p), /export const (POST|PUT|DELETE|PATCH)\b/, p);
  }
});

test('la página sigue exigiendo admin, es de solo lectura y la portada pública no consulta el módulo', () => {
  const page = read('src/pages/upayp1b4/portada.astro');
  assert.match(page, /sessionUser\.role !== 'admin'\) return Astro\.redirect/);
  assert.match(page, /loadSources\(\)/);
  assert.doesNotMatch(code('src/pages/upayp1b4/portada.astro'), /writeHomeLayout|recoverHomeLayoutFromBackup|writeFileSync|getCategories\(/);
  for (const p of ['src/pages/index.astro', 'src/layouts/Layout.astro', 'src/lib/sections.ts', 'src/lib/catalog.ts', 'src/middleware.ts']) assert.doesNotMatch(read(p), /homeLayout|home-layout/, p);
});

/* ───────── Rendimiento ───────── */
test('rendimiento con 2.000 productos, 60 secciones y bloques de 24 referencias', async () => {
  const products = Array.from({ length: 2000 }, (_, i) => prod(`pp${i}`, { title: `Auricular número ${i}`, network: ['amazon', 'aliexpress', 'ebay', 'temu'][i % 4], price: 5 + (i % 90) }));
  writeProducts(products);
  fs.rmSync(f('deleted-product-ids.json'), { force: true });
  writeSections(Array.from({ length: 60 }, (_, i) => section(`sec-${i}`, Array.from({ length: 30 }, (_, k) => `pp${(i * 31 + k) % 2100}`), { order: i, position: i % 2 ? 'above' : 'below' })));
  catalog.invalidateCatalogCache();
  const before = snapshotFiles();
  const t0 = performance.now();
  const src = Sources.loadSources(); // incluye la primera lectura y validación del catálogo (sin caché)
  const tLoad = performance.now() - t0;
  assert.equal(src.products.size, 2000);
  const blocks = Array.from({ length: 60 }, (_, i) => blk({ id: `m${i}`, refs: Array.from({ length: 24 }, (_, k) => ({ kind: 'product', id: `pp${(i * 24 + k) % 2200}` })) }));
  const t1 = performance.now();
  const resolved = R.resolveBlocks(blocks, src);
  const tResolve = performance.now() - t1;
  const t2 = performance.now();
  const proposal = P.buildSectionsProposal(src);
  const tProposal = performance.now() - t2;
  const t3 = performance.now();
  for (let i = 0; i < 20; i++) await get(optionsRoute, '/api/admin/home-layout/options?kind=product&q=auricular%20numero%2012&limit=50', adminC);
  const tOptions = (performance.now() - t3) / 20;
  const t4 = performance.now();
  const full = await get(resolveRoute, '/api/admin/home-layout/resolve?source=proposal', adminC);
  const tEndpoint = performance.now() - t4;
  assert.equal(full.status, 200);
  console.log(`RENDIMIENTO (2.000 productos): carga ${tLoad.toFixed(0)} ms · resolver 60 bloques×24 refs ${tResolve.toFixed(1)} ms · propuesta 60 secciones ${tProposal.toFixed(1)} ms · options (media de 20) ${tOptions.toFixed(1)} ms · resolve?source=proposal ${tEndpoint.toFixed(0)} ms`);
  assert.equal(resolved.blocks.length, 60);
  assert.equal(proposal.proposed.length, 60);
  assert.ok(tLoad < 5000, `carga ${tLoad}`);
  assert.ok(tResolve < 500, `resolver ${tResolve}`);
  assert.ok(tProposal < 500, `propuesta ${tProposal}`);
  assert.ok(tOptions < 300, `options ${tOptions}`);
  assert.ok(tEndpoint < 3000, `endpoint ${tEndpoint}`);
  assert.deepEqual(snapshotFiles(), before, 'sin escrituras ni siquiera con el catálogo grande');
  const big = await jsonOf(await get(optionsRoute, '/api/admin/home-layout/options?kind=product&limit=50&offset=1900', adminC));
  assert.equal(big.items.length, 50);
  assert.equal(big.total, 2000);
});
