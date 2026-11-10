// Portada editable · etapa 6: plan público (`buildPublicHome`). Candados, versión FIJADA, bloques manuales/automáticos/sección/editorial,
// secciones existentes (posición, sin duplicar, no referenciadas), fallback ante errores y rendimiento con 2.000 productos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupIsolatedData } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-public-');
delete process.env.HOME_LAYOUT_ENABLED;
const Pub = await import('../../src/lib/homeLayout/public.ts');
const Sources = await import('../../src/lib/homeLayout/sources.ts');
const Auto = await import('../../src/lib/homeLayout/automatic.ts');
const V = await import('../../src/lib/homeLayout/validate.ts');
const L = await import('../../src/lib/homeLayout/store.ts');
const AS = await import('../../src/lib/homeLayout/activationStore.ts');
const f = (n) => `${dir}/${n}`;

const prod = (i, over = {}) => ({ id: `p${i}`, slug: `p${i}`, title: `Producto ${i}`, price: 10 + i, category: i % 2 ? 'Sonido' : 'Informática', category_id: i % 2 ? 'sonido' : 'informatica', network: i % 3 ? 'amazon' : 'ebay', merchant: 'X', currency: 'EUR', inStock: true, image: '/i.jpg', affiliateUrl: 'https://afiliado.example/secreto', sourceId: `S${i}`, extra: {}, ...over });
const CATS = [{ id: 'sonido', name: 'Sonido', slug: 'sonido', icon: '🎧', keywords: [] }, { id: 'informatica', name: 'Informática', slug: 'informatica', icon: '💻', keywords: [] }];
const sec = (id, ids, over = {}) => ({ id, title: `Sección ${id}`, description: `Desc ${id}`, productIds: ids, published: true, order: 0, position: 'below', speed: 'fast', createdAt: '2026-11-01', ...over });
function seed(n = 12, sections = []) {
  fs.writeFileSync(f('products.json'), JSON.stringify(Array.from({ length: n }, (_, i) => prod(i + 1))));
  fs.writeFileSync(f('categories.json'), JSON.stringify(CATS));
  fs.writeFileSync(f('sections.json'), JSON.stringify(sections));
  fs.writeFileSync(f('deleted-product-ids.json'), '[]');
}
const blk = (id, over = {}) => ({ id, modality: 'manual', format: 'carrusel', width: 12, title: `Bloque ${id}`, card: 'producto', config: {}, refs: [{ kind: 'product', id: 'p1' }, { kind: 'product', id: 'p2' }], visible: true, ...over });
const auto = (id, rules, over = {}) => blk(id, { modality: 'automatica', format: 'carrusel', config: { rules: { limit: 6, ...rules } }, refs: [], ...over });
const secBlock = (id, sid, over = {}) => blk(id, { modality: 'seccion', card: 'producto', config: {}, refs: [{ kind: 'section', id: sid }], ...over });
const editorial = (id, cfg, over = {}) => blk(id, { modality: 'editorial', card: 'promocion', config: { headline: 'Campaña', ...cfg }, refs: [], ...over });
const docWith = (versions, { enabled = true, publishedVersion } = {}) => {
  const pubV = publishedVersion ?? Math.max(...versions.map((v) => v.version));
  return { ...V.emptyDocument(), activation: { enabled }, published: versions.find((v) => v.version === pubV), versions: versions.filter((v) => v.version !== pubV) };
};
const ver = (version, blocks) => ({ version, publishedAt: '2026-11-10T10:00:00.000Z', blocks });
const ENV = { HOME_LAYOUT_ENABLED: 'true' };
const deps = (doc, pinned, extra = {}) => ({
  env: ENV, stageEnabled: true,
  layout: () => ({ status: 'ok', doc, errors: [] }),
  activation: () => ({ status: 'ok', doc: { schemaVersion: 1, active: true, pinnedVersion: pinned, updatedAt: 'x', log: [] }, errors: [] }),
  stories: () => ({ status: 'missing', doc: { schemaVersion: 1, draft: { stories: [], updatedAt: null } }, errors: [] }),
  ...extra,
});
const ids = (list) => list.map((b) => b.id);

