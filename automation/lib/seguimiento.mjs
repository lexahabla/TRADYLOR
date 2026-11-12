/**
 * SEGUIMIENTO de incidencias del Auditor General (entrega 2a): MOTOR PURO. Sin red, sin disco, sin reloj, sin variables de entorno, sin persistencia.
 * Compara la auditoría actual con el estado de la anterior y distingue incidencias NUEVAS, PERSISTENTES, RESUELTAS, NO VERIFICADAS y REAPARECIDAS.
 * Está escrito para poder incrustarse más adelante en un nodo «Code» de n8n (sin imports reales ni globales que el entorno Code de n8n no tenga); las funciones
 * son deterministas: el mismo estado y la misma auditoría dan siempre el mismo resultado (el «ahora» es SIEMPRE `generadoEn` de la auditoría).
 *
 * Capas (cada una la puede sustituir/probar por separado):
 *   1. resumirInstantanea(informe)            informe del Auditor → instantánea compacta (claves estables, calidad de la ejecución, alcance)
 *   2. compararConEstado(estado, instantánea) → sección `seguimiento` (sin efectos)
 *   3. siguienteEstado(estado, instantánea, comparación) → estado nuevo + si procede guardarlo + condición de escritura (control de concurrencia)
 *   4. validarEscritura(almacenado, resultado) → comprobación «compare-and-set» que hará la capa de persistencia (no implementada aquí)
 * La PERSISTENCIA (dónde se guarda el estado) queda fuera de este módulo.
 *
 * Reglas de honestidad:
 *  · Una incidencia sólo se declara RESUELTA si el alcance de la auditoría actual demuestra que su objetivo se revisó (con respuesta). Si no, es NO VERIFICADA.
 *  · La primera ejecución (o cualquier reinicio de la referencia) es LÍNEA BASE: no genera incidencias «nuevas».
 *  · Una ejecución FALLIDA no se compara ni se guarda; una PARCIAL se compara pero no sustituye la última referencia válida.
 */
import { ORDEN_GRAVEDAD, bytesUtf8 } from './common.mjs';
import { normalizarUrl } from './urlPolicy.mjs';

export const ESQUEMA_SEGUIMIENTO = 1;

export const LIMITES_SEGUIMIENTO = {
  maxIncidencias: 200, // incidencias que conserva el estado
  maxBytesEstado: 65536, // tamaño máximo del estado serializado (UTF-8)
  maxResueltasRecientes: 30,
  maxAntiguedadDias: 14, // una referencia más antigua se descarta (línea base)
  diasReaparicion: 14, // ventana en la que una incidencia resuelta que vuelve se marca «reaparecida»
  maxEjecucionesSinVerificar: 7, // una incidencia «no verificada» tanto tiempo caduca
  umbralErroresParcial: 0.2, // más de este porcentaje de peticiones sin respuesta ⇒ ejecución parcial
  maxLongitudDestino: 120, // destinos más largos se sustituyen por un hash en la clave (evita colisiones por recorte)
};

const SEG_DIA_MS = 86400000;
const SEG_PARAMETROS_IGNORADOS = /^(utm_[a-z0-9_]+|fbclid|gclid|msclkid|mc_cid|mc_eid|_ga|igshid)$/i;
const SEG_CODIGOS_CONTENIDO = ['sin_titulo', 'h1', 'contenido_minimo', 'error_interno_200'];
const SEG_CODIGOS_ERROR_HTTP = ['error_servidor', 'no_encontrada', 'error_cliente'];

const segLimites = (opciones) => ({ ...LIMITES_SEGUIMIENTO, ...((opciones && opciones.limites) || {}) });
const segCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const segGravedad = (g) => (typeof g === 'string' && Object.prototype.hasOwnProperty.call(ORDEN_GRAVEDAD, g) ? g : 'info');
const segOrdenGravedad = (g) => ORDEN_GRAVEDAD[segGravedad(g)];
const segPorGravedadYClave = (a, b) => segOrdenGravedad(a.gravedad ?? a.gravedadAnterior) - segOrdenGravedad(b.gravedad ?? b.gravedadAnterior) || segCmp(a.clave, b.clave);
const segFechaMs = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(iso) ? Date.parse(iso) : NaN);
const segEsObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const segCantidad = (inc) => (inc && inc.evidencia && Number.isFinite(inc.evidencia.total) ? inc.evidencia.total : null);

/** Hash no criptográfico de 64 bits (dos FNV-1a) en 16 caracteres hexadecimales. Determinista y sin dependencias. */
function segHash(texto) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  const t = String(texto ?? '');
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * Destino NORMALIZADO de una URL o ruta: sin protocolo, host ni fragmento; sin barras repetidas ni final; parámetros ordenados y sin los de seguimiento
 * (utm_*, fbclid, gclid…). Lo que no es una URL ni una ruta (p. ej. el id de un producto) se devuelve tal cual.
 */
