/**
 * ==============================================================================
 * TRADYLOR — PERFIL DE COMPRADOR (Perfilador: tipos compartidos cliente/servidor)
 * ==============================================================================
 * Dominio propio del Perfilador (`SmartMatcherWizard`): uso + presupuesto +
 * prioridad → un perfil guardado con nombre y color generados automáticamente.
 * No tiene relación funcional con Mi Radar: solo reutiliza su motor de
 * almacenamiento/sincronización (LocalStorage + /api/radar) como infraestructura
 * genérica compartida con el resto de "registros de herramienta" (comparativas
 * del Comparador, chats del Dependiente IA). Por eso `RadarData`
 * (`types/radar.ts`) sigue transportando `buyerProfiles`/`activeBuyerProfileId`,
 * pero el dueño de ese dominio (tipo, etiquetas, nombre/color automáticos y
 * validación) es este fichero.
 * Sin imports de Node: se usa tanto en navegador (`utils/buyerProfileStore.ts`)
 * como en el backend (`lib/radarStore.ts`).
 * ==============================================================================
 */

/**
 * Perfil de Comprador guardado: resultado nombrado del Perfilador
 * (uso + presupuesto + prioridad). Un usuario puede guardar varios; el
 * selector del mainNav marca uno como "activo" (`RadarData.activeBuyerProfileId`).
 * El activo actúa como filtro VISUAL (badge "Encaja con tu perfil") en el
 * catálogo, nunca oculta productos.
 */
