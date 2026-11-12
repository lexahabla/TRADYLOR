#!/usr/bin/env node
// CONSTRUCTOR de workflows de n8n a partir del código probado de `automation/lib` («workflows como código»).
// El código de los agentes vive en módulos puros con pruebas; este script lo INCRUSTA en los nodos «Code» y escribe el JSON normalizado.
// Así el JSON que se importa a n8n es exactamente el código que han probado las pruebas automáticas.
//
//   node scripts/automation/build-workflows.mjs --write     escribe automation/workflows/*.json
//   node scripts/automation/build-workflows.mjs --check     falla si los JSON no coinciden con lo que se construiría (sincronía)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizarWorkflow, serializar } from './normalize-workflow.mjs';
import { COLUMNAS_INSTANTANEAS } from '../../automation/lib/seguimiento.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB = path.join(RAIZ, 'automation', 'lib');
const CONFIG = path.join(RAIZ, 'automation', 'config');
const SALIDA = path.join(RAIZ, 'automation', 'workflows');

/** Módulos que se incrustan, en orden de dependencia. */
const ORDEN = { auditor: ['common', 'urlPolicy', 'seguimiento', 'auditor'], investigador: ['common', 'urlPolicy', 'seguimiento', 'auditor', 'researcher'], diagnostico: ['common', 'urlPolicy', 'seguimiento', 'auditor', 'diagnostico'] };

/** Lee un módulo de `automation/lib` y le quita `import`, `export` y los comentarios de línea completa (documentación del módulo; no cambian el comportamiento). */
function leerModulo(nombre, lib = LIB) {
  const texto = fs.readFileSync(path.join(lib, `${nombre}.mjs`), 'utf8').replace(/\r\n/g, '\n');
  return texto
    .replace(/^import\s+[^;]*?from\s+'\.\/[A-Za-z]+\.mjs';\s*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*\n?/gm, '')
    .replace(/^[ \t]*\/\/.*\n?/gm, '');
}

/**
 * Sin sangrías, espacios finales ni líneas en blanco (los módulos no tienen plantillas ni cadenas multilínea: hay una prueba que lo comprueba). Cada nodo Code lleva su propia copia
 * de lo que necesita y debe quedar bajo el límite de 80 kB del linter; el código ejecutado es el mismo.
 */
const compactar = (texto) => texto.replace(/^[ \t]+/gm, '').replace(/[ \t]+$/gm, '').replace(/\n{2,}/g, '\n').trim();

export function fuenteModulo(nombre, lib = LIB) {
  return compactar(leerModulo(nombre, lib));
}

/**
 * PODA: de las bibliotecas sólo se incrusta en cada nodo Code lo que ese nodo alcanza. Se parte el paquete en declaraciones de primer nivel (líneas en columna 0 que empiezan por
 * function, const, let o class) y se conservan las que se mencionan, directa o indirectamente, desde el código propio del nodo («raíces»). Es CONSERVADORA: cualquier aparición de un
 * nombre (también dentro de una cadena o como propiedad) cuenta como referencia, de modo que sólo se descarta lo que seguro no se usa.
 */
export function podar(paquete, raices) {
  const re = /^(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|class)\s+([A-Za-z_$][\w$]*))/;
  const bloques = [];
  let actual = { nombre: null, lineas: [] };
  for (const linea of paquete.split('\n')) {
    const m = linea.match(re);
    if (m) { bloques.push(actual); actual = { nombre: m[1] ?? m[2], lineas: [linea] }; } else actual.lineas.push(linea);
  }
  bloques.push(actual);
  const nombres = new Set(bloques.filter((b) => b.nombre).map((b) => b.nombre));
  const mencionados = (texto) => (texto.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((x) => nombres.has(x));
  const vivos = new Set();
  const pila = [...mencionados(raices)];
  while (pila.length) {
    const n = pila.pop();
    if (vivos.has(n)) continue;
    vivos.add(n);
    for (const b of bloques) if (b.nombre === n) pila.push(...mencionados(b.lineas.join('\n')).filter((x) => !vivos.has(x)));
  }
  return bloques.filter((b) => !b.nombre || vivos.has(b.nombre)).map((b) => b.lineas.join('\n')).join('\n');
}

