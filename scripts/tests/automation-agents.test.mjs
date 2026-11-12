// Treidilor AI · Fase 2.0: lógica de los agentes (Auditor General v0 e Investigador comercial v0), política de URLs, workflows generados y
// simulación de punta a punta con respuestas de ejemplo. Sin red, sin n8n, sin tocar datos reales.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const J = (p) => JSON.parse(fs.readFileSync(path.join(RAIZ, p), 'utf8'));
const common = await import('../../automation/lib/common.mjs');
const politica = await import('../../automation/lib/urlPolicy.mjs');
const aud = await import('../../automation/lib/auditor.mjs');
const inv = await import('../../automation/lib/researcher.mjs');
const { simularWorkflow } = await import('../automation/simulate-workflow.mjs');
const { validarEsquema } = await import('../automation/validate-schema.mjs');
const { construirTodo } = await import('../automation/build-workflows.mjs');

const LOCAL = J('automation/config/local.json');
const PROD = J('automation/config/produccion.json');
const NOW = '2026-11-12T10:00:00.000Z';

/* ───────── configuración ───────── */
test('configuraciones válidas: local = completo (hosts locales) y producción = público (https, sin catálogo ni fichas)', () => {
  assert.deepEqual(common.validarConfig(LOCAL), []);
  assert.deepEqual(common.validarConfig(PROD), []);
  assert.equal(PROD.modo, 'publico');
  assert.equal(PROD.maxFichas, 0);
  assert.equal(PROD.maxPaginasCatalogo, 0);
  assert.equal(PROD.credencialCatalogo, '');
  assert.ok(PROD.baseUrl.startsWith('https://'));
  assert.ok(common.validarConfig({ ...LOCAL, modo: 'x' }).length > 0);
  assert.ok(common.validarConfig({ ...LOCAL, maxEnlaces: 9999 }).length > 0);
});

/* ───────── política de URLs ───────── */
test('política de URLs: sólo hosts permitidos; nunca salida de afiliado, API, panel, Mi Radar, checkout ni compartir', () => {
  for (const cfg of [LOCAL, PROD]) {
    const b = cfg.baseUrl;
    for (const mala of ['/api/redirect?id=1', '/out/abc', '/p/abc', '/checkout/x', '/upayp1b4', '/upayp1b4/portada', '/admin', '/mi-radar', '/perfil', '/share/x', '/api/admin/json-import', '/api/v1/products/delete-all', '/api/v1/products/import', '/api/radar/auth/login']) {
      assert.equal(politica.evaluarUrl(b + mala, 'enlace', cfg).ok, false, `${cfg.entorno}: ${mala} debe rechazarse`);
      assert.equal(politica.evaluarUrl(b + mala, 'ruta', cfg).ok, false);
    }
    assert.equal(politica.evaluarUrl('https://evil.example/', 'enlace', cfg).ok, false);
    assert.equal(politica.evaluarUrl('//evil.example/x', 'enlace', cfg).ok, false);
    assert.equal(politica.evaluarUrl('javascript:alert(1)', 'enlace', cfg).ok, false);
    assert.equal(politica.evaluarUrl('ftp://x/y', 'enlace', cfg).ok, false);
    assert.equal(politica.evaluarUrl(b.replace('://', '://user:pw@') + '/', 'enlace', cfg).ok, false, 'credenciales en la URL');
    assert.equal(politica.evaluarUrl(b + '/a/../upayp1b4', 'enlace', cfg).ok, false, 'ruta con ..');
    assert.equal(politica.evaluarUrl(b + '/%2e%2e/upayp1b4', 'enlace', cfg).ok, false);
    assert.equal(politica.evaluarUrl(b + '/catalogo?category=sonido', 'enlace', cfg).ok, true);
    assert.equal(politica.evaluarUrl(b + '/', 'ruta', cfg).ok, true);
  }
  // salud y catálogo sólo con su ruta exacta
  assert.equal(politica.evaluarUrl(LOCAL.baseUrl + '/api/health', 'salud', LOCAL).ok, true);
  assert.equal(politica.evaluarUrl(LOCAL.baseUrl + '/api/health2', 'salud', LOCAL).ok, false);
  assert.equal(politica.evaluarUrl(LOCAL.baseUrl + '/api/automation/v1/catalog?limit=100&page=1', 'catalogo', LOCAL).ok, true);
  assert.equal(politica.evaluarUrl(LOCAL.baseUrl + '/api/automation/v1/catalog/otra', 'catalogo', LOCAL).ok, false);
  assert.equal(politica.evaluarUrl(LOCAL.baseUrl + '/api/v1/products?limit=100&page=1', 'catalogo', LOCAL).ok, false, 'el feed del token general ya NO es una ruta permitida');
  assert.equal(politica.evaluarUrl(LOCAL.baseUrl + '/api/v1/products/import', 'catalogo', LOCAL).ok, false);
  assert.equal(politica.evaluarUrl(PROD.baseUrl + '/api/automation/v1/catalog?limit=1', 'catalogo', PROD).ok, false, 'en producción (modo público) no se lee el feed');
  // fichas: sólo en modo completo; en producción cada visita cuenta en la analítica
  assert.equal(politica.evaluarUrl(LOCAL.baseUrl + '/producto/abc-1', 'ficha', LOCAL).ok, true);
  assert.equal(politica.evaluarUrl(PROD.baseUrl + '/producto/abc-1', 'ficha', PROD).ok, false);
  assert.equal(politica.evaluarUrl(PROD.baseUrl + '/producto/abc-1', 'enlace', PROD).ok, false);
  assert.equal(politica.evaluarUrl(PROD.baseUrl.replace('https', 'http') + '/', 'ruta', PROD).ok, false, 'http fuera de local');
});

