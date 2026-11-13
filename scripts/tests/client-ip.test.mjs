// IP del cliente (H1): `X-Forwarded-For` es falsificable. Pruebas de la función central (`src/lib/clientIp.ts`), de la API de automatización
// (un token válido nunca queda bloqueado por fallos de otros ni por una IP falseada; límites del propio token intactos; auditoría acotada)
// y de que el resto de la web conserva su comportamiento mientras no se declare `TRUSTED_PROXY_HOPS`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-client-ip-');
delete process.env.TRUSTED_PROXY_HOPS;
delete process.env.AUTOMATION_API_ENABLED;
const IP = await import('../../src/lib/clientIp.ts');
const A = await import('../../src/lib/automationApi.ts');
const RL = await import('../../src/lib/rateLimit.ts');
const catalogRoute = await import('../../src/pages/api/automation/v1/catalog.ts');
const adminRoute = await import('../../src/pages/api/admin/automation-clients.ts');
const B = 'http://localhost';
const f = (n) => path.join(dir, n);
fs.writeFileSync(f('products.json'), JSON.stringify([{ id: 'p001', slug: 'p001', title: 'Producto de prueba uno', affiliateUrl: 'https://example.invalid/x', price: 10, category: 'Sonido', network: 'amazon', merchant: 'Tienda', currency: 'EUR', inStock: true, image: '/images/products/x.jpg', description: 'x'.repeat(60) }]));
fs.writeFileSync(f('categories.json'), JSON.stringify([{ id: 'sonido', name: 'Sonido', slug: 'sonido', icon: '🎧', keywords: [] }]));
fs.writeFileSync(f('sections.json'), '[]');
fs.writeFileSync(f('deleted-product-ids.json'), '[]');

/** Petición con cabecera de proxy y/o dirección del par TCP (lo que Astro adjunta). */
const mk = (url, { xff, peer, token, method = 'GET' } = {}) => {
  const r = new Request(B + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(xff !== undefined ? { 'x-forwarded-for': xff } : {}) } });
  if (peer !== undefined) Reflect.set(r, IP.ASTRO_CLIENT_ADDRESS, peer);
  return r;
};
const cat = (o, q = '?limit=1') => catalogRoute.GET({ request: mk(`/api/automation/v1/catalog${q}`, o) });
const BAD = 'tai_0000000000000000_' + 'x'.repeat(43);
const crear = async (name = 'cliente', over = {}) => {
  const r = await adminRoute.POST({ request: new Request(`${B}/api/admin/automation-clients`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: await adminCookie(), 'X-Automation-Admin': '1', Origin: B, Host: 'localhost' }, body: JSON.stringify({ action: 'create', name, scopes: ['catalog:read'], ...over }) }) });
  return r.json();
};
process.env.AUTOMATION_API_ENABLED = 'true';
const reset = () => { A.resetAutomationLimits(); delete process.env.TRUSTED_PROXY_HOPS; };

/* ───────── Función central ───────── */
test('estricto sin proxies declarados: ignora X-Forwarded-For y usa el par TCP (falsificación inútil)', () => {
  delete process.env.TRUSTED_PROXY_HOPS;
  const r = IP.resolveClientIp(mk('/', { xff: '6.6.6.6, 7.7.7.7', peer: '172.18.0.5' }), 'strict');
  assert.deepEqual([r.ip, r.source, r.trustedProxyConfigured], ['172.18.0.5', 'peer', false]);
  assert.equal(IP.resolveClientIp(mk('/', { xff: '6.6.6.6' }), 'strict').ip, 'unknown', 'sin par y sin proxies de confianza: «unknown», nunca la cabecera');
  assert.equal(IP.resolveClientIp(mk('/', { peer: '::ffff:203.0.113.4' }), 'strict').ip, '203.0.113.4', 'IPv4 mapeada normalizada');
  assert.equal(IP.resolveClientIp(mk('/', { peer: 'no-es-una-ip' }), 'strict').ip, 'unknown');
});

test('sin cabecera de proxy: usa el par; sin nada, «unknown»; nunca lanza', () => {
  for (const hops of [null, 0, 1, 2]) {
    assert.equal(IP.resolveClientIp(mk('/', { peer: '198.51.100.2' }), 'strict', hops).ip, '198.51.100.2');
    assert.equal(IP.resolveClientIp(mk('/'), 'strict', hops).ip, 'unknown');
  }
  assert.doesNotThrow(() => IP.resolveClientIp(new Request(B + '/'), 'legacy'));
});

