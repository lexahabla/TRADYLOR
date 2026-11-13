// Sitio de pruebas del Auditor completo y compose de validación: comportamiento, escenarios, registro y AISLAMIENTO. Sin Docker ni n8n (sólo sockets de loopback en el test del servidor).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = 'automation/dev/prueba-data-tables';
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const sitio = await import('../../automation/dev/prueba-data-tables/sitio-prueba.mjs');
const politica = await import('../../automation/lib/urlPolicy.mjs');
const UA = 'TreidilorAI-auditor-general/0.2 (solo lectura)';
const TOKEN = ['tai', '0'.repeat(16), 'F'.repeat(43)].join('_');
const pedir = (estado, url, cab = {}, metodo = 'GET') => sitio.procesar({ metodo, url, cabeceras: { 'user-agent': UA, 'x-treidilor-agente': 'auditor-general', ...cab } }, estado);

/* ───────────────────────── Comportamiento ───────────────────────── */
test('rutas: las cinco fijas, /api/health y las páginas de guías/marcas; lo demás es 404; páginas con contenido suficiente y un h1', () => {
  const e = sitio.crearEstado('arreglado');
  for (const ruta of ['/', '/catalogo', '/categorias', '/metodologia', '/alertas-precio', '/guias/01', '/marca/a']) {
    const r = pedir(e, ruta);
    assert.equal(r.estado, 200, ruta);
    assert.match(r.cuerpo, /<title>Treidilor \(sitio de pruebas\)<\/title>/);
    assert.equal((r.cuerpo.match(/<h1>/g) ?? []).length, 1);
    assert.ok(r.cuerpo.length > 2000, 'contenido suficiente (no «contenido mínimo»)');
  }
  assert.equal(pedir(e, '/no-existe').estado, 404);
  assert.equal(pedir(e, '/guias/../admin').estado, 404);
  const salud = JSON.parse(pedir(e, '/api/health').cuerpo);
  assert.deepEqual([salud.status, salud.dataDirExists, salud.env.smtp], ['ok', true, true]);
  assert.equal(salud.sourceHash.length, 64);
});

test('la portada enlaza las páginas del escenario Y las trampas (rutas con efectos, hosts ajenos, esquemas peligrosos)', () => {
  const home = pedir(sitio.crearEstado('base'), '/').cuerpo;
  for (const h of ['/guias/01', '/guias/02', '/guias/03', '/marca/a', '/marca/b', ...sitio.TRAMPAS]) assert.ok(home.includes(`href="${h}"`), h);
  // las trampas son exactamente lo que la política del Auditor rechaza
  const cfg = JSON.parse(leer('automation/config/local.json'));
  for (const trampa of sitio.TRAMPAS) {
    const u = politica.normalizarUrl(trampa, `${cfg.baseUrl}/`);
    assert.ok(!u || !politica.evaluarUrl(u.toString(), 'enlace', cfg).ok, `la política debe rechazar ${trampa}`);
  }
});

test('catálogo: exige un token con la forma del ficticio, pagina (limit ≤ 100) y devuelve el sobre del feed de automatización', () => {
  const e = sitio.crearEstado('arreglado');
  assert.equal(pedir(e, '/api/automation/v1/catalog?limit=100&page=1').estado, 401);
  assert.equal(pedir(e, '/api/automation/v1/catalog?limit=100&page=1', { authorization: 'Bearer algo' }).estado, 401);
  assert.equal(pedir(e, '/api/automation/v1/catalog?limit=100&page=1', { authorization: 'Bearer tai_' + 'z'.repeat(16) + '_' + 'F'.repeat(43) }).estado, 401, 'forma de token inválida');
  const r = pedir(e, '/api/automation/v1/catalog?limit=100&page=1', { authorization: `Bearer ${TOKEN}` });
  const j = JSON.parse(r.cuerpo);
  assert.deepEqual([r.estado, j.success, j.total, j.page, j.limit, j.totalPages, j.products.length], [200, true, 12, 1, 100, 1, 12]);
  assert.deepEqual(Object.keys(j.products[0]).sort(), ['addedAt', 'capturedAt', 'category', 'categoryId', 'currency', 'declaredPreviousPrice', 'descriptionLength', 'hasAffiliateLink', 'id', 'image', 'merchant', 'network', 'price', 'rating', 'ratingFlag', 'reviewsCount', 'stock', 'subcategoryId', 'title', 'verifiedAt', 'verifiedDiscount']);
  // paginación real
  const e2 = sitio.crearEstado('arreglado');
  sitio.ESCENARIOS.arreglado.catalogo.productos.push(...sitio.catalogoSano(150).slice(12));
  try {
    const p = (n, lim) => JSON.parse(pedir(e2, `/api/automation/v1/catalog?limit=${lim}&page=${n}`, { authorization: `Bearer ${TOKEN}` }).cuerpo);
    assert.deepEqual([p(1, 100).products.length, p(2, 100).products.length, p(1, 100).totalPages], [100, 50, 2]);
    assert.equal(p(1, 1000).limit, 100, 'tope de 100 por página');
  } finally {
    sitio.ESCENARIOS.arreglado.catalogo.productos.length = 12;
  }
});

