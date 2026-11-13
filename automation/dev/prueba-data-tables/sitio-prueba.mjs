#!/usr/bin/env node
// SITIO DE PRUEBAS del Auditor General (Treidilor AI). Imita, con datos SINTÉTICOS, lo mínimo del sitio y de la API de automatización que lee el Auditor local:
//   · páginas públicas (/, /catalogo, /categorias, /metodologia, /alertas-precio, /guias/NN, /marca/x), /api/health y el feed /api/automation/v1/catalog (con paginación).
//   · escenarios de incidencias (404, 500, sin título, tiempo agotado, conexión cortada, catálogo con problemas…) que se cambian SIN tocar el workflow.
//   · REGISTRO de todas las solicitudes (método, ruta, cabeceras de identificación, estado, si era una ruta prohibida): es la comprobación independiente de lo que hizo el Auditor.
//
// AISLAMIENTO: este programa NO hace ninguna conexión saliente (sin fetch, sin http.request hacia fuera, sin DNS, sin procesos). Escucha en 0.0.0.0:4350 (el sitio, dentro de la
// red Docker aislada) y en 127.0.0.1:4351 (CONTROL, sólo desde dentro del contenedor). Nunca guarda ni registra el valor de ningún token: sólo si la cabecera tiene la FORMA de un token
// ficticio. No usa credenciales reales ni datos de Treidilor.
//
//   servidor:  node sitio-prueba.mjs                                  (variables: PUERTO, PUERTO_CONTROL, ESCENARIO_INICIAL)
//   control:   node sitio-prueba.mjs --control escenario <nombre> | registro | reiniciar | escenarios | estado     (cliente de loopback)
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUERTO_SITIO = 4350;
export const PUERTO_CONTROL = 4351;
export const RUTAS_FIJAS = ['/', '/catalogo', '/categorias', '/metodologia', '/alertas-precio'];
export const RUTA_SALUD = '/api/health';
export const RUTA_CATALOGO = '/api/automation/v1/catalog';
/** Un token FICTICIO con la forma del real: tai_<16 hex>_<43 caracteres>. Sólo se comprueba la forma. */
export const FORMA_TOKEN_FICTICIO = /^Bearer tai_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;
/** Rutas con efectos que el Auditor NUNCA debe pedir (misma lista que `urlPolicy.mjs`, más las fichas: cada visita cuenta en la analítica). */
export const PROHIBIDAS = [/^\/api(\/|$)/i, /^\/out(\/|$)/i, /^\/p(\/|$)/i, /^\/checkout(\/|$)/i, /^\/upayp1b4/i, /^\/admin(\/|$)/i, /^\/mi-radar(\/|$)/i, /^\/perfil(\/|$)/i, /^\/share(\/|$)/i, /^\/ejemplo-afiliados(\/|$)/i, /^\/producto(\/|$)/i];
/** Enlaces trampa de la portada: ninguno de ellos puede aparecer en el registro. */
export const TRAMPAS = ['/api/redirect?id=1', '/out/abc', '/checkout/1', '/upayp1b4', '/producto/p1', '/mi-radar', '/share/x', 'https://evil.example/x', '//evil.example/y', 'javascript:void(0)', 'mailto:a@example.invalid', '/p/ofertas'];
export const MAX_REGISTRO = 5000;
export const RETARDO_TIEMPO_AGOTADO_MS = 17000; // por encima del timeout de 15 s del nodo HTTP del Auditor