test('con proxies de confianza: se toma la entrada N desde la DERECHA; lo que el cliente pone a la izquierda se ignora', () => {
  // un proxy (Traefik) que AÑADE: el cliente falsea «6.6.6.6» y el proxy añade la IP real
  assert.equal(IP.resolveClientIp(mk('/', { xff: '6.6.6.6, 203.0.113.50', peer: '172.18.0.5' }), 'strict', 1).ip, '203.0.113.50');
  assert.equal(IP.resolveClientIp(mk('/', { xff: '203.0.113.50', peer: '172.18.0.5' }), 'strict', 1).ip, '203.0.113.50', 'proxy que sustituye');
  // dos proxies: cliente → P1 → P2 → app  ⇒  «falso, cliente, P1»
  assert.equal(IP.resolveClientIp(mk('/', { xff: '6.6.6.6, 203.0.113.50, 10.0.0.2', peer: '10.0.0.3' }), 'strict', 2).ip, '203.0.113.50');
  const r = IP.resolveClientIp(mk('/', { xff: '6.6.6.6, 203.0.113.50', peer: '172.18.0.5' }), 'strict', 1);
  assert.deepEqual([r.source, r.trustedProxyConfigured], ['proxy_header', true]);
});

test('con proxies declarados pero cabecera incoherente (menos entradas que proxies, entradas no válidas, sin cabecera): cae al par, no a la cabecera', () => {
  assert.equal(IP.resolveClientIp(mk('/', { xff: '203.0.113.50', peer: '172.18.0.5' }), 'strict', 2).ip, '172.18.0.5');
  assert.equal(IP.resolveClientIp(mk('/', { xff: '6.6.6.6, <script>', peer: '172.18.0.5' }), 'strict', 1).ip, '172.18.0.5');
  assert.equal(IP.resolveClientIp(mk('/', { xff: 'a, b, c', peer: '172.18.0.5' }), 'strict', 3).ip, '172.18.0.5');
  assert.equal(IP.resolveClientIp(mk('/', { peer: '172.18.0.5' }), 'strict', 1).ip, '172.18.0.5');
  // 0 proxies declarados (acceso directo): la cabecera no vale nada
  assert.equal(IP.resolveClientIp(mk('/', { xff: '6.6.6.6', peer: '203.0.113.9' }), 'strict', 0).ip, '203.0.113.9');
});

test('TRUSTED_PROXY_HOPS: sólo enteros 0-5; cualquier otro valor equivale a «no configurada» (nunca se confía por defecto)', () => {
  for (const [raw, esperado] of [[undefined, null], ['', null], ['abc', null], ['-1', null], ['6', null], ['1.5', null], ['01', null], [' 1 ', 1], ['0', 0], ['1', 1], ['5', 5]]) {
    assert.equal(IP.trustedProxyHops(raw), esperado, `«${raw}»`);
  }
  process.env.TRUSTED_PROXY_HOPS = '1';
  assert.equal(IP.resolveClientIp(mk('/', { xff: '6.6.6.6, 203.0.113.50', peer: '172.18.0.5' }), 'strict').ip, '203.0.113.50', 'lee la variable de entorno');
  process.env.TRUSTED_PROXY_HOPS = 'basura';
  assert.equal(IP.resolveClientIp(mk('/', { xff: '6.6.6.6, 203.0.113.50', peer: '172.18.0.5' }), 'strict').ip, '172.18.0.5');
  delete process.env.TRUSTED_PROXY_HOPS;
});

test('modo legacy (resto de la web) SIN configurar: conserva el comportamiento anterior; CON proxies declarados: ya no confía en el primer valor', () => {
  delete process.env.TRUSTED_PROXY_HOPS;
  assert.equal(RL.clientIp(mk('/', { xff: '6.6.6.6, 7.7.7.7' })), '6.6.6.6', 'sin regresión: límites de login/registro iguales que antes');
  assert.equal(RL.clientIp(mk('/')), 'unknown');
  process.env.TRUSTED_PROXY_HOPS = '1';
  assert.equal(RL.clientIp(mk('/', { xff: '6.6.6.6, 203.0.113.50', peer: '172.18.0.5' })), '203.0.113.50');
  delete process.env.TRUSTED_PROXY_HOPS;
});

