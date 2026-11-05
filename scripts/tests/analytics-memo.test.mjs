import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Datos aislados: se fija el directorio ANTES de importar los módulos.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradylor-an-'));
process.env.TRADYLOR_DATA_DIR = dir;
const now = Date.now();
const events = Array.from({ length: 2000 }, (_, i) => ({
  type: i % 5 === 0 ? 'outbound_click' : 'page_view',
  path: '/producto/p' + (i % 7),
  productId: 'p' + (i % 7),
  sessionId: 's' + Math.floor(i / 3),
  visitorId: 'v' + Math.floor(i / 5),
  source: 'tracker',
  createdAt: new Date(now - (i % 40) * 86400000).toISOString(),
}));
fs.writeFileSync(path.join(dir, 'analytics.json'), JSON.stringify(events));
fs.writeFileSync(path.join(dir, 'products.json'), '[]');

const months = await import('../../src/lib/analyticsMonths.ts');

test('la segunda petición del panel sale de memoria (misma referencia, sin recalcular)', () => {
  months.clearAnalyticsMemo();
  const a = months.getMesesAnalitica();
  const b = months.getMesesAnalitica();
  assert.equal(a, b, 'misma referencia = no se recorrieron de nuevo los eventos');
  const p1 = months.getPeriodoDashboard(30);
  const p2 = months.getPeriodoDashboard(30);
  assert.equal(p1, p2);
  assert.ok(p1.actual.visitas > 0 || p1.actual.pageViews > 0 || Object.keys(p1.actual).length > 0);
  assert.equal(months.getFechasConDatos(), months.getFechasConDatos());
});

test('periodos distintos no comparten resultado', () => {
  const a = months.getPeriodoDashboard(30);
  const b = months.getPeriodoDashboard(7);
  assert.notEqual(a, b);
  assert.notEqual(a.dias, b.dias);
});

test('vaciar la medición invalida la memoria al instante', async () => {
  const before = months.getMesesAnalitica();
  assert.ok(before.meses.length > 0);
  await months.resetAnalitica();
  const after = months.getMesesAnalitica();
  assert.notEqual(after, before);
  assert.equal(after.meses.length, 0, 'tras vaciar no quedan meses memorizados');
  assert.equal(months.getFechasConDatos().dias.length, 0);
  assert.equal(months.getPeriodoDashboard(30).actual.pageViews ?? 0, 0);
});
