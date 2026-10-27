/**
 * ==============================================================================
 * TRADYLOR — GENERADOR DE MÉTRICA ÓPTIMA (DATOS FICTICIOS)
 * ==============================================================================
 * Produce un PeriodoDashboard completo y determinista para cualquier rango de
 * fechas, representando el tráfico que tendría un portal de afiliación de
 * éxito (coherente: estacionalidad semanal, tendencia de crecimiento, reparto
 * de fuentes realista y ranking de productos del catálogo).
 *
 * Los números son ficticios pero estables: el mismo día siempre devuelve los
 * mismos valores, y los meses posteriores crecen suavemente. Sirven como meta
 * de referencia frente a los datos reales.
 * ==============================================================================
 */
import { getCatalogProducts, productKey } from './catalog';
import type {
  FuenteMes,
  MetricasPeriodo,
  PeriodoDashboard,
  PuntoDia,
  ProductoMes,
} from './analyticsMonths';

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2026, 0, 1);

const MESES_CORTOS = [
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
];

/** Hash determinista (FNV-1a) de una cadena → [0,1). */
function hash01(texto: string): number {
  let h = 2166136261;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Ruido determinista acotado en [-r, +r] a partir de una semilla. */
function ruido(semilla: string, amplitud = 0.12): number {
  return 1 + (hash01(semilla) * 2 - 1) * amplitud;
}

/** Visitas óptimas de un día concreto (estable por fecha). */
function visitasDia(iso: string): number {
  const ts = Date.parse(`${iso}T12:00:00Z`);
  if (!Number.isFinite(ts)) return 0;
  const dow = new Date(ts).getUTCDay(); // 0=Dom .. 6=Sáb
  // Fin de semana más fuerte (compras) y lunes pico laboral.
  const semanal = [1.2, 1.12, 1.02, 1.0, 1.06, 1.16, 1.24][dow];
  const dias = Math.floor((ts - EPOCH) / DAY_MS);
  const crecimiento = 1 + Math.max(dias, -180) * 0.0007; // ~+0,07 %/día
  const base = 150;
  return Math.max(1, Math.round(base * semanal * crecimiento * ruido(`v:${iso}`)));
}

/** Sesiones/salidas/compras óptimas de un día, con las mismas proporciones que `metricasOptimas`. */
function sesionesDia(iso: string, visitas: number): number {
  const paginasPorSesion = 3.6 * ruido(`pps:${iso}`, 0.08);
  return Math.max(1, Math.round(visitas / paginasPorSesion));
}
function salidasDia(iso: string, visitas: number): number {
  return Math.round(visitas * 0.092 * ruido(`sal:${iso}`, 0.1));
}
function comprasDia(iso: string, sesiones: number): number {
  return Math.round(sesiones * 0.049 * ruido(`com:${iso}`, 0.12));
}

function isoDeTs(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function etiquetaDia(iso: string): string {
  const [, mes, dia] = iso.split('-');
  return `${dia}/${mes}`;
}

/**
 * Serie diaria de visitas para un rango, reducida a como máximo `maxPuntos`
 * agregando buckets cuando el rango es largo (para que el gráfico sea legible).
 */
function serieDiaria(desdeISO: string, hastaISO: string, maxPuntos = 31): PuntoDia[] {
  const desde = Date.parse(`${desdeISO}T12:00:00Z`);
  const hasta = Date.parse(`${hastaISO}T12:00:00Z`);
  if (!Number.isFinite(desde) || !Number.isFinite(hasta) || hasta < desde) return [];

  const dias: Array<{ iso: string; visitas: number; sesiones: number; salidas: number; compras: number }> = [];
  for (let ts = desde; ts <= hasta; ts += DAY_MS) {
    const iso = isoDeTs(ts);
    const visitas = visitasDia(iso);
    const sesiones = sesionesDia(iso, visitas);
    const salidas = salidasDia(iso, visitas);
    const compras = comprasDia(iso, sesiones);
    dias.push({ iso, visitas, sesiones, salidas, compras });
  }

  const conversion = (visitas: number, salidas: number) =>
    visitas ? Math.round((salidas / visitas) * 1000) / 10 : 0;

  if (dias.length <= maxPuntos) {
    return dias.map((d) => ({
      fecha: d.iso,
      etiqueta: etiquetaDia(d.iso),
      visitas: d.visitas,
      sesiones: d.sesiones,
      salidas: d.salidas,
      compras: d.compras,
      conversionPct: conversion(d.visitas, d.salidas),
    }));
  }

  const tamBucket = Math.ceil(dias.length / maxPuntos);
  const salida: PuntoDia[] = [];
  for (let i = 0; i < dias.length; i += tamBucket) {
    const grupo = dias.slice(i, i + tamBucket);
    const visitas = grupo.reduce((s, d) => s + d.visitas, 0);
    const sesiones = grupo.reduce((s, d) => s + d.sesiones, 0);
    const salidas = grupo.reduce((s, d) => s + d.salidas, 0);
    const compras = grupo.reduce((s, d) => s + d.compras, 0);
    salida.push({
      fecha: grupo[0].iso,
      etiqueta: etiquetaDia(grupo[0].iso),
      visitas,
      sesiones,
      salidas,
      compras,
      conversionPct: conversion(visitas, salidas),
    });
  }
  return salida;
}

function totalVisitasRango(desdeISO: string, hastaISO: string): number {
  const desde = Date.parse(`${desdeISO}T12:00:00Z`);
  const hasta = Date.parse(`${hastaISO}T12:00:00Z`);
  if (!Number.isFinite(desde) || !Number.isFinite(hasta) || hasta < desde) return 0;
  let total = 0;
  for (let ts = desde; ts <= hasta; ts += DAY_MS) total += visitasDia(isoDeTs(ts));
  return total;
}

/** Reparto óptimo de fuentes para un portal de afiliación (suma 100 %). */
function fuentesOptimas(visitas: number): FuenteMes[] {
  const semilla = 'fuentes';
  const pesos = [
    { id: 'organico' as const, etiqueta: 'Orgánico', base: 42 },
    { id: 'directo' as const, etiqueta: 'Directo', base: 24 },
    { id: 'social' as const, etiqueta: 'Redes sociales', base: 17 },
    { id: 'referido' as const, etiqueta: 'Referido', base: 10 },
    { id: 'email' as const, etiqueta: 'Email / otros', base: 7 },
  ];
  const conRuido = pesos.map((p) => ({ ...p, peso: p.base * ruido(`${semilla}:${p.id}`, 0.08) }));
  const suma = conRuido.reduce((s, p) => s + p.peso, 0);
  const sesiones = Math.round(visitas / 3.8);
  return conRuido.map((p) => {
    const porcentaje = Math.round((p.peso / suma) * 1000) / 10;
    return { id: p.id, etiqueta: p.etiqueta, porcentaje, sesiones: Math.round((sesiones * porcentaje) / 100) };
  });
}

function metricasOptimas(visitas: number, semilla: string): MetricasPeriodo {
  const paginasPorSesion = Math.round((3.6 * ruido(`pps:${semilla}`, 0.08)) * 100) / 100;
  const sesiones = Math.max(1, Math.round(visitas / paginasPorSesion));
  const usuariosUnicos = Math.round(sesiones * 0.72);
  const permanenciaMediaSeg = Math.round(168 * ruido(`perm:${semilla}`, 0.1));
  const rebotePct = Math.round(33 * ruido(`reb:${semilla}`, 0.12) * 10) / 10;
  const salidas = Math.round(visitas * 0.092 * ruido(`sal:${semilla}`, 0.1));
  const carritos = Math.round(salidas * 0.42);
  const compras = Math.round(sesiones * 0.049 * ruido(`com:${semilla}`, 0.12));
  const contactos = Math.round(visitas * 0.012);
  const conversionPct = Math.round((salidas / sesiones) * 1000) / 10;
  const aov = Math.round(78 * ruido(`aov:${semilla}`, 0.1) * 100) / 100;

  return {
    sesiones,
    usuariosUnicos,
    paginas: visitas,
    paginasPorSesion,
    permanenciaMediaSeg,
    rebotePct,
    visitas,
    salidas,
    carritos,
    compras,
    contactos,
    conversionPct,
    aov,
  };
}

/** Ranking óptimo de productos repartiendo las visitas del periodo. */
function productosOptimos(visitas: number): ProductoMes[] {
  let catalogo: Array<{ id: string; title: string }> = [];
  try {
    catalogo = getCatalogProducts().map((p) => ({ id: productKey(p), title: p.title }));
  } catch {
    catalogo = [];
  }
  if (!catalogo.length) return [];

  const conPeso = catalogo.map((p) => ({ ...p, peso: 0.4 + hash01(`prod:${p.id}`) }));
  conPeso.sort((a, b) => b.peso - a.peso);
  const top = conPeso.slice(0, 8);
  const sumaPesos = top.reduce((s, p) => s + p.peso, 0);

  return top.map((p) => {
    const prodVisitas = Math.max(1, Math.round((visitas * p.peso) / sumaPesos));
    const tasa = Math.round((6 + hash01(`tasa:${p.id}`) * 5) * 10) / 10; // 6–11 %
    const prodSalidas = Math.round((prodVisitas * tasa) / 100);
    const prodCompras = Math.round(prodSalidas * 0.28);
    return {
      productId: p.id,
      titulo: p.title,
      visitas: prodVisitas,
      salidas: prodSalidas,
      compras: prodCompras,
      tasa,
    };
  });
}

/**
 * PeriodoDashboard óptimo (ficticio) para un rango [desdeISO..hastaISO]
 * inclusivo. El "anterior" usa el rango previo de igual longitud, más bajo por
 * la tendencia de crecimiento, de modo que las variaciones salen positivas.
 */
export function getPeriodoOptimo(desdeISO: string, hastaISO: string): PeriodoDashboard {
  const desde = Date.parse(`${desdeISO}T12:00:00Z`);
  const hasta = Date.parse(`${hastaISO}T12:00:00Z`);
  const dias = Number.isFinite(desde) && Number.isFinite(hasta) && hasta >= desde
    ? Math.round((hasta - desde) / DAY_MS) + 1
    : 30;

  const visitas = totalVisitasRango(desdeISO, hastaISO);
  const anteriorDesde = isoDeTs(desde - dias * DAY_MS);
  const anteriorHasta = isoDeTs(desde - DAY_MS);
  const visitasAnterior = totalVisitasRango(anteriorDesde, anteriorHasta);

  const semilla = `${desdeISO}:${hastaISO}`;
  return {
    actual: metricasOptimas(visitas, semilla),
    anterior: metricasOptimas(visitasAnterior, `ant:${anteriorDesde}:${anteriorHasta}`),
    fuentes: fuentesOptimas(visitas),
    evolucion: serieDiaria(desdeISO, hastaISO),
    topProductos: productosOptimos(visitas),
    dias,
  };
}

/** Etiqueta legible de un rango para el selector (ej. "10 Oct 2026"). */
export function etiquetaRangoOptimo(desdeISO: string, hastaISO: string): string {
  const [y, m, d] = desdeISO.split('-');
  const mismaFecha = desdeISO === hastaISO;
  const mismoMes = desdeISO.slice(0, 7) === hastaISO.slice(0, 7);
  const mes = MESES_CORTOS[Number(m) - 1] ?? m;
  if (mismaFecha) return `${Number(d)} ${mes} ${y}`;
  if (mismoMes) return `${Number(d)}–${Number(hastaISO.slice(8))} ${mes} ${y}`;
  return `${Number(d)} ${mes} – ${Number(hastaISO.slice(8))} ${MESES_CORTOS[Number(hastaISO.slice(5, 7)) - 1]} ${y}`;
}

export { DAY_MS as OPTIMO_DAY_MS };
