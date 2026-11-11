// Subcategorías sin icono de carpeta, migas «INICIO / CATEGORÍA PADRE / SUBCATEGORÍA», biblioteca de iconos por palabra y palabras
// clave generadas automáticamente. Sin red ni IA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupIsolatedData } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-cat-icons-');
const lib = await import('../../src/lib/iconLibrary.ts');
const cats = await import('../../src/lib/categories.ts');
const route = await import('../../src/pages/api/admin/icon-library.ts');
const { adminCookie, apiRequest } = await import('./_helpers.mjs');

const read = (p) => fs.readFileSync('d:/AXEL/WEBS/TRADYLOR/tradylor_web/' + p, 'utf8');

/* ───────────── Subcategorías sin carpeta ───────────── */

test('una subcategoría nunca lleva el icono de carpeta (ni por defecto ni las ya guardadas con él)', () => {
  const root = cats.createCategory({ name: 'Informática test', icon: '💻', keywords: [] });
  assert.equal(root.ok, true);
  const rootId = root.category.id;
  const sub = cats.createCategory({ name: 'Portátiles test', keywords: [], parentId: rootId });
  assert.equal(sub.ok, true);
  assert.equal(sub.category.icon, '', 'sin icono por defecto (antes 📂)');
  const folder = cats.createCategory({ name: 'Cables test', icon: '📂', keywords: [], parentId: rootId });
  assert.equal(folder.category.icon, '', 'aunque se pida la carpeta explícitamente');
  const withIcon = cats.createCategory({ name: 'Monitores test', icon: '🖥️', keywords: [], parentId: rootId });
  assert.equal(withIcon.category.icon, '🖥️', 'un icono propio se respeta');
  const rootDefault = cats.createCategory({ name: 'Sin icono test', keywords: [] });
  assert.equal(rootDefault.category.icon, '📦', 'las raíces conservan su icono por defecto');
});

test('las subcategorías antiguas guardadas con 📂/📁 se leen sin icono (todas las representaciones)', () => {
  const all = cats.getCategories();
  const root = all.find((c) => !c.parentId);
  const raw = all.map((c) => ({ ...c }));
  raw.push({ id: 'legacy-sub', name: 'Legado', slug: 'legacy-sub', icon: '📂', keywords: [], parentId: root.id });
  raw.push({ id: 'legacy-sub2', name: 'Legado 2', slug: 'legacy-sub2', icon: '📁', keywords: [], parentId: root.id });
  cats.writeCategories(raw);
  cats.invalidateCategoriesCache();
  const after = cats.getCategories();
  assert.equal(after.find((c) => c.slug === 'legacy-sub').icon, '');
  assert.equal(after.find((c) => c.slug === 'legacy-sub2').icon, '');
  const updated = cats.updateCategory('legacy-sub', { name: 'Legado', keywords: [], parentId: root.id });
  assert.equal(updated.ok, true);
  assert.equal(cats.getCategories().find((c) => c.name === 'Legado').icon, '', 'al editar sin icono sigue sin carpeta');
});

test('una palabra escrita en el campo Icono no se guarda como icono', () => {
  const r = cats.createCategory({ name: 'Palabra test', icon: 'cafetera', keywords: [] });
  assert.equal(r.category.icon, '📦');
  const e = cats.createCategory({ name: 'Emoji test', icon: '☕', keywords: [] });
  assert.equal(e.category.icon, '☕');
});

test('la web pública no pinta icono en subcategorías (menú de categorías, listado y tabla de administración)', () => {
  // Panel de categorías rediseñado: las SUBCATEGORÍAS son enlaces de texto (sin icono); sólo las categorías principales llevan icono.
  const layout = read('src/layouts/Layout.astro');
  assert.ok(layout.includes('class="cm2-sub-link"') && !layout.includes('sub.icon') && !layout.includes('cat-sub-icon">${'));
  assert.ok(layout.includes('class="cm2-root-icon"'));
  assert.ok(read('src/pages/upayp1b4.astro').includes("category.icon || (isSub ? '' : '📦')"));
});

/* ───────────── Migas ───────────── */

test('migas: INICIO / CATEGORÍA y, en una subcategoría, INICIO / CATEGORÍA PADRE / SUBCATEGORÍA con enlaces', () => {
  const index = read('src/pages/index.astro');
  assert.ok(index.includes('const parentCategory = activeCategory?.parentId'));
  assert.ok(index.includes('href={`/?category=${encodeURIComponent(parentCategory.slug)}#catalogo`} class="section-crumb-link">{parentCategory.name}</a>'));
  assert.ok(index.includes('<span aria-current="page">{activeCategory.name}</span>'));
});

