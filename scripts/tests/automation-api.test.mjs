// API de automatización (etapa 2.2): desactivada por defecto, tokens propios con caducidad y revocación, alcances mínimos, límites, auditoría,
// minimización de datos (sin afiliación, comisiones ni descripciones) y AUSENCIA TOTAL de escrituras sobre el catálogo.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setupIsolatedData, adminCookie } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-automation-api-');
delete process.env.AUTOMATION_API_ENABLED;
const A = await import('../../src/lib/automationApi.ts');
const C = await import('../../src/lib/automationCatalog.ts');
const catalogRoute = await import('../../src/pages/api/automation/v1/catalog.ts');
const meRoute = await import('../../src/pages/api/automation/v1/me.ts');
const adminRoute = await import('../../src/pages/api/admin/automation-clients.ts');
const v1Feed = await import('../../src/pages/api/v1/products/index.ts');
const f = (n) => path.join(dir, n);
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const B = 'http://localhost';

const MARCAS = { aff: 'https://marca-afiliado-secreta.example/?tag=SECRETO', desc: 'DESCRIPCION-LARGA-NO-DEBE-SALIR', extra: 'EXTRA-INTERNO-NO-DEBE-SALIR', comision: 'COMISION-NO-DEBE-SALIR' };
const prod = (i, over = {}) => ({
  id: `p${String(i).padStart(3, '0')}`, slug: `p${i}`, title: `Producto de prueba ${i}`, price: 10 + i, originalPrice: i % 2 ? 40 + i : undefined, category: i % 3 ? 'Sonido' : 'Hogar', network: i % 2 && i !== 1 ? 'amazon' : 'aliexpress', // p001 = AliExpress: allí 4,8/100 es el valor por defecto del alta

  merchant: 'Tienda', currency: 'EUR', inStock: i % 4 !== 0, image: '/images/products/x.jpg', affiliateUrl: MARCAS.aff, sourceId: `S${i}`, description: `${MARCAS.desc} `.repeat(5),
  rating: i === 1 ? 4.8 : 4.1, reviewsCount: i === 1 ? 100 : 25, commission: MARCAS.comision, extra: { secreto: MARCAS.extra }, ...over,
});
const N = 130;
fs.writeFileSync(f('products.json'), JSON.stringify(Array.from({ length: N }, (_, i) => prod(i + 1))));
fs.writeFileSync(f('categories.json'), JSON.stringify([{ id: 'sonido', name: 'Sonido', slug: 'sonido', icon: '🎧', keywords: [] }]));
fs.writeFileSync(f('sections.json'), '[]');
fs.writeFileSync(f('deleted-product-ids.json'), '[]');
const DATOS = ['products.json', 'categories.json', 'sections.json', 'deleted-product-ids.json'];
const huellaDatos = () => DATOS.map((n) => sha(f(n))).join('|');
const ANTES = huellaDatos();

const req = (url, { method = 'GET', token, ip, headers = {}, body } = {}) =>
  new Request(B + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}), ...headers }, body });
const cat = (url, o) => catalogRoute.GET({ request: req(url, o) });
const adminReq = async (body, { method = 'POST', csrf = true, cookie = true, raw } = {}) =>
  adminRoute[method]({ request: new Request(`${B}/api/admin/automation-clients`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: await adminCookie() } : {}), ...(csrf ? { 'X-Automation-Admin': '1' } : {}) }, body: method === 'GET' ? undefined : (raw ?? JSON.stringify(body)) }) });
const crear = async (over = {}) => {
  const r = await adminReq({ action: 'create', name: 'n8n-investigador', scopes: ['catalog:read'], ...over });
  return { status: r.status, ...(await r.json()) };
};
const leerStore = () => JSON.parse(fs.readFileSync(f('automation-clients.json'), 'utf8'));

/* ───────── Desactivada por defecto ───────── */
test('desactivada por defecto: todas las rutas responden 404 (como si no existieran) y no se crea ningún archivo', async () => {
  for (const r of [await cat('/api/automation/v1/catalog'), await meRoute.GET({ request: req('/api/automation/v1/me') }), await adminReq(undefined, { method: 'GET' }), await adminReq({ action: 'create', name: 'x', scopes: ['catalog:read'] })]) {
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { success: false, code: 'no_encontrado' });
  }
  assert.equal((await catalogRoute.ALL({ request: req('/x', { method: 'DELETE' }) })).status, 404);
  assert.ok(!fs.existsSync(f('automation-clients.json')) && !fs.existsSync(f('automation-audit.jsonl')));
  assert.equal(A.automationEnabled(), false);
  for (const v of ['1', 'TRUE', 'yes', ' true']) { process.env.AUTOMATION_API_ENABLED = v; assert.equal(A.automationEnabled(), false, `«${v}» no la activa: sólo «true»`); }
  delete process.env.AUTOMATION_API_ENABLED;
  process.env.AUTOMATION_API_ENABLED = 'true'; // a partir de aquí, activada para el resto de pruebas
});