/** Paquete de módulos de un agente. Con `raices` (el código propio del nodo) se poda lo que el nodo no alcanza; sin ellas se incrusta todo. */
export function empaquetar(agente, raices = null, lib = LIB) {
  const crudo = ORDEN[agente].map((m) => leerModulo(m, lib)).join('\n\n');
  return compactar(raices === null ? crudo : podar(crudo, raices));
}

const leerConfig = (entorno) => JSON.parse(fs.readFileSync(path.join(CONFIG, `${entorno}.json`), 'utf8'));

const AYUDA = "const nodo = (n) => { try { return $(n).all().map((i) => i.json); } catch (e) { return []; } };\nconst items = (lista) => lista.map((t) => ({ json: t }));";

function codigo(agente, cfg, adaptador) {
  const guardia = "{ const errAislamiento = validarAislamiento(CONFIG); if (errAislamiento.length) throw new Error('AISLAMIENTO: ' + errAislamiento.join('; ')); }";
  return `${empaquetar(agente, `${guardia}\n${AYUDA}\n${adaptador}`)}\n\n// ── adaptador del nodo ──\nconst CONFIG = ${JSON.stringify(cfg, null, 2)};\n${guardia}\n${AYUDA}\n${adaptador}\n`;
}

const nodoCode = (nombre, js, pos) => ({ parameters: { jsCode: js }, name: nombre, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos });
const nodoManual = (pos) => ({ parameters: {}, name: 'Ejecutar a mano', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: pos });
const nota = (texto, pos) => ({ parameters: { content: texto, height: 220, width: 420 }, name: 'Aviso', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: pos });
function nodoHttp(nombre, agente, pos, credencial) {
  const n = {
    parameters: {
      method: 'GET',
      url: '={{ $json.url }}',
      authentication: credencial ? 'genericCredentialType' : 'none',
      ...(credencial ? { genericAuthType: 'httpHeaderAuth' } : {}),
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'User-Agent', value: `TreidilorAI-${agente}/0.2 (solo lectura)` }, { name: 'X-Treidilor-Agente', value: agente }] },
      options: {
        timeout: 15000,
        redirect: { redirect: { followRedirects: false } },
        batching: { batch: { batchSize: 1, batchInterval: 700 } },
        response: { response: { fullResponse: true, neverError: true, responseFormat: 'text' } },
      },
    },
    name: nombre,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: pos,
    onError: 'continueRegularOutput',
    retryOnFail: false,
  };
  if (credencial) n.credentials = { httpHeaderAuth: { id: 'REEMPLAZAR_AL_IMPORTAR', name: credencial } };
  return n;
}

/**
 * Nodos «Data table» de n8n (memoria del Auditor, entrega 2c). La tabla se referencia SIEMPRE por NOMBRE (nunca por id: los ids son de cada instalación) y sólo se usan tres operaciones:
 * listar tablas (comprobar que la tabla existe y es única), leer filas (Get) e insertar filas (Insert). Nada de update, upsert, borrado ni vaciado.
 */