export function normalizarDestino(texto) {
  const crudo = String(texto ?? '').trim();
  if (!crudo) return '';
  let ruta;
  let query;
  if (/^https?:\/\//i.test(crudo)) {
    const u = normalizarUrl(crudo, undefined);
    if (!u) return crudo;
    ruta = u.pathname;
    query = String(u.search || '').replace(/^\?/, '');
  } else if (crudo.charAt(0) === '/') {
    const sinFragmento = crudo.split('#')[0];
    const i = sinFragmento.indexOf('?');
    ruta = i >= 0 ? sinFragmento.slice(0, i) : sinFragmento;
    query = i >= 0 ? sinFragmento.slice(i + 1) : '';
  } else {
    return crudo;
  }
  ruta = ruta.replace(/\/{2,}/g, '/');
  if (ruta.length > 1) ruta = ruta.replace(/\/+$/, '');
  if (!ruta) ruta = '/';
  const pares = query.split('&').filter((p) => p && !SEG_PARAMETROS_IGNORADOS.test(p.split('=')[0])).sort(segCmp);
  return pares.length ? `${ruta}?${pares.join('&')}` : ruta;
}

/** Parte de la clave que identifica el destino: el propio destino o, si es largo, su inicio + hash (nunca se recorta a ciegas). */
function segClaveDestino(destino, L = LIMITES_SEGUIMIENTO) {
  return destino.length <= L.maxLongitudDestino ? destino : `${destino.slice(0, 60)}~${segHash(destino)}`;
}

/**
 * Clave ESTABLE de una incidencia: `area:codigo:destino`. No entran la gravedad, el título, el estado HTTP ni los recuentos (cambian sin que el problema cambie).
 * El host no entra en la clave (la referencia lleva el suyo y se comprueba aparte). Si el `id` llegó recortado (200 caracteres) se parte de `evidencia.url`.
 */
export function claveSeguimiento(inc, opciones) {
  const L = segLimites(opciones);
  const id = String((inc && inc.id) ?? '');
  const p = id.split(':');
  const area = String((inc && inc.area) ?? p[0] ?? '');
  const codigo = p[1] ?? '';
  let resto = p.slice(2).join(':');
  if (id.length >= 200 && inc && inc.evidencia && typeof inc.evidencia.url === 'string') resto = inc.evidencia.url;
  const base = `${area}:${codigo}`;
  return resto ? `${base}:${segClaveDestino(normalizarDestino(resto), L)}` : base;
}

/** Separa una clave en área, código y destino. */
function segPartesClave(clave) {
  const i = clave.indexOf(':');
  const j = i >= 0 ? clave.indexOf(':', i + 1) : -1;
  return { area: i >= 0 ? clave.slice(0, i) : clave, codigo: i >= 0 ? (j >= 0 ? clave.slice(i + 1, j) : clave.slice(i + 1)) : '', destino: j >= 0 ? clave.slice(j + 1) : '' };
}

/** Alcance del informe (opcional; lo emitirá el Auditor en la entrega 2b): qué destinos se revisaron CON respuesta. null si falta o no es válido. */
function segNormalizarAlcance(al, L) {
  if (!segEsObjeto(al)) return null;
  const lista = (x) => [...new Set((Array.isArray(x) ? x : []).filter((d) => typeof d === 'string' && d).slice(0, 2000).map((d) => segClaveDestino(normalizarDestino(d), L)))].sort(segCmp);
  const cat = segEsObjeto(al.catalogo) ? al.catalogo : {};
  return {
    host: typeof al.host === 'string' && al.host ? al.host.toLowerCase() : null,
    salud: al.salud === true,
    rutas: lista(al.rutas),
    enlaces: lista(al.enlaces),
    fichas: lista(al.fichas),
    // Rutas y fichas cuyo HTML se analizó entero (título, h1, longitud). Opcional: sin esta lista se aplica la regla anterior (basta con que respondieran).
    contenido: segEsObjeto(al.contenido) ? { rutas: lista(al.contenido.rutas), fichas: lista(al.contenido.fichas) } : null,
    catalogo: { leido: cat.leido === true, completo: cat.completo === true },
  };
}

/** Calidad de la ejecución: completa | parcial | fallida (con los motivos). Los topes voluntarios (p. ej. de enlaces) NO hacen parcial una ejecución. */
function segCalidad(inf, lista, alcance, L) {
  const motivos = [];
  const peticiones = Number.isInteger(inf.resumen && inf.resumen.peticiones) ? inf.resumen.peticiones : null;
  const errores = lista.filter((i) => /^(salud|ruta|enlace|ficha):(sin_respuesta|sin_datos)(:|$)/.test(i.id)).length;
  const saludOk = alcance ? alcance.salud === true : !lista.some((i) => /^salud:(sin_datos|sin_respuesta)(:|$)/.test(i.id));
  const respuestas = peticiones === null ? null : peticiones - errores;
  if (peticiones === 0) motivos.push('sin_peticiones');
  else if (respuestas !== null && respuestas <= 0) motivos.push('sin_respuestas');
  else if (peticiones === null && !saludOk) motivos.push('sin_datos_de_salud');
  if (motivos.length) return { estado: 'fallida', motivos };
  if (!saludOk) motivos.push('sin_datos_de_salud');
  if (lista.some((i) => /^catalogo:(feed_parcial|feed_no_disponible)(:|$)/.test(i.id))) motivos.push('catalogo_no_leido_completo');
  if (peticiones && errores / peticiones > L.umbralErroresParcial) motivos.push('muchas_peticiones_sin_respuesta');
  return { estado: motivos.length ? 'parcial' : 'completa', motivos };
}