/* ───────── sitio simulado ───────── */
const relleno = 'x'.repeat(2500);
const html = (titulo, h1, enlaces = []) => `<!doctype html><html><head><title>${titulo}</title></head><body><h1>${h1}</h1>${enlaces.map((h) => `<a href="${h}">l</a>`).join('')}<p>${relleno}</p></body></html>`;
const PRODUCTOS = [
  { id: 'p1', title: 'Auriculares Bluetooth con cancelación de ruido', description: 'Auriculares inalámbricos con estuche de carga y autonomía de 30 horas.', price: 50, originalPrice: 100, currency: 'EUR', category: 'Sonido', merchant: 'Amazon', rating: 4.5, reviewsCount: 20, image: 'https://cdn.example.com/p1.jpg' },
  { id: 'p2', title: 'Cable USB-C trenzado de 2 metros', description: 'Cable de carga rápida con conectores reforzados y trenzado de nailon.', price: 5, originalPrice: 40, currency: 'EUR', category: 'Portabilidad', merchant: 'AliExpress', rating: 4.8, reviewsCount: 100, image: 'https://cdn.example.com/p2.jpg' },
  { id: 'p3', title: 'Portátil 15 pulgadas 16 GB RAM', description: 'Portátil con pantalla Full HD, 16 GB de memoria y SSD de 512 GB.', price: 600, originalPrice: 750, currency: 'EUR', category: 'Informática', merchant: 'Amazon', rating: null, reviewsCount: null, image: 'https://cdn.example.com/p3.jpg' },
  { id: 'p4', title: 'Cable USB-C trenzado de 2 metros', description: '', price: 0, originalPrice: null, currency: 'EUR', category: '', merchant: '', image: '' },
  { id: 'p3', title: 'Portátil repetido con el mismo id', description: 'Duplicado de identificador para la prueba de integridad del catálogo.', price: 10, originalPrice: 5, currency: 'EUR', category: 'Informática', merchant: 'Amazon', image: 'ftp://malo/x.jpg' },
];
function sitio(cfg, { catalogo = PRODUCTOS, ficha500 = 'p3' } = {}) {
  const host = new URL(cfg.baseUrl).host;
  return ({ url, credencial }) => {
    const u = new URL(url);
    assert.equal(u.host, host, 'la petición sale del host permitido');
    const r = u.pathname;
    if (r === '/api/health') return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { status: 'ok', sourceHash: 'a'.repeat(64), uptimeSeconds: 9000, dataDirExists: true, env: { smtp: true } } };
    if (r === '/api/automation/v1/catalog') {
      if (!credencial) return { statusCode: 401, body: { success: false } };
      const page = Number(u.searchParams.get('page'));
      const lim = Number(u.searchParams.get('limit'));
      const trozo = catalogo.slice((page - 1) * lim, page * lim);
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { success: true, total: catalogo.length, page, limit: lim, totalPages: Math.ceil(catalogo.length / lim), products: trozo } };
    }
    if (r === '/') return { statusCode: 200, body: html('Treidilor', 'Compra con datos', ['/catalogo', '/categorias', '/roto', '/api/redirect?id=1', '/out/p1', '//evil.example/x', 'https://evil.example/', 'javascript:alert(1)', '/upayp1b4', '/producto/p1', '/checkout/p1', 'mailto:a@b.c', '#arriba', '/catalogo?category=sonido', '/metodologia']) };
    if (r === '/catalogo') return { statusCode: 200, body: html('Catálogo', 'Catálogo completo', ['/catalogo?page=2']) };
    if (r === '/categorias') return { statusCode: 200, body: html('Categorías', 'Todas las categorías') };
    if (r === '/metodologia') return { statusCode: 200, body: html('Metodología', 'Cómo trabajamos') };
    if (r === '/alertas-precio') return { statusCode: 200, body: html('Alertas', 'Alertas de precio') };
    if (r === '/roto') return { statusCode: 404, body: 'no existe' };
    if (r.startsWith('/producto/')) return r === `/producto/${ficha500}` ? { statusCode: 500, body: 'error' } : { statusCode: 200, body: html('Ficha', 'Ficha') };
    return { statusCode: 404, body: 'no' };
  };
}
const PROHIBIDAS = [/^\/api\/redirect/, /^\/out\//, /^\/p\//, /^\/checkout/, /^\/upayp1b4/, /^\/admin/, /^\/mi-radar/, /^\/api\/(admin|radar|alertas|v1\/products\/(import|delete-all|build-catalog))/];

// Los resultados de los nodos Code vienen de otro contexto de ejecución (vm): se pasan a objetos planos para compararlos.
const plano = (x) => JSON.parse(JSON.stringify(x));
function simular(nombreArchivo, cfg, opciones) {
  const wf = J(`automation/workflows/${nombreArchivo}`);
  const r = simularWorkflow(wf, { fetchSimulado: sitio(cfg, opciones), ahora: NOW, hostsPermitidos: cfg.hostsPermitidos });
  return { wf, ...r, informe: plano(r.salida[0].json) };
}

/* ───────── Auditor General: simulación completa (local) ───────── */
test('Auditor local: recorre salud, rutas, enlaces, feed y fichas; detecta lo real y NUNCA pide rutas con efectos', () => {
  const { informe, peticiones } = simular('auditor-general.local.json', LOCAL);
  assert.deepEqual(validarEsquema(informe, J('automation/schemas/informe-auditor.schema.json')), []);
  assert.equal(informe.soloLectura, true);
  assert.equal(informe.agente, 'auditor-general');
  assert.ok(peticiones.length > 8, `peticiones: ${peticiones.length}`);
  for (const p of peticiones) {
    assert.equal(p.metodo, 'GET');
    const u = new URL(p.url);
    assert.equal(u.host, 'puente-treidilor:4350');
    for (const re of PROHIBIDAS) assert.doesNotMatch(u.pathname, re, `ruta prohibida solicitada: ${p.url}`);
    assert.equal(p.credencial, p.nodo.startsWith('Pedir catálogo'), 'sólo el feed del catálogo lleva credencial');
  }
  const ids = informe.incidencias.map((i) => i.id);
  assert.ok(ids.includes('enlace:roto:http://puente-treidilor:4350/roto'), 'enlace roto detectado');
  assert.ok(!peticiones.some((p) => p.url.includes('/producto/')), 'por defecto NO se visitan fichas (cada visita escribe historial y analítica)');
  const ficha = { id: 'ficha:x', tipo: 'ficha', url: `${LOCAL.baseUrl}/producto/x`, productoId: 'x' };
  assert.ok(aud.analizarFichas([ficha], [{ statusCode: 500, headers: {}, data: 'x' }]).incidencias.some((i) => i.id.startsWith('ficha:error_servidor')), 'ficha con error 500 detectada');
  for (const c of ['catalogo:ids_duplicados', 'catalogo:sin_precio', 'catalogo:sin_imagen', 'catalogo:sin_categoria', 'catalogo:titulos_repetidos', 'catalogo:precio_anterior_menor', 'catalogo:descuento_sospechoso', 'catalogo:imagen_no_segura', 'catalogo:valoracion_por_defecto']) assert.ok(ids.includes(c), `falta ${c}`);
  assert.equal(informe.resumen.estado, 'atencion');
  assert.match(informe.markdown, /Auditor General/);
  assert.ok(informe.cobertura.noRevisado.some((x) => /Programadores internos/.test(x)), 'declara lo que NO revisa');
  // no pidió el enlace con efectos aunque aparecieran en la home
  assert.ok(!peticiones.some((p) => /redirect|\/out\/|checkout|upayp1b4|evil/.test(p.url)));
});

test('Auditor local con servidor sano: sin incidencias críticas y estado ok', () => {
  const buenos = PRODUCTOS.slice(0, 3).map((p) => ({ ...p, rating: null, reviewsCount: null, originalPrice: null }));
  const { informe } = simular('auditor-general.local.json', { ...LOCAL, rutas: ['/', '/catalogo', '/categorias', '/metodologia'] }, { catalogo: buenos, ficha500: 'ninguna' });
  assert.equal(informe.incidencias.filter((i) => ['critica', 'alta'].includes(i.gravedad)).some((i) => i.area !== 'enlace'), false, JSON.stringify(informe.incidencias.filter((i) => ['critica', 'alta'].includes(i.gravedad)).map((i) => i.id)));
});

test('Auditor PRODUCCIÓN (público): sin credenciales, sin feed, sin fichas, sólo páginas públicas y salud', () => {
  const { informe, peticiones, wf } = simular('auditor-general.produccion.json', PROD);
  assert.deepEqual(validarEsquema(informe, J('automation/schemas/informe-auditor.schema.json')), []);
  assert.equal(informe.modo, 'publico');
  assert.ok(!wf.nodes.some((n) => n.credentials), 'el workflow de producción no lleva credenciales');
  assert.ok(!wf.nodes.some((n) => /catálogo|fichas/i.test(n.name)));
  for (const p of peticiones) {
    const u = new URL(p.url);
    assert.equal(u.host, 'treidilor.com');
    assert.equal(u.protocol, 'https:');
    assert.equal(p.credencial, false);
    assert.doesNotMatch(u.pathname, /^\/producto/, 'las fichas cuentan en la analítica: nunca en producción');
    assert.ok(!PROHIBIDAS.some((re) => re.test(u.pathname)), p.url);
  }
  assert.ok(peticiones.length <= 1 + PROD.rutas.length + PROD.maxEnlaces);
  assert.ok(informe.cobertura.noRevisado.some((x) => /analítica/.test(x)));
  assert.equal(informe.resumen.fichasRevisadas, 0);
  assert.equal(informe.resumen.paginasCatalogo, 0);
});

test('Auditor: servidor caído, 500 y página con «Internal server error» tras un 200 → críticas', () => {
  const wf = J('automation/workflows/auditor-general.produccion.json');
  const caido = simularWorkflow(wf, { fetchSimulado: () => { throw new Error('ECONNREFUSED'); }, ahora: NOW }).salida[0].json;
  assert.equal(caido.resumen.estado, 'critico');
  assert.ok(caido.incidencias.some((i) => i.id === 'salud:sin_respuesta'));
  const raro = simularWorkflow(wf, {
    ahora: NOW,
    fetchSimulado: ({ url }) => {
      const r = new URL(url).pathname;
      if (r === '/api/health') return { statusCode: 200, body: { status: 'degraded', dataDirExists: false, uptimeSeconds: 10 } };
      if (r === '/') return { statusCode: 200, body: `<html><title>x</title><h1>a</h1>Internal server error${relleno}</html>` };
      if (r === '/catalogo') return { statusCode: 503, body: '' };
      return { statusCode: 200, body: html('t', 'h') };
    },
  }).salida[0].json;
  const ids = raro.incidencias.map((i) => i.id);
  assert.ok(ids.includes('salud:estado') && ids.includes('salud:sin_volumen'));
  assert.ok(ids.some((i) => i.startsWith('ruta:error_interno_200')));
  assert.ok(ids.some((i) => i.startsWith('ruta:error_servidor')));
  assert.ok(ids.includes('salud:reinicio_reciente'));
});

test('Auditor: HTML hostil no genera peticiones fuera de la política', () => {
  const malos = ['/api/redirect?id=1', '/out/x', 'http://puente-treidilor:4350/upayp1b4/portada', 'http://puente-treidilor:4351/', 'http://puente-treidilor:4350@evil.example/', '//evil.example', 'file:///etc/passwd', 'data:text/html,<script>', '/p/abc', '/api/v1/products/delete-all', '/checkout/1', '/mi-radar'];
  const pagina = html('t', 'h', malos);
  const objetivos = aud.crearObjetivosRutas(LOCAL);
  const respuestas = objetivos.map(() => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: pagina }));
  const t = aud.crearObjetivosEnlaces(objetivos, respuestas, LOCAL);
  assert.deepEqual(t.filter((x) => !x.marcador), [], JSON.stringify(t));
  assert.equal(t.length, 1);
  assert.equal(t[0].marcador, true, 'sin enlaces válidos: un único marcador a /api/health');
  assert.match(t[0].url, /\/api\/health$/);
});

