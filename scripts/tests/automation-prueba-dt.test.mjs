// Prueba aislada de Data Tables (entrega previa a 2c): comprueba, SIN n8n ni Docker, que el generador de workflows, el análisis de resultados y el entorno Compose son correctos.
// Un simulador mínimo de la tabla permite ejercitar el análisis con casos buenos y MALOS (truncado, rechazo por tamaño, orden ignorado…). NO sustituye a la prueba real en n8n 2.38.6.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const prueba = await import('../automation/prueba-data-tables.mjs');
const seg = await import('../../automation/lib/seguimiento.mjs');
const plano = (x) => JSON.parse(JSON.stringify(x));

/* ───────── simulador mínimo de los nodos de la prueba ───────── */
function simular(wf, { limiteCeldaBytes = Infinity, truncarA = null, sinOrden = false, rechazaDuplicados = false, modo = 'test', tablaPrevia = null } = {}) {
  const tabla = tablaPrevia ?? { filas: [], seq: 0, existe: false };
  const runData = {};
  const porNombre = new Map(wf.nodes.map((n) => [n.name, n]));
  let items = [];
  const orden = [];
  let actual = 'Ejecutar a mano';
  while (actual) {
    orden.push(actual);
    const sig = wf.connections[actual]?.main?.[0]?.[0]?.node;
    actual = sig;
  }
  const evaluar = (expr, json) => { const m = String(expr).match(/^=\{\{\s*\$json\.(\w+)\s*\}\}$/); return m ? json[m[1]] : expr; };
  for (const nombre of orden) {
    const n = porNombre.get(nombre);
    const p = n.parameters;
    let salida;
    if (n.type === 'n8n-nodes-base.manualTrigger') salida = [{ json: {} }];
    else if (n.type === 'n8n-nodes-base.code') {
      const ctx = { $execution: { mode: modo, id: '7' }, Date, JSON, Math, Number, String, Array, Object, Intl };
      vm.createContext(ctx);
      salida = plano(vm.runInContext(`(function(){\n${p.jsCode}\n})()`, ctx, { timeout: 5000 }));
    } else if (n.type === prueba.TIPO_NODO) {
      assert.equal(n.typeVersion, prueba.TYPE_VERSION);
      if (p.resource === 'table' && p.operation === 'create') { tabla.existe = true; salida = [{ json: { id: 'tabla-1', name: p.tableName } }]; }
      else if (p.resource === 'table' && p.operation === 'delete') { tabla.existe = false; tabla.filas = []; salida = [{ json: { success: true, deletedTableId: 'tabla-1' } }]; }
      else if (p.operation === 'insert') {
        salida = [];
        for (const it of items) {
          const fila = Object.fromEntries(Object.entries(p.columns.value).map(([k, v]) => [k, evaluar(v, it.json)]));
          if (Buffer.byteLength(String(fila.payload ?? ''), 'utf8') > limiteCeldaBytes) { salida.push({ json: { error: 'value too long for the column' } }); continue; }
          if (rechazaDuplicados && tabla.filas.some((f) => f.idEjecucion === fila.idEjecucion)) { salida.push({ json: { error: 'duplicate key' } }); continue; }
          const guardada = { ...fila, payload: truncarA && typeof fila.payload === 'string' && fila.payload.length > truncarA ? fila.payload.slice(0, truncarA) : fila.payload };
          const completa = { id: ++tabla.seq, ...guardada, createdAt: `2026-11-12T10:00:${String(tabla.seq % 60).padStart(2, '0')}.000Z`, updatedAt: '2026-11-12T10:00:00.000Z' };
          tabla.filas.push(completa);
          salida.push({ json: { ...completa } });
        }
      } else if (p.operation === 'get') {
        assert.ok(!('options' in p), 'el nodo Get no tiene colección options');
        const filtro = p.filters.conditions[0];
        let filas = tabla.filas.filter((f) => !filtro || f[filtro.keyName] === filtro.keyValue);
        const col = p.orderBy && !sinOrden ? p.orderByColumn : 'id';
        const dir = p.orderBy && !sinOrden ? p.orderByDirection : 'ASC';
        filas = [...filas].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : a.id - b.id) * (dir === 'DESC' ? -1 : 1));
        if (!p.returnAll) filas = filas.slice(0, p.limit);
        salida = filas.length ? filas.map((f) => ({ json: { ...f } })) : [{ json: {} }];
      } else throw new Error(`operación no simulada: ${p.operation}`);
    } else if (n.type === 'n8n-nodes-base.stickyNote') continue;
    runData[nombre] = [{ data: { main: [salida] }, executionStatus: 'success' }];
    items = salida;
  }
  return { ejecucion: { data: { resultData: { runData } } }, tabla };
}

