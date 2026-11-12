#!/usr/bin/env node
// PRUEBA DE INTEGRACIÓN REAL de la persistencia de 2c (Auditor General) en un n8n de PRUEBAS aislado (`tai-prueba-dt`): sin HTTP, sin acceso a Treidilor.
// Genera los workflows AUXILIARES de la prueba. El del Auditor es una COPIA del workflow REAL de producción en la que SÓLO los dos nodos HTTP se sustituyen por nodos Code que
// devuelven respuestas SINTÉTICAS con el mismo formato que el nodo HTTP de n8n; el resto (política de URLs, nodo «Informe» con el motor de seguimiento, «Comprobar tabla»,
// «Leer historial», «Solo la fila» y «Guardar instantánea») es EXACTAMENTE el código y los nodos Data table de 2c. Nada de esto se importa en producción.
//
//   node scripts/automation/prueba-persistencia-2c.mjs generar --salida <carpeta fuera del repositorio>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const leerJson = (rel) => JSON.parse(fs.readFileSync(path.join(RAIZ, rel), 'utf8'));
export const TABLA_2C = leerJson('automation/config/produccion.json').seguimiento.tabla;
export const TABLA_AMBIGUA = `${TABLA_2C}_antigua`;
export const PREFIJO = 'PRUEBA 2C · ';

/**
 * Escenarios del sitio SINTÉTICO. `enlaces` = enlaces de la portada; `paginas[ruta]` = { status | timeout | titulo:false }; `todoCaido` = ninguna respuesta.
 * (Las rutas fijas son /, /catalogo, /categorias y /metodologia; los enlaces son /a, /b y /c.)
 */
export const ESCENARIOS = {
  s0: { enlaces: ['/a', '/b', '/c'], paginas: { '/a': { status: 404 }, '/b': { status: 500 }, '/c': { timeout: true }, '/catalogo': { titulo: false } } },
  s1: { enlaces: ['/a', '/b', '/c'], paginas: { '/b': { status: 500 }, '/c': { status: 404 } } },
  s2: { enlaces: ['/a', '/b', '/c'], paginas: { '/a': { status: 404 }, '/c': { status: 404 } } },
  ok: { enlaces: ['/a', '/b', '/c'], paginas: {} },
  parcial: { enlaces: ['/a', '/b', '/c'], paginas: { '/a': { timeout: true }, '/b': { timeout: true }, '/c': { timeout: true } } },
  caida: { todoCaido: true, enlaces: [], paginas: {} },
};

/** Respuestas sintéticas con el formato del nodo HTTP de n8n (respuesta completa, formato texto): { statusCode, headers, data } o { error }. */
function codigoRespuestas() {
  return `const ESCENARIOS = ${JSON.stringify(ESCENARIOS)};
const nombre = $('Escenario').all()[0].json.escenario;
const esc = ESCENARIOS[nombre];
if (!esc) throw new Error('Escenario desconocido: ' + nombre);
const SALUD = { status: 'ok', sourceHash: 'a'.repeat(64), uptimeSeconds: 9000, dataDirExists: true, env: { smtp: true } };
const relleno = 'x'.repeat(2500);
const ruta = (url) => { const i = url.indexOf('/', 8); return i < 0 ? '/' : url.slice(i).split('?')[0]; };
const pagina = (p, enlaces) => '<!doctype html><html><head>' + (p.titulo === false ? '' : '<title>Treidilor</title>') + '</head><body><h1>Titulo</h1>' + enlaces.map((h) => '<a href="' + h + '">l</a>').join('') + '<p>' + relleno + '</p></body></html>';
return $input.all().map((it) => {
  const r = ruta(it.json.url);
  if (esc.todoCaido) return { json: { error: 'connect ECONNREFUSED' } };
  if (r === '/api/health') return { json: { statusCode: 200, headers: { 'content-type': 'application/json' }, data: JSON.stringify(SALUD) } };
  const p = (esc.paginas || {})[r] || {};
  if (p.timeout) return { json: { error: 'timeout of 15000ms exceeded' } };
  if (p.status && p.status !== 200) return { json: { statusCode: p.status, headers: { 'content-type': 'text/html' }, data: p.status >= 500 ? 'error' : '' } };
  return { json: { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, data: pagina(p, r === '/' ? esc.enlaces : []) } };
});`;
}

const nodoCode = (name, jsCode, position) => ({ parameters: { jsCode }, name, type: 'n8n-nodes-base.code', typeVersion: 2, position });
const AJUSTES = { executionOrder: 'v1', timezone: 'Europe/Madrid', saveManualExecutions: true, saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' };
const AVISO = 'PRUEBA 2C (integración real, SOLO en tai-prueba-dt). Datos sintéticos, sin HTTP, sin Treidilor. No importar en producción.';
const cadena = (nombres) => Object.fromEntries(nombres.slice(0, -1).map((n, i) => [n, { main: [[{ node: nombres[i + 1], type: 'main', index: 0 }]] }]));
const manual = { parameters: {}, name: 'Ejecutar a mano', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] };
const nota = (texto) => ({ parameters: { content: `${AVISO}\n${texto}`, height: 140, width: 420 }, name: 'Aviso', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, -260] });

