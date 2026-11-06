// Regresión: eliminados por IDENTIDAD entre canales (panel, API v1, JSON, Amazon, auto-curación,
// Construir Catálogo), borrado autenticado y diferencia entre eliminar una ficha y eliminar una oferta.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie, apiRequest, jsonOf, mockFetch, readCatalog, writeCatalog, jsonRecord, importRecords, GTIN } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-del-');
const cookie = await adminCookie();
const addRoute = await import('../../src/pages/api/products/add.ts');
const pipelineRoute = await import('../../src/pages/api/v1/products/import.ts');
const buildRoute = await import('../../src/pages/api/v1/products/build-catalog.ts');
const opencodeRoute = await import('../../src/pages/api/v1/admin/opencode-command.ts');
const identity = await import('../../src/lib/deletedIdentity.ts');
const deleted = await import('../../src/lib/deletedProducts.ts');
const curation = await import('../../src/lib/curation.ts');
const amazonImport = await import('../../src/lib/amazonImport.ts');
// El empaquetador de producción sustituye el `require` de massCatalogPipeline.findExistingProduct;
// en Node puro hay que simularlo con el módulo ya importado.
const storeModule = await import('../../src/lib/productStore.ts');
globalThis.require = (spec) => {
  if (String(spec).endsWith('productStore')) return storeModule;
  if (String(spec).endsWith('curation')) return curation;
  throw new Error('require no simulado: ' + spec);
};
const { MassCatalogPipeline } = await import('../../src/lib/services/massCatalogPipeline.ts');
const catalogOffers = await import('../../src/lib/catalogOffers.ts');

const reset = () => {
  writeCatalog(dir, []);
  for (const f of ['deleted-product-ids.json', 'deleted-identities.json', 'deleted-offers.json']) fs.rmSync(path.join(dir, f), { force: true });
};
const del = (id) => addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'delete', id } }) });
const apiImport = async (item) => jsonOf(await pipelineRoute.POST({ request: apiRequest('/api/v1/products/import', { token: true, body: item }) }));
const outcome = (out) => out.results.map((r) => r.outcome + (r.reasons.length ? ':' + r.reasons.join('+') : ''));

// ── Autenticación y registro de la eliminación ─────────────────────────────
test('DELETE /api/products/add exige sesión de administrador (antes cualquiera podía borrar)', async () => {
  reset();
  await importRecords([jsonRecord(1)]);
  const id = readCatalog(dir)[0].id;
  const anon = await addRoute.DELETE({ request: apiRequest('/api/products/add?id=' + id, { method: 'DELETE' }), url: new URL('http://localhost/api/products/add?id=' + id) });
  assert.equal(anon.status, 401);
  assert.equal(readCatalog(dir).length, 1, 'sin sesión no se borra nada');
  const ok = await addRoute.DELETE({ request: apiRequest('/api/products/add?id=' + id, { method: 'DELETE', cookie }), url: new URL('http://localhost/api/products/add?id=' + id) });
  assert.equal(ok.status, 200);
  assert.equal(readCatalog(dir).length, 0);
  assert.ok(deleted.readDeletedIds().includes(id), 'DELETE ahora deja tombstone por id');
  assert.ok(deleted.readDeletedIdentities().some((r) => r.id === id), 'y la identidad de la ficha');
});

test('al eliminar una ficha se registra su identidad completa (ofertas, ids, URLs, GTIN, variante)', async () => {
  reset();
  await importRecords([jsonRecord(1, { gtin: GTIN, condition: 'Nuevo', capacity: '128 GB' }), jsonRecord(1, { gtin: GTIN, condition: 'Nuevo', capacity: '128 GB', platform: 'otra', externalId: 'OTRA-1', url: 'https://otra.invalid/p/otra-1', sellerName: 'OtraShop' })]);
  const id = readCatalog(dir)[0].id;
  await del(id);
  const record = deleted.readDeletedIdentities().find((r) => r.id === id);
  assert.equal(record.identity.offerKeys.length, 2, 'las dos ofertas de la ficha');
  assert.deepEqual(record.identity.gtins, [GTIN]);
  assert.equal(record.identity.variant.condition, 'new');
  assert.equal(record.identity.variant.capacity, '128 gb');
  assert.ok(record.identity.urls.length >= 2);
});