test('Auditor: límites (máximo de enlaces y de fichas) y orden estable', () => {
  const enlaces = Array.from({ length: 200 }, (_, i) => `/catalogo?page=${i + 2}`);
  const objetivos = aud.crearObjetivosRutas({ ...LOCAL, rutas: ['/'] });
  const t = aud.crearObjetivosEnlaces(objetivos, objetivos.map(() => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: html('t', 'h', enlaces) })), { ...LOCAL, maxEnlaces: 7 });
  assert.equal(t.length, 7);
  assert.deepEqual(t.map((x) => x.url), [...t.map((x) => x.url)].sort());
  const fichas = aud.crearObjetivosFichas(Array.from({ length: 100 }, (_, i) => ({ id: `id-${String(i).padStart(3, '0')}` })), { ...LOCAL, maxFichas: 5 });
  assert.equal(fichas.length, 5);
  assert.equal(aud.crearObjetivosFichas([{ id: 'a' }], PROD)[0].marcador, true, 'en modo público no hay fichas');
});

/* ───────── Investigador comercial ───────── */
test('Investigador: candidatos con descuento DECLARADO (nunca verificado), sospechosos, calidad, huecos y duplicados', () => {
  const { informe, peticiones } = simular('investigador-comercial.local.json', LOCAL);
  assert.deepEqual(validarEsquema(informe, J('automation/schemas/informe-investigador.schema.json')), []);
  assert.equal(informe.soloLectura, true);
  assert.ok(peticiones.every((p) => p.metodo === 'GET' && (p.url.includes('/api/automation/v1/catalog?') || p.url.endsWith('/api/health')) && p.credencial));
  const paginasPedidas = peticiones.filter((p) => p.url.includes('/api/automation/v1/catalog?')).length;
  assert.equal(paginasPedidas, 1, 'con 6 productos y límite 100 sólo se pide UNA página del feed (el resto es un marcador /api/health)');
  const ids = informe.candidatos.map((c) => c.id);
  assert.ok(ids.includes('p1') && ids.includes('p3'), 'candidatos con descuento declarado razonable');
  assert.ok(!ids.includes('p2'), 'un descuento declarado del 87 % no es creíble');
  assert.ok(informe.sospechosos.some((s) => s.id === 'p2'));
  for (const c of informe.candidatos) {
    assert.equal(c.confianza, 'baja');
    assert.match(c.advertencias[0], /NO está verificado/);
    assert.match(c.motivos[0], /DECLARADO.*NO verificado/);
  }
  assert.ok(informe.calidad.total >= 1 && informe.calidad.ejemplos.some((q) => q.id === 'p4'));
  assert.ok(informe.huecos.length >= 1);
  assert.ok(informe.duplicados.some((d) => d.ids.includes('p2') && d.ids.includes('p4')));
  assert.ok(informe.limitaciones.some((l) => /verificad/.test(l)));
  assert.doesNotMatch(informe.markdown, /recomendamos|recomendado|el mejor/i, 'el informe no recomienda: propone revisar');
  // determinista
  const otra = simular('investigador-comercial.local.json', LOCAL).informe;
  assert.deepEqual(otra, informe);
});

