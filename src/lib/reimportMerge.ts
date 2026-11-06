/**
 * ==============================================================================
 * TREIDILOR — FUSIÓN SEGURA EN REIMPORTACIÓN (funciones puras)
 * ==============================================================================
 * Al reimportar un producto que ya existe (API, URL o JSON) NO se sustituye el
 * registro: se fusiona con precedencia por campo.
 *
 *  1. Campos BLOQUEADOS (`extra.lockedFields`: edición manual o texto
 *     enriquecido revisado) → se conserva el valor existente.
 *  2. Campos de CURACIÓN/IDENTIDAD LOCAL (slug, variantes, categoría, histórico,
 *     alternativas, auditoría...) → se conservan siempre.
 *  3. Hechos del PROVEEDOR vigentes (precio, moneda, stock, imágenes, valoración)
 *     → gana lo recién importado.
 *  4. La marca nunca se degrada: si lo importado está vacío o es el nombre de la
 *     tienda, se conserva la marca existente.
 *
 * `extra` se fusiona: lo existente se conserva y lo importado lo actualiza,
 * salvo las claves de seguimiento (observaciones, señal, refresco), que sólo
 * escribe el servicio de actualización.
 * ==============================================================================
 */

import { brandIsMerchant, normalizeBrand } from './offerIdentity';

type AnyRecord = Record<string, unknown>;

/** Campos que la reimportación nunca debe perder aunque el JSON/API no los traiga. */
export const PRESERVED_FIELDS = [
  'slug',
  'sourceId',
  'category',
  'category_id',
  'subcategory_id',
  'ia_status',
  'link_status',
  'normalized_tags',
  'alternative_product_ids',
  'alternatives',
  'conversion_score',
  'audit_status',
  'audit_score',
  'audit_reasons',
  'pipeline_version',
  'pipeline_run_at',
  'ai_enriched',
  'ai_error',
  'sourceDescription',
  'priceHistory',
  'variantGroup',
  'variantFeature',
  'title_short',
  'lastPriceSync',
] as const;

/** Campos que, si el importado no los trae, se rellenan con los existentes. */
export const FILL_IF_MISSING_FIELDS = [
  'shippingInfo',
  'shippingDays',
  'freeShipping',
  'condition',
  'commissionRate',
  'commissionEstimate',
  'sales30d',
  'visits',
  'fulfillmentProvider',
  'techSheet',
  'verdict',
] as const;

/** Claves de `extra` que sólo gestiona el servicio de actualización. */
export const TRACKING_EXTRA_KEYS = ['observations', 'priceSignal', 'refresh', 'reviewQueue'] as const;

export function readLockedFields(product: AnyRecord | null | undefined): string[] {
  const extra = (product?.extra ?? {}) as AnyRecord;
  const locked = extra.lockedFields;
  return Array.isArray(locked) ? locked.map(String) : [];
}

/** Añade campos a `extra.lockedFields` (edición manual o texto revisado). */
export function lockFields<T extends AnyRecord>(product: T, fields: string[]): T {
  const extra = { ...((product.extra ?? {}) as AnyRecord) };
  const current = new Set(readLockedFields(product));
  fields.forEach((field) => current.add(field));
  extra.lockedFields = [...current].sort();
  return { ...product, extra };
}

/** Campos editables cuyo cambio manual debe bloquearse frente a reimportaciones. */
export const EDITORIAL_FIELDS = [
  'title',
  'description',
  'pros',
  'cons',
  'verdict',
  'techSheet',
  'brand',
  'category',
  'badge',
  'specs',
] as const;

/** Campos editoriales que difieren entre el producto anterior y el editado. */
export function diffEditorialFields(before: AnyRecord, after: AnyRecord): string[] {
  return EDITORIAL_FIELDS.filter(
    (field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null),
  ) as string[];
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

export function mergeReimport<T extends AnyRecord>(existing: T | null | undefined, incoming: T): T {
  if (!existing) return incoming;
  const merged: AnyRecord = { ...incoming };
  const old = existing as AnyRecord;

  // 2) Curación/identidad local: siempre gana lo existente si está definido.
  for (const field of PRESERVED_FIELDS) {
    if (old[field] !== undefined) merged[field] = old[field];
  }

  // Relleno de lo que el importado no trae.
  for (const field of FILL_IF_MISSING_FIELDS) {
    if (isEmpty(merged[field]) && !isEmpty(old[field])) merged[field] = old[field];
  }

  // 4) La marca no se degrada.
  const incomingBrand = String(merged.brand ?? '');
  const merchant = String(merged.merchant ?? old.merchant ?? '');
  if (!normalizeBrand(incomingBrand).key || brandIsMerchant(incomingBrand, merchant)) {
    if (!isEmpty(old.brand) && !brandIsMerchant(String(old.brand), merchant)) merged.brand = old.brand;
    else if (brandIsMerchant(incomingBrand, merchant)) merged.brand = undefined;
  }

  // 1) Campos bloqueados por edición manual o revisión.
  const locked = readLockedFields(old);
  for (const field of locked) {
    if (old[field] !== undefined) merged[field] = old[field];
  }

  // extra: lo existente se conserva; lo importado actualiza; el seguimiento es del servicio.
  const oldExtra = (old.extra ?? {}) as AnyRecord;
  const newExtra = (incoming.extra ?? {}) as AnyRecord;
  const extra: AnyRecord = { ...oldExtra, ...newExtra };
  for (const key of TRACKING_EXTRA_KEYS) {
    if (oldExtra[key] !== undefined) extra[key] = oldExtra[key];
  }
  if (locked.length) extra.lockedFields = locked;
  if (Object.keys(extra).length) merged.extra = extra;

  return merged as T;
}
