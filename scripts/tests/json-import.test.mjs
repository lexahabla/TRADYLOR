import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Datos AISLADOS: se fija el directorio ANTES de importar los módulos.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treidilor-json-import-'));
process.env.TRADYLOR_DATA_DIR = dir;
const PRODUCTS = path.join(dir, 'products.json');

const service = await import('../../src/lib/jsonImport/service.ts');
const normalize = await import('../../src/lib/jsonImport/normalize.ts');
const engine = await import('../../src/lib/jsonImport/engine.ts');
const store = await import('../../src/lib/productStore.ts');
const { validateSingleProduct } = await import('../../src/lib/validateProducts.ts');

const GTIN_A = '4006381333931'; // EAN-13 válido
const GTIN_B = '5901234123457'; // EAN-13 válido
let batchSeq = 0;
const batch = () => `batch-test-${++batchSeq}-${Date.now()}`;

const readAll = () => JSON.parse(fs.readFileSync(PRODUCTS, 'utf8'));
const reset = (products = []) => fs.writeFileSync(PRODUCTS, JSON.stringify(products, null, 2));
const run = (records, opts = {}) =>
  service.processChunk({
    batchId: opts.batchId ?? batch(),
    records,
    // Por defecto se aporta categoría: sin ella la ficha NUEVA queda en revisión (ver prueba específica).
    defaults: opts.defaults ?? { category: 'Prueba' },
    dryRun: opts.dryRun ?? false,
    indexOffset: opts.indexOffset ?? 0,
  });
const outcomes = (out) => out.results.map((r) => r.outcome);
const offersOf = (p) => engine.getOffers(p);

const amazon = (over = {}) => ({
  title: 'Auriculares Sony WH-1000XM5 Negro',
  brand: 'Sony',
  gtin: GTIN_A,
  image: 'https://img.example.com/sony.jpg',
  platform: 'amazon',
  asin: 'B09XS7JWHH',
  url: 'https://www.amazon.es/dp/B09XS7JWHH?tag=x&th=1',
  price: 299.99,
  currency: 'EUR',
  availability: 'in_stock',
  capturedAt: '2026-10-06T10:00:00Z',
  ...over,
});
const temu = (over = {}) => ({
  title: 'Sony WH-1000XM5 auriculares inalámbricos',
  brand: 'Sony',
  gtin: GTIN_A,
  image: 'https://img.example.com/sony-temu.jpg',
  platform: 'temu',
  externalId: '601099512345',
  sellerName: 'AudioShop',
  url: 'https://www.temu.com/goods.html?goods_id=601099512345',
  price: 279.5,
  currency: 'EUR',
  capturedAt: '2026-10-06T11:00:00Z',
  ...over,
});

/* ───────────────────────── Normalización ───────────────────────── */

test('normalización: precios europeos/anglosajones y monedas', () => {
  assert.equal(normalize.parsePrice('1.299,99 €').value, 1299.99);
  assert.equal(normalize.parsePrice('1.299,99 €').currency, 'EUR');
  assert.equal(normalize.parsePrice('€29.99').value, 29.99);
  assert.equal(normalize.parsePrice('1,299.50').value, 1299.5);
  assert.equal(normalize.parsePrice('12,5').value, 12.5);
  assert.ok(Number.isNaN(normalize.parsePrice('gratis').value));
});

test('normalización: GTIN sólo con dígito de control válido', () => {
  assert.equal(normalize.validGtin(GTIN_A), GTIN_A);
  assert.equal(normalize.validGtin('4006381333932'), '');
  assert.equal(normalize.validGtin('abc'), '');
});

test('normalización: envío y disponibilidad desconocidos NO se interpretan como gratis/disponible', () => {
  const { record } = normalize.normalizeRecord(amazon({ availability: undefined }), 0);
  assert.equal(record.offer.availability, 'unknown');
  assert.equal(record.offer.shipping.free, null);
  assert.equal(record.offer.shipping.cost, null);
  const free = normalize.normalizeRecord(amazon({ shipping: { cost: 0 } }), 0).record;
  assert.equal(free.offer.shipping.free, true);
});