/* ───────────── Biblioteca de iconos ───────────── */

test('al escribir una palabra se proponen emojis relacionados (con tildes, plurales y sinónimos)', () => {
  const first = (q) => lib.searchIcons(q)[0]?.emoji;
  assert.equal(first('café'), '☕');
  assert.equal(first('cafe'), '☕', 'sin tilde');
  assert.equal(first('cafetera'), '☕');
  assert.equal(first('portátil'), '💻');
  assert.equal(first('portatiles'), '💻', 'plural');
  assert.equal(first('auriculares'), '🎧');
  assert.equal(first('Gaming'), '🎮');
  assert.equal(first('bicicleta'), '🚲');
  assert.ok(lib.searchIcons('cocina').some((i) => i.emoji === '🍳'));
  const cafe = lib.searchIcons('café').map((i) => i.emoji);
  assert.equal(cafe[0], '☕');
  assert.ok(cafe.length >= 2 && cafe.includes('🍵'), 'amplía con iconos relacionados (té, infusiones…)');
  assert.deepEqual(lib.searchIcons('zzzxqv'), [], 'sin relación no se inventa nada');
  assert.deepEqual(lib.searchIcons('🍳'), [], 'un emoji ya elegido no se busca como palabra');
  assert.deepEqual(lib.searchIcons(''), []);
  const emojis = lib.searchIcons('fuego').map((i) => i.emoji);
  assert.equal(new Set(emojis).size, emojis.length, 'sin emojis repetidos');
});

test('palabras clave generadas: la palabra (con y sin tilde, singular y plural) + términos del icono', () => {
  const kw = lib.suggestKeywords('portátil');
  assert.ok(kw.includes('portátil') && kw.includes('portatil'), 'variante con y sin tilde');
  assert.ok(kw.includes('laptop') && kw.includes('ordenador'), 'términos relacionados del icono');
  assert.ok(kw.includes('portátiles') || kw.includes('portatiles') || kw.includes('portatils'), 'plural');
  assert.ok(kw.length <= 14);
  assert.equal(new Set(kw).size, kw.length, 'sin duplicados');
  assert.ok(kw.every((k) => k === k.toLowerCase() && k.length >= 3));
  const chosen = lib.suggestKeywords('cocina', '🍳');
  assert.ok(chosen.includes('cocina') && chosen.includes('sartén'), 'con icono elegido se usan sus términos');
  assert.deepEqual(lib.suggestKeywords(''), []);
  assert.deepEqual(lib.suggestKeywords('☕'), [], 'sin letras no se generan palabras clave');
});

test('/api/admin/icon-library exige sesión de administrador y devuelve iconos y palabras clave', async () => {
  const anon = await route.GET({ request: apiRequest('/api/admin/icon-library?q=cafe'), url: new URL('http://localhost/api/admin/icon-library?q=cafe') });
  assert.equal(anon.status, 401);
  const cookie = await adminCookie();
  const url = new URL('http://localhost/api/admin/icon-library?q=caf%C3%A9');
  const res = await route.GET({ request: new Request(url, { headers: { cookie } }), url });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.icons[0].emoji, '☕');
  assert.ok(body.keywords.includes('café') && body.keywords.includes('cafetera'));
});

test('formulario de categorías y de subcategoría: paleta de iconos y generación automática de palabras clave', () => {
  const panel = read('src/pages/upayp1b4.astro');
  assert.ok(panel.includes('id="catIconPalette"') && panel.includes('id="createSubcatIconPalette"'));
  assert.ok(panel.includes('function wireIconLibrary(') && panel.includes('/api/admin/icon-library?q='));
  assert.ok(panel.includes("wireIconLibrary(catName, catIcon, catKeywords"));
  assert.ok(panel.includes("kwEl.dataset.autoValue") && panel.includes('kwFree'), 'no pisa palabras clave escritas a mano');
  assert.ok(panel.includes('aria-label', 'Usar el icono') || panel.includes("'Usar el icono '"), 'botones accesibles');
  assert.ok(panel.includes('.icon-opt { width: 44px; height: 44px;'), 'objetivos táctiles de 44 px');
});
