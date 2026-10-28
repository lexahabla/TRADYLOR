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
/** Máximo de perfiles de comprador guardados por usuario. */
export const BUYER_PROFILE_MAX = 8;

/**
 * Genera un nombre corto y descriptivo para una combinación de Perfil de Comprador.
 * Ejemplo: "Productividad · Equilibrio · Contenido" o "Movilidad · Premium · Rendimiento".
 * Se usa cuando el usuario guarda un perfil: ya no pone nombre a mano, se asigna
 * automáticamente a partir de uso + presupuesto + prioridad.
 */
export function buyerProfileDisplayName(profile: Pick<BuyerProfile, 'usage' | 'budget' | 'priority'>): string {
  const usage = BUYER_PROFILE_USAGE_LABELS[profile.usage] ?? profile.usage;
  const budget = BUYER_PROFILE_BUDGET_LABELS[profile.budget] ?? profile.budget;
  const priority = BUYER_PROFILE_PRIORITY_LABELS[profile.priority] ?? profile.priority;

  // Subtítulo corto según la prioridad, para diferenciar perfiles del mismo uso/presupuesto.
  const priorityShort: Record<string, string> = {
    price: 'Ahorro',
    quality: 'Calidad',
    balance: 'Equilibrio',
  };
  const pShort = priorityShort[profile.priority] ?? profile.priority;

  return `${usage} · ${pShort} · ${budget}`;
}

/**
 * Genera un color determinístico (HSL) para una combinación de perfil, para
 * usar en el badge "Encaja con tu perfil" y en el selector del mainNav.
 * Cada combinación (uso + presupuesto + prioridad) obtiene un color distinto
 * y estable entre sesiones.
 */
export function buyerProfileColor(profile: Pick<BuyerProfile, 'usage' | 'budget' | 'priority'>): { h: number; s: number; l: number } {
  const str = `${profile.usage}|${profile.budget}|${profile.priority}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  const h = Math.abs(hash) % 360;
  // Saturación y luminosidad en rango agradable para badges (no demasiado oscuro ni claro).
  const s = 55 + (Math.abs(hash) % 25); // 55–80 %
  const l = 50 + (Math.abs(hash) % 15); // 50–65 %
  return { h, s, l };
}

/** Convierte {h,s,l} a una cadena CSS hsl(). */
export function hslString(c: { h: number; s: number; l: number }): string {
  return `hsl(${c.h}, ${c.s}%, ${c.l}%)`;
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