test('normalización: HTML fuera, claves peligrosas fuera, registros inválidos con motivos', () => {
  const r = normalize.normalizeRecord(amazon({ title: '<b>Hola</b> <script>x</script> mundo', description: '<p>desc</p>' }), 0).record;
  assert.ok(!/[<>]/.test(r.product.title));
  const safe = normalize.sanitizeJson(JSON.parse('{"a":{"__proto__":{"x":1},"b":2}}'));
  assert.equal(Object.keys(safe.a).includes('__proto__'), false);
  assert.deepEqual(normalize.normalizeRecord({ title: 'x' }, 0).errors.sort(), ['falta_titulo', 'falta_url_oferta', 'precio_invalido', 'falta_moneda', 'falta_plataforma', 'falta_identificador_oferta'].sort());
  assert.ok(normalize.normalizeRecord(amazon({ price: 0 }), 0).errors.includes('precio_invalido'));
  assert.ok(normalize.normalizeRecord(amazon({ currency: undefined }), 0).errors.includes('falta_moneda'));
  assert.ok(normalize.normalizeRecord(amazon({ url: 'javascript:alert(1)', asin: undefined, platform: 'amazon' }), 0).errors.includes('falta_url_oferta'));
});

test('normalización: JSON estructurado de ScraperAPI-Amazon (sin ASIN obligatorio en otros comercios)', () => {
  const raw = { asin: 'B01EXDG2MO', name: 'Echo Dot', brand: 'Amazon', pricing: '49,99 €', images: ['https://m.media-amazon.com/a.jpg'] };
  const { record, errors } = normalize.normalizeRecord(raw, 0);
  assert.deepEqual(errors, []);
  assert.equal(record.offer.platform, 'amazon');
  assert.equal(record.offer.currency, 'EUR');
  assert.equal(record.offer.price, 49.99);
  assert.ok(record.warnings.includes('url_construida_desde_asin'));
  // Un comercio sin ASIN es válido.
  assert.deepEqual(normalize.normalizeRecord(temu(), 0).errors, []);
});

test('envoltorio: array, {products}, objeto único y defaults', () => {
  assert.equal(normalize.extractRecords([{ a: 1 }, { b: 2 }]).records.length, 2);
  const env = normalize.extractRecords({ defaults: { platform: 'Temu', currency: 'eur' }, products: [{ a: 1 }] });
  assert.equal(env.records.length, 1);
  assert.equal(env.defaults.platform, 'temu');
  assert.equal(env.defaults.currency, 'EUR');
  assert.equal(normalize.extractRecords({ title: 'x' }).records.length, 1);
});

/* ───────────────────────── Fichas y ofertas ───────────────────────── */

test('misma variante en dos comercios → UNA ficha y DOS ofertas', () => {
  reset();
  const first = run([amazon()]);
  assert.deepEqual(outcomes(first), ['created']);
  const second = run([temu()]);
  assert.deepEqual(outcomes(second), ['linked']);
  const all = readAll();
  assert.equal(all.length, 1);
  const offers = offersOf(all[0]);
  assert.equal(offers.length, 2);
  assert.deepEqual(offers.map((o) => o.platform).sort(), ['amazon', 'temu']);
  // Cada dato comercial permanece en SU oferta.
  const t = offers.find((o) => o.platform === 'temu');
  const a = offers.find((o) => o.platform === 'amazon');
  assert.equal(t.price, 279.5);
  assert.equal(t.sellerName, 'AudioShop');
  assert.equal(a.price, 299.99);
  assert.equal(all[0].price, 299.99, 'los campos planos NO cambian por la oferta de otro comerciante');
  assert.equal(all[0].affiliateUrl, 'https://www.amazon.es/dp/B09XS7JWHH?tag=x&th=1');
});

test('reimportar una oferta actualiza sus datos sin duplicarla', () => {
  reset();
  run([amazon(), temu()]);
  const out = run([temu({ price: 259, capturedAt: '2026-10-07T09:00:00Z' })]);
  assert.deepEqual(outcomes(out), ['updated']);
  assert.equal(out.results[0].entities.offersUpdated, 1);
  const all = readAll();
  assert.equal(all.length, 1);
  const offers = offersOf(all[0]);
  assert.equal(offers.length, 2);
  assert.equal(offers.find((o) => o.platform === 'temu').price, 259);
  assert.equal(offers.find((o) => o.platform === 'amazon').price, 299.99, 'la oferta de otro comerciante no se toca');
});

