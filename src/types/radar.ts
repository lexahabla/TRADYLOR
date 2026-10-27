/**
 * ==============================================================================
 * TRADYLOR — TIPOS "MI RADAR" (compartidos cliente/servidor)
 * ==============================================================================
 * Sin imports de Node: este módulo se importa desde scripts de navegador
 * (utils/radarStore.ts, utils/auth.ts) y desde el backend (lib/radarAuth.ts,
 * lib/radarStore.ts). Sólo tipos y constantes ligeras.
 * ==============================================================================
 */

/** Preferencias del usuario para las recomendaciones de productos. */
export interface UserPreferences {
  /** Slugs de las categorías que más le interesan (categories.json). */
  categories: string[];
}

/** Perfil del usuario final (cuenta pública; no confundir con el backend admin). */
export interface UserProfile {
  id: string;
  email: string;
  name?: string;
  provider: 'email' | 'google';
  createdAt: string;
  /** Nombre del fichero de avatar en el servidor (opcional). */
  avatar?: string | null;
  /** Timestamp para cache-busting del avatar. */
  updatedAt?: string;
  /** Categorías de interés elegidas en "Mis preferencias" (para recomendar productos). */
  preferences?: UserPreferences;
  /** Email nuevo pendiente de confirmar por enlace (mientras tanto sigue valiendo el actual). */
  pendingEmail?: string;
}

/** Producto guardado en Mi Radar. */
export interface SavedProduct {
  /** id o slug del producto (estable entre sesiones). */
  id: string;
  title: string;
  /** Precio ya formateado para mostrar, p. ej. "25,99 €". */
  price: string;
  /** Precio numérico en euros para el sumatorio de la lista (opcional). */
  priceValue?: number;
  image: string;
  /** Enlace para retomar la compra (salida de afiliado o ficha del producto). */
  buyUrl: string;
  store: 'amazon' | 'aliexpress';
  /** ISO date. */
  dateAdded: string;
  userNote?: string;
  /**
   * ISO date de la última vez que se movió a otra lista (arrastrar o "Mover a…").
   * Con `dateAdded` decide, al sincronizar varios dispositivos, en qué lista queda
   * el producto: gana el cambio más reciente.
   */
  movedAt?: string;
  /** Precio registrado al guardar (base de comparación de las alertas de bajada). */
  initialPrice?: number;
  /** Precio objetivo: se avisa por email cuando el precio actual llega o baja de él. */
  targetPrice?: number;
  /** Aviso de bajada de precio activo (por defecto true si hay targetPrice). */
  notifyPriceDrop?: boolean;
  /** Aviso de vuelta a stock activo (sólo productos con estado de stock conocido). */
  notifyStock?: boolean;
  /**
   * Estado de la alerta de precio del worker: 'triggered' es definitivo (un solo
   * email por producto); `lastPrice` es el último precio observado.
   */
  priceAlert?: {
    status: 'armed' | 'triggered';
    triggeredAt?: string;
    lastPrice?: number;
    lastCheckedAt?: string;
    /** Último estado de stock observado por el worker (para avisar de "vuelta a stock"). */
    lastInStock?: boolean;
  };
}

/** Carpeta/lista de proyectos con sus productos. */
export interface ProjectFolder {
  id: string;
  name: string;
  description?: string;
  products: SavedProduct[];
}

/** Registro del "Return Flow": clic en un CTA de salida directa. */
export interface PendingExit {
  productId: string;
  title: string;
  /** Date.now() del clic. */
  timestamp: number;
  status: 'pending' | 'purchased' | 'dismissed';
}

/**
 * Aviso / recordatorio de compra creado por el usuario sobre un producto de su
 * radar. Se envía por correo en la fecha y hora elegidas (dispatcher en el SSR).
 */
export interface Reminder {
  id: string;
  /** id/slug del producto guardado en el radar. */
  productId: string;
  /** Copia del título en el momento de crear el aviso (como PendingExit). */
  title: string;
  /** Epoch ms de la fecha y hora elegidas por el usuario. */
  remindAt: number;
  /** Motivo predefinido (verbatim de REMINDER_REASONS). */
  reason: string;
  /** Texto libre opcional del usuario ("espero la nómina del día 15"...). */
  reasonNote?: string;
  status: 'scheduled' | 'sending' | 'sent' | 'cancelled';
  createdAt: number;
  sentAt?: number;
  attempts?: number;
  lastError?: string;
}

