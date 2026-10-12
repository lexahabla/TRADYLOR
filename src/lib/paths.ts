import path from 'node:path';

/**
 * ==============================================================================
 * TRADYLOR - RUTAS DE FICHEROS PERSISTENTES
 * ==============================================================================
 * Único punto de verdad para localizar los JSON del catálogo y las imágenes
 * generadas. En local mantiene el comportamiento histórico (src/data y
 * public/images/products); en producción (Docker / Easy Panel) se redirigen
 * a un volumen persistente mediante variables de entorno:
 *
 *   TRADYLOR_DATA_DIR     -> productos, categorías, analítica y credenciales
 *   TRADYLOR_IMAGES_DIR   -> imágenes PNG generadas con IA
 * ==============================================================================
 */

const cwd = process.cwd();

/** Directorio con los JSON persistentes (products/categories/analytics/credentials). */
export const DATA_DIR =
  process.env.TRADYLOR_DATA_DIR?.trim() || path.join(cwd, 'src', 'data');

/** Directorio durable de imágenes generadas (fuente persistente). */
export const IMAGES_DIR =
  process.env.TRADYLOR_IMAGES_DIR?.trim() || path.join(cwd, 'public', 'images', 'products');

/** Directorio servible por el standalone de Node (build actual). */
export const CLIENT_IMAGES_DIR = path.join(cwd, 'dist', 'client', 'images', 'products');

/** Directorio de avatares de los usuarios del backend (perfil). */
export const AVATARS_DIR = path.join(DATA_DIR, 'avatars');

/** Directorio de avatares de los usuarios finales de Mi Radar. */
export const RADAR_AVATARS_DIR = path.join(DATA_DIR, 'radar-avatars');

/** Ruta absoluta de un JSON dentro del directorio de datos. */
export function dataFile(name: string): string {
  return path.join(DATA_DIR, name);
}
