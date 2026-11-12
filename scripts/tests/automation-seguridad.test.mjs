// Treidilor AI · Fase 2.0: comprobador de seguridad de workflows, normalización, sincronía del constructor, datos de prueba saneados,
// Docker Compose del n8n de pruebas e higiene del repositorio. Sin red, sin Docker, sin n8n.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const leer = (p) => fs.readFileSync(path.join(RAIZ, p), 'utf8').replace(/\r\n/g, '\n');
const J = (p) => JSON.parse(leer(p));
const { comprobarWorkflow, TIPOS_PERMITIDOS } = await import('../automation/lint-workflows.mjs');
const { normalizarWorkflow, serializar, idNodo, ID_CREDENCIAL } = await import('../automation/normalize-workflow.mjs');
const { construirTodo, fuenteModulo } = await import('../automation/build-workflows.mjs');
const { generarDatosPrueba, LISTA_BLANCA } = await import('../automation/make-test-data.mjs');
const { validarEsquema } = await import('../automation/validate-schema.mjs');

const FICHEROS = fs.readdirSync(path.join(RAIZ, 'automation/workflows')).filter((f) => f.endsWith('.json')).sort();
const clon = (f) => JSON.parse(JSON.stringify(J(`automation/workflows/${f}`)));
const nodo = (wf, nombre) => wf.nodes.find((n) => n.name === nombre);
const hay = (r, re) => r.errores.some((e) => re.test(e));

test('los workflows del repositorio pasan el comprobador y están normalizados y sincronizados con automation/lib', () => {
  assert.deepEqual(FICHEROS, ['auditor-general.local.json', 'auditor-general.produccion.json', 'investigador-comercial.local.json']);
  const esperado = construirTodo();
  for (const f of FICHEROS) {
    const texto = leer(`automation/workflows/${f}`);
    const wf = JSON.parse(texto);
    const r = comprobarWorkflow(wf, { nombreArchivo: f });
    assert.deepEqual(r.errores, [], `${f}: ${r.errores.join(' | ')}`);
    assert.deepEqual(r.avisos, [], `${f}: avisos ${r.avisos.join(' | ')}`);
    assert.equal(texto, serializar(normalizarWorkflow(wf)), `${f} no está normalizado`);
    assert.equal(texto, esperado[f], `${f} está desincronizado con automation/lib (ejecuta: node scripts/automation/build-workflows.mjs --write)`);
    assert.equal(wf.active, false);
    assert.ok(!('pinData' in wf));
    for (const n of wf.nodes) assert.ok(TIPOS_PERMITIDOS.has(n.type), `${f}: ${n.type}`);
  }
});

