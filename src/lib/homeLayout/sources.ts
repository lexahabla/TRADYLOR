/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · FUENTES DE DATOS (etapa 2, ESTRICTAMENTE DE SOLO LECTURA)
 * ==============================================================================
 * Construye una instantánea de lo que existe hoy (catálogo, categorías, comercios y secciones) para que `resolve.ts` compruebe referencias
 * por identificador. Nada se copia a `home-layout.json` y nada se escribe.
 *
 * Garantías de solo lectura:
 *  · Catálogo: `getCatalogProducts()` (lectura tolerante + caché por mtime; no escribe) y `readDeletedIds()` (lectura).
 *  · Categorías: NO se usa `getCategories()` ni `ensureCategoriesFile()`, porque pueden REESCRIBIR `categories.json` (si falta o es de esquema
 *    legado). Se lee el archivo directamente; si falta o no es utilizable se usan en memoria las categorías semilla, igual que la web pública.
 *  · Secciones: NO se usa `sections.ts`; se lee `sections.json` directamente y se informa de su estado (missing | ok | corrupt).
 * ==============================================================================
 */

import fs from 'node:fs';
import { dataFile } from '../paths';
import { getCatalogProducts } from '../catalog';
import { readDeletedIds } from '../deletedProducts';
import { detectNetworkId } from '../productNetwork';
import { DEFAULT_CATEGORIES, normalizeKey, slugifyCategory } from '../categories';

export interface ProductInfo {
  id: string;
  title: string;
  /** null = sin precio utilizable. */
  price: number | null;
  hasImage: boolean;
  /** null = el catálogo no dispone de un dato fiable. */
  inStock: boolean | null;
  network: string;
  category: string;
  linkStatus: string;
}