const TIPO_DT = 'n8n-nodes-base.dataTable';
const VERSION_DT = 1.1;
const refTabla = (nombre) => ({ __rl: true, mode: 'name', value: nombre });
const esquemaDt = COLUMNAS_INSTANTANEAS.map((id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true }));
function nodoDt(nombre, pos, cfg, operacion) {
  const tabla = cfg.seguimiento.tabla;
  const base = { name: nombre, type: TIPO_DT, typeVersion: VERSION_DT, position: pos };
  if (operacion === 'listar') return { parameters: { resource: 'table', operation: 'list', returnAll: true, options: { filterName: tabla } }, ...base, onError: 'continueRegularOutput', alwaysOutputData: true, retryOnFail: false };
  if (operacion === 'leer') {
    return {
      parameters: {
        resource: 'row', operation: 'get', dataTableId: refTabla(tabla), matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'entorno', condition: 'eq', keyValue: cfg.entorno }] },
        returnAll: false, limit: cfg.seguimiento.maxHistorial, orderBy: true, orderByColumn: 'generadoEn', orderByDirection: 'DESC',
      },
      ...base, onError: 'continueRegularOutput', alwaysOutputData: true, retryOnFail: false,
    };
  }
  // insertar: SIN reintentos automáticos (un reintento podría duplicar la fila). Con `continueErrorOutput` los errores de n8n (p. ej. tabla inexistente) salen por la segunda salida;
  // pero la Data table devuelve SIN error el elemento de entrada cuando falla una validación (columna desconocida), así que la escritura sólo se da por buena con la fila devuelta
  // (nodo «Confirmar escritura», que recibe las dos salidas). Un fallo no detiene el informe.
  return {
    parameters: {
      resource: 'row', operation: 'insert', dataTableId: refTabla(tabla),
      columns: { mappingMode: 'defineBelow', value: Object.fromEntries(COLUMNAS_INSTANTANEAS.map((c) => [c, `={{ $json.${c} }}`])), matchingColumns: [], schema: esquemaDt },
      options: {},
    },
    ...base, onError: 'continueErrorOutput', retryOnFail: false,
  };
}

function cadena(nombres) {
  const c = {};
  nombres.slice(0, -1).forEach((n, i) => { c[n] = { main: [[{ node: nombres[i + 1], type: 'main', index: 0 }]] }; });
  return c;
}