const workflows = prueba.generarWorkflows();
const ejecutarTodo = (opc) => {
  const e1 = simular(workflows['1-escribir-y-leer.json'], opc);
  const e3a = simular(workflows['3-origen.json'], { ...opc, modo: 'production', tablaPrevia: e1.tabla });
  const e3b = simular(workflows['3-origen.json'], { ...opc, modo: 'test', tablaPrevia: e1.tabla });
  const e2 = simular(workflows['2-leer.json'], { ...opc, tablaPrevia: e1.tabla });
  return { escribir: e1.ejecucion, origenes: [e3a.ejecucion, e3b.ejecucion], leer: e2.ejecucion, tabla: e1.tabla };
};
const resultado = (r, id) => r.pruebas.find((p) => p.id === id);

/* ───────────────────────── Generador ───────────────────────── */
test('generador: 4 workflows inactivos, sin credenciales, sin HTTP ni comandos, con nodos Data table typeVersion 1.1 y la tabla temporal como única referencia', () => {
  assert.deepEqual(Object.keys(workflows).sort(), ['1-escribir-y-leer.json', '2-leer.json', '3-origen.json', '4-limpiar.json']);
  const textos = Object.values(workflows).map((w) => JSON.stringify(w));
  for (const wf of Object.values(workflows)) {
    assert.equal(wf.active, false);
    assert.deepEqual(wf.tags, []);
    assert.ok(wf.nodes.every((n) => !n.credentials), 'sin credenciales');
    assert.ok(!wf.nodes.some((n) => /httpRequest|executeCommand|ssh|readWriteFile|schedule|webhook|postgres|emailSend/i.test(n.type)), 'sin red, comandos ni disparadores');
    assert.match(wf.name, /^PRUEBA DT \d · /);
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) assert.ok(Buffer.byteLength(n.parameters.jsCode) < 80_000);
    for (const n of wf.nodes.filter((x) => x.type === prueba.TIPO_NODO)) assert.equal(n.typeVersion, 1.1);
  }
  for (const t of textos) {
    assert.ok(!/https?:\/\//.test(t), 'sin URL de ningún tipo');
    assert.ok(!/treidilor\.com|upayp1b4|api\/redirect|Bearer|tai_[0-9a-f]{16}/i.test(t), 'nada de Treidilor ni de tokens');
  }
  // referencia a la tabla: por nombre (temporal) y, en un Get, por id tomado de «Crear tabla»
  const refs = Object.values(workflows).flatMap((w) => w.nodes.filter((n) => n.type === prueba.TIPO_NODO && n.parameters.dataTableId).map((n) => n.parameters.dataTableId));
  assert.ok(refs.every((r) => r.__rl === true && (r.mode === 'id' || r.value === prueba.TABLA)));
  assert.ok(refs.some((r) => r.mode === 'id'));
  // los Insert no reintentan y siguen ante un error (para ver qué rechaza la tabla); los Get devuelven un elemento aunque no haya filas
  const nodos = workflows['1-escribir-y-leer.json'].nodes;
  for (const n of nodos.filter((x) => x.parameters.operation === 'insert')) assert.deepEqual([n.onError, n.retryOnFail], ['continueRegularOutput', false]);
  for (const n of nodos.filter((x) => x.parameters.operation === 'get')) assert.equal(n.alwaysOutputData, true);
  // sólo los workflows de prueba escriben en la tabla temporal; nada referencia a otras tablas
  assert.ok(nodos.filter((x) => x.parameters.tableName).every((x) => x.parameters.tableName === prueba.TABLA));
});