/* ───────────────────────── Catálogo sintético ───────────────────────── */
const CATEGORIAS = ['Sonido', 'Informática', 'Hogar', 'Portabilidad'];
const COMERCIOS = ['Amazon', 'AliExpress', 'eBay'];
/** Producto SANO del feed de automatización (mismas claves que `AutomationProduct`). */
export function producto(i, cambios = {}) {
  const n = String(i).padStart(2, '0');
  return {
    id: `p${n}`, title: `Producto de prueba número ${n} con título descriptivo`, category: CATEGORIAS[(i - 1) % CATEGORIAS.length], categoryId: null, subcategoryId: null, network: null,
    merchant: COMERCIOS[(i - 1) % COMERCIOS.length], price: 10 + i, currency: 'EUR', declaredPreviousPrice: null, verifiedDiscount: null, stock: 'in_stock', rating: 4.2, reviewsCount: 30,
    ratingFlag: null, image: `https://cdn.example.invalid/p${n}.jpg`, descriptionLength: 80, hasAffiliateLink: true, capturedAt: null, verifiedAt: null, addedAt: null, ...cambios,
  };
}
export const catalogoSano = (n = 12) => Array.from({ length: n }, (_, i) => producto(i + 1));
/** Catálogo con problemas CONOCIDOS: p03 sin precio, p07 sin imagen, p10 y p11 con el mismo título. */
export function catalogoConProblemas() {
  const lista = catalogoSano();
  lista[2] = producto(3, { price: null });
  lista[6] = producto(7, { image: null });
  const repetido = 'Auriculares inalámbricos con cancelación activa de ruido';
  lista[9] = producto(10, { title: repetido });
  lista[10] = producto(11, { title: repetido });
  return lista;
}

/* ───────────────────────── Escenarios ───────────────────────── */
const guias = (n, p = 'guias') => Array.from({ length: n }, (_, i) => `/${p}/${String(i + 1).padStart(2, '0')}`);
const ENLACES_BASE = ['/guias/01', '/guias/02', '/guias/03', '/marca/a', '/marca/b'];
/**
 * `enlaces`: enlaces de la portada. `paginas[ruta]`: { status, sinTitulo, h1 (nº), corto, reset (corta la conexión), retardoMs }. `catalogo`: { productos } o { estado: 500 | 'reset' }.
 * `salud`: { status }. `todoCaido`: el sitio corta TODAS las conexiones.
 */
export const ESCENARIOS = {
  // Día 0: 404 en /guias/01, 500 en /guias/02, tiempo agotado en /guias/03, /metodologia sin <title> y un catálogo con 3 problemas.
  base: { enlaces: ENLACES_BASE, paginas: { '/guias/01': { status: 404 }, '/guias/02': { status: 500 }, '/guias/03': { retardoMs: RETARDO_TIEMPO_AGOTADO_MS }, '/metodologia': { sinTitulo: true } }, catalogo: { productos: catalogoConProblemas() } },
  // Día 1: todo arreglado y revisado.
  arreglado: { enlaces: ENLACES_BASE, paginas: {}, catalogo: { productos: catalogoSano() } },
  // Día 2: /guias/01 vuelve a romperse (reaparece), /marca/a da 500 (nuevo), /catalogo con dos <h1> y un descuento declarado sospechoso en el catálogo.
  mixto: { enlaces: ENLACES_BASE, paginas: { '/guias/01': { status: 404 }, '/marca/a': { status: 500 }, '/catalogo': { h1: 2 } }, catalogo: { productos: catalogoSano().map((p, i) => (i === 4 ? { ...p, declaredPreviousPrice: 400 } : p)) } },
  // Ejecución PARCIAL: tres conexiones cortadas (3 de 12 peticiones, más del 20 %).
  parcial: { enlaces: ENLACES_BASE, paginas: { '/guias/01': { reset: true }, '/guias/02': { reset: true }, '/marca/a': { reset: true } }, catalogo: { productos: catalogoSano() } },
  // Caída TOTAL: el sitio corta todas las conexiones.
  caida: { todoCaido: true, enlaces: [], paginas: {}, catalogo: { productos: [] } },
  // El feed del catálogo falla (500): incidencia «feed no disponible» y ejecución no comparable por completo.
  catalogo_roto: { enlaces: ENLACES_BASE, paginas: {}, catalogo: { estado: 500 } },
  // 80 enlaces: más que el tope (60): el Auditor visita 60 y declara los demás como no visitados.
  muchos_enlaces: { enlaces: guias(80), paginas: {}, catalogo: { productos: catalogoSano() } },
};