/**
 * INSTANTÁNEA compacta de un informe del Auditor (cualquier versión 0.x: los campos que falten se tratan como desconocidos, nunca se inventan).
 * Excluye los avisos del entorno local, deduplica por clave (gravedad máxima, `ocurrencias`) y ordena de forma determinista.
 */
export function resumirInstantanea(informe, opciones) {
  const L = segLimites(opciones);
  const inf = segEsObjeto(informe) ? informe : {};
  const lista = (Array.isArray(inf.incidencias) ? inf.incidencias : []).filter((i) => segEsObjeto(i) && typeof i.id === 'string' && i.ambito !== 'entorno_local');
  const porClave = new Map();
  for (const inc of lista) {
    const clave = claveSeguimiento(inc, opciones);
    const partes = segPartesClave(clave);
    const gravedad = segGravedad(inc.gravedad);
    const cantidad = segCantidad(inc);
    const previo = porClave.get(clave);
    if (!previo) {
      porClave.set(clave, { clave, area: partes.area, codigo: partes.codigo, gravedad, cantidad, ocurrencias: 1 });
    } else {
      previo.ocurrencias += 1;
      if (segOrdenGravedad(gravedad) < segOrdenGravedad(previo.gravedad)) previo.gravedad = gravedad;
      if (cantidad !== null && (previo.cantidad === null || cantidad > previo.cantidad)) previo.cantidad = cantidad;
    }
  }
  const alcance = segNormalizarAlcance(inf.alcance, L);
  const host = typeof (opciones && opciones.host) === 'string' && opciones.host ? opciones.host.toLowerCase() : alcance ? alcance.host : null;
  return {
    esquema: ESQUEMA_SEGUIMIENTO,
    agente: 'auditor-general',
    version: typeof inf.version === 'string' ? inf.version : '',
    entorno: typeof inf.entorno === 'string' ? inf.entorno : '',
    host,
    generadoEn: typeof inf.generadoEn === 'string' ? inf.generadoEn : '',
    calidad: segCalidad(inf, lista, alcance, L),
    alcance,
    incidencias: [...porClave.values()].sort(segPorGravedadYClave),
  };
}

/** ¿El estado almacenado es utilizable? { ok, motivo } con motivo `estado_invalido` o `esquema_incompatible`. */
export function validarEstado(estado) {
  if (!segEsObjeto(estado) || !Number.isInteger(estado.esquema)) return { ok: false, motivo: 'estado_invalido' };
  if (estado.esquema !== ESQUEMA_SEGUIMIENTO) return { ok: false, motivo: 'esquema_incompatible' };
  if (!segEsObjeto(estado.incidencias) || !segEsObjeto(estado.ultimaInstantanea) || Number.isNaN(segFechaMs(estado.ultimaInstantanea.generadoEn))) return { ok: false, motivo: 'estado_invalido' };
  if (typeof estado.entorno !== 'string' || !Number.isInteger(estado.revision) || estado.revision < 0) return { ok: false, motivo: 'estado_invalido' };
  for (const v of Object.values(estado.incidencias)) {
    if (!segEsObjeto(v) || Number.isNaN(segFechaMs(v.primeraVez)) || Number.isNaN(segFechaMs(v.ultimaVez))) return { ok: false, motivo: 'estado_invalido' };
  }
  return { ok: true, motivo: null };
}

/** Construye un estado a partir de UNA instantánea anterior (referencia mínima: sin historial, la incidencia «existe desde» esa auditoría). */
export function estadoDesdeInstantanea(inst, opciones) {
  const L = segLimites(opciones);
  const incidencias = {};
  for (const i of [...(inst.incidencias || [])].sort(segPorGravedadYClave).slice(0, L.maxIncidencias)) {
    incidencias[i.clave] = { area: i.area, codigo: i.codigo, gravedad: i.gravedad, cantidad: i.cantidad ?? null, primeraVez: inst.generadoEn, ultimaVez: inst.generadoEn, consecutivas: 1, sinVerificar: 0 };
  }
  return { esquema: ESQUEMA_SEGUIMIENTO, agente: 'auditor-general', entorno: inst.entorno, host: inst.host ?? null, revision: 0, actualizadoEn: inst.generadoEn, ultimaInstantanea: { generadoEn: inst.generadoEn, version: inst.version, calidad: inst.calidad ? inst.calidad.estado : 'completa', huella: segHash(Object.keys(incidencias).sort(segCmp).join('|')) }, incidencias, resueltasRecientes: [] };
}

