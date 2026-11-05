import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshOffers, RefreshError, readRefreshMeta, readObservations, readSignal, isDue, getRefreshStatus } from '../../src/lib/offerRefresh.ts';
import { activeSignal, freshnessOf } from '../../src/lib/offerObservations.ts';

/** Datos aislados en memoria: nunca toca products.json. */
function makeStore(products) {
  const state = { products: structuredClone(products), writes: 0 };
  return {
    state,
    read: () => structuredClone(state.products),
    write: (next) => { state.products = structuredClone(next); state.writes++; return true; },
  };
}

function makeAdapter(script) {
  const calls = { n: 0 };
  return {
    calls,
    adapter: {
      id: 'fake',
      networks: ['amazon'],
      resolveSource: (p) => (p.asin ? { type: 'asin', id: p.asin } : null),
      fetch: async () => {
        const step = script[Math.min(calls.n, script.length - 1)];
        calls.n++;
        if (step instanceof Error) throw step;
        return step;
      },
    },
  };
}

const base = () => ({
  id: 'amazon-b01exdg2mo', title: 'Auriculares Fineblue F920', brand: 'Fineblue', merchant: 'Amazon',
  network: 'amazon', asin: 'B01EXDG2MO', price: 50, currency: 'EUR', inStock: true,
  priceHistory: [{ date: '2026-11-01', price: 55 }], pros: [], cons: [], affiliateUrl: 'https://www.amazon.es/dp/B01EXDG2MO',
  verdict: 'Texto enriquecido y revisado',
});

const noSleep = async () => {};
const clock = (iso) => () => new Date(iso);
const common = (store, adapter, iso) => ({
  ids: ['amazon-b01exdg2mo'], store, adapters: [adapter], sleep: noSleep, now: clock(iso), evaluateAlerts: false, baseDelayMs: 0,
});

test('ciclo 1: primera lectura no genera señal de bajada; ciclo 2: la baja sí y sin duplicar histórico', async () => {
  const store = makeStore([base()]);
  const { adapter } = makeAdapter([
    { price: 48, currency: 'EUR', inStock: true, shippingCost: 0, identity: { sourceId: 'B01EXDG2MO', brand: 'Fineblue' } },
    { price: 42, currency: 'EUR', inStock: true, shippingCost: 0, identity: { sourceId: 'B01EXDG2MO', brand: 'Fineblue' } },
  ]);

  const r1 = await refreshOffers({ ...common(store, adapter, '2026-11-06T10:00:00.000Z'), runId: 'run-1' });
  let p = store.state.products[0];
  assert.equal(r1.updated, 1);
  assert.equal(p.price, 48);
  assert.equal(readSignal(p), null, 'primera lectura: sin señal');
  assert.equal(readObservations(p).length, 1);
  assert.equal(readRefreshMeta(p).lastVerifiedAt, '2026-11-06T10:00:00.000Z');
  assert.equal(p.verdict, 'Texto enriquecido y revisado', 'texto enriquecido intacto');
  assert.equal(p.freeShipping, true, 'envío 0 conocido → gratis');

  const r2 = await refreshOffers({ ...common(store, adapter, '2026-11-07T10:00:00.000Z'), runId: 'run-2' });
  p = store.state.products[0];
  assert.equal(r2.results[0].dropSignal, true);
  assert.equal(p.price, 42);
  const signal = readSignal(p);
  assert.equal(signal.previousPrice, 48);
  assert.equal(signal.price, 42);
  assert.equal(readObservations(p).length, 2);
  // histórico: 1 punto previo + 2 nuevos días, sin duplicados
  assert.deepEqual(p.priceHistory.map((x) => x.date), ['2026-11-01', '2026-11-06', '2026-11-07']);
});

