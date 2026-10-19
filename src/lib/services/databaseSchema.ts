/**
 * ==============================================================================
 * TRADYLOR - ESQUEMA DE BASE DE DATOS INCREMENTAL (SIN DESTRUIR)
 * ==============================================================================
 * Tipos y helpers para las NUEVAS tablas y columnas que se añaden al catálogo.
 * Mantiene compatibilidad total con products.json actual.
 * ==============================================================================
 */

import type { Product } from '../productStore';

/**
 * Tabla: raw_affiliate_products
 * Almacena el payload COMPLETO y crudo de cada ingesta desde redes de afiliación.
 * Permite re-procesar, auditar y re-ejecutar el pipeline sin perder datos originales.
 */
export interface RawAffiliateProduct {
  id: string;                    // UUID v4 generado en la ingesta
  network: string;               // 'amazon' | 'aliexpress' | 'awin' | 'cj' | 'admitad' | 'tradedoubler' | 'kwanko' | 'etsy' | 'ebay' | 'generic'
  externalId: string;            // ID nativo de la red (ASIN, Item ID, etc.)
  rawPayload: Record<string, unknown>; // JSON completo devuelto por la API del conector
  capturedAt: string;            // ISO timestamp de la captura
  processed: boolean;            // Si ya pasó por el pipeline de enriquecimiento
  processedAt?: string;          // Cuándo se procesó
  sourceProductId?: string;      // ID del producto en products.json si se creó/actualizó
  error?: string;                // Error si falló el procesamiento
}

/**
 * Tabla: product_alternatives
 * Cross-matching bidireccional de competidores/alternativas (normalizado, no destructivo).
 * Cada fila = un vínculo direccional con rol semántico.
 */
export interface ProductAlternative {
  id: string;                    // UUID v4
  productId: string;             // Producto base (FK a products.id)
  alternativeProductId: string;  // Producto alternativo (FK a products.id)
  role: 'premium' | 'cheaper' | 'similar' | 'cross-sell' | 'bundle'; // Rol semántico
  score: number;                 // 0-100 (similitud, delta precio, rating...)
  source: 'auto' | 'manual' | 'ai'; // Origen del vínculo
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
}

/**
 * Columnas NUEVAS añadidas a Product (incrementales, opcionales, retrocompatibles)
 * Se extienden sobre la interfaz Product existente en productStore.ts
 */
export interface ProductEnrichedExtensions {
  /** Array de URLs de imágenes (galería completa, sin límite de 10 del frontend actual). */
  images?: string[];
  /** Descripción corta (1-2 frases) para tarjetas/listados, distinta de la ficha completa. */
  short_description?: string;
  /** Highlights/viñetas de venta (bullet points destacados para CRO). */
  highlights?: string[];
  /** Pros/Contras estructurados para UI avanzada (tabs, acordeones). */
  pros_cons?: {
    pros: Array<{ text: string; weight?: number; source?: 'scraped' | 'ai' | 'manual' }>;
    cons: Array<{ text: string; weight?: number; source?: 'scraped' | 'ai' | 'manual' }>;
  };
  /** Tags técnicos normalizados (matriz de atributos para filtros/facetas futuras). */
  normalized_tags?: string[];
  /** Clave de agrupación para cross-matching: normalizada (marca+modelo+variante sin sufijos). */
  matching_key?: string;
  /** Términos de competidor para búsquedas y matching automático. */
  competitor_terms?: string[];
  /** Puntuación de conversión/rentabilidad 0-100 (ya existe conversion_score, se mantiene). */
  conversion_score?: number;
  /** Estado del enriquecimiento IA: pending | completed | error | skipped */
  ia_status?: string;
  /** Estado del enlace de afiliación: active | pending | broken */
  link_status?: string;
}

/**
 * Producto completo con extensiones de enriquecimiento (para uso interno del pipeline).
 */
export type EnrichedProduct = Product & ProductEnrichedExtensions;

/**
 * Helpers de migración/validación (no destructivos)
 */

export function isEnrichedProduct(product: Product): product is EnrichedProduct {
  return (
    'images' in product ||
    'short_description' in product ||
    'highlights' in product ||
    'pros_cons' in product ||
    'normalized_tags' in product ||
    'matching_key' in product ||
    'competitor_terms' in product
  );
}

