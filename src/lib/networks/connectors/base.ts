/**
 * ==============================================================================
 * TRADYLOR - CONECTOR BASE
 * ==============================================================================
 * Contrato que cumple cada conector de red. Los conectores reales llaman a las
 * APIs oficiales (PA-API 5.0, Browse API, Awin Publisher API...); cuando la red
 * no tiene credenciales o la API aún no está cableada, devuelven datos de
 * muestra claramente marcados con `estimated: true` para no bloquear la UI.
 * ==============================================================================
 */

import type { CanonicalAffiliateProduct, UnifiedProduct, UnifiedSearchParams } from '../types';

export interface NetworkConnector {
  readonly networkId: string;
  /** Valida las credenciales almacenadas contra la API real de la red. */
  validate(): Promise<{ ok: boolean; message: string }>;
  /** Busca productos normalizados en la red. */
  search(params: UnifiedSearchParams): Promise<UnifiedProduct[]>;
  /**
   * Búsqueda/sincronización al contrato canónico `CanonicalAffiliateProduct`
   * (alimenta el pipeline de catálogo). Opcional: las redes que aún no
   * implementen el mapeo canónico no la declaran.
   */
  searchCanonical?(params: UnifiedSearchParams): Promise<CanonicalAffiliateProduct[]>;
}

/**
 * Convierte un producto canónico a UnifiedProduct para las rutas de UI
 * existentes (búsqueda unificada, tablas del panel). Aditivo: no cambia el
 * contrato de UnifiedProduct ni de los consumidores actuales.
 *
 * Cubre todos los campos que lee la tabla del panel de Afiliados (Tienda,
 * Descuento, Días de envío, Ventas, Comisión estimada) tanto en las columnas
 * como en el desplegable de detalle y en el payload de importación.
 */
export function canonicalToUnified(product: CanonicalAffiliateProduct): UnifiedProduct {
  const shipDaysRaw = Number(product.technicalSpecs?.['Días de envío']);
  const hasShipDays = Number.isFinite(shipDaysRaw) && shipDaysRaw > 0;
  const shipDays = hasShipDays ? shipDaysRaw : undefined;
  const allImages = [product.mainImage, ...product.extraImages].filter(Boolean);

  // Descuento: el declarado por la red o derivado del par precio/precio original
  const discountPct = product.discountPercentage
    || (product.price > 0 && product.originalPrice > product.price
      ? Math.round(((product.originalPrice - product.price) / product.originalPrice) * 10000) / 100
      : 0);

  // Comisión estimada en EUR: la de la red o la derivada del % x precio
  const commissionAmount = product.estimatedCommission > 0
    ? product.estimatedCommission
    : product.commissionRate && product.price
      ? Math.round(product.price * (product.commissionRate / 100) * 100) / 100
      : undefined;

  return {
    network: product.network,
    externalId: product.externalId,
    title: product.title,
    description: product.description,
    price: product.price,
    originalPrice: product.originalPrice > product.price ? product.originalPrice : undefined,
    currency: product.currency,
    image: product.mainImage,
    gallery: product.extraImages.length ? product.extraImages : undefined,
    category: product.category,
    productUrl: product.affiliateUrl || product.directUrl,
    brand: product.brand || undefined,
    commissionRate: product.commissionRate || undefined,
    commissionAmount,
    rating: product.rating || undefined,
    reviewsCount: product.reviewCount || undefined,
    popularity: product.sales || undefined,
    inStock: product.inStock,
    shippingInfo: hasShipDays ? `Envío en ${shipDays} días` : undefined,
    shippingDays: shipDays,
    estimated: product.estimated === true,
    extra: {
      'ID externo': product.externalId,
      Marca: product.brand ?? null,
      Distribuidor: product.merchantName || null,
      Tienda: product.merchantName || null,
      'ID tienda': product.merchantId || null,
      'Categoría nivel 1': product.category || null,
      'Categoría nivel 2': product.subCategory || null,
      'Descuento': discountPct ? `${discountPct}%` : null,
      'Comisión (%)': product.commissionRate || null,
      'Comisión hot (%)': product.hotCommissionRate || null,
      'Comisión estimada': commissionAmount ?? null,
      'EPC': product.epc ?? null,
      'Score de conversión': product.conversionScore ?? null,
      'Valoración': product.rating || null,
      'Reseñas': product.reviewCount || null,
      'Ventas (30 días)': product.sales || null,
      'Días de envío': shipDays ?? null,
      'Garantía': product.guarantee || null,
      'Mínimo histórico': product.historicalLow ? 'Sí' : null,
      'Resumen editorial': product.editorialSummary || null,
      'Puntos': product.pros?.length ? product.pros.join(' · ') : null,
      'Pegas': product.cons?.length ? product.cons.join(' · ') : null,
      'URL directa': product.directUrl || null,
      'Enlace de afiliado': product.affiliateUrl || null,
      'Enlace de compra directa': product.directUrl || null,
      'URL del producto': product.directUrl || null,
      'Imágenes': allImages.length ? allImages.join(' | ') : null,
      'Especificaciones': product.technicalSpecs && Object.keys(product.technicalSpecs).length
        ? Object.entries(product.technicalSpecs).map(([k, v]) => `${k}: ${v}`).join(' · ')
        : null,
      'Sincronizado': product.syncedAt,
    },
  };
}

