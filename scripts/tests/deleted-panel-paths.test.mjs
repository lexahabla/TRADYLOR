// Regresión: los CAMINOS REALES del panel (importar de AliExpress/eBay, importar+enriquecer, alta manual) respetan la
// memoria de eliminados. Una importación desde el panel NO es una restauración: olvidar una eliminación requiere
// una acción explícita (hoy sólo la limpieza global DELETE /api/admin/tombstones).
// La carga útil se genera con la función REAL del panel (`buildImportPayload` de upayp1b4.astro) ejecutada en un
// contexto aislado. Sin red, sin claves, datos aislados.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { setupIsolatedData, adminCookie, apiRequest, jsonOf, mockFetch, readCatalog, writeCatalog, jsonRecord, importRecords } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-panel-');
const cookie = await adminCookie();
const addRoute = await import('../../src/pages/api/products/add.ts');
const addProductRoute = await import('../../src/pages/api/admin/add-product.ts');
const pipelineRoute = await import('../../src/pages/api/v1/products/import.ts');
const deleted = await import('../../src/lib/deletedProducts.ts');

/* ── La función real del panel que construye la petición de importación ── */
const source = fs.readFileSync(new URL('../../src/pages/upayp1b4.astro', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const from = source.indexOf('    function buildImportPayload(product, categoryOverride) {');
const to = source.indexOf('    async function importSingleProduct(');
assert.ok(from > 0 && to > from, 'buildImportPayload no encontrada en el panel');
const sandbox = { getImportCategory: () => '', Number, String, Math, Object, Array, Boolean, Date, JSON };
vm.createContext(sandbox);
vm.runInContext(source.slice(from, to), sandbox);
const buildImportPayload = (product, category) => JSON.parse(JSON.stringify(sandbox.buildImportPayload(product, category)));

/** Productos tal y como los muestra la tabla «Catálogo de Afiliados» (UnifiedProduct). */
const aliexpress = {
  title: 'Cable USB-C trenzado 2 m carga rápida', description: 'Cable', price: 4.5, originalPrice: 6, image: 'https://img.invalid/ali.jpg', gallery: ['https://img.invalid/ali.jpg'],
  network: 'aliexpress', sourceId: '1005001234567890', externalId: '1005001234567890', currency: 'EUR', commissionRate: 8, inStock: true,
  productUrl: 'https://es.aliexpress.com/item/1005001234567890.html', promotionUrl: 'https://s.click.aliexpress.com/e/_abc123', extra: { 'Días de envío': 12 },
};
const ebay = {
  title: 'Taladro percutor Bosch GSB 13 RE', description: 'Taladro', price: 75, image: 'https://img.invalid/ebay.jpg', network: 'ebay', sourceId: 'v1|123456789012|0', externalId: 'v1|123456789012|0',
  currency: 'EUR', commissionRate: 5, inStock: true, productUrl: 'https://www.ebay.es/itm/123456789012', promotionUrl: 'https://www.ebay.es/itm/123456789012?campid=1',
};

const reset = () => {
  writeCatalog(dir, []);
  for (const f of ['deleted-product-ids.json', 'deleted-identities.json', 'deleted-offers.json']) fs.rmSync(`${dir}/${f}`, { force: true });
};
const noNetwork = () => mockFetch(async () => new Response('', { status: 404 }));
const panelImport = async (product) => jsonOf(await addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: buildImportPayload(product) }) }));
const panelDelete = (id) => addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'delete', id } }) });
const panelImportEnrich = async (product) => {
  const basic = buildImportPayload(product).product;
  return jsonOf(await addProductRoute.POST({ request: apiRequest('/api/admin/add-product', { cookie, body: { title: basic.title, description: product.description, category: basic.category, keepUncategorized: true, price: basic.price, image: basic.image, affiliateUrl: basic.affiliateUrl, url: basic.url, network: basic.network, sourceId: basic.sourceId, merchant: basic.merchant, currency: basic.currency, options: { text: false, image: false, save: true } } }) }));
};

