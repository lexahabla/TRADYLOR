// Treidilor AI · Auditor General v0.2, entrega 2c: MEMORIA PERSISTENTE con instantáneas inmutables en una Data Table de n8n (Get + Insert).
// Se ejecuta el workflow GENERADO en el simulador con un almacén en memoria que imita los nodos Data table (listar, leer, insertar). Sin red, sin n8n, sin Docker.
// La verificación con las Data Tables REALES de n8n 2.38.6 es otra fase (ver automation/docs/AUDITOR-SEGUIMIENTO.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const J = (p) => JSON.parse(fs.readFileSync(path.join(RAIZ, p), 'utf8'));
const aud = await import('../../automation/lib/auditor.mjs');
const seg = await import('../../automation/lib/seguimiento.mjs');
const common = await import('../../automation/lib/common.mjs');
const { simularWorkflow, crearAlmacenSimulado } = await import('../automation/simulate-workflow.mjs');
const { validarEsquema } = await import('../automation/validate-schema.mjs');
const { comprobarWorkflow } = await import('../automation/lint-workflows.mjs');

const PROD = J('automation/config/produccion.json');
const LOCAL = J('automation/config/local.json');
const TABLA = PROD.seguimiento.tabla;
const ESQ = { informe: () => J('automation/schemas/informe-auditor.schema.json') };
const T0 = Date.parse('2026-11-10T08:00:00.000Z');
const dia = (n, horas = 0) => new Date(T0 + n * 86400000 + horas * 3600000).toISOString();
const plano = (x) => JSON.parse(JSON.stringify(x));
const claves = (lista) => lista.map((x) => x.clave).sort();
const SALUD = { status: 'ok', sourceHash: 'a'.repeat(64), uptimeSeconds: 9000, dataDirExists: true, env: { smtp: true } };

/* ───────── sitio sintético y ejecución del workflow generado ───────── */
const pagina = ({ titulo = true, links = [] } = {}) => `<!doctype html><html><head>${titulo ? '<title>Treidilor</title>' : ''}</head><body><h1>Título</h1>${links.map((h) => `<a href="${h}">l</a>`).join('')}<p>${'x'.repeat(2500)}</p></body></html>`;
function sitio(spec) {
  return ({ url }) => {
    const u = new URL(url);
    if (spec.todoCaido) throw new Error('connect ECONNREFUSED');
    if (u.pathname === '/api/health') return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: SALUD };
    const s = spec[u.pathname] ?? {};
    if (s.timeout) throw new Error('timeout of 15000ms exceeded');
    if (s.status && s.status !== 200) return { statusCode: s.status, body: s.status >= 500 ? 'error' : '' };
    return { statusCode: 200, body: pagina({ titulo: s.titulo, links: u.pathname === '/' ? spec.enlaces ?? [] : [] }) };
  };
}
const DIA0 = { enlaces: ['/a', '/b', '/c'], '/a': { status: 404 }, '/b': { status: 500 }, '/catalogo': { titulo: false } };
const nuevoAlmacen = (tablas = [TABLA]) => crearAlmacenSimulado(tablas);
const filas = (almacen) => almacen.tablas[TABLA]?.filas ?? [];

function correr(spec, { n = 0, horas = 0, almacen = nuevoAlmacen(), mode = 'test', id = null, maxEnlaces } = {}) {
  const wf = J('automation/workflows/auditor-general.produccion.json');
  if (maxEnlaces !== undefined) for (const nodo of wf.nodes) if (nodo.type === 'n8n-nodes-base.code') nodo.parameters.jsCode = nodo.parameters.jsCode.replace(/"maxEnlaces": \d+/, `"maxEnlaces": ${maxEnlaces}`);
  const r = simularWorkflow(wf, { fetchSimulado: sitio(spec), ahora: dia(n, horas), hostsPermitidos: PROD.hostsPermitidos, almacen, ejecucion: { mode, id: id ?? `${n}-${horas}-${almacen.seq}` } });
  const salida = plano(r.salida);
  return { informe: salida[0].json, fila: salida[1]?.json ?? null, salida, almacen, salidas: r.salidas, peticiones: r.peticiones };
}
const operaciones = (almacen) => almacen.operaciones.map((o) => `${o.recurso}/${o.operacion}`);

