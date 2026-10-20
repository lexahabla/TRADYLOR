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
 *
 * Los datos del `extra` passthrough canónico (claves legadas, valores de red que
 * no encajan en el esquema) se conservan y sólo se sobrescriben con los valores
 * regenerados del contrato canónico cuando estos tienen contenido.
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

  // Datos passthrough canónicos (sin nulos): completan lo que el esquema no cubre
  const passthrough: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(product.extra ?? {})) {
    if (value == null || value === '') continue;
    passthrough[key] = value;
  }

  const generated: Record<string, string | number | boolean | null> = {
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
  };

  const extra: Record<string, string | number | boolean | null> = { ...passthrough };
  for (const [key, value] of Object.entries(generated)) {
    if (value == null || value === '') continue;
    extra[key] = value;
  }
  // El texto crudo de especificaciones legado (si existe) es más rico que el
  // resumen regenerado a partir de technicalSpecs: se respeta.
  if (passthrough['Especificaciones'] != null) {
    extra['Especificaciones'] = passthrough['Especificaciones'];
  }

  // Envío: texto explícito (passthrough de red o legado) > derivado de los días
  const explicitShipping = firstString(passthrough['Texto de envío'], passthrough['Envío']);
  const shippingInfo = explicitShipping ?? (hasShipDays ? `Envío en ${shipDays} días` : undefined);

  return {
    network: product.network,
    externalId: product.externalId,
    title: product.title,
    description: product.description,
    price: product.price,
    originalPrice: product.originalPrice >= product.price && product.originalPrice > 0
      ? product.originalPrice
      : undefined,
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
    popularity: product.sales ?? undefined,
    visits: toNumberOrNull(passthrough['Visitas'])
      ?? toNumberOrNull(passthrough['Visitantes'])
      ?? toNumberOrNull(passthrough['Visits'])
      ?? undefined,
    inStock: product.inStock,
    shippingInfo,
    shippingDays: shipDays,
    firstSeenAt: product.firstSeenAt,
    estimated: product.estimated === true,
    extra,
  };
}

/** Primera cadena no vacía de la lista, o `undefined`. */
function firstString(...values: Array<string | number | boolean | null | undefined>): string | undefined {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return undefined;
}

