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
import { dataFile } from './paths';
import { readDeletedIds } from './deletedProducts';
import { extractAsinFromUrl, getAmazonAddToCartUrl } from '../utils/amazon';

const DATA_FILE_PATH = dataFile('products.json');

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

/**
 * Payload tal y como lo emite n8n (contrato JSON documentado en docs/api-v1.md):
 * referencePrice / analystVerdict / affiliateDeepLink / specs / fulfillmentProvider.
 */
export interface N8nContractPayload extends Partial<Product> {
  affiliateDeepLink?: string;
  referencePrice?: number | string;
  analystVerdict?: string;
}

/**
 * Normaliza el contrato de n8n al modelo interno del catálogo.
 * El campo interno mantiene el nombre canónico (price, verdict, affiliateUrl).
 */
export function fromN8nContract(data: N8nContractPayload): Partial<Product> {
  const normalized: Partial<Product> = { ...data };

  if (!normalized.affiliateUrl && data.affiliateDeepLink) {
    normalized.affiliateUrl = String(data.affiliateDeepLink).trim();
  }
  if (normalized.price == null && data.referencePrice != null) {
    normalized.price = Number(data.referencePrice);
  }
  if (!normalized.verdict && data.analystVerdict) {
    normalized.verdict = String(data.analystVerdict).trim();
  }
  if (data.slug) {
    normalized.slug = slugifyProduct(data.slug);
  }
  if (data.specs && typeof data.specs === 'object') {
    normalized.specs = data.specs;
  }
  if (data.fulfillmentProvider) {
    normalized.fulfillmentProvider = String(data.fulfillmentProvider).trim();
  }

  return normalized;
}

/** Inserta o actualiza (upsert por id) un producto en products.json. */
export function upsertCatalogProduct(raw: N8nContractPayload): CatalogSaveResult {
  // Tombstone: el administrador lo borró; no se revive por un import/upsert.
  if (raw?.id && readDeletedIds().includes(raw.id)) {
    return { ok: false, message: 'Producto eliminado anteriormente. Recupéralo desde el panel admin.' };
  }

  const data = fromN8nContract(raw);

  if (!data.title || !data.affiliateUrl) {
    return { ok: false, message: 'Los campos "title" y "affiliateUrl" (o "affiliateDeepLink") son obligatorios.' };
  }

  const products = readCatalogFromFile();
  const productId = data.id || slugifyProduct(data.title);
  const existing = products.find((p) => p.id === productId);

  const product: Product = {
    id: productId,
    slug: data.slug ?? existing?.slug,
    title: String(data.title).trim(),
    description: String(data.description ?? '').trim(),
    price: Number(data.price) || 0,
    originalPrice: data.originalPrice ? Number(data.originalPrice) : undefined,
    image: String(data.image ?? 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=800&auto=format&fit=crop').trim(),
    category: String(data.category ?? 'Tecnología').trim(),
    merchant: String(data.merchant ?? 'Comercio Externo').trim(),
    affiliateUrl: String(data.affiliateUrl).trim(),
    buyNowUrl: (() => {
      if (data.buyNowUrl) return String(data.buyNowUrl).trim();
      // Sin URL manual y con ASIN: se genera la cesta de Amazon con tag
      // (enlace de compra directa hacia la tramitación del pedido).
      const asin = data.asin
        ? String(data.asin).trim().toUpperCase()
        : extractAsinFromUrl(String(data.affiliateUrl).trim());
      return asin && /^[A-Z0-9]{10}$/.test(asin) ? getAmazonAddToCartUrl(asin) : existing?.buyNowUrl;
    })(),
    asin: data.asin ? String(data.asin).trim().toUpperCase() : existing?.asin,
    pros: Array.isArray(data.pros) ? data.pros.filter(Boolean) : [],
    cons: Array.isArray(data.cons) ? data.cons.filter(Boolean) : [],
    badge: data.badge ? String(data.badge).trim() : undefined,
    rating: data.rating != null ? Number(data.rating) : undefined,
    reviewsCount: data.reviewsCount != null ? Number(data.reviewsCount) : undefined,
    verdict: data.verdict ? String(data.verdict).trim() : undefined,
    techSheet: data.techSheet ? String(data.techSheet).trim() : existing?.techSheet,
    specs: data.specs ?? existing?.specs,
    fulfillmentProvider: data.fulfillmentProvider ?? existing?.fulfillmentProvider,
    priceHistory: existing?.priceHistory,
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
