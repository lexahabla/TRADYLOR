// Treidilor AI · Auditor General v0.2, entrega 2a: MOTOR PURO de seguimiento de incidencias (nuevas, persistentes, resueltas, no verificadas, reaparecidas).
// Sin red, sin n8n, sin persistencia y sin tocar los workflows. La persistencia del estado es una entrega posterior (2c).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const J = (p) => JSON.parse(fs.readFileSync(path.join(RAIZ, p), 'utf8'));
const seg = await import('../../automation/lib/seguimiento.mjs');
const { simularWorkflow } = await import('../automation/simulate-workflow.mjs');
const { validarEsquema } = await import('../automation/validate-schema.mjs');
const { construirTodo, construirDiagnosticos, fuenteModulo } = await import('../automation/build-workflows.mjs');

const plano = (x) => JSON.parse(JSON.stringify(x));
const T0 = Date.parse('2026-11-10T08:00:00.000Z');
const dia = (n, horas = 0) => new Date(T0 + n * 86400000 + horas * 3600000).toISOString();
const HOST = 'https://treidilor.com';
const ESQ = { informe: () => J('automation/schemas/informe-auditor.schema.json'), seguimiento: () => J('automation/schemas/seguimiento-auditor.schema.json'), estado: () => J('automation/schemas/estado-auditor.schema.json') };

// ── fabricación de informes sintéticos con la misma forma que los del Auditor ──
const inc = (area, codigo, clave, gravedad = 'media', extra = {}) => ({
  id: `${area}:${codigo}${clave ? `:${clave}` : ''}`.slice(0, 200),
  gravedad,
  area,
  titulo: extra.titulo ?? `${codigo} ${clave ?? ''}`,
  detalle: extra.detalle ?? 'detalle',
  evidencia: extra.evidencia ?? {},
  accionSugerida: 'acción',
  clase: 'disponibilidad',
  ambito: extra.ambito ?? (area === 'catalogo' ? 'datos' : 'produccion'),
});
const alc = (o = {}) => ({ host: 'treidilor.com', salud: true, rutas: ['/', '/catalogo'], enlaces: [], fichas: [], catalogo: { leido: false, completo: false }, ...o });
const informe = (gen, incidencias, o = {}) => ({
  agente: 'auditor-general', version: '0.2.0', entorno: o.entorno ?? 'produccion', modo: 'publico', generadoEn: gen, soloLectura: true,
  resumen: { estado: 'atencion', incidencias: { critica: 0, alta: 0, media: 0, baja: 0, info: 0 }, avisosEntorno: 0, peticiones: o.peticiones ?? 20, rutasRevisadas: 4, enlacesRevisados: 10, fichasRevisadas: 0, paginasCatalogo: 0 },
  incidencias, avisosEntorno: [], cobertura: { revisado: [], noRevisado: [] }, markdown: 'x',
  ...(o.alcance === null ? {} : { alcance: o.alcance ?? alc() }),
});
const roto = (p, g = 'alta') => inc('enlace', 'roto', `${HOST}${p}`, g, { evidencia: { url: `${HOST}${p}`, origen: '/', statusCode: 404 } });
const claves = (lista) => lista.map((x) => x.clave).sort();

/* ───────────────────────── Claves estables ───────────────────────── */
test('claves: host, protocolo, barra final, orden de parámetros, parámetros de seguimiento y fragmento NO cambian la clave', () => {
  const k = (id) => seg.claveSeguimiento({ id, area: 'enlace', evidencia: {} });
  const referencia = k('enlace:roto:https://treidilor.com/cat?a=1&b=2');
  for (const v of ['https://treidilor.com/cat/?b=2&a=1', 'http://www.otro.example:8080/cat?b=2&a=1&utm_source=news&fbclid=zz', 'https://treidilor.com/cat?a=1&b=2#abajo', 'https://treidilor.com//cat//?a=1&b=2&gclid=1']) {
    assert.equal(k(`enlace:roto:${v}`), referencia, v);
  }
  assert.equal(referencia, 'enlace:roto:/cat?a=1&b=2');
  assert.notEqual(k('enlace:roto:https://treidilor.com/cat?a=1&b=3'), referencia, 'un parámetro de negocio distinto es otro destino');
  assert.notEqual(k('enlace:roto:https://treidilor.com/otra?a=1&b=2'), referencia);
  assert.equal(seg.claveSeguimiento({ id: 'ruta:sin_titulo:/', area: 'ruta' }), 'ruta:sin_titulo:/');
  assert.equal(seg.claveSeguimiento({ id: 'catalogo:sin_precio', area: 'catalogo' }), 'catalogo:sin_precio');
  assert.equal(seg.claveSeguimiento({ id: 'ficha:no_encontrada:p3', area: 'ficha' }), 'ficha:no_encontrada:p3', 'el id de un producto no es una ruta: se respeta');
  assert.equal(seg.claveSeguimiento({ id: 'salud:http', area: 'salud' }), 'salud:http');
});

test('claves: el título, la gravedad, el estado HTTP y los recuentos no forman parte de la clave', () => {
  const a = seg.claveSeguimiento(inc('enlace', 'roto', `${HOST}/x`, 'alta', { titulo: 'Enlace interno roto: A', detalle: 'HTTP 404', evidencia: { statusCode: 404 } }));
  const b = seg.claveSeguimiento(inc('enlace', 'roto', `${HOST}/x`, 'media', { titulo: 'Otro texto totalmente distinto', detalle: 'HTTP 410', evidencia: { statusCode: 410 } }));
  assert.equal(a, b);
});

