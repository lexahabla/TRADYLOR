// Portada editable · etapa 1: modelo y validación, almacenamiento atómico con copia y recuperación, respaldo (siempre portada actual),
// endpoint de solo lectura (acceso admin) y compatibilidad con `sections.json` y la portada pública. Datos aislados, sin red.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie, apiRequest, jsonOf } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-layout-');
delete process.env.HOME_LAYOUT_ENABLED;
const V = await import('../../src/lib/homeLayout/validate.ts');
const S = await import('../../src/lib/homeLayout/store.ts');
const T = await import('../../src/lib/homeLayout/types.ts');
const sectionsLib = await import('../../src/lib/sections.ts');
const route = await import('../../src/pages/api/admin/home-layout/index.ts');
const auth = await import('../../src/lib/adminAuth.ts');
const users = await import('../../src/lib/userStore.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const file = path.join(dir, 'home-layout.json');
// Código sin comentarios (las cabeceras documentan «sections.json» o «categories.json» y no son dependencias).
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const manual = (over = {}) => ({ id: 'b1', modality: 'manual', format: 'carrusel', width: 12, title: 'Destacados', card: 'producto', config: {}, refs: [{ kind: 'product', id: 'amazon-b0abc' }], visible: true, ...over });
const auto = (over = {}) => ({ id: 'b2', modality: 'automatica', format: 'cuadricula2x2', width: 6, title: 'Sonido', card: 'producto', config: { rules: { categoryId: 'sonido', order: 'precio_asc', limit: 4 } }, refs: [], visible: true, ...over });
const seccion = (over = {}) => ({ id: 'b3', modality: 'seccion', format: 'carrusel', width: 12, title: 'Mi sección', card: 'producto', config: {}, refs: [{ kind: 'section', id: 'mejores-auriculares' }], visible: true, ...over });
const editorial = (over = {}) => ({ id: 'b4', modality: 'editorial', format: 'banner', width: 6, title: 'Campaña', card: 'promocion', config: { headline: 'Guía de portátiles', text: 'Elige bien', buttonLabel: 'Leer', link: { type: 'path', target: '/?category=informatica' } }, refs: [], visible: true, ...over });
const docWith = (blocks) => ({ ...V.emptyDocument(), draft: { blocks, updatedAt: '2026-11-10T10:00:00.000Z' } });

/* ───────── Modelo y validación ───────── */
test('las cuatro modalidades provisionales validan y se mantienen separadas de formato, ancho y tarjeta', () => {
  assert.deepEqual([...T.MODALITIES], ['manual', 'automatica', 'seccion', 'editorial']);
  assert.deepEqual([...T.WIDTHS], [3, 4, 6, 8, 9, 12]);
  for (const b of [manual(), auto(), seccion(), editorial()]) {
    const r = V.validateBlock(b);
    assert.ok(r.ok, JSON.stringify(r.errors));
    assert.equal(r.value.modality, b.modality);
  }
  // la misma modalidad con otro formato/ancho sigue siendo válida (son ejes independientes)
  assert.ok(V.validateBlock(manual({ format: 'banner', width: 3 })).ok);
  assert.ok(V.validateBlock(manual({ format: 'cuadricula2x2', width: 9, refs: [{ kind: 'product', id: 'a' }] })).ok);
});

test('rechaza modalidad, formato, ancho, tarjeta o campos desconocidos', () => {
  for (const bad of [{ modality: 'mixta' }, { format: 'mosaico' }, { width: 5 }, { width: '12' }, { card: 'oferta' }, { visible: 'si' }, { extra: 1 }, { id: '../x' }, { id: '' }, { title: 'x'.repeat(121) }]) {
    assert.equal(V.validateBlock(manual(bad)).ok, false, JSON.stringify(bad));
  }
  assert.equal(V.validateBlock(null).ok, false);
  assert.equal(V.validateBlock([]).ok, false);
});

test('manual: tarjetas y referencias coherentes, sin duplicados ni exceso (la cuadrícula 2×2 admite 4)', () => {
  assert.equal(V.validateBlock(manual({ refs: [] })).ok, false, 'sin elementos');
  assert.equal(V.validateBlock(manual({ refs: [{ kind: 'category', id: 'sonido' }] })).ok, false, 'tarjeta de producto con una categoría');
  assert.ok(V.validateBlock(manual({ card: 'categoria', refs: [{ kind: 'category', id: 'sonido' }] })).ok);
  assert.ok(V.validateBlock(manual({ card: 'promocion', refs: [{ kind: 'promotion', id: 'black-friday' }] })).ok);
  assert.equal(V.validateBlock(manual({ refs: [{ kind: 'product', id: 'a' }, { kind: 'product', id: 'a' }] })).ok, false, 'repetidos');
  const five = Array.from({ length: 5 }, (_, i) => ({ kind: 'product', id: `p${i}` }));
  assert.equal(V.validateBlock(manual({ format: 'cuadricula2x2', refs: five })).ok, false, '2×2 máx. 4');
  assert.ok(V.validateBlock(manual({ format: 'carrusel', refs: five })).ok);
  assert.equal(V.validateBlock(manual({ refs: [{ kind: 'product', id: '<script>' }] })).ok, false, 'id con marcado');
  assert.equal(V.validateBlock(manual({ config: { x: 1 } })).ok, false, 'sin configuración');
});

test('automática: solo criterios con datos fiables; descuentos, bajadas, popularidad y ventas se rechazan', () => {
  assert.ok(V.validateBlock(auto({ config: { rules: { categoryId: 'a', subcategoryId: 'b', merchant: 'eBay', order: 'recientes', limit: 8, onlyWithPrice: true } }, format: 'carrusel' })).ok);
  assert.equal(V.validateBlock(auto({ config: { rules: { categoryId: 'a', order: 'precio_desc', limit: 4 } } })).value.config.rules.order, 'precio_desc');
  for (const key of ['discount', 'descuento', 'priceDrop', 'popularity', 'ventas', 'trending']) {
    const r = V.validateBlock(auto({ config: { rules: { order: 'precio_asc', limit: 4, [key]: true } } }));
    assert.equal(r.ok, false, key);
    assert.match(r.errors.join(' '), /no permitido|datos verificables/, key);
  }
  assert.equal(V.validateBlock(auto({ config: { rules: { order: 'mas_vendidos', limit: 4 } } })).ok, false, 'orden por ventas');
  assert.equal(V.validateBlock(auto({ config: { rules: { order: 'recientes', limit: 5 } } })).ok, false, '2×2 máx. 4');
  assert.equal(V.validateBlock(auto({ config: { rules: { order: 'recientes', limit: 4, desconocido: 1 } } })).ok, false);
  assert.equal(V.validateBlock(auto({ config: { rules: { subcategoryId: 'x', order: 'recientes', limit: 2 } } })).ok, false, 'subcategoría sin categoría');
  assert.equal(V.validateBlock(auto({ refs: [{ kind: 'product', id: 'a' }] })).ok, false, 'sin referencias manuales');
  assert.equal(V.validateBlock(auto({ card: 'categoria' })).ok, false);
});

test('sección: exactamente una referencia a una sección (por id, sin copiar productos)', () => {
  assert.equal(V.validateBlock(seccion({ refs: [] })).ok, false);
  assert.equal(V.validateBlock(seccion({ refs: [{ kind: 'section', id: 'a' }, { kind: 'section', id: 'b' }] })).ok, false);
  assert.equal(V.validateBlock(seccion({ refs: [{ kind: 'product', id: 'a' }] })).ok, false);
  assert.equal(V.validateBlock(seccion({ config: { productIds: ['a'] } })).ok, false, 'no copia productos');
});

test('editorial: titular obligatorio, enlaces seguros y sin referencias de catálogo', () => {
  assert.equal(V.validateBlock(editorial({ config: { headline: '' } })).ok, false);
  assert.equal(V.validateBlock(editorial({ config: { headline: 'x'.repeat(121) } })).ok, false);
  assert.ok(V.validateBlock(editorial({ config: { headline: 'Solo texto' } })).ok);
  assert.ok(V.validateBlock(editorial({ config: { headline: 'H', buttonLabel: 'Ver', link: { type: 'url', target: 'https://example.com/x' }, imageUrl: 'https://cdn.example.com/a.jpg' } })).ok);
  for (const link of [{ type: 'url', target: 'javascript:alert(1)' }, { type: 'url', target: 'http://x.com' }, { type: 'path', target: '//evil.com' }, { type: 'path', target: 'sin-barra' }, { type: 'otro', target: '/x' }]) {
    assert.equal(V.validateBlock(editorial({ config: { headline: 'H', buttonLabel: 'Ver', link } })).ok, false, JSON.stringify(link));
  }
  assert.equal(V.validateBlock(editorial({ config: { headline: 'H', imageUrl: 'data:image/png;base64,AAAA' } })).ok, false);
  assert.equal(V.validateBlock(editorial({ config: { headline: 'H', link: { type: 'path', target: '/x' } } })).ok, false, 'enlace sin texto de botón');
  assert.equal(V.validateBlock(editorial({ refs: [{ kind: 'product', id: 'a' }] })).ok, false);
});

test('documento: bloques con id único, límites y esquema; vacío por defecto y con la portada nueva desactivada', () => {
  const empty = V.emptyDocument();
  assert.equal(empty.activation.enabled, false);
  assert.equal(empty.published, null);
  assert.ok(V.validateDocument(empty).ok);
  assert.ok(V.validateDocument(docWith([manual(), auto(), seccion(), editorial()])).ok);
  assert.equal(V.validateDocument(docWith([manual(), manual()])).ok, false, 'ids repetidos');
  assert.equal(V.validateDocument({ ...empty, schemaVersion: 2 }).ok, false);
  assert.equal(V.validateDocument({ ...empty, activation: { enabled: 'si' } }).ok, false);
  assert.equal(V.validateDocument({ ...empty, published: { version: 0, publishedAt: 'x', blocks: [] } }).ok, false);
  assert.equal(V.validateDocument({ ...empty, versions: 'no' }).ok, false);
  const many = Array.from({ length: V.MAX_BLOCKS + 1 }, (_, i) => manual({ id: `b${i}` }));
  assert.equal(V.validateDocument(docWith(many)).ok, false);
  // un bloque nuevo (nueva modalidad) sólo requiere registrarlo: los registros son datos, no código del editor
  assert.deepEqual(Object.keys(V.MODALITY_REGISTRY).sort(), ['automatica', 'editorial', 'manual', 'seccion']);
  assert.deepEqual(Object.keys(V.FORMAT_REGISTRY).sort(), ['banner', 'carrusel', 'cuadricula2x2']);
});

/* ───────── Almacenamiento ───────── */
test('leer no escribe ni crea archivos: sin archivo = documento vacío y seguro', () => {
  assert.equal(fs.existsSync(file), false);
  const r = S.readHomeLayout();
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.doc, V.emptyDocument());
  assert.equal(fs.existsSync(file), false, 'leer no crea home-layout.json');
  assert.equal(fs.existsSync(`${file}.bak`), false);
});