test('lectura repetida el mismo día no añade filas ni renueva la señal', async () => {
  const store = makeStore([base()]);
  const reading = { price: 40, currency: 'EUR', inStock: true, identity: { sourceId: 'B01EXDG2MO' } };
  const { adapter } = makeAdapter([{ ...reading, price: 45 }, reading, reading]);
  await refreshOffers({ ...common(store, adapter, '2026-11-06T08:00:00.000Z'), runId: 'a' });
  await refreshOffers({ ...common(store, adapter, '2026-11-06T09:00:00.000Z'), runId: 'b' }); // baja a 40 → señal
  const expires = readSignal(store.state.products[0]).expiresAt;
  await refreshOffers({ ...common(store, adapter, '2026-11-06T12:00:00.000Z'), runId: 'c' }); // mismo precio
  const p = store.state.products[0];
  assert.equal(readObservations(p).length, 2, 'la reconfirmación no añade fila');
  assert.equal(readSignal(p).expiresAt, expires, 'sin cambio no renueva la vigencia');
  assert.equal(p.priceHistory.filter((x) => x.date === '2026-11-06').length, 1);
});

test('una subida retira la señal y la señal caduca', async () => {
  const store = makeStore([base()]);
  const { adapter } = makeAdapter([
    { price: 45, currency: 'EUR', inStock: true, identity: { sourceId: 'B01EXDG2MO' } },
    { price: 40, currency: 'EUR', inStock: true, identity: { sourceId: 'B01EXDG2MO' } },
    { price: 47, currency: 'EUR', inStock: true, identity: { sourceId: 'B01EXDG2MO' } },
  ]);
  await refreshOffers({ ...common(store, adapter, '2026-11-01T00:00:00.000Z'), runId: '1' });
  await refreshOffers({ ...common(store, adapter, '2026-11-02T00:00:00.000Z'), runId: '2' });
  const signal = readSignal(store.state.products[0]);
  assert.ok(signal);
  assert.equal(activeSignal(signal, { now: new Date('2026-11-10T00:00:00.000Z'), offerKey: signal.offerKey, currentPrice: 40 }), null, 'caducada a los 7 días');
  assert.ok(activeSignal(signal, { now: new Date('2026-11-03T00:00:00.000Z'), offerKey: signal.offerKey, currentPrice: 40 }));
  assert.equal(activeSignal(signal, { now: new Date('2026-11-03T00:00:00.000Z'), offerKey: 'otra:oferta', currentPrice: 40 }), null, 'otra oferta destacada no hereda la señal');
  await refreshOffers({ ...common(store, adapter, '2026-11-03T00:00:00.000Z'), runId: '3' });
  assert.equal(readSignal(store.state.products[0]), null, 'la subida la retira');
});

test('fallo temporal se reintenta; fallo definitivo conserva valores y no pone stock 0', async () => {
  const store = makeStore([base()]);
  const flaky = makeAdapter([new RefreshError('503'), { price: 49, currency: 'EUR', inStock: true, identity: { sourceId: 'B01EXDG2MO' } }]);
  const ok = await refreshOffers({ ...common(store, flaky.adapter, '2026-11-06T10:00:00.000Z'), runId: 'r1' });
  assert.equal(ok.results[0].attempts, 2, 'reintentó tras el fallo temporal');
  assert.equal(store.state.products[0].price, 49);

  const dead = makeAdapter([new RefreshError('bloqueo', true)]);
  const bad = await refreshOffers({ ...common(store, dead.adapter, '2026-11-07T10:00:00.000Z'), runId: 'r2' });
  const p = store.state.products[0];
  assert.equal(bad.errors, 1);
  assert.equal(dead.calls.n, 3, 'tres intentos con espera progresiva');
  assert.equal(p.price, 49, 'conserva el último valor válido');
  assert.equal(p.inStock, true, 'un fallo no es stock cero');
  const meta = readRefreshMeta(p);
  assert.equal(meta.lastAttemptAt, '2026-11-07T10:00:00.000Z');
  assert.equal(meta.lastVerifiedAt, '2026-11-06T10:00:00.000Z', 'última verificación correcta intacta');
  assert.equal(meta.failures, 1);
});

test('respuesta sin precio válido no actualiza ni anula el precio', async () => {
  const store = makeStore([base()]);
  const { adapter } = makeAdapter([{ price: null, inStock: false }]);
  const r = await refreshOffers({ ...common(store, adapter, '2026-11-06T10:00:00.000Z'), runId: 'x', maxAttempts: 1 });
  assert.equal(r.errors, 1);
  assert.equal(store.state.products[0].price, 50);
  assert.equal(store.state.products[0].inStock, true);
});

