#!/usr/bin/env node
// PRUEBA AISLADA de las Data Tables de n8n (entrega previa a 2c). Sirve para comprobar, en un n8n de PRUEBAS con PostgreSQL y SIN conexión a nada de Treidilor, lo que
// necesita el almacenamiento del estado del Auditor: inserción, lectura ordenada, tamaño de celda, duplicados, ejecuciones manuales y reconstrucción determinista.
//
//   node scripts/automation/prueba-data-tables.mjs generar --salida <carpeta>            genera los 4 workflows de prueba (JSON) — NO toca n8n ni Docker
//   node scripts/automation/prueba-data-tables.mjs analizar --escribir f1.txt [--origen f3.txt ...] [--leer f2.txt] [--exportados carpeta] [--salida informe.json]
//        analiza (offline) la salida de `n8n execute` de esos workflows. TODAS las comprobaciones se hacen sobre los datos RECUPERADOS de la tabla (nodos Get), nunca
//        sobre los datos generados: lo generado sólo se recalcula aquí para compararlo.
//
// Este fichero no usa red ni credenciales y no se importa desde el Auditor ni desde los workflows existentes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const seg = await import(new URL('../../automation/lib/seguimiento.mjs', import.meta.url));

export const TABLA = 'tai_prueba_dt';
export const TIPO_NODO = 'n8n-nodes-base.dataTable';
export const TYPE_VERSION = 1.1;
export const COLUMNAS = [
  ['caso', 'string'], ['entorno', 'string'], ['generadoEn', 'string'], ['epoch', 'number'], ['idEjecucion', 'string'], ['origen', 'string'], ['tamanoKB', 'number'], ['payload', 'string'],
];
/** Tamaños (KB) que se prueban en la tabla; el de 512 es EXPLORATORIO (para saber dónde está el límite, si lo hay). */
export const ESPECIFICACION_TAM = [
  { id: 'tam-1', kb: 1 }, { id: 'tam-8', kb: 8 }, { id: 'tam-32', kb: 32 }, { id: 'tam-64', kb: 64 }, { id: 'tam-128', kb: 128 },
  { id: 'tam-utf8-32', kb: 32, utf8: true }, { id: 'tam-512', kb: 512, exploratorio: true },
];
/** Día n de la prueba (UTC, 08:00): mismo cálculo en los workflows y en el análisis. */
export const diaIso = (n) => new Date(Date.UTC(2026, 10, 10 + n, 8, 0, 0)).toISOString();
export const ORDEN_INSERCION_ORDEN = [3, 1, 5, 2, 4];

/**
 * Contenido DETERMINISTA de una celda: `INI|<kb>[u]|` + relleno + `|FIN`, con EXACTAMENTE kb·1024 bytes UTF-8. Con utf8:true el relleno lleva ñ, á, €, 😀 (2, 2, 3 y 4 bytes).
 * Se incrusta tal cual (toString) en el nodo Code del workflow y se recalcula aquí para comparar con lo recuperado de la tabla.
 */
export function construirPayload(opc) {
  const kb = opc.kb;
  const utf8 = Boolean(opc.utf8);
  const objetivo = kb * 1024;
  const cab = 'INI|' + kb + (utf8 ? 'u' : '') + '|';
  const pie = '|FIN';
  const unidad = utf8 ? 'ñá€😀' : 'abcdefghij0123456789';
  const bytesUnidad = utf8 ? 11 : 20;
  const hueco = objetivo - cab.length - pie.length;
  const n = Math.floor(hueco / bytesUnidad);
  return cab + unidad.repeat(n) + 'x'.repeat(hueco - n * bytesUnidad) + pie;
}