test('escenarios: cada uno produce lo que declara (404, 500, sin título, h1 doble, tiempo agotado, conexión cortada, catálogo con problemas, feed roto, 80 enlaces)', () => {
  const e = sitio.crearEstado('base');
  assert.equal(pedir(e, '/guias/01').estado, 404);
  assert.equal(pedir(e, '/guias/02').estado, 500);
  const lenta = pedir(e, '/guias/03');
  assert.ok(lenta.retardoMs > 15000, 'supera el timeout de 15 s del nodo HTTP');
  assert.doesNotMatch(pedir(e, '/metodologia').cuerpo, /<title>/);
  const cat = JSON.parse(pedir(e, '/api/automation/v1/catalog?limit=100&page=1', { authorization: `Bearer ${TOKEN}` }).cuerpo).products;
  assert.equal(cat[2].price, null);
  assert.equal(cat[6].image, null);
  assert.equal(cat[9].title, cat[10].title);
  const m = sitio.crearEstado('mixto');
  assert.equal((pedir(m, '/catalogo').cuerpo.match(/<h1>/g) ?? []).length, 2);
  assert.equal(pedir(m, '/marca/a').estado, 500);
  assert.equal(JSON.parse(pedir(m, '/api/automation/v1/catalog?limit=100&page=1', { authorization: `Bearer ${TOKEN}` }).cuerpo).products[4].declaredPreviousPrice, 400);
  const p = sitio.crearEstado('parcial');
  assert.equal(pedir(p, '/guias/01').destruir, true);
  assert.equal(pedir(p, '/guias/02').destruir, true);
  assert.equal(pedir(p, '/marca/a').destruir, true);
  assert.equal(pedir(p, '/guias/03').estado, 200);
  const c = sitio.crearEstado('caida');
  for (const ruta of ['/', '/api/health', '/api/automation/v1/catalog']) assert.equal(pedir(c, ruta, { authorization: `Bearer ${TOKEN}` }).destruir, true, ruta);
  assert.equal(pedir(sitio.crearEstado('catalogo_roto'), '/api/automation/v1/catalog?limit=100&page=1', { authorization: `Bearer ${TOKEN}` }).estado, 500);
  assert.equal(sitio.ESCENARIOS.muchos_enlaces.enlaces.length, 80);
  assert.throws(() => sitio.crearEstado('inexistente'), /escenario desconocido/);
  assert.deepEqual(Object.keys(sitio.ESCENARIOS), ['base', 'arreglado', 'mixto', 'parcial', 'caida', 'catalogo_roto', 'muchos_enlaces']);
});