test('actualizar la oferta implícita (campos planos) cambia el precio plano y conserva lo demás', () => {
  reset();
  run([amazon()]);
  const out = run([amazon({ price: 279, capturedAt: '2026-10-07T09:00:00Z' })]);
  assert.deepEqual(outcomes(out), ['updated']);
  const all = readAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].price, 279);
  assert.equal(all[0].sourceId, 'B09XS7JWHH');
});

test('reimportar datos sin cambios no aumenta fichas ni ofertas ni reescribe el fichero', () => {
  reset();
  run([amazon(), temu()]);
  const before = fs.readFileSync(PRODUCTS, 'utf8');
  const mtime = fs.statSync(PRODUCTS).mtimeMs;
  const out = run([amazon(), temu()]);
  assert.deepEqual(outcomes(out), ['unchanged', 'unchanged']);
  assert.equal(out.changed, false);
  assert.equal(fs.readFileSync(PRODUCTS, 'utf8'), before);
  assert.equal(fs.statSync(PRODUCTS).mtimeMs, mtime);
});

test('la misma oferta creada por API (campos planos) y recibida por JSON no se copia', () => {
  reset([
    {
      id: 'ali-api', title: 'Cable USB-C trenzado 2m', description: 'Descripción IA', price: 4.5, image: 'https://i.example/a.jpg',
      category: 'Tecnología', merchant: 'AliExpress', network: 'aliexpress', sourceId: 'AE-1005001234567890',
      affiliateUrl: 'https://s.click.aliexpress.com/item/1005001234567890.html?aff=1', pros: [], cons: [],
    },
    {
      id: 'ebay-api', title: 'Taladro Bosch GSB', description: 'x', price: 80, image: 'https://i.example/b.jpg', category: 'Bricolaje',
      merchant: 'eBay', network: 'ebay', sourceId: 'v1|123456789012|0', affiliateUrl: 'https://www.ebay.es/itm/123456789012?campid=1', pros: [], cons: [],
    },
  ]);
  const out = run([
    { title: 'Cable USB-C trenzado 2m', platform: 'aliexpress', externalId: '1005001234567890', url: 'https://es.aliexpress.com/item/1005001234567890.html', price: 4.5, currency: 'EUR', image: 'https://i.example/a.jpg' },
    { title: 'Taladro Bosch GSB', platform: 'ebay', externalId: '123456789012', url: 'https://www.ebay.es/itm/123456789012', price: 75, currency: 'EUR', image: 'https://i.example/b.jpg' },
  ]);
  assert.deepEqual(outcomes(out), ['unchanged', 'updated']);
  const all = readAll();
  assert.equal(all.length, 2, 'ninguna ficha nueva');
  assert.equal(all.find((p) => p.id === 'ebay-api').price, 75);
  assert.equal(all.find((p) => p.id === 'ali-api').description, 'Descripción IA');
});

test('mismo anuncio con distintos vendedores de una plataforma → ofertas separadas; el vendedor «Amazon» es la propia plataforma', () => {
  reset();
  run([amazon()]);
  const out = run([
    amazon({ sellerName: 'FooShop', price: 289, url: 'https://www.amazon.es/dp/B09XS7JWHH' }),
    amazon({ sellerName: 'BarStore', price: 295, url: 'https://www.amazon.es/dp/B09XS7JWHH' }),
    amazon({ sellerName: 'Amazon', price: 299.99 }),
  ]);
  assert.deepEqual(outcomes(out), ['linked', 'linked', 'unchanged']);
  const all = readAll();
  assert.equal(all.length, 1);
  assert.equal(offersOf(all[0]).length, 3);
  assert.equal(all[0].price, 299.99, 'la oferta del vendedor externo no sustituye a la plataforma');
});