/** Auditor sintético: copia del workflow REAL de producción con los dos nodos HTTP sustituidos por respuestas sintéticas y un nodo «Escenario» inicial. */
export function workflowAuditorSintetico() {
  const real = leerJson('automation/workflows/auditor-general.produccion.json');
  const nodos = real.nodes.map((n) => {
    if (n.type === 'n8n-nodes-base.httpRequest') return nodoCode(n.name, codigoRespuestas(), n.position);
    if (n.type === 'n8n-nodes-base.stickyNote') return nota('Copia del workflow real de producción: sólo los nodos «Pedir …» (HTTP) son sintéticos.');
    return n;
  });
  const escenario = nodoCode('Escenario', "const ESCENARIO = 'ok';\nreturn [{ json: { escenario: ESCENARIO } }];", [130, 200]);
  const conexiones = JSON.parse(JSON.stringify(real.connections));
  conexiones['Ejecutar a mano'] = { main: [[{ node: 'Escenario', type: 'main', index: 0 }]] };
  conexiones.Escenario = { main: [[{ node: 'Objetivos', type: 'main', index: 0 }]] };
  return { name: `${PREFIJO}Auditor sintético (copia del real)`, nodes: [...nodos, escenario], connections: conexiones, active: false, settings: AJUSTES, tags: [] };
}

/** Copia del nodo REAL «Guardar instantánea» (mismos parámetros de Insert) para sembrar filas de prueba. */
function nodoInsertarReal(nombre, posicion) {
  const real = leerJson('automation/workflows/auditor-general.produccion.json').nodes.find((n) => n.name === 'Guardar instantánea');
  return { ...JSON.parse(JSON.stringify(real)), name: nombre, position: posicion };
}

/** Siembra filas EXACTAS (con su `payload`) por el mismo Insert real. Las filas se inyectan por ejecución sustituyendo `const FILAS = [];`. */
export function workflowSembrar() {
  const nodos = [manual, nota('Inserta las filas de la constante FILAS con el Insert real de 2c (para simular duplicados, fechas futuras y auditorías fuera de orden).'),
    nodoCode('Filas', 'const FILAS = [];\nreturn FILAS.map((f) => ({ json: f }));', [260, 0]), nodoInsertarReal('Insertar filas', [520, 0])];
  return { name: `${PREFIJO}sembrar filas`, nodes: nodos, connections: cadena(['Ejecutar a mano', 'Filas', 'Insertar filas']), active: false, settings: AJUSTES, tags: [] };
}

/** Borra las filas de un entorno de la tabla real de 2c (sólo la tabla de esta prueba). */
export function workflowReiniciar() {
  const borrar = { parameters: { resource: 'row', operation: 'deleteRows', dataTableId: { __rl: true, mode: 'name', value: TABLA_2C }, matchType: 'allConditions', filters: { conditions: [{ keyName: 'entorno', condition: 'neq', keyValue: '__ninguno__' }] }, options: { dryRun: false } }, name: 'Borrar filas de la prueba', type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, position: [260, 0] };
  return { name: `${PREFIJO}reiniciar historial`, nodes: [manual, nota(`Borra TODAS las filas de «${TABLA_2C}» (tabla de la prueba 2C; no toca las tablas de T1–T7).`), borrar], connections: cadena(['Ejecutar a mano', 'Borrar filas de la prueba']), active: false, settings: AJUSTES, tags: [] };
}

/** Crea / borra la tabla de nombre AMBIGUO (contiene el nombre de la real) para probar `ambigua`. */
export function workflowTablaAmbigua(operacion) {
  const nodo = operacion === 'crear'
    ? { parameters: { resource: 'table', operation: 'create', tableName: TABLA_AMBIGUA, columns: { column: [{ name: 'entorno', type: 'string' }] }, options: { createIfNotExists: true } }, name: 'Crear tabla ambigua', type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, position: [260, 0] }
    : { parameters: { resource: 'table', operation: 'delete', dataTableId: { __rl: true, mode: 'name', value: TABLA_AMBIGUA } }, name: 'Borrar tabla ambigua', type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, position: [260, 0] };
  return { name: `${PREFIJO}${operacion} tabla ambigua`, nodes: [manual, nota(`${operacion === 'crear' ? 'Crea' : 'Borra'} la tabla «${TABLA_AMBIGUA}» (sólo para la prueba de nombres ambiguos).`), nodo], connections: cadena(['Ejecutar a mano', nodo.name]), active: false, settings: AJUSTES, tags: [] };
}

export function generarWorkflows2c() {
  return {
    '1-auditor-sintetico.json': workflowAuditorSintetico(),
    '2-sembrar-filas.json': workflowSembrar(),
    '3-reiniciar-historial.json': workflowReiniciar(),
    '4-crear-tabla-ambigua.json': workflowTablaAmbigua('crear'),
    '5-borrar-tabla-ambigua.json': workflowTablaAmbigua('borrar'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [orden, flag, salida] = process.argv.slice(2);
  if (orden !== 'generar' || flag !== '--salida' || !salida) { console.error('Uso: prueba-persistencia-2c.mjs generar --salida <carpeta fuera del repositorio>'); process.exit(2); }
  const destino = path.resolve(salida);
  if (destino.toLowerCase().startsWith(RAIZ.toLowerCase() + path.sep)) { console.error('✖ La salida no puede estar dentro del repositorio.'); process.exit(2); }
  fs.mkdirSync(destino, { recursive: true });
  for (const [f, wf] of Object.entries(generarWorkflows2c())) { fs.writeFileSync(path.join(destino, f), JSON.stringify(wf, null, 2)); console.log(`escrito ${path.join(destino, f)} (${wf.name})`); }
}
