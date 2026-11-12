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

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB = path.join(RAIZ, 'automation', 'lib');
const CONFIG = path.join(RAIZ, 'automation', 'config');
const SALIDA = path.join(RAIZ, 'automation', 'workflows');

/** Módulos que se incrustan, en orden de dependencia. */
const ORDEN = { auditor: ['common', 'urlPolicy', 'auditor'], investigador: ['common', 'urlPolicy', 'auditor', 'researcher'] };

/** Lee un módulo de `automation/lib` y le quita `import` y `export` para poder concatenarlo dentro de un nodo Code. */
export function fuenteModulo(nombre, lib = LIB) {
  const texto = fs.readFileSync(path.join(lib, `${nombre}.mjs`), 'utf8').replace(/\r\n/g, '\n');
  return texto
    .replace(/^import\s+[^;]*?from\s+'\.\/[A-Za-z]+\.mjs';\s*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, '')
    .trim();
}

export function empaquetar(agente, lib = LIB) {
  return ORDEN[agente].map((m) => `// ── ${m}.mjs ──\n${fuenteModulo(m, lib)}`).join('\n\n');
}

const leerConfig = (entorno) => JSON.parse(fs.readFileSync(path.join(CONFIG, `${entorno}.json`), 'utf8'));

const AYUDA = "const nodo = (n) => { try { return $(n).all().map((i) => i.json); } catch (e) { return []; } };\nconst items = (lista) => lista.map((t) => ({ json: t }));";

function codigo(agente, cfg, adaptador) {
  return `${empaquetar(agente)}\n\n// ── adaptador del nodo ──\nconst CONFIG = ${JSON.stringify(cfg, null, 2)};\n${AYUDA}\n${adaptador}\n`;
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
      headerParameters: { parameters: [{ name: 'User-Agent', value: `TreidilorAI-${agente}/0.1 (solo lectura)` }, { name: 'X-Treidilor-Agente', value: agente }] },
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
    pasos.push(['Fichas de muestra', "const cat = leerCatalogo(nodo('Páginas de catálogo'), nodo('Pedir catálogo'));\nreturn items(crearObjetivosFichas(cat.productos, CONFIG));"]);
    pasos.push(['Pedir fichas', null]);
  }
  const lecturas = completo
    ? "objetivosCatalogo: nodo('Páginas de catálogo'), respuestasCatalogo: nodo('Pedir catálogo'), objetivosFichas: nodo('Fichas de muestra'), respuestasFichas: nodo('Pedir fichas'),"
    : '';
  pasos.push(['Informe', `const informe = construirInformeAuditor({\n  cfg: CONFIG,\n  objetivosRutas: nodo('Objetivos'), respuestasRutas: nodo('Pedir rutas'),\n  objetivosEnlaces: nodo('Enlaces a revisar'), respuestasEnlaces: nodo('Pedir enlaces'),\n  ${lecturas}\n  ahoraIso: new Date().toISOString(),\n});\nreturn [{ json: informe }];`]);
  const nombre = `Treidilor AI · Auditor General v0 (${entorno})`;
  const nodos = [nodoManual([0, 0]), nota(`${AVISO_BASE}\nEntorno: ${entorno} · modo: ${cfg.modo}.${completo ? '\nCredencial necesaria (sólo lectura): «' + cfg.credencialCatalogo + '» (Header Auth).' : '\nSin credenciales.'}`, [0, -300])];
  pasos.forEach(([n, js, cred], i) => {
    const pos = [260 * (i + 1), 0];
    nodos.push(js === null ? nodoHttp(n, 'auditor-general', pos, cred ?? null) : nodoCode(n, codigo('auditor', cfg, js), pos));
  });
  return { name: nombre, nodes: nodos, connections: cadena(['Ejecutar a mano', ...pasos.map((p) => p[0])]), active: false, settings: AJUSTES, tags: [] };
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
    nodoCode('Informe', codigo('investigador', cfg, "const informe = construirInformeInvestigador({ cfg: CONFIG, objetivosCatalogo: nodo('Páginas de catálogo'), respuestasCatalogo: nodo('Pedir catálogo'), ahoraIso: new Date().toISOString() });\nreturn [{ json: informe }];"), [780, 0]),
  ];
  return { name: nombre, nodes: nodos, connections: cadena(['Ejecutar a mano', 'Páginas de catálogo', 'Pedir catálogo', 'Informe']), active: false, settings: AJUSTES, tags: [] };
}

export const FABRICA = {
  'auditor-general.local.json': () => auditor('local'),
  'auditor-general.produccion.json': () => auditor('produccion'),
  'investigador-comercial.local.json': () => investigador('local'),
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
  process.exit(fallos ? 1 : 0);
}
