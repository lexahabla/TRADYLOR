// Zona común de acciones del importador (script REAL del panel en un entorno simulado): simular / importar al catálogo /
// importar y enriquecer con IA, para todos los métodos de carga. Servidor y enriquecimiento SIMULADOS: ninguna prueba
// guarda en un catálogo real, llama a Apify/ScraperAPI ni gasta créditos de IA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../src/pages/upayp1b4.astro', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('<script is:inline>\n  // Importación de productos JSON');
assert.ok(start > 0, 'script del bloque no encontrado');
const clientScript = source.slice(start + '<script is:inline>\n'.length, source.indexOf('</script>', start));
const ids = [...new Set([...source.matchAll(/id="(jsonImp[A-Za-z]+)"/g)].map((m) => m[1]))];

function makeClient(fetchImpl) {
  const calls = [];
  const nodes = {};
  const el = (id) => {
    const listeners = {};
    const node = {
      id, value: '', textContent: '', hidden: true, disabled: false, checked: false, className: '', style: {}, files: [], children: [], max: '', placeholder: '',
      classList: { toggle() {}, add() {} },
      addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
      fire: (t) => (listeners[t] || []).forEach((f) => f({ target: node, key: '', preventDefault() {} })),
      appendChild: (c) => { node.children.push(c); return c; }, querySelector: () => ({ setAttribute() {} }), setAttribute() {}, focus() {}, remove() {}, click: () => node.fire('click'),
    };
    return (nodes[id] = node);
  };
  ids.forEach(el);
  nodes.jsonImpOnlyNew.checked = true; // por defecto: sólo productos nuevos
  ['jsonImpPlatform', 'jsonImpCurrency', 'jsonImpAsin', 'jsonImpText', 'jsonImpCatUrl', 'jsonImpCatLimit', 'jsonImpTargetCat', 'jsonImpTargetSub'].forEach((i) => { nodes[i].hidden = false; });
  nodes.jsonImpSource.value = 'amazon';
  const store = { _m: {}, getItem(k) { return k in this._m ? this._m[k] : null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
  const sandbox = {
    document: { getElementById: (i) => nodes[i], createElement: () => el('x'), body: { appendChild() {} } },
    fetch: (...a) => { calls.push(a); return fetchImpl(...a); },
    setTimeout, clearTimeout, sessionStorage: store, Promise, JSON, Math, Date, String, Array, Object, Boolean, Blob: class {}, URL: { createObjectURL: () => 'blob:', revokeObjectURL() {} },
    FileReader: class {}, BroadcastChannel: class { postMessage() {} close() {} },
    window: { IntersectionObserver: class {}, confirm: () => true },
    IntersectionObserver: class { observe() {} disconnect() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(clientScript, sandbox);
  return { nodes, calls, store };
}

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const resp = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const amz = (n, kind = 'new') => ({ asin: 'B0TEST000' + n, title: 'Producto Amazon ' + n, kind, externalId: 'a' + n, url: 'https://www.amazon.es/dp/B0TEST000' + n, price: 10 + n, currency: 'EUR' });
const temuRec = (n) => ({ goodsId: '70100000000000' + n, title: 'Producto Temu ' + n, kind: 'new', externalId: 't' + n, productUrl: 'https://www.temu.com/es/-g-70100000000000' + n + '.html', price: 5 + n, currency: 'EUR' });

/** Servidor simulado: json-import (nuevo → created; kind=existing → updated) y enrich-bulk configurable. */
function fakeServer({ enrichFail = () => false, enrichLocal = () => false, extra } = {}) {
  const log = { imports: [], enrich: [], other: [] };
  const fn = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (extra) { const r = extra(u, init); if (r) return r; }
    if (u === '/api/categories') return resp({ success: true, categories: [{ id: 'c1', name: 'Informatica' }, { id: 's1', name: 'Portatiles', parentId: 'c1' }] });
    if (u.endsWith('/api/admin/json-import')) {
      log.imports.push(body);
      return resp({ success: true, results: body.records.map((r, i) => ({ index: body.indexOffset + i, outcome: r.kind === 'existing' ? 'updated' : 'created', productId: 'p-' + (r.externalId || i), title: r.title, reasons: [], warnings: [], entities: { productsCreated: r.kind === 'existing' ? 0 : 1, offersCreated: r.kind === 'existing' ? 0 : 1, offersUpdated: r.kind === 'existing' ? 1 : 0 } })) });
    }
    if (u.endsWith('/api/admin/enrich-bulk')) {
      log.enrich.push(body);
      return resp({ success: true, results: body.ids.map((id) => (enrichFail(id) ? { id, title: id, ok: false, textStatus: 'error', imageStatus: 'error', warnings: ['límite de la IA'] } : { id, title: id, ok: true, textStatus: enrichLocal(id) ? 'local' : 'ok', imageStatus: 'skipped', warnings: [] })) });
    }
    log.other.push(u);
    return resp({ success: true });
  };
  return { fn, log };
}
const paste = (nodes, records) => { nodes.jsonImpText.value = JSON.stringify(records); nodes.jsonImpText.fire('input'); };

test('zona común: oculta sin datos; con datos muestra nº de productos, origen (Amazon/Temu), método de carga y destino', async () => {
  const { nodes } = makeClient(fakeServer().fn);
  assert.notEqual(nodes.jsonImpActionZone.hidden, false, 'sin productos cargados no se muestra');
  paste(nodes, [amz(1), amz(2), temuRec(3)]);
  await wait(320);
  assert.equal(nodes.jsonImpActionZone.hidden, false);
  assert.equal(nodes.jsonImpSumCount.textContent, '3');
  assert.match(nodes.jsonImpSumSource.textContent, /Amazon \(2\)/);
  assert.match(nodes.jsonImpSumSource.textContent, /Temu \(1\)/);
  assert.match(nodes.jsonImpSumSource.textContent, /JSON pegado/);
  assert.match(nodes.jsonImpSumTarget.textContent, /Automático/);
  nodes.jsonImpText.value = '{no json'; nodes.jsonImpText.fire('input');
  await wait(320);
  assert.equal(nodes.jsonImpSumCount.textContent, 'JSON no válido');
  nodes.jsonImpClear.fire('click');
  assert.equal(nodes.jsonImpActionZone.hidden, true);
});

test('zona común: el destino elegido se muestra en el resumen y viaja en el envío', async () => {
  const f = fakeServer();
  const { nodes } = makeClient(f.fn);
  nodes.jsonImpTargetCat.fire('focusin');
  await wait(60);
  nodes.jsonImpTargetCat.value = 'c1';
  nodes.jsonImpTargetCat.fire('change');
  nodes.jsonImpTargetSub.value = 's1';
  paste(nodes, [amz(1)]);
  nodes.jsonImpTargetSub.fire('change');
  assert.match(nodes.jsonImpSumTarget.textContent, /Informatica › Portatiles/);
  nodes.jsonImpSimulate.fire('click');
  await wait(100);
  assert.deepEqual(f.log.imports[0].target, { categoryId: 'c1', subcategoryId: 's1' });
});

test('el método ASIN / URL individual alimenta el MISMO resumen y botones, reutilizando los datos ya cargados', async () => {
  const f = fakeServer({ extra: (u) => (u.startsWith('/api/scrape') ? resp({ asin: 'B01EXDG2MO', title: 'Producto ASIN', url: 'https://www.amazon.es/dp/B01EXDG2MO', price: 9, currency: 'EUR', kind: 'new', externalId: 'asin1' }) : null) });
  const { nodes, calls } = makeClient(f.fn);
  nodes.jsonImpAsin.value = 'B01EXDG2MO';
  nodes.jsonImpFetch.fire('click');
  await wait(100);
  assert.equal(nodes.jsonImpActionZone.hidden, false);
  assert.equal(nodes.jsonImpSumCount.textContent, '1');
  assert.match(nodes.jsonImpSumSource.textContent, /ASIN o URL individual/);
  const scrapeCalls = calls.filter((c) => String(c[0]).startsWith('/api/scrape')).length;
  assert.deepEqual(f.log.imports.map((b) => b.dryRun), [true], 'la comprobación automática es una simulación: no guarda');
  nodes.jsonImpImport.fire('click');
  await wait(100);
  assert.deepEqual(f.log.imports.map((b) => b.dryRun), [true, false]);
  assert.equal(calls.filter((c) => String(c[0]).startsWith('/api/scrape')).length, scrapeCalls, 'importar no vuelve a llamar a ScraperAPI');
});

test('«Simular importación» nunca guarda y no enriquece; «Importar al catálogo» guarda sin IA y sin llamar a Apify/ScraperAPI', async () => {
  const f = fakeServer();
  const { nodes, calls } = makeClient(f.fn);
  paste(nodes, [amz(1), amz(2)]);
  nodes.jsonImpSimulate.fire('click');
  await wait(100);
  assert.deepEqual(f.log.imports.map((b) => b.dryRun), [true]);
  assert.equal(f.log.enrich.length, 0);
  assert.match(nodes.jsonImpAlert.textContent, /NO se ha guardado nada/);
  nodes.jsonImpImport.fire('click');
  await wait(100);
  assert.deepEqual(f.log.imports.map((b) => b.dryRun), [true, false]);
  assert.equal(f.log.enrich.length, 0, 'importar sin IA nunca llama al enriquecimiento');
  assert.match(nodes.jsonImpAlert.textContent, /Sin IA/);
  assert.equal(calls.some((c) => /apify|scrape|category-extract/i.test(String(c[0]))), false);
});

test('doble clic / pulsar varios botones a la vez: un solo envío (bloqueo mientras corre)', async () => {
  const f = fakeServer();
  const { nodes } = makeClient(f.fn);
  paste(nodes, [amz(1)]);
  nodes.jsonImpImport.fire('click');
  nodes.jsonImpImport.fire('click');
  nodes.jsonImpImportAi.fire('click');
  nodes.jsonImpSimulate.fire('click');
  await wait(150);
  assert.equal(f.log.imports.length, 1, JSON.stringify(f.log.imports.map((b) => b.dryRun)));
  assert.equal(f.log.imports[0].dryRun, false);
});

test('«Importar y enriquecer con IA»: vista previa gratuita, confirmación con recuento y créditos, y solo enriquece las fichas NUEVAS', async () => {
  const f = fakeServer();
  const { nodes } = makeClient(f.fn);
  paste(nodes, [amz(1), amz(2, 'existing'), temuRec(3)]);
  nodes.jsonImpImportAi.fire('click');
  await wait(120);
  assert.deepEqual(f.log.imports.map((b) => b.dryRun), [true], 'la vista previa es una simulación: no guarda');
  assert.equal(f.log.enrich.length, 0, 'sin confirmar no se gasta ningún crédito');
  assert.equal(nodes.jsonImpAiConfirm.hidden, false);
  assert.match(nodes.jsonImpAiConfirmText.textContent, /2 ficha\(s\) NUEVA/);
  assert.match(nodes.jsonImpAiConfirmText.textContent, /CONSUME CRÉDITOS DE IA/);
  assert.match(nodes.jsonImpAiConfirmText.textContent, /existentes no se enriquecen/);
  nodes.jsonImpAiConfirmNo.fire('click');
  assert.equal(nodes.jsonImpAiConfirm.hidden, true);
  assert.equal(f.log.imports.length, 1, 'cancelar no importa ni enriquece');
  nodes.jsonImpImportAi.fire('click');
  await wait(120);
  nodes.jsonImpAiConfirmGo.fire('click');
  await wait(250);
  assert.deepEqual(f.log.imports.map((b) => b.dryRun), [true, true, false]);
  assert.equal(f.log.enrich.length, 1);
  assert.deepEqual([...f.log.enrich[0].ids].sort(), ['p-a1', 'p-t3'], 'la ficha existente (actualizada) no se enriquece');
  assert.equal(f.log.enrich[0].forceImage, false);
  assert.equal(nodes.jsonImpEnrich.hidden, false);
  assert.equal(nodes.jsonImpEnrichRetry.hidden, true, 'sin pendientes no hay reintento');
});

test('sin fichas nuevas, «Importar y enriquecer con IA» no gasta créditos ni importa; lo explica', async () => {
  const f = fakeServer();
  const { nodes } = makeClient(f.fn);
  paste(nodes, [amz(1, 'existing'), amz(2, 'existing')]);
  nodes.jsonImpImportAi.fire('click');
  await wait(120);
  assert.equal(nodes.jsonImpAiConfirm.hidden, true);
  assert.match(nodes.jsonImpAlert.textContent, /No hay fichas nuevas que enriquecer/);
  assert.equal(f.log.enrich.length, 0);
  assert.deepEqual(f.log.imports.map((b) => b.dryRun), [true]);
});

test('si la IA falla: los productos importados se conservan, el enriquecimiento va por lotes y se reintenta SOLO lo pendiente', async () => {
  const failing = new Set(['p-a6', 'p-a7']);
  const f = fakeServer({ enrichFail: (id) => failing.has(id), enrichLocal: (id) => id === 'p-a2' });
  const { nodes, store } = makeClient(f.fn);
  paste(nodes, [1, 2, 3, 4, 5, 6, 7].map((n) => amz(n)));
  nodes.jsonImpImportAi.fire('click');
  await wait(120);
  nodes.jsonImpAiConfirmGo.fire('click');
  await wait(350);
  assert.equal(f.log.imports.filter((b) => b.dryRun === false).length, 1, 'se importó una sola vez');
  assert.deepEqual(f.log.enrich.map((b) => b.ids.length), [5, 2], 'lotes de 5');
  assert.equal(nodes.jsonImpEnrichRetry.hidden, false);
  assert.match(nodes.jsonImpEnrichRetry.textContent, /\(3\)/);
  assert.deepEqual(JSON.parse(store.getItem('jsonImpEnrichPending')).sort(), ['p-a2', 'p-a6', 'p-a7']);
  assert.match(nodes.jsonImpAlert.textContent, /3 ficha\(s\) pendiente\(s\)/);
  const importsBefore = f.log.imports.length;
  failing.clear();
  nodes.jsonImpEnrichRetry.fire('click');
  assert.equal(nodes.jsonImpAiConfirm.hidden, false);
  assert.match(nodes.jsonImpAiConfirmText.textContent, /3 ficha\(s\) pendiente/);
  assert.match(nodes.jsonImpAiConfirmText.textContent, /CONSUME CRÉDITOS/);
  nodes.jsonImpAiConfirmGo.fire('click');
  await wait(250);
  assert.equal(f.log.imports.length, importsBefore, 'el reintento no importa nada');
  assert.deepEqual([...f.log.enrich.at(-1).ids].sort(), ['p-a2', 'p-a6', 'p-a7']);
  assert.match(nodes.jsonImpEnrichRetry.textContent, /\(1\)/, 'p-a2 sigue con plantilla local: queda pendiente');
});

test('el botón antiguo de Amazon y la casilla «Guardar en el catálogo» ya no existen en el panel', () => {
  assert.ok(!/id="jsonImpAmazonIa"|id="jsonImpSave"|id="jsonImpRun"/.test(source));
  assert.ok(!/Importar registros válidos|Importar producto Amazon con ficha IA/.test(source));
});

/* ───────────── Moneda no EUR y «todo en revisión»: nunca un mensaje verde de éxito ───────────── */

const usd = (n) => ({ ...temuRec(n), currency: 'USD' });
/** Servidor que deja en revisión todo registro cuya moneda no sea EUR (como el motor real). */
function reviewingServer() {
  const f = fakeServer({ extra: (u, init) => {
    if (!u.endsWith('/api/admin/json-import')) return null;
    const body = JSON.parse(init.body);
    f.log.imports.push(body);
    return resp({ success: true, results: body.records.map((r, i) => (r.currency === 'EUR'
      ? { index: body.indexOffset + i, outcome: 'created', productId: 'p-' + r.externalId, title: r.title, reasons: [], warnings: [], entities: { productsCreated: 1, offersCreated: 1, offersUpdated: 0 } }
      : { index: body.indexOffset + i, outcome: 'review', title: r.title, reasons: ['moneda_no_euro:' + r.currency], warnings: [], entities: { productsCreated: 0, offersCreated: 0, offersUpdated: 0 } })) });
  } });
  return f;
}

test('la moneda de lo cargado se muestra ANTES de importar y avisa si no es EUR', async () => {
  const { nodes } = makeClient(reviewingServer().fn);
  paste(nodes, [usd(1), usd(2)]);
  await wait(320);
  assert.ok(nodes.jsonImpSumCurrency.textContent.includes('USD (2)'));
  assert.match(nodes.jsonImpSumCurrency.textContent, /NO es EUR/);
  assert.match(nodes.jsonImpSumCurrency.textContent, /no se convierte/);
  paste(nodes, [temuRec(1), temuRec(2)]);
  await wait(320);
  assert.equal(nodes.jsonImpSumCurrency.textContent, 'EUR (2)');
});

test('todo en revisión (p. ej. 10 en USD): mensaje ROJO claro, sin «éxito», en simulación y en importación real', async () => {
  const f = reviewingServer();
  const { nodes } = makeClient(f.fn);
  paste(nodes, [1, 2, 3].map(usd));
  nodes.jsonImpSimulate.fire('click');
  await wait(120);
  assert.match(nodes.jsonImpAlert.className, /is-error/);
  assert.match(nodes.jsonImpAlert.textContent, /NO se importaría ninguna ficha/);
  assert.match(nodes.jsonImpAlert.textContent, /3 de 3/);
  assert.ok(nodes.jsonImpAlert.textContent.includes('Moneda distinta de EUR (USD)'));
  assert.doesNotMatch(nodes.jsonImpAlert.textContent, /Importación terminada|Simulación terminada/);
  nodes.jsonImpImport.fire('click');
  await wait(120);
  assert.match(nodes.jsonImpAlert.className, /is-error/);
  assert.match(nodes.jsonImpAlert.textContent, /NO se ha importado ninguna ficha/);
  assert.match(nodes.jsonImpAlert.textContent, /catálogo no ha cambiado/);
  assert.doesNotMatch(nodes.jsonImpAlert.className, /is-ok/);
});

test('importación parcial (algunas en revisión): aviso ámbar con el detalle, no verde', async () => {
  const { nodes } = makeClient(reviewingServer().fn);
  paste(nodes, [temuRec(1), usd(2)]);
  nodes.jsonImpImport.fire('click');
  await wait(120);
  assert.match(nodes.jsonImpAlert.className, /is-warn/);
  assert.ok(nodes.jsonImpAlert.textContent.includes('1 ficha(s) nueva(s)'));
  assert.ok(nodes.jsonImpAlert.textContent.includes('1 registro(s) NO se han importado'));
});

test('«Importar y enriquecer con IA» con todo en revisión: no importa, no enriquece, no gasta créditos y lo dice en rojo', async () => {
  const f = reviewingServer();
  const { nodes } = makeClient(f.fn);
  paste(nodes, [1, 2].map(usd));
  nodes.jsonImpImportAi.fire('click');
  await wait(120);
  assert.equal(nodes.jsonImpAiConfirm.hidden, true);
  assert.match(nodes.jsonImpAlert.className, /is-error/);
  assert.match(nodes.jsonImpAlert.textContent, /No hay fichas nuevas que enriquecer, no se gasta ningún crédito/);
  assert.match(nodes.jsonImpAlert.textContent, /NO se importaría ninguna ficha/);
  assert.equal(f.log.enrich.length, 0);
  assert.deepEqual(f.log.imports.map((b) => b.dryRun), [true]);
});

/* ───────────── Detección automática: ya existentes, agotados y sin precio (simulación gratuita, sin guardar) ───────────── */

function scrapeServer(record, extra) {
  const f = fakeServer({ extra: (u, init) => (u.startsWith('/api/scrape') ? resp(record) : extra ? extra(u, init) : null) });
  return f;
}
const fetchAsin = async (nodes) => { nodes.jsonImpAsin.value = 'B01EXDG2MO'; nodes.jsonImpFetch.fire('click'); await wait(150); };

test('al cargar un producto/categoría se comprueba SOLO (simulación) cuáles ya existen en el catálogo, sin guardar ni llamar de nuevo al origen', async () => {
  const f = scrapeServer({ ...amz(1, 'existing'), availability: true });
  const { nodes, calls } = makeClient(f.fn);
  await fetchAsin(nodes);
  assert.equal(f.log.imports.length, 1);
  assert.equal(f.log.imports[0].dryRun, true);
  const text = nodes.jsonImpSumStatus.textContent;
  assert.ok(text.includes('0 nuevo(s)'), text);
  assert.ok(text.includes('1 ya existe(n) en el catálogo'), text);
  assert.ok(text.includes('1 con cambios'), text);
  assert.ok(text.includes('no se ha guardado nada'), text);
  assert.equal(calls.filter((c) => String(c[0]).startsWith('/api/scrape')).length, 1, 'una sola llamada al origen');
});

test('los productos agotados / sin stock se detectan antes de importar y se conserva ese estado', async () => {
  const f = scrapeServer({ ...amz(2), availability: false });
  const { nodes } = makeClient(f.fn);
  await fetchAsin(nodes);
  const text = nodes.jsonImpSumStatus.textContent;
  assert.ok(text.includes('1 nuevo(s)'), text);
  assert.ok(text.includes('1 agotado(s)/sin stock (se conserva ese estado)'), text);
});

test('un producto no disponible para comprar (sin precio) se detecta y se avisa de que se rechazará', async () => {
  const f = scrapeServer({ ...amz(3), price: undefined }, (u, init) => {
    if (!u.endsWith('/api/admin/json-import')) return null;
    const body = JSON.parse(init.body);
    f.log.imports.push(body);
    return resp({ success: true, results: body.records.map((r, i) => ({ index: body.indexOffset + i, outcome: 'rejected', title: r.title, reasons: ['precio_invalido'], warnings: [], entities: { productsCreated: 0, offersCreated: 0, offersUpdated: 0 } })) });
  });
  const { nodes } = makeClient(f.fn);
  await fetchAsin(nodes);
  const text = nodes.jsonImpSumStatus.textContent;
  assert.ok(text.includes('1 sin precio (no disponible para comprar: se rechazará)'), text);
});

test('el JSON pegado no dispara comprobaciones por su cuenta: indica cómo ver cuáles existen', async () => {
  const f = fakeServer();
  const { nodes } = makeClient(f.fn);
  paste(nodes, [amz(1), amz(2, 'existing')]);
  await wait(320);
  assert.equal(f.log.imports.length, 0);
  assert.ok(nodes.jsonImpSumStatus.textContent.includes('Pulsa «Simular importación»'));
});

test('«Solo productos nuevos» va marcado por defecto, se envía en simular e importar, y desmarcarlo lo envía como false', async () => {
  const f = fakeServer();
  const { nodes } = makeClient(f.fn);
  paste(nodes, [amz(1)]);
  nodes.jsonImpSimulate.fire('click');
  await wait(100);
  nodes.jsonImpImport.fire('click');
  await wait(100);
  assert.deepEqual(f.log.imports.map((b) => b.onlyNew), [true, true]);
  nodes.jsonImpOnlyNew.checked = false;
  nodes.jsonImpOnlyNew.fire('change');
  nodes.jsonImpImport.fire('click');
  await wait(100);
  assert.equal(f.log.imports.at(-1).onlyNew, false);
});

test('los existentes omitidos se cuentan como OMITIDOS y, si todos existen, el mensaje dice que no se ha incluido ninguno', async () => {
  const omit = fakeServer({ extra: (u, init) => {
    if (!u.endsWith('/api/admin/json-import')) return null;
    const body = JSON.parse(init.body);
    omit.log.imports.push(body);
    return resp({ success: true, results: body.records.map((r, i) => ({ index: body.indexOffset + i, outcome: 'unchanged', productId: 'p-' + r.externalId, title: r.title, reasons: ['ya_existe_omitido'], warnings: [], entities: { productsCreated: 0, offersCreated: 0, offersUpdated: 0 } })) });
  } });
  const { nodes } = makeClient(omit.fn);
  paste(nodes, [amz(1), amz(2)]);
  nodes.jsonImpImport.fire('click');
  await wait(120);
  assert.ok(nodes.jsonImpAlert.textContent.includes('YA EXISTEN en el catálogo y se omiten'), nodes.jsonImpAlert.textContent);
  assert.ok(nodes.jsonImpAlert.textContent.includes('no se ha incluido ni modificado ninguno'));
  assert.ok(!/is-ok/.test(nodes.jsonImpAlert.className));
});

test('la comprobación automática con «solo nuevos» muestra los existentes como OMITIDOS (no se vuelven a incluir)', async () => {
  const omit = fakeServer({ extra: (u, init) => {
    if (u.startsWith('/api/scrape')) return resp({ ...amz(1, 'existing') });
    if (!u.endsWith('/api/admin/json-import')) return null;
    const body = JSON.parse(init.body);
    omit.log.imports.push(body);
    return resp({ success: true, results: body.records.map((r, i) => ({ index: body.indexOffset + i, outcome: 'unchanged', productId: 'p-1', title: r.title, reasons: ['ya_existe_omitido'], warnings: [], entities: { productsCreated: 0, offersCreated: 0, offersUpdated: 0 } })) });
  } });
  const { nodes } = makeClient(omit.fn);
  nodes.jsonImpAsin.value = 'B01EXDG2MO';
  nodes.jsonImpFetch.fire('click');
  await wait(150);
  const text = nodes.jsonImpSumStatus.textContent;
  assert.ok(text.includes('0 nuevo(s)'), text);
  assert.ok(text.includes('1 ya existe(n) en el catálogo → OMITIDOS (no se vuelven a incluir ni se actualizan)'), text);
});

/* ───────────── Producto individual de Temu por URL (reutiliza la extracción) ───────────── */

function extractServer(job, records) {
  const log = { posts: [] };
  const f = fakeServer({
    extra: (u, init) => {
      if (!u.startsWith('/api/admin/category-extract')) return null;
      if (init && init.method === 'POST') { log.posts.push(JSON.parse(init.body)); return resp({ success: true, job: { ...job, status: 'running' } }, 201); }
      if (u.includes('?id=')) return resp({ success: true, job: { ...job, status: 'succeeded', resultReady: true, summary: { fetched: records.length, withReview: 0, actorErrors: 0, partial: false, currencies: { EUR: records.length }, marketMismatch: false } }, records });
      return resp({ success: true, configured: true, defaultLimit: 10, maxLimit: 50, active: null, latest: null });
    },
  });
  return { f, log };
}
const temuJob = { id: '11111111-1111-4111-8111-111111111111', source: 'temu', urlKind: 'product', url: 'https://www.temu.com/es/-g-601101683713758.html', limit: 1, createdAt: '2026-11-07T10:00:00.000Z' };
const temuProductRecord = { product: { title: 'Colchoneta térmica', images: ['https://img.kwcdn.com/a.jpg'] }, variant: {}, offer: { platform: 'temu', externalId: '601101683713758', url: 'https://www.temu.com/es/-g-601101683713758.html', price: 52.06, currency: 'EUR', availability: false }, __import: { warnings: [], review: [], errors: [] } };

test('Temu producto individual: valida la URL en el cliente (otros dominios, categorías, otros mercados) sin tocar el servidor', async () => {
  const { f, log } = extractServer(temuJob, [temuProductRecord]);
  const { nodes } = makeClient(f.fn);
  const cases = [
    ['', 'Pega la URL de un producto de Temu'],
    ['http://www.temu.com/-g-601101683713758.html', 'https://'],
    ['https://www.amazon.es/dp/B01EXDG2MO', 'Solo se admiten URL de Temu'],
    ['https://www.temu.com/es/category-o3-248.html', 'Esa URL no es la de un producto'],
    ['https://www.temu.com/us/-g-601101683713758.html', 'otro mercado de Temu'],
  ];
  for (const [url, expected] of cases) {
    nodes.jsonImpTemuUrl.value = url;
    nodes.jsonImpTemuFetch.fire('click');
    assert.ok(nodes.jsonImpTemuHint.textContent.includes(expected), url + ' → ' + nodes.jsonImpTemuHint.textContent);
  }
  assert.equal(log.posts.length, 0, 'ninguna petición inválida llegó al servidor');
});

test('Temu producto individual: una URL sin mercado se envía como ficha española (límite 1), el estado se ve en su bloque y el resultado alimenta la zona común con comprobación automática', async () => {
  const { f, log } = extractServer(temuJob, [temuProductRecord]);
  const { nodes } = makeClient(f.fn);
  nodes.jsonImpTemuUrl.value = 'https://www.temu.com/heated-mattress-pad-g-601101683713758.html?_x_sessn_id=abc';
  nodes.jsonImpTemuFetch.fire('click');
  await wait(120);
  assert.deepEqual(log.posts, [{ source: 'temu', url: 'https://www.temu.com/es/-g-601101683713758.html', limit: 1 }]);
  assert.equal(nodes.jsonImpSource.value, 'temu');
  assert.ok(nodes.jsonImpTemuHint.textContent.length > 0, 'el estado se refleja en el bloque individual');
  await wait(3500); // consulta de estado (3 s)
  assert.equal(nodes.jsonImpActionZone.hidden, false);
  assert.equal(nodes.jsonImpSumCount.textContent, '1');
  assert.ok(nodes.jsonImpSumSource.textContent.includes('URL de producto de Temu'), nodes.jsonImpSumSource.textContent);
  assert.equal(nodes.jsonImpSumCurrency.textContent, 'EUR (1)');
  assert.equal(f.log.imports.length, 1, 'comprobación automática (simulación) frente al catálogo');
  assert.equal(f.log.imports[0].dryRun, true);
  assert.ok(nodes.jsonImpSumStatus.textContent.includes('1 agotado(s)/sin stock'), nodes.jsonImpSumStatus.textContent);
});

test('Temu enlace corto de afiliado: el bloque lo acepta, lo envía TAL CUAL al servidor (límite 1) y muestra que reconoció el producto y el enlace de afiliado', async () => {
  const shortJob = { ...temuJob, affiliateUrl: 'https://temu.to/k/gk2abc9xyz', affiliateGoodsId: '601101683713758' };
  const rec = { ...temuProductRecord, offer: { ...temuProductRecord.offer, affiliateUrl: 'https://temu.to/k/gk2abc9xyz' } };
  const { f, log } = extractServer(shortJob, [rec]);
  const { nodes } = makeClient(f.fn);
  nodes.jsonImpTemuUrl.value = 'https://temu.to/k/gk2abc9xyz';
  nodes.jsonImpTemuFetch.fire('click');
  await wait(150);
  assert.deepEqual(log.posts, [{ source: 'temu', url: 'https://temu.to/k/gk2abc9xyz', limit: 1 }], 'el servidor resuelve el enlace: el cliente no toca la URL');
  assert.ok(nodes.jsonImpTemuHint.textContent.includes('Enlace de afiliado reconocido (temu.to/k/gk2abc9xyz) → producto 601101683713758'), nodes.jsonImpTemuHint.textContent);
  assert.ok(nodes.jsonImpTemuHint.textContent.includes('separado del enlace de origen'));
  await wait(3500);
  assert.ok(nodes.jsonImpSumSource.textContent.includes('enlace corto de afiliado de Temu'), nodes.jsonImpSumSource.textContent);
  assert.equal(nodes.jsonImpSumCount.textContent, '1');
  assert.ok(nodes.jsonImpAlert.textContent.includes('Enlace de afiliado reconocido: se guardará como enlace de afiliado'), nodes.jsonImpAlert.textContent);
});

test('Temu: un enlace corto de otro dominio parecido o con credenciales se rechaza en el cliente sin llamar al servidor', async () => {
  const { f, log } = extractServer(temuJob, [temuProductRecord]);
  const { nodes } = makeClient(f.fn);
  for (const url of ['https://temu.to.evil.example/k/abc', 'https://evil.example/temu.to/k/abc', 'http://temu.to/k/abc']) {
    nodes.jsonImpTemuUrl.value = url;
    nodes.jsonImpTemuFetch.fire('click');
    assert.ok(/Solo se admiten URL de Temu|https:\/\//.test(nodes.jsonImpTemuHint.textContent), url + ' → ' + nodes.jsonImpTemuHint.textContent);
  }
  assert.equal(log.posts.length, 0);
});
