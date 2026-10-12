/**
 * ==============================================================================
 * TRADYLOR — TIPOS "MI RADAR" (compartidos cliente/servidor)
 * ==============================================================================
 * Sin imports de Node: este módulo se importa desde scripts de navegador
 * (utils/radarStore.ts, utils/auth.ts) y desde el backend (lib/radarAuth.ts,
 * lib/radarStore.ts). Sólo tipos y constantes ligeras.
 * ==============================================================================
 */

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

/** Estado completo de Mi Radar de un usuario (anónimo o en la nube). */
export interface RadarData {
  projects: ProjectFolder[];
  pendingExits: PendingExit[];
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
