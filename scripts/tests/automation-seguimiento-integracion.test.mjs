// Treidilor AI · Auditor General v0.2, entrega 2b: INTEGRACIÓN del alcance y del seguimiento en el informe (JSON y Markdown), sin persistencia.
// Se ejecuta el workflow GENERADO de producción en el simulador con un sitio sintético (sin red, sin n8n). La referencia anterior se pasa como entrada opcional
// (`estadoAnterior` / `instantaneaAnterior`), que es como la aportará la persistencia en la entrega 2c.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const J = (p) => JSON.parse(fs.readFileSync(path.join(RAIZ, p), 'utf8'));
const aud = await import('../../automation/lib/auditor.mjs');
const seg = await import('../../automation/lib/seguimiento.mjs');
const { simularWorkflow } = await import('../automation/simulate-workflow.mjs');
const { validarEsquema } = await import('../automation/validate-schema.mjs');

const PROD = J('automation/config/produccion.json');
const LOCAL = J('automation/config/local.json');
const ESQ = { informe: () => J('automation/schemas/informe-auditor.schema.json'), seguimiento: () => J('automation/schemas/seguimiento-auditor.schema.json') };
const T0 = Date.parse('2026-11-10T08:00:00.000Z');
const dia = (n) => new Date(T0 + n * 86400000).toISOString();
const plano = (x) => JSON.parse(JSON.stringify(x));
const claves = (lista) => lista.map((x) => x.clave).sort();
const SALUD = { status: 'ok', sourceHash: 'a'.repeat(64), uptimeSeconds: 9000, dataDirExists: true, env: { smtp: true } };

/* ───────── sitio sintético ───────── */
const pagina = ({ titulo = true, links = [] } = {}) => `<!doctype html><html><head>${titulo ? '<title>Treidilor</title>' : ''}</head><body><h1>Título</h1>${links.map((h) => `<a href="${h}">l</a>`).join('')}<p>${'x'.repeat(2500)}</p></body></html>`;
/** `spec`: { enlaces: [...], '/ruta': { status | timeout | error | json | titulo:false } , todoCaido }. Lo no indicado responde 200 con una página correcta. */
function sitio(spec) {
  return ({ url }) => {
    const u = new URL(url);
    if (spec.todoCaido) throw new Error('connect ECONNREFUSED');
    if (u.pathname === '/api/health') return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: SALUD };
    const s = spec[u.pathname + u.search] ?? {};
    if (s.timeout) throw new Error('timeout of 15000ms exceeded');
    if (s.error) throw new Error(s.error);
    if (s.status && s.status !== 200) return { statusCode: s.status, body: s.status >= 500 ? 'error' : '' };
    if (s.json) return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { ok: true } };
    return { statusCode: 200, body: pagina({ titulo: s.titulo, links: u.pathname === '/' ? spec.enlaces ?? [] : [] }) };
  };
}

/** Ejecuta el workflow generado. Si se pasa `estadoAnterior` o `instantaneaAnterior`, vuelve a construir el informe con esa referencia (el workflow aún no tiene nodo de estado). */
function ejecutar(spec, { dia: n = 0, maxEnlaces, estadoAnterior, instantaneaAnterior } = {}) {
  const wf = J('automation/workflows/auditor-general.produccion.json');
  if (maxEnlaces !== undefined) for (const nodo of wf.nodes) if (nodo.type === 'n8n-nodes-base.code') nodo.parameters.jsCode = nodo.parameters.jsCode.replace(/"maxEnlaces": \d+/, `"maxEnlaces": ${maxEnlaces}`);
  const ahora = dia(n);
  const r = simularWorkflow(wf, { fetchSimulado: sitio(spec), ahora, hostsPermitidos: PROD.hostsPermitidos });
  let informe = plano(r.salida[0].json);
  if (estadoAnterior !== undefined || instantaneaAnterior !== undefined) {
    const nodo = (nombre) => (r.salidas.get(nombre) ?? []).map((i) => i.json);
    const entrada = { cfg: { ...PROD, ...(maxEnlaces !== undefined ? { maxEnlaces } : {}) }, objetivosRutas: nodo('Objetivos'), respuestasRutas: nodo('Pedir rutas'), objetivosEnlaces: nodo('Enlaces a revisar'), respuestasEnlaces: nodo('Pedir enlaces'), ahoraIso: ahora, estadoAnterior, instantaneaAnterior };
    informe = plano(aud.construirInformeAuditor(entrada));
  }
  return { informe, peticiones: r.peticiones, salidas: r.salidas };
}
const guardar = (estadoPrevio, informe) => seg.ejecutarSeguimiento(estadoPrevio, informe);

