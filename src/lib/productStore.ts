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
  verdict?: string;
  specs?: Record<string, string>;
  fulfillmentProvider?: string;
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
