/**
 * ============================================================================
 * TRADYLOR — PIPELINE DE INGESTIÓN DE PRODUCTOS AMAZON
 * ============================================================================
 *
 * Pipeline completo de ingestión, normalización inteligente y persistencia
 * para productos de Amazon:
 *
 *   1. Extracción / validación de ASIN (URL completa o ASIN directo, 10 chars).
 *   2. Consumo de la API estructurada de ScraperAPI (country_code=es, SCRAPER_API_KEY).
 *   3. Normalización de campos crudos al modelo interno de producto.
 *   4. Enriquecimiento por IA (texto editorial: título, descripción, specs,
 *      pros/contras, veredicto, par de precios con descuento realista) con
 *      esquema de salida estructurado que coincide con el modelo de BD.
 *   5. Persistencia upsert usando el ASIN como clave primaria única para
 *      evitar duplicados, alimentando el Catálogo y la vista de
 *      "Extracción & Alta de Producto".
 *
 * Todos los pasos son ejecutables individualmente o en cadena vía
 * importAmazonProduct(). Se expone también mediante el endpoint
 * POST /api/admin/amazon/import (requiere sesión de admin).
 */

import { productSchema } from '../content.config';
import { safeValidate } from './validateProducts';
import { readJsonArrayFile, writeJsonArrayFile } from './jsonStore';
import { dataFile } from './paths';
import { invalidateCatalogCache } from './catalog';
import {
  extractOrValidateAsin,
  isValidAsin,
  sanitizeAsin,
  getAmazonAddToCartUrl,
} from '../utils/amazon';
import { enrichProductText, buildRealisticPricing, overlayEnrichedText, enforceMoreProsThanCons, hasTextCredentials, type EnrichedText, type ImageProvider } from './ai';
import { enrichProductLocally, type LocalEnrichInput } from './localEnrich';
import { computeBadge } from './curation';
import type { Product as FlatProduct, Product as AdminProduct } from './productStore';

const DATA_FILE_PATH = dataFile('products.json');

/** Clave pública de ScraperAPI (sólo servidor; nunca se expone al cliente). */
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';
const SCRAPER_API_COUNTRY_CODE = process.env.SCRAPER_API_COUNTRY_CODE?.trim() || 'es';

/** Endpoint estructurado de Amazon de ScraperAPI (región España). */
const SCRAPER_API_BASE = 'https://api.scraperapi.com/structured/amazon/product/v1';

/** Tag de afiliado Amazon usado cuando ScraperAPI no devuelve enlace propio. */
const ASSOCIATE_TAG = 'tradylor-21';

/* ───────────────────────────────────────────────────────────────────────────
   1. TIPOS
   ─────────────────────────────────────────────────────────────────────────── */

/** Datos crudos tal como los devuelve ScraperAPI (campos opcionales y variantes). */
export interface AmazonScrapedProduct {
  asin?: string;
  title?: string;
  price?: number | string;
  original_price?: number | string;
  list_price?: number | string;
  image?: string;
  images?: string[];
  brand?: string;
  seller?: string;
  merchant?: string;
  rating?: number;
  reviews?: number;
  review_count?: number;
  specifications?: Record<string, string>;
  specs?: Record<string, string>;
  description?: string;
  availability?: string;
  in_stock?: boolean;
  currency?: string;
  affiliate_url?: string;
  buy_now_url?: string;
  [key: string]: unknown;
}

/** Producto normalizado (forma plana) listo para enriquecer y guardar. */
export interface NormalizedAmazonProduct {
  asin: string;
  title: string;
  description?: string;
  price?: number;
  originalPrice?: number;
  image?: string;
  gallery?: string[];
  brand?: string;
  merchant: string;
  currency?: string;
  inStock?: boolean;
  rating?: number;
  reviewsCount?: number;
  specs?: Record<string, string>;
  techSheet?: string;
  affiliateUrl?: string;
  buyNowUrl?: string;
  sourceId?: string;
  network?: string;
  raw?: AmazonScrapedProduct;
  extra?: Record<string, unknown>;
  videos?: string[];
}