test('claves: un id recortado a 200 caracteres no provoca colisiones y la clave no depende del host', () => {
  const largo = (prefijoHost, final) => {
    const url = `${prefijoHost}/${'segmento-largo/'.repeat(9)}${'a'.repeat(20)}${final}`;
    return { ...inc('enlace', 'roto', url, 'alta', { evidencia: { url } }) };
  };
  const a1 = largo('https://staging.treidilor-ejemplo.com', '-uno');
  const a2 = largo('https://staging.treidilor-ejemplo.com', '-dos');
  assert.equal(a1.id.length, 200, 'el id está recortado');
  assert.equal(a1.id, a2.id, 'los dos ids recortados son IGUALES: así colisionaba el identificador antiguo');
  assert.notEqual(seg.claveSeguimiento(a1), seg.claveSeguimiento(a2), 'la clave nueva los distingue');
  // el mismo destino con un host corto (id sin recortar) da la misma clave que con el host largo (id recortado)
  const b1 = largo('https://treidilor.com', '-uno');
  assert.ok(b1.id.length < 200, 'con el host corto el id NO se recorta');
  assert.equal(seg.claveSeguimiento(a1), seg.claveSeguimiento(b1));
  assert.match(seg.claveSeguimiento(a1), /^enlace:roto:\/segmento-largo\/.{0,60}~[0-9a-f]{16}$/);
});

/* ───────────────────────── Instantánea ───────────────────────── */
test('instantánea: excluye avisos del entorno local, deduplica por clave (gravedad máxima) y es determinista', () => {
  const lista = [
    inc('enlace', 'roto', `${HOST}/a`, 'media'),
    inc('enlace', 'roto', `${HOST}/a/?utm_source=x`, 'alta'),
    inc('salud', 'sin_huella', null, 'media', { ambito: 'entorno_local' }),
    inc('catalogo', 'sin_precio', null, 'media', { evidencia: { total: 3 } }),
    inc('ruta', 'h1', '/', 'baja'),
  ];
  const a = seg.resumirInstantanea(informe(dia(0), lista));
  const b = seg.resumirInstantanea(informe(dia(0), [...lista].reverse()));
  assert.deepEqual(plano(a), plano(b), 'el orden de entrada no importa');
  assert.equal(a.incidencias.length, 3);
  const e = a.incidencias.find((i) => i.clave === 'enlace:roto:/a');
  assert.deepEqual([e.gravedad, e.ocurrencias], ['alta', 2]);
  assert.ok(!a.incidencias.some((i) => i.area === 'salud'), 'los avisos del entorno local no son incidencias');
  assert.equal(a.incidencias.find((i) => i.area === 'catalogo').cantidad, 3);
  assert.deepEqual(a.incidencias.map((i) => i.clave), ['enlace:roto:/a', 'catalogo:sin_precio', 'ruta:h1:/'], 'ordenadas por gravedad (alta, media, baja) y luego por clave');
});

test('calidad: completa, parcial (salud, feed, muchas peticiones sin respuesta) y fallida (sin respuestas); los topes voluntarios no hacen parcial', () => {
  const q = (lista, o) => seg.resumirInstantanea(informe(dia(0), lista, o)).calidad;
  assert.deepEqual(q([roto('/a')]), { estado: 'completa', motivos: [] });
  assert.equal(q([inc('salud', 'sin_datos', null, 'critica')], { alcance: alc({ salud: false }) }).estado, 'parcial', 'sin salud pero con otras respuestas');
  assert.deepEqual(q([inc('catalogo', 'feed_parcial', null)]).motivos, ['catalogo_no_leido_completo']);
  const muchos = Array.from({ length: 6 }, (_, i) => inc('enlace', 'sin_respuesta', `${HOST}/e${i}`, 'media'));
  assert.deepEqual(q(muchos, { peticiones: 20 }), { estado: 'parcial', motivos: ['muchas_peticiones_sin_respuesta'] });
  assert.equal(q(muchos.slice(0, 4), { peticiones: 20 }).estado, 'completa', '4 de 20 (20 %) no supera el umbral');
  const todos = [inc('salud', 'sin_respuesta', null, 'critica'), ...Array.from({ length: 4 }, (_, i) => inc('ruta', 'sin_respuesta', `/r${i}`, 'critica'))];
  assert.deepEqual(q(todos, { peticiones: 5, alcance: alc({ salud: false, rutas: [] }) }), { estado: 'fallida', motivos: ['sin_respuestas'] });
  assert.equal(q([], { peticiones: 0 }).estado, 'fallida');
  // topes voluntarios: el informe lo declara en cobertura, no en incidencias: sigue siendo completa
  assert.equal(q([inc('catalogo', 'revision_parcial', null, 'info')]).estado, 'completa');
});

/* ───────────────────────── Primera ejecución / línea base ───────────────────────── */
test('primera ejecución: línea base SIN incidencias nuevas, y se guarda como referencia', () => {
  const r = seg.ejecutarSeguimiento(null, informe(dia(0), [roto('/a'), roto('/b'), inc('ruta', 'h1', '/', 'baja')]));
  assert.equal(r.seguimiento.modo, 'linea_base');
  assert.equal(r.seguimiento.motivo, 'primera_ejecucion');
  assert.deepEqual(r.seguimiento.resumen, { actuales: 3, nuevas: 0, persistentes: 0, resueltas: 0, noVerificadas: 0, reaparecidas: 0, indeterminadas: 0, caducadas: 0 });
  assert.equal(r.siguiente.guardar, true);
  assert.equal(r.siguiente.revisionBase, 0);
  assert.equal(r.siguiente.estado.revision, 1);
  assert.equal(Object.keys(r.siguiente.estado.incidencias).length, 3);
  assert.deepEqual(validarEsquema(r.siguiente.estado, ESQ.estado()), []);
  assert.deepEqual(validarEsquema(r.seguimiento, ESQ.seguimiento()), []);
  assert.deepEqual(seg.validarEstado(r.siguiente.estado), { ok: true, motivo: null });
});