test('escritura atómica: guarda y valida; la segunda escritura deja la anterior en .bak; sin temporales', () => {
  assert.deepEqual(S.writeHomeLayout(docWith([manual()])), { ok: true });
  assert.equal(S.readHomeLayout().status, 'ok');
  assert.equal(S.readHomeLayout().doc.draft.blocks.length, 1);
  const first = sha(file);
  assert.equal(fs.existsSync(`${file}.bak`), false, 'primera escritura: no había nada que respaldar');
  assert.deepEqual(S.writeHomeLayout(docWith([manual(), auto()])), { ok: true });
  assert.equal(sha(`${file}.bak`), first, 'el .bak es la versión anterior exacta');
  assert.equal(S.readHomeLayout().doc.draft.blocks.length, 2);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'sin archivos temporales');
});

test('un documento inválido NO se guarda y el archivo anterior queda intacto', () => {
  const before = sha(file);
  const r = S.writeHomeLayout(docWith([manual({ width: 5 })]));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'documento_invalido');
  assert.equal(sha(file), before);
  assert.equal(S.writeHomeLayout({ basura: true }).ok, false);
});

test('un fallo al escribir no destruye el archivo existente ni deja temporales', () => {
  const before = sha(file);
  const real = fs.renameSync;
  fs.renameSync = () => { throw new Error('disco lleno (simulado)'); };
  let r;
  try { r = S.writeHomeLayout(docWith([manual()])); } finally { fs.renameSync = real; }
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error_escritura');
  assert.equal(sha(file), before, 'el original sigue intacto');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('archivo corrupto: se detecta, NO se sobrescribe y se conserva para diagnóstico', () => {
  fs.writeFileSync(file, '{ "schemaVersion": 1, "draft": ');
  const corruptSha = sha(file);
  const r = S.readHomeLayout();
  assert.equal(r.status, 'corrupt');
  assert.deepEqual(r.doc, V.emptyDocument(), 'mientras tanto se trabaja con un documento vacío seguro');
  const w = S.writeHomeLayout(docWith([manual()]));
  assert.equal(w.ok, false);
  assert.equal(w.reason, 'archivo_protegido');
  assert.equal(sha(file), corruptSha, 'el original corrupto sigue intacto');
  // JSON válido pero con datos inválidos o de un esquema más nuevo: mismo trato
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, activation: { enabled: false }, draft: { blocks: [{ id: 'x' }], updatedAt: null }, published: null, versions: [] }));
  assert.equal(S.readHomeLayout().status, 'invalid');
  assert.equal(S.writeHomeLayout(docWith([manual()])).reason, 'archivo_protegido');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99 }));
  assert.equal(S.readHomeLayout().status, 'newer');
  assert.equal(S.writeHomeLayout(docWith([manual()])).reason, 'archivo_protegido');
});

