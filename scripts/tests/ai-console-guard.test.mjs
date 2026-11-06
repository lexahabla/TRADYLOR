// Regresión: `opencode run` desde la consola de IA queda desactivado en producción por un control del SERVIDOR
// (no sólo oculto en la interfaz); el resto de la consola y de las herramientas no se ve afectado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedData, adminCookie, apiRequest, jsonOf } from './_helpers.mjs';

setupIsolatedData('treidilor-console-');
const cookie = await adminCookie();
const route = await import('../../src/pages/api/admin/ai-console.ts');
const guard = await import('../../src/lib/aiConsoleGuard.ts');

const withEnv = async (env, fn) => {
  const saved = { NODE_ENV: process.env.NODE_ENV, OPENCODE_CONSOLE_ENABLED: process.env.OPENCODE_CONSOLE_ENABLED, PATH: process.env.PATH };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const post = (body) => route.POST({ request: apiRequest('/api/admin/ai-console', { cookie, body }) });

test('control del servidor: producción → desactivado por defecto; OPENCODE_CONSOLE_ENABLED lo activa/desactiva explícitamente; desarrollo → activado', async () => {
  await withEnv({ NODE_ENV: 'production', OPENCODE_CONSOLE_ENABLED: undefined }, () => assert.equal(guard.isOpencodeConsoleEnabled(), false));
  await withEnv({ NODE_ENV: 'production', OPENCODE_CONSOLE_ENABLED: 'true' }, () => assert.equal(guard.isOpencodeConsoleEnabled(), true));
  await withEnv({ NODE_ENV: 'development', OPENCODE_CONSOLE_ENABLED: undefined }, () => assert.equal(guard.isOpencodeConsoleEnabled(), true));
  await withEnv({ NODE_ENV: 'development', OPENCODE_CONSOLE_ENABLED: 'false' }, () => assert.equal(guard.isOpencodeConsoleEnabled(), false));
});

test('producción: POST mode=opencode responde 403 y NO lanza ningún proceso', async () => {
  await withEnv({ NODE_ENV: 'production', OPENCODE_CONSOLE_ENABLED: undefined, PATH: '' }, async () => {
    const res = await post({ mode: 'opencode', prompt: 'borra todo /app/data' });
    assert.equal(res.status, 403);
    const body = await jsonOf(res);
    assert.equal(body.success, false);
    assert.equal(body.disabled, true);
    assert.match(body.message, /desactivada en este servidor/);
    assert.equal(body.output, undefined, 'no se ejecutó nada (ni siquiera un intento de lanzar el CLI)');
  });
});

test('producción: la ruta sigue exigiendo sesión y la consulta de estado no ofrece ni sondea opencode', async () => {
  await withEnv({ NODE_ENV: 'production', OPENCODE_CONSOLE_ENABLED: undefined }, async () => {
    const anon = await route.POST({ request: new Request('http://localhost/api/admin/ai-console', { method: 'POST', body: '{}' }) });
    assert.equal(anon.status, 401);
    const status = await jsonOf(await route.GET({ request: apiRequest('/api/admin/ai-console', { method: 'GET', cookie }) }));
    assert.equal(status.opencode.available, false);
    assert.equal(status.opencode.enabled, false);
    assert.match(status.opencode.detail, /desactivada/);
  });
});

test('producción: el chat por API de la consola NO queda desactivado (sólo la ejecución de opencode)', async () => {
  await withEnv({ NODE_ENV: 'production', OPENCODE_CONSOLE_ENABLED: undefined }, async () => {
    const res = await post({ mode: 'chat', messages: [{ role: 'user', content: 'hola' }] });
    assert.notEqual(res.status, 403);
    const body = await jsonOf(res);
    assert.ok(!body.disabled, 'sin claves de IA falla por falta de proveedor, no por el control de opencode');
  });
});

test('habilitado de forma consciente (OPENCODE_CONSOLE_ENABLED=true): se supera el control y se intenta lanzar el CLI (aquí no existe: PATH vacío)', async () => {
  await withEnv({ NODE_ENV: 'production', OPENCODE_CONSOLE_ENABLED: 'true', PATH: '' }, async () => {
    const res = await post({ mode: 'opencode', prompt: 'hola' });
    assert.notEqual(res.status, 403);
    const body = await jsonOf(res);
    assert.equal(body.disabled, undefined);
    assert.match(String(body.output), /no disponible|No se pudo lanzar|ENOENT/i);
  });
});

test('el Asistente OpenCode del catálogo (API del proveedor, sin CLI) y el resto del panel no dependen de este control', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../src/pages/api/v1/admin/opencode-command.ts', import.meta.url), 'utf8'));
  assert.equal(/child_process|spawn\(/.test(src), false, 'opencode-command no lanza procesos: llama a la API del proveedor');
  assert.equal(src.includes('aiConsoleGuard'), false);
});