/* ───────── Alta, almacenamiento y revocación ───────── */
test('alta: sólo un administrador con CSRF; el token se muestra una vez y en disco sólo queda su huella', async () => {
  assert.equal((await adminReq({ action: 'create', name: 'x', scopes: ['catalog:read'] }, { cookie: false })).status, 401, 'sin sesión de administrador');
  assert.equal((await adminReq({ action: 'create', name: 'x', scopes: ['catalog:read'] }, { csrf: false })).status, 403, 'sin cabecera CSRF');
  assert.equal((await adminReq(undefined, { raw: 'x'.repeat(5000) })).status, 413);
  assert.equal((await adminReq(undefined, { raw: '{no json' })).status, 400);
  assert.equal((await adminReq({ action: 'otra' })).status, 400);
  const r = await crear();
  assert.equal(r.status, 201);
  assert.match(r.token, /^tai_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  assert.equal(r.client.status, 'activo');
  assert.deepEqual(r.client.scopes, ['catalog:read']);
  assert.ok(!('secretHash' in r.client) && !('salt' in r.client));
  const secreto = r.token.split('_').slice(2).join('_');
  const disco = fs.readFileSync(f('automation-clients.json'), 'utf8');
  assert.ok(!disco.includes(secreto) && !disco.includes(r.token), 'el secreto no se guarda en claro');
  assert.ok(disco.includes(r.client.id));
  const lista = await (await adminReq(undefined, { method: 'GET' })).json();
  assert.ok(!JSON.stringify(lista).includes(secreto) && !JSON.stringify(lista).includes('secretHash'));
  assert.deepEqual(lista.scopesAvailable, ['catalog:read']);
  assert.equal((await adminRoute.ALL({ request: req('/api/admin/automation-clients', { method: 'PUT' }) })).status, 405);
});

test('alta: validaciones estrictas (alcance inexistente, caducidad, límites, nombre)', async () => {
  for (const [over, code] of [
    [{ scopes: ['catalog:write'] }, 'alcance_no_existe'], [{ scopes: ['products:write', 'catalog:read'] }, 'alcance_no_existe'], [{ scopes: ['*'] }, 'alcance_no_existe'], [{ scopes: [] }, 'alcances_obligatorios'], [{ scopes: undefined }, 'alcances_obligatorios'],
    [{ ttlDays: 91 }, 'caducidad_no_valida'], [{ ttlDays: 0 }, 'caducidad_no_valida'], [{ ttlDays: 1.5 }, 'caducidad_no_valida'], [{ ratePerMinute: 0 }, 'limite_no_valido'], [{ ratePerMinute: 121 }, 'limite_no_valido'], [{ dailyQuota: 20001 }, 'cuota_no_valida'],
    [{ name: '' }, 'nombre_no_valido'], [{ name: '<script>' }, 'nombre_no_valido'], [{ name: 'x'.repeat(81) }, 'nombre_no_valido'],
  ]) {
    const r = await crear(over);
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.equal(r.code, code);
  }
  assert.deepEqual(A.AUTOMATION_SCOPES, ['catalog:read'], 'no existe ningún alcance de escritura');
});

let TOKEN;
let CLIENTE;
test('catálogo: con un token válido devuelve sólo los campos permitidos (y nada de afiliación, comisiones, descripciones ni extra)', async () => {
  const r = await crear({ name: 'investigador' });
  TOKEN = r.token;
  CLIENTE = r.client;
  const res = await cat('/api/automation/v1/catalog?limit=100&page=1', { token: TOKEN });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const texto = await res.text();
  const j = JSON.parse(texto);
  assert.equal(j.success, true);
  assert.equal(j.schema, 'automation-catalog/1');
  assert.equal(j.total, N);
  assert.equal(j.totalPages, 2);
  assert.equal(j.products.length, 100);
  for (const marca of Object.values(MARCAS)) assert.ok(!texto.includes(marca), `no debe filtrarse: ${marca}`);
  assert.ok(!/affiliateUrl|outbound|commission|comision|secreto/i.test(Object.keys(j.products[0]).join(',')));
  const CAMPOS = ['id', 'title', 'category', 'categoryId', 'subcategoryId', 'network', 'merchant', 'price', 'currency', 'declaredPreviousPrice', 'verifiedDiscount', 'stock', 'rating', 'reviewsCount', 'ratingFlag', 'image', 'descriptionLength', 'hasAffiliateLink', 'capturedAt', 'verifiedAt', 'addedAt'].sort();
  for (const p of j.products) assert.deepEqual(Object.keys(p).sort(), CAMPOS);
  const p1 = j.products.find((p) => p.id === 'p001');
  assert.equal(p1.rating, null, 'el 4,8/100 por defecto no se presenta como valoración');
  assert.equal(p1.ratingFlag, 'por_defecto');
  assert.equal(p1.verifiedDiscount, null, 'un precio anterior declarado no es un descuento verificado');
  assert.equal(p1.declaredPreviousPrice, 41);
  assert.equal(p1.hasAffiliateLink, true);
  assert.ok(p1.descriptionLength > 40);
  const pagina2 = await (await cat('/api/automation/v1/catalog?limit=100&page=2', { token: TOKEN })).json();
  assert.equal(pagina2.products.length, 30);
  assert.deepEqual([...j.products, ...pagina2.products].map((p) => p.id), Array.from({ length: N }, (_, i) => `p${String(i + 1).padStart(3, '0')}`), 'orden estable y sin repeticiones');
  const filtro = await (await cat('/api/automation/v1/catalog?category=Hogar&network=amazon', { token: TOKEN })).json();
  assert.ok(filtro.products.every((p) => p.category === 'Hogar' && p.network === 'amazon'));
  const yo = await (await meRoute.GET({ request: req('/api/automation/v1/me', { token: TOKEN }) })).json();
  assert.equal(yo.client.id, CLIENTE.id);
  assert.equal(yo.readOnly, true);
  assert.ok(!JSON.stringify(yo).includes('secretHash'));
});

test('verificado: un descuento sólo aparece con una observación verificada que coincide con el precio publicado', async () => {
  const conObs = prod(200, { price: 50, originalPrice: 80, extra: { observations: [{ price: 50, originalPrice: 80, verifiedAt: new Date().toISOString(), context: { currency: 'EUR' } }] } });
  const out = C.projectProduct(conObs);
  assert.equal(out.verifiedDiscount.pct, 37.5);
  assert.equal(out.verifiedDiscount.previousPrice, 80);
  assert.equal(C.projectProduct({ ...conObs, price: 49 }).verifiedDiscount, null, 'si el precio cambió, la observación ya no vale');
  assert.equal(C.projectProduct(prod(201, { originalPrice: 90 })).verifiedDiscount, null);
  assert.equal(C.projectProduct(prod(202, { inStock: false })).stock, 'out_of_stock');
  assert.equal(C.projectProduct(prod(203, { inStock: undefined })).stock, 'unknown');
});

/* ───────── Rechazo de tokens y alcances ───────── */
test('rechazo: sin token, token general, formato, secreto incorrecto o ajeno → 401 con mensaje genérico idéntico', async () => {
  const otro = await crear({ name: 'otro' });
  const [, id, secreto] = TOKEN.match(/^tai_([0-9a-f]{16})_(.+)$/);
  const casos = [
    undefined, 'test-token-123', 'tai_', 'Basic xx', `tai_${id}_${'A'.repeat(43)}`, `tai_${'0'.repeat(16)}_${secreto}`, `tai_${id}_${secreto.slice(1)}X`,
    `tai_${id}_${otro.token.split('_').slice(2).join('_')}`, `${TOKEN}extra`, `${TOKEN}${TOKEN}`,
  ];
  const mensajes = new Set();
  for (const [i, token] of casos.entries()) {
    const r = await cat('/api/automation/v1/catalog', { token, ip: `10.9.0.${i}` });
    assert.equal(r.status, 401, String(token));
    assert.match(r.headers.get('www-authenticate') ?? '', /Bearer/);
    mensajes.add(JSON.stringify(await r.json()));
  }
  assert.equal(mensajes.size, 1, 'no se distingue por qué falló (sin enumeración de clientes)');
  assert.equal((await cat('/api/automation/v1/catalog', { headers: { Authorization: 'Bearer test-token-123' } })).status, 401, 'el token general NO sirve');
  assert.equal((await meRoute.GET({ request: req('/api/automation/v1/me', { token: 'test-token-123' }) })).status, 401);
});

test('aislamiento de tokens: el token de automatización no sirve en la API v1 ni en el panel, y el general no sirve aquí', async () => {
  const feed = await v1Feed.GET({ request: req('/api/v1/products', { token: TOKEN }), url: new URL(B + '/api/v1/products') });
  assert.equal(feed.status, 401);
  assert.equal((await adminReq(undefined, { method: 'GET', cookie: false })).status, 401);
  const conToken = await adminRoute.GET({ request: req('/api/admin/automation-clients', { token: TOKEN }) });
  assert.equal(conToken.status, 401, 'un token de automatización no administra clientes');
});

test('caducidad, revocación y alcance insuficiente', async () => {
  A.resetAutomationLimits();
  const caduca = await crear({ name: 'caduca', ttlDays: 1 });
  assert.equal((await cat('/api/automation/v1/catalog?limit=1', { token: caduca.token })).status, 200);
  const doc = leerStore();
  doc.clients.find((c) => c.id === caduca.client.id).expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(f('automation-clients.json'), JSON.stringify(doc));
  assert.equal((await cat('/api/automation/v1/catalog?limit=1', { token: caduca.token })).status, 401, 'caducado');
  assert.equal((await (await adminReq(undefined, { method: 'GET' })).json()).clients.find((c) => c.id === caduca.client.id).status, 'caducado');

  const revocable = await crear({ name: 'revocable' });
  assert.equal((await cat('/api/automation/v1/catalog?limit=1', { token: revocable.token })).status, 200);
  const rv = await adminReq({ action: 'revoke', id: revocable.client.id });
  assert.equal(rv.status, 200);
  assert.equal((await cat('/api/automation/v1/catalog?limit=1', { token: revocable.token })).status, 401, 'revocación inmediata');
  assert.equal((await adminReq({ action: 'revoke', id: 'f'.repeat(16) })).status, 404);
  assert.equal((await cat('/api/automation/v1/catalog?limit=1', { token: TOKEN })).status, 200, 'revocar uno no afecta a los demás');

  const sinAlcance = await crear({ name: 'sin-alcance' });
  const d2 = leerStore();
  d2.clients.find((c) => c.id === sinAlcance.client.id).scopes = [];
  fs.writeFileSync(f('automation-clients.json'), JSON.stringify(d2));
  const r = await cat('/api/automation/v1/catalog?limit=1', { token: sinAlcance.token });
  assert.equal(r.status, 403);
});

/* ───────── Límites ───────── */
test('límites: por minuto (429 con Retry-After), cuota diaria y bloqueo de IP tras intentos fallidos', async () => {
  A.resetAutomationLimits();
  const lento = await crear({ name: 'lento', ratePerMinute: 2 });
  assert.equal((await cat('/api/automation/v1/catalog?limit=1', { token: lento.token })).status, 200);
  assert.equal((await cat('/api/automation/v1/catalog?limit=1', { token: lento.token })).status, 200);
  const r = await cat('/api/automation/v1/catalog?limit=1', { token: lento.token });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
  const cuota = await crear({ name: 'cuota', dailyQuota: 1 });
  assert.equal((await cat('/api/automation/v1/catalog?limit=1', { token: cuota.token })).status, 200);
  assert.equal((await cat('/api/automation/v1/catalog?limit=1', { token: cuota.token })).status, 429);
  A.resetAutomationLimits();
  for (let i = 0; i < 20; i++) assert.equal((await cat('/api/automation/v1/catalog', { token: 'tai_malo', ip: '203.0.113.9' })).status, 401);
  assert.equal((await cat('/api/automation/v1/catalog', { token: TOKEN, ip: '203.0.113.9' })).status, 429, 'IP bloqueada tras 20 fallos');
  assert.equal((await cat('/api/automation/v1/catalog', { token: TOKEN, ip: '198.51.100.7' })).status, 200, 'otra IP no se ve afectada');
  A.resetAutomationLimits();
});

/* ───────── Parámetros y métodos ───────── */
test('parámetros: lo desconocido, repetido o fuera de rango se rechaza (400); sólo GET (405)', async () => {
  A.resetAutomationLimits();
  for (const q of ['limit=0', 'limit=101', 'limit=abc', 'limit=1&limit=2', 'page=0', 'page=10001', 'page=-1', 'x=1', 'category=<b>', 'sort=precio', 'limit=1e2', 'limit=%00']) {
    const r = await cat(`/api/automation/v1/catalog?${q}`, { token: TOKEN });
    assert.equal(r.status, 400, q);
    assert.equal((await r.json()).code, 'parametros_no_validos');
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = await catalogRoute.ALL({ request: req('/api/automation/v1/catalog', { method, token: TOKEN, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'p001', price: 1 }) }) });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.get('allow'), 'GET');
  }
  assert.equal(typeof catalogRoute.POST, 'undefined');
  assert.equal(typeof catalogRoute.PUT, 'undefined');
  assert.equal(typeof catalogRoute.DELETE, 'undefined');
  A.resetAutomationLimits();
});

