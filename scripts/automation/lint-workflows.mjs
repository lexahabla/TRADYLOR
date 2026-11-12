#!/usr/bin/env node
// COMPROBADOR DE SEGURIDAD de workflows de n8n (Treidilor AI). Rechaza cualquier workflow que pueda escribir, ejecutar comandos, contener
// secretos o salirse de los límites del piloto de SÓLO LECTURA. Sólo usa módulos de Node.
//
//   node scripts/automation/lint-workflows.mjs [fichero.json | carpeta ...]     (por defecto: automation/workflows)
//   salida 0 = correcto · 1 = hay errores · 2 = uso incorrecto
import fs from 'node:fs';
import path from 'node:path';
import { validarAislamiento } from '../../automation/lib/urlPolicy.mjs';
import { COLUMNAS_INSTANTANEAS } from '../../automation/lib/seguimiento.mjs';

export const TIPOS_PERMITIDOS = new Set([
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.scheduleTrigger', // sólo desactivado
  'n8n-nodes-base.code',
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.stickyNote',
  'n8n-nodes-base.dataTable', // memoria del Auditor (2c): sólo listar tablas, leer filas e insertar filas (y crear la tabla en el workflow de preparación)
]);
const MAX_NODOS = 30;
const MAX_CODE_BYTES = 80_000;
const MAX_WORKFLOW_BYTES = 600_000;