test('primera ejecución parcial o fallida: no hay referencia válida, así que NO se guarda nada', () => {
  const parcial = seg.ejecutarSeguimiento(null, informe(dia(0), [inc('salud', 'sin_datos', null, 'critica'), roto('/a')], { alcance: alc({ salud: false }) }));
  assert.equal(parcial.seguimiento.modo, 'linea_base');
  assert.equal(parcial.siguiente.guardar, false);
  assert.equal(parcial.siguiente.motivo, 'ejecucion_parcial');
  assert.equal(parcial.siguiente.estado, null);
  const fallida = seg.ejecutarSeguimiento(null, informe(dia(0), [inc('salud', 'sin_respuesta', null, 'critica')], { peticiones: 1, alcance: alc({ salud: false, rutas: [] }) }));
  assert.equal(fallida.seguimiento.modo, 'sin_comparar');
  assert.equal(fallida.seguimiento.motivo, 'ejecucion_fallida');
  assert.equal(fallida.siguiente.guardar, false);
});

test('línea base por: entorno distinto, host distinto, esquema incompatible, estado inválido y referencia antigua', () => {
  const base = seg.ejecutarSeguimiento(null, informe(dia(0), [roto('/a')])).siguiente.estado;
  const sig = (estado, inf) => seg.ejecutarSeguimiento(estado, inf).seguimiento;
  assert.equal(sig(base, informe(dia(1), [roto('/a')], { entorno: 'local' })).motivo, 'entorno_distinto');
  assert.equal(sig(base, informe(dia(1), [roto('/a')], { alcance: alc({ host: 'otro.example' }) })).motivo, 'host_distinto');
  assert.equal(sig({ ...base, esquema: 2 }, informe(dia(1), [roto('/a')])).motivo, 'esquema_incompatible');
  assert.equal(sig({ esquema: 1, algo: 'raro' }, informe(dia(1), [roto('/a')])).motivo, 'estado_invalido');
  assert.equal(sig('basura', informe(dia(1), [roto('/a')])).motivo, 'estado_invalido');
  assert.equal(sig(base, informe(dia(40), [roto('/a')])).motivo, 'anterior_antiguo');
  for (const m of [sig(base, informe(dia(1), [roto('/a')], { entorno: 'local' })), sig(base, informe(dia(40), [roto('/a')]))]) {
    assert.equal(m.modo, 'linea_base');
    assert.equal(m.resumen.nuevas, 0, 'una línea base nunca genera «nuevas»');
  }
});

/* ───────────────────────── Comparación ───────────────────────── */
function dosEjecuciones() {
  const r1 = seg.ejecutarSeguimiento(null, informe(dia(0), [roto('/a'), roto('/b'), inc('ruta', 'sin_titulo', '/', 'media')], { alcance: alc({ enlaces: ['/a', '/b'] }) }));
  const r2 = seg.ejecutarSeguimiento(r1.siguiente.estado, informe(dia(1), [roto('/a'), roto('/c')], { alcance: alc({ enlaces: ['/a', '/b', '/c'] }) }));
  return { r1, r2 };
}

test('comparación: nueva, persistente y resuelta (con evidencia de que el objetivo se revisó)', () => {
  const { r2 } = dosEjecuciones();
  const s = r2.seguimiento;
  assert.equal(s.modo, 'comparacion');
  assert.equal(s.comparadoCon, dia(0));
  assert.deepEqual(claves(s.nuevas), ['enlace:roto:/c']);
  assert.deepEqual(claves(s.persistentes), ['enlace:roto:/a']);
  assert.deepEqual(claves(s.resueltas), ['enlace:roto:/b', 'ruta:sin_titulo:/']);
  assert.deepEqual(s.noVerificadas, []);
  const p = s.persistentes[0];
  assert.deepEqual([p.desde, p.ejecuciones, p.cambioGravedad], [dia(0), 2, null]);
  const rb = s.resueltas.find((x) => x.clave === 'enlace:roto:/b');
  assert.deepEqual([rb.desde, rb.resueltaEn, rb.diasAbierta], [dia(0), dia(1), 1]);
  assert.deepEqual(validarEsquema(s, ESQ.seguimiento()), []);
});

