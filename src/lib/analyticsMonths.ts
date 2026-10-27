/**
 * ==============================================================================
 * TRADYLOR — AGREGADOS MENSUALES DE ANALITICA
 * ==============================================================================
 * Agrupa los eventos de analytics.ts por mes calendario (YYYY-MM) y los
 * persiste en analytics-months.json para que los meses cerrados se conserven
 * aunque los eventos en bruto roten (máximo 10.000).
 *
 * - getMesesAnalitica(): histórico consultable (meses guardados + mes en curso).
 * - getPeriodo():        métricas de los últimos N días (dashboard) y del
 *                        periodo anterior (para las variaciones).
 * - resetAnalitica():    vacía eventos y meses: la medición empieza de cero.
 * ==============================================================================
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { DATA_DIR, dataFile } from './paths';
import {
  getAnalyticsEvents,
  getIgnoredIps,
  onAnalyticsFlush,
  resetAnalytics,
  type AnalyticsEvent,
} from './analytics';
import { findCatalogProduct, getCatalogProducts } from './catalog';

const MONTHS_PATH = dataFile('analytics-months.json');
const MESES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

export type FuenteId = 'organico' | 'directo' | 'social' | 'referido' | 'email' | 'otros';

export interface MetricasPeriodo {
  sesiones: number;
  usuariosUnicos: number;
  paginas: number;
  paginasPorSesion: number;
  permanenciaMediaSeg: number;
  rebotePct: number;
  visitas: number;
  salidas: number;
  carritos: number;
  compras: number;
  contactos: number;
  conversionPct: number;
  aov: number;
}

export interface FuenteMes {
  id: FuenteId;
  etiqueta: string;
  sesiones: number;
  porcentaje: number;
}

export interface PuntoDia {
  /** ISO yyyy-mm-dd */
  fecha: string;
  etiqueta: string;
  visitas: number;
  /** Sesiones distintas de ese día (o visitas si no hay sessionId). */
  sesiones: number;
  /** Clics de salida a tienda (.exit-cta) ese día. */
  salidas: number;
  /** Compras confirmadas ese día (Return Flow). */
  compras: number;
  /** Salidas ÷ visitas del día, en %. */
  conversionPct: number;
}

export interface ProductoMes {
  productId: string;
  titulo: string;
  visitas: number;
  salidas: number;
  compras: number;
  tasa: number;
}

export interface MesAnalitica {
  /** Mes calendario: yyyy-mm */
  month: string;
  /** Etiqueta legible: "Octubre 2026". */
  label: string;
  generadoEn: string;
  metrics: MetricasPeriodo;
  fuentes: FuenteMes[];
  evolucion: PuntoDia[];
  topProductos: ProductoMes[];
}

export interface ResumenAnalitica {
  resetAt: string | null;
  ignoredIps: string[];
  meses: MesAnalitica[];
}

const FUENTES: Array<{ id: FuenteId; etiqueta: string }> = [
  { id: 'organico', etiqueta: 'Orgánico' },
  { id: 'directo', etiqueta: 'Directo' },
  { id: 'social', etiqueta: 'Redes sociales' },
  { id: 'referido', etiqueta: 'Referido' },
  { id: 'email', etiqueta: 'Email / otros' },
];

let storeCache: { resetAt: string | null; meses: MesAnalitica[] } | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/* ------------------------------------------------------------------ helpers */

export function monthKeyOf(iso: string): string {
  return iso.slice(0, 7);
}

export function labelOfMonth(month: string): string {
  const [year, mon] = month.split('-');
  return `${MESES_ES[Number(mon) - 1] ?? mon} ${year}`;
}

/** Extrae el hostname (sin www.) de un referrer; cadena vacía si es directo/ilegible. */
function extraerHost(referrer: string | undefined): string {
  const raw = (referrer ?? '').trim().toLowerCase();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  }
}