test('recuperación EXPLÍCITA desde .bak: conserva antes una copia del archivo dañado y restaura la versión válida', () => {
  fs.writeFileSync(file, 'esto no es json');
  const dañado = sha(file);
  const bakDoc = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
  const r = S.recoverHomeLayoutFromBackup();
  assert.deepEqual(r, { ok: true, preservedCorrupt: true });
  const copies = fs.readdirSync(dir).filter((f) => f.startsWith('home-layout.corrupt-'));
  assert.equal(copies.length, 1);
  assert.equal(sha(path.join(dir, copies[0])), dañado, 'la copia de diagnóstico es el archivo dañado exacto');
  assert.equal(S.readHomeLayout().status, 'ok');
  assert.deepEqual(S.readHomeLayout().doc, V.validateDocument(bakDoc).value);
  // sin copia válida no hace nada
  fs.rmSync(`${file}.bak`);
  assert.equal(S.recoverHomeLayoutFromBackup().ok, false);
});

/* ───────── Respaldo: la portada actual es la única activa ───────── */
test('resolveHomeMode() devuelve SIEMPRE la portada actual en la etapa 1, aunque haya configuración y variable de entorno', () => {
  assert.equal(S.HOME_LAYOUT_STAGE_ENABLED, false);
  assert.equal(S.resolveHomeMode(), 'legacy');
  const published = { version: 1, publishedAt: '2026-11-10T10:00:00.000Z', blocks: [manual()] };
  S.writeHomeLayout({ ...V.emptyDocument(), activation: { enabled: true }, published });
  process.env.HOME_LAYOUT_ENABLED = 'true';
  try { assert.equal(S.resolveHomeMode(), 'legacy', 'candado del código cerrado'); } finally { delete process.env.HOME_LAYOUT_ENABLED; }
});