// ── Mismo producto eliminado recibido por otro id / otro canal ─────────────
test('JSON → eliminar → JSON con el mismo registro: protegido', async () => {
  reset();
  await importRecords([jsonRecord(1)]);
  await del(readCatalog(dir)[0].id);
  const out = await importRecords([jsonRecord(1)]);
  assert.match(outcome(out)[0], /^rejected:producto_eliminado_anteriormente/);
  assert.equal(readCatalog(dir).length, 0);
});

test('ficha creada por la API v1 (otro id) → eliminar → JSON con la misma oferta: protegido', async () => {
  reset();
  const created = await apiImport({ title: 'Altavoz Zeta 1 portátil serie 13', affiliateUrl: 'https://tienda.invalid/z/1', price: 31, sourceId: 'Z1', image: 'https://img.invalid/z1.jpg', category: 'Audio' });
  assert.equal(created.results[0].ok, true);
  const id = readCatalog(dir)[0].id;
  await del(id);
  const out = await importRecords([jsonRecord(1)]);
  assert.match(outcome(out)[0], /^rejected:producto_eliminado_anteriormente\+eliminado_por_/);
  assert.equal(readCatalog(dir).length, 0);
});

test('ficha creada por JSON → eliminar → API v1 con el mismo sourceId y sin id: protegido', async () => {
  reset();
  await importRecords([jsonRecord(1)]);
  await del(readCatalog(dir)[0].id);
  const res = await apiImport({ title: 'Altavoz Zeta 1 portátil serie 13', affiliateUrl: 'https://tienda.invalid/z/1', price: 31, sourceId: 'Z1', image: 'https://img.invalid/z1.jpg', category: 'Audio' });
  assert.equal(res.results[0].ok, false);
  assert.match(res.results[0].message, /eliminado anteriormente/i);
  assert.equal(readCatalog(dir).length, 0);
});

test('otro comercio con el mismo GTIN y misma variante: protegido; otro estado u otra capacidad = otra variante, NO se bloquea', async () => {
  reset();
  await importRecords([jsonRecord(1, { gtin: GTIN, condition: 'Nuevo', capacity: '128 GB' })]);
  await del(readCatalog(dir)[0].id);
  const otro = { gtin: GTIN, platform: 'otra', externalId: 'O-1', url: 'https://otra.invalid/p/o-1', sellerName: 'OtraShop', title: 'Altavoz Zeta 1 portátil serie 13' };
  assert.match(outcome(await importRecords([{ ...jsonRecord(1), ...otro, condition: 'Nuevo', capacity: '128 GB' }]))[0], /^rejected:producto_eliminado_anteriormente\+eliminado_por_gtin/);
  assert.deepEqual(outcome(await importRecords([{ ...jsonRecord(1), ...otro, externalId: 'O-2', url: 'https://otra.invalid/p/o-2', condition: 'Usado', capacity: '128 GB' }])), ['created'], 'usado ≠ nuevo');
  assert.deepEqual(outcome(await importRecords([{ ...jsonRecord(1), ...otro, externalId: 'O-3', url: 'https://otra.invalid/p/o-3', condition: 'Nuevo', capacity: '256 GB', gtin: GTIN }])), ['created'], '256 GB ≠ 128 GB');
});

