// Portada editable: vista previa FIEL del editor (iframe con la propia portada) y portada independiente del catálogo (/catalogo).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-preview-');
delete process.env.HOME_LAYOUT_ENABLED;
const Pub = await import('../../src/lib/homeLayout/public.ts');
const I = await import('../../src/lib/homeLayout/initialLayout.ts');
const V = await import('../../src/lib/homeLayout/validate.ts');
const Src = await import('../../src/lib/homeLayout/sources.ts');
const L = await import('../../src/lib/catalogListing.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const f = (n) => path.join(dir, n);

const CATS = ['portabilidad', 'informatica', 'sonido', 'hogar'];
const prod = (i, cat) => ({ id: `p${i}`, slug: `p${i}`, title: `Producto ${i}`, price: 10 + i, category: cat, category_id: cat, network: 'amazon', merchant: 'X', currency: 'EUR', inStock: true, image: `/images/products/p${i}.jpg`, affiliateUrl: 'https://x/', sourceId: `S${i}`, extra: {} });
let n = 0;
fs.writeFileSync(f('products.json'), JSON.stringify(CATS.flatMap((c) => Array.from({ length: 6 }, () => prod(++n, c)))));
fs.writeFileSync(f('categories.json'), JSON.stringify(CATS.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), slug: id, icon: '📦', keywords: [] }))));
fs.writeFileSync(f('sections.json'), '[]');
fs.writeFileSync(f('deleted-product-ids.json'), '[]');

const v1 = V.validateBlocks(I.LEGACY_V1_BLOCKS).value;
const design = () => V.validateBlocks(I.buildInitialBlocks(I.deriveInitialContext(Src.loadSources()))).value;
const compose = (blocks) => Pub.composeHome(blocks, { version: 0, publishedAt: '' }, { imageExists: () => true });

test('independencia: la portada del rediseño es independiente del catálogo; la v1 conserva el catálogo debajo', () => {
  assert.equal(Pub.isIndependentFromCatalog(v1), false, 'la v1 (activa) no cambia');
  assert.equal(Pub.isIndependentFromCatalog(design()), true, 'el rediseño sí');
  assert.equal(Pub.isIndependentFromCatalog([]), false);
  const onlyList = V.validateBlocks([{ id: 'r', modality: 'automatica', format: 'lista', width: 6, title: 'R', card: 'producto', visible: true, refs: [], config: { rules: { order: 'precio_asc', limit: 5, onlyWithPrice: true } } }]).value;
  assert.equal(Pub.isIndependentFromCatalog(onlyList), true);
});