// Día 0: /a da 404, /b da 500, /c agota el tiempo, /d bien; /catalogo sin <title>.
const DIA0 = { enlaces: ['/a', '/b', '/c', '/d'], '/a': { status: 404 }, '/b': { status: 500 }, '/c': { timeout: true }, '/catalogo': { titulo: false } };

/* ───────────────────────── Alcance ───────────────────────── */
test('alcance: distingue solicitadas, respondieron (con estado HTTP), sin respuesta (con motivo) y análisis de contenido incompleto', () => {
  const { informe } = ejecutar({ ...DIA0, '/metodologia': { status: 301 }, '/categorias': { json: true }, enlaces: ['/a', '/b', '/c', '/d', '/e'], '/e': { error: 'socket hang up ECONNRESET' } });
  const a = informe.alcance;
  assert.deepEqual(validarEsquema(informe, ESQ.informe()), []);
  assert.equal(a.host, 'treidilor.com');
  assert.equal(a.salud, true);
  assert.deepEqual(a.rutas, ['/', '/catalogo', '/categorias', '/metodologia'], 'las 4 rutas respondieron (también la que redirige y la que devuelve JSON)');
  assert.deepEqual(a.enlaces, ['https://treidilor.com/a', 'https://treidilor.com/b', 'https://treidilor.com/d'].map((u) => u), 'sólo los enlaces que RESPONDIERON, aunque sea con error HTTP');
  assert.deepEqual(a.sinRespuesta.map((x) => [x.tipo, x.destino.replace('https://treidilor.com', ''), x.motivo]), [['enlace', '/c', 'tiempo_agotado'], ['enlace', '/e', 'error_de_red']]);
  assert.deepEqual(a.contenido.rutas, ['/', '/catalogo'], 'sólo estas dos tienen HTML 200 analizado');
  assert.deepEqual(a.incompletas.map((x) => [x.destino, x.motivo]).sort(), [['/categorias', 'respuesta_no_html'], ['/metodologia', 'redireccion']]);
  assert.deepEqual(a.resumen, { solicitadas: 9, respondieron: 7, correctas: 4, sinRespuesta: 2, incompletas: 2, noVisitados: 0 });
  assert.deepEqual(a.catalogo, { leido: false, completo: false }, 'en producción no se lee el feed');
  assert.ok(informe.cobertura.revisado.some((x) => /7 de 9 páginas respondieron \(2 sin respuesta, 2 con el análisis de contenido incompleto\)/.test(x)));
});

test('alcance: enlaces descubiertos pero no visitados (tope) se declaran y no cuentan como revisados', () => {
  const { informe } = ejecutar({ ...DIA0 }, { maxEnlaces: 2 });
  const a = informe.alcance;
  assert.equal(a.enlaces.length, 2);
  assert.equal(a.resumen.noVisitados, 2);
  assert.equal(a.resumen.solicitadas, 6);
  assert.ok(informe.cobertura.noRevisado.some((x) => /2 enlaces internos descubiertos no se visitaron \(tope de 2\)/.test(x)));
});