test('payloads deterministas: kb·1024 bytes UTF-8 exactos, con marcas de inicio y fin y relleno multibyte en la variante UTF-8', () => {
  for (const e of prueba.ESPECIFICACION_TAM) {
    const p = prueba.construirPayload({ kb: e.kb, utf8: e.utf8 });
    assert.equal(Buffer.byteLength(p, 'utf8'), e.kb * 1024, e.id);
    assert.ok(p.startsWith(`INI|${e.kb}${e.utf8 ? 'u' : ''}|`) && p.endsWith('|FIN'));
  }
  const u = prueba.construirPayload({ kb: 32, utf8: true });
  assert.ok(u.length < Buffer.byteLength(u, 'utf8'), 'caracteres ≠ bytes en la variante UTF-8');
  assert.ok(/ñá€😀/.test(u));
  // la función incrustada en el nodo Code produce lo mismo que la de Node
  const codigo = workflows['1-escribir-y-leer.json'].nodes.find((n) => n.name === 'Filas de tamaño').parameters.jsCode;
  const ctx = { $execution: { mode: 'test' }, Date, JSON, Math, Number, String, Array, Object };
  vm.createContext(ctx);
  const filas = plano(vm.runInContext(`(function(){\n${codigo}\n})()`, ctx));
  assert.deepEqual(filas.map((f) => f.json.idEjecucion), ['tam-1', 'tam-8', 'tam-32', 'tam-64', 'tam-128', 'tam-utf8-32']);
  for (const f of filas) assert.equal(f.json.payload, prueba.construirPayload({ kb: f.json.tamanoKB, utf8: f.json.idEjecucion.includes('utf8') }));
});

test('las filas de «orden», «dup» y «recon» se insertan en el orden desordenado previsto y las auditorías son las del motor', () => {
  const codigo = workflows['1-escribir-y-leer.json'].nodes.find((n) => n.name === 'Filas pequeñas').parameters.jsCode;
  const ctx = { $execution: { mode: 'test' }, Date, JSON, Math, Number, String, Array, Object };
  vm.createContext(ctx);
  const filas = plano(vm.runInContext(`(function(){\n${codigo}\n})()`, ctx)).map((f) => f.json);
  assert.deepEqual(filas.filter((f) => f.caso === 'orden').map((f) => f.generadoEn), prueba.ORDEN_INSERCION_ORDEN.map(prueba.diaIso));
  assert.equal(filas.filter((f) => f.caso === 'dup').length, 2);
  assert.deepEqual(filas.filter((f) => f.caso === 'recon').map((f) => f.idEjecucion), prueba.ORDEN_INSERCION_RECON);
  for (const f of filas.filter((x) => x.caso === 'recon')) {
    const inst = JSON.parse(f.payload);
    assert.equal(inst.esquema, 1);
    assert.equal(inst.generadoEn, f.generadoEn, 'la instantánea lleva la fecha de la fila');
  }
});

/* ───────────────────────── Análisis sobre datos recuperados ───────────────────────── */
test('análisis: con una tabla que se comporta como se espera, todas las comprobaciones pasan y se hacen sobre los datos RECUPERADOS', () => {
  const r = prueba.analizarPrueba(ejecutarTodo());
  assert.equal(r.ok, true, JSON.stringify(r.resumen));
  assert.equal(resultado(r, 'T1').tamanoMaximoExactoKB, 512);
  assert.deepEqual(resultado(r, 'T5').valoresOrigen, ['production', 'test']);
  assert.equal(resultado(r, 'T4').duplicadosGuardados, 2);
  assert.equal(resultado(r, 'T6').ingenuoDifiere, true, 'plegar en orden de inserción da otro estado: por eso se ordena por fecha');
  assert.ok(resultado(r, 'T3').camposInsert.includes('id') && resultado(r, 'T3').camposInsert.includes('createdAt'));
});

