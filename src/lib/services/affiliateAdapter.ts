/**
 * ==============================================================================
 * TRADYLOR - ADAPTADOR UNIVERSAL DE CAPTURA DE COMERCIANTES
 * ==============================================================================
 * Extrae el 100% de datos disponibles (imágenes, atributos, specs, galería completa)
 * de cualquier red de afiliación o página de producto, normalizando a formato unificado.
 *
 * Diseño incremental: NO rompe conectores existentes, los ENVUELVE y EXTIENDE.
 * ==============================================================================
 */

import type { UnifiedProduct, UnifiedSearchParams } from '../networks/types';
import { getConnector } from '../networks';
import { extractMetadata, scrapeProductPage, type ScrapePageResult } from '../../pages/api/products/add';
import { complementProductFromPage } from '../../pages/api/products/add';
import { type Product } from '../productStore';
import { readRawAffiliateProducts, upsertRawAffiliateProduct, type RawAffiliateProduct } from './databaseSchema';

/**
 * Configuración del adaptador por red/comerciante
 */
export interface AdapterConfig {
  network: string;
  /** Capturar galería completa (todas las imágenes, no solo la principal) */
  captureFullGallery: boolean;
  /** Hacer scraping de la página del producto para completar huecos */
  scrapeProductPage: boolean;
  /** Timeout para scraping (ms) */
  scrapeTimeoutMs: number;
  /** Mapeo de campos extra de la red a campos normalizados */
  fieldMapping?: Record<string, string>;
  /** Categorías propias de la red que mapear a nuestras categorías */
  categoryMapping?: Record<string, string>;
}

/**
 * Configuración por defecto por red
 */
const DEFAULT_ADAPTER_CONFIGS: Record<string, AdapterConfig> = {
  amazon: {
    network: 'amazon',
    captureFullGallery: true,
    scrapeProductPage: true,
    scrapeTimeoutMs: 10000,
    fieldMapping: {
      'ASIN': 'asin',
      'Marca': 'brand',
      'Modelo': 'model',
    },
    categoryMapping: {},
  },
  aliexpress: {
    network: 'aliexpress',
    captureFullGallery: true,
    scrapeProductPage: true,
    scrapeTimeoutMs: 12000,
    fieldMapping: {
      'product_id': 'sourceId',
      'product_brand_name': 'brand',
      'shop_name': 'merchant',
      'first_level_category_name': 'category',
      'second_level_category_name': 'subcategory',
    },
    categoryMapping: {},
  },
  awin: {
    network: 'awin',
    captureFullGallery: true,
    scrapeProductPage: false,
    scrapeTimeoutMs: 8000,
    fieldMapping: {},
    categoryMapping: {},
  },
  cj: {
    network: 'cj',
    captureFullGallery: true,
    scrapeProductPage: false,
    scrapeTimeoutMs: 8000,
    fieldMapping: {},
    categoryMapping: {},
  },
  admitad: {
    network: 'admitad',
    captureFullGallery: true,
    scrapeProductPage: false,
    scrapeTimeoutMs: 8000,
    fieldMapping: {},
    categoryMapping: {},
  },
  tradedoubler: {
    network: 'tradedoubler',
    captureFullGallery: true,
    scrapeProductPage: false,
    scrapeTimeoutMs: 8000,
    fieldMapping: {},
    categoryMapping: {},
  },
  kwanko: {
    network: 'kwanko',
    captureFullGallery: true,
    scrapeProductPage: false,
    scrapeTimeoutMs: 8000,
    fieldMapping: {},
    categoryMapping: {},
  },
  etsy: {
    network: 'etsy',
    captureFullGallery: true,
    scrapeProductPage: true,
    scrapeTimeoutMs: 10000,
    fieldMapping: {},
    categoryMapping: {},
  },
  ebay: {
    network: 'ebay',
    captureFullGallery: true,
    scrapeProductPage: true,
    scrapeTimeoutMs: 10000,
    fieldMapping: {},
    categoryMapping: {},
  },
  generic: {
    network: 'generic',
    captureFullGallery: true,
    scrapeProductPage: true,
    scrapeTimeoutMs: 8000,
    fieldMapping: {},
    categoryMapping: {},
  },
};

/**
 * Resultado de la captura adaptada
 */
export interface AdaptedProduct {
  /** Producto normalizado listo para el pipeline de enriquecimiento */
  product: UnifiedProduct & {
    /** Imágenes extra capturadas (más allá de image + gallery) */
    allImages?: string[];
    /** Datos extra específicos de la red */
    networkExtra?: Record<string, unknown>;
    /** URL de la página de producto original (para scraping posterior) */
    sourceUrl?: string;
  };
  /** Payload crudo completo guardado en raw_affiliate_products */
  rawPayload: RawAffiliateProduct;
  /** Advertencias/notas del proceso de captura */
  warnings: string[];
}

/**
 * Clase principal: Adaptador Universal de Afiliados
 */