/* ───────── Sin escrituras ───────── */
test('AUSENCIA DE ESCRITURAS: nada de lo anterior modificó productos, categorías, secciones ni retirados', () => {
  assert.equal(huellaDatos(), ANTES, 'los datos del catálogo quedaron idénticos');
  const permitidos = new Set(['products.json', 'categories.json', 'sections.json', 'deleted-product-ids.json', 'automation-clients.json', 'automation-clients.json.bak', 'automation-audit.jsonl', 'images', 'users.json']);
  const extra = fs.readdirSync(dir).filter((n) => !permitidos.has(n) && !/\.tmp$/.test(n));
  assert.deepEqual(extra, [], 'sólo se escriben el almacén de clientes y la auditoría');
});

test('estático: las rutas de automatización no importan nada que escriba (productos, categorías, precios, portada) ni exponen métodos de escritura', () => {
  const root = new URL('../../', import.meta.url);
  for (const rel of ['src/pages/api/automation/v1/catalog.ts', 'src/pages/api/automation/v1/me.ts', 'src/lib/automationCatalog.ts']) {
    const t = fs.readFileSync(new URL(rel, root), 'utf8');
    assert.doesNotMatch(t, /export const (POST|PUT|PATCH|DELETE)\b/, rel);
    assert.doesNotMatch(t, /productStore|writeProducts|upsert|catalogStore|homeLayout|categories['"]|offerRefresh|writeFileSync|appendFileSync|saveCatalog/i, `${rel}: no debe importar ni usar escrituras`);
  }
  const lib = fs.readFileSync(new URL('src/lib/automationApi.ts', root), 'utf8');
  const codigo = lib.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(codigo, /TRADYLOR_API_TOKEN|isValidApiToken|apiAuth/, 'no usa el token general');
  assert.match(lib, /AUTOMATION_API_ENABLED/);
});

/* ───────── Auditoría ───────── */
test('auditoría: registra accesos, rechazos y altas/revocaciones, sin tokens ni IP en claro', async () => {
  const lineas = fs.readFileSync(f('automation-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const eventos = new Set(lineas.map((l) => l.event));
  for (const e of ['cliente_creado', 'cliente_revocado', 'peticion', 'denegado', 'limite']) assert.ok(eventos.has(e), `falta el evento ${e}`);
  const bruto = fs.readFileSync(f('automation-audit.jsonl'), 'utf8');
  assert.ok(!bruto.includes(TOKEN) && !bruto.includes(TOKEN.split('_').slice(2).join('_')), 'sin tokens');
  assert.ok(!/203\.0\.113\.9|198\.51\.100\.7|10\.9\.0\./.test(bruto), 'sin IP en claro');
  assert.ok(lineas.some((l) => l.clientId === CLIENTE.id && l.status === 200 && l.items >= 1));
  assert.ok(lineas.some((l) => l.reason === 'revocado') && lineas.some((l) => l.reason === 'caducado') && lineas.some((l) => l.reason === 'token_incorrecto'));
  const vista = await (await adminReq(undefined, { method: 'GET' })).json();
  assert.equal(vista.audit, undefined, 'sin ?audit no se devuelve el registro');
  const conAudit = await adminRoute.GET({ request: new Request(`${B}/api/admin/automation-clients?audit=5`, { headers: { Cookie: await adminCookie() } }) });
  assert.equal((await conAudit.json()).audit.length, 5);
});

/* ───────── Almacén dañado ───────── */
test('almacén dañado: la autenticación falla cerrada, no se crean clientes y el archivo no se sobrescribe', async () => {
  A.resetAutomationLimits();
  const bueno = fs.readFileSync(f('automation-clients.json'), 'utf8');
  fs.writeFileSync(f('automation-clients.json'), '{"schemaVersion":1,"clients":[ROTO');
  const rotoSha = sha(f('automation-clients.json'));
  assert.equal((await cat('/api/automation/v1/catalog?limit=1', { token: TOKEN })).status, 401);
  const r = await crear({ name: 'no-debe-crearse' });
  assert.equal(r.status, 423);
  assert.equal((await adminReq(undefined, { method: 'GET' })).status, 423);
  assert.equal((await adminReq({ action: 'revoke', id: CLIENTE.id })).status, 423);
  assert.equal(sha(f('automation-clients.json')), rotoSha, 'el archivo dañado se conserva para diagnóstico');
  fs.writeFileSync(f('automation-clients.json'), bueno);
  A.resetAutomationLimits();
  assert.equal((await cat('/api/automation/v1/catalog?limit=1', { token: TOKEN })).status, 200, 'recuperado');
  // un cliente con datos incoherentes también invalida el archivo (no se acepta a medias)
  const d = JSON.parse(bueno);
  d.clients[0].scopes = ['catalog:write'];
  fs.writeFileSync(f('automation-clients.json'), JSON.stringify(d));
  assert.equal((await cat('/api/automation/v1/catalog?limit=1', { token: TOKEN })).status, 401, 'un alcance de escritura en el archivo no se acepta');
  fs.writeFileSync(f('automation-clients.json'), bueno);
});

test('límite de clientes activos', async () => {
  const lista = await (await adminReq(undefined, { method: 'GET' })).json();
  const activos = lista.clients.filter((c) => c.status === 'activo').length;
  for (let i = activos; i < A.MAX_CLIENTS; i++) assert.equal((await crear({ name: `c${i}` })).status, 201);
  const r = await crear({ name: 'uno-mas' });
  assert.equal(r.status, 409);
  assert.equal(r.code, 'limite_clientes');
});

/* ───────── Contrato: el feed REAL alimenta a los agentes ───────── */
test('contrato: lo que devuelve la API (projectProduct) lo entienden los agentes — candidatos, calidad y valoración por defecto', async () => {
  const inv = await import('../../automation/lib/researcher.mjs');
  const aud = await import('../../automation/lib/auditor.mjs');
  const cfg = JSON.parse(fs.readFileSync(new URL('../../automation/config/local.json', import.meta.url), 'utf8'));
  const feed = [
    prod(301, { price: 100, originalPrice: 150 }),
    prod(302, { price: 100, originalPrice: 150, inStock: false }), // agotado: no es candidato
    prod(303, { price: 100, originalPrice: 700 }), // descuento poco creíble
    prod(304, { price: 100, originalPrice: undefined }),
    prod(305, { price: 100, originalPrice: 150, description: 'corta' }),
    prod(306, { price: 20, originalPrice: undefined, network: 'aliexpress', rating: 4.8, reviewsCount: 100 }),
  ].map(C.projectProduct);
  const r = inv.buscarCandidatos(feed, cfg);
  assert.deepEqual(r.candidatos.map((c) => c.id).sort(), ['p301', 'p305'], 'el precio anterior declarado del feed real se interpreta; el agotado se excluye');
  assert.deepEqual(r.sospechosos.map((c) => c.id), ['p303']);
  const calidad = inv.problemasCalidad(feed);
  assert.ok(calidad.ejemplos.some((q) => q.id === 'p305' && q.faltan.includes('descripción')), 'usa descriptionLength del feed');
  const cat = aud.analizarCatalogo({ productos: feed, total: feed.length, totalPaginas: 1, errores: [] }, cfg, '2026-11-12T10:00:00.000Z');
  const ids = cat.map((i) => i.id);
  assert.ok(ids.some((i) => i.startsWith('catalogo:valoracion_por_defecto')), 'detecta la valoración por defecto con ratingFlag');
  assert.ok(ids.some((i) => i.startsWith('catalogo:descuento_sospechoso')), 'detecta el descuento sospechoso con declaredPreviousPrice');
  assert.ok(!ids.some((i) => /sin_precio|sin_imagen|precio_anterior_menor/.test(i)));
});