export interface BuyerProfile {
  id: string;
  name: string;
  /** Uso principal elegido en el Perfilador (ver data-value de SmartMatcherWizard). */
  usage: string;
  /** Presupuesto elegido en el Perfilador: low | mid | high | premium. */
  budget: string;
  /** Prioridad elegida en el Perfilador: price | quality | balance. */
  priority: string;
  /** Color generado automáticamente para la combinación (HSL string). */
  color?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Etiquetas legibles de los valores `data-value` del Perfilador
 * (SmartMatcherWizard). Se comparten aquí para que el selector del mainNav,
 * Mi Radar y el badge "Encaja con tu perfil" no dupliquen el texto.
 */
export const BUYER_PROFILE_USAGE_LABELS: Record<string, string> = {
  productividad: 'Productividad',
  entretenimiento: 'Entretenimiento',
  creatividad: 'Creatividad',
  hogar: 'Hogar Inteligente',
  movilidad: 'Movilidad',
  fitness: 'Fitness y Salud',
};
export const BUYER_PROFILE_BUDGET_LABELS: Record<string, string> = {
  low: 'Hasta 100€',
  mid: '100€ – 400€',
  high: '400€ – 1000€',
  premium: 'Más de 1000€',
};
export const BUYER_PROFILE_BUDGET_RANGES: Record<string, [number, number]> = {
  low: [0, 100],
  mid: [100, 400],
  high: [400, 1000],
  premium: [1000, Infinity],
};
export const BUYER_PROFILE_PRIORITY_LABELS: Record<string, string> = {
  price: 'Precio',
  quality: 'Calidad / Durabilidad',
  balance: 'Equilibrio',
};

/**
 * Subtítulos de cada opción (el mismo texto que ya se ve bajo cada botón del
 * Perfilador, `smw-option-desc` en `SmartMatcherWizard.astro`): explican a qué
 * se refiere la combinación elegida en el resultado y en "Tus perfiles de
 * comprador". Si en el futuro se añade una categoría nueva de uso, debe
 * encajar como sinónimo dentro de uno de estos 6 grupos (no se crea un 7º).
 */
export const BUYER_PROFILE_USAGE_SUBTITLES: Record<string, string> = {
  productividad: 'Trabajo, estudio o multitarea',
  entretenimiento: 'Streaming, gaming, audio',
  creatividad: 'Diseño, edición, creación',
  hogar: 'Automatización y domótica',
  movilidad: 'Portátiles, wearables, transporte',
  fitness: 'Wearables, salud, bienestar',
};
export const BUYER_PROFILE_BUDGET_SUBTITLES: Record<string, string> = {
  low: 'Calidad esencial, gran valor',
  mid: 'Equilibrio perfecto calidad-precio',
  high: 'Prestaciones profesionales',
  premium: 'Sin límites, lo mejor del mercado',
};
export const BUYER_PROFILE_PRIORITY_SUBTITLES: Record<string, string> = {
  price: 'Maximizar el ahorro y la oferta',
  quality: 'Lo mejor aunque cueste más',
  balance: 'Relación calidad-precio óptima',
};

/**
 * Máximo de perfiles de comprador guardados por usuario: uno por cada uso del
 * primer paso del Perfilador (6 usos → 6 perfiles como máximo). Guardar un
 * perfil nuevo para un uso que ya tenía uno GUARDADO lo sustituye (ver
 * `saveBuyerProfile` en `utils/buyerProfileStore.ts`); no se amontonan varios
 * perfiles para el mismo uso.
 */
export const BUYER_PROFILE_MAX = 6;

/**
 * Nombre equivalente a cada una de las 72 combinaciones (6 usos × 4
 * presupuestos × 3 prioridades) del Perfilador. Lista cerrada tal cual se
 * definió en `perfilador.txt`. Clave: `uso|presupuesto|prioridad` (valores
 * `data-value` del wizard, no las etiquetas legibles).
 */
const BUYER_PROFILE_NAMES: Record<string, string> = {
  'productividad|low|price': 'Básico',
  'productividad|low|quality': 'Esencial',
  'productividad|low|balance': 'Útil',
  'productividad|mid|price': 'Funcional',
  'productividad|mid|quality': 'Pragmático',
  'productividad|mid|balance': 'Eficiente',
  'productividad|high|price': 'Avanzado',
  'productividad|high|quality': 'Profesional',
  'productividad|high|balance': 'Competitivo',
  'productividad|premium|price': 'Ejecutivo',
  'productividad|premium|quality': 'Supremo',
  'productividad|premium|balance': 'Óptimo',

  'entretenimiento|low|price': 'Casual',
  'entretenimiento|low|quality': 'Lúdico',
  'entretenimiento|low|balance': 'Divertido',
  'entretenimiento|mid|price': 'Recreativo',
  'entretenimiento|mid|quality': 'Inmersivo',
  'entretenimiento|mid|balance': 'Dinámico',
  'entretenimiento|high|price': 'Multimedia',
  'entretenimiento|high|quality': 'Cinematográfico',
  'entretenimiento|high|balance': 'Sensorial',
  'entretenimiento|premium|price': 'Épico',
  'entretenimiento|premium|quality': 'Legendario',
  'entretenimiento|premium|balance': 'Absoluto',

  'creatividad|low|price': 'Inspirador',
  'creatividad|low|quality': 'Artístico',
  'creatividad|low|balance': 'Expresivo',
  'creatividad|mid|price': 'Creativo',
  'creatividad|mid|quality': 'Detallista',
  'creatividad|mid|balance': 'Versátil',
  'creatividad|high|price': 'Diseñador',
  'creatividad|high|quality': 'Virtuoso',
  'creatividad|high|balance': 'Innovador',
  'creatividad|premium|price': 'Maestro',
  'creatividad|premium|quality': 'Visionario',
  'creatividad|premium|balance': 'Genial',

  'hogar|low|price': 'Conectado',
  'hogar|low|quality': 'Domótico',
  'hogar|low|balance': 'Práctico',
  'hogar|mid|price': 'Automatizado',
  'hogar|mid|quality': 'Inteligente',
  'hogar|mid|balance': 'Sincronizado',
  'hogar|high|price': 'Robusto',
  'hogar|high|quality': 'Integrado',
  'hogar|high|balance': 'Confortable',
  'hogar|premium|price': 'Futurista',
  'hogar|premium|quality': 'Autónomo',
  'hogar|premium|balance': 'Vanguardista',

  'movilidad|low|price': 'Portátil',
  'movilidad|low|quality': 'Nómada',
  'movilidad|low|balance': 'Urbano',
  'movilidad|mid|price': 'Viajero',
  'movilidad|mid|quality': 'Resistente',
  'movilidad|mid|balance': 'Ágil',
  'movilidad|high|price': 'Explorador',
  'movilidad|high|quality': 'Audaz',
  'movilidad|high|balance': 'Fluido',
  'movilidad|premium|price': 'Extremo',
  'movilidad|premium|quality': 'Libertario',
  'movilidad|premium|balance': 'Sofisticado',

  'fitness|low|price': 'Activo',
  'fitness|low|quality': 'Vital',
  'fitness|low|balance': 'Saludable',
  'fitness|mid|price': 'Energético',
  'fitness|mid|quality': 'Sólido',
  'fitness|mid|balance': 'Equilibrado',
  'fitness|high|price': 'Atleta',
  'fitness|high|quality': 'Rendimiento',
  'fitness|high|balance': 'Excelente',
  'fitness|premium|price': 'Olímpico',
  'fitness|premium|quality': 'Elite',
  'fitness|premium|balance': 'Insuperable',
};

/**
 * Color fijo por uso (6 usos → 6 colores): el mismo para cualquier
 * presupuesto/prioridad dentro de ese uso. Así el selector del mainNav, "Sin
 * perfil" y las tarjetas de "Tus perfiles de comprador" usan siempre el mismo
 * color para identificar un uso de un vistazo, con hasta 6 perfiles guardados.
 */
const BUYER_PROFILE_USAGE_COLORS: Record<string, { h: number; s: number; l: number }> = {
  productividad: { h: 215, s: 80, l: 58 }, // azul
  entretenimiento: { h: 280, s: 68, l: 62 }, // violeta
  creatividad: { h: 322, s: 75, l: 60 }, // magenta
  hogar: { h: 23, s: 82, l: 55 }, // naranja terracota
  movilidad: { h: 190, s: 68, l: 46 }, // cian/teal
  fitness: { h: 352, s: 75, l: 58 }, // coral
};
/** Color por defecto si el uso no está en la lista (no debería ocurrir con los 6 actuales). */
const BUYER_PROFILE_FALLBACK_COLOR = { h: 215, s: 80, l: 58 };

/**
 * Genera el nombre equivalente a la combinación de Perfil de Comprador
 * (uso + presupuesto + prioridad), tomado de la lista cerrada de
 * `perfilador.txt` (72 combinaciones). Si la combinación no está en la lista
 * (p. ej. un uso nuevo que todavía no se ha mapeado a uno de los 6 grupos),
 * cae a un nombre genérico "Uso · Prioridad · Presupuesto" como red de
 * seguridad para no dejar el perfil sin nombre.
 */
export function buyerProfileDisplayName(profile: Pick<BuyerProfile, 'usage' | 'budget' | 'priority'>): string {
  const key = `${profile.usage}|${profile.budget}|${profile.priority}`;
  const fixedName = BUYER_PROFILE_NAMES[key];
  if (fixedName) return fixedName;

  const usage = BUYER_PROFILE_USAGE_LABELS[profile.usage] ?? profile.usage;
  const budget = BUYER_PROFILE_BUDGET_LABELS[profile.budget] ?? profile.budget;
  const priorityShort: Record<string, string> = {
    price: 'Ahorro',
    quality: 'Calidad',
    balance: 'Equilibrio',
  };
  const pShort = priorityShort[profile.priority] ?? BUYER_PROFILE_PRIORITY_LABELS[profile.priority] ?? profile.priority;

  return `${usage} · ${pShort} · ${budget}`;
}

/**
 * Línea con las 3 opciones elegidas (uso · presupuesto · prioridad), con sus
 * etiquetas legibles. Ejemplo: "Creatividad · Hasta 100€ · Precio".
 */
export function buyerProfileGroupsLine(profile: Pick<BuyerProfile, 'usage' | 'budget' | 'priority'>): string {
  const usage = BUYER_PROFILE_USAGE_LABELS[profile.usage] ?? profile.usage;
  const budget = BUYER_PROFILE_BUDGET_LABELS[profile.budget] ?? profile.budget;
  const priority = BUYER_PROFILE_PRIORITY_LABELS[profile.priority] ?? profile.priority;
  return `${usage} · ${budget} · ${priority}`;
}

/**
 * Los subtítulos de las 3 opciones elegidas, por separado, para entender a
 * qué equivale cada una. Ejemplo: ["Diseño, edición, creación", "Calidad
 * esencial, gran valor", "Maximizar el ahorro y la oferta"].
 */
export function buyerProfileSubtitlesList(profile: Pick<BuyerProfile, 'usage' | 'budget' | 'priority'>): string[] {
  const usage = BUYER_PROFILE_USAGE_SUBTITLES[profile.usage] ?? '';
  const budget = BUYER_PROFILE_BUDGET_SUBTITLES[profile.budget] ?? '';
  const priority = BUYER_PROFILE_PRIORITY_SUBTITLES[profile.priority] ?? '';
  return [usage, budget, priority].filter(Boolean);
}

/**
 * Línea con los subtítulos de las 3 opciones elegidas, unidos en una sola
 * frase. Ejemplo: "Diseño, edición, creación · Calidad esencial, gran valor
 * · Maximizar el ahorro y la oferta".
 */
export function buyerProfileSubtitlesLine(profile: Pick<BuyerProfile, 'usage' | 'budget' | 'priority'>): string {
  return buyerProfileSubtitlesList(profile).join(' · ');
}

/**
 * Color fijo (HSL) del uso del perfil: 6 usos → 6 colores. Se usa en el badge
 * "Encaja con tu perfil", el selector del mainNav y "Tus perfiles de
 * comprador". No depende de presupuesto/prioridad (antes sí, por eso perfiles
 * ya guardados con un color distinto se "autocorrigen" en cuanto se vuelven a
 * pintar, sin necesitar migración de datos).
 */
export function buyerProfileColor(profile: Pick<BuyerProfile, 'usage' | 'budget' | 'priority'>): { h: number; s: number; l: number } {
  return BUYER_PROFILE_USAGE_COLORS[profile.usage] ?? BUYER_PROFILE_FALLBACK_COLOR;
}

/** Convierte {h,s,l} a una cadena CSS hsl(). */
export function hslString(c: { h: number; s: number; l: number }): string {
  return `hsl(${c.h}, ${c.s}%, ${c.l}%)`;
}

/**
 * ¿Encaja un producto con un perfil de comprador? Mismo criterio que usa el
 * badge "Encaja con tu perfil" del catálogo (precio dentro del rango de
 * presupuesto + una condición extra según la prioridad) y el filtro opcional
 * por perfil de `catalog-sort-bar` (`index.astro`). Recibe los datos ya
 * calculados que trae cada tarjeta (`data-pc-price/rating/score/discount` en
 * `ProductCard.astro`), no el producto completo: así sirve igual en el nav
 * (Layout.astro) y en la home, sin duplicar la comparación en dos sitios.
 */
export function matchesBuyerProfileCard(
  card: { price: number; rating?: number; score?: number; discount?: number },
  profile: Pick<BuyerProfile, 'budget' | 'priority'>,
): boolean {
  const range = BUYER_PROFILE_BUDGET_RANGES[profile.budget];
  if (!range || !Number.isFinite(card.price)) return false;
  if (card.price < range[0] || card.price > range[1]) return false;
  if (profile.priority === 'quality') return (card.rating ?? 0) >= 4 || (card.score ?? 0) >= 60;
  if (profile.priority === 'price') return (card.discount ?? 0) >= 10;
  return true;
}

/** Color de texto adecuado sobre un fondo HSL (blanco o negro según luminosidad). */
export function contrastTextColor(c: { h: number; s: number; l: number }): string {
  // Fórmula aproximada de luminancia percibida.
  const lum = (0.299 * c.h + 0.587 * c.s + 0.114 * c.l) / 100;
  return lum > 0.5 ? '#0b121e' : '#ffffff';
}

/** Valida un perfil de comprador recibido del cliente (nunca confiar en el payload). */
export function sanitizeBuyerProfile(input: BuyerProfile): BuyerProfile | null {
  const id = String(input?.id ?? '').trim().slice(0, 64);
  const name = String(input?.name ?? '').trim().slice(0, 60);
  if (!id || !name) return null;
  const usage = (BUYER_PROFILE_USAGE_LABELS[input?.usage] ? input.usage : 'productividad');
  const budget = (BUYER_PROFILE_BUDGET_LABELS[input?.budget] ? input.budget : 'mid');
  const priority = (BUYER_PROFILE_PRIORITY_LABELS[input?.priority] ? input.priority : 'balance');
  const now = new Date().toISOString();
  return {
    id,
    name,
    usage,
    budget,
    priority,
    createdAt: String(input?.createdAt || now).slice(0, 40),
    updatedAt: String(input?.updatedAt || now).slice(0, 40),
  };
}

/**
 * Colapsa una lista de perfiles de comprador a como máximo uno por `usage`
 * (gana el de `updatedAt`/`createdAt` más reciente) y la recorta a
 * `BUYER_PROFILE_MAX`. Se usa tras fusionar perfiles de varios dispositivos
 * (cliente y servidor): sin esto, guardar el mismo uso en dos dispositivos
 * sin conexión podría dejar dos perfiles para un único uso tras sincronizar.
 */
export function collapseBuyerProfilesByUsage(list: BuyerProfile[]): BuyerProfile[] {
  const stampOf = (p: BuyerProfile): number => {
    const ms = Date.parse(String(p.updatedAt || p.createdAt || ''));
    return Number.isFinite(ms) ? ms : 0;
  };
  const byUsage = new Map<string, BuyerProfile>();
  for (const profile of list) {
    if (!profile || typeof profile.usage !== 'string') continue;
    const current = byUsage.get(profile.usage);
    if (!current || stampOf(profile) >= stampOf(current)) {
      byUsage.set(profile.usage, profile);
    }
  }
  return [...byUsage.values()]
    .sort((a, b) => stampOf(b) - stampOf(a))
    .slice(0, BUYER_PROFILE_MAX);
}
