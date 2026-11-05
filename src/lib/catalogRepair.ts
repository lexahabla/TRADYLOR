/**
 * ==============================================================================
 * TRADYLOR — REPARACIÓN DE DATOS ANTIGUOS (simulación + reversión, funciones puras)
 * ==============================================================================
 * Detecta registros afectados por los defectos corregidos en el código y
 * propone parches. NADA se escribe aquí: `planRepairs` sólo describe;
 * `applyPlan` devuelve una COPIA reparada y `buildRollback` el parche inverso.
 *
 * Defectos detectados:
 *  - brand-is-merchant   : la «marca» es el nombre de la tienda.
 *  - fabricated-rating   : valoración/opiniones inventadas por valores por
 *                          defecto antiguos (eBay 4,5★/15; alta manual 4,8★/100).
 *  - duplicate-offer     : varias filas con el mismo id externo (sólo se INFORMA:
 *                          fusionar duplicados requiere decisión humana).
 *  - brand-spec-mismatch : la marca de la cabecera difiere de la «Marca» de las
 *                          especificaciones (sólo se INFORMA).
 * ==============================================================================
 */

import { brandIsMerchant, normalizeBrand, normalizeSourceId } from './offerIdentity';

type AnyRecord = Record<string, any>;

export type RepairKind = 'brand-is-merchant' | 'fabricated-rating' | 'duplicate-offer' | 'brand-spec-mismatch';

export interface RepairItem {
  id: string;
  kind: RepairKind;
  /** Campos a cambiar (valor nuevo; `null` = eliminar). Vacío si sólo se informa. */
  patch: Record<string, unknown>;
  detail: string;
}

export interface RepairPlan {
  items: RepairItem[];
  summary: Record<RepairKind, number>;
}

const SPEC_BRAND_KEYS = ['marca', 'brand', 'fabricante', 'manufacturer'];

function specBrand(product: AnyRecord): string {
  const specs = (product.specs ?? {}) as AnyRecord;
  for (const [name, value] of Object.entries(specs)) {
    if (SPEC_BRAND_KEYS.includes(name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim())) {
      return String(value ?? '');
    }
  }
  return '';
}

export function planRepairs(products: AnyRecord[]): RepairPlan {
  const items: RepairItem[] = [];

  for (const product of products) {
    const id = String(product.id);
    const locked = new Set<string>(Array.isArray(product.extra?.lockedFields) ? product.extra.lockedFields : []);

    if (product.brand && brandIsMerchant(product.brand, product.merchant) && !locked.has('brand')) {
      items.push({ id, kind: 'brand-is-merchant', patch: { brand: null }, detail: `marca «${product.brand}» = tienda «${product.merchant}»` });
    }

    const network = String(product.network ?? '').toLowerCase();
    const rating = Number(product.rating);
    const reviews = Number(product.reviewsCount);
    const ebayDefault = network === 'ebay' && rating === 4.5 && reviews === 15;
    const manualDefault = rating === 4.8 && reviews === 100 && !product.extra?.scraperApiSource && network !== 'amazon';
    if ((ebayDefault || manualDefault) && !locked.has('rating')) {
      items.push({
        id,
        kind: 'fabricated-rating',
        patch: { rating: null, reviewsCount: null },
        detail: `${rating}★ / ${reviews} opiniones coinciden con un valor por defecto antiguo`,
      });
    }

    const header = normalizeBrand(product.brand);
    const fromSpecs = normalizeBrand(specBrand(product));
    if (header.key && fromSpecs.key && header.key !== fromSpecs.key) {
      items.push({
        id,
        kind: 'brand-spec-mismatch',
        patch: {},
        detail: `cabecera «${product.brand}» ≠ especificaciones «${specBrand(product)}»`,
      });
    }
  }

  // Duplicados por id externo normalizado (misma red).
  const groups = new Map<string, string[]>();
  for (const product of products) {
    const sid = normalizeSourceId(product.sourceId || product.asin);
    if (!sid) continue;
    const key = `${String(product.network ?? '').toLowerCase()}:${sid}`;
    groups.set(key, [...(groups.get(key) ?? []), String(product.id)]);
  }
  for (const [key, ids] of groups) {
    if (ids.length < 2) continue;
    for (const id of ids) items.push({ id, kind: 'duplicate-offer', patch: {}, detail: `mismo anuncio ${key} en ${ids.join(', ')}` });
  }

  const summary: Record<RepairKind, number> = { 'brand-is-merchant': 0, 'fabricated-rating': 0, 'duplicate-offer': 0, 'brand-spec-mismatch': 0 };
  for (const item of items) summary[item.kind]++;
  return { items, summary };
}

export interface RollbackEntry {
  id: string;
  /** Valor ANTERIOR de cada campo tocado (`__absent__` = no existía). */
  before: Record<string, unknown>;
}

export const ABSENT = '__absent__';

/** Devuelve una COPIA con los parches aplicados y el parche inverso. */
export function applyPlan(products: AnyRecord[], plan: RepairPlan): { products: AnyRecord[]; rollback: RollbackEntry[] } {
  const rollback = new Map<string, RollbackEntry>();
  const out = products.map((product) => {
    const patches = plan.items.filter((item) => item.id === String(product.id) && Object.keys(item.patch).length);
    if (!patches.length) return product;
    const next: AnyRecord = { ...product };
    const entry: RollbackEntry = { id: String(product.id), before: {} };
    for (const { patch } of patches) {
      for (const [field, value] of Object.entries(patch)) {
        if (!(field in entry.before)) entry.before[field] = field in product ? product[field] : ABSENT;
        if (value === null) delete next[field];
        else next[field] = value;
      }
    }
    rollback.set(entry.id, entry);
    return next;
  });
  return { products: out, rollback: [...rollback.values()] };
}

export function applyRollback(products: AnyRecord[], rollback: RollbackEntry[]): AnyRecord[] {
  const byId = new Map(rollback.map((entry) => [entry.id, entry]));
  return products.map((product) => {
    const entry = byId.get(String(product.id));
    if (!entry) return product;
    const next: AnyRecord = { ...product };
    for (const [field, before] of Object.entries(entry.before)) {
      if (before === ABSENT) delete next[field];
      else next[field] = before;
    }
    return next;
  });
}