/* ───────────────────────── Núcleo puro (sin sockets) ───────────────────────── */
const html = (titulo, h1, enlaces, corto) => `<!doctype html><html lang="es"><head><meta charset="utf-8">${titulo === null ? '' : `<title>${titulo}</title>`}</head><body>${Array.from({ length: h1 }, () => '<h1>Sitio de pruebas</h1>').join('')}${enlaces.map((h) => `<a href="${h}">enlace</a>`).join('')}<p>${corto ? 'corto' : 'Contenido de prueba. '.repeat(120)}</p></body></html>`;
const json = (estado, cuerpo) => ({ estado, cabeceras: { 'content-type': 'application/json; charset=utf-8' }, cuerpo: JSON.stringify(cuerpo), retardoMs: 0, destruir: false });
const texto = (estado, cuerpo = '') => ({ estado, cabeceras: { 'content-type': 'text/html; charset=utf-8' }, cuerpo, retardoMs: 0, destruir: false });

export function crearEstado(escenario = 'base') {
  if (!ESCENARIOS[escenario]) throw new Error(`escenario desconocido: ${escenario}`);
  return { escenario, registro: [], n: 0 };
}
const formaAuth = (v) => (typeof v !== 'string' || !v ? 'ausente' : FORMA_TOKEN_FICTICIO.test(v) ? 'ficticia' : 'invalida');

/**
 * Procesa UNA solicitud. `peticion` = { metodo, url (ruta + consulta), cabeceras (en minúsculas) }. Devuelve { estado, cabeceras, cuerpo, retardoMs, destruir } y la anota en el registro
 * (sin el valor de ningún token).
 */
export function procesar(peticion, estado) {
  const esc = ESCENARIOS[estado.escenario];
  const metodo = String(peticion.metodo || 'GET').toUpperCase();
  const [ruta, consulta = ''] = String(peticion.url || '/').split('?');
  const cab = peticion.cabeceras || {};
  let r;
  if (metodo !== 'GET') r = json(405, { success: false, code: 'metodo_no_permitido' });
  else if (esc.todoCaido) r = { estado: 0, cabeceras: {}, cuerpo: '', retardoMs: 0, destruir: true };
  else r = responder(ruta, consulta, cab, esc);
  const prohibido = metodo !== 'GET' || (PROHIBIDAS.some((re) => re.test(ruta)) && ruta !== RUTA_SALUD && ruta !== RUTA_CATALOGO);
  if (estado.registro.length < MAX_REGISTRO) {
    estado.registro.push({ n: ++estado.n, escenario: estado.escenario, metodo, ruta: consulta ? `${ruta}?${consulta}` : ruta, ua: cab['user-agent'] || '', agente: cab['x-treidilor-agente'] || '', auth: formaAuth(cab.authorization), estado: r.destruir ? 'conexion_cortada' : r.estado, retardoMs: r.retardoMs || 0, prohibido });
  }
  return r;
}

function responder(ruta, consulta, cab, esc) {
  const especial = (esc.paginas || {})[ruta] || {};
  if (especial.reset) return { estado: 0, cabeceras: {}, cuerpo: '', retardoMs: 0, destruir: true };
  if (ruta === RUTA_SALUD) {
    const s = esc.salud || {};
    return json(s.status || 200, { status: 'ok', sourceHash: 'a'.repeat(64), uptimeSeconds: 86400, dataDirExists: true, env: { smtp: true } });
  }
  if (ruta === RUTA_CATALOGO) {
    if (formaAuth(cab.authorization) !== 'ficticia') return json(401, { success: false, code: 'no_autorizado' });
    const c = esc.catalogo || {};
    if (c.estado === 'reset') return { estado: 0, cabeceras: {}, cuerpo: '', retardoMs: 0, destruir: true };
    if (typeof c.estado === 'number' && c.estado !== 200) return json(c.estado, { success: false, code: 'error_interno' });
    const q = new Map(consulta.split('&').filter(Boolean).map((p) => p.split('=')));
    const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 100);
    const page = Math.max(Number(q.get('page')) || 1, 1);
    const todos = c.productos || [];
    return json(200, { success: true, schema: 'automation-catalog/1', generatedAt: '2026-11-12T10:00:00.000Z', total: todos.length, page, limit, totalPages: Math.max(1, Math.ceil(todos.length / limit)), products: todos.slice((page - 1) * limit, page * limit) });
  }
  const guia = /^\/(guias|marca)\/[A-Za-z0-9_-]{1,40}$/.test(ruta);
  if (!RUTAS_FIJAS.includes(ruta) && !guia) return texto(404, 'no existe');
  if (especial.status && especial.status !== 200) return texto(especial.status, especial.status >= 500 ? 'error' : '');
  const enlaces = ruta === '/' ? [...(esc.enlaces || []), ...TRAMPAS] : [];
  const r = texto(200, html(especial.sinTitulo ? null : 'Treidilor (sitio de pruebas)', especial.h1 === undefined ? 1 : especial.h1, enlaces, especial.corto));
  r.retardoMs = especial.retardoMs || 0;
  return r;
}