/** Número finito desde string/número (`"15%"` → 15), o `null`. */
function toNumberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[^\d.,-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const parsed = Number(cleaned.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Detecta el contrato canónico en un JSON leído del disco (puede ser legado). */
export function isCanonicalProduct(value: unknown): value is CanonicalAffiliateProduct {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CanonicalAffiliateProduct>;
  return typeof candidate.mainImage === 'string' && Array.isArray(candidate.extraImages);
}

/**
 * Migra un UnifiedProduct de cachés legadas (pre-PASO 6) al contrato canónico.
 * Es la puente que permite que `affiliate-catalog.json` /
 * `aliexpress-catalog.json` pasen a persistir SÓLO `CanonicalAffiliateProduct`
 * sin perder los datos que la tabla del panel y los filtros leen del `extra`.
 */
export function unifiedToCanonical(product: UnifiedProduct, fallbackSyncedAt: string): CanonicalAffiliateProduct {
  const price = Number(product.price) || 0;
  const passthrough: Record<string, string | number | boolean | null> = { ...(product.extra ?? {}) };

  const discountRaw = toNumberOrNull(passthrough['Descuento']);
  const originalRaw = Number(product.originalPrice);
  const originalPrice = Number.isFinite(originalRaw) && originalRaw > price ? originalRaw : price;
  const discountPercentage = discountRaw != null && discountRaw >= 0
    ? Math.round(discountRaw * 100) / 100
    : originalPrice > price
      ? Math.round(((originalPrice - price) / originalPrice) * 10000) / 100
      : 0;

  const commissionRate = Number(product.commissionRate) || 0;
  const commissionAmountRaw = Number(product.commissionAmount);
  const estimatedCommission = Number.isFinite(commissionAmountRaw) && commissionAmountRaw > 0
    ? Math.round(commissionAmountRaw * 100) / 100
    : price > 0 && commissionRate > 0
      ? Math.round(price * (commissionRate / 100) * 100) / 100
      : 0;

  const mainImage = product.image || '';
  const gallery = (product.gallery ?? []).filter((url) => url && url !== mainImage);
  const extraImages = [mainImage, ...gallery].filter(Boolean);

  const technicalSpecs: Record<string, string> = {};
  const shipDaysValue = firstString(passthrough['Días de envío'])
    ?? (product.shippingDays != null && Number.isFinite(Number(product.shippingDays))
      ? String(product.shippingDays)
      : undefined);
  if (shipDaysValue) technicalSpecs['Días de envío'] = shipDaysValue;

  const pros = firstString(passthrough['Puntos'])?.split(' · ').map((s) => s.trim()).filter(Boolean);
  const cons = firstString(passthrough['Pegas'])?.split(' · ').map((s) => s.trim()).filter(Boolean);

  // El texto de envío legado se conserva como texto explícito del passthrough
  if (product.shippingInfo && !passthrough['Texto de envío']) {
    passthrough['Texto de envío'] = product.shippingInfo;
  }
  if (product.visits != null && passthrough['Visitas'] == null) {
    passthrough['Visitas'] = product.visits;
  }

  const popularity = Number(product.popularity);

  return {
    network: product.network,
    externalId: product.externalId,
    affiliateUrl: product.productUrl || '',
    directUrl: firstString(passthrough['URL directa'], passthrough['URL del producto']) ?? product.productUrl ?? '',
    title: product.title,
    description: product.description || product.title,
    editorialSummary: firstString(passthrough['Resumen editorial']) ?? undefined,
    price,
    originalPrice,
    currency: product.currency || 'EUR',
    discountPercentage,
    inStock: product.inStock !== false,
    commissionRate,
    estimatedCommission,
    hotCommissionRate: toNumberOrNull(passthrough['Comisión hot (%)']) ?? undefined,
    epc: toNumberOrNull(passthrough['EPC']) ?? undefined,
    category: product.category || 'General',
    subCategory: firstString(passthrough['Categoría nivel 2']) ?? undefined,
    brand: product.brand || firstString(passthrough['Marca'], passthrough['Brand']) || undefined,
    merchantName: firstString(passthrough['Tienda'], passthrough['Distribuidor'], passthrough['Vendedor']) || product.network,
    merchantId: firstString(passthrough['ID tienda']) ?? undefined,
    rating: Number(product.rating) || 0,
    reviewCount: Number(product.reviewsCount) || 0,
    sales: Number.isFinite(popularity) ? popularity : undefined,
    mainImage,
    extraImages,
    technicalSpecs: Object.keys(technicalSpecs).length ? technicalSpecs : undefined,
    pros: pros?.length ? pros : undefined,
    cons: cons?.length ? cons : undefined,
    conversionScore: toNumberOrNull(passthrough['Score de conversión']) ?? undefined,
    historicalLow: passthrough['Mínimo histórico'] === 'Sí' ? true : undefined,
    guarantee: firstString(passthrough['Garantía']) ?? undefined,
    estimated: product.estimated === true,
    extra: passthrough,
    firstSeenAt: product.firstSeenAt,
    syncedAt: fallbackSyncedAt || new Date().toISOString(),
  };
}

/**
 * Normaliza una lista leída del disco al contrato canónico: lo que ya sea
 * canónico pasa intacto y lo legado (`UnifiedProduct`) se migra. Así el volumen
 * puede contener cachés antiguas escritas antes del PASO 6.
 */
export function normalizeCatalogProducts(raw: unknown[], fallbackSyncedAt: string): CanonicalAffiliateProduct[] {
  const fallback = fallbackSyncedAt || new Date().toISOString();
  const products: CanonicalAffiliateProduct[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    if (isCanonicalProduct(item)) {
      products.push(item);
      continue;
    }
    try {
      products.push(unifiedToCanonical(item as unknown as UnifiedProduct, fallback));
    } catch {
      // Entrada corrupta: se descarta en vez de romper toda la lectura
    }
  }
  return products;
}

/**
 * Busca en una red usando SIEMPRE el contrato canónico cuando la lo declara
 * (`searchCanonical`); si aún no, migra la salida legada de `search()`
 * (`unifiedToCanonical`). Descarta las muestras (`estimated`). Uniforme para
 * AliExpress, eBay, Amazon, Awin y Generic en el endpoint de catálogo y en la
 * sincronización de la caché: el resultado es SIEMPRE persistible tal cual.
 */
export async function searchCatalogBatch(
  connector: NetworkConnector,
  params: UnifiedSearchParams,
): Promise<CanonicalAffiliateProduct[]> {
  if (connector.searchCanonical) {
    const canonicalBatch = await connector.searchCanonical(params);
    // Nunca ingerir productos de muestra/respaldo (estimated) en la caché real
    return canonicalBatch.filter((product) => !product.estimated);
  }
  const legacyBatch = await connector.search(params);
  const now = new Date().toISOString();
  return legacyBatch
    .filter((product) => !product.estimated)
    .map((product) => unifiedToCanonical(product, now));
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
