/**
 * ==============================================================================
 * TRADYLOR - ADAPTADOR EBAY BROWSE API → UNIFIEDPRODUCT
 * ==============================================================================
 * Normaliza la respuesta de eBay Browse API (/buy/browse/v1/item_summary/search)
 * al contrato canónico CanonicalAffiliateProduct (y de ahí a UnifiedProduct
 * vía canonicalToUnified).
 *
 * La Browse API no trae descuento/valoración/comisión/envío en todos los
 * resultados: `adaptSingleCanonical` aplica fallbacks y cálculos por defecto
 * para que ninguna celda de la tabla del panel quede vacía («—»).
 *
 * Documentación: https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search
 * ==============================================================================
 */

import type { CanonicalAffiliateProduct, UnifiedProduct, UnifiedSearchParams } from '../../types';

/** % base de comisión EPN (rango típico 4-6%). Configurable con EBAY_COMMISSION_RATE. */
const EBAY_DEFAULT_COMMISSION_RATE = 5;
/** Valoración por defecto cuando la API no informa de feedback (escala 0-5 ★). */
const EBAY_DEFAULT_RATING = 4.5;
/** Nº de opiniones por defecto cuando la API no informa de feedback. */
const EBAY_DEFAULT_REVIEW_COUNT = 15;
/** Texto de envío por defecto cuando eBay no entrega fechas estimadas. */
const EBAY_DEFAULT_SHIPPING = 'Envío estándar eBay (3-5 días)';

function envValue(name: string): string {
  const fromProcess = process.env[name];
  const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> } | undefined)?.env;
  const fromMeta = metaEnv?.[name];
  return String(fromProcess ?? fromMeta ?? '').trim();
}

/** Porcentaje de comisión base para eBay (EBAY_COMMISSION_RATE, por defecto 5%). */
export function ebayCommissionRate(): number {
  const raw = Number(envValue('EBAY_COMMISSION_RATE').replace(',', '.'));
  if (!Number.isFinite(raw) || raw <= 0) return EBAY_DEFAULT_COMMISSION_RATE;
  const rounded = Math.round(raw * 10) / 10; // 1 decimal: 7.5 → 7.5 (no 0.075)
  if (rounded <= 0) return EBAY_DEFAULT_COMMISSION_RATE;
  return Math.min(100, rounded);
}

/** Respuesta cruda de eBay Browse API (subset de campos relevantes) */
export interface EbayItemSummary {
  itemId?: string;
  title?: string;
  price?: { value?: string; currency?: string };
  image?: { imageUrl?: string };
  additionalImages?: Array<{ imageUrl?: string }>;
  itemWebUrl?: string;
  itemAffiliateWebUrl?: string;
  categories?: Array<{ categoryId?: string; categoryName?: string }>;
  condition?: string;
  buyingOptions?: string[];
  shippingOptions?: Array<{
    shippingCost?: { value?: string; currency?: string };
    shipToLocations?: { countryCode?: string };
    minEstimatedDeliveryDate?: string;
    maxEstimatedDeliveryDate?: string;
  }>;
  seller?: { username?: string; feedbackPercentage?: string; feedbackScore?: number };
  itemLocation?: { country?: string; postalCode?: string };
  itemCreationDate?: string;
  itemEndDate?: string;
  marketingPrice?: { originalPrice?: { value?: string; currency?: string }; discountPercentage?: string };
  adultOnly?: boolean;
  legacyItemId?: string;
  itemGroupType?: string;
  itemGroupId?: string;
  shortDescription?: string;
  primaryItemGroup?: { itemGroupId?: string };
  product?: {
    productId?: string;
    title?: string;
    aspectGroups?: Array<{
      name?: string;
      aspects?: Array<{ name?: string; value?: string }>;
    }>;
    brand?: string;
    ean?: string[];
    upc?: string[];
    mpn?: string;
    gtin?: string;
    image?: { imageUrl?: string };
  };
}

/** Respuesta completa de la búsqueda */
export interface EbaySearchResponse {
  href?: string;
  next?: string;
  limit?: number;
  offset?: number;
  total?: number;
  itemSummaries?: EbayItemSummary[];
  refinement?: {
    categoryRefinements?: Array<{ categoryId?: string; categoryName?: string; count?: number }>;
    conditionRefinements?: Array<{ condition?: string; count?: number }>;
  };
}

/**
 * Adaptador que transforma EbayItemSummary → UnifiedProduct
 */
export class EbayProductAdapter {
  private readonly campaignId: string;
  private readonly searchParams: UnifiedSearchParams;

  constructor(campaignId: string, searchParams: UnifiedSearchParams = {}) {
    this.campaignId = campaignId;
    this.searchParams = searchParams;
  }