/** Clasifica el referente de una visita en una fuente de tráfico. */
export function clasificarFuente(referrer: string | undefined): FuenteId {
  const host = extraerHost(referrer);
  if (!host) return 'directo';
  const propio = (process.env.PUBLIC_HOST ?? 'tradylor.com').replace(/^www\./, '');
  if (host === propio || host.endsWith(propio)) return 'directo';
  if (/google|bing|duckduckgo|yahoo|baidu|yandex|ecosia|brave|qwant/.test(host)) return 'organico';
  if (/facebook|instagram|twitter|x\.com|t\.co|tiktok|linkedin|pinterest|youtube|reddit|threads|whatsapp|telegram/.test(host)) return 'social';
  if (/mail\.|outlook|newsletter|list-manage|substack|sendgrid|mailchimp|campaign/.test(host)) return 'email';
  return 'referido';
}

export interface ReferrerTop {
  /** Hostname real (p.ej. "google.com") o "(directo)" cuando no hay referrer. */
  host: string;
  sesiones: number;
  porcentaje: number;
}

/**
 * Procedencias reales (dominios) detrás de las 5 fuentes agregadas: en vez de
 * "Orgánico 40%" muestra "google.com 32, bing.com 8", para auditar de dónde
 * viene el tráfico de verdad y detectar bots o referidos inesperados.
 */
export function computeTopReferrers(events: AnalyticsEvent[], limite = 8): ReferrerTop[] {
  const primerHost = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'page_view') continue;
    const key = event.sessionId ?? event.visitorId ?? event.createdAt;
    if (primerHost.has(key)) continue;
    primerHost.set(key, extraerHost(event.referrer) || '(directo)');
  }
  const counts = new Map<string, number>();
  for (const host of primerHost.values()) counts.set(host, (counts.get(host) ?? 0) + 1);
  const total = primerHost.size || 1;
  return [...counts.entries()]
    .map(([host, sesiones]) => ({ host, sesiones, porcentaje: redondear((sesiones / total) * 100) }))
    .sort((a, b) => b.sesiones - a.sesiones)
    .slice(0, limite);
}

const FUENTE_LABEL: Record<FuenteId, string> = Object.fromEntries(
  FUENTES.map((f) => [f.id, f.etiqueta]),
) as Record<FuenteId, string>;