export interface CategoryInfo {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

export interface SectionInfo {
  id: string;
  title: string;
  published: boolean;
  order: number;
  position: 'above' | 'below';
  speed: 'slow' | 'normal' | 'fast' | 'none';
  productIds: string[];
}

export type SourceStatus = 'ok' | 'missing' | 'corrupt' | 'error';

export interface ReferenceSources {
  products: Map<string, ProductInfo>;
  /** ids de productos eliminados desde el admin (tombstones). */
  retiredIds: Set<string>;
  categories: Map<string, CategoryInfo>;
  /** Comercio/plataforma → nº de productos. */
  networks: Map<string, number>;
  sections: Map<string, SectionInfo>;
  /** Orden original de `sections.json`. */
  sectionList: SectionInfo[];
  status: {
    products: { status: SourceStatus; count: number };
    categories: { status: SourceStatus; count: number; origin: 'file' | 'defaults' };
    sections: { status: SourceStatus; count: number; invalidEntries: number };
  };
}

/** Plataformas conocidas aunque hoy no tengan productos. */
export const KNOWN_NETWORKS = ['amazon', 'aliexpress', 'ebay', 'temu'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function priceOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* ───────── Productos ───────── */
function readProducts(): { map: Map<string, ProductInfo>; retired: Set<string>; networks: Map<string, number>; status: SourceStatus } {
  const map = new Map<string, ProductInfo>();
  const networks = new Map<string, number>();
  let retired = new Set<string>();
  let status: SourceStatus = 'ok';
  try {
    for (const p of getCatalogProducts() as unknown as Array<Record<string, unknown>>) {
      const id = typeof p.id === 'string' ? p.id : '';
      if (!id) continue;
      const network = detectNetworkId(p as never) || '';
      map.set(id, {
        id,
        title: typeof p.title === 'string' ? p.title.trim() : '',
        price: priceOf(p.price),
        hasImage: typeof p.image === 'string' && p.image.trim().length > 0,
        inStock: typeof p.inStock === 'boolean' ? p.inStock : null,
        network,
        category: typeof p.category === 'string' ? p.category : '',
        linkStatus: typeof p.link_status === 'string' ? p.link_status : '',
      });
      if (network) networks.set(network, (networks.get(network) ?? 0) + 1);
    }
  } catch {
    status = 'error';
  }
  try {
    retired = new Set(readDeletedIds());
  } catch {
    retired = new Set();
  }
  return { map, retired, networks, status };
}

/* ───────── Categorías (lectura directa: no se llama a getCategories) ───────── */
function readCategoriesReadOnly(): { list: CategoryInfo[]; status: SourceStatus; origin: 'file' | 'defaults' } {
  const toInfo = (c: unknown): CategoryInfo | null => {
    if (!isObj(c) || typeof c.id !== 'string' || typeof c.name !== 'string' || !c.id) return null;
    const slug = typeof c.slug === 'string' && c.slug ? c.slug : slugifyCategory(c.name);
    return { id: c.id, name: c.name, slug, parentId: typeof c.parentId === 'string' && c.parentId ? c.parentId : null };
  };
  const defaults = (status: SourceStatus) => ({
    list: DEFAULT_CATEGORIES.map(toInfo).filter((c): c is CategoryInfo => c !== null),
    status,
    origin: 'defaults' as const,
  });
  const file = dataFile('categories.json');
  try {
    if (!fs.existsSync(file)) return defaults('missing');
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const arr = Array.isArray(parsed) ? parsed : isObj(parsed) ? parsed.categories : null;
    if (!Array.isArray(arr) || arr.length === 0) return defaults('corrupt');
    if (isObj(arr[0]) && typeof arr[0].slug === 'string') {
      return { list: arr.map(toInfo).filter((c): c is CategoryInfo => c !== null), status: 'ok', origin: 'file' };
    }
    // Esquema legado (array de nombres): se interpreta en memoria, sin reescribir el archivo.
    const legacy = arr
      .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      .map((name) => {
        const slug = slugifyCategory(name);
        return { id: slug, name: name.trim(), slug, parentId: null };
      });
    return { list: legacy, status: 'ok', origin: 'file' };
  } catch {
    return defaults('corrupt');
  }
}

/* ───────── Secciones (lectura directa de sections.json) ───────── */
function readSectionsReadOnly(): { list: SectionInfo[]; status: SourceStatus; invalid: number } {
  const file = dataFile('sections.json');
  try {
    if (!fs.existsSync(file)) return { list: [], status: 'missing', invalid: 0 };
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(parsed)) return { list: [], status: 'corrupt', invalid: 0 };
    const list: SectionInfo[] = [];
    let invalid = 0;
    for (const s of parsed) {
      if (!isObj(s) || typeof s.id !== 'string' || !s.id || typeof s.title !== 'string' || !Array.isArray(s.productIds)) {
        invalid++;
        continue;
      }
      const speed = s.speed === 'slow' || s.speed === 'fast' || s.speed === 'none' ? s.speed : 'normal';
      list.push({
        id: s.id,
        title: s.title.trim(),
        published: s.published === true,
        order: typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : 0,
        // Igual que index.astro: sólo «above» es «above»; cualquier otro valor se trata como «below».
        position: s.position === 'above' ? 'above' : 'below',
        speed,
        productIds: s.productIds.filter((x): x is string => typeof x === 'string'),
      });
    }
    return { list, status: 'ok', invalid };
  } catch {
    return { list: [], status: 'corrupt', invalid: 0 };
  }
}

/** Instantánea de solo lectura de los datos reales. No lanza. */
export function loadSources(): ReferenceSources {
  const prod = readProducts();
  const cats = readCategoriesReadOnly();
  const secs = readSectionsReadOnly();
  const networks = new Map<string, number>(prod.networks);
  for (const n of KNOWN_NETWORKS) if (!networks.has(n)) networks.set(n, 0);
  return {
    products: prod.map,
    retiredIds: prod.retired,
    categories: new Map(cats.list.map((c) => [c.id, c])),
    networks,
    sections: new Map(secs.list.map((s) => [s.id, s])),
    sectionList: secs.list,
    status: {
      products: { status: prod.status, count: prod.map.size },
      categories: { status: cats.status, count: cats.list.length, origin: cats.origin },
      sections: { status: secs.status, count: secs.list.length, invalidEntries: secs.invalid },
    },
  };
}

/** Busca una categoría por id y, si no hay coincidencia, por slug (nunca por nombre libre). */
export function findCategory(sources: Pick<ReferenceSources, 'categories'>, ref: string): CategoryInfo | undefined {
  const direct = sources.categories.get(ref);
  if (direct) return direct;
  const key = normalizeKey(ref);
  if (!key) return undefined;
  for (const c of sources.categories.values()) if (normalizeKey(c.slug) === key) return c;
  return undefined;
}
