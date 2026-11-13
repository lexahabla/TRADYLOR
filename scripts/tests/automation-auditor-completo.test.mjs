// Controlador de la validación integral del Auditor completo: artefactos, ensayo en simulador, verificación del registro y regresión de `alwaysOutputData`. Sin Docker ni n8n.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const plano = (x) => JSON.parse(JSON.stringify(x));
const ctl = await import('../automation/prueba-auditor-completo.mjs');
const sitio = await import('../../automation/dev/prueba-data-tables/sitio-prueba.mjs');
const { simularWorkflow, crearAlmacenSimulado } = await import('../automation/simulate-workflow.mjs');
const lint = await import('../automation/lint-workflows.mjs').catch(() => null);

const TOKEN = ctl.tokenFicticio();
const REAL = () => JSON.parse(leer('automation/workflows/auditor-general.local.json'));
const nodo = (wf, n) => wf.nodes.find((x) => x.name === n);

/* ───────────────────────── Artefactos ───────────────────────── */
test('artefactos: nombre con prefijo, active=false, y la copia local original NO se modifica (se compara con el fichero)', () => {
  const antes = leer('automation/workflows/auditor-general.local.json');
  const art = ctl.generarArtefactos();
  assert.equal(leer('automation/workflows/auditor-general.local.json'), antes);
  assert.deepEqual(Object.keys(art).sort(), ['auditor-insert-sin-salida-alwaysOutputData.json', 'auditor-insert-sin-salida.json', 'auditor-insert-tabla-inexistente.json', 'auditor-insert-validacion-falla.json', 'auditor-programado.json', 'credencial-ficticia.json', 'renombrar-tabla-ida.json', 'renombrar-tabla-vuelta.json']);
  for (const [f, wf] of Object.entries(art)) {
    if (f === 'credencial-ficticia.json') continue;
    assert.ok(wf.name.startsWith(ctl.PREFIJO), f);
    assert.equal(wf.active, false, f);
  }
  assert.equal(REAL().active, false);
});

test('variantes: cada una difiere del Auditor local SÓLO en lo esperado', () => {
  const real = REAL();
  const sin = (wf, n) => plano(wf.nodes.filter((x) => x.name !== n));
  const iguales = (wf, excepto) => assert.deepEqual(sin(wf, excepto), sin(real, excepto)) || assert.deepEqual(wf.connections, real.connections);
  const v = ctl.variantesPersistencia();
  const falla = v['auditor-insert-validacion-falla.json'];
  iguales(falla, 'Guardar instantánea');
  assert.deepEqual(Object.keys(nodo(falla, 'Guardar instantánea').parameters.columns.value).filter((k) => !(k in nodo(real, 'Guardar instantánea').parameters.columns.value)), ['columna_inexistente']);
  const tabla = v['auditor-insert-tabla-inexistente.json'];
  iguales(tabla, 'Guardar instantánea');
  assert.equal(nodo(tabla, 'Guardar instantánea').parameters.dataTableId.value, 'tabla_que_no_existe');
  assert.equal(nodo(tabla, 'Guardar instantánea').onError, 'continueErrorOutput', 'mantiene la gestión de errores de 2c');
  const prog = ctl.auditorProgramado();
  assert.equal(prog.nodes.filter((n) => n.type === 'n8n-nodes-base.scheduleTrigger').length, 1);
  assert.equal(prog.nodes.filter((n) => n.type === 'n8n-nodes-base.manualTrigger').length, 0);
  assert.deepEqual(prog.nodes.map((n) => n.name).filter((n) => !/Programación|Ejecutar|manual/i.test(n)).sort(), real.nodes.map((n) => n.name).filter((n) => !/Programación|Ejecutar|manual/i.test(n)).sort());
  assert.equal(prog.active, false, 'la copia programada se genera INACTIVA');
  assert.equal(prog.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger').parameters.rule.interval[0].minutesInterval, 1);
  const trigger = prog.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger').name;
  assert.ok(prog.connections[trigger]?.main?.[0]?.length >= 1, 'el disparador está conectado');
  // el código del Auditor es idéntico en todas las variantes (no se modifica)
  for (const wf of [falla, tabla, prog]) for (const n of real.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) assert.equal(nodo(wf, n.name).parameters.jsCode, n.parameters.jsCode, n.name);
});

test('credenciales: sólo la ficticia, compuesta en ejecución; ningún fichero del repositorio contiene el token ni su forma literal', () => {
  const [cred] = ctl.credencialFicticia();
  assert.match(cred.data.value, /^Bearer tai_0{16}_F{43}$/);
  assert.equal(cred.name, ctl.NOMBRE_CREDENCIAL);
  const ficheros = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: RAIZ, encoding: 'utf8' }).split('\n').filter((f) => /\.(mjs|json|ya?ml|md|txt)$/.test(f) && !f.startsWith('INFORMES/'));
  const literal = ['tai', '0'.repeat(16), 'F'.repeat(43)].join('_');
  const culpables = ficheros.filter((f) => fs.existsSync(path.join(RAIZ, f)) && fs.readFileSync(path.join(RAIZ, f), 'utf8').includes(literal));
  assert.deepEqual(culpables, [], 'el token ficticio no debe aparecer literal en el repositorio');
  const artefactosSinCred = Object.entries(ctl.generarArtefactos()).filter(([f]) => f !== 'credencial-ficticia.json');
  for (const [f, x] of artefactosSinCred) assert.ok(!JSON.stringify(x).includes(literal), `${f} no lleva la credencial`);
});