test('comprobador: rechaza escritura, comandos, red directa, secretos, URLs libres y límites ausentes', () => {
  const base = 'auditor-general.local.json';
  const casos = [
    ['método distinto de GET', (w) => { nodo(w, 'Pedir rutas').parameters.method = 'POST'; }, /sólo se permiten peticiones GET/],
    ['método DELETE', (w) => { nodo(w, 'Pedir rutas').parameters.method = 'DELETE'; }, /sólo se permiten peticiones GET/],
    ['cuerpo en la petición', (w) => { nodo(w, 'Pedir rutas').parameters.sendBody = true; }, /no se permite enviar cuerpo/],
    ['URL fija en un nodo HTTP', (w) => { nodo(w, 'Pedir rutas').parameters.url = 'https://treidilor.com/api/v1/products/delete-all'; }, /URL debe ser exactamente/],
    ['URL con expresión distinta', (w) => { nodo(w, 'Pedir rutas').parameters.url = '={{ $json.destino }}'; }, /URL debe ser exactamente/],
    ['sin timeout', (w) => { delete nodo(w, 'Pedir rutas').parameters.options.timeout; }, /timeout obligatorio/],
    ['timeout excesivo', (w) => { nodo(w, 'Pedir rutas').parameters.options.timeout = 120000; }, /timeout obligatorio/],
    ['sin límite de ritmo', (w) => { delete nodo(w, 'Pedir rutas').parameters.options.batching; }, /límite de ritmo/],
    ['ritmo demasiado alto', (w) => { nodo(w, 'Pedir rutas').parameters.options.batching.batch.batchSize = 50; }, /límite de ritmo/],
    ['sigue redirecciones', (w) => { nodo(w, 'Pedir rutas').parameters.options.redirect.redirect.followRedirects = true; }, /followRedirects/],
    ['reintentos excesivos', (w) => { const n = nodo(w, 'Pedir rutas'); n.retryOnFail = true; n.maxTries = 50; }, /maxTries/],
    ['workflow activo', (w) => { w.active = true; }, /«active» debe ser false/],
    ['datos fijados (pinData)', (w) => { w.pinData = { x: [] }; }, /pinData/],
    ['sin tiempo máximo', (w) => { delete w.settings.executionTimeout; }, /executionTimeout/],
    ['tiempo máximo excesivo', (w) => { w.settings.executionTimeout = 99999; }, /executionTimeout/],
    ['nodo Execute Command', (w) => { w.nodes.push({ name: 'Cmd', type: 'n8n-nodes-base.executeCommand', typeVersion: 1, position: [0, 0], parameters: { command: 'ls' } }); }, /tipo no permitido/],
    ['nodo Webhook (entrada pública)', (w) => { w.nodes.push({ name: 'Hook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: {} }); }, /tipo no permitido/],
    ['nodo de correo', (w) => { w.nodes.push({ name: 'Mail', type: 'n8n-nodes-base.emailSend', typeVersion: 1, position: [0, 0], parameters: {} }); }, /tipo no permitido/],
    ['programación activa', (w) => { w.nodes.push({ name: 'Cron', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1, position: [0, 0], parameters: {} }); }, /desactivada/],
    ['credencial con otro tipo', (w) => { nodo(w, 'Pedir catálogo').credentials = { httpBasicAuth: { id: 'x', name: 'Treidilor (solo lectura)' } }; }, /tipo de credencial no permitido/],
    ['credencial sin «solo lectura»', (w) => { nodo(w, 'Pedir catálogo').credentials = { httpHeaderAuth: { id: 'x', name: 'Token general' } }; }, /solo lectura/],
    ['HTTP alimentado por un nodo que no es Code', (w) => { w.connections['Ejecutar a mano'].main[0][0].node = 'Pedir rutas'; }, /sólo puede recibir datos de nodos Code/],
    ['conexión a un nodo inexistente', (w) => { w.connections['Objetivos'].main[0][0].node = 'Fantasma'; }, /inexistente/],
    ['ciclo', (w) => { w.connections.Informe = { main: [[{ node: 'Objetivos', type: 'main', index: 0 }]] }; }, /ciclo/],
    ['nombre de nodo repetido', (w) => { w.nodes.push({ ...nodo(w, 'Objetivos') }); }, /repetido/],
    ['demasiados nodos', (w) => { for (let i = 0; i < 40; i++) w.nodes.push({ name: `n${i}`, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0], parameters: {} }); }, /Demasiados nodos/],
    ['sin política de URLs en el código', (w) => { for (const n of w.nodes) if (n.type === 'n8n-nodes-base.code') n.parameters.jsCode = 'return [{ json: { url: "https://treidilor.com/" } }];'; }, /política de URLs/],
  ];
  for (const [nombre, mut, re] of casos) {
    const w = clon(base);
    mut(w);
    const r = comprobarWorkflow(w, { nombreArchivo: base });
    assert.ok(hay(r, re), `«${nombre}» debe rechazarse con ${re}; errores: ${r.errores.join(' | ')}`);
  }
});

test('comprobador: código peligroso en nodos Code', () => {
  const peligros = ['require("fs")', 'process.env.X', 'eval("1")', 'new Function("return 1")()', '$env.HOLA', 'fetch("https://x")', 'const x = import("fs")', 'child_process.exec("ls")', 'globalThis.x = 1', 'setTimeout(() => 1, 1)', 'while (true) {}', 'x.constructor.constructor("return 1")', 'new WebSocket("wss://x")', '$execution.id', 'this.helpers.httpRequest({})', 'a.__proto__.b = 1'];
  for (const codigo of peligros) {
    const w = clon('auditor-general.produccion.json');
    nodo(w, 'Informe').parameters.jsCode += `\n${codigo};`;
    const r = comprobarWorkflow(w, { nombreArchivo: 'auditor-general.produccion.json' });
    assert.ok(hay(r, /código con/), `código no rechazado: ${codigo}`);
  }
  const w = clon('auditor-general.produccion.json');
  nodo(w, 'Informe').parameters.jsCode = '';
  assert.ok(hay(comprobarWorkflow(w, {}), /código vacío/));
  const gigante = clon('auditor-general.produccion.json');
  nodo(gigante, 'Informe').parameters.jsCode += `\n// ${'x'.repeat(90000)}`;
  assert.ok(hay(comprobarWorkflow(gigante, {}), /demasiado grande/));
});

test('comprobador: secretos (tokens, claves, cabeceras) y credenciales en producción', () => {
  const secretos = [
    ['Bearer abcdefghijklmnopqrstuvwxyz0123456789', /Bearer/],
    ['sk-abcdefghijklmnopqrstuvwxyz1234', /sk-/],
    ['sk-ant-api03-abcdefghijklmnop', /clave/],
    ['AKIAABCDEFGHIJKLMNOP', /AWS/],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc', /JWT/],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', /GitHub/],
    ['TRADYLOR_API_TOKEN', /token general/],
    ['-----BEGIN PRIVATE KEY-----', /clave privada/],
  ];
  for (const [valor, re] of secretos) {
    const w = clon('auditor-general.local.json');
    nodo(w, 'Pedir rutas').parameters.headerParameters.parameters.push({ name: 'X-Prueba', value: valor });
    const r = comprobarWorkflow(w, { nombreArchivo: 'auditor-general.local.json' });
    assert.ok(hay(r, re), `secreto no detectado: ${valor.slice(0, 12)}…`);
  }
  const w = clon('auditor-general.local.json');
  nodo(w, 'Pedir rutas').parameters.authorization = 'valorSecretoLargo123';
  assert.ok(hay(comprobarWorkflow(w, {}), /Valor sensible/));
  // producción: ninguna credencial
  const p = clon('auditor-general.local.json');
  p.name = 'Treidilor AI · Auditor General v0 (produccion)';
  assert.ok(hay(comprobarWorkflow(p, { nombreArchivo: 'auditor-general.produccion.json' }), /producción no pueden referenciar credenciales/));
  // sólo lectura de entrada
  assert.deepEqual(comprobarWorkflow({ nodes: [] }, {}).errores.length > 0, true);
  assert.ok(comprobarWorkflow(null, {}).errores.length > 0);
});

test('normalización: quita lo volátil, ordena, fija ids de nodo y referencia las credenciales por nombre; es idempotente', () => {
  const origen = clon('auditor-general.local.json');
  origen.id = 'abc123';
  origen.versionId = 'v-1';
  origen.updatedAt = '2026-11-12T10:00:00Z';
  origen.pinData = { a: [] };
  origen.active = true;
  origen.meta = { instanceId: 'secreto-de-instancia' };
  origen.tags = [{ id: '9', name: 'zeta' }, { id: '8', name: 'alfa' }];
  nodo(origen, 'Pedir catálogo').id = 'otro-id';
  nodo(origen, 'Pedir catálogo').webhookId = 'wh';
  nodo(origen, 'Pedir catálogo').credentials.httpHeaderAuth.id = 'ID-REAL-DE-LA-INSTANCIA';
  const n = normalizarWorkflow(origen);
  for (const k of ['id', 'versionId', 'updatedAt', 'pinData', 'meta']) assert.ok(!(k in n), k);
  assert.equal(n.active, false);
  assert.deepEqual(n.tags, ['alfa', 'zeta']);
  const c = n.nodes.find((x) => x.name === 'Pedir catálogo');
  assert.equal(c.credentials.httpHeaderAuth.id, ID_CREDENCIAL);
  assert.equal(c.id, idNodo(origen.name, 'Pedir catálogo'));
  assert.ok(!('webhookId' in c));
  assert.equal(JSON.stringify(normalizarWorkflow(n)), JSON.stringify(n), 'idempotente');
  assert.notEqual(idNodo('a', 'x'), idNodo('a', 'y'));
  assert.match(idNodo('a', 'x'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(Object.keys(n)[0], Object.keys(n).slice().sort()[0], 'claves ordenadas');
});

test('constructor: el código de los nodos es el de automation/lib sin imports ni exports', () => {
  for (const mod of ['common', 'urlPolicy', 'auditor', 'researcher']) {
    const f = fuenteModulo(mod);
    assert.doesNotMatch(f, /^\s*import\s/m, mod);
    assert.doesNotMatch(f, /^\s*export\s/m, mod);
  }
  const aud = J('automation/workflows/auditor-general.produccion.json');
  const js = nodo(aud, 'Informe').parameters.jsCode;
  assert.match(js, /function evaluarUrl\(/);
  assert.match(js, /construirInformeAuditor\(/);
  assert.doesNotMatch(js, /researcher|buscarCandidatos/, 'el auditor no lleva el código del investigador');
  const inv = J('automation/workflows/investigador-comercial.local.json');
  assert.match(nodo(inv, 'Informe').parameters.jsCode, /construirInformeInvestigador\(/);
});

test('esquemas: el validador acepta un informe correcto y rechaza campos de más, de menos o con valores inválidos', () => {
  const esquema = J('automation/schemas/informe-auditor.schema.json');
  const bueno = { agente: 'auditor-general', version: '0.1.0', entorno: 'local', modo: 'completo', generadoEn: '2026-11-12T10:00:00.000Z', soloLectura: true, resumen: { estado: 'ok', incidencias: { critica: 0, alta: 0, media: 0, baja: 0, info: 0 }, peticiones: 1, rutasRevisadas: 1, enlacesRevisados: 0, fichasRevisadas: 0, paginasCatalogo: 0, avisosEntorno: 0 }, incidencias: [], avisosEntorno: [], cobertura: { revisado: [], noRevisado: [] }, markdown: '# x' };
  assert.deepEqual(validarEsquema(bueno, esquema), []);
  assert.ok(validarEsquema({ ...bueno, soloLectura: false }, esquema).length);
  assert.ok(validarEsquema({ ...bueno, extra: 1 }, esquema).length);
  assert.ok(validarEsquema({ ...bueno, version: 'x' }, esquema).length);
  const { markdown, ...sin } = bueno;
  assert.ok(validarEsquema(sin, esquema).some((e) => /markdown/.test(e)));
  assert.ok(validarEsquema({ ...bueno, incidencias: [{ id: 'a', gravedad: 'enorme', area: 'x', titulo: 't', detalle: '', evidencia: {}, accionSugerida: '', clase: 'calidad_datos', ambito: 'datos' }] }, esquema).length);
  assert.ok(validarEsquema({ ...bueno, incidencias: [{ id: 'a', gravedad: 'baja', area: 'catalogo', titulo: 't', detalle: '', evidencia: {}, accionSugerida: '', clase: 'inventada', ambito: 'datos' }] }, esquema).length, 'clase fuera del catálogo');
});

/* ───────── datos de prueba saneados ───────── */
function carpetaOrigen() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-origen-'));
  const w = (n, c) => fs.writeFileSync(path.join(d, n), typeof c === 'string' ? c : JSON.stringify(c));
  w('products.json', [{ id: 'p1', title: 'x', price: 1 }]);
  w('categories.json', []);
  w('sections.json', []);
  w('deleted-product-ids.json', []);
  for (const prohibido of ['users.json', 'radar-users.json', 'radar-data.json', 'credentials.json', 'ai-keys.json', 'analytics.json', 'price-alert-center.json', 'home-layout.json', 'home-stories.json', 'home-layout-draft-backups.json', 'nav-top-sections.json', 'aliexpress-catalog.json']) w(prohibido, { secreto: 'NO-DEBE-COPIARSE' });
  fs.mkdirSync(path.join(d, 'backups'));
  fs.mkdirSync(path.join(d, 'images'));
  w('.env', 'ADMIN_PASSWORD=NO-DEBE-COPIARSE');
  return d;
}

test('datos de prueba: sólo la lista blanca, nunca usuarios, Mi Radar, credenciales, claves, analítica, portada ni copias', () => {
  const origen = carpetaOrigen();
  const salida = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tai-salida-')), 'datos');
  const r = generarDatosPrueba({ desde: origen, salida });
  assert.deepEqual(r.copiados.sort(), [...LISTA_BLANCA].sort());
  const presentes = fs.readdirSync(salida).sort();
  assert.deepEqual(presentes, [...LISTA_BLANCA, '.token-pruebas'].sort());
  for (const f of presentes) if (f !== '.token-pruebas') assert.doesNotMatch(fs.readFileSync(path.join(salida, f), 'utf8'), /NO-DEBE-COPIARSE/);
  const token = fs.readFileSync(path.join(salida, '.token-pruebas'), 'utf8').trim();
  assert.match(token, /^[0-9a-f]{48}$/, 'token desechable aleatorio');
  assert.ok(!JSON.stringify(r).includes(token), 'el token no se devuelve ni se muestra');
  // no se puede reutilizar una carpeta con contenido ni anidar origen y salida
  assert.throws(() => generarDatosPrueba({ desde: origen, salida }), /vacía o no existir/);
  assert.throws(() => generarDatosPrueba({ desde: origen, salida: path.join(origen, 'dentro') }), /dentro de la carpeta de origen/);
  assert.throws(() => generarDatosPrueba({ desde: origen, salida: origen }), /dentro de la carpeta de origen/);
  assert.throws(() => generarDatosPrueba({ desde: path.join(origen, 'no-existe'), salida: path.join(os.tmpdir(), `x-${Date.now()}`) }), /no existe/);
  // JSON dañado o sin catálogo
  const dañado = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-malo-'));
  fs.writeFileSync(path.join(dañado, 'products.json'), '{ no es json');
  assert.throws(() => generarDatosPrueba({ desde: dañado, salida: path.join(os.tmpdir(), `y-${Date.now()}`) }));
  const sinProductos = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-vacio-'));
  fs.writeFileSync(path.join(sinProductos, 'users.json'), '[]');
  const sal2 = path.join(os.tmpdir(), `z-${Date.now()}`);
  assert.throws(() => generarDatosPrueba({ desde: sinProductos, salida: sal2 }), /products\.json/);
  assert.equal(fs.existsSync(sal2), false, 'no deja carpetas a medias');
  // el origen no se modifica
  assert.equal(fs.readFileSync(path.join(origen, 'users.json'), 'utf8'), JSON.stringify({ secreto: 'NO-DEBE-COPIARSE' }));
});

/* ───────── Docker Compose del n8n de pruebas (no se arranca) ───────── */
test('Docker Compose de pruebas: sólo 127.0.0.1, versión fijada, sin secretos, sin telemetría ni nodos peligrosos', () => {
  const y = leer('automation/dev/docker-compose.n8n.yml');
  const sinComentarios = y.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.match(sinComentarios, /- "127\.0\.0\.1:5678:5678"/);
  assert.doesNotMatch(sinComentarios, /["' ]0\.0\.0\.0:|- "?5678:5678/, 'nunca publicado en todas las interfaces');
  assert.match(sinComentarios, /image: n8nio\/n8n:\$\{N8N_VERSION:\?/, 'versión obligatoria y fijada por variable');
  assert.doesNotMatch(sinComentarios, /:latest|n8n:next/);
  assert.match(sinComentarios, /N8N_ENCRYPTION_KEY: \$\{N8N_ENCRYPTION_KEY:\?/, 'clave de cifrado por variable obligatoria (no incrustada)');
  for (const k of ['N8N_DIAGNOSTICS_ENABLED: "false"', 'N8N_VERSION_NOTIFICATIONS_ENABLED: "false"', 'N8N_COMMUNITY_PACKAGES_ENABLED: "false"', 'N8N_BLOCK_ENV_ACCESS_IN_NODE: "true"', 'restart: "no"', 'no-new-privileges:true', 'mem_limit: 1g']) assert.ok(sinComentarios.includes(k), k);
  assert.match(sinComentarios, /NODES_EXCLUDE:.*executeCommand/);
  assert.doesNotMatch(sinComentarios, /(password|secret|api[_-]?key|token)\s*:\s*[^$\s"'][^\s]{7,}/i, 'sin secretos incrustados');
  assert.doesNotMatch(sinComentarios, /\/var\/run\/docker\.sock|privileged:|network_mode:\s*host|pid:\s*host/, 'sin acceso al motor de Docker ni a la red del anfitrión');
  // Montajes del anfitrión: SOLO el script de la pasarela, en sólo lectura (nada más).
  const montajes = sinComentarios.split('\n').filter((l) => /^\s*-\s*(\.{1,2}\/|\/|[A-Za-z]:)[^\n]*:/.test(l)).map((l) => l.trim());
  assert.deepEqual(montajes, ['- ./puente-tcp.mjs:/app/puente-tcp.mjs:ro'], 'no monta carpetas del anfitrión (sólo el script de la pasarela, en sólo lectura)');
  // Aislamiento por RED (no por advertencias): n8n sólo en la red interna, sin puertos; una sola entrada y una sola salida fijas.
  assert.match(sinComentarios, /aislada:\s*\n\s*internal: true/, 'la red de n8n es internal (sin Internet)');
  const bloque = (nombre) => (sinComentarios.match(new RegExp(`^  ${nombre}:\\n([\\s\\S]*?)(?=^  [a-z-]+:\\n|^[a-z]+:|$(?![\\s\\S]))`, 'm')) ?? [])[1] ?? '';
  const n8n = bloque('n8n');
  assert.match(n8n, /networks: \[aislada\]/, 'n8n sólo está en la red aislada');
  assert.doesNotMatch(n8n, /^\s*ports:/m, 'n8n no publica puertos');
  assert.match(bloque('puente-entrada'), /PUENTE_DESTINO_HOST: n8n/);
  assert.match(bloque('puente-entrada'), /- "127\.0\.0\.1:5678:5678"/);
  const salida = bloque('puente-treidilor');
  assert.match(salida, /PUENTE_DESTINO_HOST: host\.docker\.internal/);
  assert.match(salida, /PUENTE_DESTINO_PUERTO: "4350"/);
  assert.doesNotMatch(salida, /^\s*ports:/m, 'la pasarela de salida no publica puertos');
  assert.equal((sinComentarios.match(/^\s*ports:/gm) ?? []).length, 1, 'sólo la pasarela de entrada publica un puerto');
  const ejemplo = leer('automation/dev/.env.n8n.example');
  assert.match(ejemplo, /^N8N_VERSION=$/m);
  assert.match(ejemplo, /^N8N_ENCRYPTION_KEY=$/m, 'el ejemplo no trae valores');
});

/* ───────── higiene del repositorio ───────── */
test('higiene: nada de secretos en automation/, salidas locales ignoradas por git y por Docker', () => {
  const ignorados = leer('.gitignore');
  for (const r of ['automation/reports/', 'automation/dev/.env.n8n', 'automation/exports/']) assert.ok(ignorados.includes(r), r);
  assert.match(leer('.dockerignore'), /^automation\/$/m, 'la automatización no entra en la imagen de producción');
  const recorrer = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? recorrer(path.join(d, e.name)) : [path.join(d, e.name)]));
  const patrones = [/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./];
  for (const f of recorrer(path.join(RAIZ, 'automation'))) {
    const t = fs.readFileSync(f, 'utf8');
    for (const re of patrones) assert.doesNotMatch(t, re, `${path.relative(RAIZ, f)} parece contener un secreto`);
  }
  // los agentes no mencionan el token general como credencial a usar
  for (const f of recorrer(path.join(RAIZ, 'automation/lib'))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /TRADYLOR_API_TOKEN/);
  // ningún código de automatización escribe en Treidilor
  for (const f of recorrer(path.join(RAIZ, 'automation/lib'))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\b(POST|PUT|PATCH|DELETE)\b|delete-all|build-catalog|\/import\b/, path.relative(RAIZ, f));
  // no se tocó producción: la configuración de producción es pública y sin credenciales
  assert.equal(J('automation/config/produccion.json').credencialCatalogo, '');
});

/* ───────── AISLAMIENTO: los workflows locales no pueden apuntar a producción ───────── */
test('aislamiento: un workflow local con la configuración de producción (o que mencione treidilor.com) es rechazado por el comprobador', () => {
  const prod = JSON.parse(leer('automation/config/produccion.json'));
  const local = JSON.parse(leer('automation/config/local.json'));
  for (const f of ['auditor-general.local.json', 'investigador-comercial.local.json']) {
    for (const [nombre, cambio] of [
      ['config de producción', (js) => js.replace(/const CONFIG = \{[\s\S]*?\n\};/, `const CONFIG = ${JSON.stringify(prod, null, 2)};`)],
      ['baseUrl a treidilor.com', (js) => js.split(local.baseUrl).join('https://treidilor.com')],
      ['sin guardia', (js) => js.replace('validarAislamiento(CONFIG)', 'true')],
    ]) {
      const w = clon(f);
      for (const n of w.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) n.parameters.jsCode = cambio(n.parameters.jsCode);
      const r = comprobarWorkflow(w, { nombreArchivo: f });
      assert.ok(r.errores.length > 0, `${f}: «${nombre}» debe rechazarse`);
    }
  }
  // y al revés: producción con host local
  const w = clon('auditor-general.produccion.json');
  for (const n of w.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) n.parameters.jsCode = n.parameters.jsCode.split('"https://treidilor.com"').join(`"${local.baseUrl}"`).replace('"treidilor.com"', `"${local.hostsPermitidos[0]}"`);
  assert.ok(comprobarWorkflow(w, { nombreArchivo: 'auditor-general.produccion.json' }).errores.length > 0, 'producción con host local debe rechazarse');
});

test('aislamiento: la política rechaza en tiempo de ejecución cualquier host no local en el entorno local (enlaces, redirecciones, datos)', async () => {
  const politica = await import('../../automation/lib/urlPolicy.mjs');
  const local = JSON.parse(leer('automation/config/local.json'));
  assert.deepEqual(politica.validarAislamiento(local), []);
  for (const mala of [
    { ...local, baseUrl: 'https://treidilor.com' },
    { ...local, hostsPermitidos: [...local.hostsPermitidos, 'treidilor.com'] },
    { ...local, hostsPermitidos: ['www.treidilor.com'] },
    { ...local, entorno: 'otro' },
  ]) assert.ok(politica.validarAislamiento(mala).length > 0);
  for (const url of ['https://treidilor.com/', 'https://www.treidilor.com/catalogo', 'http://treidilor.com/api/health', `${local.baseUrl}/redirect?to=https://treidilor.com`.replace('/redirect?to=', '@'), '//treidilor.com/', 'https://1.1.1.1/', 'http://localhost:5678/rest/login', 'http://127.0.0.1:5678/']) {
    for (const tipo of ['salud', 'ruta', 'enlace', 'catalogo']) {
      const r = politica.evaluarUrl(url, tipo, { ...local, hostsPermitidos: ['treidilor.com', 'www.treidilor.com', ...local.hostsPermitidos] });
      assert.equal(r.ok, false, `${url} (${tipo}) debe rechazarse en el entorno local aunque el host figure como permitido`);
    }
  }
  const prod = JSON.parse(leer('automation/config/produccion.json'));
  assert.deepEqual(politica.validarAislamiento(prod), []);
  assert.ok(politica.validarAislamiento({ ...prod, baseUrl: local.baseUrl, hostsPermitidos: local.hostsPermitidos }).length > 0);
});
