/**
 * DIAGNÓSTICO del entorno de n8n para el Auditor General (autocontenido: SIN red, SIN credenciales, SIN HTTP).
 * Ejecuta el código REAL del Auditor (política de URLs, extracción de enlaces, informe) con respuestas SINTÉTICAS fabricadas aquí mismo.
 * Sirve para comprobar, antes de importar el Auditor, que el entorno «Code» de ESA instancia de n8n (versión, task runner) lo soporta.
 * Se incrusta (sin imports) en el nodo «Code» de `automation/dev/diagnostico-auditor-produccion.json`.
 */
import { evaluarUrl, normalizarUrl, validarAislamiento } from './urlPolicy.mjs';
import { construirInformeAuditor, crearObjetivosEnlaces, crearObjetivosRutas, extraerEnlaces } from './auditor.mjs';
import { euros, plegar } from './common.mjs';

export function ejecutarDiagnostico(cfg, ahoraIso) {
  const comprobaciones = [];
  const comprobar = (grupo, nombre, ok, detalle) => comprobaciones.push({ grupo, nombre, ok: Boolean(ok), detalle: detalle === undefined ? '' : String(detalle).slice(0, 160) });
  const intentar = (grupo, nombre, fn) => {
    try {
      const r = fn();
      comprobar(grupo, nombre, r === true || (r && r.ok === true), r && r.detalle);
    } catch (e) {
      comprobar(grupo, nombre, false, `excepción: ${e && e.message ? e.message : e}`);
    }
  };

  // 1) Lo que el Auditor necesita del entorno JavaScript
  intentar('entorno', 'Intl y Date', () => typeof Intl === 'object' && typeof Date.parse === 'function' && !Number.isNaN(Date.parse(ahoraIso)));
  intentar('entorno', 'String.matchAll y normalize (NFD)', () => [...'a1b2'.matchAll(/\d/g)].length === 2 && plegar('ÁÉÍ  Ñ') === 'aei n');
  intentar('entorno', 'formato de euros (es-ES)', () => ({ ok: /^1\.?234,50/.test(euros(1234.5)), detalle: euros(1234.5) }));
  intentar('entorno', 'Object.fromEntries, Map, Set, spread, flat', () => Object.keys(Object.fromEntries([['a', 1]])).length === 1 && new Map([[1, 2]]).size === 1 && new Set([1, 1]).size === 1 && [[1], [2]].flat().length === 2);
  intentar('entorno', 'JSON y expresiones regulares con indicadores g/i/m/s', () => JSON.parse(JSON.stringify({ a: [1] })).a[0] === 1 && /a.b/s.test('a\nb') && /^x$/m.test('y\nx'));
  comprobar('entorno', 'URL global (informativo: el Auditor NO la necesita)', true, typeof URL === 'undefined' ? 'no existe (como en 2.46.6)' : 'existe');

  // 2) Aislamiento y política con la configuración que se desplegaría
  intentar('politica', 'la configuración pasa validarAislamiento', () => ({ ok: validarAislamiento(cfg).length === 0, detalle: validarAislamiento(cfg).join('; ') }));
  const base = cfg.baseUrl.replace(/\/$/, '');
  const permitidas = ['/', '/catalogo', '/catalogo?sort=precio_asc', '/herramientas/comparador'];
  const prohibidas = ['/producto/abc', '/api/redirect?id=1', '/api/v1/products', '/out/abc', '/p/abc', '/checkout/1', '/upayp1b4', '/mi-radar', '/perfil', '/share/x', '/admin', '/a/../upayp1b4'];
  for (const r of permitidas) intentar('politica', `permite ${r}`, () => evaluarUrl(base + r, 'enlace', cfg).ok === true);
  for (const r of prohibidas) intentar('politica', `rechaza ${r}`, () => evaluarUrl(base + r, 'enlace', cfg).ok === false);
  for (const u of ['https://evil.example/', 'http://treidilor.invalid/', '//evil.example/x', 'javascript:alert(1)', 'http://localhost:5678/', base.replace('://', '://user:pw@') + '/']) intentar('politica', `rechaza ${u.slice(0, 40)}`, () => evaluarUrl(u, 'enlace', cfg).ok === false);
  intentar('politica', 'resuelve enlaces relativos sin URL global', () => { const u = normalizarUrl('/catalogo?x=1#y', base); return u !== null && u.host === base.match(/^https?:\/\/([^/]+)/)[1] &&u.pathname === '/catalogo'; });

  // 3) Recorrido completo con respuestas sintéticas (no sale ninguna petición)
  const relleno = 'x'.repeat(2200);
  const html = (titulo, enlaces) => `<html><head><title>${titulo} · Treidilor</title></head><body><h1>${titulo}</h1>${enlaces.map((h) => `<a href="${h}">e</a>`).join('')}<script>const t = \`<a href="/\${x}">\`;</script><p>${relleno}</p></body></html>`;
  const enlacesHome = ['/catalogo?sort=precio_asc', '/herramientas/comparador', '/producto/abc', '/api/redirect?id=1', '/out/abc', 'https://evil.example/', '#arriba', 'mailto:a@b.c', '/categorias'];
  const objetivosRutas = crearObjetivosRutas(cfg);
  const respuestasRutas = objetivosRutas.map((t) => (t.tipo === 'salud'
    ? { statusCode: 200, headers: { 'content-type': 'application/json' }, data: JSON.stringify({ status: 'ok', sourceHash: 'a'.repeat(64), uptimeSeconds: 99999, dataDirExists: true, env: { smtp: true } }) }
    : { statusCode: 200, headers: { 'content-type': 'text/html' }, data: html(t.etiqueta || 'Página', t.etiqueta === '/' ? enlacesHome : []) }));
  const objetivosEnlaces = crearObjetivosEnlaces(objetivosRutas, respuestasRutas, cfg);
  const urlsEnlaces = objetivosEnlaces.filter((t) => !t.marcador).map((t) => t.url);
  intentar('recorrido', 'los enlaces a revisar son solo públicos y del propio sitio', () => ({
    ok: urlsEnlaces.length >= 2 && urlsEnlaces.every((u) => u.startsWith(base) && !/\/(producto|api|out|p|checkout|upayp1b4|admin|mi-radar|perfil|share)(\/|\?|$)/.test(u.slice(base.length))) && !urlsEnlaces.some((u) => /evil|redirect|\$\{/.test(u)),
    detalle: urlsEnlaces.join(' ').slice(0, 150),
  }));
  intentar('recorrido', 'el extractor ignora plantillas dentro de <script>', () => extraerEnlaces(html('x', []), base + '/').length === 0);
  const respuestasEnlaces = objetivosEnlaces.map(() => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, data: html('Destino', []) }));
  const informe = construirInformeAuditor({ cfg, objetivosRutas, respuestasRutas, objetivosEnlaces, respuestasEnlaces, ahoraIso });
  intentar('recorrido', 'el informe sale completo y sin incidencias con datos sanos', () => ({ ok: informe.agente === 'auditor-general' && informe.soloLectura === true && informe.resumen.estado === 'ok' && informe.incidencias.length === 0 && informe.markdown.length > 100, detalle: `estado ${informe.resumen.estado}, ${informe.incidencias.length} incidencias` }));
  const peticionesPrevistas = objetivosRutas.filter((t) => !t.marcador).length + urlsEnlaces.length;
  comprobar('recorrido', 'peticiones previstas dentro del tope (rutas + enlaces ≤ 1 + rutas + maxEnlaces)', peticionesPrevistas <= 1 + cfg.rutas.length + cfg.maxEnlaces, `${peticionesPrevistas} con datos sintéticos (máximo real ${1 + cfg.rutas.length + cfg.maxEnlaces})`);

  const fallos = comprobaciones.filter((c) => !c.ok);
  return {
    diagnostico: 'auditor-general',
    versionAgente: informe.version,
    entorno: cfg.entorno,
    baseUrl: cfg.baseUrl,
    generadoEn: ahoraIso,
    sinRed: true,
    resultado: fallos.length ? 'FALLO' : 'OK',
    total: comprobaciones.length,
    fallos: fallos.map((c) => `${c.grupo}: ${c.nombre}${c.detalle ? ` (${c.detalle})` : ''}`),
    comprobaciones,
  };
}
