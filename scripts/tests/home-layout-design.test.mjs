// Rediseño de la portada (maquetas v4): ampliación COMPATIBLE del modelo de bloques (variantes editoriales, enlace «Ver todo», subtítulo, lista numerada,
// bajadas verificadas), plan público con datos reales, panel de categorías y página «Todas las categorías».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupIsolatedData } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-design-');
delete process.env.HOME_LAYOUT_ENABLED;
const V = await import('../../src/lib/homeLayout/validate.ts');
const T = await import('../../src/lib/homeLayout/types.ts');
const Src = await import('../../src/lib/homeLayout/sources.ts');
const Auto = await import('../../src/lib/homeLayout/automatic.ts');
const R = await import('../../src/lib/homeLayout/resolve.ts');
const A = await import('../../src/lib/homeLayout/activation.ts');
const P = await import('../../src/lib/homeLayout/public.ts');
const D = await import('../../src/lib/homeLayout/draft.ts');
const I = await import('../../src/lib/homeLayout/initialLayout.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const obs = (price, original) => ({ capturedAt: '2026-11-08T10:00:00Z', verifiedAt: '2026-11-08T10:00:01Z', price, originalPrice: original, context: { currency: 'EUR' } });
const prod = (i, over = {}) => ({ id: `p${i}`, slug: `p${i}`, title: `Producto ${i}`, price: 10 * i, category: 'Sonido', category_id: 'sonido', network: 'amazon', merchant: 'X', currency: 'EUR', inStock: true, image: `/images/products/p${i}.jpg`, affiliateUrl: 'https://x/', sourceId: `S${i}`, extra: {}, ...over });
function seed() {
  fs.writeFileSync(`${dir}/products.json`, JSON.stringify([
    prod(1, { price: 100, originalPrice: 160, extra: { observations: [obs(100, 160)] } }),
    prod(2, { price: 80, originalPrice: 100, extra: { observations: [obs(80, 100)] } }),
    prod(3, { price: 50, originalPrice: 90 }),
    prod(4), prod(5), prod(6),
  ]));
  fs.writeFileSync(`${dir}/categories.json`, JSON.stringify([{ id: 'sonido', name: 'Sonido', slug: 'sonido', icon: '🎧', keywords: [] }, { id: 'auriculares', name: 'Auriculares', slug: 'auriculares', icon: '', keywords: [], parentId: 'sonido' }]));
  fs.writeFileSync(`${dir}/sections.json`, '[]');
  fs.writeFileSync(`${dir}/deleted-product-ids.json`, '[]');
}
seed();
const base = { id: 'b1', modality: 'editorial', format: 'banner', width: 12, title: 't', card: 'promocion', visible: true, refs: [] };
const ed = (config, over = {}) => ({ ...base, config: { headline: 'H', ...config }, ...over });
const man = (over = {}) => ({ ...base, modality: 'manual', format: 'carrusel', card: 'producto', config: {}, refs: [{ kind: 'product', id: 'p1' }], ...over });
const auto = (rules, over = {}) => ({ ...base, modality: 'automatica', format: 'carrusel', card: 'producto', config: { rules: { order: 'precio_asc', limit: 5, ...rules } }, ...over });

test('compatibilidad: los bloques ya guardados (v1) siguen validando EXACTAMENTE igual, sin campos nuevos añadidos', () => {
  const v = V.validateBlocks(I.LEGACY_V1_BLOCKS);
  assert.ok(v.ok);
  assert.deepEqual(JSON.parse(JSON.stringify(v.value)), JSON.parse(JSON.stringify(v.value.map((b) => ({ ...b })))));
  for (const b of v.value) { assert.equal('link' in b, false); assert.equal('subtitle' in b, false); }
  assert.ok(V.validateBlock(man()).ok, 'un bloque sin los campos nuevos sigue siendo válido');
  assert.ok(!('variant' in V.validateBlock(ed({ variant: 'plain' })).value.config), '«plain» = el aspecto original (no se guarda)');
});

test('variantes editoriales: campos nuevos validados (rótulo, cifra, segunda imagen segura y hasta 4 mensajes)', () => {
  const ok = (cfg) => V.validateBlock(ed(cfg));
  assert.ok(ok({ variant: 'hero', eyebrow: 'RÓTULO', imageUrl: '/a.jpg', imageUrl2: 'https://img.example/b.png' }).ok);
  assert.equal(ok({ variant: 'hero' }).value.config.variant, 'hero');
  assert.ok(ok({ variant: 'campaign', kicker: '27·11' }).ok);
  assert.ok(ok({ variant: 'trust', items: [{ title: 'A', text: 'a' }, { title: 'B' }] }).ok);
  for (const bad of [{ variant: 'otra' }, { eyebrow: 'x'.repeat(41) }, { kicker: 'x'.repeat(17) }, { imageUrl2: 'javascript:alert(1)' }, { imageUrl2: 'http://x/a.jpg' },
    { items: Array.from({ length: 5 }, (_, i) => ({ title: `t${i}` })) }, { items: [{ title: '' }] }, { items: [{ title: 't', extra: 1 }] }, { items: [{ title: 'x'.repeat(41) }] }, { desconocido: 1 }]) {
    assert.equal(ok(bad).ok, false, JSON.stringify(bad));
  }
});

test('enlace «Ver todo ›» y subtítulo de cualquier bloque; formato «lista» (máx. 10)', () => {
  assert.ok(V.validateBlock(man({ link: { type: 'category', target: 'sonido' }, subtitle: 'Sólo bajadas verificadas' })).ok);
  assert.ok(V.validateBlock(man({ link: { type: 'path', target: '/?deal=1#catalogo' } })).ok);
  for (const bad of [{ link: { type: 'path', target: 'sin-barra' } }, { link: { type: 'url', target: 'http://x.example' } }, { link: { type: 'otro', target: 'x' } }, { subtitle: '' }, { subtitle: 'x'.repeat(121) }, { desconocido: 1 }]) {
    assert.equal(V.validateBlock(man(bad)).ok, false, JSON.stringify(bad));
  }
  assert.equal(V.FORMAT_REGISTRY.lista.maxItems, 10);
  assert.ok(V.validateBlock(man({ format: 'lista', refs: Array.from({ length: 10 }, (_, i) => ({ kind: 'product', id: `p${i}` })) })).ok);
  assert.equal(V.validateBlock(man({ format: 'lista', refs: Array.from({ length: 11 }, (_, i) => ({ kind: 'product', id: `p${i}` })) })).ok, false);
  assert.equal(V.validateBlock(auto({ limit: 11 }, { format: 'lista' })).ok, false, 'el límite automático respeta el máximo del formato');
  assert.equal(R.FORMAT_MIN_ITEMS.lista, 3);
});

test('updateBlock QUITA un campo opcional cuando el parche lo deja undefined (enlace y subtítulo se pueden borrar desde el editor)', () => {
  const blocks = [man({ link: { type: 'category', target: 'sonido' }, subtitle: 's' })];
  const next = D.updateBlock(blocks, 'b1', { link: undefined, subtitle: undefined });
  assert.equal('link' in next[0], false);
  assert.equal('subtitle' in next[0], false);
  assert.equal(next[0].title, 't');
  assert.equal(D.updateBlock(blocks, 'b1', { title: 'otro' })[0].link.target, 'sonido', 'el resto de parches no toca lo demás');
});

test('motor automático: «bajada verificada» sólo con observación real; el precio de lista del comercio NO cuenta; sin datos → vacío explicado', () => {
  const src = Src.loadSources();
  assert.equal(src.products.get('p1').discountPct, 38, '160 → 100');
  assert.equal(src.products.get('p3').discountPct, null, 'originalPrice sin observación verificada: no es descuento');
  assert.equal(src.products.get('p4').discountPct, null);
  const r = Auto.runAutomatic({ order: 'descuento_desc', onlyVerifiedDiscount: true, limit: 10 }, src);
  assert.deepEqual([r.status, r.ids], ['ok', ['p1', 'p2']], 'mayor bajada primero');
  assert.deepEqual(Auto.runAutomatic({ order: 'precio_asc', onlyVerifiedDiscount: true, limit: 10 }, src).ids, ['p2', 'p1']);
  assert.deepEqual(Auto.runAutomatic({ order: 'precio_asc', limit: 10 }, src).ids.length, 6, 'sin el filtro entran todos');
  fs.writeFileSync(`${dir}/products.json`, JSON.stringify([prod(3, { price: 50, originalPrice: 90 }), prod(4)]));
  const none = Auto.runAutomatic({ order: 'descuento_desc', onlyVerifiedDiscount: true, limit: 10 }, Src.loadSources());
  assert.deepEqual([none.status, none.reason], ['vacio', 'sin_bajadas_verificadas']);
  const rb = R.resolveBlocks(V.validateBlocks([auto({ onlyVerifiedDiscount: true, order: 'descuento_desc' })]).value, Src.loadSources(), { runAutomatic: true }).blocks[0];
  assert.equal(rb.visible, false, 'el bloque se oculta, no se inventa nada');
  assert.ok(!rb.issues.some((i) => i.severity === 'error'), 'y no bloquea la activación');
  seed();
});

test('plan público: «Ver todo» sólo con destino válido, subtítulo, lista numerada, teselas de categoría con icono y subcategorías, hero/campaña/guía/confianza', () => {
  const blocks = V.validateBlocks([
    auto({ order: 'precio_asc', limit: 5 }, { id: 'rk', format: 'lista', title: 'Ranking', subtitle: 'sub', link: { type: 'path', target: '/?sort=precio_asc#catalogo' } }),
    man({ id: 'bad', title: 'Enlace admin', link: { type: 'path', target: '/upayp1b4/usuarios' } }),
    man({ id: 'cat', title: 'Cats', card: 'categoria', refs: [{ kind: 'category', id: 'sonido' }], link: { type: 'path', target: '/categorias' } }),
    ed({ variant: 'hero', eyebrow: 'E', imageUrl: '/images/products/p1.jpg', imageUrl2: '/images/products/p2.jpg', buttonLabel: 'Ver', link: { type: 'category', target: 'sonido' } }, { id: 'hero', width: 8 }),
    ed({ variant: 'trust', items: [{ title: 'A', text: 'a' }] }, { id: 'trust' }),
  ]).value;
  const doc = { ...V.emptyDocument(), activation: { enabled: true }, published: { version: 1, publishedAt: 'x', blocks } };
  const home = P.buildPublicHome({ env: { HOME_LAYOUT_ENABLED: 'true' }, stageEnabled: true, layout: () => ({ status: 'ok', doc, errors: [] }), activation: () => ({ status: 'ok', doc: { schemaVersion: 1, active: true, pinnedVersion: 1, updatedAt: 'x', log: [] }, errors: [] }), stories: () => ({ status: 'missing', doc: { schemaVersion: 1, draft: { stories: [], updatedAt: null } }, errors: [] }) });
  assert.equal(home.mode, 'layout');
  const by = Object.fromEntries([...home.top, ...home.bottom].map((b) => [b.id, b]));
  assert.deepEqual([by.rk.format, by.rk.productIds.length, by.rk.subtitle, by.rk.seeAll], ['lista', 5, 'sub', '/?sort=precio_asc#catalogo']);
  assert.equal(by.bad.seeAll, undefined, 'un destino administrativo no se enlaza');
  assert.deepEqual(by.cat.categories, [{ id: 'sonido', name: 'Sonido', href: '/?category=sonido#destacados', icon: '🎧', subs: 1 }]);
  assert.equal(by.cat.seeAll, '/categorias');
  assert.deepEqual([by.hero.editorial.variant, by.hero.editorial.eyebrow, by.hero.editorial.imageUrl2, by.hero.editorial.href], ['hero', 'E', '/images/products/p2.jpg', '/?category=sonido#destacados']);
  assert.deepEqual(by.trust.editorial.items, [{ title: 'A', text: 'a' }]);
  assert.doesNotMatch(JSON.stringify(home), /afiliado|affiliate|x\/'/i);
});

test('activación: una segunda imagen o un «Ver todo» no admisibles BLOQUEAN; lo admisible no', () => {
  const chk = (blocks) => { const v = V.validateBlocks(blocks).value; return A.checkForActivation(v, R.resolveBlocks(v, Src.loadSources(), { runAutomatic: true }).blocks); };
  assert.equal(chk([man(), ed({ imageUrl2: '/images/products/v.mp4' }, { id: 'e' })]).blocking.some((b) => b.code === 'editorial_image_unsafe'), true);
  assert.equal(chk([man({ link: { type: 'path', target: '/api/admin/x' } })]).blocking.some((b) => b.code === 'block_link_unsafe'), true);
  assert.equal(chk([man({ link: { type: 'path', target: '/categorias' } }), ed({ imageUrl2: '/images/products/p2.jpg' }, { id: 'e' })]).blocking.length, 0);
});

test('estático: panel de categorías (escritorio dos columnas, móvil acordeón), página /categorias con datos reales y componentes seguros', () => {
  const l = read('src/layouts/Layout.astro');
  for (const t of ['cm2-panel', 'data-cm-item', 'data-cm-close', "e.key === 'Escape'", 'aria-controls="${sid}"', 'href="/categorias"', 'cm2-sub-all', 'Ver toda la categoría', 'Ver todas las categorías', 'headerSubsByParent']) assert.ok(l.includes(t), t);
  assert.match(l, /<button type="button" class="category-menu-btn"/, 'el botón «Categorías» existente se conserva');
  assert.doesNotMatch(l, /<nav[^>]*categor[^>]*>[\s\S]{0,200}cm2/i, 'no hay una segunda barra de categorías');
  const page = code('src/pages/categorias.astro');
  assert.match(page, /getCategories\(\)/);
  assert.match(page, /makeCategoryResolver/);
  assert.doesNotMatch(page, /Informática|Sonido|Portabilidad|Gaming/, 'ninguna categoría escrita a mano');
  for (const c of ['src/components/home/HomeProductCard.astro', 'src/components/home/HomeLayoutBlocks.astro']) {
    const src = read(c);
    assert.doesNotMatch(src, /set:html|innerHTML|affiliateUrl|buyNowUrl|fetch\(|process\.env/, c);
  }
  assert.match(read('src/components/home/HomeProductCard.astro'), /shownDiscount/, 'el «-N %» y el precio tachado salen de la bajada VERIFICADA');
  assert.doesNotMatch(read('src/components/home/HomeProductCard.astro'), /originalPrice/, 'nunca el precio de lista del comercio');
  for (const p of ['src/pages/index.astro', 'src/middleware.ts', 'src/components/ProductCard.astro']) assert.doesNotMatch(read(p), /cm2-|HomeProductCard|categorias\.astro/, `${p} no se toca`);
});
