// Regresión: un formulario abierto ANTES de una actualización ajena (p. ej. de precio) no debe pisarla con campos que
// el usuario no editó; si ambos editan el mismo campo se detecta el conflicto y no se sobrescribe en silencio.
// Cubre products/add (el «Guardar cambios» real del panel) y add-product. Sin red, sin claves, datos aislados.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupIsolatedData, adminCookie, apiRequest, jsonOf, mockFetch, readCatalog, writeCatalog, jsonRecord, importRecords } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-form-');
const cookie = await adminCookie();
const addRoute = await import('../../src/pages/api/products/add.ts');
const addProductRoute = await import('../../src/pages/api/admin/add-product.ts');
const importer = await import('../../src/lib/jsonImport/service.ts');
const forms = await import('../../src/lib/formConflicts.ts');
const normalize = await import('../../src/lib/jsonImport/normalize.ts');

const sync = (records) => importer.processChunk({ batchId: 'fm-' + Math.random().toString(36).slice(2, 9), records, defaults: { category: 'Audio' }, dryRun: false, indexOffset: 0 });
const noNetwork = () => mockFetch(async () => new Response('', { status: 404 }));

async function seed() {
  writeCatalog(dir, []);
  await importRecords([jsonRecord(1, { price: 31 })]);
  const f = readCatalog(dir)[0];
  // la ficha tal y como la carga el formulario al abrirse
  return { f, loaded: { title: f.title, price: f.price, description: f.description } };
}
/** Lo que envía el formulario al guardar: TODOS los campos que mostraba (valores de cuando se abrió + ediciones). */
const formPayload = (f, edits = {}) => ({ ...f, ...edits });
const saveViaPanel = async (f, edits, editedFields, baseline) =>
  jsonOf(await addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'save', product: formPayload(f, edits), ...(editedFields ? { editedFields, baseline } : {}) } }) }));
const priceUpdateElsewhere = (price) => sync([jsonRecord(1, { price, capturedAt: '2026-10-07T10:00:00Z' })]);

test('unidad · resolveFormEdit: no editado → valor actual; editado sin cambios ajenos → lo enviado; editado y cambiado por otro → conflicto', () => {
  const current = { price: 9, title: 'T', description: 'd' };
  const submitted = { price: 31, title: 'T editado', description: 'd' };
  const ok = forms.resolveFormEdit({ editedFields: ['title'], baseline: { title: 'T' }, submitted, current });
  assert.equal(ok.values.price, 9, 'precio reenviado sin editar: gana el actual');
  assert.equal(ok.values.title, 'T editado');
  assert.deepEqual(ok.conflicts, []);
  const conflict = forms.resolveFormEdit({ editedFields: ['price'], baseline: { price: 31 }, submitted: { ...submitted, price: 40 }, current });
  assert.equal(conflict.values.price, 9);
  assert.deepEqual(conflict.conflicts.map((c) => [c.field, c.yours, c.current, c.baseline]), [['price', 40, 9, 31]]);
  const same = forms.resolveFormEdit({ editedFields: ['price'], baseline: { price: 31 }, submitted: { ...submitted, price: 9 }, current });
  assert.deepEqual(same.conflicts, [], 'ambos llegaron al mismo valor: no hay conflicto');
  assert.equal(forms.resolveFormEdit({ editedFields: undefined, baseline: undefined, submitted, current }).values.price, 31, 'sin editedFields: comportamiento anterior');
  assert.ok(forms.sameFormValue('31', 31) && forms.sameFormValue('31.0', 31) && forms.sameFormValue(null, ''));
});

test('products/add: formulario abierto ANTES de una actualización de precio; el usuario edita sólo el título → el precio nuevo se conserva', async () => {
  const { f, loaded } = await seed();
  priceUpdateElsewhere(9);
  assert.equal(readCatalog(dir)[0].price, 9);
  const restore = noNetwork();
  try {
    // el formulario sigue mostrando el precio antiguo (31) y lo reenvía; el usuario sólo editó el título
    const res = await saveViaPanel(f, { title: 'Título editado en el formulario antiguo' }, ['title'], { title: loaded.title });
    assert.equal(res.success, true, JSON.stringify(res).slice(0, 200));
    assert.deepEqual(res.conflicts, []);
  } finally { restore(); }
  const after = readCatalog(dir)[0];
  assert.equal(after.title, 'Título editado en el formulario antiguo', 'la edición del usuario se aplica');
  assert.equal(after.price, 9, 'el precio actualizado mientras el formulario estaba abierto NO se pisa');
});

test('products/add: si el usuario EDITA el precio y otro proceso también lo cambió → conflicto: no se sobrescribe en silencio y se avisa', async () => {
  const { f, loaded } = await seed();
  priceUpdateElsewhere(9);
  const restore = noNetwork();
  try {
    const res = await saveViaPanel(f, { price: 40, title: 'Título nuevo' }, ['price', 'title'], { price: loaded.price, title: loaded.title });
    assert.equal(res.success, true);
    assert.equal(res.conflicts.length, 1);
    assert.deepEqual([res.conflicts[0].field, res.conflicts[0].yours, res.conflicts[0].current, res.conflicts[0].baseline], ['price', 40, 9, 31]);
    assert.match(res.message, /NO se sobrescribió/);
    assert.match(res.message, /«price»/);
  } finally { restore(); }
  const after = readCatalog(dir)[0];
  assert.equal(after.price, 9, 'el valor concurrente prevalece y queda a la vista');
  assert.equal(after.title, 'Título nuevo', 'los campos sin conflicto sí se aplican');
});