/** ¿Está demostrado que el objetivo de esta incidencia se revisó en la auditoría actual? { ok, motivo }. */
function segVerificable(clave, actual, conjuntos, erroresHttp) {
  const al = actual.alcance;
  if (!al) return { ok: false, motivo: 'sin_alcance' };
  const { area, codigo, destino } = segPartesClave(clave);
  if (area === 'salud') return al.salud === true ? { ok: true } : { ok: false, motivo: 'salud_no_leida' };
  if (area === 'catalogo') return al.catalogo.completo === true ? { ok: true } : { ok: false, motivo: 'catalogo_no_leido_completo' };
  const conjunto = conjuntos[area];
  if (!conjunto) return { ok: false, motivo: 'area_desconocida' };
  if (!conjunto.has(destino)) return { ok: false, motivo: 'objetivo_no_revisado' };
  // El contenido (título, h1, longitud) sólo se evalúa si la página responde 200 con HTML: con un error HTTP, una redirección o un cuerpo no analizable no se puede afirmar que se arregló.
  if (SEG_CODIGOS_CONTENIDO.includes(codigo)) {
    if (erroresHttp.has(`${area}:${destino}`)) return { ok: false, motivo: 'pagina_con_error' };
    const analizadas = conjuntos.contenido && conjuntos.contenido[area];
    if (conjuntos.contenido && !(analizadas && analizadas.has(destino))) return { ok: false, motivo: 'analisis_incompleto' };
  }
  return { ok: true };
}

const segCambioGravedad = (actual, anterior) => (segOrdenGravedad(actual) < segOrdenGravedad(anterior) ? 'empeora' : segOrdenGravedad(actual) > segOrdenGravedad(anterior) ? 'mejora' : null);

/**
 * COMPARA la auditoría actual (instantánea) con el estado anterior. No tiene efectos ni guarda nada.
 * `modo`: 'comparacion' | 'linea_base' (sin «nuevas», se guarda como referencia) | 'sin_comparar' (ejecución fallida, orden de fechas inválido o instantánea inválida).
 */
