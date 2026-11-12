#!/usr/bin/env node
// CONTROLADOR de la validación integral del Auditor General en el entorno aislado `tai-prueba-dt` (preparado; NO ejecutado contra Docker todavía).
// Ejecuta el Auditor LOCAL (`automation/workflows/auditor-general.local.json`, SIN modificar) contra un sitio de pruebas sintético que sólo existe dentro de la red Docker aislada.
//
//   node scripts/automation/prueba-auditor-completo.mjs generar --salida <carpeta fuera del repositorio>   artefactos de la prueba (credencial FICTICIA, copia programada y variantes)
//   node scripts/automation/prueba-auditor-completo.mjs ensayo                                             ensayo en seco con el simulador (sin Docker ni n8n)
//   node scripts/automation/prueba-auditor-completo.mjs comandos                                           comandos exactos del siguiente paso (no los ejecuta)
//   node scripts/automation/prueba-auditor-completo.mjs ejecutar [--fase precondiciones|importar|secuencia|persistencia|programada|todo]   (SÓLO con Docker y autorización)
//
// Todo lo que se comprueba se contrasta con el REGISTRO que lleva el propio sitio de pruebas (lo que realmente pidió el Auditor), no sólo con el informe.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const leerJson = (rel) => JSON.parse(fs.readFileSync(path.join(RAIZ, rel), 'utf8'));
const plano = (x) => JSON.parse(JSON.stringify(x));
const sitio = await import(new URL('../../automation/dev/prueba-data-tables/sitio-prueba.mjs', import.meta.url));
const seg = await import(new URL('../../automation/lib/seguimiento.mjs', import.meta.url));
const { simularWorkflow, crearAlmacenSimulado } = await import(new URL('./simulate-workflow.mjs', import.meta.url));
const { validarEsquema } = await import(new URL('./validate-schema.mjs', import.meta.url));

export const LOCAL = leerJson('automation/config/local.json');
export const TABLA = LOCAL.seguimiento.tabla;
export const PREFIJO = 'PRUEBA 2C · ';
export const UA_ESPERADO = 'TreidilorAI-auditor-general/0.2 (solo lectura)';
/** Token FICTICIO (forma `tai_<16 hex>_<43 caracteres>`): se compone en ejecución para que ningún fichero del repositorio lo contenga. NO es una credencial real. */
export const tokenFicticio = () => ['tai', '0'.repeat(16), 'F'.repeat(43)].join('_');
export const NOMBRE_CREDENCIAL = LOCAL.credencialCatalogo;
export const AUDITOR_LOCAL = () => leerJson('automation/workflows/auditor-general.local.json');

/* ───────────────────────── Artefactos (sólo se generan; no se importan ni activan) ───────────────────────── */
const copia = (wf, nombre) => ({ ...plano(wf), name: `${PREFIJO}${nombre}`, active: false });
const nodoPorNombre = (wf, n) => wf.nodes.find((x) => x.name === n);

/** Copia del Auditor local con un disparador de programación (cada minuto) en lugar del manual. Se activa sólo en el n8n temporal, unos minutos, y se desactiva. */
export function auditorProgramado() {
  const wf = copia(AUDITOR_LOCAL(), 'Auditor local PROGRAMADO (copia)');
  const i = wf.nodes.findIndex((n) => n.type === 'n8n-nodes-base.manualTrigger');
  const antes = wf.nodes[i];
  wf.nodes[i] = { parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } }, name: 'Programación (cada minuto)', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: antes.position };
  wf.connections['Programación (cada minuto)'] = wf.connections[antes.name];
  delete wf.connections[antes.name];
  return wf;
}
/** Variantes de errores de persistencia: sólo cambian el nodo «Guardar instantánea». */
export function variantesPersistencia() {
  const insertFalla = copia(AUDITOR_LOCAL(), 'Auditor local (Insert: validación fallida)');
  nodoPorNombre(insertFalla, 'Guardar instantánea').parameters.columns.value.columna_inexistente = '={{ $json.entorno }}';
  const tablaError = copia(AUDITOR_LOCAL(), 'Auditor local (Insert: tabla inexistente)');
  nodoPorNombre(tablaError, 'Guardar instantánea').parameters.dataTableId = { __rl: true, mode: 'name', value: 'tabla_que_no_existe' };
  return { 'auditor-insert-validacion-falla.json': insertFalla, 'auditor-insert-tabla-inexistente.json': tablaError };
}
/**
 * «Insert sin salida»: el Insert real no se puede forzar a cero salidas, así que se EMULA con un Code que no devuelve nada en el lugar del Insert (misma posición, mismo nombre, sólo la salida
 * correcta conectada). `conFix` añade `alwaysOutputData: true` (la mitigación propuesta, NO aplicada a 2c todavía).
 */