test('Investigador: no inventa nada — sin precio anterior no hay candidato; sin catálogo, informe vacío y explicado', () => {
  const sinDescuento = PRODUCTOS.map((p) => ({ ...p, originalPrice: null }));
  const r = simular('investigador-comercial.local.json', LOCAL, { catalogo: sinDescuento }).informe;
  assert.deepEqual(r.candidatos, []);
  const vacio = simular('investigador-comercial.local.json', LOCAL, { catalogo: [] }).informe;
  assert.equal(vacio.resumen.productosAnalizados, 0);
  assert.deepEqual(vacio.candidatos, []);
  const sinCred = simularWorkflow(J('automation/workflows/investigador-comercial.local.json'), { ahora: NOW, fetchSimulado: () => ({ statusCode: 401, body: '{}' }) }).salida[0].json;
  const sinCredPlano = plano(sinCred);
  assert.equal(sinCredPlano.resumen.productosAnalizados, 0);
  assert.ok(sinCredPlano.limitaciones.some((l) => /Errores al leer/.test(l)));
});

test('estadísticas básicas: mediana, plegado de texto y recorte', () => {
  assert.equal(common.mediana([3, 1, 2]), 2);
  assert.equal(common.mediana([1, 2, 3, 4]), 2.5);
  assert.equal(common.mediana([]), null);
  assert.equal(common.plegar('  ÁrBol  Ñandú '), 'arbol nandu');
  assert.equal(common.recortar('a'.repeat(300), 10).length, 10);
});