export function compararConEstado(estado, actual, opciones) {
  const L = segLimites(opciones);
  const nActuales = actual && Array.isArray(actual.incidencias) ? actual.incidencias.length : 0;
  const vacio = (modo, motivo) => ({
    esquema: ESQUEMA_SEGUIMIENTO,
    modo,
    motivo,
    comparadoCon: null,
    calidad: actual && actual.calidad ? actual.calidad : null,
    resumen: { actuales: nActuales, nuevas: 0, persistentes: 0, resueltas: 0, noVerificadas: 0, reaparecidas: 0, indeterminadas: 0, caducadas: 0 },
    nuevas: [],
    persistentes: [],
    resueltas: [],
    noVerificadas: [],
    reaparecidas: [],
    indeterminadas: [],
    caducadas: [],
  });
  const genMs = segFechaMs(actual && actual.generadoEn);
  if (!actual || actual.esquema !== ESQUEMA_SEGUIMIENTO || !Array.isArray(actual.incidencias) || Number.isNaN(genMs) || !actual.calidad || typeof actual.calidad.estado !== 'string') return vacio('sin_comparar', 'instantanea_invalida');
  if (actual.calidad.estado === 'fallida') return vacio('sin_comparar', 'ejecucion_fallida');
  if (estado === null || estado === undefined) return vacio('linea_base', 'primera_ejecucion');
  const valido = validarEstado(estado);
  if (!valido.ok) return vacio('linea_base', valido.motivo);
  if (estado.entorno !== actual.entorno) return vacio('linea_base', 'entorno_distinto');
  if (estado.host && actual.host && estado.host !== actual.host) return vacio('linea_base', 'host_distinto');
  const prevMs = segFechaMs(estado.ultimaInstantanea.generadoEn);
  if (genMs <= prevMs) return vacio('sin_comparar', 'orden_invalido');
  if ((genMs - prevMs) / SEG_DIA_MS > L.maxAntiguedadDias) return vacio('linea_base', 'anterior_antiguo');

  const salida = vacio('comparacion', null);
  salida.comparadoCon = estado.ultimaInstantanea.generadoEn;
  const al = actual.alcance;
  const conjuntos = al ? { ruta: new Set(al.rutas), enlace: new Set(al.enlaces), ficha: new Set(al.fichas), contenido: al.contenido ? { ruta: new Set(al.contenido.rutas), ficha: new Set(al.contenido.fichas) } : null } : {};
  // Si el estado anterior se guardó RECORTADO, una incidencia ausente de él pudo haberse omitido: no se puede demostrar que sea nueva.
  const estadoRecortado = Boolean(estado.recortado && estado.recortado.omitidas > 0);
  const erroresHttp = new Set(actual.incidencias.filter((i) => (i.area === 'ruta' || i.area === 'ficha') && SEG_CODIGOS_ERROR_HTTP.includes(i.codigo)).map((i) => `${i.area}:${segPartesClave(i.clave).destino}`));
  const recientes = new Map((Array.isArray(estado.resueltasRecientes) ? estado.resueltasRecientes : []).filter((r) => segEsObjeto(r) && typeof r.clave === 'string').map((r) => [r.clave, r]));
  const vistas = new Set();

  for (const i of actual.incidencias) {
    vistas.add(i.clave);
    const p = estado.incidencias[i.clave];
    const comun = { clave: i.clave, area: i.area, codigo: i.codigo, gravedad: i.gravedad, cantidad: i.cantidad ?? null };
    if (p) {
      salida.persistentes.push({ ...comun, gravedadAnterior: p.gravedad, cambioGravedad: segCambioGravedad(i.gravedad, p.gravedad), variacionCantidad: Number.isFinite(i.cantidad) && Number.isFinite(p.cantidad) ? i.cantidad - p.cantidad : null, desde: p.primeraVez, ejecuciones: (p.consecutivas || 1) + 1 });
      continue;
    }
    const r = recientes.get(i.clave);
    if (r && (genMs - segFechaMs(r.resueltaEn)) / SEG_DIA_MS <= L.diasReaparicion) {
      salida.reaparecidas.push({ ...comun, resueltaEn: r.resueltaEn, reapariciones: (r.reapariciones || 0) + 1 });
    } else if (estadoRecortado) {
      salida.indeterminadas.push({ ...comun, motivo: 'estado_recortado' });
    } else {
      salida.nuevas.push(comun);
    }
  }

  for (const [clave, p] of Object.entries(estado.incidencias)) {
    if (vistas.has(clave)) continue;
    const { area, codigo } = segPartesClave(clave);
    const v = segVerificable(clave, actual, conjuntos, erroresHttp);
    const base = { clave, area, codigo, gravedadAnterior: p.gravedad, desde: p.primeraVez };
    if (v.ok) {
      salida.resueltas.push({ ...base, resueltaEn: actual.generadoEn, diasAbierta: Math.max(0, Math.floor((genMs - segFechaMs(p.primeraVez)) / SEG_DIA_MS)), reapariciones: p.reapariciones || 0 });
    } else if ((p.sinVerificar || 0) + 1 > L.maxEjecucionesSinVerificar) {
      salida.caducadas.push({ ...base, motivo: 'sin_verificar_demasiado_tiempo', sinVerificar: (p.sinVerificar || 0) + 1 });
    } else {
      salida.noVerificadas.push({ ...base, motivo: v.motivo, sinVerificar: (p.sinVerificar || 0) + 1 });
    }
  }

  for (const k of ['nuevas', 'persistentes', 'reaparecidas', 'indeterminadas', 'resueltas', 'noVerificadas', 'caducadas']) salida[k].sort(segPorGravedadYClave);
  salida.resumen = { actuales: nActuales, nuevas: salida.nuevas.length, persistentes: salida.persistentes.length, resueltas: salida.resueltas.length, noVerificadas: salida.noVerificadas.length, reaparecidas: salida.reaparecidas.length, indeterminadas: salida.indeterminadas.length, caducadas: salida.caducadas.length };
  return salida;
}

/** Compara dos instantáneas SUELTAS (la anterior se toma como referencia mínima, sin historial). Atajo para uso y pruebas. */
export function compararInstantaneas(anterior, actual, opciones) {
  const estado = anterior ? estadoDesdeInstantanea(anterior, opciones) : null;
  return compararConEstado(estado, actual, opciones);
}

/**
 * ESTADO SIGUIENTE. Devuelve { guardar, motivo, estado, revisionBase }:
 *  · fallida / sin comparar → guardar:false y el estado anterior intacto;  parcial → guardar:false (no sustituye la última referencia válida);
 *  · completa → estado nuevo con `revision = revisionBase + 1`. La persistencia debe escribirlo SÓLO si `validarEscritura` da ok (control de concurrencia).
 * El estado acotado (≤ maxIncidencias y ≤ maxBytesEstado) conserva primeraVez/ultimaVez/consecutivas de cada incidencia y las resueltas recientes.
 */