test('NO se bloquean productos distintos: título parecido, URL genérica ni id débil de otra plataforma', async () => {
  reset();
  await importRecords([jsonRecord(1, { externalId: 'S1', url: 'https://tienda.invalid/' })]); // URL de portada: no es identidad fiable
  await del(readCatalog(dir)[0].id);
  // Mismo título pero otro producto (otra referencia, otra URL): no se bloquea por título.
  assert.deepEqual(outcome(await importRecords([jsonRecord(1, { externalId: 'X9', url: 'https://otra-tienda.invalid/p/x9', platform: 'otra' })])), ['created']);
  // Id débil («S1») de OTRA plataforma: no coincide.
  assert.deepEqual(outcome(await importRecords([jsonRecord(7, { externalId: 'S1', url: 'https://otra.invalid/p/7', platform: 'otra' })])), ['created']);
  // La URL de portada tampoco bloquea: otro producto del mismo dominio entra.
  assert.deepEqual(outcome(await importRecords([jsonRecord(8, { externalId: 'Q8', url: 'https://tienda.invalid/', platform: 'tienda2' })])), ['created']);
});

test('importación Amazon (JSON de ScraperAPI): no resucita un ASIN eliminado', async () => {
  reset();
  await importRecords([jsonRecord(1, { platform: 'amazon', externalId: 'B0DELETED1', url: 'https://www.amazon.es/dp/B0DELETED1' })]);
  await del(readCatalog(dir)[0].id);
  const restore = mockFetch(async () => new Response('', { status: 404 }));
  try {
    const out = await amazonImport.importAmazonProductFromRawJson('B0DELETED1', { asin: 'B0DELETED1', name: 'Altavoz Zeta', pricing: '31,00 €', images: ['https://img.invalid/z.jpg'] }, { save: true });
    assert.equal(out.success, false);
    assert.match(out.message, /eliminado anteriormente/i);
  } finally { restore(); }
  assert.equal(readCatalog(dir).length, 0);
});

test('Construir Catálogo: una ficha eliminada no se vuelve a crear con otro id', async () => {
  reset();
  const g = (n) => {
    const url = `https://tienda.invalid/bc/${n}`;
    return { canonical: { network: 'tienda', externalId: `BC${n}`, affiliateUrl: url, directUrl: url, title: `Producto build ${n} edición ${n * 7}`, description: 'd', price: 10, originalPrice: 12, currency: 'EUR', discountPercentage: 0, inStock: true, commissionRate: 0, estimatedCommission: 0, category: 'Audio', brand: 'Marca', merchantName: 'Tienda', rating: 4, reviewCount: 10, mainImage: 'https://img.invalid/bc.jpg', extraImages: [] }, variants: [], bestPrice: 10, bestOriginalPrice: 12, bestCommissionRate: 0, bestCommissionAmount: 0, bestRating: 4, bestSales: 0, allNetworks: ['tienda'], allAffiliateUrls: { tienda: url }, allDirectUrls: { tienda: url }, allMerchantNames: { tienda: 'Tienda' }, allExtraImages: [], allPrices: { tienda: 10 }, allOriginalPrices: { tienda: 12 }, allCurrencies: { tienda: 'EUR' }, category: 'Audio', isHSR: false, hsrScore: 0 };
  };
  await buildRoute.buildAndUpsertProducts([g(1)], false, false);
  assert.equal(readCatalog(dir).length, 1);
  await del(readCatalog(dir)[0].id);
  const out = await buildRoute.buildAndUpsertProducts([g(1)], false, false);
  assert.equal(out.upserted, 0);
  assert.equal(readCatalog(dir).length, 0);
});

