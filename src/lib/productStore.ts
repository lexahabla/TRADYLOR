import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from './paths';

// Interfaz del producto (compartida por el panel admin y los endpoints de alta)
export interface Product {
  id: string;
  title: string;
  description: string;
  price: number;
  originalPrice?: number;
  image: string;
  /** Galería de imágenes del producto (la primera suele ser la principal). */
  gallery?: string[];
  category: string;
  merchant: string;
  affiliateUrl: string;
  buyNowUrl?: string;
  /** Código ASIN de Amazon (autodetectado desde el enlace de afiliado). */
  asin?: string;
  pros: string[];
  cons: string[];
  badge?: string;
  rating?: number;
  reviewsCount?: number;
  /** Marca del producto (ej: Samsung); se muestra en la ficha y en JSON-LD. */
  brand?: string;
  verdict?: string;
  specs?: Record<string, string>;
  /** Texto de ficha técnica (consulta en la página del producto). */
  techSheet?: string;
  fulfillmentProvider?: string;
  /** Texto de envío mostrado en checkout y ficha (ej: "Envío en 15 días"). */
  shippingInfo?: string;
  /** Días estimados de envío (entero; filtros y estimaciones). */
  shippingDays?: number;
  /** Envío estándar gratuito confirmado en la ficha del comerciante. */
  freeShipping?: boolean;
  /** Histórico de precio (1 punto por día; lo completa lib/priceHistory.ts). */
  priceHistory?: { date: string; price: number }[];
}

// Ruta al archivo de persistencia JSON
export const DATA_FILE_PATH = dataFile('products.json');

/**
 * Lee de forma segura los productos almacenados en el archivo JSON local.
 */
export function readProductsFromFile(): Product[] {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      return [];
    }
    const raw = fs.readFileSync(DATA_FILE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    console.error('[ProductStore] Error al leer products.json:', error);
    return [];
  }
}

/**
 * Escribe los productos en el archivo JSON local garantizando el formateo.
 */
export function writeProductsToFile(products: Product[]): boolean {
  try {
    const dir = path.dirname(DATA_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(products, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('[ProductStore] Error al guardar en products.json:', error);
    return false;
  }
}

/**
 * Genera un ID limpio tipo slug a partir del título.
 */
export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 50);
  return base || `producto-${Date.now().toString(36)}`;
}

/**
 * Inserta o actualiza un producto en products.json (upsert por `id`).
 * Devuelve el producto guardado y si fue una actualización.
 */
export function upsertProduct(product: Product): { product: Product; updated: boolean } {
  const products = readProductsFromFile();
  const index = products.findIndex((item) => item.id === product.id);
  const updated = index >= 0;
  if (updated) {
    products[index] = product;
  } else {
    products.unshift(product);
  }
  writeProductsToFile(products);
  return { product, updated };
}

/**
 * Clave normalizada para comparar productos (misma regla que el panel admin
 * usa con el catálogo AliExpress): minúsculas, sin esquema, sin `www`, sin
 * query/hash y sin barra final. Así un enlace de afiliado con parámetros de
 * tracking se considera IGUAL que la URL limpia del producto.
 */
export function normalizeProductKey(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

/**
 * Busca en el catálogo un producto que YA exista y coincida con el candidato
 * por URL de afiliado/tienda o por título (normalizados). Sirve para no crear
 * filas repetidas en products.json.
 *
 * @param ignoreId  id del producto que se está actualizando (no cuenta como duplicado).
 */
export function findDuplicateProduct(
  products: Product[],
  candidate: { id?: string | null; title?: string | null; urls?: Array<string | null | undefined> },
  ignoreId?: string | null,
): Product | undefined {
  const ignored = new Set(
    [candidate.id, ignoreId]
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );
  const urls = new Set(
    (candidate.urls ?? [])
      .map((value) => normalizeProductKey(value))
      .filter(Boolean),
  );
  const titleKey = normalizeProductKey(candidate.title);
  if (!urls.size && !titleKey) return undefined;

  return products.find((item) => {
    if (ignored.has(item.id)) return false;
    if (item.affiliateUrl && urls.has(normalizeProductKey(item.affiliateUrl))) return true;
    if (item.buyNowUrl && urls.has(normalizeProductKey(item.buyNowUrl))) return true;
    return Boolean(titleKey) && titleKey === normalizeProductKey(item.title);
  });
}