// Hallazgos de la primera ejecución en n8n real (12/11/2026): el entorno Code NO tiene URL ni URLSearchParams.
test('política de URLs sin `URL` global (entorno Code de n8n): mismas decisiones y extracción de enlaces sin <script>', async () => {
  const vm = await import('node:vm');
  const src = fs.readFileSync(new URL('../../automation/lib/urlPolicy.mjs', import.meta.url), 'utf8').replace(/^export\s+/gm, '');
  const ctx = vm.createContext({});
  vm.runInContext(`${src}\nglobalThis.__p = { normalizarUrl, evaluarUrl };`, ctx);
  const p = ctx.__p;
  assert.equal(vm.runInContext('typeof URL', ctx), 'undefined');
  const cfg = JSON.parse(JSON.stringify({ ...LOCAL }));
  const ok = (u, t = 'enlace') => p.evaluarUrl(u, t, cfg).ok;
  assert.equal(ok(`${cfg.baseUrl}/catalogo?category=sonido#x`), true);
  assert.equal(ok('/catalogo'), true);
  assert.equal(ok('//evil.example/x'), false);
  assert.equal(ok('javascript:alert(1)'), false);
  assert.equal(ok('/a/../upayp1b4'), false);
  assert.equal(ok('/api/redirect?id=1'), false);
  assert.equal(ok(`${cfg.baseUrl}/api/health`, 'salud'), true);
  assert.equal(ok(`${cfg.baseUrl.replace('://', '://u:p@')}/`), false);
  assert.equal(ok(`${cfg.baseUrl}\@evil.example/`), false);
  const html = '<a href="/catalogo">x</a><script>const h = `<a href="/${escapeHtml(c.url)}">`;</script><!-- <a href="/oculto"> --><a href="/${y}">z</a>';
  const enl = aud.extraerEnlaces(html, `${LOCAL.baseUrl}/`);
  assert.equal(enl.length, 1);
  assert.match(enl[0], /\/catalogo$/);
});