function redondear(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function tituloDeProducto(productId: string): string {
  try {
    const product = findCatalogProduct(productId);
    if (product?.title) return product.title;
  } catch {
    // Catálogo no disponible: se queda con el id.
  }
  return productId;
}

/* ------------------------------------------------------- cálculo de periodo */

function eventosEnRango(events: AnalyticsEvent[], desdeMs: number, hastaMs: number): AnalyticsEvent[] {
  return events.filter((event) => {
    const ts = Date.parse(event.createdAt);
    return Number.isFinite(ts) && ts >= desdeMs && ts < hastaMs;
  });
}

/** Tope para la media de permanencia: una pestaña olvidada abierta horas no
 *  debe poder inflar "Tiempo medio de permanencia" (el beacon ya limita a 45
 *  min en el servidor; aquí se acota aún más sólo para la media, sin tocar
 *  el valor crudo almacenado). */
const MAX_DURATION_FOR_AVG_MS = 20 * 60 * 1000;

/** Agrupa un conjunto de eventos en las métricas de un periodo. */
export function computeMetricas(events: AnalyticsEvent[]): MetricasPeriodo {
  const sesiones = new Set<string>();
  const visitantes = new Set<string>();
  const paginasPorSesion = new Map<string, number>();
  const duraciones: number[] = [];
  const duracionPorSesion = new Map<string, number>();
  const rebotePorSesion = new Map<string, { paginas: number; durMs: number }>();
  const conversiones = new Set<string>();

  let visitas = 0;
  let salidas = 0;
  let carritos = 0;
  let compras = 0;
  let contactos = 0;
  let ingresos = 0;
  let pedidosConImporte = 0;

  for (const event of events) {
    if (event.sessionId) sesiones.add(event.sessionId);
    if (event.visitorId) visitantes.add(event.visitorId);
    if (event.type === 'page_view') {
      visitas += 1;
      if (event.sessionId) {
        paginasPorSesion.set(event.sessionId, (paginasPorSesion.get(event.sessionId) ?? 0) + 1);
        const estado = rebotePorSesion.get(event.sessionId) ?? { paginas: 0, durMs: 0 };
        estado.paginas += 1;
        rebotePorSesion.set(event.sessionId, estado);
      }
    } else if (event.type === 'outbound_click') {
      salidas += 1;
      conversiones.add(event.sessionId ?? event.visitorId ?? `${event.type}:${event.createdAt}`);
    } else if (event.type === 'cart_add') carritos += 1;
    else if (event.type === 'purchase') {
      compras += 1;
      conversiones.add(event.sessionId ?? event.visitorId ?? `${event.type}:${event.createdAt}`);
      if (typeof event.amount === 'number' && event.amount > 0) {
        ingresos += event.amount;
        pedidosConImporte += 1;
      }
    } else if (event.type === 'contact_click') contactos += 1;

    if (event.type === 'page_duration' && typeof event.durationMs === 'number') {
      duraciones.push(Math.min(event.durationMs, MAX_DURATION_FOR_AVG_MS));
      if (event.sessionId) {
        duracionPorSesion.set(event.sessionId, (duracionPorSesion.get(event.sessionId) ?? 0) + event.durationMs);
        const estado = rebotePorSesion.get(event.sessionId) ?? { paginas: 0, durMs: 0 };
        estado.durMs += event.durationMs;
        rebotePorSesion.set(event.sessionId, estado);
      }
    }
  }

  // Sin sessionId (beacons antiguos / middleware) contamos las visitas como sesiones.
  const totalSesiones = sesiones.size || visitas;
  const paginasTotales = [...paginasPorSesion.values()].reduce((sum, n) => sum + n, 0) || visitas;
  const permanenciaMedia = duraciones.length
    ? duraciones.reduce((sum, ms) => sum + ms, 0) / duraciones.length / 1000
    : 0;

  let rebotes = 0;
  for (const estado of rebotePorSesion.values()) {
    if (estado.paginas <= 1 && estado.durMs < 15_000) rebotes += 1;
  }
  const rebotePct = rebotePorSesion.size ? (rebotes / rebotePorSesion.size) * 100 : 0;

  return {
    sesiones: totalSesiones,
    usuariosUnicos: visitantes.size || totalSesiones,
    paginas: paginasTotales,
    paginasPorSesion: totalSesiones ? redondear(paginasTotales / totalSesiones, 2) : 0,
    permanenciaMediaSeg: redondear(permanenciaMedia, 0),
    rebotePct: redondear(rebotePct),
    visitas,
    salidas,
    carritos,
    compras,
    contactos,
    // Sesiones/visitantes que hicieron clic de salida o compra (sin doble conteo).
    conversionPct: totalSesiones ? redondear((conversiones.size / totalSesiones) * 100) : 0,
    aov: pedidosConImporte ? redondear(ingresos / pedidosConImporte, 2) : 0,
  };
}

/** Fuentes de tráfico (por sesión) de un conjunto de eventos. */
export function computeFuentes(events: AnalyticsEvent[]): FuenteMes[] {
  const primeraFuente = new Map<string, FuenteId>();
  for (const event of events) {
    if (event.type !== 'page_view') continue;
    const key = event.sessionId ?? event.visitorId ?? event.createdAt;
    if (!primeraFuente.has(key)) primeraFuente.set(key, clasificarFuente(event.referrer));
  }
  const counts = new Map<FuenteId, number>();
  for (const fuente of primeraFuente.values()) counts.set(fuente, (counts.get(fuente) ?? 0) + 1);
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0) || 1;
  return FUENTES.map(({ id, etiqueta }) => {
    const sesiones = counts.get(id) ?? 0;
    return { id, etiqueta, sesiones, porcentaje: redondear((sesiones / total) * 100) };
  });
}