const AJUSTES = { executionOrder: 'v1', timezone: 'Europe/Madrid', executionTimeout: 900, saveManualExecutions: true, saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' };

const AVISO_BASE = 'TREIDILOR AI · SÓLO LECTURA.\nEste workflow NO escribe en Treidilor: sólo hace peticiones GET a URLs que fija el código con la política de URLs (nunca salida de afiliado, API de escritura, panel ni fichas en producción).\nSe genera desde automation/lib con scripts/automation/build-workflows.mjs: no se edita a mano.\nSe activa/programa SÓLO a mano y con autorización.';

function auditor(entorno) {
  const cfg = leerConfig(entorno);
  const completo = cfg.modo === 'completo';
  const pasos = [
    ['Objetivos', 'return items(crearObjetivosRutas(CONFIG));'],
    ['Pedir rutas', null],
    ['Enlaces a revisar', "return items(crearObjetivosEnlaces(nodo('Objetivos'), nodo('Pedir rutas'), CONFIG));"],
    ['Pedir enlaces', null],
  ];
  if (completo) {
    pasos.push(['Páginas de catálogo', 'return items(crearObjetivosCatalogo(CONFIG));']);
    pasos.push(['Pedir catálogo', null, cfg.credencialCatalogo]);
    pasos.push(['Páginas restantes', "return items(crearObjetivosCatalogoResto(nodo('Páginas de catálogo'), nodo('Pedir catálogo'), CONFIG));"]);
    pasos.push(['Pedir catálogo (resto)', null, cfg.credencialCatalogo]);
    pasos.push(['Fichas de muestra', "const cat = leerCatalogo([...nodo('Páginas de catálogo'), ...nodo('Páginas restantes')], [...nodo('Pedir catálogo'), ...nodo('Pedir catálogo (resto)')]);\nreturn items(crearObjetivosFichas(cat.productos, CONFIG));"]);
    pasos.push(['Pedir fichas', null]);
  }
  const lecturas = completo
    ? "objetivosCatalogo: nodo('Páginas de catálogo'), respuestasCatalogo: nodo('Pedir catálogo'), objetivosCatalogoResto: nodo('Páginas restantes'), respuestasCatalogoResto: nodo('Pedir catálogo (resto)'), objetivosFichas: nodo('Fichas de muestra'), respuestasFichas: nodo('Pedir fichas'),"
    : '';
  // Memoria (2c): comprobar la tabla → un solo elemento → leer el historial → Informe → quedarse sólo con la fila a guardar → insertarla.
  // «Uno tabla»: List se ejecuta UNA VEZ POR CADA elemento de entrada (la entrada son las respuestas de todos los enlaces): sin este Code devolvería la tabla repetida N veces.
  pasos.push(['Uno tabla', 'return [{ json: {} }];', undefined, 'pequeno']);
  pasos.push(['Comprobar tabla', null, undefined, 'dt-listar']);
  pasos.push(['Uno historial', 'return [{ json: {} }];', undefined, 'pequeno']);
  pasos.push(['Leer historial', null, undefined, 'dt-leer']);
  pasos.push(['Informe', `const resultado = construirInformeYFila({
  cfg: CONFIG,
  objetivosRutas: nodo('Objetivos'), respuestasRutas: nodo('Pedir rutas'),
  objetivosEnlaces: nodo('Enlaces a revisar'), respuestasEnlaces: nodo('Pedir enlaces'),
  ${lecturas}
  ahoraIso: new Date().toISOString(),
  persistencia: { tablas: nodo('Comprobar tabla'), historial: nodo('Leer historial'), idEjecucion: 'ex-' + String($execution.id), origen: origenDeModo($execution.mode) },
});
return [{ json: resultado.informe }].concat(resultado.fila ? [{ json: Object.assign({ tipo: 'fila' }, resultado.fila) }] : []);`]);
  pasos.push(['Solo la fila', "return $input.all().filter((i) => i.json.tipo === 'fila');", undefined, 'pequeno']);
  pasos.push(['Guardar instantánea', null, undefined, 'dt-insertar']);
  // Confirmar escritura: recibe las DOS salidas del Insert (correcta y de error) y completa el informe con el resultado real de la escritura.
  pasos.push(['Confirmar escritura', "const informe = nodo('Informe')[0];\nreturn [{ json: confirmarEscritura(informe, $input.all().map((i) => i.json)) }];"]);
  const nombre = `Treidilor AI · Auditor General v0 (${entorno})`;
  const nodos = [nodoManual([0, 0]), nota(`${AVISO_BASE}\nEntorno: ${entorno} · modo: ${cfg.modo}.${completo ? '\nCredencial necesaria (sólo lectura): «' + cfg.credencialCatalogo + '» (Header Auth).' : '\nSin credenciales.'}\nMEMORIA: lee e inserta instantáneas en la Data Table «${cfg.seguimiento.tabla}» de n8n (créala antes con el workflow «Auditor · crear tabla de instantáneas»). No escribe en Treidilor.`, [0, -300])];
  pasos.forEach(([n, js, cred, tipo], i) => {
    const pos = [260 * (i + 1), 0];
    if (tipo === 'dt-listar') nodos.push(nodoDt(n, pos, cfg, 'listar'));
    else if (tipo === 'dt-leer') nodos.push(nodoDt(n, pos, cfg, 'leer'));
    else if (tipo === 'dt-insertar') nodos.push(nodoDt(n, pos, cfg, 'insertar'));
    else if (tipo === 'pequeno') nodos.push(nodoCode(n, js, pos));
    else nodos.push(js === null ? nodoHttp(n, 'auditor-general', pos, cred ?? null) : nodoCode(n, codigo('auditor', cfg, js), pos));
  });
  const conexiones = cadena(['Ejecutar a mano', ...pasos.map((p) => p[0])]);
  conexiones['Guardar instantánea'] = { main: [[{ node: 'Confirmar escritura', type: 'main', index: 0 }], [{ node: 'Confirmar escritura', type: 'main', index: 0 }]] };
  return { name: nombre, nodes: nodos, connections: conexiones, active: false, settings: AJUSTES, tags: [] };
}

/** Workflow de PREPARACIÓN (se ejecuta una vez a mano en cada n8n): crea la tabla de instantáneas, con las columnas del historial, si no existe. */
function crearTablaInstantaneas() {
  const cfg = leerConfig('produccion');
  const nodos = [
    nodoManual([0, 0]),
    nota('TREIDILOR AI · PREPARACIÓN de la memoria del Auditor.\nCrea (si no existe) la Data Table «' + cfg.seguimiento.tabla + '» con las columnas del historial de instantáneas.\nSe ejecuta UNA vez a mano en cada instalación de n8n. No hace peticiones, no usa credenciales y no borra nada.', [0, -300]),
    { parameters: { resource: 'table', operation: 'create', tableName: cfg.seguimiento.tabla, columns: { column: COLUMNAS_INSTANTANEAS.map((name) => ({ name, type: 'string' })) }, options: { createIfNotExists: true } }, name: 'Crear tabla de instantáneas', type: TIPO_DT, typeVersion: VERSION_DT, position: [260, 0], retryOnFail: false },
  ];
  return { name: 'Treidilor AI · Auditor · crear tabla de instantáneas', nodes: nodos, connections: cadena(['Ejecutar a mano', 'Crear tabla de instantáneas']), active: false, settings: AJUSTES, tags: [] };
}

function investigador(entorno) {
  const cfg = leerConfig(entorno);
  if (cfg.modo !== 'completo') throw new Error('El investigador necesita el feed del catálogo (modo completo)');
  const nombre = `Treidilor AI · Investigador comercial v0 (${entorno})`;
  const nodos = [
    nodoManual([0, 0]),
    nota(`${AVISO_BASE}\nEntorno: ${entorno}. Credencial necesaria (sólo lectura): «${cfg.credencialCatalogo}» (Header Auth).\nLos descuentos que muestra son los DECLARADOS por la fuente y NO están verificados.`, [0, -300]),
    nodoCode('Páginas de catálogo', codigo('investigador', cfg, 'return items(crearObjetivosCatalogo(CONFIG));'), [260, 0]),
    nodoHttp('Pedir catálogo', 'investigador-comercial', [520, 0], cfg.credencialCatalogo),
    nodoCode('Páginas restantes', codigo('investigador', cfg, "return items(crearObjetivosCatalogoResto(nodo('Páginas de catálogo'), nodo('Pedir catálogo'), CONFIG));"), [780, 0]),
    nodoHttp('Pedir catálogo (resto)', 'investigador-comercial', [1040, 0], cfg.credencialCatalogo),
    nodoCode('Informe', codigo('investigador', cfg, "const informe = construirInformeInvestigador({ cfg: CONFIG, objetivosCatalogo: nodo('Páginas de catálogo'), respuestasCatalogo: nodo('Pedir catálogo'), objetivosCatalogoResto: nodo('Páginas restantes'), respuestasCatalogoResto: nodo('Pedir catálogo (resto)'), ahoraIso: new Date().toISOString() });\nreturn [{ json: informe }];"), [1300, 0]),
  ];
  return { name: nombre, nodes: nodos, connections: cadena(['Ejecutar a mano', 'Páginas de catálogo', 'Pedir catálogo', 'Páginas restantes', 'Pedir catálogo (resto)', 'Informe']), active: false, settings: AJUSTES, tags: [] };
}

/**
 * Diagnóstico previo a importar el Auditor en una instancia de n8n (autocontenido: SIN red ni credenciales). Un nodo Code ejecuta el código real del
 * Auditor con respuestas sintéticas. Incluye un nodo HTTP DESHABILITADO y sin conexiones: no se ejecuta, pero al importar permite ver si esa versión de
 * n8n reconoce los tipos/versiones de nodo que usa el Auditor (un nodo desconocido se muestra con «?»).
 */
function diagnosticoAuditorProduccion() {
  const cfg = leerConfig('produccion');
  const nodos = [
    nodoManual([0, 0]),
    nota('TREIDILOR AI · DIAGNÓSTICO DEL ENTORNO (sin red, sin credenciales).\nEjecuta el código del Auditor con datos sintéticos. NO hace ninguna petición.\nResultado en el nodo «Diagnóstico»: campo «resultado» = OK, y «fallos» vacío.\nEl nodo «Prueba de versión (deshabilitado)» no se ejecuta: sólo comprueba que esta versión de n8n reconoce el nodo HTTP 4.2 (si aparece con «?», NO es compatible).', [0, -300]),
    nodoCode('Diagnóstico', codigo('diagnostico', cfg, 'return [{ json: ejecutarDiagnostico(CONFIG, new Date().toISOString()) }];'), [260, 0]),
    { ...nodoHttp('Prueba de versión (deshabilitado)', 'auditor-general', [260, 260], null), disabled: true },
  ];
  return { name: 'Treidilor AI · Diagnóstico del entorno (Auditor, sin red)', nodes: nodos, connections: cadena(['Ejecutar a mano', 'Diagnóstico']), active: false, settings: AJUSTES, tags: [] };
}

export const DIAGNOSTICOS = { 'diagnostico-auditor-produccion.json': () => diagnosticoAuditorProduccion() };
export const construirDiagnosticos = () => Object.fromEntries(Object.entries(DIAGNOSTICOS).map(([f, fn]) => [f, serializar(normalizarWorkflow(fn()))]));

export const FABRICA = {
  'auditor-general.local.json': () => auditor('local'),
  'auditor-general.produccion.json': () => auditor('produccion'),
  'investigador-comercial.local.json': () => investigador('local'),
  'auditor-instantaneas-crear-tabla.json': () => crearTablaInstantaneas(),
};

export function construirTodo() {
  return Object.fromEntries(Object.entries(FABRICA).map(([f, fn]) => [f, serializar(normalizarWorkflow(fn()))]));
}

if (process.argv[1]?.endsWith('build-workflows.mjs')) {
  const modo = process.argv[2];
  const todo = construirTodo();
  let fallos = 0;
  fs.mkdirSync(SALIDA, { recursive: true });
  for (const [f, texto] of Object.entries(todo)) {
    const destino = path.join(SALIDA, f);
    if (modo === '--write') {
      fs.writeFileSync(destino, texto);
      console.log(`escrito ${path.relative(RAIZ, destino)} (${texto.length} bytes)`);
    } else if (modo === '--check') {
      const actual = fs.existsSync(destino) ? fs.readFileSync(destino, 'utf8').replace(/\r\n/g, '\n') : null; // Git puede convertir saltos de línea al extraer
      if (actual !== texto) { console.error(`✖ ${f}: desincronizado con automation/lib (ejecuta --write)`); fallos++; } else console.log(`✔ ${f}`);
    } else {
      console.error('Uso: build-workflows.mjs --write | --check');
      process.exit(2);
    }
  }
  const SALIDA_DEV = path.join(RAIZ, 'automation', 'dev');
  for (const [f, texto] of Object.entries(construirDiagnosticos())) {
    const destino = path.join(SALIDA_DEV, f);
    if (modo === '--write') {
      fs.writeFileSync(destino, texto);
      console.log(`escrito ${path.relative(RAIZ, destino)} (${texto.length} bytes)`);
    } else {
      const actual = fs.existsSync(destino) ? fs.readFileSync(destino, 'utf8').replace(/\r\n/g, '\n') : null;
      if (actual !== texto) { console.error(`✖ ${f}: desincronizado con automation/lib (ejecuta --write)`); fallos++; } else console.log(`✔ ${f}`);
    }
  }
  process.exit(fallos ? 1 : 0);
}