for (const [name, product] of [['AliExpress', aliexpress], ['eBay', ebay]]) {
  test(`importación del panel (${name}): control sin eliminados; tras ELIMINAR la ficha, volver a importar se bloquea con un mensaje claro`, async () => {
    reset();
    const restore = noNetwork();
    try {
      const first = await panelImport(product);
      assert.equal(first.success, true, JSON.stringify(first).slice(0, 200));
      assert.equal(readCatalog(dir).length, 1);
      const id = readCatalog(dir)[0].id;
      assert.equal((await panelDelete(id)).status, 200);
      assert.equal(readCatalog(dir).length, 0);

      const again = await panelImport(product);
      assert.equal(again.success, false, 'la importación ordinaria NO restaura');
      assert.equal(again.deleted, true);
      assert.equal(again.restorable, false);
      assert.match(again.message, /eliminado anteriormente/i);
      assert.match(again.message, /acción explícita/i);
      assert.equal(readCatalog(dir).length, 0, 'la ficha no se recrea');
      assert.ok(deleted.readDeletedIds().includes(id), 'el tombstone sigue');
      assert.ok(deleted.readDeletedIdentities().some((r) => r.id === id), 'y la identidad');
    } finally { restore(); }
  });
}

test('importar+enriquecer del panel (add-product, keepUncategorized) también respeta lo eliminado, sin gastar IA', async () => {
  reset();
  const restore = noNetwork();
  try {
    assert.equal((await panelImport(aliexpress)).success, true);
    await panelDelete(readCatalog(dir)[0].id);
    const res = await panelImportEnrich(aliexpress);
    assert.equal(res.success, false);
    assert.equal(res.saved, false);
    assert.equal(res.deleted, true);
    assert.match(res.message, /acción explícita/i);
    assert.equal(readCatalog(dir).length, 0);
  } finally { restore(); }
});

test('alta manual del formulario con la misma URL de producto: bloqueada; editar una ficha EXISTENTE sigue permitido', async () => {
  reset();
  const restore = noNetwork();
  try {
    await panelImport(aliexpress);
    const id = readCatalog(dir)[0].id;
    // edición de la ficha existente (el formulario reenvía su id): permitido
    const edit = await jsonOf(await addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'save', product: { ...readCatalog(dir)[0], title: 'Cable USB-C (editado)' } } }) }));
    assert.equal(edit.success, true);
    assert.equal(readCatalog(dir)[0].title, 'Cable USB-C (editado)');
    await panelDelete(id);
    const manual = await jsonOf(await addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'save', product: { title: 'Otro título distinto', affiliateUrl: aliexpress.productUrl, price: 3, image: 'https://i.invalid/a.jpg', category: 'X', merchant: 'M', pros: [], cons: [], description: 'd' } } }) }));
    assert.equal(manual.success, false);
    assert.equal(manual.deleted, true, 'bloqueada por la URL de producto de la ficha eliminada');
  } finally { restore(); }
});

test('lo eliminado desde el panel también bloquea al resto de canales (API v1 y JSON) y no bloquea productos distintos de la misma red', async () => {
  reset();
  const restore = noNetwork();
  try {
    await panelImport(aliexpress);
    await panelDelete(readCatalog(dir)[0].id);
    // API v1 con el mismo id externo y sin id
    const api = await jsonOf(await pipelineRoute.POST({ request: apiRequest('/api/v1/products/import', { token: true, body: { title: aliexpress.title, affiliateUrl: aliexpress.productUrl, price: 4.5, sourceId: 'AE-1005001234567890', image: aliexpress.image, category: 'Tecnología' } }) }));
    assert.equal(api.results[0].ok, false);
    assert.match(api.results[0].message, /eliminado anteriormente/i);
    // JSON con la misma oferta
    const out = await importRecords([jsonRecord(1, { platform: 'aliexpress', externalId: '1005001234567890', url: aliexpress.productUrl })]);
    assert.match(out.results[0].outcome + out.results[0].reasons.join('+'), /^rejectedproducto_eliminado_anteriormente/);
    // otro producto de AliExpress (otro id externo y otra URL): NO se bloquea
    const other = await panelImport({ ...aliexpress, title: 'Funda de móvil silicona negra', sourceId: '1005009999999999', externalId: '1005009999999999', productUrl: 'https://es.aliexpress.com/item/1005009999999999.html', promotionUrl: 'https://s.click.aliexpress.com/e/_zzz999' });
    assert.equal(other.success, true);
    assert.equal(readCatalog(dir).length, 1);
  } finally { restore(); }
});