export function siguienteEstado(estado, actual, comparacion, opciones) {
  const L = segLimites(opciones);
  const revisionBase = estado && Number.isInteger(estado.revision) ? estado.revision : 0;
  const sinCambio = (motivo) => ({ guardar: false, motivo, estado: estado === undefined ? null : estado, revisionBase });
  if (comparacion.modo === 'sin_comparar') return sinCambio(comparacion.motivo);
  if (actual.calidad.estado !== 'completa') return sinCambio('ejecucion_parcial');

  const gen = actual.generadoEn;
  const genMs = segFechaMs(gen);
  const continua = comparacion.modo === 'comparacion';
  const previas = continua ? estado.incidencias : {};
  const recientesPrevias = continua && Array.isArray(estado.resueltasRecientes) ? estado.resueltasRecientes : [];
  const reaparecidas = new Map(comparacion.reaparecidas.map((r) => [r.clave, r]));
  const nuevo = {};

  for (const i of actual.incidencias) {
    const p = previas[i.clave];
    const re = reaparecidas.get(i.clave);
    nuevo[i.clave] = {
      area: i.area,
      codigo: i.codigo,
      gravedad: i.gravedad,
      cantidad: i.cantidad ?? null,
      primeraVez: p ? p.primeraVez : gen,
      ultimaVez: gen,
      consecutivas: p ? (p.consecutivas || 1) + 1 : 1,
      sinVerificar: 0,
      ...(re ? { reapariciones: re.reapariciones } : p && p.reapariciones ? { reapariciones: p.reapariciones } : {}),
    };
  }
  for (const nv of comparacion.noVerificadas) nuevo[nv.clave] = { ...previas[nv.clave], sinVerificar: nv.sinVerificar };

  const resueltas = comparacion.resueltas.map((r) => ({ clave: r.clave, resueltaEn: gen, primeraVez: r.desde, reapariciones: r.reapariciones || 0 }));
  const vigentes = recientesPrevias.filter((r) => segEsObjeto(r) && typeof r.clave === 'string' && !(r.clave in nuevo) && (genMs - segFechaMs(r.resueltaEn)) / SEG_DIA_MS <= L.diasReaparicion);
  const resueltasRecientes = [...resueltas, ...vigentes.filter((r) => !resueltas.some((x) => x.clave === r.clave))].sort((a, b) => segCmp(b.resueltaEn, a.resueltaEn) || segCmp(a.clave, b.clave)).slice(0, L.maxResueltasRecientes);

  // Acotación: por número de incidencias y por tamaño (se descartan primero las de menor gravedad).
  let claves = Object.keys(nuevo).sort((a, b) => segOrdenGravedad(nuevo[a].gravedad) - segOrdenGravedad(nuevo[b].gravedad) || segCmp(a, b));
  const total = claves.length;
  if (claves.length > L.maxIncidencias) claves = claves.slice(0, L.maxIncidencias);
  const construir = (lista) => {
    const incidencias = {};
    for (const k of [...lista].sort(segCmp)) incidencias[k] = nuevo[k];
    const e = {
      esquema: ESQUEMA_SEGUIMIENTO,
      agente: 'auditor-general',
      entorno: actual.entorno,
      host: actual.host || (estado && estado.host) || null,
      revision: revisionBase + 1,
      actualizadoEn: gen,
      ultimaInstantanea: { generadoEn: gen, version: actual.version, calidad: actual.calidad.estado, huella: segHash(actual.incidencias.map((i) => i.clave).join('|')), ...(opciones && typeof opciones.idEjecucion === 'string' && opciones.idEjecucion ? { idEjecucion: opciones.idEjecucion.slice(0, 64) } : {}) },
      incidencias,
      resueltasRecientes,
    };
    if (lista.length < total) e.recortado = { conservadas: lista.length, omitidas: total - lista.length };
    return e;
  };
  let resultado = construir(claves);
  while (bytesUtf8(JSON.stringify(resultado)) > L.maxBytesEstado && claves.length > 0) {
    claves = claves.slice(0, Math.max(0, claves.length - Math.max(1, Math.ceil(claves.length / 10))));
    resultado = construir(claves);
  }
  return { guardar: true, motivo: continua ? 'ok' : comparacion.motivo, estado: resultado, revisionBase };
}

/**
 * CONTROL DE CONCURRENCIA (compare-and-set) para la capa de persistencia: sólo se escribe si el estado almacenado sigue en la revisión sobre la que se calculó
 * el siguiente estado y su auditoría es más reciente. Si hay conflicto, se vuelve a leer el estado y se repite `ejecutarSeguimiento` (es determinista).
 */
export function validarEscritura(almacenado, resultado) {
  if (!resultado || resultado.guardar !== true || !resultado.estado) return { ok: false, motivo: 'nada_que_guardar' };
  const revision = almacenado && Number.isInteger(almacenado.revision) ? almacenado.revision : 0;
  if (revision !== resultado.revisionBase) return { ok: false, motivo: 'conflicto_revision', revisionAlmacenada: revision };
  const gAlmacenado = almacenado && almacenado.ultimaInstantanea ? segFechaMs(almacenado.ultimaInstantanea.generadoEn) : NaN;
  if (!Number.isNaN(gAlmacenado) && gAlmacenado >= segFechaMs(resultado.estado.ultimaInstantanea.generadoEn)) return { ok: false, motivo: 'orden_invalido' };
  return { ok: true, motivo: null };
}