  /**
   * Transforma un array de EbayItemSummary a UnifiedProduct[]
   */
  adapt(items: EbayItemSummary[]): UnifiedProduct[] {
    return items
      .filter((item) => item.itemId && item.price?.value)
      .map((item) => this.adaptSingle(item))
      .filter((product): product is UnifiedProduct => product !== null);
  }

  /**
   * Transforma un array de EbayItemSummary al contrato canónico
   * CanonicalAffiliateProduct (pipeline). Aplica fallbacks para que ninguna
   * celda del catálogo quede vacía.
   */
  adaptCanonical(items: EbayItemSummary[]): CanonicalAffiliateProduct[] {
    return items
      .filter((item) => item.itemId)
      .map((item) => this.adaptSingleCanonical(item))
      .filter((product): product is CanonicalAffiliateProduct => product !== null);
  }

  adaptSingleCanonical(item: EbayItemSummary): CanonicalAffiliateProduct | null {
    const externalId = item.itemId ?? item.legacyItemId;
    if (!externalId) return null;

    // Precio limpio (Browse API lo devuelve como string decimal)
    const price = this.parsePrice(item.price?.value);
    const currency = item.price?.currency ?? 'EUR';

    // Precio original + descuento (marketingPrice) con fallback calculado.
    // Regla: originalPrice NUNCA vacío (si no hay oferta real = precio de venta)
    // y descuento % real siempre que exista rebaja.
    let originalPrice = price;
    if (item.marketingPrice?.originalPrice?.value) {
      const orig = this.parsePrice(item.marketingPrice.originalPrice.value);
      if (orig > price) originalPrice = orig;
    }
    let discountPercentage = 0;
    if (item.marketingPrice?.discountPercentage) {
      const parsed = this.parsePrice(item.marketingPrice.discountPercentage);
      if (parsed > 0) discountPercentage = Math.round(parsed * 100) / 100;
    } else if (originalPrice > price && originalPrice > 0) {
      discountPercentage = Math.round(((originalPrice - price) / originalPrice) * 10000) / 100;
    }
    // eBay a veces informa sólo el % de descuento: el precio original se deriva
    if (discountPercentage > 0 && discountPercentage < 100 && originalPrice <= price) {
      originalPrice = Math.round((price / (1 - discountPercentage / 100)) * 100) / 100;
    }
    // Sin descuento real: original = precio de venta y 0% (nunca NaN ni hueco)
    if (originalPrice <= price) {
      originalPrice = price;
      discountPercentage = 0;
    }

    // URL de afiliado con Campaign ID (mkmk) siempre inyectado
    const directUrl = item.itemWebUrl ?? item.itemAffiliateWebUrl ?? '';
    const affiliateUrl = this.buildAffiliateUrl(item.itemAffiliateWebUrl || item.itemWebUrl || '');

    // Vendedor (fallback explícito para evitar celdas vacías)
    const merchantName = item.seller?.username?.trim() || 'Vendedor de eBay';

    // Social proof: feedback del vendedor en % → escala 5 ★. Si la Browse API no
    // lo informa, valores por defecto coherentes para que la tabla no muestre «—».
    let rating = 0;
    if (item.seller?.feedbackPercentage) {
      const fb = parseFloat(item.seller.feedbackPercentage);
      if (!Number.isNaN(fb)) rating = Math.round((fb / 100) * 5 * 10) / 10;
    }
    if (!rating) rating = EBAY_DEFAULT_RATING;
    const reviewCount = item.seller?.feedbackScore && item.seller.feedbackScore > 0
      ? item.seller.feedbackScore
      : EBAY_DEFAULT_REVIEW_COUNT;

    // Imágenes: principal + secundarias (sin duplicar la principal)
    const mainImage = item.image?.imageUrl ?? item.product?.image?.imageUrl ?? '';
    const extraImages = (item.additionalImages ?? [])
      .map((img) => img.imageUrl)
      .filter((url): url is string => Boolean(url) && url !== mainImage);

    // Fallbacks de texto/categoría
    const title = item.title?.trim() || 'Producto eBay';
    const description = item.shortDescription?.trim() || `Artículo de eBay vendido por ${merchantName}.`;
    const category = this.searchParams.category || item.categories?.[0]?.categoryName || 'General';

    // Especificaciones a partir de los aspectos del producto
    const technicalSpecs: Record<string, string> = {};
    for (const group of item.product?.aspectGroups ?? []) {
      for (const aspect of group.aspects ?? []) {
        if (aspect.name && aspect.value) technicalSpecs[aspect.name] = aspect.value;
      }
    }
    if (item.condition) technicalSpecs['Estado'] = item.condition;
    if (item.itemLocation?.country) technicalSpecs['Ubicación'] = item.itemLocation.country;

    // Envío: días máximos estimados de entrega (la tabla de catálogo lee
    // 'Días de envío' para la columna de envío; sin esto saldría «—»)
    const shipping = item.shippingOptions?.[0];
    const deliveryMax = shipping?.maxEstimatedDeliveryDate;
    let hasDeliveryDays = false;
    if (deliveryMax) {
      const days = Math.ceil((Date.parse(deliveryMax) - Date.now()) / 86_400_000);
      if (Number.isFinite(days) && days > 0) {
        technicalSpecs['Días de envío'] = String(days);
        hasDeliveryDays = true;
      }
    }
    if (shipping?.shippingCost?.value != null) {
      const cost = this.parsePrice(shipping.shippingCost.value);
      technicalSpecs['Coste de envío'] = cost > 0
        ? `${cost.toFixed(2)} ${shipping.shippingCost.currency ?? currency}`
        : 'Gratis';
    }

    // Monetización: la Browse API no da comisión por ítem → se aplica el % base
    // configurado de EPN para que la columna de comisión nunca salga en «—»/0.
    const commissionRate = ebayCommissionRate();
    const estimatedCommission = price > 0 && commissionRate > 0
      ? Math.round(price * (commissionRate / 100) * 100) / 100
      : 0;

    const inStock = item.buyingOptions ? item.buyingOptions.includes('FIXED_PRICE') : true;

    // Passthrough canónico: datos que la UI lee del `extra` y que el esquema
    // canónico no cubre con campos propios (descuento 0%, envío por defecto,
    // ventas no disponibles en la Browse API).
    const extra: Record<string, string | number | boolean | null> = {
      'Descuento': `${discountPercentage}%`,
      'Ventas (30 días)': 'n/d',
    };
    if (!hasDeliveryDays) extra['Envío'] = EBAY_DEFAULT_SHIPPING;

    return {
      network: 'ebay',
      externalId,
      affiliateUrl,
      directUrl,
      title,
      description,
      price,
      originalPrice,
      currency,
      discountPercentage,
      inStock,
      commissionRate,
      estimatedCommission,
      category,
      brand: item.product?.brand?.trim() || undefined,
      merchantName,
      merchantId: item.seller?.username || undefined,
      rating,
      reviewCount,
      mainImage,
      extraImages,
      technicalSpecs: Object.keys(technicalSpecs).length ? technicalSpecs : undefined,
      extra,
      syncedAt: new Date().toISOString(),
    };
  }