/* ───────────────────────── Auditorías sintéticas para la prueba de reconstrucción ───────────────────────── */
const inc = (area, codigo, clave, gravedad) => ({ id: `${area}:${codigo}:${clave}`, gravedad, area, titulo: 't', detalle: 'd', evidencia: {}, accionSugerida: 'a', clase: 'disponibilidad', ambito: 'produccion' });
const informe = (dia, incidencias, enlaces) => ({
  agente: 'auditor-general', version: '0.2.0', entorno: 'produccion', modo: 'publico', generadoEn: diaIso(dia), soloLectura: true,
  resumen: { peticiones: 20 }, incidencias, avisosEntorno: [], cobertura: { revisado: [], noRevisado: [] },
  alcance: { host: 'sitio-prueba.invalid', salud: true, rutas: ['/'], enlaces, fichas: [], contenido: { rutas: ['/'], fichas: [] }, catalogo: { leido: false, completo: false } },
});
/** Tres auditorías consecutivas (día 1, 2 y 3): A abre /a y /b; B resuelve /b y abre /c; C mantiene /a y /c. Se INSERTAN en orden B, A, C (fuera de orden). */
export function informesRecon() {
  return [
    { id: 'recon-A', dia: 1, informe: informe(1, [inc('enlace', 'roto', '/a', 'alta'), inc('enlace', 'roto', '/b', 'media')], ['/a', '/b', '/c']) },
    { id: 'recon-B', dia: 2, informe: informe(2, [inc('enlace', 'roto', '/a', 'alta'), inc('enlace', 'roto', '/c', 'alta')], ['/a', '/b', '/c']) },
    { id: 'recon-C', dia: 3, informe: informe(3, [inc('enlace', 'roto', '/a', 'alta'), inc('enlace', 'roto', '/c', 'alta')], ['/a', '/b', '/c']) },
  ];
}
export const ORDEN_INSERCION_RECON = ['recon-B', 'recon-A', 'recon-C'];

/** Pliega instantáneas EN EL ORDEN DADO con el motor de 2a: devuelve el estado final y el modo de cada paso. */
export function plegarInstantaneas(instantaneas) {
  let estado = null;
  const pasos = [];
  for (const inst of instantaneas) {
    const comparacion = seg.compararConEstado(estado, inst);
    const siguiente = seg.siguienteEstado(estado, inst, comparacion);
    pasos.push(`${comparacion.modo}${comparacion.motivo ? `:${comparacion.motivo}` : ''}${siguiente.guardar ? '+guardar' : ''}`);
    if (siguiente.guardar) estado = siguiente.estado;
  }
  return { estado, pasos };
}
/** Reconstrucción DETERMINISTA: elimina duplicados por idEjecucion (se queda la fila de menor `id`) y ordena por (generadoEn, idEjecucion), no por el orden de inserción. */
export function reconstruir(filas) {
  const unicas = deduplicarPorIdEjecucion(filas);
  const ordenadas = [...unicas].sort((a, b) => (a.generadoEn < b.generadoEn ? -1 : a.generadoEn > b.generadoEn ? 1 : a.idEjecucion < b.idEjecucion ? -1 : a.idEjecucion > b.idEjecucion ? 1 : 0));
  return plegarInstantaneas(ordenadas.map((f) => JSON.parse(f.payload)));
}
export function deduplicarPorIdEjecucion(filas) {
  const porId = new Map();
  for (const f of [...filas].sort((a, b) => a.id - b.id)) if (!porId.has(f.idEjecucion)) porId.set(f.idEjecucion, f);
  return [...porId.values()];
}