test('variantes distintas (capacidad/talla) no se fusionan', () => {
  reset();
  const a = { title: 'Móvil Acme X1 128 GB', brand: 'Acme', mpn: 'X1-128', capacity: '128 GB', image: 'https://i.example/x.jpg', platform: 'amazon', asin: 'B0AAAAAAA1', price: 400, currency: 'EUR' };
  const b = { ...a, title: 'Móvil Acme X1 256 GB', mpn: 'X1-256', capacity: '256 GB', asin: 'B0AAAAAAA2', price: 450 };
  const out = run([a, b]);
  assert.deepEqual(outcomes(out), ['created', 'created']);
  assert.equal(readAll().length, 2);
  // Misma referencia (MPN) pero capacidad distinta → NO se fusiona: revisión.
  const c = { ...b, platform: 'temu', asin: undefined, externalId: 'T-1', url: 'https://www.temu.com/g.html?goods_id=1', capacity: '512 GB', title: 'Acme X1 512GB' };
  const rev = run([c]);
  assert.deepEqual(outcomes(rev), ['review']);
  assert.ok(rev.results[0].reasons[0].includes('atributos_en_conflicto'));
  assert.equal(readAll().length, 2);
});

test('nuevo / usado / reacondicionado del mismo modelo son fichas distintas', () => {
  reset();
  run([amazon({ condition: 'Nuevo' })]);
  const used = run([amazon({ asin: 'B0USEDUSED1', url: 'https://www.amazon.es/dp/B0USEDUSED1', condition: 'Usado - Como nuevo', price: 180 })]);
  assert.deepEqual(outcomes(used), ['created']);
  const refurb = run([temu({ condition: 'Reacondicionado', price: 200 })]);
  assert.deepEqual(outcomes(refurb), ['created']);
  const all = readAll();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((p) => p.condition).sort(), ['Nuevo', 'Reacondicionado', 'Usado']);
});

test('coincidencia dudosa (sólo título) → revisión, sin fusión ni ficha duplicada', () => {
  reset();
  run([amazon({ gtin: undefined })]);
  const before = fs.readFileSync(PRODUCTS, 'utf8');
  const out = run([{ title: 'Auriculares Sony WH-1000XM5 Negro', platform: 'pccomponentes', externalId: '777', url: 'https://www.pccomponentes.com/sony-wh1000xm5', price: 310, currency: 'EUR', image: 'https://i.example/p.jpg' }]);
  assert.deepEqual(outcomes(out), ['review']);
  assert.ok(out.results[0].candidates.length >= 1);
  assert.equal(fs.readFileSync(PRODUCTS, 'utf8'), before, 'el catálogo no cambia');
  const reviews = JSON.parse(fs.readFileSync(path.join(dir, 'import-review.json'), 'utf8'));
  assert.ok(reviews.some((r) => r.status === 'pending' && r.record?.offer?.platform === 'pccomponentes'));
});

test('contenido enriquecido y ediciones manuales se conservan', () => {
  reset([
    {
      id: 'amazon-b09xs7jwhh', title: 'Sony WH-1000XM5 (título editado)', description: 'Texto optimizado con IA', price: 299.99, currency: 'EUR',
      image: 'https://i.example/a.jpg', category: 'Audio', merchant: 'Amazon', network: 'amazon', sourceId: 'B09XS7JWHH', asin: 'B09XS7JWHH',
      affiliateUrl: 'https://www.amazon.es/dp/B09XS7JWHH?tag=treidilor-21', pros: ['Cancelación de ruido'], cons: [], verdict: 'Veredicto propio',
      ai_enriched: true, ia_status: 'completed', title_short: 'Sony XM5', brand: 'Sony', slug: 'sony-xm5',
      extra: { lockedFields: ['title', 'description'], observations: [{ x: 1 }] },
    },
  ]);
  const out = run([amazon({ title: 'TÍTULO NUEVO DEL COMERCIO', description: 'Descripción nueva', price: 289 })]);
  assert.deepEqual(outcomes(out), ['updated']);
  const p = readAll()[0];
  assert.equal(p.price, 289);
  assert.equal(p.title, 'Sony WH-1000XM5 (título editado)');
  assert.equal(p.description, 'Texto optimizado con IA');
  assert.equal(p.verdict, 'Veredicto propio');
  assert.deepEqual(p.pros, ['Cancelación de ruido']);
  assert.equal(p.slug, 'sony-xm5');
  assert.equal(p.title_short, 'Sony XM5');
  assert.equal(p.ai_enriched, true);
  assert.equal(p.affiliateUrl, 'https://www.amazon.es/dp/B09XS7JWHH?tag=treidilor-21', 'el enlace de afiliado no se sustituye por la URL del JSON');
  assert.deepEqual(p.extra.observations, [{ x: 1 }]);
  assert.deepEqual(p.extra.lockedFields, ['title', 'description']);
});