  /**
   * Transforma un solo EbayItemSummary a UnifiedProduct
   */
  adaptSingle(item: EbayItemSummary): UnifiedProduct | null {
    const externalId = item.itemId ?? item.legacyItemId;
    if (!externalId) return null;

    const price = this.parsePrice(item.price?.value);
    const currency = item.price?.currency ?? 'EUR';

    // Precio original si hay marketing price con descuento
    let originalPrice: number | undefined;
    if (item.marketingPrice?.originalPrice?.value) {
      const orig = this.parsePrice(item.marketingPrice.originalPrice.value);
      if (orig > price) originalPrice = orig;
    }

    // URL de afiliado con campaign ID
    const baseUrl = item.itemAffiliateWebUrl || item.itemWebUrl || '';
    const productUrl = this.buildAffiliateUrl(baseUrl);

    // Categoría: usar la búsqueda param si existe, sino la primera de eBay
    const category = this.searchParams.category
      || item.categories?.[0]?.categoryName
      || 'General';

    // Imágenes: principal + galería
    const mainImage = item.image?.imageUrl ?? '';
    const gallery = item.additionalImages
      ?.map((img) => img.imageUrl)
      .filter((url): url is string => Boolean(url)) ?? [];

    // Envío
    let shippingInfo: string | undefined;
    let inStock = true;
    const shipping = item.shippingOptions?.[0];
    if (shipping) {
      const cost = this.parsePrice(shipping.shippingCost?.value);
      if (cost === 0) {
        shippingInfo = 'Envío gratis';
      } else if (cost > 0) {
        shippingInfo = `Envío: ${cost.toFixed(2)} ${shipping.shippingCost?.currency ?? currency}`;
      }
      const deliveryMin = shipping.minEstimatedDeliveryDate;
      const deliveryMax = shipping.maxEstimatedDeliveryDate;
      if (deliveryMin && deliveryMax) {
        shippingInfo = `${shippingInfo ? shippingInfo + ' · ' : ''}Entrega: ${this.formatDate(deliveryMin)} - ${this.formatDate(deliveryMax)}`;
      } else if (deliveryMin) {
        shippingInfo = `${shippingInfo ? shippingInfo + ' · ' : ''}Entrega estimada: ${this.formatDate(deliveryMin)}`;
      }
    }
    if (item.buyingOptions) {
      inStock = item.buyingOptions.includes('FIXED_PRICE');
    }

    // Valoraciones del vendedor (no del producto, pero es lo que da eBay)
    let rating: number | undefined;
    let reviewsCount: number | undefined;
    if (item.seller?.feedbackPercentage) {
      const fb = parseFloat(item.seller.feedbackPercentage);
      if (!Number.isNaN(fb)) {
        rating = Math.round((fb / 100) * 5 * 10) / 10; // Convertir % a escala 5
      }
    }
    if (item.seller?.feedbackScore) {
      reviewsCount = item.seller.feedbackScore;
    }

    // Popularidad: no hay métrica directa, usar feedbackScore como proxy
    const popularity = item.seller?.feedbackScore ?? 0;

    // Comisión: eBay no da comisión por producto en Browse API.
    // Se estima según categoría (EPN paga % por categoría).
    // Dejamos undefined para que el frontend no muestre datos inventados.

    // Descripción: combinar shortDescription + aspectos del producto
    const descriptionParts: string[] = [];
    if (item.shortDescription) descriptionParts.push(item.shortDescription);
    if (item.product?.aspectGroups) {
      const aspects = item.product.aspectGroups.flatMap((g) => g.aspects ?? []);
      const aspectText = aspects
        .filter((a) => a.name && a.value)
        .map((a) => `${a.name}: ${a.value}`)
        .slice(0, 5)
        .join(' · ');
      if (aspectText) descriptionParts.push(aspectText);
    }
    if (item.seller?.username) descriptionParts.push(`Vendedor: ${item.seller.username}`);
    if (item.itemLocation?.country) descriptionParts.push(`Ubicación: ${item.itemLocation.country}`);

    // Extra data para debug/tabla admin
    const extra: Record<string, string | number | boolean | null> = {
      'eBay Item ID': externalId,
      'Legacy Item ID': item.legacyItemId ?? null,
      'Condition': item.condition ?? null,
      'Buying Options': item.buyingOptions?.join(', ') ?? null,
      'Seller': item.seller?.username ?? null,
      'Seller Feedback %': item.seller?.feedbackPercentage ?? null,
      'Seller Feedback Score': item.seller?.feedbackScore ?? null,
      'Item Location': item.itemLocation?.country ?? null,
      'Category IDs': item.categories?.map((c) => c.categoryId).join(', ') ?? null,
      'Marketing Discount %': item.marketingPrice?.discountPercentage ?? null,
      'Adult Only': item.adultOnly ?? false,
      'Item Group Type': item.itemGroupType ?? null,
      'Item Group ID': item.itemGroupId ?? null,
      'Product ID': item.product?.productId ?? null,
      'Brand': item.product?.brand ?? null,
      'MPN': item.product?.mpn ?? null,
      'EAN': item.product?.ean?.join(', ') ?? null,
      'UPC': item.product?.upc?.join(', ') ?? null,
      'GTIN': item.product?.gtin ?? null,
    };

    return {
      network: 'ebay',
      externalId,
      title: item.title ?? 'Producto eBay',
      description: descriptionParts.join(' · ') || 'Producto de eBay',
      price,
      originalPrice,
      currency,
      image: mainImage,
      gallery: gallery.length ? gallery : undefined,
      category,
      productUrl,
      commissionRate: undefined, // eBay Browse API no proporciona comisión por ítem
      commissionAmount: undefined,
      rating,
      reviewsCount,
      popularity,
      inStock,
      shippingInfo,
      estimated: false,
      extra,
    };
  }

  /**
   * Construye la URL de afiliado añadiendo el campaign ID (mkmk)
   */
  private buildAffiliateUrl(baseUrl: string): string {
    if (!this.campaignId || !baseUrl) return baseUrl;
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}mkmk=${this.campaignId}`;
  }

  /**
   * Parsea precio de string a number
   */
  private parsePrice(value?: string): number {
    if (!value) return 0;
    const parsed = parseFloat(value.replace(/[^\d.,-]/g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Formatea fecha ISO a DD/MM/YYYY
   */
  private formatDate(isoString: string): string {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch {
      return isoString;
    }
  }
}

/**
 * Factory function para uso directo sin instanciar la clase
 */
export function adaptEbayProducts(
  items: EbayItemSummary[],
  campaignId: string,
  searchParams: UnifiedSearchParams = {}
): UnifiedProduct[] {
  const adapter = new EbayProductAdapter(campaignId, searchParams);
  return adapter.adapt(items);
}