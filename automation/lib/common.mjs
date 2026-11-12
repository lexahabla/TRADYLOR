/**
 * Utilidades comunes de los agentes de Treidilor AI. PURAS: sin red, sin disco, sin variables de entorno.
 * Este fichero se incrusta tal cual (sin `export`) en los nodos «Code» de los workflows de n8n: no debe tener imports.
 */

export const GRAVEDADES = ['critica', 'alta', 'media', 'baja', 'info'];
export const ORDEN_GRAVEDAD = { critica: 0, alta: 1, media: 2, baja: 3, info: 4 };

/** Minúsculas sin tildes ni espacios sobrantes. */
export function plegar(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function recortar(texto, max = 120) {
  const t = String(texto ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

export function mediana(numeros) {
  const v = numeros.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function euros(n) {
  return Number.isFinite(Number(n)) ? `${Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : 'sin precio';
}

/** Fecha ISO válida o null. */
export function fechaValida(valor) {
  if (typeof valor !== 'string' || !valor) return null;
  const t = Date.parse(valor);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function diasEntre(desdeIso, hastaIso) {
  const a = Date.parse(desdeIso);
  const b = Date.parse(hastaIso);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.floor((b - a) / 86400000);
}

/** Cuenta por clave. */
export function contarPor(lista, clave) {
  const out = {};
  for (const x of lista) {
    const k = String(clave(x) ?? '—');
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Ordena incidencias: gravedad y luego id (determinista). */
export function ordenarIncidencias(lista) {
  return [...lista].sort((a, b) => (ORDEN_GRAVEDAD[a.gravedad] ?? 9) - (ORDEN_GRAVEDAD[b.gravedad] ?? 9) || String(a.id).localeCompare(String(b.id)));
}

export function resumenIncidencias(lista) {
  const c = { critica: 0, alta: 0, media: 0, baja: 0, info: 0 };
  for (const i of lista) if (c[i.gravedad] !== undefined) c[i.gravedad]++;
  return c;
}

export function estadoGlobal(contador) {
  if (contador.critica > 0) return 'critico';
  if (contador.alta > 0 || contador.media > 0) return 'atencion';
  return 'ok';
}

/** Valida la configuración mínima de un agente. Devuelve una lista de errores (vacía = correcta). */
export function validarConfig(cfg) {
  const errores = [];
  if (!cfg || typeof cfg !== 'object') return ['configuración ausente'];
  if (typeof cfg.baseUrl !== 'string' || !/^https?:\/\//.test(cfg.baseUrl)) errores.push('baseUrl debe empezar por http(s)://');
  if (!Array.isArray(cfg.hostsPermitidos) || !cfg.hostsPermitidos.length) errores.push('hostsPermitidos es obligatorio');
  if (!['completo', 'publico'].includes(cfg.modo)) errores.push('modo debe ser completo o publico');
  if (!Array.isArray(cfg.rutas) || !cfg.rutas.length) errores.push('rutas es obligatorio');
  for (const k of ['maxEnlaces', 'maxPaginasCatalogo', 'limitePorPagina', 'maxFichas']) {
    if (!Number.isInteger(cfg[k]) || cfg[k] < 0 || cfg[k] > 500) errores.push(`${k} debe ser un entero entre 0 y 500`);
  }
  if (!cfg.umbrales || typeof cfg.umbrales !== 'object') errores.push('umbrales es obligatorio');
  return errores;
}
