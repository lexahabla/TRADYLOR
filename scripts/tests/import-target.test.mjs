// Destino de categoría/subcategoría de las fichas NUEVAS en la importación JSON (pegado, archivo o extracción de Apify):
// validación en el servidor, prioridad sobre la categoría de la fuente, trazabilidad, fichas existentes intactas.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, readCatalog, writeCatalog, apiRequest, jsonOf, adminCookie, jsonRecord } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-target-');
const cats = await import('../../src/lib/categories.ts');
cats.writeCategories([
  { id: 'c-audio', name: 'Audio', slug: 'audio', icon: 'A', keywords: ['altavoz'] },
  { id: 'c-info', name: 'Informatica', slug: 'informatica', icon: 'I', keywords: ['portatil'] },
  { id: 'c-hogar', name: 'Hogar', slug: 'hogar', icon: 'H', keywords: ['lampara'] },
  { id: 's-port', name: 'Portatiles', slug: 'portatiles', icon: 'P', keywords: [], parentId: 'c-info' },
  { id: 's-mon', name: 'Monitores', slug: 'monitores', icon: 'M', keywords: [], parentId: 'c-info' },
  { id: 's-bt', name: 'Bluetooth', slug: 'bluetooth', icon: 'B', keywords: [], parentId: 'c-audio' },
]);
cats.invalidateCategoriesCache();

const { resolveImportTarget } = await import('../../src/lib/jsonImport/categoryResolver.ts');
const service = await import('../../src/lib/jsonImport/service.ts');
const route = await import('../../src/pages/api/admin/json-import/index.ts');
const cookie = await adminCookie();

let seq = 0;
const run = (records, { target, defaults = {}, dryRun = false } = {}) =>
  service.processChunk({ batchId: `tgt-test-${++seq}-${Date.now()}`, records, defaults, dryRun, indexOffset: 0, target });
const target = (categoryId, subcategoryId) => resolveImportTarget({ categoryId, subcategoryId }).target;
const post = (body, auth = { cookie }) => route.POST({ request: apiRequest('/api/admin/json-import', { body, ...auth }) });

test('resolveImportTarget: acepta categoría sola y categoría+subcategoría propia; sin destino no hace nada', () => {
  assert.deepEqual(resolveImportTarget(undefined), {});
  assert.deepEqual(resolveImportTarget(null), {});
  assert.deepEqual(resolveImportTarget({ categoryId: '', subcategoryId: '' }), {});
  assert.deepEqual(resolveImportTarget({ categoryId: 'c-hogar' }).target, { category: 'Hogar', categoryId: 'c-hogar' });
  assert.deepEqual(resolveImportTarget({ categoryId: 'c-info', subcategoryId: 's-mon' }).target, { category: 'Informatica', categoryId: 'c-info', subcategoryId: 's-mon', subcategoryName: 'Monitores' });
});

test('resolveImportTarget: rechaza categorías inexistentes, subcategorías de otra categoría y destinos mal formados', () => {
  assert.match(resolveImportTarget({ categoryId: 'nope' }).error, /no existe/);
  assert.match(resolveImportTarget({ categoryId: 's-mon' }).error, /no existe/, 'una subcategoría no vale como categoría raíz');
  assert.match(resolveImportTarget({ categoryId: 'c-audio', subcategoryId: 's-mon' }).error, /no pertenece/);
  assert.match(resolveImportTarget({ categoryId: 'c-info', subcategoryId: 'nope' }).error, /no existe/);
  assert.match(resolveImportTarget({ categoryId: 'c-info', subcategoryId: 'c-audio' }).error, /no existe/, 'una raíz no vale como subcategoría');
  assert.match(resolveImportTarget({ subcategoryId: 's-mon' }).error, /categoría de destino/);
  assert.ok(resolveImportTarget('Audio').error);
  assert.ok(resolveImportTarget([1]).error);
});

test('Ficha NUEVA: el destino manda sobre la categoría de la fuente, fija los ids y conserva la categoría de origen', () => {
  writeCatalog(dir, []);
  const out = run([jsonRecord(1, { category: 'Cocina' })], { target: target('c-info', 's-port') });
  assert.equal(out.results[0].outcome, 'created');
  assert.equal(out.results[0].categoryApplied, 'Informatica › Portatiles');
  const [p] = readCatalog(dir);
  assert.equal(p.category, 'Informatica');
  assert.equal(p.category_id, 'c-info');
  assert.equal(p.subcategory_id, 's-port');
  assert.equal(p.extra.importMeta.sourceCategory, 'Cocina');
  assert.equal(p.ia_status, 'pending', 'asignar el destino no ejecuta IA');
});

test('Categoría sin subcategorías: se importa solo con la categoría principal', () => {
  writeCatalog(dir, []);
  const out = run([jsonRecord(2)], { target: target('c-hogar') });
  assert.equal(out.results[0].outcome, 'created');
  const [p] = readCatalog(dir);
  assert.equal(p.category, 'Hogar');
  assert.equal(p.category_id, 'c-hogar');
  assert.equal(p.subcategory_id, undefined);
});

test('Sin destino rigen las reglas actuales: respeta la categoría de la fuente y, sin ella, va a revisión', () => {
  writeCatalog(dir, []);
  const a = run([jsonRecord(3, { category: 'Audio' })]);
  assert.equal(a.results[0].outcome, 'created');
  assert.equal(a.results[0].categoryApplied, undefined);
  const b = run([jsonRecord(4, { category: undefined })]);
  assert.equal(b.results[0].outcome, 'review');
  assert.deepEqual(b.results[0].reasons, ['sin_categoria']);
  const stored = readCatalog(dir);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].category_id, undefined, 'sin destino no se inventan ids');
  assert.equal(stored[0].extra.importMeta.sourceCategory, undefined);
});