test('NO se declara resuelta sin evidencia: sin alcance, objetivo no revisado, salud o catálogo no leídos → «no verificada»', () => {
  const prev = seg.ejecutarSeguimiento(null, informe(dia(0), [roto('/a'), inc('ruta', 'h1', '/catalogo', 'baja'), inc('salud', 'sin_smtp', null, 'baja'), inc('catalogo', 'sin_precio', null, 'media', { evidencia: { total: 2 } }), inc('ficha', 'no_encontrada', 'p3', 'alta')])).siguiente.estado;
  const motivos = (inf) => Object.fromEntries(seg.ejecutarSeguimiento(prev, inf).seguimiento.noVerificadas.map((x) => [x.clave, x.motivo]));
  // 1) informe actual SIN alcance (informe antiguo): nada se puede afirmar
  const sinAlcance = seg.ejecutarSeguimiento(prev, informe(dia(1), [], { alcance: null })).seguimiento;
  assert.equal(sinAlcance.resueltas.length, 0);
  assert.equal(sinAlcance.noVerificadas.length, 5);
  assert.ok(sinAlcance.noVerificadas.every((x) => x.motivo === 'sin_alcance'));
  // 2) alcance que no incluye los objetivos / no lee salud ni catálogo
  assert.deepEqual(motivos(informe(dia(1), [], { alcance: alc({ salud: false, rutas: ['/'], enlaces: [] }) })), {
    'enlace:roto:/a': 'objetivo_no_revisado', 'ruta:h1:/catalogo': 'objetivo_no_revisado', 'salud:sin_smtp': 'salud_no_leida', 'catalogo:sin_precio': 'catalogo_no_leido_completo', 'ficha:no_encontrada:p3': 'objetivo_no_revisado',
  });
  // 3) con el alcance completo sí se resuelven todas
  const todo = seg.ejecutarSeguimiento(prev, informe(dia(1), [], { alcance: alc({ rutas: ['/', '/catalogo'], enlaces: ['/a'], fichas: ['p3'], catalogo: { leido: true, completo: true } }) })).seguimiento;
  assert.equal(todo.resueltas.length, 5);
  assert.equal(todo.noVerificadas.length, 0);
  // 4) catálogo leído pero con revisión parcial (completo:false) → no verificada
  assert.equal(motivos(informe(dia(1), [], { alcance: alc({ rutas: ['/', '/catalogo'], enlaces: ['/a'], fichas: ['p3'], catalogo: { leido: true, completo: false } }) }))['catalogo:sin_precio'], 'catalogo_no_leido_completo');
});

test('contenido de una página que ahora da error HTTP: no se puede decir que el título/h1 se arregló', () => {
  const prev = seg.ejecutarSeguimiento(null, informe(dia(0), [inc('ruta', 'sin_titulo', '/guia', 'media'), inc('ruta', 'h1', '/guia', 'baja')], { alcance: alc({ rutas: ['/guia'] }) })).siguiente.estado;
  const s = seg.ejecutarSeguimiento(prev, informe(dia(1), [inc('ruta', 'no_encontrada', '/guia', 'alta')], { alcance: alc({ rutas: ['/guia'] }) })).seguimiento;
  assert.deepEqual(claves(s.nuevas), ['ruta:no_encontrada:/guia']);
  assert.deepEqual(claves(s.noVerificadas), ['ruta:h1:/guia', 'ruta:sin_titulo:/guia']);
  assert.ok(s.noVerificadas.every((x) => x.motivo === 'pagina_con_error'));
  assert.equal(s.resueltas.length, 0);
});

test('cambios de gravedad y de cantidad en incidencias persistentes', () => {
  const g0 = informe(dia(0), [inc('catalogo', 'sin_precio', null, 'media', { evidencia: { total: 3 } }), roto('/a', 'media')]);
  const g1 = informe(dia(1), [inc('catalogo', 'sin_precio', null, 'alta', { evidencia: { total: 8 } }), roto('/a', 'baja')]);
  const s = seg.ejecutarSeguimiento(seg.ejecutarSeguimiento(null, g0).siguiente.estado, g1).seguimiento;
  const cat = s.persistentes.find((x) => x.area === 'catalogo');
  assert.deepEqual([cat.cambioGravedad, cat.gravedadAnterior, cat.gravedad, cat.variacionCantidad], ['empeora', 'media', 'alta', 5]);
  const en = s.persistentes.find((x) => x.area === 'enlace');
  assert.deepEqual([en.cambioGravedad, en.variacionCantidad], ['mejora', null]);
});

test('reaparecida: vuelve dentro de la ventana tras resolverse; fuera de la ventana es una nueva', () => {
  const ciclo = (diasAusente) => {
    const e = seg.ejecutarSeguimiento(null, informe(dia(0), [roto('/a')], { alcance: alc({ enlaces: ['/a'] }) })).siguiente.estado;
    const r = seg.ejecutarSeguimiento(e, informe(dia(1), [], { alcance: alc({ enlaces: ['/a'] }) }));
    assert.deepEqual(claves(r.seguimiento.resueltas), ['enlace:roto:/a']);
    assert.equal(r.siguiente.estado.resueltasRecientes.length, 1);
    // ejecuciones intermedias cada 7 días SIN la incidencia (con un hueco de 20 días la referencia ya sería «antigua» y daría línea base)
    let estado = r.siguiente.estado;
    for (let d = 8; d < 1 + diasAusente; d += 7) estado = seg.ejecutarSeguimiento(estado, informe(dia(d), [], { alcance: alc({ enlaces: ['/a'] }) })).siguiente.estado;
    return seg.ejecutarSeguimiento(estado, informe(dia(1 + diasAusente), [roto('/a')], { alcance: alc({ enlaces: ['/a'] }) }));
  };
  const dentro = ciclo(3).seguimiento;
  assert.deepEqual(claves(dentro.reaparecidas), ['enlace:roto:/a']);
  assert.equal(dentro.reaparecidas[0].reapariciones, 1);
  assert.equal(dentro.nuevas.length, 0);
  const fuera = ciclo(20);
  assert.equal(fuera.seguimiento.reaparecidas.length, 0);
  assert.deepEqual(claves(fuera.seguimiento.nuevas), ['enlace:roto:/a']);
  // y el estado recuerda las reapariciones
  assert.equal(ciclo(3).siguiente.estado.incidencias['enlace:roto:/a'].reapariciones, 1);
});

