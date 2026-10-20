/**
 * ==============================================================================
 * TRADYLOR - FECHA DE ALTA («firstSeenAt») EN LA CACHÉ DEL CATÁLOGO ALIEXPRESS
 * ==============================================================================
 * Lógica PURA (sin red ni disco) que `syncAliCatalog` aplica al mezclar los
 * productos frescos de la API con la caché guardada. Vive aparte de
 * `aliexpressCatalog.ts` para poder probarla sin conectores ni volumen.
 *
 * POR QUÉ HACE FALTA
 * ------------------
 * En el sync, cada producto devuelto por la API REEMPLAZA al objeto cacheado
 * (`mergedById.set(...)`), así que cualquier campo que sólo exista en la caché
 * se perdería en cada sincronización. `firstSeenAt` (cuándo apareció el producto
 * por primera vez) tiene que arrastrarse de forma explícita.
 *
 * REGLAS
 * ------
 *  - Producto nuevo en esta sincronización            → `now`.
 *  - Ya estaba en la caché CON fecha válida           → se conserva.
 *  - Ya estaba en la caché SIN fecha (caché anterior
 *    a este campo, o fecha ilegible)                  → fecha de la sincronización
 *    previa: es la cota más ajustada que se conoce (sabíamos que ya estaba entonces,
 *    no cuándo entró). Sin sincronización previa válida → `now`.
 *
 * Con la primera sincronización tras desplegar este cambio, la caché antigua queda
 * toda con la fecha del sync previo y lo nuevo con la de ahora: ordenar por
 * «Fecha de alta» pone arriba las novedades reales.
 * ==============================================================================
 */

/** Devuelve la cadena si es una fecha ISO interpretable; si no, `undefined`. */
export function validIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

/**
 * Estampa `firstSeenAt` en cada producto del catálogo ya mezclado.
 * No muta los objetos de entrada: devuelve copias.
 *
 * @param merged           productos resultantes de la mezcla (API fresca + caché)
 * @param existing         productos que había en la caché antes de sincronizar
 * @param previousSyncedAt `syncedAt` del snapshot anterior (puede faltar)
 * @param now              instante de ESTA sincronización (el mismo que irá en `syncedAt`)
 */
export function stampFirstSeen<T extends { externalId: string; firstSeenAt?: string }>(
  merged: T[],
  existing: T[],
  previousSyncedAt: string | null | undefined,
  now: string,
): T[] {
  const known = new Map<string, string | undefined>();
  for (const product of existing) known.set(product.externalId, validIsoDate(product.firstSeenAt));
  const legacyDate = validIsoDate(previousSyncedAt) ?? now;

  return merged.map((product) => {
    if (!known.has(product.externalId)) return { ...product, firstSeenAt: now };
    return { ...product, firstSeenAt: known.get(product.externalId) ?? legacyDate };
  });
}