test('Con destino, un registro sin categoría de origen se crea (el destino la aporta) sin trazabilidad inventada', () => {
  writeCatalog(dir, []);
  const out = run([jsonRecord(5, { category: undefined })], { target: target('c-audio', 's-bt') });
  assert.equal(out.results[0].outcome, 'created');
  const [p] = readCatalog(dir);
  assert.equal(p.category, 'Audio');
  assert.equal(p.subcategory_id, 's-bt');
  assert.equal(p.extra.importMeta.sourceCategory, undefined);
});

test('Fichas EXISTENTES: actualizar una oferta o vincular otra NO cambia su categoría ni sus ids', () => {
  writeCatalog(dir, []);
  run([jsonRecord(6, { category: 'Audio' })]);
  const before = readCatalog(dir)[0];
  // El editor manual las movió: categoría e ids propios que el destino no debe pisar.
  writeCatalog(dir, [{ ...before, category: 'Hogar', category_id: 'c-hogar', subcategory_id: undefined }]);
  const tgt = target('c-info', 's-mon');
  // Misma oferta con otro precio → actualiza.
  const upd = run([jsonRecord(6, { price: 11, category: 'Audio' })], { target: tgt });
  assert.equal(upd.results[0].outcome, 'updated');
  assert.equal(upd.results[0].categoryApplied, undefined);
  // Otra oferta de la misma ficha (mismo gtin, otro comercio) → vincula.
  const link = run([jsonRecord(6, { platform: 'otra', externalId: 'O6', url: 'https://otra.invalid/6', price: 25, gtin: before.extra?.identifiers?.gtin })], { target: tgt });
  assert.ok(['linked', 'review', 'unchanged'].includes(link.results[0].outcome));
  const after = readCatalog(dir);
  assert.equal(after.length, 1, 'no se crean fichas nuevas');
  assert.equal(after[0].category, 'Hogar');
  assert.equal(after[0].category_id, 'c-hogar');
  assert.equal(after[0].subcategory_id, undefined);
});

test('Simulación con destino: informa el destino y no escribe nada', () => {
  writeCatalog(dir, []);
  const out = run([jsonRecord(7)], { target: target('c-info', 's-port'), dryRun: true });
  assert.equal(out.results[0].outcome, 'created');
  assert.equal(out.results[0].categoryApplied, 'Informatica › Portatiles');
  assert.equal(readCatalog(dir).length, 0);
});

test('Elemento crudo de Apify: el destino elegido gana a la categoría que deduce el resolvedor', () => {
  writeCatalog(dir, []);
  const raw = {
    asin: 'B0TARGET01', title: 'Portatil Lenovo IdeaPad 15 i5 16GB 512GB', url: 'https://www.amazon.es/dp/B0TARGET01', brand: 'Lenovo',
    breadCrumbs: 'Computers > Portatil', highResolutionImages: ['https://m.media-amazon.com/images/I/aaa._AC_SL1500_.jpg'],
    price: { value: 500, currency: '€' }, seller: { name: 'Amazon' }, inStock: true, offers: [], attributes: [],
    variantAsins: [], variantAttributes: [], variantDetails: [], shippingPrice: null,
  };
  const out = run([raw], { target: target('c-hogar') });
  assert.equal(out.results[0].outcome, 'created', JSON.stringify(out.results[0]));
  const [p] = readCatalog(dir);
  assert.equal(p.category, 'Hogar');
  assert.equal(p.category_id, 'c-hogar');
  assert.ok(p.extra.importMeta.sourceCategory === undefined || typeof p.extra.importMeta.sourceCategory === 'string');
});

test('Endpoint: valida el destino en el servidor (combinación inválida → 400 sin escribir) y acepta uno válido', async () => {
  writeCatalog(dir, []);
  const base = { batchId: 'tgt-route-0001', records: [jsonRecord(8)], defaults: { category: 'Audio' } };
  for (const bad of [{ categoryId: 'nope' }, { categoryId: 'c-audio', subcategoryId: 's-mon' }, { subcategoryId: 's-mon' }, 'Informatica']) {
    const res = await post({ ...base, target: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await jsonOf(res)).success, false);
  }
  assert.equal(readCatalog(dir).length, 0, 'ninguna petición inválida escribió');
  const ok = await post({ ...base, batchId: 'tgt-route-0002', target: { categoryId: 'c-info', subcategoryId: 's-mon' } });
  assert.equal(ok.status, 200);
  const data = await jsonOf(ok);
  assert.equal(data.target.subcategoryName, 'Monitores');
  assert.equal(data.results[0].categoryApplied, 'Informatica › Monitores');
  assert.equal(readCatalog(dir)[0].subcategory_id, 's-mon');
  // Sin destino: respuesta sin `target` y reglas habituales.
  const none = await post({ ...base, batchId: 'tgt-route-0003', records: [jsonRecord(9)] });
  assert.equal(none.status, 200);
  assert.equal((await jsonOf(none)).target, undefined);
});

test('Endpoint: sin autenticación sigue devolviendo 401 aunque lleve destino', async () => {
  const res = await post({ batchId: 'tgt-route-0004', records: [jsonRecord(10)], target: { categoryId: 'c-info' } }, {});
  assert.equal(res.status, 401);
});

test('La asignación de destino no usa IA (sin módulos de IA en el importador)', () => {
  for (const f of ['src/lib/jsonImport/engine.ts', 'src/lib/jsonImport/categoryResolver.ts']) {
    const text = fs.readFileSync(path.join('d:/AXEL/WEBS/TRADYLOR/tradylor_web', f), 'utf8');
    assert.ok(!/from '\.\.\/ai'|openai|anthropic/i.test(text), f);
  }
});