test('alcance del catálogo (modo completo): leído y completo sólo si el feed se leyó entero y sin errores', () => {
  const objetivosRutas = aud.crearObjetivosRutas(LOCAL);
  const respuestasRutas = objetivosRutas.map((t) => (t.tipo === 'salud' ? { statusCode: 200, headers: { 'content-type': 'application/json' }, data: JSON.stringify(SALUD) } : { statusCode: 200, headers: { 'content-type': 'text/html' }, data: pagina() }));
  const productos = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, title: `Producto de prueba número ${i}`, description: 'Descripción suficientemente larga para el producto de prueba.', price: 10, currency: 'EUR', category: 'Sonido', merchant: 'Amazon', image: 'https://cdn.example.com/x.jpg' }));
  const feed = (total, lista = productos) => [{ statusCode: 200, headers: {}, data: JSON.stringify({ success: true, total, page: 1, limit: 100, totalPages: 1, products: lista }) }];
  const base = { cfg: LOCAL, objetivosRutas, respuestasRutas, objetivosCatalogo: aud.crearObjetivosCatalogo(LOCAL), ahoraIso: dia(0) };
  assert.deepEqual(aud.construirInformeAuditor({ ...base, respuestasCatalogo: feed(3) }).alcance.catalogo, { leido: true, completo: true });
  assert.deepEqual(aud.construirInformeAuditor({ ...base, respuestasCatalogo: feed(250) }).alcance.catalogo, { leido: true, completo: false }, 'se leyeron 3 de 250: revisión parcial');
  assert.deepEqual(aud.construirInformeAuditor({ ...base, respuestasCatalogo: [{ statusCode: 500, headers: {}, data: 'x' }] }).alcance.catalogo, { leido: false, completo: false });
});