/** Opciones del pipeline de importación. */
export interface ImportAmazonOptions {
  /** Proveedor de texto forzado (openai, anthropic, groq, gemini…). */
  textProvider?: NonNullable<Parameters<typeof enrichProductText>[1]>['provider'];
  /** Proveedor de imagen forzado (openai, flux). */
  imageProvider?: ImageProvider;
  /** Si es false, no se guarda en products.json (solo devuelve vista previa). */
  save?: boolean;
  /** Si es false, no se genera/enriquece imagen con IA. */
  enrichImage?: boolean;
  /** Si es true, no se sustituye una imagen real ya guardada por una de IA. */
  imageOnlyIfMissing?: boolean;
  /** Código de región para ScraperAPI (ej: 'es', 'us', 'uk'). Por defecto SCRAPER_API_COUNTRY_CODE o 'es'. */
  countryCode?: string;
}

/** Resultado de la importación. */
export interface ImportAmazonResult {
  success: boolean;
  asin?: string;
  product?: FlatProduct;
  updated?: boolean;
  saved?: boolean;
  message?: string;
  warnings?: string[];
}

/* ───────────────────────────────────────────────────────────────────────────
   2. PASO A — CONSUMO DE SCRAPERAPI
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Espera un tiempo dado en milisegundos (útil para backoff entre reintentos).
 */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detecta si el cuerpo de una respuesta es una página HTML de bloqueo/captcha
 * en lugar del JSON estructurado de ScraperAPI.
 */
function looksLikeBlockPage(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  // Si empieza con <!DOCTYPE o <html, es casi seguro una página HTML.
  if (/^\s*<!DOCTYPE\s/i.test(trimmed) || /^\s*<html\b/i.test(trimmed)) {
    return true;
  }
  // Señales de páginas de bloqueo/captcha/error de Amazon y ScraperAPI.
  const blockSignals = [
    'page not found',
    'sorry! we couldn\'t find that page',
    'captcha',
    'access denied',
    'blocked',
    'robot check',
    'unusual traffic',
    'api key invalid',
    'invalid api key',
    'rate limit',
    'quota exceeded',
    'service unavailable',
    'temporarily unavailable',
    'automated access to amazon data',
  ];
  const lower = trimmed.toLowerCase();
  return blockSignals.some((s) => lower.includes(s));
}

/**
 * Llama a la API estructurada de Amazon de ScraperAPI para un ASIN concreto
 * (región España). Requiere la variable de entorno SCRAPER_API_KEY.
 *
 * Incluye reintentos con backoff exponencial (máx. 3 intentos) para absorber
 * bloqueos temporales (HTTP 503, página de captcha/bloqueo de Amazon) y
 * errores de red transitorios. Si ScraperAPI devuelve HTML en lugar de JSON
 * (página de bloqueo), se detecta y se informa con un mensaje claro.
 */