test('un dato desconocido o ausente no borra uno conocido; una lectura antigua no pisa una más reciente (oferta adicional)', () => {
  reset();
  run([amazon({ shipping: { cost: 4.99, days: 3 }, originalPrice: 349 })]);
  const out = run([amazon({ availability: undefined, shipping: undefined, originalPrice: undefined, capturedAt: '2026-10-07T09:00:00Z' })]);
  assert.deepEqual(outcomes(out), ['unchanged']);
  assert.equal(readAll()[0].inStock, true, 'disponibilidad desconocida no sustituye a la conocida');
  // Oferta adicional: la fecha de CAPTURA guardada permite descartar una lectura anterior.
  run([temu({ capturedAt: '2026-10-07T10:00:00Z' })]);
  const stale = run([temu({ price: 1, capturedAt: '2026-10-01T00:00:00Z' })]);
  assert.deepEqual(outcomes(stale), ['unchanged']);
  assert.ok(stale.results[0].reasons.includes('lectura_anterior_descartada'));
  assert.equal(offersOf(readAll()[0]).find((o) => o.platform === 'temu').price, 279.5);
});

test('oferta PRINCIPAL: la fecha de captura de la lectura se guarda aparte (con procedencia) y descarta lecturas fiables más antiguas', () => {
  reset();
  run([amazon({ capturedAt: '2026-10-05T10:00:00Z' })]);
  const reading = readAll()[0].extra.priceReading;
  assert.equal(new Date(reading.capturedAt).toISOString(), '2026-10-05T10:00:00.000Z');
  assert.equal(reading.capturedAtInferred, false);
  assert.equal(reading.source.channel, 'json');
  assert.ok(reading.receivedAt && reading.source.batchId);
  const older = run([amazon({ price: 100, capturedAt: '2026-10-01T10:00:00Z' })]);
  assert.deepEqual(outcomes(older), ['unchanged']);
  assert.ok(older.results[0].reasons.includes('lectura_anterior_descartada'));
  assert.equal(readAll()[0].price, 299.99);
  assert.equal(readAll()[0].lastPriceSync, undefined, 'y no se afirma ninguna verificación');
});

test('los datos comerciales nuevos de un comerciante (envío, disponibilidad) se guardan en su oferta', () => {
  reset();
  run([amazon()]);
  run([temu({ shipping: { cost: 3.5, days: 12 }, availability: 'out_of_stock' })]);
  const t = offersOf(readAll()[0]).find((o) => o.platform === 'temu');
  assert.equal(t.availability, 'out_of_stock');
  assert.equal(t.shipping.cost, 3.5);
  assert.equal(t.shipping.free, null, 'envío con coste conocido no implica gratis; sin dato, desconocido');
  const a = offersOf(readAll()[0]).find((o) => o.platform === 'amazon');
  assert.equal(a.availability, 'in_stock');
});

/* ───────────────────────── Lotes, reintentos y errores ───────────────────────── */

test('los errores no bloquean los registros válidos del lote', () => {
  reset();
  const out = run([{ title: 'x' }, amazon(), 42, null, temu()]);
  assert.deepEqual(outcomes(out), ['rejected', 'created', 'rejected', 'rejected', 'linked']);
  assert.equal(readAll().length, 1);
  assert.ok(out.results[0].reasons.length > 0);
});

test('duplicados dentro del mismo bloque y reintentos/ejecuciones repetidas no crean copias', () => {
  reset();
  const id = batch();
  const out = run([amazon(), amazon(), temu(), temu()], { batchId: id });
  assert.deepEqual(outcomes(out), ['created', 'unchanged', 'linked', 'unchanged']);
  // Reintento del mismo bloque (cliente reenvía tras un corte).
  const retry = run([amazon(), amazon(), temu(), temu()], { batchId: id });
  assert.deepEqual(outcomes(retry), ['unchanged', 'unchanged', 'unchanged', 'unchanged']);
  // «Ejecución simultánea»: otro lote con los mismos datos.
  const other = run([amazon(), temu()]);
  assert.deepEqual(outcomes(other), ['unchanged', 'unchanged']);
  const all = readAll();
  assert.equal(all.length, 1);
  assert.equal(offersOf(all[0]).length, 2);
  // El informe es idempotente por índice.
  const report = service.readBatchReport(id);
  assert.equal(report.results.length, 4);
});