/* ───────────────────────── Primera ejecución y línea base ───────────────────────── */
test('primera ejecución: el informe trae el seguimiento como LÍNEA BASE (nada es «nuevo») y lo dice en JSON y Markdown', () => {
  const { informe, peticiones } = ejecutar(DIA0);
  const s = informe.seguimiento;
  assert.deepEqual([s.modo, s.motivo, s.origenReferencia, s.comparadoCon], ['linea_base', 'primera_ejecucion', 'ninguna', null]);
  assert.deepEqual([s.resumen.nuevas, s.resumen.persistentes, s.resumen.resueltas, s.resumen.noVerificadas, s.resumen.reaparecidas], [0, 0, 0, 0, 0]);
  assert.ok(s.resumen.actuales >= 4, 'hay incidencias actuales, pero ninguna se clasifica como nueva');
  assert.deepEqual(validarEsquema(informe, ESQ.informe()), []);
  assert.deepEqual(validarEsquema(s, ESQ.seguimiento()), []);
  assert.match(informe.markdown, /## Seguimiento/);
  assert.match(informe.markdown, /\*\*Línea base\*\* — primera ejecución/);
  assert.match(informe.markdown, /Sin memoria persistente/, 'sin la tabla de n8n, el informe lo dice (la memoria se prueba en automation-persistencia.test.mjs)');
  assert.doesNotMatch(informe.markdown, /### Nuevas/);
  assert.equal(peticiones.length, 9, 'el alcance y el seguimiento no añaden peticiones: salud + 4 rutas + 4 enlaces');
});

/* ───────────────────────── Resoluciones reales ───────────────────────── */
test('resoluciones REALES: se resuelve lo que se volvió a revisar y está bien; persiste lo que sigue mal; lo nuevo es nuevo', () => {
  const dia0 = ejecutar(DIA0).informe;
  const estado = guardar(null, dia0).siguiente.estado;
  assert.ok(Object.keys(estado.incidencias).includes('enlace:roto:/a') && Object.keys(estado.incidencias).includes('ruta:sin_titulo:/catalogo') && Object.keys(estado.incidencias).includes('enlace:sin_respuesta:/c'));
  // día 1: /a arreglado, /catalogo con título, /b sigue 500, /c sigue sin responder, /d ahora 404
  const dia1 = ejecutar({ enlaces: ['/a', '/b', '/c', '/d'], '/b': { status: 500 }, '/c': { timeout: true }, '/d': { status: 404 } }, { dia: 1, estadoAnterior: estado }).informe;
  const s = dia1.seguimiento;
  assert.deepEqual([s.modo, s.origenReferencia, s.comparadoCon], ['comparacion', 'estado', dia(0)]);
  assert.deepEqual(claves(s.resueltas), ['enlace:roto:/a', 'ruta:sin_titulo:/catalogo']);
  assert.deepEqual(claves(s.persistentes), ['enlace:roto:/b', 'enlace:sin_respuesta:/c']);
  assert.deepEqual(claves(s.nuevas), ['enlace:roto:/d']);
  assert.deepEqual(s.noVerificadas, []);
  assert.equal(s.resueltas.find((x) => x.clave === 'enlace:roto:/a').diasAbierta, 1);
  assert.deepEqual(validarEsquema(dia1, ESQ.informe()), []);
  // Markdown
  for (const texto of ['### Resueltas (2)', '### Persistentes (2)', '### Nuevas (1)', '`enlace:roto:/a`', '`enlace:roto:/d`', 'su destino se revisó en esta ejecución']) assert.ok(dia1.markdown.includes(texto), texto);
  assert.match(dia1.markdown, /\*\*Nuevas:\*\* 1 · \*\*Persistentes:\*\* 2 · \*\*Resueltas:\*\* 2 · \*\*No verificadas:\*\* 0 · \*\*Reaparecidas:\*\* 0/);
});

test('una instantánea anterior (o un informe anterior) sirve de referencia en pruebas y simulaciones', () => {
  const dia0 = ejecutar(DIA0).informe;
  const spec1 = { enlaces: ['/a', '/b', '/c', '/d'], '/b': { status: 500 }, '/c': { timeout: true } };
  const conEstado = ejecutar(spec1, { dia: 1, estadoAnterior: guardar(null, dia0).siguiente.estado }).informe.seguimiento;
  const conInstantanea = ejecutar(spec1, { dia: 1, instantaneaAnterior: seg.resumirInstantanea(dia0) }).informe.seguimiento;
  const conInforme = ejecutar(spec1, { dia: 1, instantaneaAnterior: dia0 }).informe.seguimiento;
  assert.equal(conInstantanea.origenReferencia, 'instantanea');
  assert.deepEqual(claves(conInstantanea.resueltas), ['enlace:roto:/a', 'ruta:sin_titulo:/catalogo']);
  for (const otro of [conInstantanea, conInforme]) {
    assert.deepEqual(plano({ ...otro, origenReferencia: 'estado' }), plano(conEstado), 'el resultado es el mismo con cualquiera de las tres formas');
  }
});

/* ───────────────────────── Evidencia insuficiente ───────────────────────── */
test('respuestas HTTP erróneas: un enlace que sigue dando error no se resuelve, y el contenido de una página con error no se da por arreglado', () => {
  const estado = guardar(null, ejecutar(DIA0).informe).siguiente.estado;
  // /a pasa de 404 a 503 (sigue roto); /catalogo ahora da 500: ya no se puede decir que tenga título
  const s = ejecutar({ enlaces: ['/a', '/b', '/c', '/d'], '/a': { status: 503 }, '/b': { status: 500 }, '/c': { timeout: true }, '/catalogo': { status: 500 } }, { dia: 1, estadoAnterior: estado }).informe.seguimiento;
  assert.ok(claves(s.persistentes).includes('enlace:roto:/a'), 'sigue roto (503)');
  assert.ok(!claves(s.resueltas).includes('enlace:roto:/a'));
  assert.deepEqual(claves(s.noVerificadas), ['ruta:sin_titulo:/catalogo']);
  assert.equal(s.noVerificadas[0].motivo, 'pagina_con_error');
  assert.ok(claves(s.nuevas).includes('ruta:error_servidor:/catalogo'));
  assert.equal(s.resueltas.length, 0);
});

test('análisis incompleto: una redirección o una respuesta no HTML no demuestran que el contenido esté arreglado', () => {
  const estado = guardar(null, ejecutar(DIA0).informe).siguiente.estado;
  for (const [respuesta, motivoAlcance] of [[{ status: 301 }, 'redireccion'], [{ json: true }, 'respuesta_no_html']]) {
    const { informe } = ejecutar({ enlaces: ['/a', '/b', '/c', '/d'], '/a': { status: 404 }, '/b': { status: 500 }, '/c': { timeout: true }, '/catalogo': respuesta }, { dia: 1, estadoAnterior: estado });
    const nv = informe.seguimiento.noVerificadas.find((x) => x.clave === 'ruta:sin_titulo:/catalogo');
    assert.ok(nv, JSON.stringify(respuesta));
    assert.equal(nv.motivo, 'analisis_incompleto');
    assert.ok(informe.alcance.incompletas.some((x) => x.destino === '/catalogo' && x.motivo === motivoAlcance));
    assert.equal(informe.seguimiento.resueltas.some((x) => x.clave === 'ruta:sin_titulo:/catalogo'), false);
  }
});

test('tiempos de espera: haber PEDIDO un enlace no basta; sin respuesta no hay resolución y el motivo queda registrado', () => {
  const estado = guardar(null, ejecutar(DIA0).informe).siguiente.estado;
  const { informe } = ejecutar({ enlaces: ['/a', '/b', '/c', '/d'], '/a': { timeout: true }, '/b': { status: 500 }, '/c': { timeout: true } }, { dia: 1, estadoAnterior: estado });
  const s = informe.seguimiento;
  assert.ok(informe.alcance.sinRespuesta.some((x) => x.destino.endsWith('/a') && x.motivo === 'tiempo_agotado'));
  assert.ok(!claves(s.resueltas).includes('enlace:roto:/a'), '/a se solicitó pero no respondió: no está resuelto');
  const nv = s.noVerificadas.find((x) => x.clave === 'enlace:roto:/a');
  assert.equal(nv.motivo, 'objetivo_no_revisado');
  assert.ok(claves(s.nuevas).includes('enlace:sin_respuesta:/a'), 'el tiempo agotado es una incidencia distinta');
});

test('enlaces no visitados: con un tope menor, las incidencias de los enlaces que no se visitaron pasan a «no verificadas», nunca a resueltas', () => {
  const estado = guardar(null, ejecutar(DIA0).informe).siguiente.estado;
  const { informe } = ejecutar({ enlaces: ['/a', '/b', '/c', '/d'], '/b': { status: 500 }, '/c': { timeout: true }, '/d': { status: 404 } }, { dia: 1, maxEnlaces: 2, estadoAnterior: estado });
  const s = informe.seguimiento;
  assert.deepEqual(claves(s.resueltas), ['enlace:roto:/a', 'ruta:sin_titulo:/catalogo'], '/a sí se visitó (es de los 2 primeros) y está bien');
  assert.deepEqual(claves(s.persistentes), ['enlace:roto:/b']);
  assert.deepEqual(claves(s.noVerificadas), ['enlace:sin_respuesta:/c'], '/c no se visitó con el tope de 2: no se sabe');
  assert.equal(s.noVerificadas[0].motivo, 'objetivo_no_revisado');
  assert.equal(informe.alcance.resumen.noVisitados, 2);
  assert.deepEqual(s.nuevas, [], '/d no se visitó: no hay forma de saber si falla');
});

/* ───────────────────────── Ejecuciones parciales y fallidas ───────────────────────── */
test('ejecución PARCIAL (muchos tiempos de espera): se informa, nada se resuelve sin evidencia y NO sustituye la última referencia', () => {
  const estado = guardar(null, ejecutar(DIA0).informe).siguiente.estado;
  const { informe } = ejecutar({ enlaces: ['/a', '/b', '/c', '/d'], '/a': { timeout: true }, '/b': { timeout: true }, '/c': { timeout: true }, '/d': { timeout: true } }, { dia: 1, estadoAnterior: estado });
  assert.equal(informe.seguimiento.modo, 'comparacion');
  assert.equal(informe.seguimiento.calidad.estado, 'parcial');
  assert.deepEqual(informe.seguimiento.calidad.motivos, ['muchas_peticiones_sin_respuesta']);
  assert.ok(!claves(informe.seguimiento.resueltas).includes('enlace:roto:/a'));
  const r = guardar(estado, informe);
  assert.equal(r.siguiente.guardar, false);
  assert.equal(r.siguiente.motivo, 'ejecucion_parcial');
  assert.deepEqual(plano(r.siguiente.estado), plano(estado), 'la referencia válida anterior queda intacta');
});

test('ejecución FALLIDA (servidor caído): sin comparar, sin resolver nada y sin guardar', () => {
  const estado = guardar(null, ejecutar(DIA0).informe).siguiente.estado;
  const { informe } = ejecutar({ todoCaido: true }, { dia: 1, estadoAnterior: estado });
  assert.equal(informe.resumen.estado, 'critico');
  assert.deepEqual([informe.seguimiento.modo, informe.seguimiento.motivo, informe.seguimiento.resumen.resueltas], ['sin_comparar', 'ejecucion_fallida', 0]);
  assert.match(informe.markdown, /\*\*Sin comparar\*\* — esta ejecución no obtuvo respuestas suficientes/);
  assert.equal(guardar(estado, informe).siguiente.guardar, false);
});

/* ───────────────────────── Estado recortado ───────────────────────── */
test('estado recortado: lo que falta en él NO se clasifica como nuevo (indeterminado), y sigue siendo seguible desde ahora', () => {
  const base = guardar(null, ejecutar(DIA0).informe).siguiente.estado;
  const recortado = { ...base, recortado: { conservadas: Object.keys(base.incidencias).length, omitidas: 5 } };
  const spec1 = { enlaces: ['/a', '/b', '/c', '/d'], '/a': { status: 404 }, '/b': { status: 500 }, '/c': { timeout: true }, '/d': { status: 404 }, '/catalogo': { titulo: false } };
  const normal = ejecutar(spec1, { dia: 1, estadoAnterior: base }).informe;
  assert.deepEqual(claves(normal.seguimiento.nuevas), ['enlace:roto:/d'], 'con un estado completo, /d sí es nueva');
  const conRecorte = ejecutar(spec1, { dia: 1, estadoAnterior: recortado }).informe;
  const s = conRecorte.seguimiento;
  assert.deepEqual(s.nuevas, []);
  assert.deepEqual(claves(s.indeterminadas), ['enlace:roto:/d']);
  assert.equal(s.indeterminadas[0].motivo, 'estado_recortado');
  assert.equal(s.resumen.indeterminadas, 1);
  assert.deepEqual(validarEsquema(conRecorte, ESQ.informe()), []);
  assert.match(conRecorte.markdown, /### Indeterminadas \(1\)/);
  assert.match(conRecorte.markdown, /el estado anterior estaba recortado/);
  // la siguiente referencia ya incluye esa incidencia (primera vez vista ahora) y deja de estar recortada si cabe
  const siguiente = guardar(recortado, conRecorte).siguiente;
  assert.equal(siguiente.guardar, true);
  assert.ok('enlace:roto:/d' in siguiente.estado.incidencias);
  assert.ok(!('recortado' in siguiente.estado));
});

/* ───────────────────────── Compatibilidad, determinismo, límites y aislamiento ───────────────────────── */
test('compatibilidad: un informe sin alcance ni seguimiento sigue siendo válido; una referencia inválida produce línea base con su motivo', () => {
  const { informe } = ejecutar(DIA0);
  const antiguo = plano(informe);
  delete antiguo.alcance;
  delete antiguo.seguimiento;
  delete antiguo.consumo;
  assert.deepEqual(validarEsquema(antiguo, ESQ.informe()), []);
  assert.doesNotMatch(aud.informeMarkdown({ ...antiguo, markdown: '' }), /## Seguimiento|## Consumo/);
  // el alcance de la entrega 2a (sin los campos nuevos) también valida
  const alcance2a = { host: 'treidilor.com', salud: true, rutas: ['/'], enlaces: [], fichas: [], catalogo: { leido: false, completo: false } };
  assert.deepEqual(validarEsquema({ ...antiguo, alcance: alcance2a }, ESQ.informe()), []);
  // un informe antiguo como referencia anterior: sirve de línea base para comparar
  const sinAlcance = ejecutar(DIA0, { dia: 1, instantaneaAnterior: antiguo }).informe.seguimiento;
  assert.equal(sinAlcance.modo, 'comparacion');
  // estado inválido → línea base con motivo
  const invalido = ejecutar(DIA0, { dia: 1, estadoAnterior: { esquema: 1, raro: true } }).informe.seguimiento;
  assert.deepEqual([invalido.modo, invalido.motivo, invalido.origenReferencia], ['linea_base', 'estado_invalido', 'estado']);
  assert.match(aud.informeMarkdown(ejecutar(DIA0, { dia: 1, estadoAnterior: { esquema: 1, raro: true } }).informe), /el estado anterior no es válido/);
});

test('el seguimiento no duplica la lógica del motor y es determinista', () => {
  const dia0 = ejecutar(DIA0).informe;
  const estado = guardar(null, dia0).siguiente.estado;
  const spec1 = { enlaces: ['/a', '/b'], '/b': { status: 500 } };
  const a = ejecutar(spec1, { dia: 1, estadoAnterior: estado }).informe;
  const b = ejecutar(spec1, { dia: 1, estadoAnterior: estado }).informe;
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'mismo estado y mismas respuestas → mismo informe');
  // el informe contiene exactamente lo que da el motor
  const { seguimiento } = seg.ejecutarSeguimiento(estado, { ...a, seguimiento: undefined, consumo: undefined, markdown: '' }, { host: 'treidilor.com' });
  assert.deepEqual(plano({ ...a.seguimiento, origenReferencia: undefined }), plano({ ...seguimiento, origenReferencia: undefined }));
  const fuente = fs.readFileSync(path.join(RAIZ, 'automation/lib/auditor.mjs'), 'utf8');
  assert.doesNotMatch(fuente, /function (claveSeguimiento|compararConEstado|siguienteEstado|normalizarDestino)\b/, 'auditor.mjs sólo llama al motor');
});

test('se conservan los límites de consumo y las políticas de aislamiento', () => {
  assert.equal(PROD.maxEnlaces, 40, 'el límite de 40 enlaces no ha cambiado');
  const { informe, peticiones } = ejecutar({ ...DIA0, enlaces: Array.from({ length: 60 }, (_, i) => `/g/${String(i).padStart(2, '0')}`) });
  assert.equal(peticiones.length, 1 + 4 + 40);
  assert.equal(informe.consumo.presupuesto.enlacesPedidos, 40);
  assert.equal(informe.alcance.resumen.noVisitados, 20);
  assert.ok(informe.consumo.estimado.esEstimacion);
  for (const p of peticiones) {
    const u = new URL(p.url);
    assert.deepEqual([p.metodo, u.protocol, u.host, p.credencial], ['GET', 'https:', 'treidilor.com', false]);
    assert.ok(u.pathname === '/api/health' || !u.pathname.startsWith('/api'));
  }
  const wf = J('automation/workflows/auditor-general.produccion.json');
  assert.equal(wf.active, false);
  assert.ok(!wf.nodes.some((n) => /schedule|webhook|postgres|executeCommand|emailSend/i.test(n.type)), 'sin programación ni salidas (la memoria es una Data Table de n8n: ver automation-persistencia.test.mjs)');
  assert.ok(wf.nodes.every((n) => !n.credentials));
  const texto = JSON.stringify(wf);
  assert.ok(!/\$getWorkflowStaticData|\$execution\.(?!mode\b|id\b)/.test(texto), 'el workflow sólo lee $execution.mode e $execution.id y no usa datos estáticos');
});
