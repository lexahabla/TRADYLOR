/**
 * ==============================================================================
 * TRADYLOR - ESCRITURA COMPARTIDA DEL CATÁLOGO (products.json)
 * ==============================================================================
 * Lógica de persistencia reutilizada por:
 *   - El panel admin (POST /api/products/add)
 *   - La API pública de automatización n8n (POST /api/v1/products/import)
 *
 * El enmascaramiento (link cloaking) ya está activo en el frontend: el CTA del
 * detalle apunta a `/out/[id]`, que redirige en servidor al affiliateUrl real.
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Product } from '../data/products';

const DATA_FILE_PATH = path.join(process.cwd(), 'src', 'data', 'products.json');

export function readCatalogFromFile(): Product[] {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE_PATH, 'utf-8'));
  } catch (error) {
    console.error('[CatalogStore] Error al leer products.json:', error);
    return [];
  }
}

function writeCatalogToFile(products: Product[]): boolean {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE_PATH), { recursive: true });
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(products, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('[CatalogStore] Error al guardar products.json:', error);
    return false;
  }
}

export function slugifyProduct(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

export interface CatalogSaveResult {
  ok: boolean;
  message: string;
  product?: Product;
  updated?: boolean;
}

/** Inserta o actualiza (upsert por id) un producto en products.json. */
export function upsertCatalogProduct(data: Partial<Product>): CatalogSaveResult {
  if (!data.title || !data.affiliateUrl) {
    return { ok: false, message: 'Los campos "title" y "affiliateUrl" son obligatorios.' };
  }

  const products = readCatalogFromFile();
  const productId = data.id || slugifyProduct(data.title);

  const product: Product = {
    id: productId,
    title: String(data.title).trim(),
    description: String(data.description ?? '').trim(),
    price: Number(data.price) || 0,
    originalPrice: data.originalPrice ? Number(data.originalPrice) : undefined,
    image: String(data.image ?? 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=800&auto=format&fit=crop').trim(),
    category: String(data.category ?? 'Tecnología').trim(),
    merchant: String(data.merchant ?? 'Comercio Externo').trim(),
    affiliateUrl: String(data.affiliateUrl).trim(),
    pros: Array.isArray(data.pros) ? data.pros.filter(Boolean) : [],
    cons: Array.isArray(data.cons) ? data.cons.filter(Boolean) : [],
    badge: data.badge ? String(data.badge).trim() : undefined,
    rating: data.rating != null ? Number(data.rating) : undefined,
    reviewsCount: data.reviewsCount != null ? Number(data.reviewsCount) : undefined,
    verdict: data.verdict ? String(data.verdict).trim() : undefined,
  };

  const existingIndex = products.findIndex((p) => p.id === productId);
  if (existingIndex >= 0) products[existingIndex] = product;
  else products.unshift(product);

  if (!writeCatalogToFile(products)) {
    return { ok: false, message: 'Error de escritura en el servidor de archivos.' };
  }

  return {
    ok: true,
    message: existingIndex >= 0 ? 'Producto actualizado con éxito.' : 'Producto guardado con éxito.',
    product,
    updated: existingIndex >= 0,
  };
}
