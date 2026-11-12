// Prueba de integración REAL de 2c (herramientas): los workflows auxiliares son una copia del workflow real con SÓLO los nodos HTTP sustituidos. Sin Docker ni n8n.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const J = (p) => JSON.parse(fs.readFileSync(path.join(RAIZ, p), 'utf8'));
const g = await import('../automation/prueba-persistencia-2c.mjs');
const { simularWorkflow, crearAlmacenSimulado } = await import('../automation/simulate-workflow.mjs');
const plano = (x) => JSON.parse(JSON.stringify(x));

test('el Auditor sintético es el workflow REAL con sólo los dos nodos HTTP sustituidos por respuestas sintéticas', () => {
  const real = J('automation/workflows/auditor-general.produccion.json');
  const aux = g.workflowAuditorSintetico();
  assert.ok(!aux.nodes.some((n) => n.type === 'n8n-nodes-base.httpRequest'), 'sin HTTP');
  assert.ok(aux.nodes.every((n) => !n.credentials) && aux.active === false);
  assert.match(aux.name, /^PRUEBA 2C · /);
  const porNombre = new Map(aux.nodes.map((n) => [n.name, n]));
  const httpReales = real.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').map((n) => n.name);
  assert.deepEqual(httpReales, ['Pedir rutas', 'Pedir enlaces']);
  for (const n of real.nodes) {
    if (httpReales.includes(n.name) || n.type === 'n8n-nodes-base.stickyNote') continue;
    assert.deepEqual(plano(porNombre.get(n.name)), plano(n), `${n.name} es idéntico al real (mismo código y mismos nodos Data table)`);
  }
  for (const nombre of httpReales) assert.equal(porNombre.get(nombre).type, 'n8n-nodes-base.code');
  assert.deepEqual(aux.nodes.map((n) => n.name).filter((n) => !real.nodes.some((r) => r.name === n)), ['Escenario']);
});

test('ejecutado en el simulador, el Auditor sintético reproduce el circuito: línea base, comparación y ejecución parcial sin escritura', () => {
  const aux = g.workflowAuditorSintetico();
  const almacen = crearAlmacenSimulado([g.TABLA_2C]);
  const correr = (esc, n) => {
    const w = plano(aux);
    const nodo = w.nodes.find((x) => x.name === 'Escenario');
    nodo.parameters.jsCode = nodo.parameters.jsCode.replace(/const ESCENARIO = '[^']*';/, `const ESCENARIO = '${esc}';`);
    const r = simularWorkflow(w, { almacen, hostsPermitidos: ['treidilor.com'], ahora: new Date(Date.parse('2026-11-12T10:00:00Z') + n * 86400000).toISOString(), ejecucion: { mode: 'test', id: esc } });
    return plano(r.salida)[0].json;
  };
  const a = correr('s0', 0);
  assert.deepEqual([a.seguimiento.modo, a.persistencia.escritura.guardar, a.persistencia.tabla.estado], ['linea_base', true, 'ok']);
  assert.equal(a.seguimiento.resumen.actuales, 4);
  const b = correr('s1', 1);
  assert.deepEqual([b.seguimiento.modo, b.seguimiento.resumen.nuevas, b.seguimiento.resumen.persistentes, b.seguimiento.resumen.resueltas], ['comparacion', 1, 1, 3]);
  const c = correr('parcial', 2);
  assert.deepEqual([c.seguimiento.calidad.estado, c.persistencia.escritura.guardar, c.persistencia.escritura.motivo], ['parcial', false, 'ejecucion_parcial']);
  assert.equal(almacen.tablas[g.TABLA_2C].filas.length, 2);
  const d = correr('caida', 3);
  assert.deepEqual([d.seguimiento.modo, d.persistencia.escritura.motivo], ['sin_comparar', 'ejecucion_fallida']);
});

test('workflows auxiliares: siembra con el Insert REAL, reinicio sólo de la tabla de la prueba y tabla ambigua que contiene el nombre de la real', () => {
  const real = J('automation/workflows/auditor-general.produccion.json').nodes.find((n) => n.name === 'Guardar instantánea');
  const siembra = g.workflowSembrar().nodes.find((n) => n.name === 'Insertar filas');
  assert.deepEqual(plano(siembra.parameters), plano(real.parameters));
  assert.deepEqual([siembra.retryOnFail, siembra.onError], [false, 'continueErrorOutput']);
  const borrar = g.workflowReiniciar().nodes.find((n) => n.parameters?.operation === 'deleteRows');
  assert.equal(borrar.parameters.dataTableId.value, g.TABLA_2C);
  assert.ok(borrar.parameters.filters.conditions.length > 0, 'Delete exige filtro');
  assert.ok(g.TABLA_AMBIGUA.includes(g.TABLA_2C) && g.TABLA_AMBIGUA !== g.TABLA_2C);
  const todos = JSON.stringify(g.generarWorkflows2c());
  assert.ok(!/tai_prueba_dt/.test(todos), 'no toca la tabla de T1–T7');
});

test('la CLI no escribe workflows dentro del repositorio', () => {
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts/automation/prueba-persistencia-2c.mjs'), 'generar', '--salida', path.join(RAIZ, 'automation', 'dev', 'salida-2c')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /dentro del repositorio/);
});
