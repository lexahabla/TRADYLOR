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
