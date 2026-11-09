/**
 * ==============================================================================
 * TREIDILOR — RECOMENDACIÓN DE PRECIO OBJETIVO (zonas realista / posible / poco probable)
 * ==============================================================================
 * Ayuda a elegir un precio objetivo con sentido. NO es una predicción ni una probabilidad calculada: es una GUÍA cualitativa construida sólo con:
 *  1) el historial REAL de la ficha (`collectPoints`): mínimo, máximo y volatilidad observados; con ≥ 3 lecturas la guía es «del historial»;
 *  2) sin historial suficiente, una referencia ORIENTATIVA por tramos de bajada sobre el precio actual (se rotula como tal, nunca como dato);
 *  3) el calendario: cerca del Black Friday las bajadas son más habituales (se amplía la zona «posible» y se dice).
 * Nunca se promete que el precio llegue al objetivo ni se inventa un porcentaje de probabilidad.
 *
 * Zonas (precio, de mayor a menor):  realista → posible → poco probable.
 *  - historial: «realista» = hasta la mitad de la volatilidad observada por debajo del precio actual (entre 3 % y 10 %); «posible» = hasta la
 *    volatilidad observada (entre 8 % y 25 %) sin bajar del mínimo histórico menos un 2 %; por debajo = «poco probable» (nunca se ha visto).
 *  - orientativa: realista ≤ 5 %, posible ≤ 12 %, por debajo poco probable.
 * ==============================================================================
 */

import { collectPoints } from './priceHistoryView';

export type ZoneKey = 'realista' | 'posible' | 'poco_probable';

export interface AdviceZone {
  key: ZoneKey;
  label: string;
  color: string;
  /** Límites de precio de la zona (from ≤ price ≤ to). */
  from: number;
  to: number;
}

export interface AdviceView {
  basis: 'historial' | 'orientativa';
  current: number;
  /** Extremos del control deslizante. */
  sliderMin: number;
  sliderMax: number;
  /** Precio objetivo sugerido (límite inferior de la zona realista, o el mínimo histórico si cae dentro). */
  recommended: number;
  zones: AdviceZone[];
  /** Umbrales para clasificar un precio en el cliente. */
  realistFrom: number;
  possibleFrom: number;
  /** Frase que explica en qué se basa la guía. */
  basisText: string;
  /** Nota de calendario (Black Friday) si procede. */
  eventNote: string | null;
  lowestRecorded: number | null;
  points: number;
}

export const ZONE_COLORS: Record<ZoneKey, string> = { realista: '#10b981', posible: '#f59e0b', poco_probable: '#ef4444' };
export const ZONE_LABELS: Record<ZoneKey, string> = { realista: 'Realista', posible: 'Posible', poco_probable: 'Poco probable' };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86_400_000;