export async function scrapeAmazonProduct(
  asin: string,
  opts: { maxRetries?: number; retryDelayMs?: number; countryCode?: string } = {},
): Promise<AmazonScrapedProduct> {
  if (!SCRAPER_API_KEY) {
    throw new Error(
      'Falta la variable de entorno SCRAPER_API_KEY para consumir ScraperAPI.',
    );
  }
  const maxRetries = opts.maxRetries ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 2000;

  const countryCode = opts.countryCode ?? SCRAPER_API_COUNTRY_CODE;
  const url = `${SCRAPER_API_BASE}?api_key=${encodeURIComponent(SCRAPER_API_KEY)}&asin=${encodeURIComponent(asin)}&country_code=${encodeURIComponent(countryCode)}&retry_404=true`;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          // User-Agent de navegador para reducir la probabilidad de que Amazon
          // devuelva una página de captcha/bloqueo a través de ScraperAPI.
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
      });

      const text = await response.text();

      // ── Éxito: intentamos parsear JSON ──
      if (response.ok) {
        try {
          return JSON.parse(text) as AmazonScrapedProduct;
        } catch {
          // La respuesta tiene HTTP 200 pero no es JSON: puede ser una página
          // de bloqueo/captcha de Amazon envuelta por ScraperAPI, o una página
          // de error tipo "Page Not Found" (ASIN no existe en Amazon).
          if (looksLikeBlockPage(text)) {
            const snippet = text.slice(0, 120).replace(/\s+/g, ' ');
            const lower = text.toLowerCase();
            if (lower.includes('page not found') || lower.includes("sorry! we couldn't find that page")) {
              throw new Error(
                `Amazon no encontró el producto para el ASIN "${asin}" (página "Page Not Found" de Amazon). Verifica que el ASIN sea correcto y exista en Amazon ${countryCode}.`,
              );
            }
            throw new Error(
              `ScraperAPI devolvió una página de bloqueo/captcha (no JSON) en el intento ${attempt}/${maxRetries}: "${snippet}". Posible IP bloqueada o captcha de Amazon.`,
            );
          }
          throw new Error(
            `ScraperAPI respondió ${response.status} con contenido no JSON (${text.length} bytes). No se pudo parsear la respuesta del ASIN "${asin}".`,
          );
        }
      }

      // ── Errores de HTTP ──
      const isRetryable =
        response.status === 429 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;

      // Clasificamos el error para dar un mensaje útil.
      let reason = `ScraperAPI respondió ${response.status}`;
      const lower = text.toLowerCase();
      if (lower.includes('invalid api key') || lower.includes('api key invalid')) {
        reason += ' (clave de API inválida — revisa SCRAPER_API_KEY)';
      } else if (lower.includes('quota exceeded') || lower.includes('rate limit')) {
        reason += ' (cuota/límite de peticiones agotado)';
      } else if (lower.includes('blocked') || looksLikeBlockPage(text)) {
        reason += ' (IP bloqueada o página de captcha de Amazon)';
      } else if (response.status === 503) {
        reason += ' (servicio no disponible temporalmente)';
      }
      // Mostramos más cuerpo de respuesta para diagnosticar (clave, cuota, error de ScraperAPI…)
      const snippet = text.slice(0, 800).replace(/\s+/g, ' ');
      reason += `: "${snippet}"`;

      lastError = new Error(reason);

      // Si no es reintentoable o ya agotamos los intentos, lanzamos.
      if (!isRetryable || attempt === maxRetries) {
        throw lastError;
      }
    } catch (error: any) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      // Si ya es un error de bloqueo claro, no reintentamos.
      if (/bloqueo|captcha|clave de API inválida|cuota\/límite/.test(msg)) {
        throw error;
      }
      if (attempt === maxRetries) {
        throw error;
      }
    }

    // Backoff exponencial: 2s, 4s, 8s…
    await sleepMs(retryDelayMs * 2 ** (attempt - 1));
  }

  throw lastError ?? new Error('ScraperAPI falló sin devolver error detectable.');
}

/* ───────────────────────────────────────────────────────────────────────────
   3. PASO B — NORMALIZACIÓN DE CAMPOS CRUDOS
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Mapea los datos crudos de ScraperAPI al formato plano interno.
 * Intenta varios nombres de campo porque ScraperAPI puede devolver variantes
 * (price / original_price / list_price, reviews / review_count, etc.).
 */