test('auto-curación (MassCatalogPipeline): no resucita una ficha eliminada y fusiona (conserva extra.offers) si existe', async () => {
  reset();
  const raw = (n) => ({
    id: 'raw-' + n, network: 'tienda', externalId: `AC${n}`, capturedAt: new Date().toISOString(), processed: false,
    rawPayload: { network: 'tienda', externalId: `AC${n}`, affiliateUrl: `https://tienda.invalid/ac/${n}`, directUrl: `https://tienda.invalid/ac/${n}`, title: `Producto auto curado ${n} edición ${n * 5}`, description: 'd', price: 10, originalPrice: 12, currency: 'EUR', discountPercentage: 0, inStock: true, commissionRate: 0, estimatedCommission: 0, category: 'Audio', brand: 'Marca', merchantName: 'Tienda', rating: 4, reviewCount: 10, mainImage: 'https://img.invalid/ac.jpg', extraImages: [] },
  });
  const pipeline = new MassCatalogPipeline({ network: 'tienda', useAI: false, scrapePages: false, autoLinkAlternatives: false });
  const first = await pipeline.processSingleRaw(raw(1));
  assert.equal(first.success, true, JSON.stringify(first));
  const id = readCatalog(dir)[0].id;
  // Fusión: una ficha existente con ofertas adicionales conserva extra.offers al reprocesar.
  const ficha = readCatalog(dir)[0];
  writeCatalog(dir, [{ ...ficha, extra: { ...(ficha.extra ?? {}), offers: [{ offerId: 'o1', offerKey: 'otra:x' }], lockedFields: ['verdict'] }, verdict: 'Veredicto propio', slug: 'slug-propio', priceHistory: [{ date: '2026-10-01', price: 9 }] }]);
  const again = await pipeline.processSingleRaw({ ...raw(1), processed: false });
  assert.equal(again.success, true);
  const after = readCatalog(dir).find((p) => p.id === id);
  assert.equal(after.extra.offers.length, 1, 'extra.offers conservado');
  assert.equal(after.verdict, 'Veredicto propio', 'el texto bloqueado por edición manual se conserva');
  assert.equal(after.slug, 'slug-propio', 'la identidad local (slug) se conserva');
  assert.equal(after.priceHistory.length, 1, 'el histórico de precio se conserva');
  // Eliminada → no se vuelve a crear.
  await del(id);
  const third = await pipeline.processSingleRaw({ ...raw(1), processed: false });
  assert.equal(third.success, false);
  assert.match(third.error, /eliminado anteriormente/i);
  assert.equal(readCatalog(dir).length, 0);
});

test('borrado masivo (curation) y opencode bulk_delete también registran la identidad', async () => {
  reset();
  await importRecords([jsonRecord(1), jsonRecord(2), jsonRecord(3)]);
  const [a, b, c] = readCatalog(dir).map((p) => p.id);
  curation.bulkDeleteProducts([a]);
  assert.ok(deleted.readDeletedIdentities().some((r) => r.id === a));
  process.env.OPENAI_API_KEY = 'clave-de-prueba-no-valida';
  process.env.TEXT_AI_PROVIDER = 'openai';
  const actions = { actions: [{ type: 'bulk_delete', params: { productIds: [b], confirm: true }, description: 'x' }], summary: 's' };
  const restore = mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(actions) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  try {
    const res = await jsonOf(await opencodeRoute.POST({ request: apiRequest('/api/v1/admin/opencode-command', { cookie, body: { prompt: 'borra', productIds: [b, c], context: 'selected' } }) }));
    assert.equal(res.success, true, JSON.stringify(res).slice(0, 200));
  } finally { restore(); delete process.env.OPENAI_API_KEY; delete process.env.TEXT_AI_PROVIDER; }
  assert.deepEqual(readCatalog(dir).map((p) => p.id), [c]);
  assert.ok(deleted.readDeletedIds().includes(b), 'opencode bulk_delete ahora deja tombstone');
  assert.ok(deleted.readDeletedIdentities().some((r) => r.id === b), 'y la identidad');
});