test('el cuerpo de la respuesta HTTP se lee de `data` (n8n real) o `body` (simulador)', () => {
  const t = { id: 'salud', tipo: 'salud', url: `${LOCAL.baseUrl}/api/health` };
  for (const campo of ['data', 'body']) {
    const r = { statusCode: 200, headers: {}, [campo]: JSON.stringify({ status: 'ok', sourceHash: 'x', env: {} }) };
    const inc = aud.analizarSalud([t], [r]).incidencias;
    assert.ok(!inc.some((i) => i.id === 'salud:sin_datos'), `campo ${campo}`);
  }
});

/* ───────── Auditor v0.2: feed sin páginas innecesarias y avisos del entorno local ───────── */
test('Auditor v0.2: sólo se piden las páginas del feed que existen (1 página con ≤ 100 productos, 3 con 250) y respeta el tope', () => {
  const grande = (n) => Array.from({ length: n }, (_, i) => ({ id: `g${String(i).padStart(4, '0')}`, title: `Producto de prueba número ${i}`, price: 10 + i, category: `Cat ${i % 7}`, merchant: 'Tienda', image: '/i.jpg', descriptionLength: 200, rating: 4.1, reviewsCount: 30 + i }));
  const paginas = (n, cfg = LOCAL) => simular('auditor-general.local.json', cfg, { catalogo: grande(n) }).peticiones.filter((p) => p.url.includes('/api/automation/v1/catalog?')).map((p) => Number(new URL(p.url).searchParams.get('page')));
  assert.deepEqual(paginas(60), [1]);
  assert.deepEqual(paginas(100), [1]);
  assert.deepEqual(paginas(101), [1, 2]);
  assert.deepEqual(paginas(250), [1, 2, 3]);
  assert.deepEqual(paginas(900), [1, 2, 3, 4, 5], 'tope maxPaginasCatalogo');
  const { informe } = simular('auditor-general.local.json', LOCAL, { catalogo: grande(250) });
  assert.ok(informe.incidencias.every((i) => i.id !== 'catalogo:feed_parcial'));
  assert.ok(informe.cobertura.revisado.some((x) => /250 productos del feed/.test(x)));
});