test('registro: anota método, ruta, cabeceras de identificación, forma del token (nunca su valor), estado y rutas prohibidas', () => {
  const e = sitio.crearEstado('arreglado');
  pedir(e, '/');
  pedir(e, '/api/automation/v1/catalog?limit=100&page=1', { authorization: `Bearer ${TOKEN}` });
  pedir(e, '/api/automation/v1/catalog?limit=100&page=1', { authorization: 'Bearer secreto-que-no-debe-aparecer' });
  pedir(e, '/api/redirect?id=1');
  pedir(e, '/out/abc');
  pedir(e, '/producto/p1');
  pedir(e, '/api/health');
  pedir(e, '/', {}, 'POST');
  const r = e.registro;
  assert.deepEqual(r.map((x) => x.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(r.map((x) => x.auth), ['ausente', 'ficticia', 'invalida', 'ausente', 'ausente', 'ausente', 'ausente', 'ausente']);
  assert.deepEqual(r.map((x) => x.prohibido), [false, false, false, true, true, true, false, true], 'catálogo y salud están permitidos; redirect, out, producto y cualquier no-GET no');
  assert.equal(r[0].ua, UA);
  assert.equal(r[0].agente, 'auditor-general');
  const texto = JSON.stringify(r);
  assert.ok(!texto.includes(TOKEN) && !texto.includes('secreto-que-no-debe-aparecer'), 'el registro nunca contiene el valor de un token');
  assert.equal(pedir(e, '/', {}, 'DELETE').estado, 405);
  // límite del registro
  const g = sitio.crearEstado('arreglado');
  for (let i = 0; i < sitio.MAX_REGISTRO + 50; i++) pedir(g, '/');
  assert.equal(g.registro.length, sitio.MAX_REGISTRO);
});

test('las rutas prohibidas del sitio son las de la política del Auditor (más las fichas)', () => {
  const de = (res) => res.map((r) => r.source).sort();
  const base = de(politica.RUTAS_PROHIBIDAS);
  for (const s of base) assert.ok(de(sitio.PROHIBIDAS).includes(s), s);
  assert.deepEqual(de(sitio.PROHIBIDAS).filter((s) => !base.includes(s)), ['^\\/producto(\\/|$)']);
});

/* ───────────────────────── Servidor real en loopback (puertos efímeros) ───────────────────────── */
const esperar = (srv) => new Promise((r) => (srv.listening ? r() : srv.once('listening', r)));
const get = (puerto, ruta, { metodo = 'GET', cab = {} } = {}) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port: puerto, path: ruta, method: metodo, headers: cab }, (x) => { let t = ''; x.on('data', (d) => { t += d; }); x.on('end', () => res({ estado: x.statusCode, cuerpo: t })); }); q.on('error', rej); q.end(); });

test('servidor: atiende el sitio, corta la conexión cuando el escenario lo pide y el control cambia de escenario y entrega el registro', async () => {
  const s = sitio.iniciarServidores({ puerto: 0, puertoControl: 0, escenario: 'base', anfitrion: '127.0.0.1' });
  await Promise.all([esperar(s.sitio), esperar(s.control)]);
  const ps = s.sitio.address().port;
  const pc = s.control.address().port;
  try {
    assert.equal((await get(ps, '/guias/01', { cab: { 'user-agent': UA } })).estado, 404);
    assert.equal((await get(ps, '/')).estado, 200);
    assert.equal(JSON.parse((await get(pc, '/estado')).cuerpo).escenario, 'base');
    assert.deepEqual(JSON.parse((await get(pc, '/escenarios')).cuerpo), Object.keys(sitio.ESCENARIOS));
    assert.equal((await get(pc, '/escenario/parcial', { metodo: 'POST' })).estado, 200);
    await assert.rejects(get(ps, '/guias/01'), /socket hang up|ECONNRESET/);
    assert.equal((await get(pc, '/escenario/no_existe', { metodo: 'POST' })).estado, 404);
    const reg = JSON.parse((await get(pc, '/registro')).cuerpo);
    assert.deepEqual(reg.map((x) => [x.escenario, x.ruta, x.estado]), [['base', '/guias/01', 404], ['base', '/', 200], ['parcial', '/guias/01', 'conexion_cortada']]);
    assert.equal((await get(pc, '/reiniciar', { metodo: 'POST' })).estado, 200);
    assert.deepEqual(JSON.parse((await get(pc, '/registro')).cuerpo), []);
    assert.equal((await get(pc, '/otra-cosa')).estado, 404);
  } finally {
    s.cerrar();
  }
});