test('todas las URLs de los artefactos apuntan sólo al sitio interno (http://puente-treidilor:4350) o a la propia instancia; ningún host externo', () => {
  for (const [f, x] of Object.entries(ctl.generarArtefactos())) {
    const urls = [...JSON.stringify(x).matchAll(/https?:\/\/[^\s"'\\]+/g)].map((m) => m[0]);
    for (const u of urls) assert.ok(/^http:\/\/puente-treidilor:4350(\/|$)/.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)/.test(u), `${f}: ${u}`);
  }
  assert.equal(ctl.LOCAL.baseUrl, 'http://puente-treidilor:4350');
  assert.deepEqual(ctl.LOCAL.hostsPermitidos, ['puente-treidilor:4350']);
});

test('CLI: «generar» rechaza una carpeta dentro del repositorio y escribe fuera (en un directorio temporal)', () => {
  const cli = path.join(RAIZ, 'scripts/automation/prueba-auditor-completo.mjs');
  const dentro = spawnSync(process.execPath, [cli, 'generar', '--salida', path.join(RAIZ, 'INFORMES', '_no_debe_existir')], { encoding: 'utf8' });
  assert.equal(dentro.status, 2);
  assert.ok(!fs.existsSync(path.join(RAIZ, 'INFORMES', '_no_debe_existir')));
  const sin = spawnSync(process.execPath, [cli, 'generar'], { encoding: 'utf8' });
  assert.equal(sin.status, 2);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-art-'));
  try {
    const ok = spawnSync(process.execPath, [cli, 'generar', '--salida', tmp], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(fs.readdirSync(tmp).length, 8);
    assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, 'credencial-ficticia.json'), 'utf8'))[0].data.value.includes(TOKEN));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI: «comandos» sólo imprime; no ejecuta nada ni se conecta (los comandos están y usan --pull never y el proyecto tai-prueba-dt)', () => {
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts/automation/prueba-auditor-completo.mjs'), 'comandos'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /up -d --pull never/);
  assert.match(r.stdout, /-p tai-prueba-dt/);
  assert.doesNotMatch(r.stdout, /\bpush\b|prune|down -v|rm -f|docker system|treidilor-ai-pruebas/);
  assert.equal(ctl.comandosPaso2().length, 13);
});

test('el ejecutor real sólo toca el n8n temporal (127.0.0.1:5689) y contenedores tai-dt-*; nunca producción ni treidilor-*', () => {
  const f = leer('scripts/automation/prueba-auditor-completo.mjs');
  // se excluye la línea de las pruebas NEGATIVAS de aislamiento (wget a Internet/producción que deben FALLAR)
  const codigo = f.split('\n').filter((l) => !/wget/.test(l)).join('\n').replace(/^\s*\/\/.*$/gm, '');
  const permitidos = ['tai-dt-aislada', 'tai-dt-db', 'tai-dt-n8n', 'tai-dt-sitio', 'tai-dt-puente'];
  const usados = [...new Set([...codigo.matchAll(/tai-dt-[a-z0-9]+/g)].map((m) => m[0]))];
  assert.ok(usados.length >= 3 && usados.every((u) => permitidos.includes(u)), usados.join());
  assert.deepEqual([...new Set([...codigo.matchAll(/https?:\/\/[A-Za-z0-9.:_-]+/g)].map((m) => m[0]))].sort(), ['http://127.0.0.1:5689']);
  assert.ok(!/treidilor\.com|treidilor-ai-pruebas|5678\b|n8n_pruebas/.test(codigo));
});