/* ───────── API de automatización ───────── */
test('FALSIFICACIÓN: fallos desde una IP aparente no bloquean a un cliente legítimo con token válido (sin proxies declarados)', async () => {
  reset();
  const ok = await crear('legitimo');
  for (let i = 0; i < 60; i++) await cat({ token: BAD, xff: '198.51.100.7', peer: '172.18.0.5' });
  for (let i = 0; i < 3; i++) assert.equal((await cat({ token: ok.token, xff: '198.51.100.7', peer: '172.18.0.5' })).status, 200, 'el token válido sigue pasando');
});

test('FALSIFICACIÓN: con proxies declarados, el atacante no bloquea a la víctima ni esquiva su propio bloqueo cambiando la cabecera', async () => {
  reset();
  process.env.TRUSTED_PROXY_HOPS = '1';
  const ok = await crear('legitimo2');
  // el atacante (IP real 203.0.113.50, la que añade el proxy) falsea una IP distinta en cada petición
  const estados = [];
  for (let i = 0; i < 40; i++) estados.push((await cat({ token: BAD, xff: `6.6.${i}.1, 203.0.113.50`, peer: '172.18.0.5' })).status);
  assert.equal(estados.slice(0, 20).every((s) => s === 401), true);
  assert.equal(estados.slice(20).every((s) => s === 429), true, 'cambiar el valor falso NO esquiva el bloqueo: cuenta la IP real');
  // la víctima (otra IP real) falseada por el atacante en la parte izquierda de la cabecera: nada cambia para ella
  assert.equal((await cat({ token: BAD, xff: '203.0.113.50, 198.51.100.7', peer: '172.18.0.5' })).status, 401, 'la IP real de la víctima no está bloqueada');
  // y un token válido pasa incluso desde la IP bloqueada
  assert.equal((await cat({ token: ok.token, xff: 'x, 203.0.113.50', peer: '172.18.0.5' })).status, 200);
  reset();
});

test('IPs aparentes distintas sin proxies declarados: todas cuentan contra el par (no se esquiva el bloqueo de intentos inválidos)', async () => {
  reset();
  const estados = [];
  for (let i = 0; i < 30; i++) estados.push((await cat({ token: BAD, xff: `10.1.${i}.1`, peer: '172.18.0.5' })).status);
  assert.equal(estados.filter((s) => s === 401).length, 20);
  assert.equal(estados.filter((s) => s === 429).length, 10);
});

test('sin token: 401 y, tras 20 fallos de la misma IP, 429 con Retry-After; con token válido nunca', async () => {
  reset();
  const ok = await crear('legitimo3');
  assert.equal((await cat({ peer: '203.0.113.9' })).status, 401, 'sin cabecera Authorization');
  for (let i = 0; i < 19; i++) await cat({ token: BAD, peer: '203.0.113.9' });
  const bloqueado = await cat({ peer: '203.0.113.9' });
  assert.equal(bloqueado.status, 429);
  assert.equal(bloqueado.headers.get('retry-after'), '60');
  assert.equal((await cat({ token: ok.token, peer: '203.0.113.9' })).status, 200, 'token válido desde la IP bloqueada');
  assert.equal((await cat({ token: BAD, peer: '198.51.100.20' })).status, 401, 'otra IP no se ve afectada');
  reset();
});

test('con token válido: 200 con el esquema esperado, y los límites del PROPIO token siguen aplicándose (minuto y cuota)', async () => {
  reset();
  const lento = await crear('lento', { ratePerMinute: 2 });
  assert.equal((await cat({ token: lento.token, peer: '203.0.113.1' })).status, 200);
  assert.equal((await cat({ token: lento.token, peer: '203.0.113.1' })).status, 200);
  const r = await cat({ token: lento.token, peer: '203.0.113.1' });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, 'limite_por_minuto');
  // otro cliente con la misma IP no comparte ese contador
  const otro = await crear('otro');
  assert.equal((await cat({ token: otro.token, peer: '203.0.113.1' })).status, 200);
  const cuota = await crear('cuota', { dailyQuota: 1 });
  assert.equal((await cat({ token: cuota.token, peer: '203.0.113.2' })).status, 200);
  const c = await cat({ token: cuota.token, peer: '203.0.113.3' });
  assert.equal(c.status, 429);
  assert.equal((await c.json()).code, 'cuota_diaria', 'la cuota va por token, no por IP');
  reset();
});