test('enlaces: /?…#catalogo → /catalogo?… sólo con portada independiente; el resto no cambia', () => {
  assert.equal(Pub.toCatalogHref('/?deal=1#catalogo'), '/catalogo?deal=1');
  assert.equal(Pub.toCatalogHref('/?category=sonido#destacados'), '/catalogo?category=sonido');
  assert.equal(Pub.toCatalogHref('/#catalogo'), '/catalogo');
  assert.equal(Pub.toCatalogHref('/categorias'), '/categorias');
  assert.equal(Pub.toCatalogHref('/producto/p1'), '/producto/p1');
  assert.equal(Pub.toCatalogHref('https://otro.example/?a=1#catalogo'), 'https://otro.example/?a=1#catalogo');
  const d = compose(design());
  assert.equal(d.mode, 'layout');
  assert.equal(d.independent, true);
  const all = [...d.top, ...d.bottom];
  for (const b of all) {
    for (const h of [b.seeAll, b.editorial?.href, ...(b.categories ?? []).map((c) => c.href)]) if (h) assert.doesNotMatch(h, /#catalogo|#destacados|^\/\?/, `${b.id}: ${h}`);
  }
  const old = compose(v1);
  assert.equal(old.mode, 'layout');
  assert.equal(old.independent, false);
  const welcome = [...old.top, ...old.bottom].find((b) => b.id === 'bienvenida');
  assert.equal(welcome.editorial.href, '/#catalogo', 'la v1 sigue enlazando a la ancla del catálogo de su propia portada');
});

test('un borrador antiguo con enlaces /?…#catalogo se pinta con /catalogo?… sin tocar el borrador guardado', () => {
  const blocks = design().map((b) => (b.id === 'bajadas' ? { ...b, link: { type: 'path', target: '/?deal=1#catalogo' } } : b));
  assert.ok(V.validateBlocks(blocks).ok, 'el borrador antiguo sigue siendo válido');
  const d = compose(blocks);
  const bajadas = [...d.top, ...d.bottom].find((b) => b.id === 'bajadas');
  if (bajadas) assert.equal(bajadas.seeAll, '/catalogo?deal=1');
  assert.equal(blocks.find((b) => b.id === 'bajadas').link.target, '/?deal=1#catalogo', 'la entrada no se muta');
});

test('composeHome es la misma lógica que la web: sin descuentos verificados «Bajadas de precio» no aparece y el resto sí', () => {
  const d = compose(design());
  const ids = [...d.top, ...d.bottom].map((b) => b.id);
  assert.ok(!ids.includes('bajadas'), 'sin bajadas verificadas el bloque se oculta (no se inventan)');
  for (const need of ['hero', 'campana', 'categorias', 'ranking', 'guia', 'cat-informatica', 'confianza']) assert.ok(ids.includes(need), need);
  const ranking = [...d.top, ...d.bottom].find((b) => b.id === 'ranking');
  assert.equal(ranking.title, 'Los 5 más económicos');
  assert.equal(ranking.productIds.length, 5);
  const text = JSON.stringify(d);
  assert.doesNotMatch(text, /Lo más buscado|más vendido|popular/i, 'no se afirma popularidad sin datos');
  assert.equal(compose([]).mode, 'legacy', 'sin bloques no hay portada');
});

test('compatibilidad: listingHref admite otra base y por defecto conserva «/»', () => {
  const p = { q: '', category: ['sonido'], brand: [], attrs: {}, deal: false };
  assert.equal(L.listingHref(p), '/?category=sonido#catalogo');
  assert.equal(L.listingHref(p, { base: '/catalogo' }), '/catalogo?category=sonido#catalogo');
  assert.equal(L.listingHref({ ...p, category: [] }, { base: '/catalogo', page: 2 }), '/catalogo?page=2#catalogo');
});

test('el rediseño inicial enlaza a /catalogo (no a la ancla de la portada)', () => {
  const blocks = I.buildInitialBlocks(I.deriveInitialContext(Src.loadSources()));
  const targets = JSON.stringify(blocks.map((b) => [b.link?.target, b.config?.link?.target]));
  assert.doesNotMatch(targets, /#catalogo/);
  assert.match(targets, /\/catalogo/);
  assert.equal(I.LEGACY_V1_BLOCKS.find((b) => b.id === 'bienvenida').config.link.target, '/#catalogo', 'la v1 original no cambia');
});

test('estático: /catalogo reutiliza el listado; la portada independiente no pinta catálogo; la vista previa es de sólo lectura y de administrador', () => {
  const cat = code('src/pages/catalogo.astro');
  assert.match(cat, /import Index from '\.\/index\.astro'/);
  assert.match(cat, /<Index catalogPage \/>/);
  const idx = code('src/pages/index.astro');
  assert.match(idx, /const showCatalog = previewBlocks \? Boolean\(layoutHome && !layoutHome\.independent\) : !layoutHome \|\| !layoutHome\.independent;/);
  assert.match(idx, /\{showCatalog && \(<>/, 'el catálogo sólo se pinta si procede');
  assert.match(idx, /catalogPage \? null : previewBlocks \?/, '/catalogo no usa la portada nueva');
  assert.doesNotMatch(idx, /writeHomeLayout|writeStories|writeActivation|writeDraftBackups/);
  const view = code('src/pages/upayp1b4/portada-vista.astro');
  assert.match(view, /getSessionUser/);
  assert.match(view, /user\.role !== 'admin'/);
  assert.match(view, /sameOrigin/);
  assert.match(view, /validateBlocks/, 'valida los bloques antes de pintar');
  assert.doesNotMatch(view, /write(HomeLayout|Stories|Activation|DraftBackups)|planPublish|planActivate|\bfs\./, 'sólo lectura');
  assert.match(view, /noindex/);
  assert.match(idx, /window\.addEventListener\('auxclick', block, true\)/, 'también el clic central');
  assert.ok(idx.includes('/\\/api\\/analytics\\//.test(url)'), 'la vista previa no cuenta visitas');
  assert.match(idx, /method !== 'GET'\) return Promise\.resolve/, 'la vista previa descarta toda petición que no sea de lectura');
  const client = code('src/scripts/homeLayoutEditor.ts');
  assert.match(client, /sandbox: 'allow-scripts allow-same-origin'/);
  assert.match(client, /method: 'post', action: PV_URL, target: name/);
  assert.match(client, /PV_DESKTOP_W = 1280/);
  assert.match(client, /PV_MOBILE_W = 390/);
  assert.doesNotMatch(client, /innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function/);
  const css = read('src/pages/upayp1b4/portada.astro');
  assert.match(css, /\.pe-pvwin-if \{ height: clamp\(/, 'cada ventana tiene alto propio');
  assert.match(css, /overscroll-behavior: contain/);
  assert.match(idx + read('src/pages/index.astro'), /overscroll-behavior:contain/, 'el scroll interno no arrastra al administrador');
});