test('candados: sin código, sin variable, sin activación o sin versión fijada → portada anterior; sin leer disco si los dos primeros están cerrados', () => {
  seed();
  const d = docWith([ver(1, [blk('m1')])]);
  const boom = () => { throw new Error('no debería leerse'); };
  assert.deepEqual(Pub.buildPublicHome({ env: {}, stageEnabled: true, layout: boom, activation: boom }), { mode: 'legacy', reason: 'candado_cerrado' });
  assert.equal(Pub.buildPublicHome({ env: ENV, stageEnabled: false, layout: boom, activation: boom }).mode, 'legacy');
  assert.equal(Pub.buildPublicHome({ env: { HOME_LAYOUT_ENABLED: 'false' }, stageEnabled: true, layout: boom }).mode, 'legacy');
  assert.equal(Pub.buildPublicHome(deps(d, 1)).mode, 'layout', 'con todo abierto');
  assert.equal(Pub.buildPublicHome(deps(docWith([ver(1, [blk('m1')])], { enabled: false }), 1)).mode, 'legacy', 'activation.enabled apagado');
  assert.equal(Pub.buildPublicHome(deps(d, 1, { activation: () => ({ status: 'ok', doc: { schemaVersion: 1, active: false, pinnedVersion: 1, updatedAt: 'x', log: [] }, errors: [] }) })).mode, 'legacy', 'archivo de activación apagado');
  assert.equal(Pub.buildPublicHome(deps(d, null)).mode, 'legacy', 'sin versión fijada');
  assert.equal(Pub.buildPublicHome(deps(d, 7)).mode, 'legacy', 'versión fijada inexistente');
  for (const status of ['missing', 'corrupt', 'invalid', 'newer']) {
    assert.equal(Pub.buildPublicHome(deps(d, 1, { activation: () => ({ status, doc: { schemaVersion: 1, active: true, pinnedVersion: 1, updatedAt: 'x', log: [] }, errors: [] }) })).mode, 'legacy', `activación ${status}`);
    assert.equal(Pub.buildPublicHome(deps(d, 1, { layout: () => ({ status, doc: d, errors: [] }) })).mode, 'legacy', `portada ${status}`);
  }
});

test('versión FIJADA: publicar otra versión interna NO cambia la web', () => {
  seed();
  const v1 = ver(1, [blk('uno', { title: 'Versión uno' })]);
  const v2 = ver(2, [blk('dos', { title: 'Versión dos' })]);
  const d = docWith([v1, v2], { publishedVersion: 2 });
  assert.deepEqual(ids(Pub.buildPublicHome(deps(d, 1)).top), ['uno'], 'se sirve la fijada (v1), no la última publicada (v2)');
  assert.deepEqual(ids(Pub.buildPublicHome(deps(d, 2)).top), ['dos']);
});

test('bloques manuales, automáticos, de sección y editoriales: reales, ordenados y sólo con datos presentables', () => {
  seed(12, [sec('ofertas', ['p3', 'p4', 'p999'], { position: 'above' })]);
  const blocks = [
    blk('man', { refs: [{ kind: 'product', id: 'p2' }, { kind: 'product', id: 'p404' }, { kind: 'product', id: 'p1' }] }),
    auto('au', { categoryId: 'sonido', order: 'precio_desc', limit: 3 }),
    blk('ban', { format: 'banner', width: 12, refs: [{ kind: 'product', id: 'p5' }, { kind: 'product', id: 'p6' }] }),
    blk('grid', { format: 'cuadricula2x2', width: 6, refs: ['p1', 'p2', 'p3', 'p4'].map((id) => ({ kind: 'product', id })) }),
    secBlock('sb', 'ofertas'),
    editorial('ed', { text: 'Texto', buttonLabel: 'Ir', link: { type: 'path', target: '/guias/portatiles' }, imageUrl: '/images/products/x.jpg' }, { width: 6 }),
    blk('cats', { card: 'categoria', refs: [{ kind: 'category', id: 'sonido' }, { kind: 'category', id: 'inexistente' }] }),
  ];
  const home = Pub.buildPublicHome(deps(docWith([ver(1, blocks)]), 1));
  assert.equal(home.mode, 'layout');
  const by = Object.fromEntries([...home.top, ...home.bottom].map((b) => [b.id, b]));
  assert.deepEqual(by.man.productIds, ['p2', 'p1'], 'se omite el producto inexistente y se conserva el orden del editor');
  const expectedAuto = Auto.runAutomatic({ categoryId: 'sonido', order: 'precio_desc', limit: 3 }, Sources.loadSources());
  assert.deepEqual(by.au.productIds, expectedAuto.ids, 'MISMO motor y fuentes que la previsualización');
  assert.deepEqual(by.au.productIds, ['p11', 'p9', 'p7']);
  assert.deepEqual(by.ban.productIds, ['p5'], 'banner = un producto destacado a ancho completo');
  assert.equal(by.ban.featured, true);
  assert.equal(by.grid.productIds.length, 4);
  assert.deepEqual(by.sb.productIds, ['p3', 'p4'], 'sección: sólo productos existentes, en el orden de sections.json');
  assert.deepEqual([by.sb.section.id, by.sb.section.speed, by.sb.section.description], ['ofertas', 'fast', 'Desc ofertas']);
  assert.deepEqual(by.ed.editorial, { headline: 'Campaña', text: 'Texto', imageUrl: '/images/products/x.jpg', buttonLabel: 'Ir', href: '/guias/portatiles' });
  assert.deepEqual(by.cats.categories, [{ id: 'sonido', name: 'Sonido', href: '/?category=sonido#destacados' }]);
  assert.doesNotMatch(JSON.stringify(home), /afiliado|secreto|affiliate/i, 'ningún enlace de afiliado');
});