test('la lógica de respaldo vuelve a la portada actual ante cualquier duda (probada con el candado abierto sólo en la prueba)', () => {
  const ok = { status: 'ok', doc: { ...V.emptyDocument(), activation: { enabled: true }, published: { version: 1, publishedAt: '2026-11-10T10:00:00.000Z', blocks: [manual()] } }, errors: [] };
  const env = { HOME_LAYOUT_ENABLED: 'true' };
  assert.equal(S.evaluateHomeMode(ok, env, true), 'layout', 'sólo con TODAS las condiciones');
  assert.equal(S.evaluateHomeMode(ok, env, false), 'legacy', 'candado del código');
  assert.equal(S.evaluateHomeMode(ok, {}, true), 'legacy', 'sin variable de entorno');
  assert.equal(S.evaluateHomeMode(ok, { HOME_LAYOUT_ENABLED: 'false' }, true), 'legacy');
  assert.equal(S.evaluateHomeMode({ ...ok, doc: { ...ok.doc, activation: { enabled: false } } }, env, true), 'legacy', 'desactivada');
  assert.equal(S.evaluateHomeMode({ ...ok, doc: { ...ok.doc, published: null } }, env, true), 'legacy', 'sin portada publicada');
  assert.equal(S.evaluateHomeMode({ ...ok, doc: { ...ok.doc, published: { version: 1, publishedAt: 'x', blocks: [] } } }, env, true), 'legacy', 'publicada vacía');
  for (const status of ['missing', 'corrupt', 'invalid', 'newer']) assert.equal(S.evaluateHomeMode({ ...ok, status }, env, true), status && 'legacy', status);
  assert.equal(S.evaluateHomeMode(null, env, true), 'legacy', 'entrada rota');
});

