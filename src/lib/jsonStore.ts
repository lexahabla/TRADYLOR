/**
 * ==============================================================================
 * TRADYLOR - LECTURA / ESCRITURA SEGURA DE FICHEROS JSON
 * ==============================================================================
 * Centraliza los dos fallos que ya han_costado catálogo en producción:
 *
 *   1. **Escritura no atómica**: `fs.writeFileSync` trunca el fichero y luego
 *      escribe. Si el proceso se cae (o el contenedor se reinicia) a mitad de
 *      escritura, `products.json` queda con el JSON truncado.
 *   2. **Lectura intolerante**: al leer un JSON truncado, `JSON.parse` lanza y
 *      el código devolvía `[]`. Con un `[]` por delante, el siguiente `upsert`
 *      **reescribía el catálogo entero con un solo producto** (pérdida de
 *      datos: el catálogo pasó de 254 a 25 fichas en el reproceso de producción
 *      del 22/10/2026).
 *
 * Ahora la escritura es atómica (fichero temporal + `rename`, igual que ya
 * hacían `pipeline/metrics.ts`, `build-catalog.ts`, `radarStore.ts` o
 * `userStore.ts`) y la lectura reintenta y, como último recurso, devuelve la
 * última versión válida leída en memoria en vez de un `[]` vacío.
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';

/** Última versión válida leída por fichero (evita devolver `[]` por un JSON roto). */
const lastGood = new Map<string, unknown[]>();

/**
 * Lee un array JSON de forma tolerante:
 * - reintenta hasta 3 veces (por si el fichero se está reescribiendo),
 * - si el JSON no es válido, devuelve la última versión válida conocida,
 * - si el fichero no existe, devuelve `[]` (no se resucita nada).
 */
export function readJsonArrayFile<T = unknown>(filePath: string): T[] {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!fs.existsSync(filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (Array.isArray(parsed)) {
        lastGood.set(filePath, [...parsed]);
        return parsed as T[];
      }
      return [];
    } catch (error) {
      if (attempt === 2) {
        console.error(`[JsonStore] No se pudo leer ${filePath}:`, error);
      }
    }
  }

  const cached = lastGood.get(filePath);
  return cached ? ([...cached] as T[]) : [];
}

/**
 * Escribe un array JSON de forma atómica (fichero temporal + `rename`).
 * Devuelve `false` si no se pudo escribir (el fichero original queda intacto).
 */
export function writeJsonArrayFile<T = unknown>(filePath: string, data: T[]): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpFile = `${filePath}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpFile, filePath);
    lastGood.set(filePath, [...data]);
    return true;
  } catch (error) {
    console.error(`[JsonStore] Error al guardar ${filePath}:`, error);
    return false;
  }
}