/* ───────────────────────── Servidores (sólo escuchan; nunca se conectan hacia fuera) ───────────────────────── */
export function iniciarServidores({ puerto = PUERTO_SITIO, puertoControl = PUERTO_CONTROL, escenario = 'base', anfitrion = '0.0.0.0' } = {}) {
  const estado = crearEstado(escenario);
  const sitio = http.createServer((req, res) => {
    const r = procesar({ metodo: req.method, url: req.url, cabeceras: req.headers }, estado);
    if (r.destruir) { req.socket.destroy(); return; }
    setTimeout(() => { if (!res.destroyed) { res.writeHead(r.estado, r.cabeceras); res.end(r.cuerpo); } }, r.retardoMs);
  });
  const control = http.createServer((req, res) => {
    const responder = (cod, o) => { res.writeHead(cod, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const url = String(req.url || '');
    if (req.method === 'GET' && url === '/registro') return responder(200, estado.registro);
    if (req.method === 'GET' && url === '/estado') return responder(200, { escenario: estado.escenario, solicitudes: estado.n });
    if (req.method === 'GET' && url === '/escenarios') return responder(200, Object.keys(ESCENARIOS));
    if (req.method === 'POST' && url === '/reiniciar') { estado.registro.length = 0; estado.n = 0; return responder(200, { ok: true }); }
    const m = url.match(/^\/escenario\/([a-z_0-9]+)$/);
    if (req.method === 'POST' && m) { if (!ESCENARIOS[m[1]]) return responder(404, { ok: false, error: 'escenario desconocido' }); estado.escenario = m[1]; return responder(200, { ok: true, escenario: m[1] }); }
    return responder(404, { ok: false });
  });
  // El control SÓLO en la interfaz de loopback del contenedor: no es alcanzable desde otros contenedores.
  sitio.listen(puerto, anfitrion);
  control.listen(puertoControl, '127.0.0.1');
  return { sitio, control, estado, cerrar: () => { sitio.close(); control.close(); } };
}

/** Cliente de control (loopback): `node sitio-prueba.mjs --control escenario base`. */
function clienteControl([accion, arg]) {
  const rutas = { escenario: ['POST', `/escenario/${arg}`], registro: ['GET', '/registro'], reiniciar: ['POST', '/reiniciar'], escenarios: ['GET', '/escenarios'], estado: ['GET', '/estado'] };
  if (!rutas[accion] || (accion === 'escenario' && !/^[a-z_0-9]+$/.test(arg || ''))) { console.error('Uso: --control escenario <nombre> | registro | reiniciar | escenarios | estado'); process.exit(2); }
  const [metodo, ruta] = rutas[accion];
  const req = http.request({ host: '127.0.0.1', port: Number(process.env.PUERTO_CONTROL || PUERTO_CONTROL), method: metodo, path: ruta }, (res) => { let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => { console.log(t); process.exit(res.statusCode === 200 ? 0 : 1); }); });
  req.on('error', (e) => { console.error(`control no disponible: ${e.message}`); process.exit(1); });
  req.end();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--control');
  if (i >= 0) clienteControl(process.argv.slice(i + 1));
  else {
    const escenario = process.env.ESCENARIO_INICIAL || 'base';
    iniciarServidores({ puerto: Number(process.env.PUERTO || PUERTO_SITIO), puertoControl: Number(process.env.PUERTO_CONTROL || PUERTO_CONTROL), escenario });
    console.log(`[sitio-prueba] escucha en :${process.env.PUERTO || PUERTO_SITIO} (control sólo en 127.0.0.1:${process.env.PUERTO_CONTROL || PUERTO_CONTROL}) · escenario «${escenario}»`);
  }
}
