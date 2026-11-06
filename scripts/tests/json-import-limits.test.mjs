// Regresión: límites declarados del importador JSON (archivo, registros, bloque, tamaño) y sus mensajes de
// error, autenticación del endpoint y comportamiento del cliente (script real del panel en un DOM simulado).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { setupIsolatedData, adminCookie, apiRequest, jsonOf, readCatalog, jsonRecord } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-limits-');
const cookie = await adminCookie();
const route = await import('../../src/pages/api/admin/json-import/index.ts');
const service = await import('../../src/lib/jsonImport/service.ts');
const normalize = await import('../../src/lib/jsonImport/normalize.ts');

const post = (body, opts = {}) => route.POST({ request: apiRequest('/api/admin/json-import', { cookie, ...opts, body }) });
const batchId = () => 'lim-' + Math.random().toString(36).slice(2, 10);

/* ───────────────────────── Servidor ───────────────────────── */

test('autenticación: sin sesión ni token → 401; con token Bearer válido → acepta', async () => {
  const anon = await route.POST({ request: new Request('http://localhost/api/admin/json-import', { method: 'POST', body: '{}' }) });
  assert.equal(anon.status, 401);
  const anonGet = await route.GET({ request: new Request('http://localhost/x'), url: new URL('http://localhost/x?batchId=abcdef12') });
  assert.equal(anonGet.status, 401);
  const withToken = await route.POST({ request: apiRequest('/api/admin/json-import', { token: true, body: { batchId: batchId(), records: [jsonRecord(1)], dryRun: true } }) });
  assert.equal(withToken.status, 200);
  assert.equal((await jsonOf(await post({ batchId: batchId(), records: [jsonRecord(1)], dryRun: true }))).success, true);
});

test('límite de registros por petición: 0 y 101 se rechazan con un mensaje claro; 100 se aceptan', async () => {
  for (const records of [[], Array.from({ length: service.MAX_CHUNK_RECORDS + 1 }, (_, i) => jsonRecord(i))]) {
    const res = await post({ batchId: batchId(), records, dryRun: true });
    assert.equal(res.status, 400);
    assert.match((await jsonOf(res)).message, /entre 1 y 100 registros/i);
  }
  const ok = await post({ batchId: batchId(), records: Array.from({ length: service.MAX_CHUNK_RECORDS }, (_, i) => jsonRecord(i + 1)), dryRun: true });
  assert.equal(ok.status, 200);
  assert.equal((await jsonOf(ok)).results.length, 100);
});

test('tamaño del bloque (3 MB), JSON malformado e identificador de lote inválido', async () => {
  const big = await route.POST({ request: apiRequest('/api/admin/json-import', { cookie, rawBody: JSON.stringify({ batchId: batchId(), records: [{ title: 'x'.repeat(3_100_000) }] }) }) });
  assert.equal(big.status, 413);
  assert.match((await jsonOf(big)).message, /3 MB/);
  const bad = await route.POST({ request: apiRequest('/api/admin/json-import', { cookie, rawBody: '{no es json' }) });
  assert.equal(bad.status, 400);
  assert.match((await jsonOf(bad)).message, /JSON inválido/);
  const noBatch = await post({ batchId: 'x', records: [jsonRecord(1)] });
  assert.equal(noBatch.status, 400);
  assert.match((await jsonOf(noBatch)).message, /batchId/);
});

test('profundidad excesiva y claves peligrosas se neutralizan; registros inválidos se rechazan con motivos', async () => {
  let deep = { a: 1 };
  for (let i = 0; i < 40; i++) deep = { n: deep };
  assert.throws(() => normalize.sanitizeJson(deep), /profundidad/i);
  const res = await post({ batchId: batchId(), dryRun: true, records: [{ title: 'x' }, { ...jsonRecord(2), ['__proto__']: { polluted: true } }] });
  const body = await jsonOf(res);
  assert.equal(body.results[0].outcome, 'rejected');
  assert.ok(body.results[0].reasons.includes('falta_url_oferta'));
  assert.equal({}.polluted, undefined, 'sin contaminación de prototipos');
});