/* ───────────────────────── Flujo completo con el workflow generado ───────────────────────── */
test('primera ejecución con la tabla vacía: línea base, una fila guardada con SÓLO las columnas del historial, y el informe lo dice', () => {
  const r = correr(DIA0);
  const p = r.informe.persistencia;
  assert.deepEqual(p.tabla, { nombre: TABLA, estado: 'ok' });
  assert.deepEqual(p.lectura, { filas: 0, validas: 0, duplicadas: 0, descartadas: 0, ultimaInstantanea: null });
  assert.deepEqual([p.escritura.guardar, p.escritura.motivo, p.escritura.origen], [true, 'ok', 'manual']);
  assert.deepEqual([r.informe.seguimiento.modo, r.informe.seguimiento.motivo, r.informe.seguimiento.origenReferencia], ['linea_base', 'primera_ejecucion', 'ninguna']);
  assert.equal(r.informe.seguimiento.resumen.nuevas, 0, 'línea base: nada es nuevo');
  assert.deepEqual(validarEsquema(r.informe, ESQ.informe()), []);
  // la salida de «Informe» lleva el informe y la fila; sólo la fila llega al Insert
  assert.equal(r.salida.length, 2);
  assert.equal(r.fila.tipo, 'fila');
  assert.deepEqual(operaciones(r.almacen), ['table/list', 'row/get', 'row/insert']);
  const guardadas = filas(r.almacen);
  assert.equal(guardadas.length, 1);
  const { id, createdAt, updatedAt, ...columnas } = guardadas[0];
  assert.deepEqual(Object.keys(columnas).sort(), [...seg.COLUMNAS_INSTANTANEAS].sort(), 'sólo las columnas permitidas (sin evidencias, textos ni datos sensibles)');
  assert.deepEqual([columnas.entorno, columnas.host, columnas.origen, columnas.calidad], ['produccion', 'treidilor.com', 'manual', 'completa']);
  assert.match(columnas.idEjecucion, /^ex-/);
  const inst = JSON.parse(columnas.payload);
  assert.deepEqual([inst.esquema, inst.generadoEn, inst.calidad.estado], [1, dia(0), 'completa']);
  assert.match(r.informe.markdown, /### Historial \(memoria del Auditor\)/);
  assert.match(r.informe.markdown, /\*\*se guardará\*\* una instantánea \(origen manual\)/);
});

test('ejecuciones sucesivas: nuevas, persistentes, resueltas y reaparecidas salen del HISTORIAL guardado, y cada ejecución completa añade una fila', () => {
  const almacen = nuevoAlmacen();
  correr(DIA0, { n: 0, almacen });
  // día 1: /a arreglado, /catalogo con título, /b sigue 500, /c ahora 404
  const d1 = correr({ enlaces: ['/a', '/b', '/c'], '/b': { status: 500 }, '/c': { status: 404 } }, { n: 1, almacen });
  assert.deepEqual([d1.informe.seguimiento.modo, d1.informe.seguimiento.origenReferencia, d1.informe.seguimiento.comparadoCon], ['comparacion', 'historial', dia(0)]);
  assert.deepEqual(claves(d1.informe.seguimiento.resueltas), ['enlace:roto:/a', 'ruta:sin_titulo:/catalogo']);
  assert.deepEqual(claves(d1.informe.seguimiento.persistentes), ['enlace:roto:/b']);
  assert.deepEqual(claves(d1.informe.seguimiento.nuevas), ['enlace:roto:/c']);
  assert.deepEqual(d1.informe.persistencia.lectura, { filas: 1, validas: 1, duplicadas: 0, descartadas: 0, ultimaInstantanea: dia(0) });
  assert.equal(filas(almacen).length, 2);
  // día 2: /a vuelve a romperse → reaparecida; /b arreglado
  const d2 = correr({ enlaces: ['/a', '/b', '/c'], '/a': { status: 404 }, '/c': { status: 404 } }, { n: 2, almacen });
  assert.deepEqual(claves(d2.informe.seguimiento.reaparecidas), ['enlace:roto:/a']);
  assert.deepEqual(claves(d2.informe.seguimiento.resueltas), ['enlace:roto:/b']);
  assert.deepEqual(claves(d2.informe.seguimiento.persistentes), ['enlace:roto:/c']);
  assert.equal(filas(almacen).length, 3);
  const p = d2.informe.seguimiento.persistentes[0];
  assert.deepEqual([p.ejecuciones, p.desde], [2, dia(1)]);
  assert.deepEqual(validarEsquema(d2.informe, ESQ.informe()), []);
});

test('origen de la ejecución con $execution.mode: manual (test) y programada (production); otro origen no actualiza el historial', () => {
  const almacen = nuevoAlmacen();
  const m = correr(DIA0, { n: 0, almacen, mode: 'test' });
  const p = correr(DIA0, { n: 1, almacen, mode: 'production' });
  assert.deepEqual(filas(almacen).map((f) => f.origen), ['manual', 'programada']);
  assert.deepEqual([m.informe.persistencia.escritura.origen, p.informe.persistencia.escritura.origen], ['manual', 'programada']);
  const otro = correr(DIA0, { n: 2, almacen, mode: 'cli' });
  assert.deepEqual([otro.informe.persistencia.escritura.guardar, otro.informe.persistencia.escritura.motivo, otro.informe.persistencia.escritura.origen], [false, 'origen_no_valido', 'cli']);
  assert.equal(filas(almacen).length, 2, 'un origen no permitido no escribe');
  assert.equal(otro.informe.seguimiento.modo, 'comparacion', 'pero sí compara con el historial');
  assert.ok(!operaciones(almacen).slice(-1).includes('row/insert') || filas(almacen).length === 2);
});

/* ───────────────────────── La tabla no está o falla ───────────────────────── */
test('sin la tabla: el informe sale igual, lo dice claramente y no lee ni guarda nada', () => {
  const r = correr(DIA0, { almacen: nuevoAlmacen([]) });
  assert.deepEqual(r.informe.persistencia.tabla, { nombre: TABLA, estado: 'no_encontrada' });
  assert.deepEqual([r.informe.persistencia.escritura.guardar, r.informe.persistencia.escritura.motivo], [false, 'persistencia_no_disponible']);
  assert.equal(r.informe.seguimiento.modo, 'linea_base');
  assert.equal(r.salida.length, 1, 'sin fila: el Insert no se ejecuta');
  assert.ok(!operaciones(r.almacen).includes('row/insert'));
  assert.match(r.informe.markdown, /Sin memoria persistente/);
  assert.match(r.informe.markdown, /crear tabla de instantáneas/);
  assert.deepEqual(validarEsquema(r.informe, ESQ.informe()), []);
});

test('tabla ambigua (otra tabla con ese texto en el nombre) o ilegible: no se usa la memoria; nunca se escribe en la tabla equivocada', () => {
  const ambigua = correr(DIA0, { almacen: nuevoAlmacen([TABLA, `${TABLA}_antigua`]) });
  assert.equal(ambigua.informe.persistencia.tabla.estado, 'ambigua');
  assert.ok(!operaciones(ambigua.almacen).includes('row/insert'));
  assert.equal(filas(ambigua.almacen).length + (ambigua.almacen.tablas[`${TABLA}_antigua`]?.filas.length ?? 0), 0);
  const ilegible = nuevoAlmacen();
  ilegible.falloLectura = true;
  const r = correr(DIA0, { almacen: ilegible });
  assert.equal(r.informe.persistencia.tabla.estado, 'error_lectura');
  assert.equal(r.informe.persistencia.escritura.guardar, false);
  assert.equal(filas(ilegible).length, 0);
});

test('si el Insert falla, el informe se genera igualmente (el fallo no detiene el workflow) y no se reintenta', () => {
  const almacen = nuevoAlmacen();
  almacen.falloInsert = true;
  const r = correr(DIA0, { almacen });
  assert.equal(r.informe.persistencia.escritura.guardar, true, 'el informe indica que quería guardar');
  assert.equal(filas(almacen).length, 0);
  assert.equal(operaciones(almacen).filter((o) => o === 'row/insert').length, 1, 'un solo intento (sin reintentos automáticos)');
  const salidaInsert = r.salidas.get('Guardar instantánea');
  assert.match(salidaInsert[0].json.error, /Could not insert/);
});

/* ───────────────────────── Calidad, orden y protecciones ───────────────────────── */
test('no se guardan auditorías FALLIDAS ni PARCIALES, y la última referencia válida queda intacta', () => {
  const almacen = nuevoAlmacen();
  correr(DIA0, { n: 0, almacen });
  const antes = plano(filas(almacen));
  const caida = correr({ todoCaido: true }, { n: 1, almacen });
  assert.equal(caida.informe.resumen.estado, 'critico');
  assert.deepEqual([caida.informe.seguimiento.modo, caida.informe.persistencia.escritura.guardar, caida.informe.persistencia.escritura.motivo], ['sin_comparar', false, 'ejecucion_fallida']);
  const parcial = correr({ enlaces: ['/a', '/b', '/c'], '/a': { timeout: true }, '/b': { timeout: true }, '/c': { timeout: true } }, { n: 2, almacen });
  assert.equal(parcial.informe.seguimiento.calidad.estado, 'parcial');
  assert.deepEqual([parcial.informe.persistencia.escritura.guardar, parcial.informe.persistencia.escritura.motivo], [false, 'ejecucion_parcial']);
  assert.deepEqual(plano(filas(almacen)), antes, 'ninguna fila nueva ni modificada');
  // y lo que no se revisó no se da por resuelto
  assert.ok(!claves(parcial.informe.seguimiento.resueltas).includes('enlace:roto:/a'));
});

test('una ejecución ANTIGUA o TARDÍA no degrada el estado válido: no se guarda y la reconstrucción no cambia', () => {
  const almacen = nuevoAlmacen();
  correr(DIA0, { n: 0, almacen });
  correr(DIA0, { n: 5, almacen });
  const antes = plano(filas(almacen));
  const estadoAntes = plano(seg.reconstruirEstado(antes, { entorno: 'produccion' }).estado);
  const tardia = correr({ enlaces: ['/a'], '/a': { status: 404 } }, { n: 2, almacen });
  assert.deepEqual([tardia.informe.seguimiento.modo, tardia.informe.seguimiento.motivo], ['sin_comparar', 'orden_invalido']);
  assert.deepEqual([tardia.informe.persistencia.escritura.guardar, tardia.informe.persistencia.escritura.motivo], [false, 'orden_invalido']);
  assert.deepEqual(plano(filas(almacen)), antes);
  assert.deepEqual(plano(seg.reconstruirEstado(filas(almacen), { entorno: 'produccion' }).estado), estadoAntes);
  // la misma fecha tampoco: no hay dos auditorías en el mismo instante
  assert.equal(correr(DIA0, { n: 5, almacen }).informe.persistencia.escritura.motivo, 'orden_invalido');
});

test('una fila con fecha FUTURA en el historial se descarta y no bloquea las auditorías siguientes', () => {
  const almacen = nuevoAlmacen();
  const base = correr(DIA0, { n: 0, almacen });
  const futura = { ...plano(filas(almacen)[0]), id: 99, idEjecucion: 'ex-reloj-roto', generadoEn: dia(400) };
  const inst = JSON.parse(futura.payload);
  futura.payload = JSON.stringify({ ...inst, generadoEn: dia(400) });
  almacen.tablas[TABLA].filas.push(futura);
  const r = correr(DIA0, { n: 1, almacen });
  assert.equal(r.informe.persistencia.lectura.descartadas, 1);
  assert.equal(r.informe.persistencia.escritura.guardar, true, 'la auditoría de hoy sí se guarda');
  assert.equal(r.informe.seguimiento.comparadoCon, base.informe.generadoEn);
});

test('reintento: la misma ejecución no se guarda dos veces (idempotencia por idEjecucion)', () => {
  const almacen = nuevoAlmacen();
  correr(DIA0, { n: 0, almacen, id: 'ex-777' });
  const otra = correr(DIA0, { n: 1, almacen, id: 'ex-777' });
  assert.deepEqual([otra.informe.persistencia.escritura.guardar, otra.informe.persistencia.escritura.motivo], [false, 'ya_guardada']);
  assert.equal(filas(almacen).length, 1);
});

test('el historial leído se limita a las últimas filas configuradas (el Get ordena por generadoEn descendente con límite)', () => {
  const wf = J('automation/workflows/auditor-general.produccion.json');
  const get = wf.nodes.find((n) => n.name === 'Leer historial').parameters;
  assert.deepEqual([get.returnAll, get.limit, get.orderBy, get.orderByColumn, get.orderByDirection], [false, PROD.seguimiento.maxHistorial, true, 'generadoEn', 'DESC']);
  assert.deepEqual(get.filters.conditions, [{ keyName: 'entorno', condition: 'eq', keyValue: 'produccion' }]);
  const almacen = nuevoAlmacen();
  for (let i = 0; i < 70; i++) correr(DIA0, { n: i, almacen, id: `x${i}` });
  assert.equal(filas(almacen).length, 70);
  const r = correr(DIA0, { n: 70, almacen });
  assert.equal(r.informe.persistencia.lectura.filas, PROD.seguimiento.maxHistorial);
  assert.equal(r.informe.persistencia.lectura.ultimaInstantanea, dia(69));
});

/* ───────────────────────── Reconstrucción, duplicados y concurrencia (motor) ───────────────────────── */
const inc = (area, codigo, clave, gravedad = 'alta') => ({ id: `${area}:${codigo}:${clave}`, gravedad, area, titulo: 't', detalle: 'd', evidencia: {}, accionSugerida: 'a', clase: 'disponibilidad', ambito: 'produccion' });
const informe = (n, incidencias, { entorno = 'produccion', enlaces = ['/a', '/b', '/c'], peticiones = 20, host = 'treidilor.com' } = {}) => ({
  agente: 'auditor-general', version: '0.2.0', entorno, modo: 'publico', generadoEn: dia(n), soloLectura: true, resumen: { peticiones }, incidencias, avisosEntorno: [], cobertura: { revisado: [], noRevisado: [] },
  alcance: { host, salud: true, rutas: ['/'], enlaces, fichas: [], contenido: { rutas: ['/'], fichas: [] }, catalogo: { leido: false, completo: false } },
});
const fila = (n, incidencias, extra = {}) => {
  const inst = seg.resumirInstantanea(informe(n, incidencias, extra.informe ?? {}));
  return { id: extra.id, ...seg.filaDeInstantanea(inst, { idEjecucion: extra.idEjecucion ?? `ex-${n}`, origen: 'programada' }), ...(extra.fila ?? {}) };
};

test('reconstrucción: deduplica por (entorno, idEjecucion) conservando la fila de menor id, y ordena por (generadoEn, idEjecucion)', () => {
  const f1 = fila(1, [inc('enlace', 'roto', '/a')], { id: 5 });
  const f1dup = { ...f1, id: 3 }; // mismo idEjecucion, id menor: es la que se conserva
  const f1otra = { ...f1, id: 9, payload: f1.payload.replace('/a', '/zzz') };
  assert.deepEqual(seg.deduplicarFilas([f1, f1dup, f1otra]).map((f) => f.id), [3]);
  const otroEntorno = { ...f1, id: 4, entorno: 'local' };
  assert.equal(seg.deduplicarFilas([f1, otroEntorno]).length, 2, 'el mismo idEjecucion en otro entorno es otra fila');
  // empates de generadoEn: manda idEjecucion
  const a = { ...fila(2, []), id: 7, idEjecucion: 'ex-b' };
  const b = { ...fila(2, []), id: 6, idEjecucion: 'ex-a' };
  assert.deepEqual(seg.ordenarFilas([a, b]).map((f) => f.idEjecucion), ['ex-a', 'ex-b']);
  // el resultado es el mismo con duplicados y para cualquier orden de inserción
  const lista = [fila(1, [inc('enlace', 'roto', '/a')], { id: 1 }), fila(2, [inc('enlace', 'roto', '/a'), inc('enlace', 'roto', '/b')], { id: 2 }), fila(3, [inc('enlace', 'roto', '/b')], { id: 3 })];
  const esperado = plano(seg.reconstruirEstado(lista, { entorno: 'produccion' }).estado);
  const permutaciones = (x) => (x.length <= 1 ? [x] : x.flatMap((e, i) => permutaciones([...x.slice(0, i), ...x.slice(i + 1)]).map((p) => [e, ...p])));
  for (const perm of permutaciones(lista)) {
    const numeradas = perm.map((f, i) => ({ ...f, id: i + 1 }));
    assert.deepEqual(plano(seg.reconstruirEstado(numeradas, { entorno: 'produccion' }).estado), esperado);
    assert.deepEqual(plano(seg.reconstruirEstado([...numeradas, ...numeradas.map((f, i) => ({ ...f, id: 50 + i }))], { entorno: 'produccion' }).estado), esperado, 'con cada fila duplicada');
  }
  assert.equal(esperado.incidencias['enlace:roto:/b'].primeraVez, dia(2));
  assert.ok(!('enlace:roto:/a' in esperado.incidencias), '/a se resolvió el día 3');
});

test('reconstrucción: ignora lo que no es una fila y las de otro entorno, y descarta con motivo las inválidas', () => {
  const buena = fila(1, [inc('enlace', 'roto', '/a')], { id: 1 });
  const instParcial = JSON.parse(buena.payload);
  const malas = [
    { ...buena, id: 2, idEjecucion: 'x-json', payload: '{no es json' },
    { ...buena, id: 3, idEjecucion: 'x-esquema', payload: JSON.stringify({ ...instParcial, esquema: 2 }) },
    { ...buena, id: 4, idEjecucion: 'x-calidad', payload: JSON.stringify({ ...instParcial, calidad: { estado: 'parcial', motivos: [] } }) },
    { ...buena, id: 5, idEjecucion: 'x-fecha', generadoEn: dia(2) }, // la fila dice otra fecha que su instantánea
    { ...buena, id: 6, idEjecucion: 'x-grande', payload: JSON.stringify({ ...instParcial, relleno: 'x'.repeat(70000) }) },
  ];
  const otras = [{}, { error: 'Could not read data table' }, { ...buena, id: 7, idEjecucion: 'x-local', entorno: 'local' }, null, 'texto'];
  const r = seg.reconstruirEstado([...otras, ...malas, buena], { entorno: 'produccion', ahoraIso: dia(1) });
  assert.equal(r.validas, 1);
  assert.deepEqual(r.descartadas.map((d) => [d.idEjecucion, d.motivo]).sort(), [['x-calidad', 'calidad_no_completa'], ['x-esquema', 'esquema_incompatible'], ['x-fecha', 'fila_incoherente'], ['x-grande', 'payload_invalido'], ['x-json', 'payload_invalido']]);
  assert.ok(r.estado && 'enlace:roto:/a' in r.estado.incidencias);
});

test('concurrencia: dos auditorías que leen el MISMO historial y terminan en cualquier orden convergen al mismo estado, sin perder ninguna', () => {
  const base = nuevoAlmacen();
  correr(DIA0, { n: 0, almacen: base });
  const clon = () => { const a = nuevoAlmacen(); a.tablas[TABLA].filas = plano(filas(base)); a.seq = base.seq; return a; };
  const specA = { enlaces: ['/a', '/b', '/c'], '/b': { status: 500 }, '/c': { status: 404 } };
  const specB = { enlaces: ['/a', '/b', '/c'], '/c': { status: 404 } };
  const a = correr(specA, { n: 1, almacen: clon(), id: 'ex-A' });
  const b = correr(specB, { n: 2, almacen: clon(), id: 'ex-B' }); // leyó el mismo historial que A (no vio su fila)
  assert.equal(a.informe.persistencia.escritura.guardar && b.informe.persistencia.escritura.guardar, true);
  assert.equal(a.informe.persistencia.lectura.filas, 1);
  assert.equal(b.informe.persistencia.lectura.filas, 1);
  const filaA = a.fila, filaB = b.fila;
  const base1 = plano(filas(base));
  const soloColumnas = (f, id) => ({ id, ...Object.fromEntries(seg.COLUMNAS_INSTANTANEAS.map((c) => [c, f[c]])) });
  const ab = [...base1, soloColumnas(filaA, 100), soloColumnas(filaB, 101)];
  const ba = [...base1, soloColumnas(filaB, 100), soloColumnas(filaA, 101)];
  const eAB = seg.reconstruirEstado(ab, { entorno: 'produccion' });
  const eBA = seg.reconstruirEstado(ba, { entorno: 'produccion' });
  assert.deepEqual(plano(eAB.estado), plano(eBA.estado), 'el orden de inserción no cambia el estado');
  assert.equal(eAB.validas, 3, 'no se pierde ninguna auditoría');
  // y coincide con ejecutarlas en secuencia
  const sec = nuevoAlmacen();
  sec.tablas[TABLA].filas = plano(base1);
  sec.seq = base.seq;
  correr(specA, { n: 1, almacen: sec, id: 'ex-A' });
  correr(specB, { n: 2, almacen: sec, id: 'ex-B' });
  assert.deepEqual(plano(seg.reconstruirEstado(filas(sec), { entorno: 'produccion' }).estado), plano(eAB.estado));
  // una reejecución simultánea del MISMO id no duplica el efecto
  const dupl = [...ab, soloColumnas(filaA, 102)];
  assert.deepEqual(plano(seg.reconstruirEstado(dupl, { entorno: 'produccion' }).estado), plano(eAB.estado));
});

test('estado recortado y no verificado: lo que no se puede demostrar como nuevo es «indeterminada», y lo no revisado no se resuelve', () => {
  // 250 incidencias en la última auditoría guardada → el estado reconstruido queda recortado (máx. 200)
  const muchas = Array.from({ length: 250 }, (_, i) => inc('enlace', 'roto', `/p/${String(i).padStart(3, '0')}`, i < 5 ? 'critica' : 'baja'));
  const enlaces = Array.from({ length: 250 }, (_, i) => `/p/${String(i).padStart(3, '0')}`);
  const grande = fila(1, muchas, { id: 1, informe: { enlaces, peticiones: 400 } });
  const previo = seg.reconstruirEstado([grande], { entorno: 'produccion' });
  assert.deepEqual(previo.estado.recortado, { conservadas: 200, omitidas: 50 });
  const nueva = informe(2, [...muchas.slice(0, 3), inc('enlace', 'roto', '/p/249', 'baja')], { enlaces, peticiones: 400 });
  const r = seg.ejecutarSeguimientoConHistorial([grande], nueva, { idEjecucion: 'ex-2', origen: 'programada' });
  assert.ok(r.seguimiento.indeterminadas.some((x) => x.clave === 'enlace:roto:/p/249'), 'ausente por el recorte: no se puede decir que sea nueva');
  assert.equal(r.seguimiento.nuevas.length, 0);
  assert.equal(r.guardar, true);
  // no verificada: la auditoría siguiente no revisa /a
  const conA = fila(1, [inc('enlace', 'roto', '/a')], { id: 1 });
  const sinRevisar = seg.ejecutarSeguimientoConHistorial([conA], informe(2, [], { enlaces: [] }), { idEjecucion: 'ex-2', origen: 'manual' });
  assert.deepEqual(claves(sinRevisar.seguimiento.noVerificadas), ['enlace:roto:/a']);
  assert.equal(sinRevisar.seguimiento.resueltas.length, 0);
});

/* ───────────────────────── Límites y privacidad ───────────────────────── */
test('una instantánea que excede el tamaño máximo no se guarda; las normales caben con holgura', () => {
  const muchas = Array.from({ length: 250 }, (_, i) => inc('enlace', 'roto', `/p/${i}`, 'baja'));
  const grande = informe(1, muchas, { enlaces: Array.from({ length: 250 }, (_, i) => `/p/${i}`), peticiones: 400 });
  const r = seg.ejecutarSeguimientoConHistorial([], grande, { idEjecucion: 'ex-1', origen: 'manual', persistencia: { maxBytesInstantanea: 2000 } });
  assert.deepEqual([r.guardar, r.motivoGuardado, r.fila], [false, 'instantanea_demasiado_grande', null]);
  const normal = seg.ejecutarSeguimientoConHistorial([], informe(1, [inc('enlace', 'roto', '/a')]), { idEjecucion: 'ex-1', origen: 'manual' });
  assert.equal(normal.guardar, true);
  assert.ok(Buffer.byteLength(normal.fila.payload) < 2000, `una auditoría normal ocupa ${Buffer.byteLength(normal.fila.payload)} bytes`);
  assert.ok(seg.LIMITES_PERSISTENCIA.maxBytesInstantanea <= 65536);
});

test('privacidad: la fila no contiene evidencias, textos, HTML ni secretos aunque el informe los tenga', () => {
  const sensible = { ...inc('enlace', 'roto', '/a'), titulo: 'TÍTULO-SENSIBLE', detalle: 'DETALLE-SENSIBLE Bearer abcdefghijklmnop', evidencia: { url: 'https://treidilor.com/a', secreto: 'SECRETO-123', cuerpo: '<html>HTML-SENSIBLE</html>' }, accionSugerida: 'ACCION-SENSIBLE' };
  const r = seg.ejecutarSeguimientoConHistorial([], informe(1, [sensible]), { idEjecucion: 'ex-1', origen: 'manual' });
  const texto = JSON.stringify(r.fila);
  for (const prohibido of ['SENSIBLE', 'SECRETO', 'Bearer', '<html>', 'titulo', 'detalle', 'evidencia', 'accionSugerida', 'markdown']) assert.ok(!texto.includes(prohibido), prohibido);
  assert.deepEqual(Object.keys(r.fila).sort(), [...seg.COLUMNAS_INSTANTANEAS].sort());
  assert.ok(Object.values(r.fila).every((v) => typeof v === 'string'), 'todas las columnas son texto');
});

/* ───────────────────────── Configuración, generación y política de seguridad ───────────────────────── */
test('configuración: la sección de seguimiento es válida y se valida', () => {
  assert.deepEqual(common.validarConfig(PROD), []);
  assert.deepEqual(common.validarConfig(LOCAL), []);
  for (const mala of [{ ...PROD.seguimiento, tabla: 'Mal Nombre' }, { ...PROD.seguimiento, tabla: 'abc' }, { ...PROD.seguimiento, maxHistorial: 0 }, { ...PROD.seguimiento, maxHistorial: 500 }, { ...PROD.seguimiento, origenesValidos: ['cli'] }, { ...PROD.seguimiento, origenesValidos: [] }]) {
    assert.ok(common.validarConfig({ ...PROD, seguimiento: mala }).length > 0, JSON.stringify(mala));
  }
  assert.deepEqual(common.validarConfig({ ...PROD, seguimiento: undefined }), [], 'es opcional (compatibilidad)');
});

test('workflows generados: tabla por NOMBRE (sin ids de ninguna instalación), Insert sin reintentos, sólo listar/leer/insertar, y el linter lo exige', () => {
  for (const f of ['auditor-general.produccion.json', 'auditor-general.local.json']) {
    const wf = J(`automation/workflows/${f}`);
    assert.deepEqual(comprobarWorkflow(wf, { nombreArchivo: f }).errores, [], f);
    const dt = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.dataTable');
    assert.deepEqual(dt.map((n) => n.name), ['Comprobar tabla', 'Leer historial', 'Guardar instantánea']);
    const texto = JSON.stringify(wf);
    assert.ok(!/"mode":"(id|list)"|dataTableId":"[^{]/.test(texto), 'ninguna referencia por id o lista');
    assert.ok(!/tabla-\d|prueba_dt|tai_prueba|"projectId"/.test(texto), 'nada específico de una instalación');
    const ins = dt.find((n) => n.parameters.operation === 'insert');
    assert.deepEqual([ins.retryOnFail, ins.onError, ins.parameters.options], [false, 'continueRegularOutput', {}]);
    assert.deepEqual(Object.keys(ins.parameters.columns.value).sort(), [...seg.COLUMNAS_INSTANTANEAS].sort());
    // la fila sólo llega al Insert a través del nodo «Solo la fila»
    const entradas = Object.entries(wf.connections).filter(([, c]) => c.main[0].some((x) => x.node === 'Guardar instantánea')).map(([d]) => d);
    assert.deepEqual(entradas, ['Solo la fila']);
    // no se amplía el alcance de exploración: los nodos HTTP son los mismos de antes
    assert.equal(wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').length, f.includes('local') ? 5 : 2);
  }
  // el linter rechaza lo que no debe
  const base = J('automation/workflows/auditor-general.produccion.json');
  const prueba = (cambia, patron) => { const w = plano(base); cambia(w.nodes.find((n) => n.name === 'Guardar instantánea'), w); assert.ok(comprobarWorkflow(w, { nombreArchivo: 'auditor-general.produccion.json' }).errores.some((e) => patron.test(e)), String(patron)); };
  prueba((n) => { n.retryOnFail = true; }, /no puede reintentar/);
  prueba((n) => { n.parameters.dataTableId = { __rl: true, mode: 'id', value: 'abc123' }; }, /por NOMBRE fijo/);
  prueba((n) => { n.parameters.dataTableId = { __rl: true, mode: 'name', value: '={{ $json.t }}' }; }, /por NOMBRE fijo/);
  prueba((n) => { n.parameters.operation = 'upsert'; }, /operación de Data table no permitida/);
  prueba((n) => { n.parameters.operation = 'deleteRows'; }, /operación de Data table no permitida/);
  prueba((n) => { n.parameters.columns.value.secreto = '={{ $json.x }}'; }, /sólo puede escribir las columnas/);
  prueba((n) => { n.parameters.dataTableId = { __rl: true, mode: 'name', value: 'otra_tabla' }; }, /sólo la tabla de la configuración/);
  prueba((n, w) => { w.connections['Leer historial'] = { main: [[{ node: 'Guardar instantánea', type: 'main', index: 0 }]] }; w.connections['Solo la fila'] = { main: [[]] }; }, /el Insert sólo puede recibir datos de nodos Code/);
});

test('workflow de preparación: crea la tabla (sólo ahí se permite crear), sin credenciales ni peticiones, e idempotente', () => {
  const f = 'auditor-instantaneas-crear-tabla.json';
  const wf = J(`automation/workflows/${f}`);
  assert.deepEqual(comprobarWorkflow(wf, { nombreArchivo: f }).errores, []);
  const crear = wf.nodes.find((n) => n.type === 'n8n-nodes-base.dataTable');
  assert.deepEqual([crear.parameters.resource, crear.parameters.operation, crear.parameters.tableName, crear.parameters.options], ['table', 'create', TABLA, { createIfNotExists: true }]);
  assert.deepEqual(crear.parameters.columns.column.map((c) => c.name), seg.COLUMNAS_INSTANTANEAS);
  assert.ok(crear.parameters.columns.column.every((c) => c.type === 'string'));
  assert.ok(wf.nodes.every((n) => !n.credentials) && !wf.nodes.some((n) => /httpRequest/.test(n.type)));
  assert.equal(wf.active, false);
  // en otro workflow, crear tablas está prohibido
  const w = J('automation/workflows/auditor-general.produccion.json');
  const nodo = w.nodes.find((n) => n.name === 'Comprobar tabla');
  nodo.parameters = { resource: 'table', operation: 'create', tableName: TABLA };
  assert.ok(comprobarWorkflow(w, { nombreArchivo: 'auditor-general.produccion.json' }).errores.some((e) => /table\/create/.test(e)));
  // el simulador crea la tabla y la segunda ejecución no cambia nada
  const alm = crearAlmacenSimulado([]);
  for (let i = 0; i < 2; i++) simularWorkflow(wf, { almacen: alm });
  assert.deepEqual(Object.keys(alm.tablas), [TABLA]);
});

test('tamaño de los nodos Code: el del Informe queda por debajo de 80 kB con margen y el resto de nodos son pequeños', () => {
  for (const f of fs.readdirSync(path.join(RAIZ, 'automation/workflows'))) {
    const wf = J(`automation/workflows/${f}`);
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      const bytes = Buffer.byteLength(n.parameters.jsCode);
      assert.ok(bytes < 80_000, `${f} · ${n.name}: ${bytes} bytes`);
      if (n.name !== 'Informe') assert.ok(bytes < 25_000, `${f} · ${n.name}: ${bytes} bytes (sólo incrusta lo que usa)`);
    }
  }
  const informeProd = J('automation/workflows/auditor-general.produccion.json').nodes.find((n) => n.name === 'Informe').parameters.jsCode;
  assert.ok(Buffer.byteLength(informeProd) < 76_000, `margen: ${Buffer.byteLength(informeProd)} bytes`);
  assert.match(informeProd, /function evaluarUrl\(/);
  assert.match(informeProd, /validarAislamiento\(CONFIG\)/);
});

test('aislamiento y alcance sin cambios: mismas peticiones (sólo GET públicos) y el tope de 40 enlaces', () => {
  assert.equal(PROD.maxEnlaces, 40);
  const r = correr({ ...DIA0, enlaces: Array.from({ length: 60 }, (_, i) => `/g/${String(i).padStart(2, '0')}`) });
  assert.equal(r.peticiones.length, 1 + 4 + 40);
  for (const p of r.peticiones) {
    const u = new URL(p.url);
    assert.deepEqual([p.metodo, u.protocol, u.host, p.credencial], ['GET', 'https:', 'treidilor.com', false]);
    assert.ok(u.pathname === '/api/health' || !u.pathname.startsWith('/api'));
  }
  assert.equal(r.informe.consumo.presupuesto.enlacesPedidos, 40);
  assert.ok(r.informe.consumo.estimado.esEstimacion);
});

test('compatibilidad: construirInformeAuditor y los informes sin persistencia siguen funcionando', () => {
  const entradaBase = { cfg: PROD, objetivosRutas: aud.crearObjetivosRutas(PROD), respuestasRutas: aud.crearObjetivosRutas(PROD).map((t) => (t.tipo === 'salud' ? { statusCode: 200, headers: { 'content-type': 'application/json' }, data: JSON.stringify(SALUD) } : { statusCode: 200, headers: { 'content-type': 'text/html' }, data: pagina() })), ahoraIso: dia(0) };
  const sin = aud.construirInformeAuditor(entradaBase);
  assert.ok(!('persistencia' in sin));
  assert.equal(sin.seguimiento.origenReferencia, 'ninguna');
  assert.deepEqual(validarEsquema(plano(sin), ESQ.informe()), []);
  const yFila = aud.construirInformeYFila({ ...entradaBase, persistencia: { tablas: [{ id: 't', name: TABLA }], historial: [{}], idEjecucion: 'ex-1', origen: 'manual' } });
  assert.deepEqual(plano(yFila.informe).seguimiento.origenReferencia, 'ninguna');
  assert.ok(yFila.fila && yFila.fila.idEjecucion === 'ex-1');
  // sin configuración de seguimiento en la CONFIG, la persistencia no se usa
  const sinCfg = aud.construirInformeYFila({ ...entradaBase, cfg: { ...PROD, seguimiento: undefined }, persistencia: { tablas: [{ id: 't', name: TABLA }], historial: [], idEjecucion: 'ex-1', origen: 'manual' } });
  assert.deepEqual([sinCfg.informe.persistencia.tabla.estado, sinCfg.fila], ['sin_configurar', null]);
});