test('products/add: editar el precio cuando NADIE más lo cambió → se aplica; y si ambos llegaron al mismo valor no hay conflicto', async () => {
  const { f, loaded } = await seed();
  const restore = noNetwork();
  try {
    const r1 = await saveViaPanel(f, { price: 28 }, ['price'], { price: loaded.price });
    assert.equal(r1.success, true);
    assert.deepEqual(r1.conflicts, []);
    assert.equal(readCatalog(dir)[0].price, 28);
    priceUpdateElsewhere(20);
    const r2 = await saveViaPanel(readCatalog(dir)[0], { price: 20 }, ['price'], { price: 28 });
    assert.deepEqual(r2.conflicts, [], 'mismo valor final: sin conflicto');
    assert.equal(readCatalog(dir)[0].price, 20);
  } finally { restore(); }
});

test('products/add sin editedFields (cliente antiguo o API): comportamiento anterior, el formulario manda (compatibilidad)', async () => {
  const { f } = await seed();
  priceUpdateElsewhere(9);
  const restore = noNetwork();
  try {
    const res = await saveViaPanel(f, { title: 'Sin lista de campos editados' });
    assert.equal(res.success, true);
  } finally { restore(); }
  assert.equal(readCatalog(dir)[0].price, 31, 'sin información de campos editados se aplica lo enviado (documentado)');
});

test('add-product: formulario abierto antes de una actualización de precio → no la pisa; mismo campo editado por ambos → conflicto', async () => {
  const { f, loaded } = await seed();
  priceUpdateElsewhere(9);
  const restore = noNetwork();
  try {
    const body = (price, extra) => ({ id: f.id, title: f.title + ' (editado)', affiliateUrl: f.affiliateUrl, price, category: 'Audio', options: { text: false, image: false, save: true }, ...extra });
    const sinTocarPrecio = await jsonOf(await addProductRoute.POST({ request: apiRequest('/api/admin/add-product', { cookie, body: body(31, { editedFields: ['title'], baseline: { title: loaded.title } }) }) }));
    assert.equal(sinTocarPrecio.success, true, JSON.stringify(sinTocarPrecio).slice(0, 200));
    assert.deepEqual(sinTocarPrecio.conflicts, []);
    assert.equal(readCatalog(dir)[0].price, 9, 'precio actual conservado');
    assert.match(readCatalog(dir)[0].title, /\(editado\)/);
    const conflicto = await jsonOf(await addProductRoute.POST({ request: apiRequest('/api/admin/add-product', { cookie, body: body(40, { editedFields: ['price'], baseline: { price: 31 } }) }) }));
    assert.equal(conflicto.success, true);
    assert.deepEqual(conflicto.conflicts.map((c) => c.field), ['price']);
    assert.equal(readCatalog(dir)[0].price, 9, 'el conflicto no sobrescribe');
  } finally { restore(); }
});

test('panel: «Guardar cambios» envía los campos EDITADOS y su valor original, y muestra el aviso de conflictos', () => {
  const src = fs.readFileSync(new URL('../../src/pages/upayp1b4.astro', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /function captureFormBaseline\(product\)/);
  assert.match(src, /captureFormBaseline\(product\);/, 'se captura al abrir la ficha');
  assert.match(src, /action: 'save', product: productPayload, \.\.\.\(isEditing \? \(collectFormEdits\(editingId\) \|\| \{\}\) : \{\}\)/);
  assert.match(src, /hadConflicts \? 'Guardado con conflictos'/);
  // los nombres de campo del panel coinciden con los que entiende el servidor
  const panelFields = [...src.matchAll(/^\s{6}(\w+): \(\) =>/gm)].map((m) => m[1]);
  for (const field of ['title', 'price', 'description', 'originalPrice', 'category', 'affiliateUrl', 'image', 'brand']) {
    assert.ok(forms.FORM_EDIT_FIELDS.includes(field), 'el servidor entiende ' + field);
    assert.ok(panelFields.includes(field) || src.includes(field + ': () =>'), 'el panel envía ' + field);
  }
});

test('captura inferida: un JSON SIN fecha y otro posterior CON fecha anterior a la recepción → la segunda lectura se aplica (no se declara «anterior»)', () => {
  writeCatalog(dir, []);
  sync([jsonRecord(1, { gtin: '4006381333931' })]);
  sync([jsonRecord(1, { gtin: '4006381333931', platform: 'otra', externalId: 'O1', url: 'https://otra.invalid/p/o1', price: 30, capturedAt: undefined })]);
  const out = sync([jsonRecord(1, { gtin: '4006381333931', platform: 'otra', externalId: 'O1', url: 'https://otra.invalid/p/o1', price: 25, capturedAt: '2026-10-01T10:00:00Z' })]);
  assert.equal(out.results[0].outcome, 'updated');
  void normalize;
});