test('secciones existentes: su posición se respeta, no se duplican y las no referenciadas se conservan (con sus id)', () => {
  seed(12, [
    sec('arriba', ['p1', 'p2'], { position: 'above', order: 1 }),
    sec('abajo', ['p3', 'p4'], { position: 'below', order: 2 }),
    sec('libre-a', ['p5'], { position: 'above', order: 3 }),
    sec('libre-b', ['p6'], { position: 'below', order: 0 }),
    sec('oculta', ['p7'], { published: false }),
    sec('vacia', ['p404']),
  ]);
  const blocks = [blk('m1'), secBlock('s1', 'arriba'), secBlock('s2', 'abajo'), secBlock('s2bis', 'abajo'), blk('m2')];
  const home = Pub.buildPublicHome(deps(docWith([ver(1, blocks)]), 1));
  assert.deepEqual(ids(home.top), ['m1', 's1', 'm2', 'seccion-libre-a'], 'arriba: bloques y secciones «arriba», luego las no referenciadas «arriba»');
  assert.deepEqual(ids(home.bottom), ['s2', 'seccion-libre-b'], 'abajo: la sección referenciada UNA vez y luego las no referenciadas «abajo»');
  const all = [...home.top, ...home.bottom].filter((b) => b.section).map((b) => b.section.id);
  assert.equal(new Set(all).size, all.length, 'sin id de sección repetidos');
  assert.ok(!all.includes('oculta') && !all.includes('vacia'), 'las no publicadas o vacías no se muestran, como hoy');
  // la sección referenciada pero oculta por el administrador NO reaparece como «no referenciada»
  const hidden = Pub.buildPublicHome(deps(docWith([ver(1, [blk('m1'), secBlock('s1', 'arriba', { visible: false })])]), 1));
  assert.ok(![...hidden.top, ...hidden.bottom].some((b) => b.section?.id === 'arriba'));
});

test('bloques rotos u omisibles: «recientes» sin fecha fiable, enlaces inseguros, imágenes inseguras y referencias inexistentes no rompen la web', () => {
  seed(12);
  const blocks = [
    blk('ok'),
    auto('rec', { order: 'recientes', limit: 4 }),
    blk('roto', { refs: [{ kind: 'product', id: 'p404' }] }),
    editorial('adm', { buttonLabel: 'Entrar', link: { type: 'path', target: '/upayp1b4' }, imageUrl: '/images/products/v.mp4' }),
    editorial('ext', { buttonLabel: 'Ir', link: { type: 'url', target: 'https://tienda.example/oferta' } }),
    editorial('sinbtn', { link: { type: 'path', target: '/guias' } }),
    editorial('rota', { buttonLabel: 'Ver', link: { type: 'product', target: 'p404' } }),
  ];
  const home = Pub.buildPublicHome(deps(docWith([ver(1, blocks)]), 1));
  const by = Object.fromEntries(home.top.map((b) => [b.id, b]));
  assert.equal(by.rec, undefined, '«recientes» sin fechas fiables no se muestra (nunca se inventan)');
  assert.equal(by.roto, undefined);
  assert.equal(by.adm.editorial.href, undefined, 'destino administrativo: sin botón');
  assert.equal(by.adm.editorial.buttonLabel, undefined);
  assert.equal(by.adm.editorial.imageUrl, undefined, 'imagen de vídeo: se omite');
  assert.deepEqual([by.ext.editorial.href, by.ext.editorial.external], ['https://tienda.example/oferta', true]);
  assert.equal(by.sinbtn.editorial.href, undefined, 'enlace sin texto de botón: sin botón');
  assert.equal(by.rota, undefined, 'editorial con un destino inexistente: el bloque no se muestra');
  // con TODO inválido se vuelve a la portada anterior
  assert.deepEqual(Pub.buildPublicHome(deps(docWith([ver(1, [blk('roto', { refs: [{ kind: 'product', id: 'p404' }] })])]), 1)), { mode: 'legacy', reason: 'sin_contenido_visible' });
});