/** Serie diaria de visitas, sesiones, salidas, compras y conversión de un conjunto de eventos. */
export function computeEvolucion(events: AnalyticsEvent[], limiteDias = 30): PuntoDia[] {
  const porDia = new Map<string, { visitas: number; sesiones: Set<string>; salidas: number; compras: number }>();
  for (const event of events) {
    const fecha = event.createdAt.slice(0, 10);
    const bucket = porDia.get(fecha) ?? { visitas: 0, sesiones: new Set<string>(), salidas: 0, compras: 0 };
    if (event.sessionId) bucket.sesiones.add(event.sessionId);
    if (event.type === 'page_view') bucket.visitas += 1;
    else if (event.type === 'outbound_click') bucket.salidas += 1;
    else if (event.type === 'purchase') bucket.compras += 1;
    porDia.set(fecha, bucket);
  }
  const dias = [...porDia.keys()].sort();
  return dias.slice(-limiteDias).map((fecha) => {
    const [year, month, day] = fecha.split('-');
    const bucket = porDia.get(fecha)!;
    return {
      fecha,
      etiqueta: `${day}/${month}`,
      visitas: bucket.visitas,
      sesiones: bucket.sesiones.size || bucket.visitas,
      salidas: bucket.salidas,
      compras: bucket.compras,
      conversionPct: bucket.visitas ? redondear((bucket.salidas / bucket.visitas) * 100) : 0,
    };
  });
}

/** Top productos de un conjunto de eventos. */
export function computeTopProductos(events: AnalyticsEvent[], limite = 10): ProductoMes[] {
  const byProduct = new Map<string, { visitas: number; salidas: number; compras: number }>();
  for (const event of events) {
    if (!event.productId) continue;
    const entry = byProduct.get(event.productId) ?? { visitas: 0, salidas: 0, compras: 0 };
    if (event.type === 'page_view') entry.visitas += 1;
    else if (event.type === 'outbound_click') entry.salidas += 1;
    else if (event.type === 'purchase') entry.compras += 1;
    byProduct.set(event.productId, entry);
  }
  return [...byProduct.entries()]
    .map(([productId, entry]) => ({
      productId,
      titulo: tituloDeProducto(productId),
      visitas: entry.visitas,
      salidas: entry.salidas,
      compras: entry.compras,
      tasa: entry.visitas ? Math.min(redondear((entry.salidas / entry.visitas) * 100), 100) : 0,
    }))
    .sort((a, b) => b.visitas - a.visitas)
    .slice(0, limite);
}

/**
 * Rendimiento de TODO el catálogo en el periodo (no sólo el Top 10): incluye
 * los productos sin ninguna visita con sus contadores a cero, para que la
 * búsqueda por nombre del dashboard encuentre cualquier ficha, no sólo las
 * más populares. No se usa en el histórico mensual ni en el Excel (que
 * siguen con `computeTopProductos`, limitado a 10) para no tocar esos
 * contratos ya existentes.
 */
export function computeProductosCompleto(events: AnalyticsEvent[]): ProductoMes[] {
  const byProduct = new Map<string, { titulo: string; visitas: number; salidas: number; compras: number }>();
  for (const producto of getCatalogProducts()) {
    byProduct.set(producto.id, { titulo: producto.title || producto.id, visitas: 0, salidas: 0, compras: 0 });
  }
  for (const event of events) {
    if (!event.productId) continue;
    const entry =
      byProduct.get(event.productId) ?? { titulo: tituloDeProducto(event.productId), visitas: 0, salidas: 0, compras: 0 };
    if (event.type === 'page_view') entry.visitas += 1;
    else if (event.type === 'outbound_click') entry.salidas += 1;
    else if (event.type === 'purchase') entry.compras += 1;
    byProduct.set(event.productId, entry);
  }
  return [...byProduct.entries()]
    .map(([productId, entry]) => ({
      productId,
      titulo: entry.titulo,
      visitas: entry.visitas,
      salidas: entry.salidas,
      compras: entry.compras,
      tasa: entry.visitas ? Math.min(redondear((entry.salidas / entry.visitas) * 100), 100) : 0,
    }))
    .sort((a, b) => b.visitas - a.visitas);
}