/** Último viernes de noviembre (Black Friday) del año de `now`. */
export function blackFriday(year: number): Date {
  const d = new Date(Date.UTC(year, 10, 30));
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

/** ¿Estamos en la ventana de Black Friday / Cyber Monday (10 días antes y 4 después)? */
export function nearBlackFriday(now: Date): Date | null {
  const bf = blackFriday(now.getUTCFullYear());
  const diff = (now.getTime() - bf.getTime()) / DAY;
  return diff >= -10 && diff <= 4 ? bf : null;
}

const dateEs = (d: Date) => d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
const eur = (n: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

export function buildAdvice(product: { priceHistory?: unknown; extra?: unknown }, currentPrice: number, now: Date = new Date()): AdviceView {
  const current = round2(Number(currentPrice) || 0);
  const pts = collectPoints(product).filter((p) => Number.isFinite(p.price) && p.price > 0);
  const prices = pts.map((p) => p.price);
  const lowest = prices.length ? Math.min(...prices) : null;
  const highest = prices.length ? Math.max(...prices) : null;
  const hasHistory = pts.length >= 3 && lowest !== null && highest !== null;
  const bf = nearBlackFriday(now);

  let realPct: number;
  let possPct: number;
  if (hasHistory) {
    const vol = highest! > 0 ? (highest! - lowest!) / highest! : 0;
    realPct = clamp(vol * 0.5, 0.03, 0.1);
    possPct = clamp(vol, 0.08, 0.25);
  } else {
    realPct = 0.05;
    possPct = 0.12;
  }
  if (bf) possPct = Math.min(0.3, possPct + 0.05); // calendario: más bajadas habituales
  possPct = Math.max(possPct, realPct + 0.02);

  const realistFrom = round2(current * (1 - realPct));
  let possibleFrom = round2(current * (1 - possPct));
  // Con historial, por debajo del mínimo registrado (−2 %) el precio nunca se ha visto: poco probable.
  if (hasHistory && lowest! < current) possibleFrom = Math.max(possibleFrom, round2(lowest! * 0.98));
  possibleFrom = Math.min(possibleFrom, realistFrom);

  const sliderMax = Math.max(Math.ceil(current), 1);
  const sliderMin = Math.max(0.5, Math.floor(Math.min(lowest ?? current, current) * 0.5));
  // Sugerencia: el mínimo registrado si cae dentro de la zona realista; si no, el inicio de la zona realista.
  const recommended = hasHistory && lowest! >= realistFrom && lowest! <= current ? round2(lowest!) : realistFrom;

  const zones: AdviceZone[] = [
    { key: 'realista', label: ZONE_LABELS.realista, color: ZONE_COLORS.realista, from: realistFrom, to: sliderMax },
    { key: 'posible', label: ZONE_LABELS.posible, color: ZONE_COLORS.posible, from: possibleFrom, to: realistFrom },
    { key: 'poco_probable', label: ZONE_LABELS.poco_probable, color: ZONE_COLORS.poco_probable, from: sliderMin, to: possibleFrom },
  ];

  const basisText = hasHistory
    ? `Guía basada en el historial real de esta ficha (${pts.length} lecturas: mínimo ${eur(lowest!)}, máximo ${eur(highest!)}). No es una predicción: el precio puede no llegar al objetivo.`
    : `Referencia orientativa (esta ficha aún no tiene historial suficiente): se considera realista una bajada de hasta el ${Math.round(realPct * 100)} %, posible hasta el ${Math.round(possPct * 100)} % y poco probable más allá. No es un dato ni una predicción.`;
  const eventNote = bf
    ? `Estamos cerca del Black Friday (${dateEs(bf)}): suelen producirse más bajadas, así que la zona «posible» es más amplia.`
    : null;

  return {
    basis: hasHistory ? 'historial' : 'orientativa',
    current, sliderMin, sliderMax, recommended, zones, realistFrom, possibleFrom, basisText, eventNote,
    lowestRecorded: lowest, points: pts.length,
  };
}

/** Zona en la que cae un precio objetivo. */
export function zoneOf(advice: Pick<AdviceView, 'realistFrom' | 'possibleFrom' | 'current'>, target: number): ZoneKey {
  if (target >= advice.realistFrom) return 'realista';
  if (target >= advice.possibleFrom) return 'posible';
  return 'poco_probable';
}

/** CSS `linear-gradient` de la barra (de izquierda = precio bajo a derecha = precio alto) con las tres zonas. */
export function gradientOf(advice: AdviceView): string {
  const span = advice.sliderMax - advice.sliderMin || 1;
  const pct = (price: number) => clamp(((price - advice.sliderMin) / span) * 100, 0, 100);
  const a = pct(advice.possibleFrom).toFixed(1);
  const b = pct(advice.realistFrom).toFixed(1);
  const [r, p, u] = [ZONE_COLORS.realista, ZONE_COLORS.posible, ZONE_COLORS.poco_probable];
  return `linear-gradient(90deg, ${u} 0%, ${u} ${a}%, ${p} ${a}%, ${p} ${b}%, ${r} ${b}%, ${r} 100%)`;
}