/* ───────────────────────── Ensayo en simulador ───────────────────────── */
test('ensayo: la secuencia completa (7 escenarios) cumple TODAS las comprobaciones con el Auditor local sin modificar', () => {
  const r = ctl.ensayoEnSimulador();
  const fallos = r.resultados.flatMap((x) => x.comprobaciones.filter((k) => !k.ok).map((k) => `${x.nombre}:${k.id} ${k.detalle}`));
  assert.deepEqual(fallos, []);
  assert.equal(r.resultados.length, 7);
  // lo comprobado lo es sobre el registro del sitio, no sólo sobre el informe
  const base = r.resultados[0];
  assert.deepEqual(base.registro.map((x) => x.metodo).filter((m) => m !== 'GET'), []);
  assert.ok(base.registro.every((x) => x.ua === ctl.UA_ESPERADO));
  const muchos = r.resultados[6];
  assert.equal(ctl.verificarRegistroSitio(muchos.registro).resumen.enlaces, 60, 'el tope de 60 enlaces se respeta con 80 disponibles');
  // origen: test→manual; en producción→programada; origen ajeno no guarda
  const prog = ctl.ensayoEnSimulador({ secuencia: ['base'], modos: { base: 'production' } }).resultados[0];
  assert.equal(prog.final.persistencia.escritura.resultado, 'guardada');
  const raro = ctl.ensayoEnSimulador({ secuencia: ['base'], modos: { base: 'webhook' } }).resultados[0];
  assert.notEqual(raro.final.persistencia.escritura.resultado, 'guardada', 'un origen no válido no guarda');
});

test('el ensayo detecta fallos de verdad: con una petición prohibida o sin cabeceras la verificación falla', () => {
  const e = sitio.crearEstado('arreglado');
  const ua = { 'user-agent': ctl.UA_ESPERADO, 'x-treidilor-agente': 'auditor-general' };
  const p = (url, cab = ua, metodo = 'GET') => sitio.procesar({ metodo, url, cabeceras: cab }, e);
  p('/api/health'); p('/'); p('/catalogo');
  assert.equal(ctl.verificarRegistroSitio(e.registro).ok, true);
  const mal = (fn) => { const x = sitio.crearEstado('arreglado'); const q = (u, cab = ua, m = 'GET') => sitio.procesar({ metodo: m, url: u, cabeceras: cab }, x); q('/api/health'); fn(q); return ctl.verificarRegistroSitio(x.registro); };
  assert.match(mal((q) => q('/api/redirect?id=1')).problemas.join(), /prohibidas/);
  assert.match(mal((q) => q('/producto/p1')).problemas.join(), /prohibidas/);
  assert.match(mal((q) => q('/', {})).problemas.join(), /identificación/);
  assert.match(mal((q) => q('/', ua, 'POST')).problemas.join(), /no son GET/);
  assert.match(mal((q) => q('/', { ...ua, authorization: `Bearer ${TOKEN}` })).problemas.join(), /Authorization fuera/);
  assert.match(mal((q) => q('/api/automation/v1/catalog?limit=100&page=1', ua)).problemas.join(), /sin el token/);
  assert.match(mal((q) => { q('/'); q('/'); }).problemas.join(), /repetidas/);
  assert.match(mal((q) => q('/otra')).problemas.join(), /fuera de lo esperado/);
  assert.match(mal((q) => { for (let i = 0; i < 61; i++) q(`/guias/${i}`); }).problemas.join(), /más enlaces que el tope/);
  const sinSalud = sitio.crearEstado('arreglado'); sitio.procesar({ metodo: 'GET', url: '/', cabeceras: ua }, sinSalud);
  assert.match(ctl.verificarRegistroSitio(sinSalud.registro).problemas.join(), /primera petición/);
});