/* ───────────────────────── Generación de los workflows ───────────────────────── */
const AJUSTES = { executionOrder: 'v1', timezone: 'Europe/Madrid', saveManualExecutions: true, saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' };
const AVISO = 'PRUEBA AISLADA de Data Tables (Treidilor AI). Sólo para un n8n de PRUEBAS sin conexión a Treidilor: no hace peticiones HTTP, no usa credenciales y sólo escribe en la tabla temporal «' + TABLA + '».';
const nodoManual = () => ({ parameters: {}, name: 'Ejecutar a mano', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] });
const nota = (texto) => ({ parameters: { content: texto, height: 160, width: 420 }, name: 'Aviso', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, -260] });
const nodoCode = (nombre, js, i) => ({ parameters: { jsCode: js }, name: nombre, type: 'n8n-nodes-base.code', typeVersion: 2, position: [260 * (i + 1), 0] });
const porNombre = (valor) => ({ __rl: true, mode: 'name', value: valor });
const esquema = COLUMNAS.map(([id, type]) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, type, canBeUsedToMatch: true }));
const valores = Object.fromEntries(COLUMNAS.map(([c]) => [c, `={{ $json.${c} }}`]));
const nodoTabla = (nombre, i, operation, parameters) => ({ parameters: { resource: 'table', operation, ...parameters }, name: nombre, type: TIPO_NODO, typeVersion: TYPE_VERSION, position: [260 * (i + 1), 0] });
const nodoCrearTabla = (i) => nodoTabla('Crear tabla', i, 'create', { tableName: TABLA, columns: { column: COLUMNAS.map(([name, type]) => ({ name, type })) }, options: { createIfNotExists: true } });
const nodoInsertar = (nombre, i) => ({
  parameters: { resource: 'row', operation: 'insert', dataTableId: porNombre(TABLA), columns: { mappingMode: 'defineBelow', value: valores, matchingColumns: [], schema: esquema }, options: {} },
  name: nombre, type: TIPO_NODO, typeVersion: TYPE_VERSION, position: [260 * (i + 1), 0], onError: 'continueRegularOutput', retryOnFail: false,
});
/** Get con TODOS sus parámetros en el nivel superior (el nodo Get no tiene colección `options`). */
const nodoGet = (nombre, i, { filtro, returnAll = true, limit, orden, dataTableId = porNombre(TABLA) } = {}) => ({
  parameters: {
    resource: 'row', operation: 'get', dataTableId,
    matchType: 'allConditions',
    filters: { conditions: filtro ? [{ keyName: 'caso', condition: 'eq', keyValue: filtro }] : [] },
    returnAll,
    ...(returnAll ? {} : { limit }),
    orderBy: Boolean(orden),
    ...(orden ? { orderByColumn: orden[0], orderByDirection: orden[1] } : {}),
  },
  name: nombre, type: TIPO_NODO, typeVersion: TYPE_VERSION, position: [260 * (i + 1), 0], alwaysOutputData: true,
});
const uno = (nombre, i) => nodoCode(nombre, 'return [{ json: {} }];', i); // un solo elemento: cada Get se ejecuta UNA vez
const filaJs = "const D = (n) => new Date(Date.UTC(2026, 10, 10 + n, 8, 0, 0)).toISOString();\nconst fila = (caso, n, idEjecucion, extra) => ({ json: Object.assign({ caso: caso, entorno: 'prueba', generadoEn: D(n), epoch: Date.parse(D(n)), idEjecucion: idEjecucion, origen: $execution.mode, tamanoKB: 0, payload: '' }, extra) });";

function cadena(nombres) {
  const c = {};
  nombres.slice(0, -1).forEach((n, i) => { c[n] = { main: [[{ node: nombres[i + 1], type: 'main', index: 0 }]] }; });
  return c;
}
function workflow(nombre, intermedios, textoAviso) {
  const nodos = intermedios.map((n) => n);
  const todos = [nodoManual(), nota(`${AVISO}\n${textoAviso}`), ...nodos];
  return { name: nombre, nodes: todos, connections: cadena(['Ejecutar a mano', ...nodos.map((n) => n.name)]), active: false, settings: AJUSTES, tags: [] };
}

