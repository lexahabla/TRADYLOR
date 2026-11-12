// Treidilor AI · Auditor General v0.2: consumo de cada ejecución (MEDIDO ≠ ESTIMADO), escenarios de tope de enlaces y compatibilidad de informes.
// Sin red, sin n8n, sin tocar datos reales: se ejecuta el workflow GENERADO de producción en el simulador con un sitio sintético.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const J = (p) => JSON.parse(fs.readFileSync(path.join(RAIZ, p), 'utf8'));
const aud = await import('../../automation/lib/auditor.mjs');
const common = await import('../../automation/lib/common.mjs');
const { simularWorkflow } = await import('../automation/simulate-workflow.mjs');
const { validarEsquema } = await import('../automation/validate-schema.mjs');

const PROD = J('automation/config/produccion.json');
const NOW = '2026-11-12T10:00:00.000Z';
const ESQUEMA = () => J('automation/schemas/informe-auditor.schema.json');
const plano = (x) => JSON.parse(JSON.stringify(x));
const bytesDe = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');
const SALUD = { status: 'ok', sourceHash: 'a'.repeat(64), uptimeSeconds: 9000, dataDirExists: true, env: { smtp: true } };
const BYTES_SALUD = bytesDe(JSON.stringify(SALUD));

const relleno = 'x'.repeat(2500);
const html = (titulo, h1, enlaces = []) => `<!doctype html><html><head><title>${titulo}</title></head><body><h1>${h1}</h1>${enlaces.map((h) => `<a href="${h}">l</a>`).join('')}<p>${relleno}</p></body></html>`;

// Sitio con muchos enlaces de tamaño distinto y de varias secciones: permite comprobar el cálculo exacto de los escenarios.
function sitioGrande(secciones, porSeccion) {
  const tamanos = new Map();
  const enlaces = [];
  for (const s of secciones) for (let i = 1; i <= porSeccion; i++) enlaces.push(`/${s}/${String(i).padStart(2, '0')}`);
  const fetchSimulado = ({ url }) => {
    const u = new URL(url);
    if (u.pathname === '/api/health') return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: SALUD };
    let cuerpo;
    if (u.pathname === '/') cuerpo = html('Treidilor', 'Compra con datos', enlaces);
    else if (['/catalogo', '/categorias', '/metodologia'].includes(u.pathname)) cuerpo = html(u.pathname, u.pathname);
    else cuerpo = `<!doctype html><html><head><title>t</title></head><body><h1>Ficha ñ 😀</h1><p>${'y'.repeat(1000 + (u.pathname.length * 37 + Number(u.pathname.slice(-2))) * 10)}</p></body></html>`;
    tamanos.set(url, bytesDe(cuerpo));
    return { statusCode: 200, body: cuerpo };
  };
  return { fetchSimulado, tamanos, enlaces };
}

function ejecutarProduccion(fetchSimulado, { maxEnlaces } = {}) {
  const wf = J('automation/workflows/auditor-general.produccion.json');
  if (maxEnlaces !== undefined) {
    for (const n of wf.nodes) if (n.type === 'n8n-nodes-base.code') n.parameters.jsCode = n.parameters.jsCode.replace(/"maxEnlaces": \d+/, `"maxEnlaces": ${maxEnlaces}`);
  }
  const r = simularWorkflow(wf, { fetchSimulado, ahora: NOW, hostsPermitidos: PROD.hostsPermitidos });
  return { ...r, informe: plano(r.salida[0].json) };
}

test('bytesUtf8 coincide con Buffer.byteLength (ASCII, tildes, símbolos, emoji y sustitutos sueltos)', () => {
  for (const s of ['', 'abc', 'Cómo trabajamos — Catálogo', '€ 12,50 · ñandú', '日本語', 'emoji 😀🎧 fin', 'suelto \ud83d fin', 'x'.repeat(5000)]) {
    assert.equal(common.bytesUtf8(s), bytesDe(s), JSON.stringify(s).slice(0, 30));
  }
  assert.equal(common.bytesUtf8(null), 0);
  assert.equal(common.bytesUtf8(undefined), 0);
});

test('formatearBytes: formato fijo en B, KB y MB', () => {
  assert.equal(aud.formatearBytes(0), '0 B');
  assert.equal(aud.formatearBytes(1023), '1023 B');
  assert.equal(aud.formatearBytes(1536), '1,5 KB');
  assert.equal(aud.formatearBytes(1048576 * 2.5), '2,50 MB');
});

