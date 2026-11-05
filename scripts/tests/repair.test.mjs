import test from 'node:test';
import assert from 'node:assert/strict';
import { planRepairs, applyPlan, applyRollback } from '../../src/lib/catalogRepair.ts';

// Registros sintéticos con los defectos antiguos.
const data = () => [
  { id: 'a', title: 'A', brand: 'Amazon', merchant: 'Amazon', network: 'amazon', asin: 'B01EXDG2MO', rating: 4.2, reviewsCount: 50, specs: { Marca: 'Fineblue' } },
  { id: 'b', title: 'B', brand: 'Sonix', merchant: 'Tienda', network: 'ebay', sourceId: 'v1|123456789012|0', rating: 4.5, reviewsCount: 15 },
  { id: 'c', title: 'C', brand: 'Sonix', merchant: 'Tienda', network: 'ebay', sourceId: '123456789012', rating: 4.9, reviewsCount: 300 },
  { id: 'd', title: 'D', brand: 'Amazon', merchant: 'Amazon', network: 'amazon', extra: { lockedFields: ['brand'] } },
  { id: 'e', title: 'E', brand: 'Marca', merchant: 'Otra', network: 'aliexpress', rating: 4.8, reviewsCount: 100 },
];

test('la simulación detecta cada defecto y no toca nada', () => {
  const input = data();
  const before = JSON.stringify(input);
  const plan = planRepairs(input);
  assert.equal(JSON.stringify(input), before, 'el plan no muta la entrada');
  assert.equal(plan.summary['brand-is-merchant'], 1, 'a sí; d está bloqueado por edición manual');
  assert.equal(plan.summary['fabricated-rating'], 2, 'b (eBay 4,5/15) y e (alta manual 4,8/100)');
  assert.equal(plan.summary['duplicate-offer'], 2, 'b y c son el mismo anuncio eBay (v1|id|0 ≡ id)');
  assert.equal(plan.summary['brand-spec-mismatch'], 1, 'cabecera Amazon vs specs Fineblue');
});

test('aplicar genera una copia y la reversión restaura exactamente el original', () => {
  const input = data();
  const plan = planRepairs(input);
  const { products: repaired, rollback } = applyPlan(input, plan);
  assert.equal(repaired.find((p) => p.id === 'a').brand, undefined);
  assert.equal(repaired.find((p) => p.id === 'b').rating, undefined);
  assert.equal(repaired.find((p) => p.id === 'c').rating, 4.9, 'lo no afectado no cambia');
  assert.equal(input.find((p) => p.id === 'a').brand, 'Amazon', 'la entrada original sigue intacta');
  const restored = applyRollback(repaired, rollback);
  assert.deepEqual(restored, data());
});

test('los duplicados y desajustes sólo se informan, no se modifican', () => {
  const input = data();
  const { products: repaired } = applyPlan(input, planRepairs(input));
  assert.equal(repaired.length, input.length);
  assert.ok(repaired.find((p) => p.id === 'c'));
});

test('reparar dos veces es idempotente', () => {
  const once = applyPlan(data(), planRepairs(data())).products;
  const twice = applyPlan(once, planRepairs(once)).products;
  assert.deepEqual(twice, once);
});