// ── Eliminar una ficha ≠ eliminar una oferta ───────────────────────────────
test('eliminar UNA oferta no bloquea la ficha ni sus otras ofertas; la oferta eliminada no vuelve', async () => {
  reset();
  await importRecords([jsonRecord(1, { gtin: GTIN })]);
  await importRecords([jsonRecord(1, { gtin: GTIN, platform: 'otra', externalId: 'OTRA-1', url: 'https://otra.invalid/p/o1', sellerName: 'OtraShop' })]);
  await importRecords([jsonRecord(1, { gtin: GTIN, platform: 'tercera', externalId: 'TER-1', url: 'https://tercera.invalid/p/t1' })]);
  const ficha = readCatalog(dir)[0];
  assert.equal(ficha.extra.offers.length, 2);
  const target = ficha.extra.offers[0].offerKey;
  const implicitKey = catalogOffers.getOffers(ficha).find((o) => o.implicit).offerKey;
  const principal = identity.deleteOffer(ficha.id, implicitKey);
  assert.deepEqual(principal, { ok: false, reason: 'oferta_principal_de_la_ficha' }, 'la oferta principal sólo se quita eliminando la ficha');
  assert.deepEqual(identity.deleteOffer('no-existe', target), { ok: false, reason: 'ficha_no_encontrada' });
  const res = identity.deleteOffer(ficha.id, target);
  assert.equal(res.ok, true);
  assert.equal(readCatalog(dir)[0].extra.offers.length, 1, 'sólo se quitó esa oferta');
  assert.equal(deleted.readDeletedIds().includes(ficha.id), false, 'la ficha NO queda marcada como eliminada');
  assert.equal(deleted.readDeletedIdentities().length, 0);
  // La oferta eliminada no vuelve (aunque la ficha exista y coincida por GTIN)…
  assert.match(outcome(await importRecords([jsonRecord(1, { gtin: GTIN, platform: 'otra', externalId: 'OTRA-1', url: 'https://otra.invalid/p/o1', sellerName: 'OtraShop' })]))[0], /^rejected:oferta_eliminada_anteriormente/);
  // …pero otra oferta distinta del mismo producto sí se vincula.
  assert.deepEqual(outcome(await importRecords([jsonRecord(1, { gtin: GTIN, platform: 'cuarta', externalId: 'CUA-1', url: 'https://cuarta.invalid/p/c1' })])), ['linked:gtin']);
});

// ── Recuperación explícita y eliminaciones antiguas ────────────────────────
test('el panel NO restaura: guardar un producto eliminado se bloquea; sólo una restauración explícita lo permite', async () => {
  reset();
  await importRecords([jsonRecord(1)]);
  const id = readCatalog(dir)[0].id;
  await del(id);
  const panelSave = (extra = {}) => addRoute.POST({ request: apiRequest('/api/products/add', { cookie, body: { action: 'save', product: { title: 'Altavoz Zeta 1 desde el panel', affiliateUrl: 'https://tienda.invalid/z/1', sourceId: 'Z1', network: 'tienda', price: 5, image: 'https://i.invalid/a.jpg', category: 'Audio', merchant: 'M', pros: [], cons: [], description: 'd', ...extra } } }) });
  const restore = mockFetch(async () => new Response('', { status: 404 }));
  try {
    const blocked = await jsonOf(await panelSave());
    assert.equal(blocked.success, false);
    assert.equal(blocked.deleted, true);
    assert.equal(blocked.restorable, false, 'no existe una acción de restauración individual');
    assert.match(blocked.message, /acción explícita/);
    assert.equal(readCatalog(dir).length, 0);
    assert.ok(deleted.readDeletedIds().includes(id), 'el tombstone NO se quita al guardar');
    assert.ok(deleted.readDeletedIdentities().some((r) => r.id === id), 'ni la identidad');
    assert.match(outcome(await importRecords([jsonRecord(1)]))[0], /^rejected/, 'y los demás canales siguen bloqueados');
    // Restauración EXPLÍCITA (única existente): limpieza global de eliminados, sólo administradores.
    const tombstones = await import('../../src/pages/api/admin/tombstones/index.ts');
    const anon = await tombstones.DELETE({ request: new Request('http://localhost/api/admin/tombstones', { method: 'DELETE' }) });
    assert.equal(anon.status, 401);
    assert.ok(deleted.readDeletedIdentities().length > 0, 'sin sesión no se olvida nada');
    const okRestore = await tombstones.DELETE({ request: apiRequest('/api/admin/tombstones', { method: 'DELETE', cookie }) });
    assert.equal(okRestore.status, 200);
    assert.equal(deleted.readDeletedIdentities().length, 0);
    assert.equal((await jsonOf(await panelSave())).success, true, 'tras la restauración explícita ya se puede volver a añadir');
  } finally { restore(); }
});

