// Portada editable: historias iniciales. Seis historias con datos REALES del catálogo, siempre como BORRADOR, con el modelo de historias existente,
// sin inventar nada y sin sobrescribir historias existentes.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-stories-initial-');
delete process.env.HOME_LAYOUT_ENABLED;
const IS = await import('../../src/lib/homeLayout/initialStories.ts');
const ST = await import('../../src/lib/homeLayout/stories.ts');
const SS = await import('../../src/lib/homeLayout/storiesStore.ts');
const Pub = await import('../../src/lib/homeLayout/public.ts');
const V = await import('../../src/lib/homeLayout/validate.ts');
const I = await import('../../src/lib/homeLayout/initialLayout.ts');
const Src = await import('../../src/lib/homeLayout/sources.ts');
const route = await import('../../src/pages/api/admin/home-layout/stories-initial.ts');
const auth = await import('../../src/lib/adminAuth.ts');
const users = await import('../../src/lib/userStore.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const f = (n) => path.join(dir, n);
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const B = 'http://localhost/api/admin/home-layout/';
const NOW = new Date('2026-11-13T10:00:00.000Z');

const CATS = [
  { id: 'informatica', name: 'Informática', slug: 'informatica', parentId: null },
  { id: 'portabilidad', name: 'Portabilidad', slug: 'portabilidad', parentId: null },
  { id: 'sonido', name: 'Sonido', slug: 'sonido', parentId: null },
  { id: 'hogar', name: 'Hogar', slug: 'hogar', parentId: null },
  { id: 'portatiles', name: 'Portátiles', slug: 'portatiles', parentId: 'informatica' },
  { id: 'monitores', name: 'Monitores', slug: 'monitores', parentId: 'informatica' },
  { id: 'auriculares', name: 'Auriculares', slug: 'auriculares', parentId: 'sonido' },
];
let n = 0;
const prod = (cat, price, over = {}) => { n++; return { id: `p${n}`, title: `Producto de ${cat} número ${n} con un nombre bastante largo para comprobar el recorte del título en la pantalla`, price, currency: 'EUR', inStock: true, image: `https://cdn.example.com/img/p${n}.jpg`, network: 'amazon', merchant: 'Amazon', category: cat, category_id: cat, ...over }; };
const withDiscount = (p, previous) => ({ ...p, extra: { observations: [{ capturedAt: '2026-11-12T08:00:00Z', verifiedAt: '2026-11-12T08:00:01Z', price: p.price, originalPrice: previous, context: { currency: 'EUR' } }] } });
const input = (products, over = {}) => ({ products, categories: CATS, retiredIds: new Set(), imageOk: () => true, now: NOW, ...over });
const catalog = () => {
  n = 0;
  return [
    prod('informatica', 90, { subcategory_id: 'informatica--portatiles' }), prod('informatica', 250, { subcategory_id: 'informatica--monitores' }), prod('informatica', 600, { subcategory_id: 'informatica--portatiles' }), prod('informatica', 40),
    prod('portabilidad', 1), prod('portabilidad', 2), prod('portabilidad', 3), prod('portabilidad', 4),
    prod('sonido', 5, { subcategory_id: 'auriculares' }), prod('sonido', 6, { subcategory_id: 'auriculares' }), prod('sonido', 7),
    prod('hogar', 60),
    prod('portabilidad', 11), prod('portabilidad', 12), prod('sonido', 13), prod('informatica', 700, { subcategory_id: 'informatica--monitores' }), prod('informatica', 30),
    withDiscount(prod('informatica', 80, { subcategory_id: 'informatica--portatiles' }), 160),
    withDiscount(prod('portabilidad', 9), 12),
  ];
};

test('seis historias en el orden pedido, siempre BORRADOR, con el modelo existente y de 1 a 4 pantallas', () => {
  const r = IS.buildInitialStories(input(catalog()));
  assert.deepEqual(r.stories.map((s) => s.name), ['Informática', 'Portabilidad', 'Sonido', 'Hogar', 'Bajadas de precio', 'Descubre']);
  assert.ok(r.stories.every((s) => s.status === 'borrador'), 'nada se publica');
  assert.ok(r.stories.every((s) => s.screens.length >= 1 && s.screens.length <= 4));
  assert.equal(ST.validateStories(r.stories).ok, true, 'cumple la validación del editor');
  assert.deepEqual(r.report.map((x) => x.status), Array(6).fill('creada'));
  for (const s of r.stories) for (const sc of s.screens) {
    assert.ok(sc.title.length <= 80 && (sc.text ?? '').length <= 200 && (sc.buttonLabel ?? '').length <= 40, `${sc.id}: límites del editor`);
    assert.ok(sc.image.startsWith('https://cdn.example.com/'), 'imagen real del producto');
    assert.ok(sc.link && sc.buttonLabel, `${sc.id}: enlace y botón`);
    assert.equal(sc.duration, 7);
  }
  assert.deepEqual(Object.keys(r.stories[0]).sort(), ['id', 'name', 'screens', 'status'], 'sin campos nuevos');
});

test('sin repeticiones: ningún producto ni imagen se repite entre historias ni dentro de ellas (portadas distintas)', () => {
  const r = IS.buildInitialStories(input(catalog()));
  const images = r.stories.flatMap((s) => s.screens.map((x) => x.image));
  assert.equal(new Set(images).size, images.length, 'imágenes únicas');
  const products = r.stories.flatMap((s) => s.screens.filter((x) => x.link.type === 'product').map((x) => x.link.target));
  assert.equal(new Set(products).size, products.length, 'productos únicos');
  assert.equal(new Set(r.stories.map((s) => s.screens[0].image)).size, 6, 'seis portadas distintas');
});

test('categorías: portada de categoría con enlace a la categoría y productos reales; subcategorías primero; el más económico de cada una', () => {
  const r = IS.buildInitialStories(input(catalog()));
  const inf = r.stories.find((s) => s.id === 'informatica');
  assert.deepEqual([inf.screens[0].link.type, inf.screens[0].link.target, inf.screens[0].buttonLabel], ['category', 'informatica', 'Explorar categoría']);
  assert.match(inf.screens[0].text, /producto/);
  assert.match(inf.screens[0].text, /Portátiles \(\d+\)/, 'usa subcategorías reales («informatica--portatiles»)');
  assert.ok(inf.screens.slice(1).every((x) => x.link.type === 'product' && x.buttonLabel === 'Ver producto'));
  for (const x of inf.screens.slice(1)) assert.match(x.text, /€ en Amazon/);
  assert.match(inf.screens[1].text, /precio del 13\/11\/2026/, 'el precio lleva la fecha del día');
  // precios reales (los de la ficha), con formato español
  const priceOf = (id) => catalog().find((p) => p.id === id).price;
  for (const x of inf.screens.slice(1)) { const num = Number(x.text.split(' €')[0].replace('.', '').replace(',', '.')); assert.equal(num, priceOf(x.link.target)); }
  // el más económico de la subcategoría mayoritaria abre la historia de productos
  assert.ok(!r.stories.find((s) => s.id === 'informatica').screens.some((x) => /Descubre/.test(x.title)));
});

test('una categoría sin productos presentables se omite y se explica; una con un solo producto → una pantalla con su precio real', () => {
  const products = catalog().filter((p) => p.category_id !== 'sonido');
  const r = IS.buildInitialStories(input(products));
  assert.ok(!r.stories.some((s) => s.id === 'sonido'));
  const row = r.report.find((x) => x.id === 'sonido');
  assert.equal(row.status, 'omitida');
  assert.match(row.reason, /Sonido/);
  const hogar = r.stories.find((s) => s.id === 'hogar');
  assert.equal(hogar.screens.length, 1);
  assert.match(hogar.screens[0].text, /60,00 € en Amazon/);
  assert.equal(hogar.screens[0].link.type, 'category');
  // sin ningún producto: nada que crear
  const none = IS.buildInitialStories(input([]));
  assert.deepEqual(none.stories, []);
  assert.ok(none.report.every((x) => x.status === 'omitida'));
});

test('no presentables quedan fuera: retirados, sin stock, sin precio, otra moneda, imagen insegura o inexistente', () => {
  const base = catalog();
  const bad = [
    prod('informatica', 5, { retiredFlag: true }), prod('informatica', 6, { inStock: false }), prod('informatica', 0), prod('informatica', null), prod('informatica', 7, { currency: 'USD' }),
    prod('informatica', 8, { image: 'javascript:alert(1)' }), prod('informatica', 9, { image: '/images/products/no-existe.jpg' }), prod('informatica', 10, { image: 'https://x/y.mp4' }),
  ];
  const retired = new Set([bad[0].id]);
  const r = IS.buildInitialStories(input([...base, ...bad], { retiredIds: retired, imageOk: (img) => !img.includes('no-existe') }));
  const used = new Set(r.stories.flatMap((s) => s.screens.map((x) => x.link.target)));
  for (const b of bad) assert.ok(!used.has(b.id), `${b.id} no debe usarse`);
  assert.equal(ST.validateStories(r.stories).ok, true);
});

test('Bajadas de precio: sólo descuentos VERIFICADOS (observación coherente con el precio), con su precio anterior y su fecha', () => {
  const r = IS.buildInitialStories(input(catalog()));
  const b = r.stories.find((s) => s.id === 'bajadas');
  assert.equal(b.screens.length, 2, 'sólo los dos productos con observación verificada');
  assert.match(b.screens[0].text, /−50 % verificado: 80,00 € \(antes 160,00 €\) en Amazon · verificado el 12\/11\/2026/);
  assert.match(b.screens[1].text, /−25 % verificado: 9,00 € \(antes 12,00 €\)/);
  // «originalPrice» suelto (sin observación verificada) no es descuento
  const loose = catalog().map((p) => ({ ...p, originalPrice: p.price * 2, extra: undefined }));
  const none = IS.buildInitialStories(input(loose));
  assert.ok(!none.stories.some((s) => s.id === 'bajadas'), 'sin bajadas verificadas la historia se omite');
  assert.match(none.report.find((x) => x.id === 'bajadas').reason, /no se inventa/);
  // observación que no corresponde al precio actual → no verificada
  const stale = catalog().map((p) => (p.extra ? { ...p, price: p.price + 5 } : p));
  assert.ok(!IS.buildInitialStories(input(stale)).stories.some((s) => s.id === 'bajadas'));
});

test('Descubre: catálogo, el más económico real, categorías reales; nada inventado', () => {
  const r = IS.buildInitialStories(input(catalog()));
  const d = r.stories.find((s) => s.id === 'descubre');
  assert.deepEqual(d.screens[0].link, { type: 'campaign', target: '/catalogo' });
  assert.match(d.screens[0].text, /\d+ productos de 4 categorías/);
  assert.ok(d.screens.some((x) => x.link.target === '/categorias'));
  const cheap = d.screens.find((x) => /más económico/.test(x.text));
  assert.ok(cheap, 'pantalla del más económico');
  assert.doesNotMatch(JSON.stringify(r.stories), /Lo más buscado|más vendid|valoraci|reseñ|estrellas|★/i, 'sin popularidad, valoraciones ni reseñas');
});

test('el texto es determinista y no depende del azar', () => {
  const a = JSON.stringify(IS.buildInitialStories(input(catalog())).stories);
  const b = JSON.stringify(IS.buildInitialStories(input(catalog())).stories);
  assert.equal(a, b);
});

test('portada independiente: los destinos de categoría de las historias pasan a /catalogo?…; los de la v1 no cambian', () => {
  n = 0; fs.writeFileSync(f('products.json'), JSON.stringify(catalog().map((p) => ({ ...p, slug: p.id, affiliateUrl: 'https://x/', sourceId: p.id, extra: p.extra ?? {} }))));
  fs.writeFileSync(f('categories.json'), JSON.stringify(CATS.map((c) => ({ ...c, icon: '📦', keywords: [] }))));
  fs.writeFileSync(f('sections.json'), '[]'); fs.writeFileSync(f('deleted-product-ids.json'), '[]');
  const r = IS.buildInitialStories(input(catalog()));
  const published = r.stories.map((s) => ({ ...s, status: 'publicada' }));
  const doc = { schemaVersion: 1, draft: { stories: published, updatedAt: '2026-11-13T09:00:00.000Z' } };
  const design = V.validateBlocks(I.buildInitialBlocks(I.deriveInitialContext(Src.loadSources()))).value;
  const v1 = V.validateBlocks(I.LEGACY_V1_BLOCKS).value;
  const deps = { stories: () => ({ status: 'ok', doc, errors: [] }), imageExists: () => true };
  const home = Pub.composeHome(design, { version: 4, publishedAt: 'x' }, deps);
  assert.equal(home.mode, 'layout');
  assert.equal(home.independent, true);
  const hrefs = home.stories.flatMap((s) => s.screens.map((x) => x.href)).filter(Boolean);
  assert.ok(hrefs.some((h) => h.startsWith('/catalogo?category=')), 'categoría → /catalogo?category=…');
  assert.ok(hrefs.every((h) => !h.includes('#destacados') && !h.startsWith('/?')), 'sin anclas antiguas');
  const old = Pub.composeHome(v1, { version: 1, publishedAt: 'x' }, deps);
  assert.equal(old.independent, false);
  assert.ok(old.stories.flatMap((s) => s.screens.map((x) => x.href)).some((h) => h?.startsWith('/?category=')), 'la v1 conserva su enlace de siempre');
  // borrador: no se muestra
  const drafts = { schemaVersion: 1, draft: { stories: r.stories, updatedAt: '2026-11-13T09:00:00.000Z' } };
  assert.deepEqual(Pub.composeHome(design, { version: 4, publishedAt: 'x' }, { ...deps, stories: () => ({ status: 'ok', doc: drafts, errors: [] }) }).stories, [], 'en borrador no aparece en la web');
});

/* ───────── API ───────── */
let adminC; let common;
const get = (...rest) => { const cookie = rest.length ? rest[0] : adminC; return route.GET({ request: new Request(`${B}stories-initial`, { method: 'GET', headers: cookie ? { Cookie: cookie } : {} }) }); };
const post = (payload, opts = {}) => { const { headers = {}, raw } = opts; const cookie = 'cookie' in opts ? opts.cookie : adminC; return route.POST({ request: new Request(`${B}stories-initial`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: raw ?? JSON.stringify(payload) }) }); };
const j = (r) => r.json();
const reset = () => { for (const f2 of fs.readdirSync(dir)) if (/^home-/.test(f2)) fs.rmSync(f(f2), { recursive: true, force: true }); };
const create = { action: 'create_initial', baseRevision: 'inicial', confirm: true };