/* --------------------------------------------------------- periodo del panel */

export interface PeriodoDashboard {
  actual: MetricasPeriodo;
  anterior: MetricasPeriodo;
  fuentes: FuenteMes[];
  evolucion: PuntoDia[];
  topProductos: ProductoMes[];
  dias: number;
  /** Rendimiento de TODO el catálogo (no sólo el Top 10), para la búsqueda por nombre. */
  productosCompletos?: ProductoMes[];
  /** Dominios reales detrás de las 5 fuentes agregadas. */
  topReferrers?: ReferrerTop[];
}

const DAY_MS = 86_400_000;

/** Métricas de los últimos `dias` días + periodo anterior (para variaciones). */
export function getPeriodoDashboard(dias = 30): PeriodoDashboard {
  const ahora = Date.now();
  const desde = ahora - dias * DAY_MS;
  return getPeriodoRangoMs(desde, ahora, dias);
}

/**
 * Métricas para un rango arbitrario [desdeISO..hastaISO] (ambos inclusivos,
 * cortados a día). El periodo "anterior" tiene la misma longitud inmediatamente
 * antes, para poder calcular variaciones.
 */
export function getPeriodoRango(desdeISO: string, hastaISO: string): PeriodoDashboard {
  const desde = Date.parse(`${desdeISO}T00:00:00`);
  const hasta = Date.parse(`${hastaISO}T00:00:00`) + DAY_MS; // inclusive del día
  if (!Number.isFinite(desde) || !Number.isFinite(hasta) || hasta <= desde) {
    return getPeriodoDashboard(30);
  }
  const dias = Math.max(1, Math.round((hasta - desde) / DAY_MS));
  return getPeriodoRangoMs(desde, hasta, dias);
}

function getPeriodoRangoMs(desde: number, hasta: number, dias: number): PeriodoDashboard {
  const longitud = hasta - desde;
  const desdeAnterior = desde - longitud;
  const eventos = getAnalyticsEvents();
  const actuales = eventosEnRango(eventos, desde, hasta);
  const anteriores = eventosEnRango(eventos, desdeAnterior, desde);
  return {
    actual: computeMetricas(actuales),
    anterior: computeMetricas(anteriores),
    fuentes: computeFuentes(actuales),
    evolucion: computeEvolucion(actuales, Math.min(dias, 31)),
    topProductos: computeTopProductos(actuales),
    productosCompletos: computeProductosCompleto(actuales),
    topReferrers: computeTopReferrers(actuales),
    dias,
  };
}

/**
 * Fechas con eventos registrados, para resaltarlas en el calendario del panel.
 * Devuelve días (yyyy-mm-dd), meses (yyyy-mm) y años (yyyy) con al menos un evento.
 */
export function getFechasConDatos(): { dias: string[]; meses: string[]; anios: string[] } {
  const eventos = getAnalyticsEvents();
  const dias = new Set<string>();
  for (const event of eventos) {
    const fecha = event.createdAt.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) dias.add(fecha);
  }
  const listaDias = [...dias].sort();
  const meses = new Set(listaDias.map((d) => d.slice(0, 7)));
  const anios = new Set(listaDias.map((d) => d.slice(0, 4)));
  return { dias: listaDias, meses: [...meses].sort(), anios: [...anios].sort() };
}