test('«no verificada» se conserva en el estado y caduca si pasan demasiadas ejecuciones sin revisarla', () => {
  let estado = seg.ejecutarSeguimiento(null, informe(dia(0), [roto('/a')])).siguiente.estado;
  const sinRevisar = (n) => informe(dia(n), [], { alcance: alc({ enlaces: [] }) });
  for (let n = 1; n <= 7; n++) {
    const r = seg.ejecutarSeguimiento(estado, sinRevisar(n));
    assert.deepEqual(claves(r.seguimiento.noVerificadas), ['enlace:roto:/a'], `ejecución ${n}`);
    assert.equal(r.seguimiento.noVerificadas[0].sinVerificar, n);
    assert.equal(r.siguiente.guardar, true);
    estado = r.siguiente.estado;
    assert.ok('enlace:roto:/a' in estado.incidencias, 'se conserva');
    assert.equal(estado.incidencias['enlace:roto:/a'].ultimaVez, dia(0), 'sin verificar no actualiza «ultimaVez»');
  }
  const r8 = seg.ejecutarSeguimiento(estado, sinRevisar(8));
  assert.deepEqual(claves(r8.seguimiento.caducadas), ['enlace:roto:/a']);
  assert.ok(!('enlace:roto:/a' in r8.siguiente.estado.incidencias));
  // y si la incidencia sigue ahí cuando se vuelve a revisar, es persistente (no «nueva»)
  const vuelve = seg.ejecutarSeguimiento(estado, informe(dia(8), [roto('/a')], { alcance: alc({ enlaces: ['/a'] }) })).seguimiento;
  assert.deepEqual(claves(vuelve.persistentes), ['enlace:roto:/a']);
  assert.equal(vuelve.persistentes[0].ejecuciones, 2);
  assert.equal(vuelve.persistentes[0].desde, dia(0));
});

test('ejecución FALLIDA: sin comparar, sin guardar y el estado anterior queda intacto', () => {
  const estado = seg.ejecutarSeguimiento(null, informe(dia(0), [roto('/a')])).siguiente.estado;
  const copia = plano(estado);
  const caida = [inc('salud', 'sin_respuesta', null, 'critica'), inc('ruta', 'sin_respuesta', '/', 'critica'), inc('ruta', 'sin_respuesta', '/catalogo', 'critica')];
  const r = seg.ejecutarSeguimiento(estado, informe(dia(1), caida, { peticiones: 3, alcance: alc({ salud: false, rutas: [] }) }));
  assert.equal(r.seguimiento.modo, 'sin_comparar');
  assert.equal(r.seguimiento.motivo, 'ejecucion_fallida');
  assert.equal(r.seguimiento.resumen.resueltas, 0, 'una caída del servidor no resuelve nada');
  assert.equal(r.siguiente.guardar, false);
  assert.deepEqual(plano(r.siguiente.estado), copia);
});

test('ejecución PARCIAL: se compara pero NO sustituye la última referencia válida', () => {
  const estado = seg.ejecutarSeguimiento(null, informe(dia(0), [roto('/a'), roto('/b')], { alcance: alc({ enlaces: ['/a', '/b'] }) })).siguiente.estado;
  const copia = plano(estado);
  const parcial = informe(dia(1), [roto('/a'), inc('catalogo', 'feed_parcial', null, 'media')], { alcance: alc({ enlaces: ['/a'] }) });
  const r = seg.ejecutarSeguimiento(estado, parcial);
  assert.equal(r.instantanea.calidad.estado, 'parcial');
  assert.equal(r.seguimiento.modo, 'comparacion');
  assert.deepEqual(claves(r.seguimiento.persistentes), ['enlace:roto:/a']);
  assert.deepEqual(claves(r.seguimiento.noVerificadas), ['enlace:roto:/b'], '/b no se revisó: no verificada, no resuelta');
  assert.equal(r.siguiente.guardar, false);
  assert.equal(r.siguiente.motivo, 'ejecucion_parcial');
  assert.deepEqual(plano(r.siguiente.estado), copia);
});

test('orden de fechas: una auditoría igual o anterior a la referencia no se compara ni se guarda', () => {
  const estado = seg.ejecutarSeguimiento(null, informe(dia(2), [roto('/a')])).siguiente.estado;
  for (const gen of [dia(2), dia(1), dia(2, -1)]) {
    const r = seg.ejecutarSeguimiento(estado, informe(gen, [roto('/a')]));
    assert.deepEqual([r.seguimiento.modo, r.seguimiento.motivo, r.siguiente.guardar], ['sin_comparar', 'orden_invalido', false], gen);
  }
  assert.equal(seg.ejecutarSeguimiento(estado, { incidencias: 'no' }).seguimiento.motivo, 'instantanea_invalida');
  assert.equal(seg.ejecutarSeguimiento(estado, informe('no-es-fecha', [])).seguimiento.motivo, 'instantanea_invalida');
});

test('duplicados: la misma incidencia repetida (también con otra URL equivalente) cuenta una sola vez', () => {
  const dup = [roto('/a'), { ...roto('/a'), id: 'enlace:roto:https://treidilor.com/a/?utm_medium=x' }, roto('/a', 'media')];
  const r = seg.ejecutarSeguimiento(null, informe(dia(0), dup));
  assert.equal(r.instantanea.incidencias.length, 1);
  assert.equal(r.instantanea.incidencias[0].ocurrencias, 3);
  assert.equal(r.seguimiento.resumen.actuales, 1);
  assert.equal(Object.keys(r.siguiente.estado.incidencias).length, 1);
});