export function generarWorkflows() {
  const recon = informesRecon();
  const porId = Object.fromEntries(recon.map((r) => [r.id, r]));
  const reconJs = JSON.stringify(ORDEN_INSERCION_RECON.map((id) => ({ dia: porId[id].dia, id, instantanea: JSON.stringify(seg.resumirInstantanea(porId[id].informe)) })));
  const pequenas = `${filaJs}\nconst RECON = ${reconJs};\nreturn [].concat(\n  ${JSON.stringify(ORDEN_INSERCION_ORDEN)}.map((n) => fila('orden', n, 'orden-' + n, { payload: 'orden-' + n })),\n  [fila('dup', 1, 'dup-1', { payload: 'dup' }), fila('dup', 1, 'dup-1', { payload: 'dup' })],\n  RECON.map((r) => fila('recon', r.dia, r.id, { payload: r.instantanea }))\n);`;
  const tam = (lista) => `${filaJs}\n${construirPayload.toString()}\nconst ESP = ${JSON.stringify(lista)};\nreturn ESP.map((e) => fila(e.exploratorio ? 'tam-expl' : 'tam', 1, e.id, { tamanoKB: e.kb, payload: construirPayload({ kb: e.kb, utf8: e.utf8 }) }));`;
  const escribir = workflow('PRUEBA DT 1 · escribir y leer', [
    nodoCrearTabla(0),
    nodoCode('Filas pequeñas', pequenas, 1),
    nodoInsertar('Insertar pequeñas', 2),
    nodoCode('Filas de tamaño', tam(ESPECIFICACION_TAM.filter((e) => !e.exploratorio)), 3),
    nodoInsertar('Insertar tamaños', 4),
    nodoCode('Fila exploratoria', tam(ESPECIFICACION_TAM.filter((e) => e.exploratorio)), 5),
    nodoInsertar('Insertar exploratoria', 6),
    uno('Uno 1', 7), nodoGet('Leer todo (orden de inserción)', 8),
    uno('Uno 2', 9), nodoGet('Leer orden generadoEn DESC (límite 3)', 10, { filtro: 'orden', returnAll: false, limit: 3, orden: ['generadoEn', 'DESC'] }),
    uno('Uno 3', 11), nodoGet('Leer orden generadoEn ASC', 12, { filtro: 'orden', orden: ['generadoEn', 'ASC'] }),
    uno('Uno 4', 13), nodoGet('Leer orden epoch DESC (límite 3)', 14, { filtro: 'orden', returnAll: false, limit: 3, orden: ['epoch', 'DESC'] }),
    uno('Uno 5', 15), nodoGet('Leer por id de tabla', 16, { dataTableId: { __rl: true, mode: 'id', value: "={{ $('Crear tabla').first().json.id }}" } }),
  ], 'Crea la tabla, inserta filas (orden, duplicados, auditorías fuera de orden y tamaños de 1 a 512 KB) y las LEE de vuelta con varios Get.');
  const leer = workflow('PRUEBA DT 2 · leer', [uno('Uno', 0), nodoGet('Leer todo', 1)], 'Sólo lee la tabla (comprueba la persistencia entre ejecuciones).');
  const origen = workflow('PRUEBA DT 3 · origen de la ejecución', [
    nodoCrearTabla(0),
    nodoCode('Fila origen', `${filaJs}\nreturn [fila('origen', 1, 'origen-' + String($execution.id), { payload: String($execution.mode) })];`, 1),
    nodoInsertar('Insertar origen', 2),
    uno('Uno', 3), nodoGet('Leer filas origen', 4, { filtro: 'origen' }),
  ], 'Escribe UNA fila con el valor de $execution.mode. Se ejecuta por la CLI y por el editor (manual) para ver qué valor toma cada vía.');
  const limpiar = workflow('PRUEBA DT 4 · limpiar', [nodoTabla('Borrar tabla de prueba', 0, 'delete', { dataTableId: porNombre(TABLA) })], `Borra SOLO la tabla «${TABLA}».`);
  return { '1-escribir-y-leer.json': escribir, '2-leer.json': leer, '3-origen.json': origen, '4-limpiar.json': limpiar };
}

/* ───────────────────────── Análisis de los datos RECUPERADOS ───────────────────────── */
/** Extrae el JSON de la ejecución de la salida de `n8n execute` (texto con cabecera «====»). */
export function extraerEjecucion(texto) {
  const marca = String(texto).indexOf('====');
  const inicio = String(texto).indexOf('{', marca >= 0 ? marca : 0);
  if (inicio < 0) throw new Error('la salida no contiene un JSON de ejecución');
  return JSON.parse(String(texto).slice(inicio));
}
const resultData = (ej) => ej?.data?.resultData ?? ej?.resultData ?? {};
const filasDe = (ej, nodo) => ((resultData(ej).runData?.[nodo]?.[0]?.data?.main?.[0]) ?? []).map((i) => i.json);
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 16);
const prueba = (id, titulo, ok, detalles, extra = {}) => ({ id, titulo, ok, detalles, ...extra });