/* ───────────────────────── Aislamiento ───────────────────────── */
test('AISLAMIENTO del sitio: sólo escucha; no hace ninguna conexión saliente (sin fetch, DNS, net, procesos ni https) y su control es sólo de loopback', () => {
  const fuente = leer(`${DIR}/sitio-prueba.mjs`);
  const codigo = fuente.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual([...codigo.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]).sort(), ['node:http', 'node:path', 'node:url'], 'sólo módulos básicos');
  for (const prohibido of [/\bfetch\s*\(/, /node:https?\b.*\bget\b/, /node:net\b/, /node:dns\b/, /child_process/, /node:tls/, /node:https/, /\bhttps\.(get|request)\b/,/\.connect\s*\(/, /process\.env\.(HOME|USER)/, /require\s*\(/]) assert.doesNotMatch(codigo, prohibido, String(prohibido));
  // las únicas peticiones salientes son del cliente de control y van a una constante de loopback
  assert.deepEqual([...codigo.matchAll(/http\.request\(\{ host: '([^']+)'/g)].map((m) => m[1]), ['127.0.0.1']);
  assert.match(codigo, /control\.listen\(puertoControl, '127\.0\.0\.1'\)/, 'el control escucha sólo en loopback');
  assert.ok(!/control\.listen\(puertoControl,\s*anfitrion/.test(codigo));
  // no hay hosts reales, ni URLs absolutas hacia fuera, ni credenciales reales
  assert.ok(!/treidilor\.com|upayp1b4\.|api\.n8n|docker\.n8n/i.test(codigo.replace(/\/\^\\\/upayp1b4\/i/g, '')), 'sin hosts de producción');
  assert.ok(!/Bearer tai_[0-9a-f]{16}_[A-Za-z0-9_-]{43}['"`]/.test(fuente) && !fuente.includes(TOKEN), 'ningún token en el código');
  assert.ok(!/process\.env\.[A-Z_]*(TOKEN|KEY|PASSWORD|SECRET)/i.test(codigo));
});

const sinComentarios = (t) => t.replace(/^\s*#.*$/gm, '').replace(/\s+#.*$/gm, '');
test('AISLAMIENTO del compose de validación: sin puertos, sin redes nuevas, sin salida; sólo retira httpRequest y añade el sitio con alias en la red aislada', () => {
  const base = sinComentarios(leer(`${DIR}/docker-compose.yml`));
  const v = sinComentarios(leer(`${DIR}/docker-compose.validacion.yml`));
  // la base sigue siendo la que aísla
  assert.match(base, /aislada:\s+name: tai-dt-aislada\s+internal: true/);
  assert.deepEqual([...base.matchAll(/- "([^"]*:\d+:\d+)"/g)].map((m) => m[1]), ['127.0.0.1:5689:5678']);
  // la variante no publica puertos ni toca redes/volúmenes ni ofrece caminos hacia fuera
  for (const prohibido of [/\bports:/, /^networks:/m, /^volumes:/m, /extra_hosts/, /network_mode/, /privileged/, /docker\.sock/, /cap_add/, /host\.docker\.internal/, /\bentrada\b/, /internal:\s*false/, /driver:\s*bridge/, /treidilor-|treidilor_/, /n8n_pruebas_datos|n8n_data\b/, /:latest/]) assert.doesNotMatch(v, prohibido, String(prohibido));
  assert.deepEqual([...v.matchAll(/container_name: (\S+)/g)].map((m) => m[1]), ['tai-dt-sitio']);
  // el sitio: red aislada con el alias de la configuración local, imagen ya descargada, endurecido y sin puertos
  const s = v.slice(v.indexOf('  sitio:'));
  assert.match(s, /image: node:22-bookworm-slim\b/);
  assert.match(s, /networks:\s+aislada:\s+aliases:\s+- puente-treidilor\s/);
  assert.deepEqual([...s.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]).filter((k) => ['aislada', 'entrada', 'salida'].includes(k)), ['aislada'], 'sólo la red aislada');
  for (const requisito of [/read_only: true/, /user: node/, /cap_drop: \[ALL\]/, /no-new-privileges:true/, /mem_limit: 128m/, /cpus: 0\.25/, /com\.treidilor\.prueba: data-tables/, /sitio-prueba\.mjs:\/app\/sitio-prueba\.mjs:ro/]) assert.match(s, requisito, String(requisito));
  // n8n: sólo se retira httpRequest
  const excl = v.match(/NODES_EXCLUDE: '(\[[^']*\])'/);
  assert.deepEqual(JSON.parse(excl[1]).sort(), ['n8n-nodes-base.executeCommand', 'n8n-nodes-base.readWriteFile', 'n8n-nodes-base.ssh']);
  const baseExcl = JSON.parse(base.match(/NODES_EXCLUDE: '(\[[^']*\])'/)[1]);
  assert.deepEqual(baseExcl.filter((x) => !JSON.parse(excl[1]).includes(x)), ['n8n-nodes-base.httpRequest']);
  // la variante sólo toca n8n (entorno) y añade `sitio`
  assert.deepEqual([...v.matchAll(/^  (\w+):\s*$/gm)].map((m) => m[1]).filter((k) => ['n8n', 'sitio', 'db', 'puente-entrada'].includes(k)), ['n8n', 'sitio']);
  assert.deepEqual([...v.slice(0, v.indexOf('  sitio:')).matchAll(/^      (\w+):/gm)].map((m) => m[1]), ['NODES_EXCLUDE'], 'de n8n sólo se cambia NODES_EXCLUDE');
  // sin secretos y sin credenciales reales
  assert.ok(!/PASSWORD|ENCRYPTION_KEY|TOKEN|SECRET/.test(v.replace(/^\s*#.*$/gm, '')));
});