test('fallo de lectura o de proceso → portada anterior (nunca lanza)', () => {
  seed();
  const d = docWith([ver(1, [blk('m1')])]);
  const boom = () => { throw new Error('fallo simulado'); };
  for (const k of ['layout', 'activation', 'sources', 'sectionDescriptions']) assert.equal(Pub.buildPublicHome(deps(d, 1, { [k]: boom })).mode, 'legacy', k);
  // las historias que fallan NO tumban la portada: se omiten
  const withBadStories = Pub.buildPublicHome(deps(d, 1, { stories: boom }));
  assert.equal(withBadStories.mode, 'layout');
  assert.deepEqual(withBadStories.stories, []);
  // catálogo no disponible
  assert.equal(Pub.buildPublicHome(deps(d, 1, { sources: () => ({ ...Sources.loadSources(), status: { ...Sources.loadSources().status, products: { status: 'error', count: 0 } } }) })).reason, 'catalogo_no_disponible');
});

test('extremo a extremo con archivos reales: resolveHomeMode exige los tres candados y la desactivación vuelve a la portada anterior', () => {
  seed();
  const d = docWith([ver(1, [blk('m1')])]);
  assert.equal(L.writeHomeLayout(d).ok, true);
  assert.equal(L.resolveHomeMode(), 'legacy', 'sin variable de entorno');
  process.env.HOME_LAYOUT_ENABLED = 'true';
  try {
    assert.equal(L.resolveHomeMode(), 'legacy', 'sin archivo de activación (versión fijada)');
    const now = '2026-11-10T11:00:00.000Z';
    assert.equal(AS.writeActivation({ schemaVersion: 1, active: true, pinnedVersion: 1, updatedAt: now, log: [] }).ok, true);
    assert.equal(L.resolveHomeMode(), 'layout');
    const home = Pub.buildPublicHome();
    assert.equal(home.mode, 'layout');
    assert.equal(home.version, 1);
    // apagado del archivo de activación → portada anterior
    assert.equal(AS.writeActivation({ schemaVersion: 1, active: false, pinnedVersion: 1, updatedAt: '2026-11-10T11:00:01.000Z', log: [] }).ok, true);
    assert.equal(Pub.buildPublicHome().mode, 'legacy');
    // archivo de activación corrupto → portada anterior y archivo conservado
    fs.writeFileSync(f('home-layout-activation.json'), '{no es json');
    assert.equal(Pub.buildPublicHome().mode, 'legacy');
    assert.equal(fs.readFileSync(f('home-layout-activation.json'), 'utf8'), '{no es json');
    fs.rmSync(f('home-layout-activation.json'));
  } finally { delete process.env.HOME_LAYOUT_ENABLED; }
});

test('rendimiento: 2.000 productos, 60 bloques y 20 secciones se resuelven en tiempo razonable y de forma determinista', () => {
  seed(2000, Array.from({ length: 20 }, (_, i) => sec(`s${i}`, Array.from({ length: 24 }, (_, j) => `p${i * 24 + j + 1}`), { order: i, position: i % 2 ? 'above' : 'below' })));
  const blocks = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? auto(`a${i}`, { order: i % 2 ? 'precio_asc' : 'precio_desc', limit: 24 }) : i % 3 === 1 ? blk(`m${i}`, { refs: Array.from({ length: 24 }, (_, j) => ({ kind: 'product', id: `p${i * 24 + j + 1}` })) }) : secBlock(`b${i}`, `s${i % 20}`)));
  // las secciones repetidas se pintan una vez
  const d = docWith([ver(1, blocks)]);
  Pub.buildPublicHome(deps(d, 1, { sources: undefined }));
  const t0 = performance.now();
  const a = Pub.buildPublicHome(deps(d, 1));
  const ms = performance.now() - t0;
  const b = Pub.buildPublicHome(deps(d, 1));
  assert.equal(a.mode, 'layout');
  assert.deepEqual(a, b, 'determinista');
  console.log(`  buildPublicHome con 2.000 productos y 60 bloques: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1500, `tardó ${ms} ms`);
});