export function analizarPrueba({ escribir, origenes = [], leer = null, exportados = [] }) {
  const pruebas = [];
  const rdE = resultData(escribir);
  const todas = filasDe(escribir, 'Leer todo (orden de inserción)');
  const nodosInsertar = ['Insertar pequeñas', 'Insertar tamaños', 'Insertar exploratoria'];
  const salidasInsertar = nodosInsertar.map((n) => ({ nodo: n, items: filasDe(escribir, n), error: rdE.runData?.[n]?.[0]?.error ?? null }));

  // T0 · la ejecución terminó y la lectura devolvió filas
  pruebas.push(prueba('T0', 'La ejecución se completó y la lectura devolvió filas', !rdE.error && todas.length > 0, [rdE.error ? `error global: ${JSON.stringify(rdE.error).slice(0, 200)}` : 'sin error global', `filas leídas: ${todas.length}`]));

  // T3 · inserciones: lo que devolvió Insert coincide con lo que hay en la tabla
  const idsInsertados = salidasInsertar.flatMap((s) => s.items.filter((i) => Number.isFinite(i.id)).map((i) => i.id));
  const idsLeidos = todas.map((f) => f.id);
  const camposInsert = salidasInsertar[0].items[0] ? Object.keys(salidasInsertar[0].items[0]).sort() : [];
  const crecientes = idsLeidos.every((id, i) => i === 0 || id > idsLeidos[i - 1]);
  pruebas.push(prueba('T3', 'Inserciones: Insert devuelve las filas y todas están en la tabla (ids únicos y crecientes)',
    idsInsertados.length > 0 && idsInsertados.every((id) => idsLeidos.includes(id)) && new Set(idsLeidos).size === idsLeidos.length && crecientes && todas.every((f) => f.createdAt !== undefined),
    [`filas devueltas por Insert: ${idsInsertados.length} · filas leídas: ${idsLeidos.length}`, `campos de una fila devuelta por Insert: ${camposInsert.join(', ')}`, ...salidasInsertar.filter((s) => s.error || s.items.some((i) => i.error)).map((s) => `${s.nodo}: ERROR ${JSON.stringify(s.error ?? s.items.find((i) => i.error)).slice(0, 200)}`)],
    { camposInsert }));

  // T1 · tamaño de celda, sobre los datos RECUPERADOS (comparados con el contenido esperado y su huella)
  const tamanos = ESPECIFICACION_TAM.map((e) => {
    const esperado = construirPayload({ kb: e.kb, utf8: e.utf8 });
    const fila = todas.find((f) => f.idEjecucion === e.id);
    if (!fila) return { ...e, estado: 'no_guardada', rechazo: salidasInsertar.map((s) => s.items.find((i) => i.error)).find(Boolean) ?? null };
    const real = typeof fila.payload === 'string' ? fila.payload : '';
    const exacto = real === esperado;
    return { ...e, estado: exacto ? 'exacta' : 'alterada', caracteres: real.length, bytes: Buffer.byteLength(real, 'utf8'), bytesEsperados: e.kb * 1024, huella: sha(real), huellaEsperada: sha(esperado), tamanoKBColumna: fila.tamanoKB };
  });
  const obligatorias = tamanos.filter((t) => !t.exploratorio);
  const maxOk = Math.max(0, ...tamanos.filter((t) => t.estado === 'exacta').map((t) => t.kb));
  pruebas.push(prueba('T1', 'Tamaño de celda (1, 8, 32, 64 y 128 KB + UTF-8): el contenido recuperado es idéntico al esperado',
    obligatorias.every((t) => t.estado === 'exacta'),
    tamanos.map((t) => `${t.id}: ${t.estado}${t.bytes !== undefined ? ` (${t.bytes}/${t.bytesEsperados} bytes, ${t.caracteres} caracteres, huella ${t.huella}${t.huella === t.huellaEsperada ? '' : ` ≠ ${t.huellaEsperada}`})` : ''}${t.exploratorio ? ' [exploratoria]' : ''}`),
    { tamanos, tamanoMaximoExactoKB: maxOk }));

  // T2 · lectura ordenada
  const secuencia = (nodo) => filasDe(escribir, nodo).map((f) => f.generadoEn);
  const esperadoDesc = [5, 4, 3].map(diaIso);
  const esperadoAsc = [1, 2, 3, 4, 5].map(diaIso);
  const ordenInsercion = todas.filter((f) => f.caso === 'orden').map((f) => f.generadoEn);
  const t2 = {
    descLimite3: JSON.stringify(secuencia('Leer orden generadoEn DESC (límite 3)')) === JSON.stringify(esperadoDesc),
    asc: JSON.stringify(secuencia('Leer orden generadoEn ASC')) === JSON.stringify(esperadoAsc),
    epochDesc: JSON.stringify(filasDe(escribir, 'Leer orden epoch DESC (límite 3)').map((f) => f.generadoEn)) === JSON.stringify(esperadoDesc),
    porDefectoEsInsercion: JSON.stringify(ordenInsercion) === JSON.stringify(ORDEN_INSERCION_ORDEN.map(diaIso)),
  };
  pruebas.push(prueba('T2', 'Lectura ordenada: orden por texto (ISO) y por número, límite y orden por defecto (= inserción)', Object.values(t2).every(Boolean),
    [`generadoEn DESC con límite 3: ${t2.descLimite3 ? 'correcto' : `INCORRECTO (${JSON.stringify(secuencia('Leer orden generadoEn DESC (límite 3)'))})`}`, `generadoEn ASC: ${t2.asc ? 'correcto' : 'INCORRECTO'}`, `epoch DESC con límite 3: ${t2.epochDesc ? 'correcto' : 'INCORRECTO'}`, `orden por defecto = orden de inserción (id ascendente): ${t2.porDefectoEsInsercion ? 'sí' : 'NO'}`], { t2 }));

  // T4 · duplicados
  const dups = todas.filter((f) => f.caso === 'dup');
  const unicos = deduplicarPorIdEjecucion(dups);
  pruebas.push(prueba('T4', 'Duplicados: qué hace la tabla con dos inserciones de la misma clave y cómo se eliminan al leer', dups.length >= 1 && unicos.length === 1,
    [`filas con la misma clave guardadas: ${dups.length} (${dups.length === 2 ? 'la tabla ADMITE duplicados: hay que deduplicar por idEjecucion' : dups.length === 1 ? 'la tabla RECHAZA o fusiona duplicados' : 'resultado inesperado'})`, `tras deduplicarPorIdEjecucion: ${unicos.length} (se conserva la fila de menor id)`], { duplicadosGuardados: dups.length }));

  // T5 · ejecuciones manuales (valor de $execution.mode por cada vía) y persistencia entre ejecuciones
  const origenFilas = [...origenes.flatMap((ej) => filasDe(ej, 'Leer filas origen')), ...(leer ? filasDe(leer, 'Leer todo').filter((f) => f.caso === 'origen') : [])];
  const valoresOrigen = [...new Set(origenFilas.map((f) => f.origen))].sort();
  const persiste = leer ? filasDe(leer, 'Leer todo').length >= todas.length : null;
  pruebas.push(prueba('T5', 'Ejecuciones manuales: el nodo escribe y `$execution.mode` registra la vía; las filas persisten entre ejecuciones', origenFilas.length > 0 && (persiste === null || persiste),
    [`filas «origen» recuperadas: ${origenFilas.length} · valores de $execution.mode: ${valoresOrigen.join(', ') || '—'}`, persiste === null ? 'persistencia entre ejecuciones: no comprobada (falta el workflow 2)' : `persistencia: ${persiste ? 'las filas escritas siguen ahí en otra ejecución' : 'FALTAN filas'}`], { valoresOrigen, persiste }));

  // T6 · reconstrucción determinista con auditorías insertadas fuera de orden
  const filasRecon = todas.filter((f) => f.caso === 'recon');
  let t6 = { ok: false, detalles: ['no se recuperaron las filas de reconstrucción'] };
  if (filasRecon.length === 3) {
    const insercion = filasRecon.map((f) => f.idEjecucion);
    const esperado = plegarInstantaneas(informesRecon().map((r) => seg.resumirInstantanea(r.informe)));
    const porFecha = reconstruir(filasRecon);
    const barajadas = reconstruir([...filasRecon].reverse().map((f, i) => ({ ...f, id: i + 1 })));
    const ingenuo = plegarInstantaneas(filasRecon.map((f) => JSON.parse(f.payload)));
    const igual = JSON.stringify(porFecha.estado) === JSON.stringify(esperado.estado) && JSON.stringify(barajadas.estado) === JSON.stringify(esperado.estado);
    const fueraDeOrden = JSON.stringify(insercion) === JSON.stringify(ORDEN_INSERCION_RECON);
    const ingenuoDifiere = JSON.stringify(ingenuo.estado) !== JSON.stringify(esperado.estado);
    t6 = { ok: igual && fueraDeOrden, detalles: [`orden de inserción real (por id): ${insercion.join(', ')} ${fueraDeOrden ? '(fuera de orden, como se pretendía)' : '(NO fuera de orden: la prueba no es concluyente)'}`, `reconstrucción por fecha = estado esperado (en orden): ${igual ? 'sí' : 'NO'}`, `pasos por fecha: ${porFecha.pasos.join(' → ')}`, `plegado ingenuo por orden de inserción: ${ingenuo.pasos.join(' → ')} · estado ${ingenuoDifiere ? 'DISTINTO (por eso hay que ordenar por fecha)' : 'igual (no demuestra la necesidad)'}`], ingenuoDifiere };
  }
  pruebas.push(prueba('T6', 'Reconstrucción determinista: dos auditorías que terminan fuera de orden dan el mismo estado que en orden', t6.ok, t6.detalles, { ingenuoDifiere: t6.ingenuoDifiere ?? null }));

  // T7 · referencia a la tabla y typeVersion reales
  const porId = filasDe(escribir, 'Leer por id de tabla');
  const nodosExportados = exportados.flatMap((w) => (Array.isArray(w) ? w : [w]).flatMap((x) => x.nodes ?? [])).filter((n) => n.type === TIPO_NODO);
  const versiones = [...new Set(nodosExportados.map((n) => n.typeVersion))].sort();
  const modos = [...new Set(nodosExportados.map((n) => n.parameters?.dataTableId?.mode).filter(Boolean))].sort();
  pruebas.push(prueba('T7', 'Referencia a la tabla por nombre y por id; typeVersion real del nodo en el JSON exportado', porId.length === todas.length && todas.length > 0,
    [`lectura por id de tabla: ${porId.length} filas (por nombre: ${todas.length})`, nodosExportados.length ? `typeVersion en los workflows exportados de la instancia: ${versiones.join(', ')} · modos de referencia: ${modos.join(', ')}` : 'JSON exportado: no aportado (usa n8n export:workflow)'], { typeVersions: versiones, modosReferencia: modos }));

  const ok = pruebas.every((p) => p.ok);
  return { ok, resumen: pruebas.map((p) => `${p.ok ? '✔' : '✖'} ${p.id} ${p.titulo}`), pruebas };
}