/**
 * Genera matching_key a partir de título + marca + modelo (normalizado).
 * Ej: "Samsung Galaxy S24 Ultra 512GB Negro" -> "samsung-galaxy-s24-ultra-512gb"
 */
export function generateMatchingKey(
  title: string,
  brand?: string,
  model?: string
): string {
  const parts = [
    brand || '',
    model || '',
    title || '',
  ].filter(Boolean).join(' ');

  return parts
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 120);
}

/**
 * Genera competitor_terms a partir del título (tokens significativos para búsquedas).
 */
export function generateCompetitorTerms(title: string): string[] {
  const stopWords = new Set([
    'de', 'del', 'la', 'el', 'en', 'y', 'con', 'para', 'por', 'un', 'una', 'los', 'las',
    'y', 'o', 'pero', 'si', 'no', 'con', 'sin', 'sobre', 'entre', 'hasta', 'desde',
    'the', 'and', 'or', 'for', 'with', 'without', 'in', 'on', 'at', 'to', 'from', 'by',
    'pro', 'max', 'plus', 'ultra', 'lite', 'mini', 'air', 'neo', 'new', 'model', 'versión',
    'version', 'edición', 'edition', 'color', 'negro', 'blanco', 'azul', 'rojo', 'gris',
    'black', 'white', 'blue', 'red', 'gray', 'grey', 'silver', 'gold', 'rose', 'space',
  ]);

  const tokens = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map(t => t.trim())
    .filter(t => t.length >= 3 && !stopWords.has(t) && !/^\d+$/.test(t));

  // Quitar duplicados y limitar
  return [...new Set(tokens)].slice(0, 15);
}

/**
 * Genera short_description a partir de la descripción completa (primeras 2 frases).
 */
export function generateShortDescription(description: string, maxLength = 280): string {
  if (!description?.trim()) return '';
  const sentences = description.trim().split(/(?<=[.!?])\s+/);
  let result = '';
  for (const sentence of sentences) {
    if ((result + sentence).length > maxLength) break;
    result += (result ? ' ' : '') + sentence;
  }
  return result.trim() || description.slice(0, maxLength).trim();
}

/**
 * Genera highlights (bullet points de venta) a partir de pros + specs clave.
 */
export function generateHighlights(
  pros: string[],
  specs: Record<string, string>,
  maxItems = 5
): string[] {
  const highlights: string[] = [];

  // Top 3 pros como highlights
  highlights.push(...pros.slice(0, 3));

  // Specs diferenciales (conectividad, pantalla, batería, etc.)
  const keySpecs = ['Conectividad', 'Pantalla', 'Batería', 'Autonomía', 'Procesador', 'Memoria', 'Almacenamiento', 'Cámara', 'Resolución', 'Peso', 'Dimensiones'];
  for (const key of keySpecs) {
    const matchKey = Object.keys(specs).find(k => k.toLowerCase() === key.toLowerCase());
    if (matchKey && highlights.length < maxItems) {
      highlights.push(`${matchKey}: ${specs[matchKey]}`);
    }
  }

  return highlights.slice(0, maxItems);
}

/**
 * Convierte pros/cons planos al formato estructurado pros_cons.
 */
export function structureProsCons(
  pros: string[],
  cons: string[]
): ProductEnrichedExtensions['pros_cons'] {
  return {
    pros: pros.map((text, i) => ({ text, weight: 10 - i, source: 'ai' as const })),
    cons: cons.map((text, i) => ({ text, weight: 10 - i, source: 'ai' as const })),
  };
}

/**
 * Rutas de archivos JSON para las nuevas tablas (persistencia en volumen).
 */
import { dataFile } from '../paths';

export const RAW_AFFILIATE_PRODUCTS_FILE = dataFile('raw-affiliate-products.json');
export const PRODUCT_ALTERNATIVES_FILE = dataFile('product-alternatives.json');

/**
 * Lectura/escritura segura de raw_affiliate_products.json
 */
import fs from 'node:fs';
import path from 'node:path';