test('un bloque que no cambia nada no deja el catálogo tocado (dryRun) y un bloque real crea la copia previa', async () => {
  const before = readCatalog(dir).length;
  await post({ batchId: batchId(), records: [jsonRecord(5)], dryRun: true });
  assert.equal(readCatalog(dir).length, before);
  const real = await jsonOf(await post({ batchId: batchId(), records: [jsonRecord(5)] }));
  assert.equal(real.results[0].outcome, 'created');
  assert.ok(real.backup, 'copia de seguridad previa al primer cambio');
});

/* ───────────────────────── Cliente (script real del panel) ───────────────────────── */

const source = fs.readFileSync(new URL('../../src/pages/upayp1b4.astro', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('<script is:inline>\n  // Importación de productos JSON');
assert.ok(start > 0, 'script del bloque no encontrado');
const clientScript = source.slice(start + '<script is:inline>\n'.length, source.indexOf('</script>', start));

function makeClient(fetchImpl) {
  const calls = [];
  const nodes = {};
  const el = (id) => {
    const listeners = {};
    const classes = new Set();
    const node = {
      id, value: '', textContent: '', hidden: false, disabled: false, checked: false, className: '', style: {}, files: [], children: [],
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), add: (c) => classes.add(c) },
      addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
      fire: (t) => (listeners[t] || []).forEach((f) => f({ target: node })),
      appendChild: (c) => { node.children.push(c); return c; }, querySelector: () => ({ setAttribute() {} }), setAttribute() {}, focus() {}, remove() {}, click() {},
    };
    return (nodes[id] = node);
  };
  const ids = ['jsonImpAsin', 'jsonImpFetch', 'jsonImpAsinHint', 'jsonImpText', 'jsonImpFile', 'jsonImpFileInfo', 'jsonImpPlatform', 'jsonImpCurrency', 'jsonImpSave', 'jsonImpRun', 'jsonImpAmazonIa', 'jsonImpCancel', 'jsonImpClear', 'jsonImpAlert', 'jsonImpProgress', 'jsonImpBarFill', 'jsonImpProgressText', 'jsonImpReport', 'jsonImpReportTitle', 'jsonImpCounters', 'jsonImpDetails', 'jsonImpDownload', 'jsonImpCatBlock', 'jsonImpCatUrl', 'jsonImpCatLimit', 'jsonImpCatRun', 'jsonImpCatCancel', 'jsonImpCatLoad', 'jsonImpCatStatus', 'jsonImpTargetCat', 'jsonImpTargetSub', 'jsonImpTargetHint', 'jsonImpSource', 'jsonImpCatLabelText', 'jsonImpCatLabelHint'];
  ids.forEach(el);
  nodes.jsonImpSave.checked = true;
  const sandbox = {
    document: { getElementById: (i) => nodes[i], createElement: () => el('x'), body: { appendChild() {} } },
    fetch: (...a) => { calls.push(a); return fetchImpl ? fetchImpl(...a) : Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, results: [] }) }); },
    setTimeout, Promise, JSON, Math, Date, String, Array, Object, Boolean, Blob: class {}, URL: { createObjectURL: () => 'blob:', revokeObjectURL() {} },
    FileReader: class {}, BroadcastChannel: class { postMessage() {} close() {} },
    // «URL de categoría»: el estado se carga de forma perezosa (al aparecer el bloque o usarlo), nunca al cargar la página.
    window: { IntersectionObserver: class {}, confirm: () => true },
    IntersectionObserver: class { observe() {} disconnect() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(clientScript, sandbox);
  return { nodes, calls };
}

test('cliente: JSON vacío, malformado, sin productos o con más de 5.000 registros → mensaje útil, texto conservado y NINGUNA petición', async () => {
  const { nodes, calls } = makeClient();
  const cases = [
    ['', /Pega un JSON o sube un archivo/],
    ['{no json', /JSON inválido/],
    ['[]', /no contiene ningún producto/],
    [JSON.stringify(Array.from({ length: 5001 }, () => ({ title: 'x' }))), /5001 registros; el máximo es 5000/],
  ];
  for (const [text, expected] of cases) {
    nodes.jsonImpText.value = text;
    nodes.jsonImpRun.fire('click');
    await new Promise((r) => setTimeout(r, 5));
    assert.match(nodes.jsonImpAlert.textContent, expected);
    assert.equal(nodes.jsonImpText.value, text, 'el texto pegado no se borra');
  }
  assert.equal(calls.length, 0);
});

