// Límites por fuente del programador (lote propio, tope diario con registro de ejecuciones) y configuración persistente por plataforma. Sin red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, writeCatalog } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-refresh-limits-');
const refresh = await import('../../src/lib/offerRefresh.ts');

const prod = (net, i) => ({ id: `${net}-${i}`, slug: `${net}-${i}`, title: `P ${net} ${i}`, price: 10 + i, category: 'X', network: net, merchant: net, currency: 'EUR', inStock: true, image: '/x.jpg', affiliateUrl: `https://x.invalid/${net}/${i}`, sourceId: `${net}${i}0000000`, extra: {} });
const adapterFor = (net, calls) => ({ id: `fake-${net}`, networks: [net], resolveSource: (p) => ({ type: 't', id: p.sourceId }), fetch: async (p) => { calls.push(p.sourceId); return { price: p.price, currency: 'EUR', inStock: true }; } });
const T0 = new Date('2026-11-10T08:00:00Z');
const run = (calls, schedule, now = T0, extra = {}) => refresh.refreshOffers({ onlyDue: true, mode: 'scheduled', schedule, adapters: [adapterFor('amazon', calls), adapterFor('ebay', calls)], now: () => now, sleep: async () => {}, baseDelayMs: 0, betweenMs: 0, evaluateAlerts: false, ...extra });

test('cada fuente respeta su propio lote (no se reparte un lote global entre fuentes)', async () => {
  writeCatalog(dir, [1, 2, 3, 4, 5].map((i) => prod('amazon', i)).concat([1, 2, 3, 4, 5].map((i) => prod('ebay', i))));
  const calls = [];
  const sched = { amazon: { enabled: true, everyHours: 24, batchSize: 2, maxAgeHours: 72 }, ebay: { enabled: true, everyHours: 24, batchSize: 3, maxAgeHours: 72 } };
  const rep = await run(calls, sched, T0, { dryRun: true });
  assert.equal(rep.total, 5, '2 de Amazon + 3 de eBay');
  assert.equal(rep.results.filter((r) => r.network === 'amazon').length, 2);
  assert.equal(rep.results.filter((r) => r.network === 'ebay').length, 3);
});

test('el tope diario (maxPerDay) se descuenta con los intentos registrados hoy y se renueva al día siguiente', async () => {
  writeCatalog(dir, [1, 2, 3, 4, 5].map((i) => prod('amazon', i)));
  const sched = { amazon: { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72, maxPerDay: 3 } };
  const calls = [];
  const first = await run(calls, sched, T0);
  assert.equal(first.total, 3, 'sólo 3 consultas pese a haber 5 vencidas y lote de 10');
  assert.equal(calls.length, 3);
  const second = await run(calls, sched, new Date(T0.getTime() + 3_600_000));
  assert.equal(second.total, 0, 'tope diario agotado: no hay consultas');
  assert.equal(calls.length, 3);
  assert.deepEqual(refresh.attemptsToday(T0), { amazon: 3 });
  const next = await run(calls, sched, new Date(T0.getTime() + 24 * 3_600_000));
  assert.ok(next.total >= 1 && next.total <= 3, 'al día siguiente se vuelve a poder consultar, con tope');
});

test('un tope de 0 pausa la fuente; una fuente sin tope (eBay) no se limita', async () => {
  writeCatalog(dir, [1, 2, 3].map((i) => prod('ebay', i)));
  fs.rmSync(path.join(dir, 'offer-refresh-runs.json'), { force: true });
  const calls = [];
  const paused = await run(calls, { ebay: { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72, maxPerDay: 0 } }, T0);
  assert.equal(paused.total, 0);
  const free = await run(calls, { ebay: { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72 } }, T0);
  assert.equal(free.total, 3);
});

test('el registro de ejecuciones guarda intentos por fuente y errores saneados; el dryRun no registra', async () => {
  fs.rmSync(path.join(dir, 'offer-refresh-runs.json'), { force: true });
  writeCatalog(dir, [1, 2].map((i) => prod('amazon', i)));
  const failing = { id: 'f', networks: ['amazon'], resolveSource: (p) => ({ type: 't', id: p.sourceId }), fetch: async () => { throw new refresh.RefreshError('Fallo sin clave api_key=SECRETO', false); } };
  await refresh.refreshOffers({ onlyDue: true, mode: 'scheduled', schedule: { amazon: { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72 } }, adapters: [failing], now: () => T0, sleep: async () => {}, baseDelayMs: 0, betweenMs: 0, evaluateAlerts: false, dryRun: true });
  assert.equal(refresh.readRunLog().length, 0, 'dryRun no se registra');
  await refresh.refreshOffers({ onlyDue: true, mode: 'scheduled', schedule: { amazon: { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72 } }, adapters: [failing], now: () => T0, sleep: async () => {}, baseDelayMs: 0, betweenMs: 0, evaluateAlerts: false });
  const log = refresh.readRunLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].byNetwork.amazon.attempts, 2);
  assert.equal(log[0].byNetwork.amazon.errors, 2);
  assert.equal(log[0].errorSamples.length, 2);
  assert.doesNotMatch(JSON.stringify(log), /SECRETO/, 'el registro no guarda claves');
});

test('configuración por plataforma: maxPerDay se valida, persiste y se puede quitar; Amazon nace con tope y Temu/eBay apagados', async () => {
  assert.equal(refresh.DEFAULT_SCHEDULE.amazon.maxPerDay, 10);
  await assert.rejects(() => refresh.writeScheduleConfig('ebay', { maxPerDay: -1 }), /entre 0 y 1000/);
  await assert.rejects(() => refresh.writeScheduleConfig('ebay', { maxPerDay: 5000 }), /entre 0 y 1000/);
  const saved = await refresh.writeScheduleConfig('ebay', { enabled: true, maxPerDay: 40 });
  assert.equal(saved.ebay.maxPerDay, 40);
  assert.equal(saved.ebay.enabled, true);
  assert.equal((await refresh.readScheduleConfig()).ebay.maxPerDay, 40, 'persiste en el volumen');
  const cleared = await refresh.writeScheduleConfig('ebay', { maxPerDay: null });
  assert.equal(cleared.ebay.maxPerDay, undefined);
  // Desactivar Amazon también persiste.
  const off = await refresh.writeScheduleConfig('amazon', { enabled: false });
  assert.equal((await refresh.readScheduleConfig()).amazon.enabled, false);
  assert.equal((await refresh.readScheduleConfig()).amazon.maxPerDay, 10, 'conserva su tope');
});
