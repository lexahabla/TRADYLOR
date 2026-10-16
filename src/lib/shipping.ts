/**
 * ==============================================================================
 * TRADYLOR — RESOLUCIÓN DE DATOS DE ENVÍO
 * ==============================================================================
 * Los campos shippingDays/shippingInfo/freeShipping se guardan en products.json
 * al importar desde el panel, pero los productos importados antes de existir
 * esos campos no los tienen. Este mítodo los resuelve igualmente consultando la
 * caché del catálogo AliExpress (aliexpress-catalog.json) por enlace de
 * afiliado/URL del producto, para que ficha y checkout muestren datos reales
 * sin reimportar nada.
 *
 * - resolveProductShipping(product) → { shippingDays?, shippingInfo?, freeShipping? }
 * - Los campos ya presentes en el producto tienen prioridad.
 * - El índice del snapshot se memoriza y se invalida por mtime del fichero.
 * ==============================================================================
 */

import fs from 'node:fs';
import { dataFile } from './paths';
import type { Product } from '../data/products';

export interface ResolvedShipping {
  shippingDays?: number;
  shippingInfo?: string;
  freeShipping?: boolean;
}

const CATALOG_FILE = dataFile('aliexpress-catalog.json');
/** Días ≤ 3 se consideran envío rápido/gratis (mismo criterio que el importador). */
const FREE_SHIPPING_MAX_DAYS = 3;

interface SnapshotEntry {
  productUrl?: string;
  extra?: Record<string, string | number | boolean | null>;
  shippingInfo?: string;
}

interface ShippingIndex {
  mtimeMs: number;
  /** URL normalizada → entrada del snapshot. */
  byUrl: Map<string, SnapshotEntry>;
}

let indexCache: ShippingIndex | null = null;

/** Normaliza una URL para comparar: minúsculas, sin fragmento ni barra final. */
function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/#.*$/, '').replace(/\/+$/, '');
}
/** Clave sin query (fallback cuando el producto guarda la URL con tracking distinto). */
function pathKey(url: string): string {
  try {
    const u = new URL(normalizeUrl(url));
    return `${u.host}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return normalizeUrl(url).split('?')[0];
  }
}

function indexUrls(map: Map<string, SnapshotEntry>, urls: Array<string | null | undefined>, entry: SnapshotEntry): void {
  for (const raw of urls) {
    if (!raw) continue;
    const url = String(raw).trim();
    if (!url) continue;
    const key = normalizeUrl(url);
    if (key && !map.has(key)) map.set(key, entry);
    const pKey = pathKey(url);
    if (pKey && !map.has(pKey)) map.set(pKey, entry);
  }
}

function loadIndex(): ShippingIndex | null {
  try {
    if (!fs.existsSync(CATALOG_FILE)) return null;
    const mtimeMs = fs.statSync(CATALOG_FILE).mtimeMs;
    if (indexCache && indexCache.mtimeMs === mtimeMs) return indexCache;

    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8')) as { products?: SnapshotEntry[] };
    if (!parsed || !Array.isArray(parsed.products)) return null;

    const byUrl = new Map<string, SnapshotEntry>();

    for (const entry of parsed.products) {
      if (!entry) continue;
      const extra = entry.extra ?? {};
      indexUrls(byUrl, [
        entry.productUrl,
        extra['Enlace de afiliado'] as string | undefined,
        extra['URL del producto'] as string | undefined,
      ], entry);
    }

    indexCache = { mtimeMs, byUrl };
    return indexCache;
  } catch {
    return null;
  }
}

/** Extrae un entero de días de cadenas tipo "15", "15-30", "15 días". */
function parseDays(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const num = Number(value);
  if (Number.isFinite(num)) return Math.max(0, Math.round(num));
  const match = String(value).match(/(\d+)/);
  if (match) return Math.max(0, Number(match[1]));
  return undefined;
}

function findSnapshotEntry(product: Product): SnapshotEntry | null {
  const index = loadIndex();
  if (!index) return null;

  const candidates = [product.affiliateUrl, product.buyNowUrl].filter(Boolean) as string[];
  for (const url of candidates) {
    const hit = index.byUrl.get(normalizeUrl(url)) ?? index.byUrl.get(pathKey(url));
    if (hit) return hit;
  }
  return null;
}

/**
 * Datos de envío efectivos de un producto: campos propios si existen;
 * si no, los del snapshot del catálogo AliExpress (match por enlace/URL).
 */
export function resolveProductShipping(product: Product): ResolvedShipping {
  const own: ResolvedShipping = {};
  if (product.shippingDays != null) own.shippingDays = product.shippingDays;
  if (product.shippingInfo) own.shippingInfo = product.shippingInfo;
  if (product.freeShipping != null) own.freeShipping = product.freeShipping;
  if (own.shippingDays != null && own.shippingInfo && own.freeShipping != null) return own;

  const entry = findSnapshotEntry(product);
  if (!entry) return own;

  const extra = entry.extra ?? {};
  const days = own.shippingDays ?? parseDays(extra['Días de envío']);
  const info = own.shippingInfo ?? (entry.shippingInfo || (days != null ? `Envío en ${days} días` : undefined));
  const free = own.freeShipping ?? (days != null ? days <= FREE_SHIPPING_MAX_DAYS : undefined);

  const resolved: ResolvedShipping = {};
  if (days != null) resolved.shippingDays = days;
  if (info) resolved.shippingInfo = info;
  if (free != null) resolved.freeShipping = free;
  return resolved;
}