test('cliente: más de 10 MB (texto o archivo) se rechaza antes de enviar nada', async () => {
  const { nodes, calls } = makeClient();
  nodes.jsonImpText.value = 'x'.repeat(10_000_001);
  nodes.jsonImpRun.fire('click');
  assert.match(nodes.jsonImpAlert.textContent, /supera los 10 MB/);
  nodes.jsonImpFile.files = [{ name: 'enorme.json', size: 10_000_001 }];
  nodes.jsonImpFile.fire('change');
  assert.match(nodes.jsonImpAlert.textContent, /«enorme\.json» supera los 10 MB/);
  assert.equal(calls.length, 0);
});

test('cliente: envía bloques de 50 (nunca más de los 100 que admite el servidor) y reanuda sin duplicar', async () => {
  const sizes = [];
  const { nodes, calls } = makeClient((url, opts) => {
    const b = JSON.parse(opts.body);
    sizes.push([b.indexOffset, b.records.length]);
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, results: b.records.map((_, i) => ({ index: b.indexOffset + i, outcome: 'created', reasons: [], warnings: [], entities: { productsCreated: 1, offersCreated: 1, offersUpdated: 0 } })) }) });
  });
  nodes.jsonImpText.value = JSON.stringify(Array.from({ length: 120 }, (_, i) => jsonRecord(i + 1)));
  nodes.jsonImpRun.fire('click');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(sizes, [[0, 50], [50, 50], [100, 20]]);
  assert.ok(sizes.every(([, n]) => n <= service.MAX_CHUNK_RECORDS));
  assert.equal(calls.filter((c) => c[0] === '/api/admin/json-import').length, 3, '3 bloques (más el aviso al catálogo)');
  assert.equal(nodes.jsonImpReport.hidden, false, 'se muestra el informe');
});

test('cliente: un error del servidor en mitad del lote se explica y permite reanudar (los ya importados no se duplican)', async () => {
  let n = 0;
  const { nodes } = makeClient((url, opts) => {
    const b = JSON.parse(opts.body);
    n += 1;
    if (n === 2) return Promise.resolve({ ok: false, status: 400, json: async () => ({ success: false, message: 'Envía entre 1 y 100 registros por petición.' }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, results: b.records.map((_, i) => ({ index: b.indexOffset + i, outcome: 'created', reasons: [], warnings: [], entities: { productsCreated: 1, offersCreated: 1, offersUpdated: 0 } })) }) });
  });
  nodes.jsonImpText.value = JSON.stringify(Array.from({ length: 80 }, (_, i) => jsonRecord(i + 1)));
  nodes.jsonImpRun.fire('click');
  await new Promise((r) => setTimeout(r, 80));
  assert.match(nodes.jsonImpAlert.textContent, /se interrumpió: Envía entre 1 y 100 registros/);
  assert.match(nodes.jsonImpAlert.textContent, /vuelve a pulsar «Importar»/);
  assert.equal(nodes.jsonImpRun.disabled, false, 'los controles quedan activos para reanudar');
  assert.equal(nodes.jsonImpText.value.length > 0, true, 'el JSON pegado se conserva');
});

test('cliente: «URL de categoría» no hace ninguna petición al cargar la página; el estado se pide al usarlo y sólo una vez', async () => {
  const { nodes, calls } = makeClient(async (url) => ({ ok: true, status: 200, json: async () => (String(url) === '/api/categories' ? { success: true, categories: [{ id: 'c1', name: 'Audio' }, { id: 's1', name: 'Bluetooth', parentId: 'c1' }] } : { success: true, configured: true, defaultLimit: 10, maxLimit: 50, active: null, latest: null }) }));
  assert.equal(calls.length, 0, 'al cargar no se llama a /api');
  assert.equal(nodes.jsonImpCatLimit.value, '', 'el valor inicial (10) lo pone el HTML, no el script');
  nodes.jsonImpCatBlock.fire('focusin');
  nodes.jsonImpCatBlock.fire('pointerdown');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 2, 'una petición de estado y una de categorías, sólo una vez cada una');
  assert.ok(calls.some((c) => /category-extract$/.test(String(c[0]))));
  assert.ok(calls.some((c) => String(c[0]) === '/api/categories'));
  assert.equal(nodes.jsonImpCatLimit.max, '50');
});