export class AffiliateAdapter {
  private config: AdapterConfig;

  constructor(network: string, customConfig?: Partial<AdapterConfig>) {
    const baseConfig = DEFAULT_ADAPTER_CONFIGS[network] || DEFAULT_ADAPTER_CONFIGS.generic;
    this.config = { ...baseConfig, ...customConfig };
  }

  /**
   * Captura un producto individual por su ID externo en la red
   */
  async captureProduct(externalId: string): Promise<AdaptedProduct | null> {
    const connector = getConnector(this.config.network);
    if (!connector) {
      throw new Error(`Conector no disponible para la red: ${this.config.network}`);
    }

    // Buscar el producto en la red
    const results = await connector.search({
      query: externalId,
      limit: 1,
    });

    if (!results.length) {
      return null;
    }

    const unifiedProduct = results[0];
    return this.adaptProduct(unifiedProduct);
  }

  /**
   * Captura múltiples productos desde una búsqueda
   */
  async captureProducts(params: UnifiedSearchParams): Promise<AdaptedProduct[]> {
    const connector = getConnector(this.config.network);
    if (!connector) {
      throw new Error(`Conector no disponible para la red: ${this.config.network}`);
    }

    const results = await connector.search(params);
    const adapted: AdaptedProduct[] = [];

    for (const unifiedProduct of results) {
      try {
        const adaptedProduct = await this.adaptProduct(unifiedProduct);
        if (adaptedProduct) adapted.push(adaptedProduct);
      } catch (error) {
        console.warn(`[AffiliateAdapter] Error adaptando ${unifiedProduct.externalId}:`, error);
      }
    }

    return adapted;
  }

  /**
   * Adapta un UnifiedProduct a formato enriquecido + guarda raw payload
   */
  private async adaptProduct(unified: UnifiedProduct): Promise<AdaptedProduct> {
    const warnings: string[] = [];

    // 1. Guardar payload crudo INMEDIATAMENTE (auditoría, re-procesamiento)
    const rawPayload: RawAffiliateProduct = {
      id: `raw-${this.config.network}-${unified.externalId}-${Date.now().toString(36)}`,
      network: this.config.network,
      externalId: unified.externalId,
      rawPayload: unified as unknown as Record<string, unknown>,
      capturedAt: new Date().toISOString(),
      processed: false,
    };
    upsertRawAffiliateProduct(rawPayload);

    // 2. Extraer TODAS las imágenes disponibles (galería completa)
    let allImages: string[] = [];
    if (this.config.captureFullGallery) {
      allImages = this.extractAllImages(unified);
    }

    // 3. Scraping de la página del producto si está habilitado y hay URL
    let scrapedData: ReturnType<typeof extractMetadata> | null = null;
    if (this.config.scrapeProductPage && unified.productUrl) {
      try {
        const scrapeResult = await scrapeProductPage(unified.productUrl, {
          timeoutMs: this.config.scrapeTimeoutMs,
        });
        if (scrapeResult.ok && scrapeResult.data) {
          scrapedData = scrapeResult.data;
          // Fusionar imágenes del scraping
          if (scrapedData.gallery?.length) {
            for (const img of scrapedData.gallery) {
              if (!allImages.includes(img)) allImages.push(img);
            }
          }
          if (scrapedData.imageCandidates?.length) {
            for (const img of scrapedData.imageCandidates) {
              if (!allImages.includes(img)) allImages.push(img);
            }
          }
        } else if (scrapeResult.blocked) {
          warnings.push(`Scraping bloqueado por ${this.config.network} (CAPTCHA/bot detection)`);
        } else {
          warnings.push(`Scraping falló: ${scrapeResult.message}`);
        }
      } catch (error) {
        warnings.push(`Error en scraping: ${error instanceof Error ? error.message : 'desconocido'}`);
      }
    }

    // 4. Construir producto adaptado con TODOS los datos disponibles
    const adaptedProduct: AdaptedProduct['product'] = {
      ...unified,
      // Galería completa unificada (máx 50 para no saturar)
      gallery: allImages.slice(0, 50),
      allImages: allImages.slice(0, 100),
      // Datos extra de la red
      networkExtra: unified.extra,
      // URL fuente para referencia
      sourceUrl: unified.productUrl,
    };

    // 5. Aplicar mapeo de campos extra si existe
    if (unified.extra && this.config.fieldMapping) {
      for (const [sourceKey, targetKey] of Object.entries(this.config.fieldMapping)) {
        if (unified.extra[sourceKey] && !adaptedProduct[targetKey as keyof typeof adaptedProduct]) {
          (adaptedProduct as Record<string, unknown>)[targetKey] = unified.extra[sourceKey];
        }
      }
    }

    // 6. Mapear categoría si hay mapping
    if (this.config.categoryMapping && unified.category) {
      const mapped = this.config.categoryMapping[unified.category];
      if (mapped) adaptedProduct.category = mapped;
    }

    return {
      product: adaptedProduct,
      rawPayload,
      warnings,
    };
  }