export function auditorInsertSinSalida(conFix) {
  const wf = copia(AUDITOR_LOCAL(), `Auditor local (Insert sin salida${conFix ? ', con alwaysOutputData' : ''}) EMULADO`);
  const i = wf.nodes.findIndex((n) => n.name === 'Guardar instantánea');
  wf.nodes[i] = { parameters: { jsCode: 'return [];' }, name: 'Guardar instantánea', type: 'n8n-nodes-base.code', typeVersion: 2, position: wf.nodes[i].position, ...(conFix ? { alwaysOutputData: true } : {}) };
  wf.connections['Guardar instantánea'] = { main: [[{ node: 'Confirmar escritura', type: 'main', index: 0 }]] };
  return wf;
}
/** Renombrar la tabla de memoria (ida y vuelta) para probar «tabla ausente» dentro del flujo completo. */
export function renombrarTabla(ida) {
  const de = ida ? TABLA : `${TABLA}_renombrada`;
  const a = ida ? `${TABLA}_renombrada` : TABLA;
  const manual = { parameters: {}, name: 'Ejecutar a mano', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] };
  const nodo = { parameters: { resource: 'table', operation: 'update', dataTableId: { __rl: true, mode: 'name', value: de }, newName: a }, name: ida ? 'Renombrar (ida)' : 'Renombrar (vuelta)', type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, position: [260, 0] };
  return { name: `${PREFIJO}renombrar tabla (${ida ? 'ida' : 'vuelta'})`, nodes: [manual, nodo], connections: { 'Ejecutar a mano': { main: [[{ node: nodo.name, type: 'main', index: 0 }]] } }, active: false, settings: { executionOrder: 'v1' }, tags: [] };
}
export function credencialFicticia() {
  return [{ id: 'REEMPLAZAR_AL_IMPORTAR', name: NOMBRE_CREDENCIAL, type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${tokenFicticio()}` } }];
}
export function generarArtefactos() {
  return {
    'credencial-ficticia.json': credencialFicticia(),
    'auditor-programado.json': auditorProgramado(),
    ...variantesPersistencia(),
    'auditor-insert-sin-salida.json': auditorInsertSinSalida(false),
    'auditor-insert-sin-salida-alwaysOutputData.json': auditorInsertSinSalida(true),
    'renombrar-tabla-ida.json': renombrarTabla(true),
    'renombrar-tabla-vuelta.json': renombrarTabla(false),
  };
}

/* ───────────────────────── Verificación del registro del sitio ───────────────────────── */
/**
 * Comprueba, SOBRE EL REGISTRO DEL SITIO (lo que realmente se pidió), que el Auditor respetó su política: sólo GET, ninguna ruta prohibida, cabeceras de identificación en todas las peticiones,
 * el token (ficticio) sólo en el feed del catálogo, una sola vez cada URL, y dentro de los topes configurados.
 */
export function verificarRegistroSitio(registro, cfg = LOCAL) {
  const problemas = [];
  const rutas = registro.map((r) => r.ruta);
  const sinConsulta = (r) => r.ruta.split('?')[0];
  if (registro.some((r) => r.metodo !== 'GET')) problemas.push('hay peticiones que no son GET');
  if (registro.some((r) => r.prohibido)) problemas.push(`rutas prohibidas solicitadas: ${registro.filter((r) => r.prohibido).map((r) => r.ruta).join(', ')}`);
  if (registro.some((r) => r.ua !== UA_ESPERADO || r.agente !== 'auditor-general')) problemas.push('faltan o no coinciden las cabeceras de identificación (User-Agent / X-Treidilor-Agente)');
  const catalogo = registro.filter((r) => sinConsulta(r) === sitio.RUTA_CATALOGO);
  if (catalogo.some((r) => r.auth !== 'ficticia')) problemas.push('una petición del feed del catálogo sin el token (ficticio)');
  // MARCADORES (diseño del Auditor): cuando un nodo HTTP no tiene nada que pedir (sin páginas restantes del catálogo, sin fichas), recibe un elemento «marcador» con la URL de /api/health para que la
  // cadena siga. Es la ÚNICA repetición admitida (como máximo 3 marcadores —sin enlaces, sin páginas restantes del catálogo y sin fichas— + la comprobación de salud) y el marcador del nodo de catálogo lleva el token (ficticio) a /api/health.
  const salud = registro.filter((r) => sinConsulta(r) === sitio.RUTA_SALUD);
  if (salud.length > 4) problemas.push(`/api/health se pidió ${salud.length} veces (máximo 4: salud + 3 marcadores)`);
  if (salud[0] && salud[0].auth !== 'ausente') problemas.push('la comprobación de salud llevó Authorization');
  if (registro.some((r) => sinConsulta(r) !== sitio.RUTA_CATALOGO && sinConsulta(r) !== sitio.RUTA_SALUD && r.auth !== 'ausente')) problemas.push('se envió Authorization fuera del feed del catálogo y de los marcadores');
  const sinSalud = rutas.filter((x) => x.split('?')[0] !== sitio.RUTA_SALUD);
  if (new Set(sinSalud).size !== sinSalud.length) problemas.push('hay URLs repetidas');
  if (registro.length && sinConsulta(registro[0]) !== sitio.RUTA_SALUD) problemas.push('la primera petición no es /api/health');
  const permitido = (r) => { const p = sinConsulta(r); return p === sitio.RUTA_SALUD || p === sitio.RUTA_CATALOGO || sitio.RUTAS_FIJAS.includes(p) || /^\/(guias|marca)\/[A-Za-z0-9_-]+$/.test(p); };
  if (registro.some((r) => !permitido(r))) problemas.push(`URLs fuera de lo esperado: ${registro.filter((r) => !permitido(r)).map((r) => r.ruta).join(', ')}`);
  const enlaces = registro.filter((r) => /^\/(guias|marca)\//.test(sinConsulta(r)));
  if (enlaces.length > cfg.maxEnlaces) problemas.push(`más enlaces que el tope (${enlaces.length} > ${cfg.maxEnlaces})`);
  if (catalogo.length > cfg.maxPaginasCatalogo) problemas.push(`más páginas de catálogo que el tope (${catalogo.length} > ${cfg.maxPaginasCatalogo})`);
  const fijas = registro.filter((r) => sitio.RUTAS_FIJAS.includes(sinConsulta(r)));
  if (fijas.length > sitio.RUTAS_FIJAS.length) problemas.push('rutas fijas repetidas');
  const observaciones = [];
  if (salud.length > 1) observaciones.push(`${salud.length - 1} petición(es) «marcador» a /api/health${salud.slice(1).some((x) => x.auth !== 'ausente') ? ' (una de ellas con el token del catálogo)' : ''}`);
  return { ok: problemas.length === 0, problemas, observaciones, resumen: { total: registro.length, enlaces: enlaces.length, catalogo: catalogo.length, rutas: fijas.length, marcadores: Math.max(0, salud.length - 1) } };
}

/* ───────────────────────── Comprobaciones por escenario (las mismas en el ensayo y en la ejecución real) ───────────────────────── */
export const clavesDe = (informe) => seg.resumirInstantanea(informe).incidencias.map((i) => i.clave).sort();
const incluye = (lista, esperadas) => esperadas.every((c) => lista.includes(c));
const c = (id, ok, detalle = '') => ({ id, ok: Boolean(ok), detalle });

/** Incidencias que SIEMPRE produce cada escenario (claves de seguimiento). */
export const INCIDENCIAS_BASE = ['enlace:roto:/guias/01', 'enlace:roto:/guias/02', 'enlace:sin_respuesta:/guias/03', 'ruta:sin_titulo:/metodologia', 'catalogo:sin_precio', 'catalogo:sin_imagen', 'catalogo:titulos_repetidos'];

export function comprobarEscenario(nombre, r) {
  const { informe: inf, final, registro } = r;
  const s = final.seguimiento;
  const p = final.persistencia;
  const claves = clavesDe(inf);
  const out = [];
  const reg = verificarRegistroSitio(registro);
  out.push(c(`${nombre}:registro`, reg.ok, reg.ok ? `${reg.resumen.total} peticiones (enlaces ${reg.resumen.enlaces}, catálogo ${reg.resumen.catalogo}); ninguna prohibida; cabeceras y token correctos` : reg.problemas.join(' · ')));
  out.push(c(`${nombre}:esquema`, validarEsquema(final, JSON.parse(fs.readFileSync(path.join(RAIZ, 'automation/schemas/informe-auditor.schema.json'), 'utf8'))).length === 0));
  out.push(c(`${nombre}:modo`, inf.modo === 'completo' && inf.entorno === 'local'));
  const e = p.escritura;
  switch (nombre) {
    case 'base':
      out.push(c('base:incidencias', incluye(claves, INCIDENCIAS_BASE), claves.join(', ')));
      out.push(c('base:linea_base', s.modo === 'linea_base' && s.resumen.nuevas === 0 && s.origenReferencia === 'ninguna'));
      out.push(c('base:alcance', inf.alcance.catalogo.completo === true && inf.alcance.sinRespuesta.some((x) => /guias\/03/.test(x.destino) && x.motivo === 'tiempo_agotado') && inf.alcance.resumen.sinRespuesta === 1));
      out.push(c('base:guardada', e.resultado === 'guardada' && Number.isInteger(e.filaId) && p.tabla.estado === 'ok', JSON.stringify(e)));
      break;
    case 'arreglado':
      out.push(c('arreglado:resueltas', incluye(s.resueltas.map((x) => x.clave), INCIDENCIAS_BASE) && s.nuevas.length === 0 && s.persistentes.length === 0, JSON.stringify(s.resumen)));
      out.push(c('arreglado:memoria', s.origenReferencia === 'historial' && e.resultado === 'guardada' && inf.resumen.estado === 'ok', `estado ${inf.resumen.estado}`));
      break;
    case 'mixto':
      out.push(c('mixto:reaparecida', s.reaparecidas.some((x) => x.clave === 'enlace:roto:/guias/01'), JSON.stringify(s.resumen)));
      out.push(c('mixto:nuevas', incluye(s.nuevas.map((x) => x.clave), ['enlace:roto:/marca/a', 'ruta:h1:/catalogo', 'catalogo:descuento_sospechoso'])));
      out.push(c('mixto:guardada', e.resultado === 'guardada'));
      break;
    case 'parcial':
      out.push(c('parcial:calidad', s.calidad.estado === 'parcial' && e.guardar === false && e.resultado === 'no_procede' && e.motivo === 'ejecucion_parcial', JSON.stringify(e)));
      // sólo se resuelve lo que se revisó con evidencia (la ruta y el catálogo sí se leyeron); lo que cayó por conexión cortada queda «no verificado», nunca resuelto
      out.push(c('parcial:sin_resolver', !s.resueltas.some((x) => /guias\/01|marca\/a/.test(x.clave)) && ['enlace:roto:/guias/01', 'enlace:roto:/marca/a'].every((k) => s.noVerificadas.some((x) => x.clave === k)), `resueltas: ${s.resueltas.map((x) => x.clave).join(',')}; no verificadas: ${s.noVerificadas.map((x) => x.clave).join(',')}`));
      break;
    case 'caida':
      // Con el feed del catálogo en juego, una caída total NO se clasifica como «fallida» sino como «parcial» (las peticiones del catálogo no cuentan como errores): se compara y no se guarda.
      out.push(c('caida:no_se_guarda', inf.resumen.estado === 'critico' && e.guardar === false && e.resultado === 'no_procede' && ['ejecucion_fallida', 'ejecucion_parcial'].includes(e.motivo) && s.resueltas.length === 0 && r.registro.every((x) => x.estado === 'conexion_cortada'), `calidad ${s.calidad.estado}; motivo ${e.motivo}; modo ${s.modo}`));
      break;
    case 'catalogo_roto':
      out.push(c('catalogo_roto:incidencia', claves.includes('catalogo:feed_no_disponible') && s.calidad.estado === 'parcial' && e.resultado === 'no_procede', claves.join(', ')));
      break;
    case 'muchos_enlaces':
      out.push(c('muchos_enlaces:tope', reg.resumen.enlaces === LOCAL.maxEnlaces && inf.alcance.resumen.noVisitados === 80 - LOCAL.maxEnlaces && inf.consumo.presupuesto.enlacesOmitidosPorTope === 80 - LOCAL.maxEnlaces, `visitados ${reg.resumen.enlaces}; no visitados ${inf.alcance.resumen.noVisitados}`));
      break;
    default:
      throw new Error(`escenario sin comprobaciones: ${nombre}`);
  }
  return out;
}

/* ───────────────────────── Ensayo en seco con el simulador (sin Docker ni n8n) ───────────────────────── */
const T0 = Date.parse('2026-11-10T08:00:00.000Z');
const dia = (n) => new Date(T0 + n * 86400000).toISOString();

/** `fetchSimulado` que atiende las peticiones del Auditor con el núcleo puro del sitio de pruebas (mismas cabeceras que los nodos HTTP del workflow; el token ficticio sólo en los nodos con credencial). */
export function crearFetchSimulado(wf, estado) {
  const cabeceras = (nombreNodo) => Object.fromEntries((wf.nodes.find((n) => n.name === nombreNodo)?.parameters?.headerParameters?.parameters ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  return ({ url, credencial, nodo }) => {
    const ruta = url.replace(/^https?:\/\/[^/]+/, '') || '/';
    const r = sitio.procesar({ metodo: 'GET', url: ruta, cabeceras: { ...cabeceras(nodo), ...(credencial ? { authorization: `Bearer ${tokenFicticio()}` } : {}) } }, estado);
    if (r.destruir) throw new Error('socket hang up ECONNRESET');
    if (r.retardoMs >= 15000) throw new Error('timeout of 15000ms exceeded');
    return { statusCode: r.estado, headers: r.cabeceras, body: r.cuerpo };
  };
}

/**
 * Candidato de mitigación para «Insert sin salida» (NO aplicado a 2c): el mismo workflow con `alwaysOutputData: true` en «Guardar instantánea». Si el Insert no emite nada, emite un elemento vacío y
 * «Confirmar escritura» se ejecuta (y marca la escritura como fallida en lugar de dejarla «pendiente»).
 */
export function conAlwaysOutputData(wf) {
  const v = plano(wf);
  nodoPorNombre(v, 'Guardar instantánea').alwaysOutputData = true;
  return v;
}

/** Ejecuta el Auditor local, SIN modificar, contra el sitio de pruebas (su núcleo puro), con memoria en un almacén en memoria. */
export function ensayoEnSimulador({ secuencia = ['base', 'arreglado', 'mixto', 'parcial', 'caida', 'catalogo_roto', 'muchos_enlaces'], modos = {} } = {}) {
  const wf = AUDITOR_LOCAL();
  const estado = sitio.crearEstado('base');
  const almacen = crearAlmacenSimulado([TABLA]);
  const resultados = [];
  secuencia.forEach((nombre, i) => {
    estado.escenario = nombre;
    estado.registro.length = 0;
    const fetchSimulado = crearFetchSimulado(wf, estado);
    const sim = simularWorkflow(wf, { fetchSimulado, ahora: dia(i), hostsPermitidos: LOCAL.hostsPermitidos, almacen, ejecucion: { mode: modos[nombre] ?? 'test', id: `${i + 1}` } });
    const informe = plano(sim.salida)[0].json;
    const confirmado = sim.salidas.get('Confirmar escritura');
    const final = plano(confirmado?.[0]?.json ?? informe);
    const r = { nombre, informe, final, registro: plano(estado.registro), peticiones: sim.peticiones.length };
    r.comprobaciones = comprobarEscenario(nombre, r);
    resultados.push(r);
  });
  return { resultados, almacen, ok: resultados.every((r) => r.comprobaciones.every((x) => x.ok)) };
}

/* ───────────────────────── Comandos del siguiente paso (no se ejecutan) ───────────────────────── */
export function comandosPaso2() {
  const env = 'D:\\treidilor-pruebas\\prueba-dt\\.env.prueba-dt';
  const base = 'automation/dev/prueba-data-tables';
  const compose = `docker compose -p tai-prueba-dt --env-file ${env} -f ${base}/docker-compose.yml -f ${base}/docker-compose.validacion.yml`;
  return [
    ['0. Validar la configuración (sin crear nada)', `${compose} config --quiet`],
    ['1. Aplicar la variante (recrea tai-dt-n8n, arranca tai-dt-sitio; sin descargas)', `${compose} up -d --pull never`],
    ['2. Esperar a n8n', "docker inspect -f '{{.State.Health.Status}}' tai-dt-n8n"],
    ['3. Aislamiento: la red sigue siendo interna', "docker network inspect tai-dt-aislada -f '{{.Internal}}'   # debe decir true"],
    ['3b. Aislamiento: sin salida a Internet ni a producción (deben FALLAR)', 'docker exec tai-dt-n8n wget -T 3 -qO- http://1.1.1.1 ; docker exec tai-dt-n8n wget -T 3 -qO- http://treidilor.com ; docker exec tai-dt-n8n wget -T 3 -qO- http://host.docker.internal'],
    ['3c. El sitio de pruebas sí es alcanzable desde n8n', 'docker exec tai-dt-n8n wget -T 5 -qO- http://puente-treidilor:4350/api/health'],
    ['3d. Sin puertos nuevos publicados', "docker ps --format '{{.Names}}  {{.Ports}}'   # sólo 127.0.0.1:5689 en tai-dt-puente-entrada; tai-dt-sitio sin puertos"],
    ['4. Generar artefactos FUERA del repositorio', 'node scripts/automation/prueba-auditor-completo.mjs generar --salida D:\\treidilor-pruebas\\prueba-dt\\auditor-completo'],
    ['5. Importar credencial ficticia y workflows (el Auditor local se importa SIN modificar)', 'node scripts/automation/prueba-auditor-completo.mjs ejecutar --fase importar'],
    ['6. Precondiciones + secuencia de auditorías (base, arreglado, mixto, parcial, caída, catálogo roto, muchos enlaces)', 'node scripts/automation/prueba-auditor-completo.mjs ejecutar --fase precondiciones ; node scripts/automation/prueba-auditor-completo.mjs ejecutar --fase secuencia'],
    ['7. Errores de persistencia dentro del flujo completo', 'node scripts/automation/prueba-auditor-completo.mjs ejecutar --fase persistencia'],
    ['8. Ejecución programada (activa la copia unos minutos y la desactiva)', 'node scripts/automation/prueba-auditor-completo.mjs ejecutar --fase programada'],
    ['9. Volver a comprobar el aislamiento y T1–T7 (sólo huella)', 'node scripts/automation/prueba-auditor-completo.mjs ejecutar --fase precondiciones'],
  ];
}

/* ───────────────────────── Ejecución REAL (Docker + n8n del entorno temporal; sólo con autorización) ───────────────────────── */
const D = 'D:/treidilor-pruebas/prueba-dt';
const BASE_N8N = 'http://127.0.0.1:5689';
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
const controlSitio = (...a) => docker('exec', 'tai-dt-sitio', 'node', '/app/sitio-prueba.mjs', '--control', ...a).trim();
const psql = (sql) => docker('exec', 'tai-dt-db', 'psql', '-U', 'n8n_prueba', '-d', 'n8n_prueba', '-tA', '-c', sql).trim();

function desaplanar(texto) {
  const arr = JSON.parse(texto); const memo = new Map();
  const res = (i) => { if (memo.has(i)) return memo.get(i); const v = arr[i]; if (v === null || typeof v !== 'object') return v; const out = Array.isArray(v) ? [] : {}; memo.set(i, out); for (const k of Object.keys(v)) { const x = v[k]; out[k] = typeof x === 'string' ? res(Number(x)) : x; } return out; };
  return res(0);
}
async function cliente() {
  const dueno = JSON.parse(fs.readFileSync(`${D}/.owner-prueba-dt`, 'utf8'));
  let cookie = '';
  const r = await fetch(`${BASE_N8N}/rest/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emailOrLdapLoginId: dueno.email, password: dueno.password }) });
  cookie = (r.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
  if (r.status !== 200 || !cookie) throw new Error('no se pudo iniciar sesión en el n8n temporal');
  return async (ruta, op = {}) => { const x = await fetch(`${BASE_N8N}${ruta}`, { ...op, headers: { cookie, 'content-type': 'application/json', 'browser-id': 'prueba-auditor-completo', ...(op.headers ?? {}) } }); const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch { /* no JSON */ } return { status: x.status, json: j, texto: t }; };
}
async function esperar(api, execId, maxS = 240) {
  for (let i = 0; i < maxS * 2; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const e = (await api(`/rest/executions/${execId}`)).json?.data;
    if (e && (e.finished || ['success', 'error', 'crashed'].includes(e.status))) { const d = typeof e.data === 'string' ? desaplanar(e.data) : e.data; return { id: execId, status: e.status, mode: e.mode, runData: d.resultData.runData ?? {} }; }
  }
  throw new Error('la ejecución no terminó');
}
const salidaNodo = (ej, nodo) => ((ej.runData[nodo]?.[0]?.data?.main?.[0]) ?? []).map((i) => i.json);