test('análisis: una celda que se TRUNCA al guardar se detecta leyendo (aunque lo generado fuera correcto)', () => {
  const r = prueba.analizarPrueba(ejecutarTodo({ truncarA: 40000 }));
  const t1 = resultado(r, 'T1');
  assert.equal(t1.ok, false);
  assert.deepEqual(t1.tamanos.filter((t) => t.estado === 'alterada').map((t) => t.id).sort(), ['tam-128', 'tam-512', 'tam-64']);
  const t64 = t1.tamanos.find((t) => t.id === 'tam-64');
  assert.ok(t64.caracteres === 40000 && t64.bytes < t64.bytesEsperados && t64.huella !== t64.huellaEsperada);
  assert.equal(t1.tamanoMaximoExactoKB, 32);
});

test('análisis: una celda que se RECHAZA por tamaño queda como «no guardada» con el error del Insert', () => {
  const r = prueba.analizarPrueba(ejecutarTodo({ limiteCeldaBytes: 32 * 1024 }));
  const t1 = resultado(r, 'T1');
  assert.equal(t1.ok, false);
  const estados = Object.fromEntries(t1.tamanos.map((t) => [t.id, t.estado]));
  assert.deepEqual(estados, { 'tam-1': 'exacta', 'tam-8': 'exacta', 'tam-32': 'exacta', 'tam-64': 'no_guardada', 'tam-128': 'no_guardada', 'tam-utf8-32': 'exacta', 'tam-512': 'no_guardada' });
  assert.ok(t1.tamanos.find((t) => t.id === 'tam-64').rechazo.error.includes('too long'));
  assert.equal(t1.tamanoMaximoExactoKB, 32);
});

test('análisis: el mismo tamaño con contenido distinto también se detecta (comparación por contenido y huella, no por longitud)', () => {
  const r0 = ejecutarTodo();
  const run = r0.escribir.data.resultData.runData['Leer todo (orden de inserción)'][0].data.main[0];
  const fila = run.find((i) => i.json.idEjecucion === 'tam-32');
  fila.json.payload = fila.json.payload.replace('abcdefghij', 'abcdefghiX');
  assert.equal(fila.json.payload.length, prueba.construirPayload({ kb: 32 }).length);
  const t1 = resultado(prueba.analizarPrueba(r0), 'T1');
  assert.equal(t1.tamanos.find((t) => t.id === 'tam-32').estado, 'alterada');
  assert.equal(t1.ok, false);
});

test('análisis: un Get que ignora el orden se detecta; una tabla que rechaza duplicados se informa sin fallar', () => {
  assert.equal(resultado(prueba.analizarPrueba(ejecutarTodo({ sinOrden: true })), 'T2').ok, false);
  const r = prueba.analizarPrueba(ejecutarTodo({ rechazaDuplicados: true }));
  const t4 = resultado(r, 'T4');
  assert.equal(t4.ok, true);
  assert.equal(t4.duplicadosGuardados, 1);
  assert.match(t4.detalles[0], /RECHAZA o fusiona/);
});

test('análisis: sin filas recuperadas, la prueba falla (no se da nada por bueno)', () => {
  const vacio = { data: { resultData: { runData: {} } } };
  const r = prueba.analizarPrueba({ escribir: vacio });
  assert.equal(r.ok, false);
  assert.equal(resultado(r, 'T0').ok, false);
  assert.equal(resultado(r, 'T1').ok, false);
  assert.equal(resultado(r, 'T6').ok, false);
});