test('API: permisos, CSRF, tipo, tamaño, 405 — sin escribir', async () => {
  adminC = await adminCookie();
  const master = auth.authenticateUser('tester', 'Test-pass-123');
  users.createUser({ username: 'comun6', password: 'Clave-comun-123', name: 'Común', role: 'user' }, users.toPublicUser(users.findUserById(master.id)));
  common = auth.createAdminSession(auth.authenticateUser('comun6', 'Clave-comun-123')).split(';')[0];
  reset();
  for (const cookie of [undefined, 'tradylor_admin_session=falsa.1.x', common]) { assert.equal((await get(cookie)).status, 401); assert.equal((await post(create, { cookie })).status, 401); }
  assert.equal((await route.ALL({ request: new Request(`${B}stories-initial`, { method: 'PUT', headers: { Cookie: adminC } }) })).status, 405);
  const evil = await route.POST({ request: new Request(`${B}stories-initial`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Layout-Editor': '1', Cookie: adminC, Origin: 'https://evil.example' }, body: JSON.stringify(create) }) });
  assert.equal(evil.status, 403);
  assert.equal((await post(create, { headers: { 'X-Home-Layout-Editor': '0' } })).status, 403);
  assert.equal((await post(create, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post(null, { raw: '{no' })).status, 400);
  assert.equal((await post(null, { raw: JSON.stringify({ x: 'a'.repeat(2000) }) })).status, 413);
  assert.equal((await post({ ...create, confirm: false })).status, 400);
  assert.equal((await post({ ...create, extra: 1 })).status, 400);
  assert.equal((await post({ ...create, action: 'otra' })).status, 400);
  assert.equal(fs.existsSync(f('home-stories.json')), false, 'nada se escribió');
});

test('API: GET calcula con el catálogo real sin escribir; POST crea las historias como borrador y no toca portada, catálogo ni activación', async () => {
  reset();
  const guards = ['products.json', 'categories.json', 'sections.json'].map((x) => sha(f(x)));
  const g = await j(await get());
  assert.equal(g.available, true);
  assert.equal(g.stories.length, 6);
  assert.equal(fs.existsSync(f('home-stories.json')), false, 'GET no escribe');
  const r = await post(create);
  assert.equal(r.status, 200);
  const rb = await j(r);
  assert.deepEqual(rb.created.map((x) => x.name), ['Informática', 'Portabilidad', 'Sonido', 'Hogar', 'Bajadas de precio', 'Descubre']);
  const stored = SS.readStories().doc.draft.stories;
  assert.equal(stored.length, 6);
  assert.ok(stored.every((s) => s.status === 'borrador'));
  assert.deepEqual(['products.json', 'categories.json', 'sections.json'].map((x) => sha(f(x))), guards, 'catálogo, categorías y secciones intactos');
  assert.equal(fs.existsSync(f('home-layout.json')), false, 'no se crea ni toca la portada');
  assert.equal(fs.existsSync(f('home-layout-activation.json')), false);
  // la web no las muestra (borrador)
  assert.deepEqual(Pub.buildPublicHome({ env: { HOME_LAYOUT_ENABLED: 'true' } }).mode, 'legacy');
});

test('API: nunca sobrescribe — con historias existentes → 409 y no cambia nada; archivo protegido → 423', async () => {
  const before = sha(f('home-stories.json'));
  const g = await j(await get());
  assert.deepEqual([g.available, g.reason], [false, 'ya_hay_historias']);
  const r = await post({ ...create, baseRevision: (await j(await get())).revision });
  assert.equal(r.status, 409);
  assert.equal(sha(f('home-stories.json')), before);
  fs.writeFileSync(f('home-stories.json'), '{ roto');
  const dmg = await j(await get());
  assert.deepEqual([dmg.available, dmg.reason], [false, 'archivo_protegido']);
  assert.equal((await post(create)).status, 423);
  assert.equal(fs.readFileSync(f('home-stories.json'), 'utf8'), '{ roto');
  // revisión obsoleta
  fs.rmSync(f('home-stories.json'));
  assert.equal((await post({ ...create, baseRevision: '2020-01-01T00:00:00.000Z' })).status, 409);
  assert.equal(fs.existsSync(f('home-stories.json')), false);
});

test('estático: el editor ofrece la carga sólo sin historias, con confirmación; el visor encuadra la imagen entera', () => {
  const ui = code('src/scripts/homeLayoutStories.ts');
  assert.match(ui, /stories-initial', \{ method: 'POST'/);
  assert.match(ui, /confirm: true/);
  assert.match(ui, /if \(!S\.loaded \|\| !ini \|\| S\.stories\.length\) return null;/);
  assert.match(ui, /Crear las historias iniciales como borrador…/);
  assert.doesNotMatch(ui, /innerHTML|outerHTML|insertAdjacentHTML|\beval\(/);
  const api = code('src/pages/api/admin/home-layout/stories-initial.ts');
  assert.match(api, /requireAdminAuth/);
  assert.match(api, /sameOrigin/);
  assert.match(api, /ya_hay_historias/);
  assert.doesNotMatch(api, /fetch\(|writeHomeLayout|writeActivation|writeDraftBackups|status: 'publicada'/);
  const pure = code('src/lib/homeLayout/initialStories.ts');
  assert.doesNotMatch(pure, /node:fs|fetch\(|process\.env|Math\.random/);
  assert.doesNotMatch(pure, /status: 'publicada'/);
  const css = read('src/components/home/HomeStories.astro');
  assert.match(css, /object-fit: contain; border-radius: 18px/);
});