/* ───────────────────────── CLI ───────────────────────── */
function cli() {
  const [orden, ...resto] = process.argv.slice(2);
  const args = { origen: [] };
  for (let i = 0; i < resto.length; i++) if (resto[i].startsWith('--')) { const k = resto[i].slice(2); const v = resto[++i]; if (k === 'origen') args.origen.push(v); else args[k] = v; }
  if (orden === 'generar') {
    if (!args.salida) { console.error('Uso: generar --salida <carpeta fuera del repositorio>'); process.exit(2); }
    const salida = path.resolve(args.salida);
    if (salida.toLowerCase().startsWith(RAIZ.toLowerCase() + path.sep)) { console.error('✖ La salida no puede estar dentro del repositorio.'); process.exit(2); }
    fs.mkdirSync(salida, { recursive: true });
    for (const [f, wf] of Object.entries(generarWorkflows())) { fs.writeFileSync(path.join(salida, f), JSON.stringify(wf, null, 2)); console.log(`escrito ${path.join(salida, f)} (${wf.name})`); }
    return;
  }
  if (orden === 'analizar') {
    if (!args.escribir) { console.error('Uso: analizar --escribir f1.txt [--origen f3.txt ...] [--leer f2.txt] [--exportados carpeta] [--salida informe.json]'); process.exit(2); }
    const leerEj = (f) => extraerEjecucion(fs.readFileSync(path.resolve(f), 'utf8'));
    const exportados = args.exportados ? fs.readdirSync(path.resolve(args.exportados)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(path.resolve(args.exportados), f), 'utf8'))) : [];
    const r = analizarPrueba({ escribir: leerEj(args.escribir), origenes: args.origen.map(leerEj), leer: args.leer ? leerEj(args.leer) : null, exportados });
    for (const p of r.pruebas) { console.log(`${p.ok ? '✔' : '✖'} ${p.id} ${p.titulo}`); for (const d of p.detalles) console.log(`    ${d}`); }
    if (args.salida) fs.writeFileSync(path.resolve(args.salida), JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  console.error('Uso: prueba-data-tables.mjs generar|analizar …');
  process.exit(2);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