/* ----------------------------------------------------- histórico por meses */

function leerStore(): { resetAt: string | null; meses: MesAnalitica[] } {
  if (storeCache) return storeCache;
  try {
    if (fs.existsSync(MONTHS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(MONTHS_PATH, 'utf-8')) as ResumenAnalitica;
      storeCache = {
        resetAt: parsed.resetAt ?? null,
        meses: Array.isArray(parsed.meses) ? parsed.meses : [],
      };
    }
  } catch (error) {
    console.warn('[Analytics] No se pudo leer analytics-months.json:', error);
  }
  storeCache ??= { resetAt: null, meses: [] };
  return storeCache;
}

function persistStore(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void escribirStore();
  }, 1_000);
  persistTimer.unref?.();
}

async function escribirStore(): Promise<void> {
  try {
    const store = leerStore();
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${MONTHS_PATH}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
    await fsp.rename(tmp, MONTHS_PATH);
  } catch (error) {
    console.warn('[Analytics] No se pudo persistir analytics-months.json:', error);
  }
}

/** Reconstruye los meses presentes en los eventos en vivo y los fusiona. */
function sincronizarMeses(): void {
  const store = leerStore();
  const eventos = getAnalyticsEvents();
  if (!eventos.length) return;
  const porMes = new Map<string, AnalyticsEvent[]>();
  for (const event of eventos) {
    const key = monthKeyOf(event.createdAt);
    const bucket = porMes.get(key) ?? [];
    bucket.push(event);
    porMes.set(key, bucket);
  }
  const existentes = new Map(store.meses.map((mes) => [mes.month, mes]));
  for (const [month, eventosMes] of porMes) {
    existentes.set(month, construirMes(month, eventosMes));
  }
  store.meses = [...existentes.values()].sort((a, b) => b.month.localeCompare(a.month));
  persistStore();
}

function construirMes(month: string, eventos: AnalyticsEvent[]): MesAnalitica {
  const evolucion = computeEvolucion(eventos, 31);
  return {
    month,
    label: labelOfMonth(month),
    generadoEn: new Date().toISOString(),
    metrics: computeMetricas(eventos),
    fuentes: computeFuentes(eventos),
    evolucion,
    topProductos: computeTopProductos(eventos),
  };
}

onAnalyticsFlush(() => {
  try {
    sincronizarMeses();
  } catch (error) {
    console.warn('[Analytics] No se pudieron sincronizar los meses:', error);
  }
});

/** Histórico mensual completo: meses cerrados + mes en curso calculado al vuelo. */
export function getMesesAnalitica(): ResumenAnalitica {
  const store = leerStore();
  const eventos = getAnalyticsEvents();
  const enVivo = new Map<string, AnalyticsEvent[]>();
  for (const event of eventos) {
    const key = monthKeyOf(event.createdAt);
    const bucket = enVivo.get(key) ?? [];
    bucket.push(event);
    enVivo.set(key, bucket);
  }
  const meses = new Map(store.meses.map((mes) => [mes.month, mes]));
  for (const [month, eventosMes] of enVivo) meses.set(month, construirMes(month, eventosMes));
  return {
    resetAt: store.resetAt,
    ignoredIps: getIgnoredIps(),
    meses: [...meses.values()].sort((a, b) => b.month.localeCompare(a.month)),
  };
}

/** Selecciona meses del histórico (valida el formato yyyy-mm). */
export function seleccionarMeses(resumen: ResumenAnalitica, claves: string[]): MesAnalitica[] {
  const pedidos = new Set(claves.map((clave) => clave.trim()).filter(Boolean));
  return resumen.meses.filter((mes) => pedidos.has(mes.month));
}

/** Vacía la medición por completo: eventos + histórico mensual. */
export async function resetAnalitica(): Promise<void> {
  resetAnalytics();
  storeCache = { resetAt: new Date().toISOString(), meses: [] };
  await escribirStore();
}