export function normalizeScrapedAmazonData(
  raw: AmazonScrapedProduct,
  asinFallback?: string,
): NormalizedAmazonProduct {
  const asin = sanitizeAsin(raw.asin || asinFallback || '');
  const title =
    String(raw.title || '').trim() ||
    String(raw.name || '').trim() ||
    `Producto Amazon ${asin}`;
  const merchant = String(raw.merchant || raw.seller || 'Amazon').trim();

  // ── Precio: soporta número directo, objeto { value }, string o variantes ──
  const priceFromObj = (v: unknown): number | undefined => {
    if (v == null) return undefined;
    if (typeof v === 'object' && !(v instanceof Array)) {
      const o = v as Record<string, unknown>;
      if (o.value != null) return Number(o.value);
      if (o.amount != null) return Number(o.amount);
      return undefined;
    }
    if (typeof v === 'string') return Number(String(v).replace(/[^0-9.,]/g, '').replace(',', '.'));
    return Number(v);
  };
  const price =
    priceFromObj(raw.price) ??
    (raw.pricing != null ? Number(String(raw.pricing).replace(/[^0-9.,]/g, '').replace(',', '.')) : undefined);
  const originalPrice =
    priceFromObj(raw.original_price) ??
    priceFromObj(raw.list_price) ??
    priceFromObj(raw.listPrice) ??
    priceFromObj(raw.originalPrice) ??
    undefined;

  const image = String(raw.image || raw.thumbnailImage || '').trim();
  const allImages: string[] = [];
  const seen = new Set<string>();
  const addImage = (u: unknown) => {
    const s = String(u || '').trim();
    if (!s || !/^https?:\/\//i.test(s)) return;
    if (/sprite|icon|logo|spacer|blank|pixel|transparent|1x1/i.test(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    allImages.push(s);
  };
  // Soporte para ambos esquemas: ScraperAPI (high_res_images / images) y
  // JSON alternativo (highResolutionImages / galleryThumbnails).
  if (Array.isArray(raw.high_res_images)) raw.high_res_images.forEach(addImage);
  if (Array.isArray(raw.highResolutionImages)) raw.highResolutionImages.forEach(addImage);
  if (Array.isArray(raw.images)) raw.images.forEach(addImage);
  if (Array.isArray(raw.galleryThumbnails)) raw.galleryThumbnails.forEach(addImage);
  if (image && !seen.has(image)) allImages.unshift(image);
  const gallery = allImages.slice(0, 8);

  const videos: string[] = [];
  const seenV = new Set<string>();
  const addVideo = (u: unknown) => {
    const s = String(u || '').trim();
    if (!s || !/^https?:\/\//i.test(s)) return;
    if (seenV.has(s)) return;
    seenV.add(s);
    videos.push(s);
  };
  if (Array.isArray(raw.videos)) raw.videos.forEach(addVideo);
  if (raw.video_urls && Array.isArray(raw.video_urls)) raw.video_urls.forEach(addVideo);

  const rating =
    raw.rating != null ? Number(raw.rating) : raw.stars != null ? Number(raw.stars) : undefined;
  const reviewsCount =
    raw.reviews != null
      ? Number(raw.reviews)
      : raw.review_count != null
        ? Number(raw.review_count)
        : raw.reviewsCount != null
          ? Number(raw.reviewsCount)
          : raw.total_reviews != null
            ? Number(raw.total_reviews)
            : raw.total_ratings != null
              ? Number(raw.total_ratings)
              : undefined;

  const description =
    String(raw.description || '').trim() ||
    String(raw.full_description || '').trim() ||
    String(raw.sourceDescription || '').trim() ||
    (Array.isArray(raw.features) && raw.features.length
      ? raw.features.map(String).filter(Boolean).join('\n')
      : '');
  const availability = String(raw.availability || '').toLowerCase();
  const inStock =
    availability.includes('in stock') ||
    availability.includes('disponible') ||
    availability.includes('en stock') ||
    availability.includes('en stock') ||
    raw.inStock === true;

  const pros =
    Array.isArray(raw.feature_bullets) && raw.feature_bullets.length
      ? raw.feature_bullets.map(String)
      : Array.isArray(raw.features) && raw.features.length
        ? raw.features.map(String).filter(Boolean).slice(0, 6)
        : undefined;
  const cons: string[] = [];

  // ── Especs: soporta objeto clave/valor o array de { key, value } ──
  let specs =
    (raw.specifications || raw.specs || raw.product_information || {}) as Record<string, string>;
  if ((!specs || Object.keys(specs).length === 0) && Array.isArray(raw.productOverview)) {
    const fromOverview: Record<string, string> = {};
    for (const item of raw.productOverview) {
      if (item && typeof item === 'object' && item.key && item.value) {
        fromOverview[String(item.key)] = String(item.value);
      }
    }
    specs = Object.keys(fromOverview).length ? fromOverview : specs;
  }

  const brand =
    String(raw.brand || '').trim() ||
    String(raw.marca || '').trim() ||
    undefined;
  const fulfillmentProvider = String(raw.sold_by || '').trim() || undefined;

  return {
    asin,
    title,
    description,
    price: Number.isFinite(price!) ? price : undefined,
    originalPrice: Number.isFinite(originalPrice!) ? originalPrice : undefined,
    image,
    gallery,
    brand,
    merchant,
    currency: String(raw.currency || 'EUR').trim() || 'EUR',
    inStock,
    rating: Number.isFinite(rating!) ? rating : undefined,
    reviewsCount: Number.isFinite(reviewsCount!) ? reviewsCount : undefined,
    specs: specs && Object.keys(specs).length ? specs : undefined,
    techSheet: undefined,
    affiliateUrl: String(
      raw.affiliate_url ||
        raw.affiliateUrl ||
        `https://www.amazon.es/dp/${asin || 'B000000000'}?tag=${ASSOCIATE_TAG}`,
    ).trim(),
    buyNowUrl: String(raw.buy_now_url || raw.buyNowUrl || '').trim() || undefined,
    sourceId: asin,
    network: 'amazon',
    raw,
    videos: videos.length ? videos : undefined,
    extra: {
      fulfillmentProvider,
      pros,
      cons,
      sourceDescription: description,
      ...(videos.length ? { videos } : {}),
    },
  };
}

/* ───────────────────────────────────────────────────────────────────────────
   4. PASO C — ENRIQUECIMIENTO POR IA (ESQUEMA ESTRUCTURADO)
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Enriquece un producto normalizado de Amazon con IA (texto) y opcionalmente
 * con imagen. Aplica overlay sobre la base local para no borrar datos con
 * campos vacíos. Devuelve el producto listo para guardar (forma plana).
 */
export async function enrichAmazonProductData(
  normalized: NormalizedAmazonProduct,
  options: ImportAmazonOptions = {}
): Promise<FlatProduct> {
  const localInput: LocalEnrichInput = {
    title: normalized.title,
    description: normalized.description,
    brand: normalized.brand,
    merchant: normalized.merchant,
    price: normalized.price,
    originalPrice: normalized.originalPrice,
    rating: normalized.rating,
    reviewsCount: normalized.reviewsCount,
    url: normalized.affiliateUrl,
    specs: normalized.specs,
  };
  const baseLocal = enrichProductLocally(localInput);

  let enrichment: EnrichedText | null = null;
  if (hasTextCredentials()) {
    try {
      const ai = await enrichProductText(
        {
          title: normalized.title,
          description: normalized.description,
          category: normalized.specs ? undefined : undefined,
          url: normalized.affiliateUrl,
          price: normalized.price,
          originalPrice: normalized.originalPrice,
          specs: normalized.specs,
        },
        { provider: options.textProvider },
      );
      enrichment = overlayEnrichedText(baseLocal, ai);
    } catch (error: any) {
      enrichment = baseLocal;
    }
  } else {
    enrichment = baseLocal;
  }

  const finalTitle = enrichment?.title?.trim() || normalized.title;
  const finalDescription = enrichment?.description?.trim() || normalized.description || '';
  const finalSpecs =
    enrichment?.specs && Object.keys(enrichment.specs).length
      ? { ...(normalized.specs ?? {}), ...enrichment.specs }
      : normalized.specs;
  const finalTechSheet = enrichment?.techSheet?.trim() || normalized.techSheet;
  const finalBrand =
    normalized.brand || enrichment?.brand || normalized.merchant || 'Comercio Externo';
  const finalCategory = enrichment?.category || 'Tecnología';

  // Precios: respetar precio de scraping si existe, si no par realista.
  let price = normalized.price ?? enrichment?.pricing?.price ?? 0;
  let originalPrice =
    normalized.originalPrice ?? enrichment?.pricing?.originalPrice;
  if (!price || price <= 0) {
    const realistic = buildRealisticPricing();
    price = realistic.price;
    originalPrice = realistic.originalPrice;
  } else if (!originalPrice || originalPrice <= price) {
    originalPrice = buildRealisticPricing(price).originalPrice;
  }

  const balanced = enforceMoreProsThanCons(
    enrichment?.pros ?? [],
    enrichment?.cons ?? [],
  );

  const affiliateUrl =
    normalized.affiliateUrl ||
    `https://www.amazon.es/dp/${normalized.asin}?tag=${ASSOCIATE_TAG}`;

  const baseId = `amazon-${normalized.asin.toLowerCase()}`;

  const base: FlatProduct = {
    id: baseId,
    title: finalTitle,
    description: finalDescription,
    price,
    originalPrice: originalPrice ?? price * 1.2,
    image: normalized.image || normalized.gallery?.[0] || '',
    gallery: normalized.gallery?.length
      ? [...normalized.gallery]
      : normalized.image
        ? [normalized.image]
        : undefined,
    category: finalCategory,
    merchant: normalized.merchant,
    brand: finalBrand,
    affiliateUrl,
    buyNowUrl: normalized.buyNowUrl || getAmazonAddToCartUrl(normalized.asin),
    asin: normalized.asin,
    pros: balanced.pros,
    cons: balanced.cons,
    verdict: enrichment?.verdict,
    techSheet: finalTechSheet,
    specs: finalSpecs,
    rating: normalized.rating,
    reviewsCount: normalized.reviewsCount,
    badge: computeBadge({
      id: baseId,
      title: finalTitle,
      description: finalDescription,
      price,
      originalPrice: originalPrice ?? price * 1.2,
      image: normalized.image || '',
      category: finalCategory,
      merchant: normalized.merchant,
      brand: finalBrand,
      affiliateUrl,
      pros: balanced.pros,
      cons: balanced.cons,
      rating: normalized.rating,
      reviewsCount: normalized.reviewsCount,
    } as unknown as AdminProduct),
    network: 'amazon',
    currency: normalized.currency,
    inStock: normalized.inStock,
    sourceId: normalized.asin,
    ia_status: 'completed',
    link_status: 'active',
    fulfillmentProvider: 'Amazon Logistics',
    extra: {
      scraperApiSource: normalized.raw,
      importSource: 'scraperapi-amazon',
    },
  };

  return base;
}

/* ───────────────────────────────────────────────────────────────────────────
   5. PASO D — PERSISTENCIA UPSERT POR ASIN
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Upsert usando el ASIN como clave primaria única para evitar duplicados.
 * Busca si ya existe un producto con este ASIN en `asin`, `sourceId` o
 * `extra.asin` y lo actualiza; si no existe, lo crea al principio del array.
 * Devuelve el producto guardado, si fue actualización y el ASIN.
 */
export function upsertAmazonProductByAsin(
  product: FlatProduct,
): { product: FlatProduct; updated: boolean; asin: string } {
  const asin = sanitizeAsin(
    product.asin || product.sourceId || '',
  );
  if (!isValidAsin(asin)) {
    throw new Error(
      `No se puede hacer upsert sin un ASIN válido (recibido: ${product.asin || product.sourceId}).`,
    );
  }

  const products = readJsonArrayFile<FlatProduct>(DATA_FILE_PATH);

  const existingIndex = products.findIndex((p) => {
    const pAsin = sanitizeAsin(p.asin || p.sourceId || '');
    const extraAsin =
      p.extra && typeof p.extra === 'object' && !Array.isArray(p.extra)
        ? String((p.extra as Record<string, unknown>).asin ?? '').trim()
        : '';
    return Boolean(pAsin && pAsin === asin) || Boolean(extraAsin && extraAsin === asin);
  });

  const updated = existingIndex >= 0;
  if (updated) {
    const existing = products[existingIndex];
    // Conservar campos de curación existentes (no se pisan por una re-importación).
    const curationFields = [
      'sourceId', 'category', 'category_id', 'subcategory_id', 'ia_status', 'link_status',
      'normalized_tags', 'alternative_product_ids', 'alternatives',
      'conversion_score', 'audit_status', 'audit_score', 'audit_reasons',
      'pipeline_version', 'pipeline_run_at', 'ai_enriched', 'ai_error',
      'sourceDescription',
    ];
    for (const field of curationFields) {
      const existingObj = existing as unknown as Record<string, unknown>;
      const productObj = product as unknown as Record<string, unknown>;
      if (existingObj[field] !== undefined) {
        productObj[field] = existingObj[field];
      }
    }
    // Fusión superficial de `extra` para no perder datos previos.
    if (existing.extra) {
      product.extra = {
        ...(existing.extra as Record<string, unknown>),
        ...((product.extra ?? {}) as Record<string, unknown>),
      };
    }
    products[existingIndex] = product;
  } else {
    products.unshift(product);
  }

  if (!writeJsonArrayFile(DATA_FILE_PATH, products)) {
    throw new Error('Error de escritura en el servidor de archivos.');
  }

  // Invalidar el caché en memoria del catálogo para que getCatalogProducts()
  // devuelva los datos recién escritos en la próxima lectura.
  invalidateCatalogCache();

  return { product, updated, asin };
}

/* ───────────────────────────────────────────────────────────────────────────
   6. ORQUESTADOR COMPLETO
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * Ejecuta el pipeline completo de Amazon para un ASIN o URL de producto:
 *
 *   1. Extraer/validar ASIN (10 chars) desde URL o ASIN directo.
 *   2. Llamar a ScraperAPI (country_code=es).
 *   3. Normalizar campos crudos al modelo interno.
 *   4. Enriquecer con IA (texto + imagen opcional).
 *   5. Upsert por ASIN (deduplicación) en products.json.
 *
 * Devuelve { success, product, updated, asin, message, warnings }.
 */
export async function importAmazonProduct(
  asinOrUrl: string,
  options: ImportAmazonOptions = {},
): Promise<ImportAmazonResult> {
  const warnings: string[] = [];

  // 1) Extraer / validar ASIN
  let asin: string;
  try {
    asin = extractOrValidateAsin(asinOrUrl);
  } catch (error: any) {
    return {
      success: false,
      message: error?.message || 'ASIN inválido',
      warnings,
    };
  }

  // 2) ScraperAPI (región configurable)
  let raw: AmazonScrapedProduct;
  try {
    raw = await scrapeAmazonProduct(asin, { countryCode: options.countryCode });
  } catch (error: any) {
    return {
      success: false,
      message: `Error de ScraperAPI: ${error?.message || error}`,
      warnings,
      asin,
    };
  }

  // 3) Normalizar
  const normalized = normalizeScrapedAmazonData(raw);

  // 4) Enriquecer con IA
  let enriched: FlatProduct;
  try {
    enriched = await enrichAmazonProductData(normalized, {
      textProvider: options.textProvider,
      imageProvider: options.imageProvider,
    });
  } catch (error: any) {
    warnings.push(
      `IA de texto no disponible: ${error?.message || error}. Producto con datos locales.`,
    );
    enriched = {
      id: `amazon-${asin.toLowerCase()}`,
      title: normalized.title,
      description: normalized.description || '',
      price: normalized.price ?? 0,
      originalPrice: normalized.originalPrice ?? (normalized.price ?? 0) * 1.2,
      image: normalized.image || '',
      gallery: normalized.gallery,
      category: 'Tecnología',
      merchant: normalized.merchant,
      brand: normalized.brand || normalized.merchant || 'Comercio Externo',
      affiliateUrl: normalized.affiliateUrl || '',
      buyNowUrl: normalized.buyNowUrl || getAmazonAddToCartUrl(asin),
      asin,
      pros: [],
      cons: [],
      network: 'amazon',
      currency: normalized.currency,
      inStock: normalized.inStock,
      sourceId: asin,
      specs: normalized.specs,
      rating: normalized.rating,
      reviewsCount: normalized.reviewsCount,
      techSheet: normalized.techSheet,
      verdict: undefined,
      link_status: 'active',
      ia_status: 'completed',
      fulfillmentProvider: 'Amazon Logistics',
      extra: { scraperApiSource: normalized.raw, importSource: 'scraperapi-amazon' },
    };
  }

  // 5) Upsert por ASIN
  let saved = false;
  let updated = false;
  if (options.save !== false) {
    try {
      const result = upsertAmazonProductByAsin(enriched);
      saved = true;
      updated = result.updated;
    } catch (error: any) {
      return {
        success: false,
        message: `Error al guardar: ${error?.message || error}`,
        warnings,
        asin,
      };
    }
  }

  return {
    success: true,
    product: enriched,
    updated,
    saved,
    asin,
    message: saved
      ? updated
        ? 'Producto actualizado (upsert por ASIN).'
        : 'Producto guardado (upsert por ASIN).'
      : 'Vista previa generada (no guardada).',
    warnings,
  };
}

/**
 * Ejecuta el pipeline de Amazon a partir de un JSON crudo de ScraperAPI que
 * el cliente ya obtuvo externamente (evita que el servidor de Tradylor tenga
 * que llamar a ScraperAPI y así se saltea bloqueos IP / anti-bot de Amazon).
 *
 * Pasos:
 *   1. Validar ASIN.
 *   2. Normalizar el JSON crudo al modelo interno (salta la llamada a ScraperAPI).
 *   3. Enriquecer con IA (texto editorial + imagen opcional).
 *   4. Upsert por ASIN (deduplicación) en products.json.
 *
 * Devuelve { success, product, updated, asin, message, warnings }.
 */
export async function importAmazonProductFromRawJson(
  asin: string,
  raw: AmazonScrapedProduct,
  options: ImportAmazonOptions = {},
): Promise<ImportAmazonResult> {
  const warnings: string[] = [];

  // 1) Validar ASIN
  let cleanAsin: string;
  try {
    cleanAsin = extractOrValidateAsin(asin);
  } catch (error: any) {
    return {
      success: false,
      message: error?.message || 'ASIN inválido',
      warnings,
    };
  }

  // 2) Normalizar JSON crudo (sin llamar a ScraperAPI)
  const normalized = normalizeScrapedAmazonData(raw, cleanAsin);

  // 3) Enriquecer con IA
  let enriched: FlatProduct;
  try {
    enriched = await enrichAmazonProductData(normalized, {
      textProvider: options.textProvider,
      imageProvider: options.imageProvider,
    });
  } catch (error: any) {
    warnings.push(
      `IA de texto no disponible: ${error?.message || error}. Producto con datos locales.`,
    );
    enriched = {
      id: `amazon-${cleanAsin.toLowerCase()}`,
      title: normalized.title,
      description: normalized.description || '',
      price: normalized.price ?? 0,
      originalPrice: normalized.originalPrice ?? (normalized.price ?? 0) * 1.2,
      image: normalized.image || '',
      gallery: normalized.gallery,
      category: 'Tecnología',
      merchant: normalized.merchant,
      brand: normalized.brand || normalized.merchant || 'Comercio Externo',
      affiliateUrl: normalized.affiliateUrl || '',
      buyNowUrl: normalized.buyNowUrl || getAmazonAddToCartUrl(cleanAsin),
      asin: cleanAsin,
      pros: [],
      cons: [],
      network: 'amazon',
      currency: normalized.currency,
      inStock: normalized.inStock,
      sourceId: cleanAsin,
      specs: normalized.specs,
      rating: normalized.rating,
      reviewsCount: normalized.reviewsCount,
      techSheet: normalized.techSheet,
      verdict: undefined,
      link_status: 'active',
      ia_status: 'completed',
      fulfillmentProvider: 'Amazon Logistics',
      extra: { scraperApiSource: normalized.raw, importSource: 'scraperapi-amazon-json' },
    };
  }

  // 4) Upsert por ASIN
  let saved = false;
  let updated = false;
  if (options.save !== false) {
    try {
      const result = upsertAmazonProductByAsin(enriched);
      saved = true;
      updated = result.updated;
    } catch (error: any) {
      return {
        success: false,
        message: `Error al guardar: ${error?.message || error}`,
        warnings,
        asin: cleanAsin,
      };
    }
  }

  return {
    success: true,
    product: enriched,
    updated,
    saved,
    asin: cleanAsin,
    message: saved
      ? updated
        ? 'Producto actualizado (upsert por ASIN desde JSON).'
        : 'Producto guardado (upsert por ASIN desde JSON).'
      : 'Vista previa generada desde JSON (no guardada).',
    warnings,
  };
}

/**
 * Valida (sin persistir) que un ASIN o URL de Amazon sea correcto y que
 * ScraperAPI devuelva datos. Útil para pre-visualizar antes de guardar.
 */
export async function validateAmazonInput(asinOrUrl: string): Promise<{
  valid: boolean;
  asin?: string;
  title?: string;
  message?: string;
}> {
  let asin: string;
  try {
    asin = extractOrValidateAsin(asinOrUrl);
  } catch (error: any) {
    return { valid: false, message: error?.message || 'ASIN inválido' };
  }
  try {
    const raw = await scrapeAmazonProduct(asin);
    const normalized = normalizeScrapedAmazonData(raw);
    return {
      valid: true,
      asin: normalized.asin,
      title: normalized.title,
    };
  } catch (error: any) {
    return {
      valid: false,
      asin,
      message: `Error de ScraperAPI: ${error?.message || error}`,
    };
  }
}

/**
 * Esquema de salida estructurado (JSON Schema compatible con Zod) que
 * coincide con el modelo de base de datos de content.config.ts. Se usa para
 * validar el producto antes de persistirlo.
 */
export const amazonProductOutputSchema = productSchema;

/**
 * Valida un producto plano (FlatProduct) contra el esquema Zod de BD y lo
 * devuelve normalizado, o null si no cumple.
 */
export function validateAmazonProductForDb(
  product: FlatProduct,
): FlatProduct | null {
  const structured = safeValidate(product);
  if (!structured.success) {
    console.warn(
      '[AmazonImport] Producto no válido para BD:',
      structured.error?.issues?.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
    return null;
  }
  return product;
}