test('un token revocado o caducado cuenta como fallo de autenticación (se puede bloquear la IP que lo repite) y no afecta a otros clientes', async () => {
  reset();
  const malo = await crear('revocado');
  const bueno = await crear('vigente');
  const { revokeClient } = A;
  assert.equal(revokeClient(malo.client.id).ok, true);
  for (let i = 0; i < 20; i++) assert.equal((await cat({ token: malo.token, peer: '203.0.113.77' })).status, 401);
  assert.equal((await cat({ token: malo.token, peer: '203.0.113.77' })).status, 429);
  assert.equal((await cat({ token: bueno.token, peer: '203.0.113.77' })).status, 200);
  reset();
});

test('H2: una inundación sin token no llena la auditoría (tope por minuto + una línea resumen) y no impide registrar lo legítimo', async () => {
  reset();
  const audit = f('automation-audit.jsonl');
  const ok = await crear('legitimo4');
  const lineas = () => (fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const antes = lineas().length;
  for (let i = 0; i < 1000; i++) await cat({ token: BAD, peer: `203.0.113.${(i % 200) + 1}` });
  const denegados = lineas().slice(antes).filter((l) => l.event === 'denegado' || l.event === 'limite');
  assert.ok(denegados.length <= 10, `como máximo 10 denegaciones por minuto, hubo ${denegados.length}`);
  assert.equal((await cat({ token: ok.token, peer: '198.51.100.99' })).status, 200);
  const ultima = lineas().at(-1);
  assert.equal(ultima.event, 'peticion', 'la petición legítima se registra siempre');
  assert.equal(ultima.status, 200);
  // al cambiar de ventana se escribe UNA línea con el recuento suprimido
  A.authenticate(mk('/api/automation/v1/catalog', { token: BAD, peer: '203.0.113.1' }), 'catalog:read', Date.now() + 61000);
  const resumen = lineas().filter((l) => l.event === 'denegados_suprimidos');
  assert.equal(resumen.length, 1);
  assert.match(resumen[0].detail, /^n=\d+$/);
  assert.ok(Number(resumen[0].detail.slice(2)) >= 900, 'cuenta lo suprimido');
  const texto = fs.readFileSync(audit, 'utf8');
  assert.ok(!texto.includes(BAD) && !texto.includes('203.0.113.9'), 'sin tokens ni IP en claro');
  reset();
});

/* ───────── Estáticas ───────── */
test('estático: Astro no declara security.allowedDomains (si lo hiciera, clientAddress pasaría a ser el primer valor de X-Forwarded-For)', () => {
  const cfg = fs.readFileSync(path.join(process.cwd(), 'astro.config.mjs'), 'utf8');
  assert.ok(!/allowedDomains/.test(cfg), 'astro.config.mjs no debe definir allowedDomains sin revisar clientIp.ts');
});

test('estático: sólo los sitios previstos leen X-Forwarded-For (clientIp.ts es el punto único)', () => {
  const permitidos = new Set(['src/lib/clientIp.ts', 'src/lib/rateLimit.ts', 'src/lib/shareGeo.ts', 'src/lib/analytics.ts']);
  const hallados = [];
  const rec = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (/\.(ts|astro)$/.test(e.name) && /x-forwarded-for/i.test(fs.readFileSync(p, 'utf8'))) hallados.push(path.relative(process.cwd(), p).replace(/\\/g, '/'));
    }
  };
  rec(path.join(process.cwd(), 'src'));
  const fuera = hallados.filter((p) => !permitidos.has(p));
  assert.deepEqual(fuera, [], `lecturas directas de X-Forwarded-For fuera del punto único: ${fuera.join(', ')}`);
  // la API de automatización usa el modo estricto
  const api = fs.readFileSync(path.join(process.cwd(), 'src/lib/automationApi.ts'), 'utf8');
  assert.match(api, /resolveClientIp\(request, 'strict'\)/);
  assert.ok(!/x-forwarded-for/i.test(api));
});