test('interrupción a mitad: reanudar con todos los bloques da el mismo catálogo que sin interrupción', () => {
  reset();
  const records = Array.from({ length: 30 }, (_, i) => ({
    title: `Producto de prueba número ${i}`, brand: 'Marca', platform: 'tienda', externalId: `SKU-${i}`, url: `https://tienda.example/p/${i}`,
    price: 10 + i, currency: 'EUR', image: `https://i.example/${i}.jpg`,
  }));
  const id = batch();
  run(records.slice(0, 10), { batchId: id, indexOffset: 0 });
  // (se corta aquí) → se reenvía todo desde el principio
  for (let o = 0; o < 30; o += 10) run(records.slice(o, o + 10), { batchId: id, indexOffset: o });
  assert.equal(readAll().length, 30);
  assert.equal(new Set(readAll().map((p) => p.id)).size, 30);
});

test('producto eliminado anteriormente no resucita; colisión de id no reemplaza fichas', () => {
  reset();
  fs.writeFileSync(path.join(dir, 'deleted-product-ids.json'), JSON.stringify(['amazon-b09xs7jwhh']));
  const out = run([amazon()]);
  assert.deepEqual(outcomes(out), ['rejected']);
  assert.ok(out.results[0].reasons.includes('producto_eliminado_anteriormente'));
  fs.rmSync(path.join(dir, 'deleted-product-ids.json'));

  reset([{ id: 'amazon-b09xs7jwhh', title: 'Otra cosa distinta', description: '', price: 5, image: 'https://i/a.jpg', category: 'X', merchant: 'Otro', network: 'otro', sourceId: 'zzz', affiliateUrl: 'https://otro.example/1', pros: [], cons: [] }]);
  const coll = run([amazon({ gtin: undefined })]);
  assert.deepEqual(outcomes(coll), ['created']);
  const all = readAll();
  assert.equal(all.length, 2);
  assert.equal(all.find((p) => p.title === 'Otra cosa distinta').price, 5, 'la ficha existente sigue intacta');
});

test('crear ficha exige imagen; vincular una oferta a una ficha existente no', () => {
  reset();
  const sinImagen = run([amazon({ image: undefined })]);
  assert.deepEqual(outcomes(sinImagen), ['rejected']);
  assert.ok(sinImagen.results[0].reasons.includes('falta_imagen_para_crear_ficha'));
  run([amazon()]);
  const link = run([temu({ image: undefined })]);
  assert.deepEqual(outcomes(link), ['linked']);
});

test('registros SIN categoría: quedan en revisión con sus datos, no se publican; vincular ofertas sigue funcionando', () => {
  reset();
  const sinCategoria = run([amazon()], { defaults: {} });
  assert.deepEqual(outcomes(sinCategoria), ['review']);
  assert.deepEqual(sinCategoria.results[0].reasons, ['sin_categoria']);
  assert.equal(readAll().length, 0, 'no entra en el catálogo público');
  const reviews = JSON.parse(fs.readFileSync(path.join(dir, 'import-review.json'), 'utf8'));
  const item = reviews.find((r) => r.reasons.includes('sin_categoria') && r.record?.offer?.externalId === 'B09XS7JWHH');
  assert.ok(item, 'queda en la cola de revisión');
  assert.equal(item.record.product.title, 'Auriculares Sony WH-1000XM5 Negro', 'conserva los datos para resolverlo después');
  assert.equal(item.record.offer.price, 299.99);
  // Con categoría (en el registro o por defecto) sí entra; y una oferta sin categoría puede vincularse a una ficha existente.
  assert.deepEqual(outcomes(run([amazon({ category: 'Audio' })], { defaults: {} })), ['created']);
  assert.deepEqual(outcomes(run([temu()], { defaults: {} })), ['linked']);
  assert.equal(readAll().length, 1);
});

