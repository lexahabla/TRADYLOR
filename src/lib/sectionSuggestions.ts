import { readProductsFromFile, type Product } from './productStore';

/**
 * ==============================================================================
 * TRADYLOR — SUGERENCIAS INTELIGENTES DE SECCIONES (calendario comercial)
 * ==============================================================================
 * Motor 100% automático y determinista (sin APIs externas ni claves nuevas):
 * según la fecha actual, propone secciones listas para publicar con sus
 * productos ya seleccionados (descuento / valoración / novedad). El admin solo
 * pulsa "Crear" — cero trabajo manual.
 *
 * Si ningún evento comercial está activo hoy, se ofrecen 2 sugerencias
 * "evergreen" (mayor ahorro ahora mismo / novedades) para que el botón de
 * sugerencias nunca aparezca vacío.
 * ==============================================================================
 */

export interface SectionSuggestion {
  key: string;
  title: string;
  description: string;
  icon: string;
  productIds: string[];
  /** Explicación corta del criterio de selección automática. */
  reason: string;
}

type Heuristic = 'discount' | 'rating' | 'novelty';

interface CalendarEvent {
  key: string;
  title: string;
  icon: string;
  description: string;
  heuristic: Heuristic;
  /** [mes inicio, día inicio, mes fin, día fin] — admite rangos que cruzan fin de año. */
  range: [number, number, number, number];
}

const MAX_PRODUCTS_PER_SUGGESTION = 12;
const MIN_PRODUCTS_PER_SUGGESTION = 4;

/** Calendario comercial (España/UE). Puede haber varios eventos activos a la vez. */
const CALENDAR_EVENTS: CalendarEvent[] = [
  { key: 'black-friday', title: '🔥 Black Friday', icon: '🔥', heuristic: 'discount', range: [11, 18, 11, 30], description: 'Los descuentos más agresivos del catálogo ahora mismo.' },
  { key: 'cyber-monday', title: '💻 Cyber Monday', icon: '💻', heuristic: 'discount', range: [12, 1, 12, 2], description: 'Última llamada de ofertas tras el Black Friday.' },
  { key: 'navidad', title: '🎄 Ideas para Navidad', icon: '🎄', heuristic: 'rating', range: [12, 1, 12, 24], description: 'Las opciones mejor valoradas del catálogo para regalar sin arriesgar.' },
  { key: 'reyes-rebajas', title: '👑 Rebajas de enero', icon: '👑', heuristic: 'discount', range: [1, 1, 1, 31], description: 'Lo que más ha bajado de precio para arrancar el año.' },
  { key: 'san-valentin', title: '💘 San Valentín', icon: '💘', heuristic: 'rating', range: [2, 1, 2, 14], description: 'Regalos con las valoraciones más altas del catálogo.' },
  { key: 'dia-madre', title: '🌷 Día de la Madre', icon: '🌷', heuristic: 'rating', range: [4, 25, 5, 10], description: 'Selección mejor valorada para acertar seguro.' },
  { key: 'verano', title: '☀️ Esenciales de verano', icon: '☀️', heuristic: 'novelty', range: [6, 1, 7, 15], description: 'Las novedades más recientes del catálogo para esta temporada.' },
  { key: 'ofertas-flash-verano', title: '⚡ Ofertas flash de verano', icon: '⚡', heuristic: 'discount', range: [7, 8, 7, 20], description: 'Descuentos destacados durante la ventana de grandes ofertas de julio.' },
  { key: 'vuelta-cole', title: '🎒 Vuelta al Cole', icon: '🎒', heuristic: 'novelty', range: [8, 20, 9, 15], description: 'Novedades recientes para la vuelta a clase y al trabajo.' },
  { key: 'halloween', title: '🎃 Halloween', icon: '🎃', heuristic: 'novelty', range: [10, 15, 10, 31], description: 'Las últimas novedades incorporadas al catálogo.' },
  { key: 'singles-day', title: '🛍️ Ofertas 11.11', icon: '🛍️', heuristic: 'discount', range: [11, 1, 11, 11], description: 'Arrancan los grandes descuentos antes del Black Friday.' },
];

const EVERGREEN_EVENTS: CalendarEvent[] = [
  { key: 'top-ahorro', title: '💰 Mayor ahorro ahora mismo', icon: '💰', heuristic: 'discount', range: [1, 1, 12, 31], description: 'Los descuentos más altos del catálogo en este momento.' },
  { key: 'novedades-catalogo', title: '🆕 Novedades del catálogo', icon: '🆕', heuristic: 'novelty', range: [1, 1, 12, 31], description: 'Lo último que ha entrado en el catálogo.' },
];

/** `true` si (mes, día) cae dentro del rango, admitiendo rangos que cruzan fin de año (ej. 20 dic - 10 ene). */
function inRange(month: number, day: number, range: [number, number, number, number]): boolean {
  const [m1, d1, m2, d2] = range;
  const cur = month * 100 + day;
  const start = m1 * 100 + d1;
  const end = m2 * 100 + d2;
  return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end;
}

function byDiscount(products: Product[]): Product[] {
  return products
    .filter((p) => typeof p.originalPrice === 'number' && p.originalPrice > p.price)
    .sort((a, b) => {
      const da = (a.originalPrice! - a.price) / a.originalPrice!;
      const db = (b.originalPrice! - b.price) / b.originalPrice!;
      return db - da;
    });
}

function byRating(products: Product[]): Product[] {
  return products
    .filter((p) => (p.rating ?? 0) >= 4)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.reviewsCount ?? 0) - (a.reviewsCount ?? 0));
}

function byNovelty(products: Product[]): Product[] {
  const stamp = (p: Product) => Date.parse(p.pipeline_run_at ?? '') || 0;
  return [...products].sort((a, b) => stamp(b) - stamp(a));
}

/**
 * Sugerencias de secciones según la fecha dada (por defecto, hoy). Cada
 * sugerencia ya trae sus `productIds` calculados: el admin sólo necesita
 * pulsar "Crear" en `/upayp1b4` (POST existente `/api/admin/sections`).
 */
export function getSeasonalSectionSuggestions(referenceDate: Date = new Date()): SectionSuggestion[] {
  const month = referenceDate.getMonth() + 1;
  const day = referenceDate.getDate();

  const products = readProductsFromFile().filter((p) => p.audit_status !== 'rejected' && p.link_status !== 'broken');
  const pools: Record<Heuristic, Product[]> = {
    discount: byDiscount(products),
    rating: byRating(products),
    novelty: byNovelty(products),
  };

  const active = CALENDAR_EVENTS.filter((event) => inRange(month, day, event.range));
  const chosen = active.length > 0 ? active : EVERGREEN_EVENTS;

  const reasonLabel: Record<Heuristic, string> = {
    discount: 'Ordenado por % de descuento',
    rating: 'Ordenado por valoración y nº de reseñas',
    novelty: 'Ordenado por fecha de alta en el catálogo',
  };

  const suggestions: SectionSuggestion[] = [];
  for (const event of chosen) {
    const picked = pools[event.heuristic].slice(0, MAX_PRODUCTS_PER_SUGGESTION);
    if (picked.length < MIN_PRODUCTS_PER_SUGGESTION) continue;
    suggestions.push({
      key: event.key,
      title: event.title,
      description: event.description,
      icon: event.icon,
      productIds: picked.map((p) => p.id),
      reason: reasonLabel[event.heuristic],
    });
  }
  return suggestions;
}