test('el informe trae «medido» y «estimado» separados, con valores exactos y la estimación rotulada como tal', () => {
  const { fetchSimulado, tamanos } = sitioGrande(['guia', 'marca', 'oferta'], 8);
  const { informe, peticiones, salidas } = ejecutarProduccion(fetchSimulado);
  const c = informe.consumo;
  assert.ok(c, 'el informe incluye consumo');
  assert.deepEqual(validarEsquema(informe, ESQUEMA()), []);
  // medido: coincide con los bytes reales de los cuerpos servidos (salud incluida) y con el nº de peticiones
  assert.equal(c.peticiones, peticiones.length);
  assert.equal(c.medido.bytesRecibidos, [...tamanos.values()].reduce((a, b) => a + b, 0) + BYTES_SALUD);
  assert.equal(c.medido.porTipo.salud.peticiones, 1);
  assert.equal(c.medido.porTipo.ruta.peticiones, 4);
  // páginas más pesadas: ≤ 5, de mayor a menor y todas realmente pedidas
  assert.ok(c.medido.paginasMasPesadas.length > 0 && c.medido.paginasMasPesadas.length <= 5);
  const pesos = c.medido.paginasMasPesadas.map((p) => p.bytes);
  assert.deepEqual(pesos, [...pesos].sort((a, b) => b - a));
  const pedidas = new Set(peticiones.map((p) => p.url));
  assert.ok(c.medido.paginasMasPesadas.every((p) => pedidas.has(p.destino)));
  // estimado: es una estimación declarada, no una medición; ≥ lo medido y sin exagerar respecto del tamaño JSON de todas las salidas
  assert.equal(c.estimado.esEstimacion, true);
  assert.match(c.estimado.metodo, /ESTIMACI[ÓO]N, no medici[óo]n/);
  assert.ok(c.estimado.bytesHistorial >= c.medido.bytesRecibidos, 'el tamaño serializado no puede ser menor que el cuerpo');
  const bruto = [...salidas.values()].flat().reduce((n, i) => n + bytesDe(JSON.stringify(i.json)), 0);
  assert.ok(c.estimado.bytesHistorial <= bruto + 4096, 'no exagera respecto del tamaño JSON de las salidas del workflow');
  // Markdown: ambos apartados, claramente distinguidos
  assert.match(informe.markdown, /## Consumo/);
  assert.match(informe.markdown, /\*\*Medido:\*\*/);
  assert.match(informe.markdown, /\*\*Estimado \(NO medido\):\*\*/);
  assert.match(informe.markdown, /Páginas más pesadas/);
});

test('escenarios de 10, 20 y 40 enlaces con las respuestas reales: exactos, monótonos y con secciones cubiertas', () => {
  const { fetchSimulado, tamanos, enlaces } = sitioGrande(['a-guia', 'b-marca', 'c-oferta', 'd-prueba', 'e-ayuda'], 12); // 60 enlaces
  const { informe, peticiones } = ejecutarProduccion(fetchSimulado);
  const c = informe.consumo;
  assert.equal(enlaces.length, 60);
  assert.deepEqual(c.presupuesto, { maxEnlaces: 40, enlacesDescubiertos: 60, enlacesPedidos: 40, enlacesOmitidosPorTope: 20 });
  assert.deepEqual(c.escenarios.map((e) => e.maxEnlaces), [10, 20, 40]);
  assert.ok(c.escenarios.every((e) => e.calculable));
  // exactitud: los N primeros enlaces (orden estable) son los que se habrían pedido
  const orden = peticiones.filter((p) => p.nodo === 'Pedir enlaces').map((p) => p.url);
  const fijos = [...tamanos.entries()].filter(([u]) => !orden.includes(u)).reduce((n, [, b]) => n + b, 0) + BYTES_SALUD;
  for (const e of c.escenarios) {
    const n = e.maxEnlaces;
    assert.equal(e.enlaces, n);
    assert.equal(e.peticiones, 5 + n);
    assert.equal(e.bytesRecibidos, fijos + orden.slice(0, n).reduce((acc, u) => acc + tamanos.get(u), 0), `bytes con tope ${n}`);
  }
  // el escenario del tope vigente (40) coincide con el total de la ejecución
  assert.equal(c.escenarios[2].bytesRecibidos, c.medido.bytesRecibidos);
  assert.equal(c.escenarios[2].peticiones, c.peticiones);
  assert.equal(c.escenarios[2].bytesHistorialEstimado, c.estimado.bytesHistorial);
  // monotonía y cobertura
  const [e10, e20, e40] = c.escenarios;
  assert.ok(e10.peticiones < e20.peticiones && e20.peticiones < e40.peticiones);
  assert.ok(e10.bytesRecibidos < e20.bytesRecibidos && e20.bytesRecibidos < e40.bytesRecibidos);
  assert.ok(e10.bytesHistorialEstimado < e20.bytesHistorialEstimado && e20.bytesHistorialEstimado < e40.bytesHistorialEstimado);
  assert.ok(e10.familiasCubiertas <= e20.familiasCubiertas && e20.familiasCubiertas <= e40.familiasCubiertas);
  assert.equal(e40.familiasDescubiertas, 5);
  assert.equal(e10.familiasCubiertas, 1, 'con el orden alfabético, 10 enlaces cubren una sola sección (limitación conocida, ver documentación)');
});

test('con un tope menor que el escenario, ese escenario no es «calculable» (no se inventan cifras) y el tope vigente se respeta', () => {
  const { fetchSimulado } = sitioGrande(['guia', 'marca'], 20); // 40 enlaces descubiertos
  const { informe, peticiones } = ejecutarProduccion(fetchSimulado, { maxEnlaces: 15 });
  const c = informe.consumo;
  assert.deepEqual(c.presupuesto, { maxEnlaces: 15, enlacesDescubiertos: 40, enlacesPedidos: 15, enlacesOmitidosPorTope: 25 });
  assert.equal(peticiones.filter((p) => p.nodo === 'Pedir enlaces').length, 15);
  const [e10, e20, e40] = c.escenarios;
  assert.equal(e10.calculable, true);
  assert.equal(e20.calculable, false);
  assert.equal(e40.calculable, false);
  assert.ok(!('bytesRecibidos' in e20) && !('bytesHistorialEstimado' in e40), 'no hay cifras inventadas');
  assert.match(informe.markdown, /no calculable con esta ejecución/);
  assert.deepEqual(validarEsquema(informe, ESQUEMA()), []);
});

test('servidor caído: el consumo se calcula igualmente (cero bytes) y el informe sigue siendo válido', () => {
  const { informe } = ejecutarProduccion(() => { throw new Error('connect ECONNREFUSED'); });
  assert.equal(informe.resumen.estado, 'critico');
  assert.ok(informe.consumo);
  assert.equal(informe.consumo.medido.bytesRecibidos, 0);
  assert.equal(informe.consumo.presupuesto.enlacesDescubiertos, 0);
  assert.deepEqual(validarEsquema(informe, ESQUEMA()), []);
});

test('compatibilidad: un informe v0.2 anterior (sin «consumo») sigue siendo válido y su Markdown se genera sin él', () => {
  const { fetchSimulado } = sitioGrande(['guia'], 3);
  const { informe } = ejecutarProduccion(fetchSimulado);
  assert.ok(informe.consumo);
  const anterior = plano(informe);
  delete anterior.consumo;
  assert.deepEqual(validarEsquema(anterior, ESQUEMA()), [], 'el esquema no exige consumo');
  const md = aud.informeMarkdown({ ...anterior, markdown: '' });
  assert.match(md, /Auditor General/);
  assert.doesNotMatch(md, /## Consumo/);
  const raro = plano(informe);
  raro.consumo.extra = 1;
  assert.ok(validarEsquema(raro, ESQUEMA()).some((e) => /campo no admitido/.test(e)), 'no admite campos inventados');
  const falsa = plano(informe);
  falsa.consumo.estimado.esEstimacion = false;
  assert.ok(validarEsquema(falsa, ESQUEMA()).length > 0, 'una estimación no puede presentarse como medición');
});

test('el comportamiento previo no cambia: mismos enlaces, mismo orden y mismo tope', () => {
  const objetivos = [{ id: 'ruta:/', tipo: 'ruta', url: `${PROD.baseUrl}/`, etiqueta: '/' }];
  const enlaces = Array.from({ length: 70 }, (_, i) => `/x/${String(i).padStart(2, '0')}`);
  const respuestas = [{ statusCode: 200, headers: { 'content-type': 'text/html' }, data: html('T', 'H', enlaces) }];
  const lista = aud.crearObjetivosEnlaces(objetivos, respuestas, PROD);
  assert.equal(lista.length, PROD.maxEnlaces);
  assert.deepEqual(lista.map((o) => o.url), enlaces.slice(0, PROD.maxEnlaces).map((e) => PROD.baseUrl + e));
  assert.equal(aud.descubrirEnlaces(objetivos, respuestas, PROD).length, 70);
});