test('JSON sin origen reconsultable queda pendiente y conserva su última fecha', async () => {
  const jsonOnly = { ...base(), id: 'json-1', asin: undefined, sourceId: undefined, extra: { refresh: { lastVerifiedAt: '2026-10-01T00:00:00.000Z', status: 'ok' } } };
  const store = makeStore([jsonOnly]);
  const { adapter } = makeAdapter([{ price: 1 }]);
  const r = await refreshOffers({ ...common(store, adapter, '2026-11-06T10:00:00.000Z'), ids: ['json-1'], runId: 'n' });
  assert.equal(r.noSource, 1);
  const meta = readRefreshMeta(store.state.products[0]);
  assert.equal(meta.status, 'no_source');
  assert.equal(meta.lastVerifiedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(freshnessOf(meta.lastVerifiedAt, 72, new Date('2026-11-06T10:00:00.000Z')), 'stale');
});

test('cambio de marca en la fuente va a revisión y no se aplica', async () => {
  const store = makeStore([base()]);
  const { adapter } = makeAdapter([{ price: 44, currency: 'EUR', inStock: true, identity: { sourceId: 'B01EXDG2MO', brand: 'OtraMarca' } }]);
  await refreshOffers({ ...common(store, adapter, '2026-11-06T10:00:00.000Z'), runId: 'b' });
  const p = store.state.products[0];
  assert.equal(p.brand, 'Fineblue');
  assert.equal(p.extra.reviewQueue[0].field, 'brand');
});

test('no hay solape: una segunda ejecución simultánea devuelve null', async () => {
  const store = makeStore([base()]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = {
    id: 'slow', networks: ['amazon'], resolveSource: (p) => ({ type: 'asin', id: p.asin }),
    fetch: async () => { await gate; return { price: 40, currency: 'EUR', identity: { sourceId: 'B01EXDG2MO' } }; },
  };
  const first = refreshOffers({ ...common(store, adapter, '2026-11-06T10:00:00.000Z'), runId: 'a' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(getRefreshStatus().running, true);
  assert.equal(await refreshOffers({ ...common(store, adapter, '2026-11-06T10:00:00.000Z'), runId: 'b' }), null);
  release();
  assert.ok(await first);
});

test('frecuencia: sólo está pendiente quien supera su periodo, con espera tras fallos', () => {
  const cfg = { enabled: true, everyHours: 24, batchSize: 10, maxAgeHours: 72 };
  const now = new Date('2026-11-06T12:00:00.000Z');
  const verifiedRecently = { ...base(), extra: { refresh: { lastVerifiedAt: '2026-11-06T02:00:00.000Z' } } };
  const verifiedLongAgo = { ...base(), extra: { refresh: { lastVerifiedAt: '2026-11-04T02:00:00.000Z' } } };
  const failedJustNow = { ...base(), extra: { refresh: { lastVerifiedAt: '2026-11-04T02:00:00.000Z', lastAttemptAt: '2026-11-06T11:50:00.000Z', failures: 2 } } };
  assert.equal(isDue(verifiedRecently, cfg, now), false);
  assert.equal(isDue(verifiedLongAgo, cfg, now), true);
  assert.equal(isDue(failedJustNow, cfg, now), false);
});

test('alertas: se evalúan una vez tras guardar observaciones; no si no hubo lectura nueva', async () => {
  const store = makeStore([base()]);
  let calls = 0;
  const { adapter } = makeAdapter([{ price: 44, currency: 'EUR', inStock: true, identity: { sourceId: 'B01EXDG2MO' } }]);
  const opts = { ...common(store, adapter, '2026-11-06T10:00:00.000Z'), evaluateAlerts: true, alertRunner: async () => { calls++; return 1; } };
  const first = await refreshOffers({ ...opts, runId: 'a' });
  assert.equal(calls, 1);
  assert.equal(first.alertsSent, 1);
  await refreshOffers({ ...opts, runId: 'b' }); // misma lectura el mismo día → no añade observación
  assert.equal(calls, 1, 'sin observación nueva no se reevalúan alertas');
});