/* ───────── Endpoint de solo lectura y acceso ───────── */
test('GET /api/admin/home-layout: sólo administradores (sin sesión y usuario común reciben 401)', async () => {
  const anon = await route.GET({ request: apiRequest('/api/admin/home-layout', { method: 'GET' }) });
  assert.equal(anon.status, 401);
  const master = auth.authenticateUser('tester', 'Test-pass-123');
  const actor = users.toPublicUser ? users.toPublicUser(users.findUserById(master.id)) : master;
  users.createUser({ username: 'comun1', password: 'Clave-comun-123', name: 'Usuario común', role: 'user' }, actor);
  const common = auth.createAdminSession(auth.authenticateUser('comun1', 'Clave-comun-123')).split(';')[0];
  const res = await route.GET({ request: apiRequest('/api/admin/home-layout', { method: 'GET', cookie: common }) });
  assert.equal(res.status, 401, 'un usuario sin rol admin no accede');
  const forged = await route.GET({ request: apiRequest('/api/admin/home-layout', { method: 'GET', cookie: 'tradylor_admin_session=falsa.1.x' }) });
  assert.equal(forged.status, 401);
});

test('GET con administrador: lectura, portada actual servida, sin rutas ni datos sensibles, sin escribir', async () => {
  fs.rmSync(file, { force: true }); fs.rmSync(`${file}.bak`, { force: true });
  const before = fs.readdirSync(dir).sort().join();
  const res = await route.GET({ request: apiRequest('/api/admin/home-layout', { method: 'GET', cookie: await adminCookie() }) });
  const body = await jsonOf(res);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(body.mode, 'legacy');
  assert.equal(body.status, 'missing');
  assert.equal(body.activation.enabled, false);
  assert.deepEqual(body.catalog.modalities.map((m) => m.id), ['manual', 'automatica', 'seccion', 'editorial']);
  assert.equal(body.catalog.provisional, true);
  assert.doesNotMatch(JSON.stringify(body), /[A-Za-z]:\\|\/tmp\/|treidilor-home-layout|password|token|secret/i);
  assert.equal(fs.readdirSync(dir).sort().join(), before, 'el GET no crea ni modifica archivos');
  assert.equal(typeof route.POST, 'undefined');
  assert.equal(typeof route.PUT, 'undefined');
  assert.equal(typeof route.DELETE, 'undefined');
});