export async function ejecutarReal(fase = 'todo') {
  const cs = [];
  const check = (id, ok, detalle = '') => { cs.push({ id, ok: Boolean(ok), detalle }); console.log(`${ok ? '✔' : '✖'} ${id}${detalle ? ` — ${detalle}` : ''}`); return ok; };
  const quiere = (f) => fase === 'todo' || fase === f;
  if (quiere('precondiciones')) {
    check('aislamiento:red_interna', docker('network', 'inspect', 'tai-dt-aislada', '-f', '{{.Internal}}').trim() === 'true');
    for (const u of ['http://1.1.1.1', 'http://treidilor.com', 'http://host.docker.internal']) { let sale = true; try { docker('exec', 'tai-dt-n8n', 'wget', '-T', '3', '-qO-', u); } catch { sale = false; } check(`aislamiento:sin_salida ${u}`, !sale); }
    check('sitio:alcanzable_desde_n8n', /"status":"ok"/.test(docker('exec', 'tai-dt-n8n', 'wget', '-T', '5', '-qO-', 'http://puente-treidilor:4350/api/health')));
    check('aislamiento:sin_puertos_nuevos', !/tai-dt-sitio\s+.*->/.test(docker('ps', '--format', '{{.Names}}  {{.Ports}}')));
  }
  if (quiere('importar')) {
    docker('exec', 'tai-dt-n8n', 'rm', '-rf', '/tmp/ac'); docker('exec', 'tai-dt-n8n', 'mkdir', '-p', '/tmp/ac/wf');
    fs.copyFileSync(path.join(RAIZ, 'automation/workflows/auditor-general.local.json'), `${D}/auditor-completo/auditor-general.local.json`);
    docker('cp', `${D}/auditor-completo/credencial-ficticia.json`, 'tai-dt-n8n:/tmp/ac/credencial.json');
    for (const f of fs.readdirSync(`${D}/auditor-completo`).filter((x) => x.endsWith('.json') && x !== 'credencial-ficticia.json')) docker('cp', `${D}/auditor-completo/${f}`, `tai-dt-n8n:/tmp/ac/wf/${f}`);
    console.log(docker('exec', 'tai-dt-n8n', 'n8n', 'import:credentials', '--input=/tmp/ac/credencial.json').split('\n').filter((l) => /Success|Error/i.test(l)).join(' | '));
    console.log(docker('exec', 'tai-dt-n8n', 'n8n', 'import:workflow', '--separate', '--input=/tmp/ac/wf').split('\n').filter((l) => /Success|Error/i.test(l)).join(' | '));
  }
  const api = await cliente();
  const idDe = (parte) => { const m = docker('exec', 'tai-dt-n8n', 'n8n', 'list:workflow').split('\n').map((l) => l.split('|')).filter((p) => p.length === 2 && p[1].includes(parte)); if (m.length !== 1) throw new Error(`workflow «${parte}»: ${m.length}`); return m[0][0].trim(); };
  const correr = async (idWf) => { const run = await api(`/rest/workflows/${idWf}/run`, { method: 'POST', body: JSON.stringify({ triggerToStartFrom: { name: 'Ejecutar a mano' } }) }); if (run.status !== 200) throw new Error(`run ${run.status} ${run.texto.slice(0, 160)}`); return esperar(api, run.json.data.executionId); };
  const auditar = async (idWf, escenario) => {
    controlSitio('escenario', escenario); controlSitio('reiniciar');
    const t0 = Date.now(); const ej = await correr(idWf);
    const registro = JSON.parse(controlSitio('registro'));
    const informe = salidaNodo(ej, 'Informe')[0]; const final = salidaNodo(ej, 'Confirmar escritura')[0] ?? informe;
    return { nombre: escenario, ej, informe, final, registro, ms: Date.now() - t0 };
  };
  if (quiere('secuencia')) {
    const id = idDe('Auditor General v0 (local)');
    for (const esc of ['base', 'arreglado', 'mixto', 'parcial', 'caida', 'catalogo_roto', 'muchos_enlaces']) {
      const r = await auditar(id, esc);
      check(`${esc}:ejecucion`, r.ej.status === 'success' && r.ej.mode === 'manual', `estado=${r.ej.status} modo=${r.ej.mode} ${r.ms} ms`);
      if (r.informe) for (const x of comprobarEscenario(esc, r)) check(x.id, x.ok, x.detalle);
      else check(`${esc}:informe`, false, 'sin informe');
    }
  }
  if (quiere('persistencia')) console.log('(fase persistencia: ver el procedimiento; se ejecuta con las variantes importadas: validación fallida, tabla inexistente, tabla renombrada e Insert sin salida con y sin alwaysOutputData)');
  if (quiere('programada')) console.log('(fase programada: activar «Auditor local PROGRAMADO (copia)», esperar 2–3 ejecuciones, comprobar $execution.mode y origen, DESACTIVAR y verificar active=false)');
  const fallos = cs.filter((x) => !x.ok);
  console.log(`\nRESUMEN: ${cs.length - fallos.length}/${cs.length} comprobaciones correctas${fallos.length ? ` · FALLAN: ${fallos.map((f) => f.id).join(', ')}` : ''}`);
  return { cs, ok: fallos.length === 0 };
}