  /**
   * Extrae TODAS las imágenes disponibles del UnifiedProduct
   */
  private extractAllImages(unified: UnifiedProduct): string[] {
    const images: string[] = [];

    // Imagen principal
    if (unified.image) images.push(unified.image);

    // Galería del conector
    if (unified.gallery?.length) {
      for (const img of unified.gallery) {
        if (!images.includes(img)) images.push(img);
      }
    }

    // Imágenes extra del campo extra (algunas redes las ponen ahí)
    if (unified.extra) {
      const extraImages = unified.extra['Imágenes'] || unified.extra['images'] || unified.extra['gallery'];
      if (typeof extraImages === 'string') {
        // Formato "url1 | url2 | url3"
        for (const part of extraImages.split('|')) {
          const url = part.trim();
          if (url && !images.includes(url)) images.push(url);
        }
      } else if (Array.isArray(extraImages)) {
        for (const url of extraImages) {
          if (url && !images.includes(url)) images.push(String(url));
        }
      }
    }

    return images;
  }

  /**
   * Captura masiva desde el catálogo sincronizado (affiliate-catalog.json)
   * Procesa TODOS los productos de una red en lotes
   */
  async captureFullCatalog(batchSize = 50): Promise<{
    total: number;
    captured: number;
    failed: number;
    warnings: string[];
  }> {
    const connector = getConnector(this.config.network);
    if (!connector) {
      throw new Error(`Conector no disponible para la red: ${this.config.network}`);
    }

    // Usar el catálogo ya sincronizado (rápido, sin llamadas API)
    const { readAffiliateCatalog } = await import('../../pages/api/admin/catalog/index');
    const snapshot = readAffiliateCatalog();
    if (!snapshot?.products?.length) {
      return { total: 0, captured: 0, failed: 0, warnings: ['Catálogo vacío: sincroniza primero desde el panel'] };
    }

    const networkProducts = snapshot.products.filter(p => p.network === this.config.network);
    const warnings: string[] = [];
    let captured = 0;
    let failed = 0;

    // Procesar en lotes para no saturar memoria
    for (let i = 0; i < networkProducts.length; i += batchSize) {
      const batch = networkProducts.slice(i, i + batchSize);
      for (const product of batch) {
        try {
          await this.adaptProduct(product);
          captured++;
        } catch (error) {
          failed++;
          warnings.push(`Error en ${product.externalId}: ${error instanceof Error ? error.message : 'desconocido'}`);
        }
      }
      // Pequeña pausa entre lotes
      if (i + batchSize < networkProducts.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    return {
      total: networkProducts.length,
      captured,
      failed,
      warnings,
    };
  }
}

/**
 * Función helper: crea adaptador para una red
 */
export function createAdapter(network: string, customConfig?: Partial<AdapterConfig>): AffiliateAdapter {
  return new AffiliateAdapter(network, customConfig);
}

/**
 * Función helper: captura un producto de cualquier red (auto-detecta por URL)
 */
export async function captureProductFromUrl(url: string): Promise<AdaptedProduct | null> {
  // Detectar red por URL
  let network = 'generic';
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes('amazon.')) network = 'amazon';
    else if (hostname.includes('aliexpress.')) network = 'aliexpress';
    else if (hostname.includes('ebay.')) network = 'ebay';
    else if (hostname.includes('etsy.')) network = 'etsy';
    // Awin, CJ, etc. usan dominios variados - se necesita más contexto
  } catch {
    // URL inválida
  }

  const adapter = createAdapter(network);
  // Para URL directa, necesitamos el externalId - intentamos extraerlo
  const connector = getConnector(network);
  if (!connector) return null;

  // Buscar por URL como query
  const results = await connector.search({ query: url, limit: 1 });
  if (!results.length) return null;

  return adapter.adaptProduct(results[0]);
}

/**
 * Enriquece un producto capturado con datos de su página (scraping + IA fallback)
 * Reutiliza la lógica existente de complementProductFromPage
 */
export async function enrichCapturedProduct(
  adapted: AdaptedProduct,
  options: { title?: string; timeoutMs?: number } = {}
): Promise<AdaptedProduct> {
  // Convertir a formato que espera complementProductFromPage
  const productData: Record<string, any> = {
    ...adapted.product,
    url: adapted.product.sourceUrl || adapted.product.productUrl,
    complement: true, // Forzar complemento
  };

  const warnings: string[] = [...adapted.warnings];

  await complementProductFromPage(productData, warnings, options);

  // Fusionar datos enriquecidos
  const enrichedProduct: AdaptedProduct['product'] = {
    ...adapted.product,
    ...productData,
    // Mantener allImages capturado originalmente
    allImages: adapted.product.allImages,
    networkExtra: adapted.product.networkExtra,
    sourceUrl: adapted.product.sourceUrl,
  };

  return {
    ...adapted,
    product: enrichedProduct,
    warnings,
  };
}