test('con un archivo corrupto el endpoint informa del estado sin tocar el archivo', async () => {
  fs.writeFileSync(file, '{ roto');
  const before = sha(file);
  const body = await jsonOf(await route.GET({ request: apiRequest('/api/admin/home-layout', { method: 'GET', cookie: await adminCookie() }) }));
  assert.equal(body.status, 'corrupt');
  assert.equal(body.mode, 'legacy');
  assert.equal(sha(file), before);
  fs.rmSync(file, { force: true });
});

/* ───────── Integración administrativa, compatibilidad y portada pública intacta ───────── */
test('la página exige sesión y rol admin, reutiliza el backend existente y no escribe al cargar', () => {
  const page = read('src/pages/upayp1b4/portada.astro');
  assert.match(page, /getSessionUser\(Astro\.request\)/);
  assert.match(page, /if \(!sessionUser\) return Astro\.redirect\('\/upayp1b4'\)/);
  assert.match(page, /sessionUser\.role !== 'admin'\) return Astro\.redirect\('\/upayp1b4\/perfil'\)/);
  for (const c of ['AdminNav', 'AdminSectionHeader', 'AdminUserMenu', 'Layout']) assert.match(page, new RegExp(`import ${c} from`), c);
  assert.doesNotMatch(page, /writeHomeLayout|recoverHomeLayoutFromBackup|writeFileSync|fetch\(/);
  assert.match(read('src/middleware.ts'), /startsWith\('\/upayp1b4\/'\) && !getSessionUser/);
});

test('el menú del backend incluye «Portada» como enlace a su ruta, sin tocar el resto de entradas', () => {
  const nav = read('src/components/AdminNav.astro');
  assert.match(nav, /\{ id: 'portada', label: 'Portada', href: '\/upayp1b4\/portada' \}/);
  for (const l of ['Catálogo', 'Importar', 'Categorías', 'Transparencia', 'Desarrollo IA', 'Tráfico y ventas', 'Marketing']) assert.match(nav, new RegExp(`label: '${l}'`), l);
});

test('compatibilidad con las secciones existentes: home-layout.json es independiente y sections.json no se toca', () => {
  const sectionsFile = path.join(dir, 'sections.json');
  const sections = [{ id: 'mejores-auriculares', title: 'Mejores auriculares', productIds: ['a', 'b'], published: true, order: 0, position: 'below', speed: 'normal', createdAt: '2026-11-01T00:00:00.000Z' }];
  fs.writeFileSync(sectionsFile, JSON.stringify(sections, null, 2));
  const before = sha(sectionsFile);
  S.writeHomeLayout(docWith([seccion(), manual()]));
  S.writeHomeLayout(docWith([seccion()]));
  S.readHomeLayout();
  assert.equal(sha(sectionsFile), before, 'sections.json intacto');
  assert.notEqual(S.layoutFile(), sectionsFile);
  // las secciones existentes siguen leyéndose igual y la referencia por id no copia productos
  assert.deepEqual(sectionsLib.readSections().map((s) => s.id), ['mejores-auriculares']);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(stored.draft.blocks[0].refs, [{ kind: 'section', id: 'mejores-auriculares' }]);
  assert.doesNotMatch(JSON.stringify(stored), /"productIds"/);
  // el módulo nuevo no importa ni escribe sections.json
  for (const f of ['types', 'validate', 'store']) assert.doesNotMatch(code(`src/lib/homeLayout/${f}.ts`), /lib\/sections|from '\.\.\/sections'|sections\.json/);
});

test('la portada pública no consulta el módulo nuevo y el almacenamiento no toca el catálogo', () => {
  const index = read('src/pages/index.astro');
  assert.doesNotMatch(index, /homeLayout|home-layout|resolveHomeMode/);
  for (const f of ['src/layouts/Layout.astro', 'src/lib/sections.ts', 'src/lib/catalog.ts', 'src/lib/productStore.ts', 'src/middleware.ts']) assert.doesNotMatch(read(f), /homeLayout|home-layout/, f);
  const src = ['types', 'validate', 'store'].map((f) => code(`src/lib/homeLayout/${f}.ts`)).join('\n');
  assert.doesNotMatch(src, /products\.json|productStore|categories\.json|credentials|fetch\(/);
});