test('Auditor v0.2: los avisos del entorno local se listan aparte y no cuentan; en producción esos mismos hallazgos SÍ son incidencias', () => {
  const { informe } = simular('auditor-general.local.json', LOCAL);
  assert.ok(informe.avisosEntorno.length >= 1, 'hay avisos de entorno (categorías con pocos productos en una muestra pequeña)');
  assert.ok(informe.avisosEntorno.every((i) => i.ambito === 'entorno_local'));
  assert.ok(informe.incidencias.every((i) => i.ambito !== 'entorno_local'));
  assert.equal(informe.resumen.avisosEntorno, informe.avisosEntorno.length);
  const total = Object.values(informe.resumen.incidencias).reduce((a, b) => a + b, 0);
  assert.equal(total, informe.incidencias.length, 'el resumen sólo cuenta incidencias reales');
  assert.match(informe.markdown, /Avisos del entorno local/);
  assert.deepEqual(validarEsquema(informe, J('automation/schemas/informe-auditor.schema.json')), []);
  for (const i of [...informe.incidencias, ...informe.avisosEntorno]) assert.ok(i.clase && i.ambito, `clasificada: ${i.id}`);
  // misma clasificación con distinta configuración de entorno
  const sinHuella = { id: 'salud:sin_huella', gravedad: 'media', area: 'salud', titulo: 't', detalle: '', evidencia: {}, accionSugerida: '' };
  assert.equal(aud.clasificarIncidencia(sinHuella, LOCAL).ambito, 'entorno_local');
  assert.equal(aud.clasificarIncidencia(sinHuella, PROD).ambito, 'produccion', 'en producción la falta de huella es una incidencia real');
  assert.equal(aud.clasificarIncidencia({ ...sinHuella, id: 'catalogo:sin_precio', area: 'catalogo' }, LOCAL).ambito, 'datos', 'un problema de datos no es un aviso de entorno');
  assert.equal(aud.clasificarIncidencia({ ...sinHuella, id: 'ruta:error_servidor:/', area: 'ruta' }, LOCAL).clase, 'disponibilidad');
});