/** Estado de un aviso para pintar la UI del botón 🔔. */
export type ReminderStatus = Reminder['status'];

/** Motivos que el usuario elige al crear un aviso (se incluyen en el correo). */
export const REMINDER_REASONS: readonly string[] = [
  'Esperando fondos / cobro',
  'Esperando oferta o descuento',
  'Falta de stock',
  'Regalo o fecha especial',
  'Comparando con otro producto',
  'Otro',
] as const;

/** Máximo de avisos por producto y por usuario (límite de abuso de SMTP). */
export const REMINDER_MAX_PER_PRODUCT = 1;
export const REMINDER_MAX_PER_USER = 20;
/** Horizonte máximo de programación: 1 año. */
export const REMINDER_MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

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

/** Comparativa guardada desde el Comparador (Centro de Herramientas). */
export interface ComparatorHistoryEntry {
  id: string;
  createdAt: string;
  categorySlug?: string;
  categoryName?: string;
  /** Perfil Smart Match aplicado en el momento de guardar (si lo hubiera). */
  smartMatchProfile?: string;
  productIds: string[];
}

/** Un turno de la conversación con el Dependiente IA. */
export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

/** Conversación guardada con el Dependiente IA (Centro de Herramientas). */
export interface AiChatEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Título corto autogenerado (primeras palabras del primer mensaje). */
  title: string;
  messages: AiChatMessage[];
}

/** Estado completo de Mi Radar de un usuario (anónimo o en la nube). */
export interface RadarData {
  projects: ProjectFolder[];
  pendingExits: PendingExit[];
  /** Avisos/recordatorios (opcional para no romper clientes antiguos). */
  reminders?: Reminder[];
  /**
   * Bajas de productos: id → epoch ms. La sincronización fusiona por unión y nunca
   * borraba nada, así que sin esto un producto quitado volvía a aparecer. Un
   * producto sólo se descarta si la baja es igual o posterior a su último cambio.
   */
  removedProducts?: Record<string, number>;
  /** Bajas de listas: id → epoch ms (los ids de lista son únicos, no se reutilizan). */
  removedProjects?: Record<string, number>;
  /**
   * Bajas de registros de herramientas (perfiles de comprador, comparativas
   * guardadas y chats del Dependiente IA): id → epoch ms. La fusión de esas
   * listas es por unión, así que sin esta marca un registro borrado en un
   * dispositivo volvía en el siguiente sync.
   */
  removedToolRecords?: Record<string, number>;
  /** Perfiles de comprador guardados (opcional; requiere sesión para crearse). */
  buyerProfiles?: BuyerProfile[];
  /** id del perfil marcado como activo en el selector del mainNav (o vacío). */
  activeBuyerProfileId?: string;
  /** Comparativas guardadas desde el Centro de Herramientas. */
  comparatorHistory?: ComparatorHistoryEntry[];
  /** Conversaciones guardadas con el Dependiente IA. */
  aiChats?: AiChatEntry[];
}

/** Respuesta de /api/radar/auth/session. */
export interface SessionResponse {
  authenticated: boolean;
  user: UserProfile | null;
  /** true si GOOGLE_CLIENT_ID está configurado en el servidor. */
  googleEnabled: boolean;
}

/** Carpeta por defecto creada al registrarse o al primer guardado anónimo. */
export const DEFAULT_PROJECT: Pick<ProjectFolder, 'id' | 'name' | 'description'> = {
  id: 'general',
  name: 'General',
  description: 'Tus productos guardados sin organizar.',
};

/** Clave de LocalStorage (Offline-First). */
export const RADAR_STORAGE_KEY = 'tradylor-radar-v1';

/** Umbral del Return Flow en /mi-radar: se pregunta a partir de 24h. */
export const RETURN_FLOW_MIN_AGE_MS = 24 * 60 * 60 * 1000;

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