test('modo simulación no escribe nada; el lote real crea copia de seguridad', () => {
  reset();
  const before = fs.readFileSync(PRODUCTS, 'utf8');
  const dry = run([amazon()], { dryRun: true });
  assert.deepEqual(outcomes(dry), ['created']);
  assert.equal(fs.readFileSync(PRODUCTS, 'utf8'), before);
  const id = batch();
  const { backup } = service.startBatch(id, false);
  assert.ok(backup && fs.existsSync(path.join(dir, 'import-backups', backup)));
  assert.equal(service.startBatch(id, false).backup, backup, 'idempotente por lote');
});

test('la copia de seguridad se crea justo antes del primer bloque que modifica el catálogo, no antes', () => {
  reset();
  const names = () => (fs.existsSync(path.join(dir, 'import-backups')) ? fs.readdirSync(path.join(dir, 'import-backups')).sort() : []);
  const id = batch();
  const before = names();
  const noChange = run([{ title: 'x' }], { batchId: id });
  assert.deepEqual(outcomes(noChange), ['rejected']);
  assert.deepEqual(names(), before, 'un bloque que no cambia nada no genera copia');
  const changed = run([amazon()], { batchId: id });
  assert.ok(changed.backup, 'el bloque que modifica devuelve su copia');
  assert.ok(names().includes(changed.backup));
  assert.ok(names().length <= 5, 'retención: sólo las últimas 5 copias');
  const copy = JSON.parse(fs.readFileSync(path.join(dir, 'import-backups', changed.backup), 'utf8'));
  assert.deepEqual(copy, [], 'la copia contiene el estado ANTERIOR a la importación');
});

test('la ficha creada es válida para el catálogo público y no depende del ASIN', () => {
  reset();
  run([amazon(), temu({ gtin: GTIN_B, title: 'Cargador GaN 65W', brand: 'Anker' })]);
  for (const p of readAll()) {
    const valid = validateSingleProduct(p);
    assert.ok(valid, `la ficha ${p.id} debe pasar el esquema del catálogo`);
  }
  const t = readAll().find((p) => p.network === 'temu');
  assert.equal(t.asin, undefined);
  assert.equal(t.link_status, 'pending', 'sin enlace de afiliado explícito queda pendiente');
  assert.equal(t.category, 'Prueba');
  assert.equal(t.ia_status, 'pending');
});

test('las fichas existentes sin ofertas adicionales siguen leyéndose igual (oferta implícita)', () => {
  const legacy = { id: 'l', title: 'Legacy', price: 10, currency: undefined, image: 'x', category: 'c', merchant: 'Amazon', network: 'amazon', sourceId: 'B0LEGACY01', affiliateUrl: 'https://www.amazon.es/dp/B0LEGACY01', pros: [], cons: [] };
  const offers = engine.getOffers(legacy);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].implicit, true);
  assert.equal(offers[0].currency, 'EUR');
  assert.equal(offers[0].availability, 'unknown');
  assert.equal(offers[0].shipping.free, null);
});

test('rendimiento: 1.000 registros nuevos + reimportación en pocos segundos', () => {
  reset();
  const records = Array.from({ length: 1000 }, (_, i) => ({
    title: `Artículo masivo ${i} modelo ${i * 7}`, brand: `Marca${i % 20}`, platform: 'tienda', externalId: `S${i}`, url: `https://t.example/p/${i}`,
    price: 5 + (i % 90), currency: 'EUR', image: `https://i.example/${i}.jpg`,
  }));
  const id = batch();
  const t0 = Date.now();
  for (let o = 0; o < 1000; o += 100) run(records.slice(o, o + 100), { batchId: id, indexOffset: o });
  assert.equal(readAll().length, 1000);
  for (let o = 0; o < 1000; o += 100) run(records.slice(o, o + 100), { batchId: id, indexOffset: o });
  assert.equal(readAll().length, 1000);
  assert.ok(Date.now() - t0 < 20000, `tardó ${Date.now() - t0} ms`);
});