/** Patrones prohibidos en el código de los nodos «Code» (el código del piloto no hace E/S: la red la hacen los nodos HTTP). */
export const PATRONES_CODIGO = [
  [/\brequire\s*\(/, 'require()'],
  [/\bimport\s*\(/, 'import()'],
  [/\bprocess\s*\./, 'process'],
  [/child_process|\bspawn\s*\(|\bexec\s*\(|execSync/, 'ejecución de comandos'],
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\b|\bFunction\s*\(/, 'Function()'],
  [/\$env\b|\$\{?\s*env\./, 'acceso a variables de entorno'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/\bnew\s+URL\b|\bURLSearchParams\b|\bstructuredClone\b/, 'URL/URLSearchParams/structuredClone (no existen en el entorno Code de n8n)'],
  [/XMLHttpRequest|WebSocket|EventSource/, 'red directa'],
  [/\bglobalThis\b|__proto__|constructor\s*\.\s*constructor/, 'escape del entorno'],
  [/\bsetTimeout\b|\bsetInterval\b/, 'temporizadores'],
  [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/, 'bucle infinito'],
  [/\$execution\.(?!mode\b|id\b)|\$workflow\.|\$getWorkflowStaticData|helpers\.httpRequest|\$helpers/, 'API interna de n8n con efectos (sólo se permiten $execution.mode y $execution.id, de lectura)'],
];

const PATRONES_SECRETO = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/, 'cabecera Bearer con valor'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'clave tipo sk-'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/, 'clave Anthropic'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'clave AWS'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'JWT'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'token de Slack'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'token de GitHub'],
  [/TRADYLOR_API_TOKEN/, 'referencia al token general de Treidilor'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'clave privada'],
];
const CLAVES_SENSIBLES = /^(password|passwd|secret|token|apikey|api_key|authorization|client_secret|access_token)$/i;

function recorrer(valor, visita, ruta = '') {
  if (typeof valor === 'string') visita(valor, ruta, undefined);
  else if (Array.isArray(valor)) valor.forEach((v, i) => recorrer(v, visita, `${ruta}[${i}]`));
  else if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) {
      if (typeof v === 'string') visita(v, `${ruta}.${k}`, k);
      else recorrer(v, visita, `${ruta}.${k}`);
    }
  }
}

/**
 * Comprueba un workflow ya parseado. Devuelve { errores:[...], avisos:[...] }.
 * `ctx.nombreArchivo` (p. ej. «auditor-general.produccion.json»): los de producción no pueden llevar credenciales.
 */
export function comprobarWorkflow(wf, ctx = {}) {
  const errores = [];
  const avisos = [];
  const err = (m) => errores.push(m);
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return { errores: ['El workflow debe ser un objeto JSON'], avisos };
  if (JSON.stringify(wf).length > MAX_WORKFLOW_BYTES) err(`El workflow supera ${MAX_WORKFLOW_BYTES} bytes`);
  if (typeof wf.name !== 'string' || !wf.name.trim()) err('Falta «name»');
  if (wf.active !== false) err('«active» debe ser false: los workflows se activan a mano en n8n, nunca desde el repositorio');
  if ('pinData' in wf) err('«pinData» no está permitido (datos de ejemplo/secretos fijados)');
  if (!Array.isArray(wf.nodes) || !wf.nodes.length) {
    err('Faltan «nodes»');
    return { errores, avisos };
  }
  if (wf.nodes.length > MAX_NODOS) err(`Demasiados nodos (${wf.nodes.length} > ${MAX_NODOS})`);
  const settings = wf.settings ?? {};
  if (!(Number(settings.executionTimeout) > 0 && Number(settings.executionTimeout) <= 1800)) err('settings.executionTimeout debe estar entre 1 y 1800 segundos');

  const nombres = new Set();
  const esProduccion = /[.-]produccion\./i.test(ctx.nombreArchivo ?? '') || /producci[oó]n/i.test(String(wf.name ?? ''));
  let hayHttp = false;
  let hayPolitica = false;
  const tablasDt = new Set();
  let tablaConfig = null;
  for (const n of wf.nodes) {
    const etiqueta = `Nodo «${n?.name ?? '?'}»`;
    if (!n || typeof n !== 'object' || typeof n.name !== 'string' || !n.name) { err('Hay un nodo sin nombre'); continue; }
    if (nombres.has(n.name)) err(`${etiqueta}: nombre repetido`);
    nombres.add(n.name);
    if (!TIPOS_PERMITIDOS.has(n.type)) { err(`${etiqueta}: tipo no permitido (${n.type})`); continue; }
    if (n.type === 'n8n-nodes-base.scheduleTrigger' && n.disabled !== true) err(`${etiqueta}: la programación debe ir desactivada (disabled: true)`);
    if (n.credentials && Object.keys(n.credentials).length) {
      if (esProduccion) err(`${etiqueta}: los workflows de producción no pueden referenciar credenciales (v0 sólo lectura pública)`);
      for (const [tipo, c] of Object.entries(n.credentials)) {
        if (tipo !== 'httpHeaderAuth') err(`${etiqueta}: tipo de credencial no permitido (${tipo})`);
        if (!/solo lectura/i.test(String(c?.name ?? ''))) err(`${etiqueta}: la credencial debe llamarse «… (solo lectura)»`);
      }
    }
    if (n.type === 'n8n-nodes-base.code') {
      const js = String(n.parameters?.jsCode ?? '');
      if (!js.trim()) err(`${etiqueta}: código vacío`);
      if (Buffer.byteLength(js) > MAX_CODE_BYTES) err(`${etiqueta}: código demasiado grande`);
      for (const [re, que] of PATRONES_CODIGO) if (re.test(js)) err(`${etiqueta}: código con ${que}`);
      // AISLAMIENTO (segunda barrera; la primera es la red del Compose): la configuración incrustada debe ser coherente con el tipo de archivo.
      const mc = js.match(/const CONFIG = (\{[\s\S]*?\n\});/);
      if (mc) {
        let cfg = null;
        try { cfg = JSON.parse(mc[1]); } catch { err(`${etiqueta}: CONFIG incrustada ilegible`); }
        if (cfg) {
          for (const e of validarAislamiento(cfg)) err(`${etiqueta}: aislamiento — ${e}`);
          if (esProduccion && cfg.entorno !== 'produccion') err(`${etiqueta}: aislamiento — un workflow de producción debe llevar la configuración de producción`);
          if (!esProduccion && cfg.entorno !== 'local') err(`${etiqueta}: aislamiento — un workflow local debe llevar la configuración local`);
          if (!esProduccion && /treidilor\.com/i.test(JSON.stringify(cfg))) err(`${etiqueta}: aislamiento — un workflow local no puede mencionar treidilor.com`);
          if (cfg.seguimiento && typeof cfg.seguimiento.tabla === 'string') tablaConfig = cfg.seguimiento.tabla;
        }
        if (!/validarAislamiento\(CONFIG\)/.test(js)) err(`${etiqueta}: falta la guardia de aislamiento al inicio del nodo`);
      }
      if (/function\s+evaluarUrl\b/.test(js) && /hostsPermitidos/.test(js)) hayPolitica = true;
    }
    if (n.type === 'n8n-nodes-base.dataTable') {
      const p = n.parameters ?? {};
      const op = `${p.resource}/${p.operation}`;
      const permitidas = new Set(['table/list', 'row/get', 'row/insert']);
      if (/crear-tabla/.test(ctx.nombreArchivo ?? '')) permitidas.add('table/create');
      if (!permitidas.has(op)) err(`${etiqueta}: operación de Data table no permitida (${op}); sólo listar tablas, leer e insertar filas`);
      if (p.resource === 'row') {
        const ref = p.dataTableId;
        if (!ref || ref.__rl !== true || ref.mode !== 'name' || typeof ref.value !== 'string' || !ref.value || ref.value.startsWith('=')) err(`${etiqueta}: la tabla debe referenciarse por NOMBRE fijo (modo «name»), nunca por id, lista ni expresión`);
        else tablasDt.add(ref.value);
      }
      if (p.resource === 'table' && p.operation === 'list' && typeof p.options?.filterName === 'string') tablasDt.add(p.options.filterName);
      if (p.resource === 'table' && p.operation === 'create' && typeof p.tableName === 'string') tablasDt.add(p.tableName);
      if (op === 'row/insert') {
        if (n.retryOnFail === true) err(`${etiqueta}: el Insert no puede reintentar automáticamente (duplicaría filas)`);
        const columnas = Object.keys(p.columns?.value ?? {});
        if (!columnas.length || columnas.some((c) => !COLUMNAS_INSTANTANEAS.includes(c))) err(`${etiqueta}: el Insert sólo puede escribir las columnas del historial (${COLUMNAS_INSTANTANEAS.join(', ')})`);
        if (p.options && p.options.optimizeBulk === true) avisos.push(`${etiqueta}: optimizeBulk no devuelve las filas insertadas`);
      }
    }
    if (n.type === 'n8n-nodes-base.httpRequest') {
      hayHttp = true;
      const p = n.parameters ?? {};
      const metodo = String(p.method ?? 'GET').toUpperCase();
      if (metodo !== 'GET') err(`${etiqueta}: sólo se permiten peticiones GET (hay ${metodo})`);
      if (p.url !== '={{ $json.url }}') err(`${etiqueta}: la URL debe ser exactamente «={{ $json.url }}» (la fija un nodo Code con política de URLs)`);
      if (p.sendBody || p.jsonBody || p.bodyParameters || p.body || p.specifyBody) err(`${etiqueta}: no se permite enviar cuerpo`);
      if (p.authentication && !['none', 'genericCredentialType'].includes(p.authentication)) err(`${etiqueta}: autenticación no permitida (${p.authentication})`);
      if (p.authentication === 'genericCredentialType' && p.genericAuthType !== 'httpHeaderAuth') err(`${etiqueta}: sólo se permite httpHeaderAuth`);
      const o = p.options ?? {};
      if (!(Number(o.timeout) >= 1000 && Number(o.timeout) <= 30000)) err(`${etiqueta}: timeout obligatorio entre 1000 y 30000 ms`);
      const lote = o.batching?.batch ?? {};
      if (!(Number(lote.batchSize) >= 1 && Number(lote.batchSize) <= 2 && Number(lote.batchInterval) >= 500)) err(`${etiqueta}: límite de ritmo obligatorio (≤ 2 peticiones por lote, ≥ 500 ms entre lotes)`);
      if (o.redirect?.redirect?.followRedirects !== false) err(`${etiqueta}: followRedirects debe ser false (no se siguen redirecciones a destinos no controlados)`);
      if (n.retryOnFail && !(Number(n.maxTries) >= 1 && Number(n.maxTries) <= 3)) err(`${etiqueta}: maxTries debe ser ≤ 3`);
      if (n.onError !== 'continueRegularOutput') avisos.push(`${etiqueta}: conviene onError = continueRegularOutput para no perder el informe ante un fallo puntual`);
    }
  }
  if (hayHttp && !hayPolitica) err('Hay nodos HTTP pero ningún nodo Code incluye la política de URLs (evaluarUrl + hostsPermitidos)');
  if (tablaConfig && [...tablasDt].some((x) => x !== tablaConfig)) err(`Los nodos Data table deben usar sólo la tabla de la configuración («${tablaConfig}»)`);

  // Conexiones: nodos existentes, sin ciclos, y cada HTTP debe recibir de un Code (que fija la URL con la política)
  const conexiones = wf.connections ?? {};
  const aristas = [];
  for (const [de, salidas] of Object.entries(conexiones)) {
    if (!nombres.has(de)) err(`Conexión desde un nodo inexistente («${de}»)`);
    for (const rama of Object.values(salidas ?? {})) for (const grupo of rama ?? []) for (const c of grupo ?? []) {
      if (!nombres.has(c.node)) err(`Conexión hacia un nodo inexistente («${c.node}»)`);
      aristas.push([de, c.node]);
    }
  }
  const tipoDe = Object.fromEntries(wf.nodes.map((n) => [n.name, n.type]));
  for (const n of wf.nodes) {
    if (n.type !== 'n8n-nodes-base.httpRequest') continue;
    const entradas = aristas.filter(([, a]) => a === n.name).map(([d]) => d);
    if (n.disabled === true && !entradas.length) continue; // deshabilitado y sin conexiones: no se ejecuta (sirve para validar versiones de nodo al importar)
    if (!entradas.length || entradas.some((d) => tipoDe[d] !== 'n8n-nodes-base.code')) err(`Nodo «${n.name}»: sólo puede recibir datos de nodos Code`);
  }
  for (const n of wf.nodes) {
    if (n.type !== 'n8n-nodes-base.dataTable' || n.parameters?.operation !== 'insert') continue;
    const entradas = aristas.filter(([, a]) => a === n.name).map(([d]) => d);
    if (!entradas.length || entradas.some((d) => tipoDe[d] !== 'n8n-nodes-base.code')) err(`Nodo «${n.name}»: el Insert sólo puede recibir datos de nodos Code (que deciden qué fila se guarda)`);
  }
  const grado = new Map([...nombres].map((x) => [x, 0]));
  for (const [, a] of aristas) grado.set(a, (grado.get(a) ?? 0) + 1);
  const pendientes = [...grado.entries()].filter(([, g]) => g === 0).map(([x]) => x);
  let visitados = 0;
  while (pendientes.length) {
    const x = pendientes.pop();
    visitados++;
    for (const [d, a] of aristas) if (d === x) { grado.set(a, grado.get(a) - 1); if (grado.get(a) === 0) pendientes.push(a); }
  }
  if (visitados < nombres.size) err('Las conexiones contienen un ciclo');

  // Secretos
  recorrer(wf, (valor, ruta, clave) => {
    for (const [re, que] of PATRONES_SECRETO) if (re.test(valor)) { err(`Posible secreto (${que}) en ${ruta || 'raíz'}`); break; }
    if (clave && CLAVES_SENSIBLES.test(clave) && valor.length >= 8 && !valor.startsWith('=')) err(`Valor sensible en la clave «${clave}» (${ruta})`);
  });
  return { errores, avisos };
}

function listarJson(destino) {
  const st = fs.statSync(destino);
  if (st.isFile()) return [destino];
  return fs.readdirSync(destino).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(destino, f));
}

if (process.argv[1]?.endsWith('lint-workflows.mjs')) {
  const destinos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const lista = (destinos.length ? destinos : ['automation/workflows']).flatMap((d) => (fs.existsSync(d) ? listarJson(d) : []));
  if (!lista.length) {
    console.error('No hay workflows que comprobar.');
    process.exit(2);
  }
  let fallos = 0;
  for (const f of lista) {
    let wf;
    try {
      wf = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      console.error(`✖ ${f}: JSON no válido`);
      fallos++;
      continue;
    }
    const { errores, avisos } = comprobarWorkflow(wf, { nombreArchivo: path.basename(f) });
    if (errores.length) {
      fallos++;
      console.error(`✖ ${f}`);
      for (const e of errores) console.error(`   - ${e}`);
    } else console.log(`✔ ${f}`);
    for (const a of avisos) console.log(`   · aviso: ${a}`);
  }
  process.exit(fallos ? 1 : 0);
}