/* ───────────────────────── Determinismo, inmutabilidad y compatibilidad ───────────────────────── */
function congelar(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const v of Object.values(x)) congelar(v); }
  return x;
}

test('determinismo: el mismo estado y el mismo informe dan el mismo resultado (sin importar el orden) y las entradas no se mutan', () => {
  const lista0 = [roto('/a'), roto('/b'), inc('ruta', 'h1', '/', 'baja'), inc('catalogo', 'sin_precio', null, 'media', { evidencia: { total: 4 } })];
  const lista1 = [roto('/a'), roto('/c'), inc('ruta', 'h1', '/', 'baja'), inc('catalogo', 'sin_precio', null, 'media', { evidencia: { total: 6 } })];
  const estado = seg.ejecutarSeguimiento(null, informe(dia(0), lista0, { alcance: alc({ enlaces: ['/a', '/b'], catalogo: { leido: true, completo: true } }) })).siguiente.estado;
  const inf1 = informe(dia(1), lista1, { alcance: alc({ enlaces: ['/a', '/b', '/c'], catalogo: { leido: true, completo: true } }) });
  const a = plano(seg.ejecutarSeguimiento(congelar(plano(estado)), congelar(plano(inf1))));
  const b = plano(seg.ejecutarSeguimiento(plano(estado), { ...plano(inf1), incidencias: [...inf1.incidencias].reverse() }));
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'también el orden de las claves del JSON es estable');
  // idempotencia lógica: comparar un informe con su propio resultado (misma lista, otro día) deja todo persistente
  const sig = seg.ejecutarSeguimiento(a.siguiente.estado, informe(dia(2), lista1, { alcance: alc({ enlaces: ['/a', '/b', '/c'], catalogo: { leido: true, completo: true } }) }));
  assert.equal(sig.seguimiento.resumen.nuevas + sig.seguimiento.resumen.resueltas + sig.seguimiento.resumen.noVerificadas, 0);
  assert.equal(sig.seguimiento.resumen.persistentes, lista1.length);
  assert.ok(sig.seguimiento.persistentes.every((p) => p.ejecuciones === 3 || p.ejecuciones === 2));
});

test('compatibilidad: informes anteriores (sin alcance, sin consumo) se aceptan como «anterior» y como «actual»; las instantáneas sueltas también se comparan', () => {
  const antiguo = informe(dia(0), [roto('/a'), roto('/b')], { alcance: null });
  delete antiguo.resumen.paginasCatalogo;
  const r1 = seg.ejecutarSeguimiento(null, antiguo);
  assert.equal(r1.seguimiento.modo, 'linea_base');
  assert.equal(r1.siguiente.guardar, true, 'un informe antiguo completo sirve de línea base');
  const r2 = seg.ejecutarSeguimiento(r1.siguiente.estado, informe(dia(1), [roto('/a'), roto('/z')], { alcance: alc({ enlaces: ['/a', '/b', '/z'] }) }));
  assert.deepEqual([claves(r2.seguimiento.persistentes), claves(r2.seguimiento.nuevas), claves(r2.seguimiento.resueltas)], [['enlace:roto:/a'], ['enlace:roto:/z'], ['enlace:roto:/b']]);
  // instantáneas sueltas (sin historial)
  const i0 = seg.resumirInstantanea(informe(dia(0), [roto('/a')]));
  const i1 = seg.resumirInstantanea(informe(dia(1), [roto('/a'), roto('/n')], { alcance: alc({ enlaces: ['/a', '/n'] }) }));
  const s = seg.compararInstantaneas(i0, i1);
  assert.deepEqual([claves(s.persistentes), claves(s.nuevas)], [['enlace:roto:/a'], ['enlace:roto:/n']]);
  assert.equal(seg.compararInstantaneas(null, i1).motivo, 'primera_ejecucion');
  // el esquema del informe acepta el alcance y el seguimiento (opcionales) y sigue aceptando los informes sin ellos
  const real = ejecutarProduccionSimulada();
  assert.deepEqual(validarEsquema(real, ESQ.informe()), []);
  const conSeg = { ...plano(real), alcance: alc(), seguimiento: r2.seguimiento };
  assert.deepEqual(validarEsquema(conSeg, ESQ.informe()), []);
  assert.ok(validarEsquema({ ...conSeg, seguimiento: { ...r2.seguimiento, modo: 'inventado' } }, ESQ.informe()).length > 0);
});

function ejecutarProduccionSimulada() {
  const wf = J('automation/workflows/auditor-general.produccion.json');
  const pagina = (links = []) => `<!doctype html><html><head><title>t</title></head><body><h1>x</h1>${links.map((h) => `<a href="${h}">l</a>`).join('')}<p>${'z'.repeat(2500)}</p></body></html>`;
  const fetchSimulado = ({ url }) => {
    const u = new URL(url);
    if (u.pathname === '/api/health') return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { status: 'ok', sourceHash: 'a'.repeat(64), uptimeSeconds: 9000, dataDirExists: true, env: { smtp: true } } };
    if (u.pathname === '/') return { statusCode: 200, body: pagina(['/guia/1', '/roto']) };
    if (u.pathname === '/roto') return { statusCode: 404, body: 'no' };
    return { statusCode: 200, body: pagina() };
  };
  const r = simularWorkflow(wf, { fetchSimulado, ahora: '2026-11-12T10:00:00.000Z', hostsPermitidos: ['treidilor.com'] });
  return plano(r.salida[0].json);
}

