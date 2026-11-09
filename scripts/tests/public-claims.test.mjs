// FASE 2 · Textos generados: se descartan cifras sin respaldo y se conserva lo válido y lo editado a mano. Sólo lectura.
import test from 'node:test';
import assert from 'node:assert/strict';
const { publicText, withPublicText, claimProblem } = await import('../../src/lib/publicClaims.ts');

const P = (over = {}) => ({ title: 'Auriculares Zeta Pro', brand: 'Zeta', specs: { Autonomía: '20 h', Bluetooth: '5.3' }, pros: [], cons: [], verdict: '', description: '', extra: {}, ...over });

test('descarta recuentos de reseñas, % de descuento, análisis propios y datos internos', () => {
  const p = P({ pros: ['Valoración media de 4,8 estrellas en 25 reseñas.', 'Descuento del 20 % respecto al precio de referencia.', 'Según nuestro análisis en laboratorio', 'Comisión estimada: 9% en aliexpress', 'Bluetooth 5.3 estable'] });
  const t = publicText(p);
  assert.deepEqual(t.pros, ['Bluetooth 5.3 estable']);
  assert.deepEqual(t.removed.map((r) => r.reason).sort(), ['analisis_inexistente', 'dato_interno', 'descuento_no_verificado', 'recuento_resenas_sin_respaldo']);
});

test('el rendimiento con cifras sólo se conserva si consta en título o especificaciones', () => {
  const t = publicText(P({ pros: ['Hasta 20 horas de autonomía', 'Hasta 40 horas de autonomía'] }));
  assert.deepEqual(t.pros, ['Hasta 20 horas de autonomía']);
});

test('prosa: se eliminan sólo las frases problemáticas del veredicto', () => {
  const t = publicText(P({ verdict: 'Buen equipo para el día a día. Cuenta con 4.4/5 basada en 14 reseñas. Conecta por Bluetooth 5.3.' }));
  assert.equal(t.verdict, 'Buen equipo para el día a día. Conecta por Bluetooth 5.3.');
});

test('la edición manual del administrador no se toca', () => {
  const p = P({ pros: ['Basado en 500 reseñas verificadas por el administrador'], extra: { fieldSources: { pros: 'manual' } } });
  assert.deepEqual(publicText(p).pros, p.pros);
});

test('no muta el producto original y conserva textos válidos', () => {
  const p = Object.freeze(P({ pros: Object.freeze(['Ligero', 'Descuento del 15 %']) }));
  const q = withPublicText(p);
  assert.deepEqual(q.pros, ['Ligero']);
  assert.deepEqual(p.pros, ['Ligero', 'Descuento del 15 %']);
  assert.equal(claimProblem('Diseño cómodo', ''), null);
});

test('descuentos «notables» sin cifra tampoco se publican como ventaja (no hay descuento verificado que lo respalde)', () => {
  const t = publicText({ title: 'Portátil X', specs: {}, pros: ['Descuento notable respecto al precio original', 'Pantalla de 16 pulgadas'], cons: [] });
  assert.deepEqual(t.pros, ['Pantalla de 16 pulgadas']);
});
