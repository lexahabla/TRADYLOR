/**
 * Política de URLs de los agentes (SOLO LECTURA). PURA: sin red. Se incrusta en los nodos «Code» de n8n (sin imports).
 *
 * Principios:
 *  · Un agente sólo pide URLs de los hosts configurados (`hostsPermitidos`), por http(s) y sin credenciales en la URL.
 *  · NUNCA se piden las rutas con efectos: salida de afiliado (`/out`, `/p`), `/api/redirect`, `/checkout`, la API (salvo las dos
 *    lecturas explícitas), el panel (`/upayp1b4`), Mi Radar, perfil y compartir.
 *  · En modo `publico` (producción) tampoco se piden fichas de producto: el servidor cuenta cada visita y anota el precio visto.
 */

export const RUTAS_PROHIBIDAS = [
  /^\/api(\/|$)/i,
  /^\/out(\/|$)/i,
  /^\/p(\/|$)/i,
  /^\/checkout(\/|$)/i,
  /^\/upayp1b4/i,
  /^\/admin(\/|$)/i,
  /^\/mi-radar(\/|$)/i,
  /^\/perfil(\/|$)/i,
  /^\/share(\/|$)/i,
  /^\/ejemplo-afiliados(\/|$)/i,
];

const HOSTS_LOCALES = ['localhost', '127.0.0.1', 'host.docker.internal'];

const PUERTOS_POR_DEFECTO = { 'http:': '80', 'https:': '443' };

/** Analiza una URL ABSOLUTA http(s). Sin `URL` (el entorno Code de n8n no la tiene). Devuelve null si no es válida. */
function analizarAbsoluta(texto) {
  const m = texto.match(/^(https?):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i);
  if (!m) return null;
  const protocol = `${m[1].toLowerCase()}:`;
  let autoridad = m[2];
  let username = '';
  let password = '';
  const arroba = autoridad.lastIndexOf('@');
  if (arroba >= 0) {
    const info = autoridad.slice(0, arroba);
    autoridad = autoridad.slice(arroba + 1);
    const dos = info.indexOf(':');
    username = dos >= 0 ? info.slice(0, dos) : info;
    password = dos >= 0 ? info.slice(dos + 1) : '';
    if (!username && !password) username = '@';
  }
  const h = autoridad.match(/^([A-Za-z0-9.-]+)(?::(\d*))?$/);
  if (!h || !h[1]) return null;
  const hostname = h[1].toLowerCase();
  const port = h[2] && h[2] !== PUERTOS_POR_DEFECTO[protocol] ? h[2] : '';
  const pathname = m[3] || '/';
  const search = m[4] && m[4] !== '?' ? m[4] : '';
  const host = port ? `${hostname}:${port}` : hostname;
  const userinfo = username || password ? `${username}${password ? `:${password}` : ''}@` : '';
  return { protocol, username, password, host, hostname, port, pathname, search, hash: '', toString: () => `${protocol}//${userinfo}${host}${pathname}${search}` };
}

/**
 * Resuelve `valor` respecto a `base` y quita el fragmento. Devuelve null si no es una URL http(s) válida.
 * No resuelve los segmentos «..»: se conservan en `pathname` y `evaluarUrl` los rechaza.
 */
export function normalizarUrl(valor, base) {
  const v = String(valor ?? '').replace(/[\t\r\n]/g, '').trim();
  if (!v || /[\\\s]/.test(v)) return null;
  const b = analizarAbsoluta(String(base ?? ''));
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return analizarAbsoluta(v);
  if (!b) return null;
  if (v.startsWith('//')) return analizarAbsoluta(`${b.protocol}${v}`);
  const origen = `${b.protocol}//${b.host}`;
  if (v.startsWith('/')) return analizarAbsoluta(`${origen}${v}`);
  if (v.startsWith('?')) return analizarAbsoluta(`${origen}${b.pathname}${v}`);
  if (v.startsWith('#')) return analizarAbsoluta(`${origen}${b.pathname}${b.search}`);
  return analizarAbsoluta(`${origen}${b.pathname.slice(0, b.pathname.lastIndexOf('/') + 1)}${v}`);
}

/**
 * ¿Puede un agente pedir esta URL? `tipo`: 'salud' | 'ruta' | 'enlace' | 'catalogo' | 'ficha'.
 * Devuelve { ok, motivo, url } (url = cadena normalizada si ok).
 */
export function evaluarUrl(valor, tipo, cfg) {
  const u = normalizarUrl(valor, cfg.baseUrl);
  if (!u) return { ok: false, motivo: 'url_no_valida' };
  if (u.username || u.password) return { ok: false, motivo: 'credenciales_en_url' };
  if (!cfg.hostsPermitidos.includes(u.host)) return { ok: false, motivo: 'host_no_permitido' };
  const local = HOSTS_LOCALES.includes(u.hostname);
  if (u.protocol === 'http:' && !local) return { ok: false, motivo: 'http_fuera_de_local' };
  const ruta = u.pathname;
  if (ruta.includes('..') || /%2e|%2f|%5c/i.test(ruta)) return { ok: false, motivo: 'ruta_sospechosa' };
  if (tipo === 'salud') return ruta === '/api/health' ? { ok: true, url: u.toString() } : { ok: false, motivo: 'salud_solo_api_health' };
  if (tipo === 'catalogo') {
    if (cfg.modo !== 'completo') return { ok: false, motivo: 'catalogo_solo_modo_completo' };
    return ruta === '/api/v1/products' ? { ok: true, url: u.toString() } : { ok: false, motivo: 'catalogo_ruta_no_permitida' };
  }
  if (RUTAS_PROHIBIDAS.some((r) => r.test(ruta))) return { ok: false, motivo: 'ruta_con_efectos' };
  if (tipo === 'ficha') {
    if (cfg.modo !== 'completo') return { ok: false, motivo: 'fichas_solo_modo_completo' };
    return /^\/producto\/[A-Za-z0-9_.~-]{1,160}$/.test(ruta) ? { ok: true, url: u.toString() } : { ok: false, motivo: 'ficha_ruta_no_valida' };
  }
  if (/^\/producto(\/|$)/i.test(ruta)) return { ok: false, motivo: 'ficha_visita_cuenta_en_analitica' };
  return { ok: true, url: u.toString() };
}