/** Todo en uno: informe → instantánea → comparación → siguiente estado. Determinista y sin efectos. */
export function ejecutarSeguimiento(estadoPrevio, informe, opciones) {
  const instantanea = resumirInstantanea(informe, opciones);
  const seguimiento = compararConEstado(estadoPrevio, instantanea, opciones);
  const siguiente = siguienteEstado(estadoPrevio, instantanea, seguimiento, opciones);
  return { instantanea, seguimiento, siguiente };
}

/* ───────────────────────── Historial de instantáneas INMUTABLES (entrega 2c) ─────────────────────────
 * La memoria del Auditor es una tabla de n8n (Data Table) de SOLO INSERCIONES: cada auditoría completa añade una fila con su instantánea y nunca se modifica ni se borra.
 * El estado se RECONSTRUYE leyendo las últimas filas: se deduplica por (entorno, idEjecucion) conservando la de menor `id`, se ordena por (generadoEn, idEjecucion) y se pliega
 * con el motor de 2a. Como el resultado depende sólo del CONJUNTO de filas y no del orden de inserción, dos ejecuciones simultáneas o que terminan fuera de orden convergen al mismo
 * estado, sin necesidad de actualizaciones atómicas. Este módulo sigue siendo PURO: la lectura y la escritura las hacen los nodos Data Table del workflow.
 */
export const COLUMNAS_INSTANTANEAS = ['entorno', 'host', 'generadoEn', 'idEjecucion', 'origen', 'calidad', 'huella', 'payload'];
export const LIMITES_PERSISTENCIA = {
  maxBytesInstantanea: 61440, // una instantánea mayor no se guarda
  maxHistorial: 60, // filas que se leen (las más recientes)
  toleranciaFuturoMs: 30 * 86400000, // una fila fechada más de 30 días en el futuro es un dato erróneo (reloj roto): se descarta y no bloquea las siguientes. Una auditoría anterior a la última válida (ejecución antigua o tardía) NO se guarda (orden_invalido)
  origenesValidos: ['manual', 'programada'], // orígenes de ejecución que pueden actualizar el historial
};
const segLimitesPers = (opciones) => ({ ...LIMITES_PERSISTENCIA, ...((opciones && opciones.persistencia) || {}) });
const segIdNum = (f) => (Number.isFinite(Number(f.id)) ? Number(f.id) : Infinity);
const segEsFila = (f) => segEsObjeto(f) && typeof f.idEjecucion === 'string' && f.idEjecucion !== '' && typeof f.entorno === 'string';

/** Origen de la ejecución a partir de `$execution.mode` de n8n: «test» = manual (editor), «production» = programada; otro valor se conserva tal cual. */
export function origenDeModo(modo) {
  return modo === 'production' ? 'programada' : modo === 'test' ? 'manual' : String(modo);
}

/** Estado de la tabla a partir del resultado del nodo «Data table → List» (filtrado por nombre: coincidencia por subcadena): ok | no_encontrada | ambigua | error_lectura. */
export function estadoDeTabla(tablas, nombre) {
  const lista = Array.isArray(tablas) ? tablas : [];
  if (lista.some((t) => segEsObjeto(t) && t.error !== undefined)) return 'error_lectura';
  const conNombre = lista.filter((t) => segEsObjeto(t) && typeof t.name === 'string');
  if (!conNombre.length) return 'no_encontrada';
  return conNombre.length === 1 && conNombre[0].name === nombre ? 'ok' : 'ambigua';
}

/** Fila a insertar para una instantánea: sólo texto, sólo las columnas permitidas. Nada de evidencias, textos ni datos sensibles (la instantánea ya sólo lleva claves y fechas). */
export function filaDeInstantanea(inst, datos) {
  return {
    entorno: inst.entorno,
    host: inst.host || '',
    generadoEn: inst.generadoEn,
    idEjecucion: String(datos.idEjecucion),
    origen: String(datos.origen),
    calidad: inst.calidad.estado,
    huella: segHash(inst.incidencias.map((i) => i.clave).join('|')),
    payload: JSON.stringify(inst),
  };
}

/** Deduplica por (entorno, idEjecucion) conservando la fila de MENOR `id` (la primera insertada). */
export function deduplicarFilas(filas) {
  const porClave = new Map();
  for (const f of Array.isArray(filas) ? filas : []) {
    if (!segEsFila(f)) continue;
    const k = `${f.entorno}\u0001${f.idEjecucion}`;
    const previa = porClave.get(k);
    if (!previa || segIdNum(f) < segIdNum(previa)) porClave.set(k, f);
  }
  return [...porClave.values()];
}

/** Orden determinista: (generadoEn, idEjecucion, id). */
export function ordenarFilas(filas) {
  return [...filas].sort((a, b) => segCmp(String(a.generadoEn), String(b.generadoEn)) || segCmp(a.idEjecucion, b.idEjecucion) || segIdNum(a) - segIdNum(b));
}

