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

/** Resuelve `valor` respecto a `base` y quita el fragmento. Devuelve null si no es una URL http(s) válida. */
export function normalizarUrl(valor, base) {
  try {
    const u = new URL(String(valor), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
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
  if (/^\/producto(\/|$)/i.test(ruta) && cfg.modo !== 'completo') return { ok: false, motivo: 'ficha_visita_cuenta_en_analitica' };
  return { ok: true, url: u.toString() };
}