test('análisis: lee el typeVersion y el modo de referencia del JSON exportado de la instancia', () => {
  const exportado = [{ nodes: [{ type: prueba.TIPO_NODO, typeVersion: 1.1, parameters: { dataTableId: { __rl: true, mode: 'name', value: prueba.TABLA } } }, { type: prueba.TIPO_NODO, typeVersion: 1, parameters: { dataTableId: { __rl: true, mode: 'id', value: '=x' } } }] }];
  const t7 = resultado(prueba.analizarPrueba({ ...ejecutarTodo(), exportados: exportado }), 'T7');
  assert.deepEqual(t7.typeVersions, [1, 1.1]);
  assert.deepEqual(t7.modosReferencia, ['id', 'name']);
});

test('extraerEjecucion: separa la cabecera de n8n execute del JSON', () => {
  const texto = 'Execution was successful:\n====================================\n{"data":{"resultData":{"runData":{}}}}\n';
  assert.deepEqual(prueba.extraerEjecucion(texto), { data: { resultData: { runData: {} } } });
  assert.throws(() => prueba.extraerEjecucion('sin json'));
});

/* ───────────────────────── Reconstrucción determinista ───────────────────────── */
test('reconstrucción: el estado es el mismo para CUALQUIER orden de inserción y con duplicados, y distinto del plegado ingenuo', () => {
  const informes = prueba.informesRecon();
  const instantaneas = informes.map((r) => seg.resumirInstantanea(r.informe));
  const esperado = prueba.plegarInstantaneas(instantaneas);
  assert.deepEqual(esperado.pasos, ['linea_base:primera_ejecucion+guardar', 'comparacion+guardar', 'comparacion+guardar']);
  const filas = informes.map((r, i) => ({ id: i + 1, idEjecucion: r.id, generadoEn: r.informe.generadoEn, payload: JSON.stringify(seg.resumirInstantanea(r.informe)) }));
  const permutaciones = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => permutaciones([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  let distintos = 0;
  for (const perm of permutaciones(filas)) {
    const numeradas = perm.map((f, i) => ({ ...f, id: i + 1 }));
    assert.deepEqual(plano(prueba.reconstruir(numeradas).estado), plano(esperado.estado), perm.map((f) => f.idEjecucion).join(','));
    // con cada fila duplicada (inserciones repetidas) el resultado no cambia
    const duplicadas = [...numeradas, ...numeradas.map((f, i) => ({ ...f, id: 100 + i }))];
    assert.deepEqual(plano(prueba.reconstruir(duplicadas).estado), plano(esperado.estado));
    if (JSON.stringify(prueba.plegarInstantaneas(numeradas.map((f) => JSON.parse(f.payload))).estado) !== JSON.stringify(esperado.estado)) distintos++;
  }
  assert.ok(distintos > 0, 'plegar por orden de inserción da un estado distinto en alguna permutación');
  // el estado final recoge lo esperado: /a persiste 3 ejecuciones, /b se resolvió y /c existe desde el día 2
  const final = esperado.estado;
  assert.equal(final.incidencias['enlace:roto:/a'].consecutivas, 3);
  assert.ok(!('enlace:roto:/b' in final.incidencias));
  assert.equal(final.incidencias['enlace:roto:/c'].primeraVez, prueba.diaIso(2));
  assert.equal(final.revision, 3);
});

/* ───────────────────────── Seguridad del procedimiento y del entorno ───────────────────────── */
test('la CLI no escribe workflows dentro del repositorio y escribe los 4 fuera', () => {
  const dentro = spawnSync(process.execPath, [path.join(RAIZ, 'scripts/automation/prueba-data-tables.mjs'), 'generar', '--salida', path.join(RAIZ, 'automation', 'dev', 'prueba-data-tables', 'salida')], { encoding: 'utf8' });
  assert.equal(dentro.status, 2);
  assert.match(dentro.stderr, /dentro del repositorio/);
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'tai-dt-'));
  try {
    const fuera = spawnSync(process.execPath, [path.join(RAIZ, 'scripts/automation/prueba-data-tables.mjs'), 'generar', '--salida', tmp], { encoding: 'utf8' });
    assert.equal(fuera.status, 0, fuera.stderr);
    assert.deepEqual(fs.readdirSync(tmp).sort(), Object.keys(workflows).sort());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Compose de la prueba: proyecto, contenedores, red y volúmenes propios; red interna sin salida; un solo puerto en 127.0.0.1; imágenes fijadas; sin nada de Treidilor', () => {
  const c = fs.readFileSync(path.join(RAIZ, 'automation/dev/prueba-data-tables/docker-compose.yml'), 'utf8');
  const sinComentarios = c.replace(/^\s*#.*$/gm, '').replace(/\s+#.*$/gm, '');
  assert.match(sinComentarios, /^name: tai-prueba-dt$/m);
  assert.deepEqual([...sinComentarios.matchAll(/container_name: (\S+)/g)].map((m) => m[1]).sort(), ['tai-dt-db', 'tai-dt-n8n', 'tai-dt-puente-entrada']);
  assert.match(sinComentarios, /aislada:\s+name: tai-dt-aislada\s+internal: true/);
  assert.deepEqual([...sinComentarios.matchAll(/- "([^"]*:\d+:\d+)"/g)].map((m) => m[1]), ['127.0.0.1:5689:5678'], 'único puerto publicado, sólo en loopback');
  assert.ok(!/extra_hosts|host\.docker\.internal|network_mode|privileged|docker\.sock|\/var\/run/.test(sinComentarios), 'sin camino al anfitrión ni acceso al socket de Docker');
  assert.ok(!/treidilor-|treidilor_|treidilor-ai-pruebas|n8n_pruebas_datos|n8n_data\b/.test(sinComentarios), 'sin recursos de Treidilor ni del n8n de pruebas de los agentes');
  assert.deepEqual([...sinComentarios.matchAll(/^\s+name: (tai_dt_\w+)$/gm)].map((m) => m[1]).sort(), ['tai_dt_n8n', 'tai_dt_pg']);
  assert.match(sinComentarios, /image: postgres:17\b/);
  assert.match(sinComentarios, /image: n8nio\/n8n:\$\{PRUEBA_DT_N8N_VERSION:-2\.38\.6\}/);
  assert.ok(!/:latest/.test(sinComentarios));
  assert.equal((sinComentarios.match(/com\.treidilor\.prueba: data-tables/g) ?? []).length, 1, 'etiqueta definida una vez y reutilizada (ancla)');
  assert.ok(sinComentarios.includes('*etiqueta'));
  // el n8n de la prueba no puede hacer peticiones HTTP ni ejecutar comandos
  assert.match(sinComentarios, /NODES_EXCLUDE: .*httpRequest/);
  // secretos: ninguna contraseña ni clave en el fichero; sólo variables obligatorias
  assert.ok(!/(PASSWORD|ENCRYPTION_KEY): (?!\$\{)\S/.test(sinComentarios));
  const ejemplo = fs.readFileSync(path.join(RAIZ, 'automation/dev/prueba-data-tables/.env.example'), 'utf8');
  assert.ok(/^PRUEBA_DT_PG_PASSWORD=$/m.test(ejemplo) && /^PRUEBA_DT_ENCRYPTION_KEY=$/m.test(ejemplo), 'plantilla sin valores');
});

test('el generador y el análisis no se importan desde el Auditor, los agentes ni los workflows existentes (no los modifican)', () => {
  for (const f of ['automation/lib/auditor.mjs', 'automation/lib/seguimiento.mjs', 'automation/lib/common.mjs', 'automation/lib/researcher.mjs', 'automation/lib/diagnostico.mjs', 'scripts/automation/build-workflows.mjs']) {
    assert.ok(!fs.readFileSync(path.join(RAIZ, f), 'utf8').includes('prueba-data-tables'), f);
  }
  for (const f of fs.readdirSync(path.join(RAIZ, 'automation/workflows'))) assert.ok(!fs.readFileSync(path.join(RAIZ, 'automation/workflows', f), 'utf8').includes('tai_prueba_dt'), f);
});