/* ───────────────────────── CLI ───────────────────────── */
async function cli() {
  const [orden, ...resto] = process.argv.slice(2);
  const opc = {};
  for (let i = 0; i < resto.length; i++) if (resto[i].startsWith('--')) opc[resto[i].slice(2)] = resto[++i];
  if (orden === 'generar') {
    if (!opc.salida) { console.error('Uso: generar --salida <carpeta fuera del repositorio>'); process.exit(2); }
    const destino = path.resolve(opc.salida);
    if (destino.toLowerCase().startsWith(RAIZ.toLowerCase() + path.sep)) { console.error('✖ La salida no puede estar dentro del repositorio (la credencial ficticia no debe llegar a git).'); process.exit(2); }
    fs.mkdirSync(destino, { recursive: true });
    for (const [f, x] of Object.entries(generarArtefactos())) { fs.writeFileSync(path.join(destino, f), JSON.stringify(x, null, 2), { mode: 0o600 }); console.log(`escrito ${path.join(destino, f)}`); }
    return;
  }
  if (orden === 'ensayo') {
    const r = ensayoEnSimulador();
    for (const x of r.resultados) for (const k of x.comprobaciones) console.log(`${k.ok ? '✔' : '✖'} ${k.id}${k.detalle ? ` — ${String(k.detalle).slice(0, 160)}` : ''}`);
    console.log(r.ok ? '\nENSAYO CORRECTO' : '\nENSAYO CON FALLOS');
    process.exit(r.ok ? 0 : 1);
  }
  if (orden === 'comandos') { for (const [t, cmd] of comandosPaso2()) console.log(`# ${t}\n${cmd}\n`); return; }
  if (orden === 'ejecutar') { const r = await ejecutarReal(opc.fase ?? 'todo'); process.exit(r.ok ? 0 : 1); }
  console.error('Uso: prueba-auditor-completo.mjs generar|ensayo|comandos|ejecutar');
  process.exit(2);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
