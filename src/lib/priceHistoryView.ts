/**
 * ==============================================================================
 * TREIDILOR — HISTORIAL DE PRECIOS (vista pura por periodos)
 * ==============================================================================
 * Convierte las observaciones REALES de una ficha en cuatro vistas (1, 3, 6 y 12 meses). No inventa nada:
 *  - Sólo se usan `product.priceHistory` (el precio del catálogo registrado en la fecha en que se visitó la ficha) y `extra.observations`
 *    (lecturas verificadas contra la tienda, en EUR). Cada punto conserva su fecha real y su procedencia.
 *  - Nunca se generan puntos intermedios ni se «rellena» un hueco: el gráfico es en ESCALÓN (el precio se mantiene hasta la siguiente lectura
 *    registrada) y sólo hay marcas en las fechas realmente observadas.
 *  - Es el historial de la oferta principal de ESTA ficha (un modelo, una variante). No se mezclan fichas ni vendedores.
 *  - El precio es el del producto, SIN gastos de envío (el envío se muestra aparte).
 *  - Con menos de 2 lecturas en el periodo, el periodo se declara «sin historial suficiente».
 * ==============================================================================
 */

export type PeriodKey = '1m' | '3m' | '6m' | '12m';
export const PERIODS: Array<{ key: PeriodKey; label: string; days: number }> = [
  { key: '1m', label: '1 mes', days: 30 },
  { key: '3m', label: '3 meses', days: 91 },
  { key: '6m', label: '6 meses', days: 182 },
  { key: '12m', label: '12 meses', days: 365 },
];

export type PointSource = 'visita' | 'verificada';
export interface HistoryPoint { date: string; price: number; source: PointSource }

export interface PeriodView {
  key: PeriodKey;
  label: string;
  days: number;
  from: string;
  to: string;
  points: HistoryPoint[];
  sufficient: boolean;
  min: HistoryPoint | null;
  max: HistoryPoint | null;
  first: HistoryPoint | null;
  last: HistoryPoint | null;
  /** Variación entre la primera y la última lectura del periodo (%), o null. */
  changePct: number | null;
  /** Geometría SVG (escalón) lista para pintar. */
  chart: { width: number; height: number; path: string; area: string; markers: Array<{ x: number; y: number; date: string; price: number; source: PointSource }>; yTicks: Array<{ y: number; price: number }> } | null;
}

export interface HistoryView {
  /** Todas las lecturas reales ordenadas por fecha. */
  total: number;
  /** true si el historial se compone sólo de lecturas verificadas con la tienda. */
  onlyVerified: boolean;
  firstDate: string | null;
  lastDate: string | null;
  periods: PeriodView[];
  /** Periodo que se muestra por defecto: el más corto con historial suficiente (si ninguno, '3m'). */
  defaultPeriod: PeriodKey;
}

const DAY = 86_400_000;
const isoDay = (v: unknown): string | null => {
  const s = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) ? s : null;
};

/** Lecturas reales de la ficha: visitas (precio del catálogo ese día) y observaciones verificadas (que mandan si coinciden en fecha). */
export function collectPoints(product: { priceHistory?: unknown; extra?: unknown }): HistoryPoint[] {
  const byDate = new Map<string, HistoryPoint>();
  const history = Array.isArray(product.priceHistory) ? (product.priceHistory as Array<{ date?: unknown; price?: unknown }>) : [];
  for (const h of history) {
    const date = isoDay(h?.date);
    const price = Number(h?.price);
    if (date && Number.isFinite(price) && price > 0) byDate.set(date, { date, price, source: 'visita' });
  }
  const extra = (product.extra ?? {}) as { observations?: unknown };
  const obs = Array.isArray(extra.observations) ? (extra.observations as Array<Record<string, any>>) : [];
  for (const o of obs) {
    const date = isoDay(o?.capturedAt);
    const price = Number(o?.price);
    const currency = String(o?.context?.currency ?? 'EUR').toUpperCase();
    if (date && currency === 'EUR' && Number.isFinite(price) && price > 0 && o?.verifiedAt) byDate.set(date, { date, price, source: 'verificada' });
  }
  const all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  // Con lecturas VERIFICADAS suficientes (≥ 2) el historial se construye sólo con ellas: el precio del catálogo anotado en una visita no es una lectura de tienda.
  const verified = all.filter((p) => p.source === 'verificada');
  return verified.length >= 2 ? verified : all;
}

const W = 640;
const H = 220;
const PAD = { l: 8, r: 8, t: 14, b: 16 };

function buildChart(points: HistoryPoint[], from: number, to: number): NonNullable<PeriodView['chart']> {
  const prices = points.map((p) => p.price);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  if (hi === lo) { lo -= 1; hi += 1; } // línea plana: margen visual, no un dato
  const span = Math.max(to - from, DAY);
  const x = (date: string) => PAD.l + ((Date.parse(date) - from) / span) * (W - PAD.l - PAD.r);
  const y = (price: number) => PAD.t + (1 - (price - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const f = (n: number) => n.toFixed(1);
  let path = `M${f(x(points[0].date))},${f(y(points[0].price))}`;
  for (let i = 1; i < points.length; i++) path += ` H${f(x(points[i].date))} V${f(y(points[i].price))}`;
  const lastX = x(points[points.length - 1].date);
  const area = `${path} V${H - PAD.b} H${f(x(points[0].date))} Z`;
  const ticks = [hi, (hi + lo) / 2, lo].map((price) => ({ y: y(price), price: Math.round(price * 100) / 100 }));
  void lastX;
  return {
    width: W,
    height: H,
    path,
    area,
    markers: points.map((p) => ({ x: x(p.date), y: y(p.price), date: p.date, price: p.price, source: p.source })),
    yTicks: ticks,
  };
}

export function buildHistoryView(product: { priceHistory?: unknown; extra?: unknown }, now: Date = new Date()): HistoryView {
  const all = collectPoints(product);
  const toMs = now.getTime();
  const toIso = now.toISOString().slice(0, 10);
  const periods: PeriodView[] = PERIODS.map((p) => {
    const fromMs = toMs - p.days * DAY;
    const points = all.filter((pt) => Date.parse(pt.date) >= fromMs - DAY && Date.parse(pt.date) <= toMs + DAY);
    const sufficient = points.length >= 2;
    const min = points.length ? points.reduce((a, b) => (b.price < a.price ? b : a)) : null;
    const max = points.length ? points.reduce((a, b) => (b.price > a.price ? b : a)) : null;
    const first = points[0] ?? null;
    const last = points[points.length - 1] ?? null;
    return {
      key: p.key, label: p.label, days: p.days,
      from: new Date(fromMs).toISOString().slice(0, 10), to: toIso,
      points, sufficient, min, max, first, last,
      changePct: sufficient && first && last && first.price > 0 ? Math.round(((last.price - first.price) / first.price) * 1000) / 10 : null,
      chart: sufficient ? buildChart(points, Date.parse(points[0].date), Date.parse(points[points.length - 1].date)) : null,
    };
  });
  // Por defecto 3 meses si tiene historial suficiente; si no, el primer periodo que lo tenga.
  const firstSufficient = periods.find((p) => p.key === '3m' && p.sufficient) ?? periods.find((p) => p.sufficient);
  return {
    total: all.length,
    onlyVerified: all.length > 0 && all.every((p) => p.source === 'verificada'),
    firstDate: all[0]?.date ?? null,
    lastDate: all[all.length - 1]?.date ?? null,
    periods,
    defaultPeriod: (firstSufficient?.key ?? '3m') as PeriodKey,
  };
}