test('eliminaciones antiguas (sólo id): se reconstruyen desde copias de seguridad y el resto queda protegido sólo por id', async () => {
  reset();
  // «Antiguas»: sólo existe el id en deleted-product-ids.json.
  fs.writeFileSync(path.join(dir, 'deleted-product-ids.json'), JSON.stringify(['viejo-con-copia', 'viejo-sin-copia']));
  fs.mkdirSync(path.join(dir, 'backups', 'categories-x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backups', 'categories-x', 'products.json'), JSON.stringify([
    { id: 'viejo-con-copia', title: 'Altavoz antiguo', description: '', price: 10, image: 'x', category: 'Audio', merchant: 'Amazon', network: 'amazon', sourceId: 'B0OLDOLD01', asin: 'B0OLDOLD01', affiliateUrl: 'https://www.amazon.es/dp/B0OLDOLD01', pros: [], cons: [] },
  ]));
  // Antes del rescate el mismo producto con otro id SÍ reaparece (única limitación real).
  assert.deepEqual(outcome(await importRecords([jsonRecord(1, { platform: 'amazon', externalId: 'B0OLDOLD01', url: 'https://www.amazon.es/dp/B0OLDOLD01' })])), ['created']);
  reset();
  fs.writeFileSync(path.join(dir, 'deleted-product-ids.json'), JSON.stringify(['viejo-con-copia', 'viejo-sin-copia']));
  fs.mkdirSync(path.join(dir, 'backups', 'categories-x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backups', 'categories-x', 'products.json'), JSON.stringify([
    { id: 'viejo-con-copia', title: 'Altavoz antiguo', description: '', price: 10, image: 'x', category: 'Audio', merchant: 'Amazon', network: 'amazon', sourceId: 'B0OLDOLD01', asin: 'B0OLDOLD01', affiliateUrl: 'https://www.amazon.es/dp/B0OLDOLD01', pros: [], cons: [] },
  ]));
  const dry = identity.backfillDeletedIdentities({ apply: false });
  assert.deepEqual(dry.recovered, ['viejo-con-copia']);
  assert.deepEqual(dry.unrecoverable, ['viejo-sin-copia']);
  assert.equal(deleted.readDeletedIdentities().length, 0, 'sin --apply no se escribe nada');
  identity.backfillDeletedIdentities({ apply: true });
  assert.equal(deleted.readDeletedIdentities().length, 1);
  assert.match(outcome(await importRecords([jsonRecord(1, { platform: 'amazon', externalId: 'B0OLDOLD01', url: 'https://www.amazon.es/dp/B0OLDOLD01' })]))[0], /^rejected:producto_eliminado_anteriormente/);
});

test('«deshacer el vaciado» (clearDeletedIds) también limpia identidades y ofertas eliminadas', async () => {
  reset();
  await importRecords([jsonRecord(1)]);
  await del(readCatalog(dir)[0].id);
  deleted.addDeletedOffer({ offerKey: 'x:y', deletedAt: new Date().toISOString() });
  deleted.clearDeletedIds();
  assert.equal(deleted.readDeletedIdentities().length, 0);
  assert.equal(deleted.readDeletedOffers().length, 0);
  assert.deepEqual(outcome(await importRecords([jsonRecord(1)])), ['created']);
});