/* ───────── Despliegue controlado del Auditor en producción: revisión del workflow ───────── */
test('auditor-general.produccion: revisión estática — sólo GET públicos, sin credenciales, sin MCP, sin nada local', () => {
  const wf = J('automation/workflows/auditor-general.produccion.json');
  const texto = JSON.stringify(wf);
  assert.equal(wf.active, false);
  assert.ok(!('pinData' in wf) && !('credentials' in wf));
  const tipos = wf.nodes.map((n) => n.type);
  assert.deepEqual([...new Set(tipos)].sort(), ['n8n-nodes-base.code', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.stickyNote']);
  assert.ok(!tipos.some((t) => /schedule|webhook|cron|mcp|executeCommand|ssh|postgres|emailSend|slack|telegram/i.test(t)), 'sin programación, webhooks, MCP ni salidas');
  assert.ok(wf.nodes.every((n) => !n.credentials), 'ningún nodo referencia credenciales');
  const http = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  assert.equal(http.length, 2);
  for (const n of http) {
    const p = n.parameters;
    assert.equal(p.method, 'GET');
    assert.equal(p.url, '={{ $json.url }}');
    assert.equal(p.authentication, 'none');
    assert.ok(!p.sendBody && !p.sendQuery && !p.jsonBody && !p.bodyParameters, 'sin cuerpo ni parámetros añadidos');
    assert.deepEqual(p.headerParameters.parameters.map((h) => h.name).sort(), ['User-Agent', 'X-Treidilor-Agente'], 'sólo dos cabeceras, sin Authorization ni cookies');
    assert.match(p.headerParameters.parameters.find((h) => h.name === 'User-Agent').value, /^TreidilorAI-auditor-general\/0\.2 \(solo lectura\)$/);
    assert.equal(p.options.redirect.redirect.followRedirects, false);
    assert.equal(p.options.batching.batch.batchSize, 1);
    assert.ok(p.options.batching.batch.batchInterval >= 700);
    assert.ok(p.options.timeout <= 15000);
    assert.equal(n.retryOnFail, false);
  }
  // La política embebe la lista de hosts locales SOLO para RECHAZARLOS en producción (lista de denegación): se excluye esa línea exacta.
  const sinListaDenegacion = texto.replace(/const HOSTS_LOCALES = \[[^\]]*\];/g, '');
  assert.ok(!/availableInMCP|mcp|localhost|127\.0\.0\.1|host\.docker\.internal|puente-treidilor|n8n-pruebas|\.local\b|5678|4350|Bearer|TRADYLOR_API_TOKEN|tai_[0-9a-f]{16}/i.test(sinListaDenegacion), 'nada del entorno local, de MCP ni de tokens');
  assert.ok(texto.includes("const HOSTS_LOCALES = ['localhost', '127.0.0.1', 'puente-treidilor'];"),'la única mención local es la lista de denegación');
  const hosts = new Set(texto.match(/https?:\/\/[A-Za-z0-9.:-]+/g));
  assert.deepEqual([...hosts], ['https://treidilor.com'], 'el único host que aparece es el del sitio público');
  assert.ok(wf.settings.executionTimeout <= 900);
  assert.ok(!('availableInMCP' in wf.settings));
});

test('auditor-general.produccion: simulación — todas las peticiones son GET https a páginas públicas de treidilor.com, dentro del tope y sin efectos', () => {
  const { peticiones, informe } = simular('auditor-general.produccion.json', PROD);
  assert.ok(peticiones.length >= 2 && peticiones.length <= 1 + PROD.rutas.length + PROD.maxEnlaces, `peticiones: ${peticiones.length}`);
  const vistas = new Set();
  for (const p of peticiones) {
    assert.equal(p.metodo, 'GET');
    assert.ok(!p.credencial, 'sin credencial');
    const u = new URL(p.url);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.host, 'treidilor.com');
    assert.ok(!u.username && !u.password && !u.hash);
    assert.ok(u.pathname === '/api/health' || !u.pathname.startsWith('/api'), `única ruta /api: salud (${u.pathname})`);
    for (const re of PROHIBIDAS) assert.doesNotMatch(u.pathname, re, `ruta prohibida: ${p.url}`);
    assert.doesNotMatch(u.pathname, /^\/producto(s)?(\/|$)/, 'ninguna ficha: cada visita cuenta en la analítica');
    assert.ok(!/[?&](token|key|secret|password|session|email)=/i.test(u.search));
    assert.ok(!vistas.has(p.url), `URL repetida: ${p.url}`);
    vistas.add(p.url);
  }
  assert.equal(informe.modo, 'publico');
  assert.ok(informe.cobertura.noRevisado.some((x) => /Fichas de producto y feed/.test(x)), 'declara que no revisa fichas ni feed');
});

test('diagnóstico del entorno (autocontenido): sin red, sin credenciales, sincronizado, comprobado por el linter y OK en el simulador', async () => {
  const { construirDiagnosticos } = await import('../automation/build-workflows.mjs');
  const { comprobarWorkflow } = await import('../automation/lint-workflows.mjs');
  const f = 'diagnostico-auditor-produccion.json';
  assert.equal(fs.readFileSync(path.join(RAIZ, 'automation/dev', f), 'utf8').replace(/\r\n/g, '\n'), construirDiagnosticos()[f], 'sincronizado con automation/lib');
  const wf = J(`automation/dev/${f}`);
  assert.deepEqual(comprobarWorkflow(wf, { nombreArchivo: f }).errores, []);
  assert.equal(wf.active, false);
  assert.ok(wf.nodes.every((n) => !n.credentials));
  const http = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  assert.ok(http.every((n) => n.disabled === true), 'el único nodo HTTP está deshabilitado');
  assert.ok(!Object.values(wf.connections).some((c) => JSON.stringify(c).includes('Prueba de versión')), 'y sin conexiones');
  const r = simularWorkflow(wf, { fetchSimulado: () => { throw new Error('el diagnóstico no debe hacer ninguna petición'); }, ahora: NOW, hostsPermitidos: PROD.hostsPermitidos });
  const out = plano(r.salida[0].json);
  assert.equal(out.resultado, 'OK', JSON.stringify(out.fallos));
  assert.equal(out.sinRed, true);
  assert.equal(r.peticiones.length, 0);
  assert.ok(out.total >= 30);
});