test('con un informe REAL del Auditor (simulado): línea base, y una segunda auditoría detecta la incidencia resuelta con el alcance', () => {
  const real = ejecutarProduccionSimulada();
  assert.ok(real.incidencias.some((i) => i.id.startsWith('enlace:roto:')));
  const r1 = seg.ejecutarSeguimiento(null, real);
  assert.equal(r1.seguimiento.modo, 'linea_base');
  const claveRota = r1.instantanea.incidencias.find((i) => i.area === 'enlace').clave;
  assert.equal(claveRota, 'enlace:roto:/roto');
  // el siguiente día el enlace ya no está roto y se revisó (alcance construido como lo emitirá el Auditor en 2b)
  const manana = { ...real, generadoEn: '2026-11-13T10:00:00.000Z', incidencias: real.incidencias.filter((i) => !i.id.startsWith('enlace:roto:')), alcance: alc({ rutas: ['/', '/catalogo', '/categorias', '/metodologia'], enlaces: ['/guia/1', '/roto'] }) };
  const r2 = seg.ejecutarSeguimiento(r1.siguiente.estado, manana);
  assert.deepEqual(claves(r2.seguimiento.resueltas), ['enlace:roto:/roto']);
});

/* ───────────────────────── Límites de tamaño ───────────────────────── */
test('límites: el estado no supera el máximo de incidencias ni de bytes y conserva las más graves', () => {
  const muchas = Array.from({ length: 300 }, (_, i) => inc('enlace', 'roto', `${HOST}/p/${String(i).padStart(3, '0')}`, i < 5 ? 'critica' : 'baja'));
  const r = seg.ejecutarSeguimiento(null, informe(dia(0), muchas, { peticiones: 400 }));
  const e = r.siguiente.estado;
  assert.equal(Object.keys(e.incidencias).length, 200);
  assert.deepEqual(e.recortado, { conservadas: 200, omitidas: 100 });
  for (let i = 0; i < 5; i++) assert.ok(`enlace:roto:/p/00${i}` in e.incidencias, 'las críticas se conservan');
  assert.ok(Buffer.byteLength(JSON.stringify(e)) <= seg.LIMITES_SEGUIMIENTO.maxBytesEstado);
  assert.deepEqual(validarEsquema(e, ESQ.estado()), []);
  // límite de bytes pequeño: se recorta por tamaño y sigue siendo válido
  const pequeno = seg.ejecutarSeguimiento(null, informe(dia(0), muchas, { peticiones: 400 }), { limites: { maxBytesEstado: 4000 } }).siguiente.estado;
  assert.ok(Buffer.byteLength(JSON.stringify(pequeno)) <= 4000);
  assert.ok(pequeno.recortado.omitidas > 100);
  assert.deepEqual(validarEsquema(pequeno, ESQ.estado()), []);
  assert.deepEqual(seg.validarEstado(pequeno), { ok: true, motivo: null });
  // las resueltas recientes también están acotadas
  const prev = seg.ejecutarSeguimiento(null, informe(dia(0), Array.from({ length: 50 }, (_, i) => roto(`/r/${i}`)), { alcance: alc({ enlaces: Array.from({ length: 50 }, (_, i) => `/r/${i}`) }) })).siguiente.estado;
  const res = seg.ejecutarSeguimiento(prev, informe(dia(1), [], { alcance: alc({ enlaces: Array.from({ length: 50 }, (_, i) => `/r/${i}`) }) }));
  assert.equal(res.seguimiento.resumen.resueltas, 50);
  assert.equal(res.siguiente.estado.resueltasRecientes.length, 30);
});

test('el estado sólo guarda claves públicas, gravedades y fechas: nada de evidencias, textos, HTML ni secretos', () => {
  const sensible = inc('enlace', 'roto', `${HOST}/a`, 'alta', { titulo: 'TÍTULO-SENSIBLE', detalle: 'DETALLE-SENSIBLE Bearer abc', evidencia: { url: `${HOST}/a`, secreto: 'SECRETO-123', cuerpo: '<html>HTML-SENSIBLE</html>' } });
  const texto = JSON.stringify(seg.ejecutarSeguimiento(null, informe(dia(0), [sensible])).siguiente.estado);
  for (const prohibido of ['SENSIBLE', 'SECRETO', 'Bearer', '<html>', 'titulo', 'detalle', 'evidencia', 'accionSugerida', 'markdown']) assert.ok(!texto.includes(prohibido), prohibido);
});

