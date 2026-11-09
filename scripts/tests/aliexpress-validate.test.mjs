// «Validar conexión» de AliExpress: un rechazo de la cuenta DENTRO de la respuesta (resp_code 401/404) no puede darse por verificado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedData } from './_helpers.mjs';

setupIsolatedData('treidilor-ali-validate-');
process.env.ALIEXPRESS_APP_KEY = '123456';
process.env.ALIEXPRESS_APP_SECRET = 'secreto-de-prueba';
const { AliExpressConnector } = await import('../../src/lib/networks/connectors/aliexpress.ts');

const realFetch = globalThis.fetch;
const reply = (body) => {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
};
test.after(() => { globalThis.fetch = realFetch; });

test('resp_code 401 «This publisher is not registered» → NO verificada, con el motivo real y el código', async () => {
  reply({ aliexpress_affiliate_category_get_response: { resp_result: { resp_code: 401, resp_msg: 'This publisher is not registered' } } });
  const r = await new AliExpressConnector().validate();
  assert.equal(r.ok, false);
  assert.match(r.message, /This publisher is not registered/);
  assert.match(r.message, /401/);
});

test('error_response de firma/clave sigue siendo un fallo', async () => {
  reply({ error_response: { code: 29, msg: 'Invalid app Key' } });
  const r = await new AliExpressConnector().validate();
  assert.equal(r.ok, false);
  assert.match(r.message, /Invalid app Key/);
});

test('resp_code 200 → verificada', async () => {
  reply({ aliexpress_affiliate_category_get_response: { resp_result: { resp_code: 200, resp_msg: 'call succeeded', result: { categories: { category: [] } } } } });
  const r = await new AliExpressConnector().validate();
  assert.equal(r.ok, true);
  assert.match(r.message, /verificada/);
});