export function readRawAffiliateProducts(): RawAffiliateProduct[] {
  try {
    if (!fs.existsSync(RAW_AFFILIATE_PRODUCTS_FILE)) return [];
    const raw = fs.readFileSync(RAW_AFFILIATE_PRODUCTS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeRawAffiliateProducts(products: RawAffiliateProduct[]): boolean {
  try {
    const dir = path.dirname(RAW_AFFILIATE_PRODUCTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RAW_AFFILIATE_PRODUCTS_FILE, JSON.stringify(products, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function upsertRawAffiliateProduct(product: RawAffiliateProduct): { product: RawAffiliateProduct; updated: boolean } {
  const products = readRawAffiliateProducts();
  const index = products.findIndex(p => p.id === product.id);
  const updated = index >= 0;
  if (updated) products[index] = product;
  else products.unshift(product);
  writeRawAffiliateProducts(products);
  return { product, updated };
}

/**
 * Lectura/escritura segura de product_alternatives.json
 */
export function readProductAlternatives(): ProductAlternative[] {
  try {
    if (!fs.existsSync(PRODUCT_ALTERNATIVES_FILE)) return [];
    const raw = fs.readFileSync(PRODUCT_ALTERNATIVES_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeProductAlternatives(alternatives: ProductAlternative[]): boolean {
  try {
    const dir = path.dirname(PRODUCT_ALTERNATIVES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PRODUCT_ALTERNATIVES_FILE, JSON.stringify(alternatives, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function upsertProductAlternative(alt: ProductAlternative): { alternative: ProductAlternative; updated: boolean } {
  const alternatives = readProductAlternatives();
  const index = alternatives.findIndex(a => a.id === alt.id);
  const updated = index >= 0;
  if (updated) alternatives[index] = alt;
  else alternatives.unshift(alt);
  writeProductAlternatives(alternatives);
  return { alternative: alt, updated };
}

/**
 * Vinculación bidireccional de alternativas (mantiene product_alternatives.json sincronizado).
 * También actualiza alternative_product_ids y alternatives en products.json (compatibilidad).
 */
import { readProductsFromFile, writeProductsToFile, type Product as ProductStoreProduct } from '../productStore';

export function linkAlternativesBidirectional(
  productId: string,
  alternativeId: string,
  role: ProductAlternative['role'],
  score: number,
  source: ProductAlternative['source'] = 'auto'
): { ok: boolean; message: string } {
  // 1. Tabla product_alternatives (nueva)
  const alternatives = readProductAlternatives();
  const existingIndex = alternatives.findIndex(
    a => a.productId === productId && a.alternativeProductId === alternativeId && a.role === role
  );

  const now = new Date().toISOString();
  if (existingIndex >= 0) {
    alternatives[existingIndex] = {
      ...alternatives[existingIndex],
      score,
      source,
      updatedAt: now,
    };
  } else {
    alternatives.push({
      id: `${productId}-${alternativeId}-${role}-${Date.now().toString(36)}`,
      productId,
      alternativeProductId: alternativeId,
      role,
      score,
      source,
      createdAt: now,
      updatedAt: now,
    });
  }
  writeProductAlternatives(alternatives);

  // 2. Sincronizar products.json (compatibilidad con frontend existente)
  const products = readProductsFromFile();
  const base = products.find(p => p.id === productId);
  const alt = products.find(p => p.id === alternativeId);
  if (base && alt) {
    // alternative_product_ids (array plano)
    const altIds = [...new Set([...(base.alternative_product_ids || []), alternativeId])].filter(id => id !== productId);
    base.alternative_product_ids = altIds;

    // alternatives (objeto con roles)
    base.alternatives = base.alternatives || {};
    if (role === 'premium') base.alternatives.premiumOptionId = alternativeId;
    if (role === 'cheaper') {
      base.alternatives.cheaperOptionIds = [...new Set([...(base.alternatives.cheaperOptionIds || []), alternativeId])];
      base.alternatives.cheaperOptionId = base.alternatives.cheaperOptionIds[0];
    }
    if (role === 'similar') {
      base.alternatives.similarOptionIds = [...new Set([...(base.alternatives.similarOptionIds || []), alternativeId])];
      base.alternatives.similarOptionId = base.alternatives.similarOptionIds[0];
    }

    writeProductsToFile(products);
  }

  return { ok: true, message: 'Alternativa vinculada bidireccionalmente' };
}