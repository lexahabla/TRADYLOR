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
  assert.equal(politica.evaluarUrl(LOCAL.baseUrl + '/api/v1/products?limit=100&page=1', 'catalogo', LOCAL).ok, true);
  assert.equal(politica.evaluarUrl(LOCAL.baseUrl + '/api/v1/products/import', 'catalogo', LOCAL).ok, false);
  assert.equal(politica.evaluarUrl(PROD.baseUrl + '/api/v1/products?limit=1', 'catalogo', PROD).ok, false, 'en producción no se lee el feed');
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
    if (r === '/api/v1/products') {
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
    assert.equal(u.host, 'host.docker.internal:4350');
    for (const re of PROHIBIDAS) assert.doesNotMatch(u.pathname, re, `ruta prohibida solicitada: ${p.url}`);
    assert.equal(p.credencial, p.nodo === 'Pedir catálogo', 'sólo el feed del catálogo lleva credencial');
  }
  const ids = informe.incidencias.map((i) => i.id);
  assert.ok(ids.includes('enlace:roto:http://host.docker.internal:4350/roto'), 'enlace roto detectado');
  assert.ok(ids.some((i) => i.startsWith('ficha:error_servidor')), 'ficha con error 500 detectada');
  for (const c of ['catalogo:ids_duplicados', 'catalogo:sin_precio', 'catalogo:sin_imagen', 'catalogo:sin_categoria', 'catalogo:titulos_repetidos', 'catalogo:precio_anterior_menor', 'catalogo:descuento_sospechoso', 'catalogo:imagen_no_segura', 'catalogo:valoracion_por_defecto']) assert.ok(ids.includes(c), `falta ${c}`);
  assert.equal(informe.resumen.estado, 'critico');
  assert.match(informe.markdown, /Auditor General/);
  assert.ok(informe.cobertura.noRevisado.some((x) => /verificados/.test(x)), 'declara lo que NO revisa');
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
  const malos = ['/api/redirect?id=1', '/out/x', 'http://host.docker.internal:4350/upayp1b4/portada', 'http://host.docker.internal:4351/', 'http://host.docker.internal:4350@evil.example/', '//evil.example', 'file:///etc/passwd', 'data:text/html,<script>', '/p/abc', '/api/v1/products/delete-all', '/checkout/1', '/mi-radar'];
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
  assert.ok(peticiones.every((p) => p.metodo === 'GET' && /\/api\/v1\/products\?/.test(p.url) && p.credencial));
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