/* ───────────────────────── Concurrencia (capa de persistencia futura) ───────────────────────── */
test('concurrencia: la escritura sólo es válida si la revisión y el orden coinciden; el recálculo tras un conflicto es determinista', () => {
  const base = seg.ejecutarSeguimiento(null, informe(dia(0), [roto('/a')], { alcance: alc({ enlaces: ['/a', '/b'] }) })).siguiente;
  assert.deepEqual(seg.validarEscritura(null, base), { ok: true, motivo: null }, 'primera escritura sobre un almacén vacío');
  const almacenado0 = base.estado;
  // dos ejecuciones concurrentes leen el MISMO estado (revisión 1) y calculan su siguiente estado
  const A = seg.ejecutarSeguimiento(almacenado0, informe(dia(1), [roto('/a'), roto('/b')], { alcance: alc({ enlaces: ['/a', '/b'] }) }));
  const B = seg.ejecutarSeguimiento(almacenado0, informe(dia(1, 2), [roto('/a')], { alcance: alc({ enlaces: ['/a', '/b'] }) }));
  assert.equal(A.siguiente.revisionBase, 1);
  assert.equal(B.siguiente.revisionBase, 1);
  assert.equal(seg.validarEscritura(almacenado0, A.siguiente).ok, true);
  let almacen = A.siguiente.estado; // A escribe primero
  const conflicto = seg.validarEscritura(almacen, B.siguiente);
  assert.deepEqual(conflicto, { ok: false, motivo: 'conflicto_revision', revisionAlmacenada: 2 });
  // B relee el estado de A y recalcula con el mismo informe: ahora es válido y consistente con A
  const B2 = seg.ejecutarSeguimiento(almacen, informe(dia(1, 2), [roto('/a')], { alcance: alc({ enlaces: ['/a', '/b'] }) }));
  assert.equal(B2.siguiente.revisionBase, 2);
  assert.deepEqual(seg.validarEscritura(almacen, B2.siguiente), { ok: true, motivo: null });
  assert.deepEqual(claves(B2.seguimiento.resueltas), ['enlace:roto:/b'], 'B ve la incidencia que A acababa de registrar y la resuelve');
  // y una ejecución más antigua que el estado almacenado no puede escribir aunque la revisión coincida
  const vieja = { guardar: true, revisionBase: 2, estado: { ...B2.siguiente.estado, ultimaInstantanea: { ...B2.siguiente.estado.ultimaInstantanea, generadoEn: dia(0, 5) } } };
  assert.deepEqual(seg.validarEscritura(almacen, vieja), { ok: false, motivo: 'orden_invalido' });
  assert.deepEqual(seg.validarEscritura(almacen, { guardar: false }), { ok: false, motivo: 'nada_que_guardar' });
  assert.equal(seg.ejecutarSeguimiento(almacen, informe(dia(1, 2), [roto('/a')], { alcance: alc({ enlaces: ['/a', '/b'] }) })).siguiente.estado.revision, 3);
});

/* ───────────────────────── Incrustación futura en n8n y workflows intactos ───────────────────────── */
test('el módulo es incrustable en un nodo Code (sin URL, structuredClone ni Buffer; sin colisiones de nombres) y da los mismos resultados', () => {
  const fuente = fs.readFileSync(path.join(RAIZ, 'automation/lib/seguimiento.mjs'), 'utf8');
  const sinComentarios = fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const prohibido of [/\bnew\s+URL\b/, /URLSearchParams/, /structuredClone/, /\bBuffer\b/, /\bTextEncoder\b/, /\brequire\s*\(/, /\bprocess\b/, /\bfetch\s*\(/, /\bDate\.now\b/, /\bnew\s+Date\b/, /Math\.random/, /export\s+default/]) assert.doesNotMatch(sinComentarios, prohibido, String(prohibido));
  const paquete = ['common', 'urlPolicy', 'seguimiento', 'auditor'].map((m) => `// ── ${m} ──\n${fuenteModulo(m)}`).join('\n\n');
  const contexto = { JSON, Math, Number, String, Array, Object, Map, Set, RegExp, Error, Date, Intl, Boolean };
  vm.createContext(contexto);
  const f = vm.runInContext(`(function () {\n${paquete}\nreturn { ejecutarSeguimiento, resumirInstantanea, claveSeguimiento };\n})()`, contexto, { timeout: 5000 });
  assert.equal(typeof contexto.URL, 'undefined');
  const e0 = informe(dia(0), [roto('/a'), roto('/b')], { alcance: alc({ enlaces: ['/a', '/b'] }) });
  const e1 = informe(dia(1), [roto('/a'), roto('/c')], { alcance: alc({ enlaces: ['/a', '/b', '/c'] }) });
  const dentro0 = plano(f.ejecutarSeguimiento(null, plano(e0)));
  const dentro1 = plano(f.ejecutarSeguimiento(dentro0.siguiente.estado, plano(e1)));
  const fuera0 = plano(seg.ejecutarSeguimiento(null, e0));
  const fuera1 = plano(seg.ejecutarSeguimiento(fuera0.siguiente.estado, e1));
  assert.deepEqual(dentro0, fuera0);
  assert.deepEqual(dentro1, fuera1);
  assert.equal(f.claveSeguimiento({ id: 'enlace:roto:https://x.example/a/?utm_source=1', area: 'enlace' }), 'enlace:roto:/a');
});

test('workflows regenerados (2b): sincronizados con su código y con el motor de seguimiento incrustado en el Auditor y el diagnóstico', () => {
  const generado = construirTodo();
  for (const [f, texto] of Object.entries(generado)) {
    assert.equal(fs.readFileSync(path.join(RAIZ, 'automation/workflows', f), 'utf8').replace(/\r\n/g, '\n'), texto, `${f} sincronizado`);
    // el Auditor incrusta el seguimiento y el alcance; el Investigador no necesita nada de eso y el constructor lo poda
    if (f.startsWith('auditor-general')) assert.ok(texto.includes('compararConEstado') && texto.includes('calcularAlcance'), `${f} incrusta el seguimiento y el alcance`);
    else assert.ok(!texto.includes('compararConEstado'), `${f} no incrusta el seguimiento`);
  }
  for (const [f, texto] of Object.entries(construirDiagnosticos())) {
    assert.equal(fs.readFileSync(path.join(RAIZ, 'automation/dev', f), 'utf8').replace(/\r\n/g, '\n'), texto, `${f} sincronizado`);
  }
});