/**
 * Busca en una red usando SIEMPRE el contrato canónico cuando la lo declara
 * (`searchCanonical` → `canonicalToUnified`); si aún no, cae a `search()`
 * descartando las muestras (`estimated`). Uniforme para AliExpress, eBay y
 * Amazon en el endpoint de catálogo y en la sincronización de la caché.
 */
export async function searchCatalogBatch(
  connector: NetworkConnector,
  params: UnifiedSearchParams,
): Promise<UnifiedProduct[]> {
  if (connector.searchCanonical) {
    const canonicalBatch = await connector.searchCanonical(params);
    // Nunca ingerir productos de muestra/respaldo (estimated) en la caché real
    return canonicalBatch.filter((product) => !product.estimated).map(canonicalToUnified);
  }
  const legacyBatch = await connector.search(params);
  // Nunca ingerir productos de muestra (estimated) en la caché real
  return legacyBatch.filter((product) => !product.estimated);
}

/** Error estándar de conector con mensaje legible para el panel. */
export class ConnectorError extends Error {
  constructor(
    public readonly networkId: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/** Helper: fetch con timeout para que una red caída nunca bloquee la búsqueda global. */
export async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Categorías que rotan al recorrer el catálogo completo de una red. */
const CATALOG_CATEGORIES = [
  'Tecnología',
  'Audio & Sonido',
  'Informática & Laptops',
  'Lectura Digital',
  'Hogar Inteligente',
  'Fotografía & Vídeo',
  'Gaming & Accesorios',
  'Herramientas',
];

const CATALOG_MODELS = [
  'serie premium',
  'edición compacta',
  'modelo profesional',
  'versión económica',
  'pack familiar',
  'modelo top gama',
  'alternativa ligera',
  'unidad reacondicionada',
];

/** Genera productos de muestra normalizados para maquetar la UI antes de cablear la API real. */
export function sampleProducts(networkId: string, params: UnifiedSearchParams, base: number): UnifiedProduct[] {
  const term = (params.query || 'producto').slice(0, 40);
  // Sin query = recorrido de catálogo completo: se devuelven más referencias
  // para poder importar en bloque desde el panel de Afiliados.
  const browsingCatalog = !params.query;
  const count = browsingCatalog ? Math.min(params.limit ?? 40, 40) : Math.min(params.limit ?? 8, 8);
  return Array.from({ length: count }, (_, index) => {
    const price = Math.round((base + index * 17.49 + (term.length * 1.3)) * 100) / 100;
    const commissionRate = 2 + ((base + index) % 9);
    const model = CATALOG_MODELS[(base + index) % CATALOG_MODELS.length];
    const title = browsingCatalog
      ? `${CATALOG_CATEGORIES[(base + index) % CATALOG_CATEGORIES.length]} — ${model} ${index + 1} (${networkId})`
      : `${term.charAt(0).toUpperCase()}${term.slice(1)} — modelo destacado ${index + 1} (${networkId})`;
    return {
      network: networkId,
      externalId: `${networkId}-demo-${base}-${index}`,
      title,
      description: `Resultado de muestra de la red ${networkId} para “${term}”. Conecta la API oficial para datos reales.`,
      price,
      originalPrice: Math.round(price * 1.18 * 100) / 100,
      currency: 'EUR',
      image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?q=80&w=800&auto=format&fit=crop',
      category:
        params.category ||
        (browsingCatalog ? CATALOG_CATEGORIES[(base + index) % CATALOG_CATEGORIES.length] : 'Tecnología'),
      productUrl: `https://example.com/${networkId}/producto/${index}`,
      commissionRate,
      commissionAmount: Math.round(price * (commissionRate / 100) * 100) / 100,
      rating: Math.round((3.6 + ((base + index) % 14) / 10) * 10) / 10,
      reviewsCount: 40 + base * 13 + index * 57,
      popularity: 50 + ((base + index * 7) % 50),
      inStock: (index + base) % 5 !== 0,
      shippingInfo: 'Envío estándar',
      estimated: true,
    };
  });
}