/**
 * RECONSTRUYE el estado del seguimiento a partir de las filas leídas. Ignora lo que no es una fila (elementos vacíos o de error del nodo Get) y las de otro entorno; descarta, con
 * su motivo, las filas inválidas (JSON ilegible, esquema o entorno incoherente, calidad no completa, fecha incoherente o futura). Devuelve { estado, pasos, leidas, validas, duplicadas, descartadas, ultimaGeneradoEn }.
 */
export function reconstruirEstado(filas, opciones) {
  const L = segLimitesPers(opciones);
  const entorno = opciones && opciones.entorno;
  const tope = opciones && opciones.ahoraIso ? segFechaMs(opciones.ahoraIso) + L.toleranciaFuturoMs : Infinity;
  const propias = (Array.isArray(filas) ? filas : []).filter((f) => segEsFila(f) && (entorno === undefined || f.entorno === entorno));
  const unicas = deduplicarFilas(propias);
  const descartadas = [];
  const validas = [];
  for (const f of ordenarFilas(unicas)) {
    let inst = null;
    try { inst = typeof f.payload === 'string' && bytesUtf8(f.payload) <= L.maxBytesInstantanea ? JSON.parse(f.payload) : null; } catch (e) { inst = null; }
    const motivo = !inst ? 'payload_invalido'
      : inst.esquema !== ESQUEMA_SEGUIMIENTO || !Array.isArray(inst.incidencias) ? 'esquema_incompatible'
      : inst.entorno !== f.entorno || inst.generadoEn !== f.generadoEn ? 'fila_incoherente'
      : !inst.calidad || inst.calidad.estado !== 'completa' ? 'calidad_no_completa'
      : Number.isNaN(segFechaMs(f.generadoEn)) ? 'fecha_invalida'
      : segFechaMs(f.generadoEn) > tope ? 'fecha_futura' : null;
    if (motivo) descartadas.push({ idEjecucion: f.idEjecucion, motivo }); else validas.push(inst);
  }
  let estado = null;
  const pasos = [];
  for (const inst of validas) {
    const comparacion = compararConEstado(estado, inst, opciones);
    const siguiente = siguienteEstado(estado, inst, comparacion, opciones);
    pasos.push(`${comparacion.modo}${comparacion.motivo ? `:${comparacion.motivo}` : ''}${siguiente.guardar ? '+guardar' : ''}`);
    if (siguiente.guardar) estado = siguiente.estado;
  }
  return { estado, pasos, leidas: propias.length, validas: validas.length, duplicadas: propias.length - unicas.length, descartadas, ultimaGeneradoEn: validas.length ? validas[validas.length - 1].generadoEn : null };
}

/**
 * Seguimiento con HISTORIAL: informe + filas leídas → comparación, y la fila a guardar (o ninguna). Decide NO guardar si la ejecución es fallida o incompleta (parcial), si su fecha no es posterior
 * a la última válida (ejecución antigua o tardía), si el origen no está permitido, si no hay `idEjecucion`, si la instantánea excede el tamaño máximo o si esa ejecución ya está guardada (reintento).
 * Devuelve { instantanea, seguimiento, previo, guardar, motivoGuardado, fila }.
 */
export function ejecutarSeguimientoConHistorial(filas, informe, opciones) {
  const L = segLimitesPers(opciones);
  const instantanea = resumirInstantanea(informe, opciones);
  const previo = reconstruirEstado(filas, { ...opciones, entorno: instantanea.entorno, ahoraIso: instantanea.generadoEn });
  const seguimiento = compararConEstado(previo.estado, instantanea, opciones);
  const siguiente = siguienteEstado(previo.estado, instantanea, seguimiento, opciones);
  const idEjecucion = opciones && typeof opciones.idEjecucion === 'string' ? opciones.idEjecucion : '';
  let guardar = siguiente.guardar;
  let motivoGuardado = guardar ? 'ok' : siguiente.motivo;
  const rechazo = (m) => { guardar = false; motivoGuardado = m; };
  if (guardar && !L.origenesValidos.includes(opciones && opciones.origen)) rechazo('origen_no_valido');
  if (guardar && !idEjecucion) rechazo('sin_id_ejecucion');
  if (guardar && (Array.isArray(filas) ? filas : []).some((f) => segEsFila(f) && f.entorno === instantanea.entorno && f.idEjecucion === idEjecucion)) rechazo('ya_guardada');
  let fila = null;
  if (guardar) {
    fila = filaDeInstantanea(instantanea, { idEjecucion, origen: opciones.origen });
    if (bytesUtf8(fila.payload) > L.maxBytesInstantanea) { fila = null; rechazo('instantanea_demasiado_grande'); }
  }
  return { instantanea, seguimiento, previo, guardar, motivoGuardado, fila };
}