test('resumen: suma de resultados principales = procesados; una entrada puede crear ficha y oferta', () => {
  reset();
  const out = run([amazon(), temu(), { title: 'x' }]);
  const s = service.summarize(out.results);
  assert.equal(s.processed, 3);
  assert.equal(Object.values(s.outcomes).reduce((a, b) => a + b, 0), 3);
  assert.deepEqual(s.entities, { productsCreated: 1, offersCreated: 2, offersUpdated: 0 });
});

test('regresión: el contrato de productStore.upsertProduct no cambia', () => {
  reset();
  const saved = store.upsertProduct({ id: 'z', title: 'Z', description: '', price: 1, image: 'x', category: 'c', merchant: 'm', affiliateUrl: 'u', pros: [], cons: [] });
  assert.equal(saved.updated, false);
  assert.equal(readAll()[0].id, 'z');
});

test('fecha de captura: de dónde sale y qué pasa si falta, es inválida o es futura (recepción ≠ captura ≠ verificación)', () => {
  const now = '2026-10-10T12:00:00.000Z';
  const norm = (over, defaults = {}) => normalize.normalizeRecord(amazon(over), 0, defaults, now).record;
  // válida: la que da la fuente (varios nombres de campo y epoch)
  assert.equal(norm({ capturedAt: '2026-10-09T08:00:00Z' }).offer.capturedAt, '2026-10-09T08:00:00.000Z');
  assert.equal(norm({ capturedAt: undefined, scrapedAt: '2026-10-08T08:00:00Z' }).offer.capturedAt, '2026-10-08T08:00:00.000Z');
  assert.equal(norm({ capturedAt: 1762675200 }).offer.capturedAt, '2025-11-09T08:00:00.000Z', 'epoch en segundos');
  // por defecto del envoltorio
  assert.equal(norm({ capturedAt: undefined }, { capturedAt: '2026-10-05T00:00:00Z' }).offer.capturedAt, '2026-10-05T00:00:00.000Z');
  // ausente → inferida (= recepción) y marcada
  const missing = norm({ capturedAt: undefined });
  assert.equal(missing.offer.capturedAt, now);
  assert.equal(missing.offer.capturedAtInferred, true);
  assert.deepEqual(missing.warnings.filter((w) => w.startsWith('fecha_')), ['fecha_captura_inferida']);
  // inválida → ignorada y avisada
  const invalid = norm({ capturedAt: 'ayer por la tarde' });
  assert.equal(invalid.offer.capturedAtInferred, true);
  assert.ok(invalid.warnings.includes('fecha_captura_invalida_descartada'));
  // futura (> 1 h) → ignorada y avisada; una dentro de la tolerancia se acepta
  const future = norm({ capturedAt: '2027-01-01T00:00:00Z' });
  assert.equal(future.offer.capturedAtInferred, true);
  assert.ok(future.warnings.includes('fecha_captura_futura_descartada'));
  assert.equal(norm({ capturedAt: '2026-10-10T12:30:00Z' }).offer.capturedAtInferred, undefined, '30 min por delante: tolerancia de reloj');
});

test('una fecha futura NO bloquea las lecturas legítimas posteriores (si se aceptara, todas se descartarían como «anteriores»)', () => {
  reset();
  run([amazon(), temu({ capturedAt: '2999-01-01T00:00:00Z' })]);
  const stored = offersOf(readAll()[0]).find((o) => o.platform === 'temu');
  assert.equal(stored.capturedAtInferred, true, 'la fecha futura se descartó y se infirió');
  const later = run([temu({ price: 250, capturedAt: '2026-10-20T10:00:00Z' })]);
  assert.deepEqual(outcomes(later), ['updated']);
});

test('un JSON recibido ahora NO verifica el precio: la oferta guarda recepción, captura y una verificación vacía', () => {
  reset();
  run([amazon(), temu({ capturedAt: '2026-10-01T10:00:00Z' })]);
  const offer = offersOf(readAll()[0]).find((o) => o.platform === 'temu');
  assert.equal(new Date(offer.capturedAt).toISOString(), '2026-10-01T10:00:00.000Z', 'captura = la de la fuente (antigua)');
  assert.ok(Date.parse(offer.receivedAt) > Date.parse('2026-10-01'), 'recepción = ahora');
  assert.equal(offer.verifiedAt, '', 'verificación: ninguna');
  assert.equal(readAll()[0].lastPriceSync, undefined);
});