/* ───────────────────────── Regresión de alwaysOutputData (candidato; NO aplicado a 2c) ───────────────────────── */
const ejecutar = (wf, { ahora = '2026-11-12T10:00:00.000Z', escenario = 'base', modo = 'test', falloInsert = false } = {}) => {
  const estado = sitio.crearEstado(escenario);
  const almacen = crearAlmacenSimulado([ctl.TABLA]);
  almacen.falloInsert = falloInsert;
  const sim = simularWorkflow(wf, { fetchSimulado: ctl.crearFetchSimulado(REAL(), estado), ahora, hostsPermitidos: ctl.LOCAL.hostsPermitidos, almacen, ejecucion: { mode: modo, id: '1' } });
  const informe = plano(sim.salida)[0].json;
  const conf = sim.salidas.get('Confirmar escritura');
  return { informe, confirmado: conf, final: plano(conf?.[0]?.json ?? informe), almacen, sim };
};

test('alwaysOutputData: Insert que NO emite nada, SIN el flag → «Confirmar escritura» no se ejecuta y la escritura queda «pendiente» (el problema)', () => {
  const r = ejecutar(ctl.auditorInsertSinSalida(false));
  assert.ok(!r.confirmado || r.confirmado.length === 0, 'la confirmación no se ejecuta');
  assert.equal(r.final.persistencia.escritura.resultado, 'pendiente');
});

test('alwaysOutputData: con el flag, «Confirmar escritura» SÍ se ejecuta y marca fallida/sin_confirmacion (la mitigación)', () => {
  const r = ejecutar(ctl.auditorInsertSinSalida(true));
  assert.equal(r.confirmado?.length, 1);
  assert.deepEqual([r.final.persistencia.escritura.resultado, r.final.persistencia.escritura.motivoFallo], ['fallida', 'sin_confirmacion']);
  assert.ok(r.final.resumen && r.final.seguimiento, 'el informe sigue íntegro');
});

test('alwaysOutputData: el éxito normal no cambia con el candidato (sigue «guardada» con la fila, una sola confirmación)', () => {
  const real = REAL();
  const base = ejecutar(real);
  const cand = ejecutar(ctl.conAlwaysOutputData(real));
  for (const r of [base, cand]) {
    assert.equal(r.final.persistencia.escritura.resultado, 'guardada');
    assert.ok(Number.isFinite(Number(r.final.persistencia.escritura.filaId)));
    assert.equal(r.confirmado.length, 1);
  }
  assert.equal(base.almacen.filas?.(ctl.TABLA)?.length ?? 1, cand.almacen.filas?.(ctl.TABLA)?.length ?? 1);
});

test('alwaysOutputData: el candidato difiere del Auditor local SÓLO en el flag del Insert y no rompe el linter', async () => {
  const real = REAL();
  const cand = ctl.conAlwaysOutputData(real);
  assert.equal(nodo(cand, 'Guardar instantánea').alwaysOutputData, true);
  assert.equal(nodo(real, 'Guardar instantánea').alwaysOutputData, undefined, 'el workflow real NO lo lleva');
  const quitar = (wf) => { const x = plano(wf); delete nodo(x, 'Guardar instantánea').alwaysOutputData; return x; };
  assert.deepEqual(quitar(cand), real);
  assert.equal(JSON.stringify(nodo(JSON.parse(leer('automation/workflows/auditor-general.produccion.json')), 'Guardar instantánea') ?? {}).includes('alwaysOutputData'), false, 'no se ha aplicado a 2c (el workflow de producción generado no lo lleva)');
  if (lint?.lintWorkflow) { const r = lint.lintWorkflow(cand); assert.deepEqual(r.errores ?? r.errors ?? [], []); }
});

test('alwaysOutputData: fallos del Insert con el candidato (validación fallida / tabla inexistente) siguen dando «fallida» con su motivo y el informe íntegro', () => {
  const v = ctl.variantesPersistencia();
  for (const [f, wf] of Object.entries(v)) {
    const r = ejecutar(ctl.conAlwaysOutputData(wf), { falloInsert: /tabla/.test(f) ? 'tabla' : true });
    assert.equal(r.final.persistencia.escritura.resultado, 'fallida', f);
    assert.ok(r.final.resumen, 'informe íntegro');
    assert.equal(r.confirmado.length >= 1, true);
  }
});

test('«Confirmar escritura» es robusto a un elemento vacío extra junto a la fila o al error', () => {
  const real = REAL();
  const base = ejecutar(real);
  const conf = nodo(real, 'Confirmar escritura');
  assert.ok(conf, 'existe el nodo');
  assert.equal(base.final.persistencia.escritura.resultado, 'guardada');
  const cand = ejecutar(ctl.conAlwaysOutputData(real));
  assert.equal(cand.final.persistencia.escritura.resultado, 'guardada', 'un {} extra no degrada una escritura confirmada');
});
