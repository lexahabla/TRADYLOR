/**
 * ==============================================================================
 * TRADYLOR - ADAPTADOR EBAY BROWSE API → UNIFIEDPRODUCT
 * ==============================================================================
 * Normaliza la respuesta de eBay Browse API (/buy/browse/v1/item_summary/search)
 * al esquema unificado UnifiedProduct.
 *
 * Documentación: https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search
 * ==============================================================================
 */

import type { CanonicalAffiliateProduct, UnifiedProduct, UnifiedSearchParams } from '../../types';

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

    // Precio original + descuento (marketingPrice) con fallback calculado
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

    // URL de afiliado con Campaign ID (mkmk) siempre inyectado
    const directUrl = item.itemWebUrl ?? item.itemAffiliateWebUrl ?? '';
    const affiliateUrl = this.buildAffiliateUrl(item.itemAffiliateWebUrl || item.itemWebUrl || '');

    // Vendedor (fallback 'eBay' para evitar celdas vacías)
    const merchantName = item.seller?.username?.trim() || 'eBay';

    // Valoración: feedback del vendedor en % → escala 5 ★; fallback 0
    let rating = 0;
    if (item.seller?.feedbackPercentage) {
      const fb = parseFloat(item.seller.feedbackPercentage);
      if (!Number.isNaN(fb)) rating = Math.round((fb / 100) * 5 * 10) / 10;
    }
    const reviewCount = item.seller?.feedbackScore ?? 0;

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
    if (deliveryMax) {
      const days = Math.ceil((Date.parse(deliveryMax) - Date.now()) / 86_400_000);
      if (Number.isFinite(days) && days > 0) technicalSpecs['Días de envío'] = String(days);
    }
    if (shipping?.shippingCost?.value != null) {
      const cost = this.parsePrice(shipping.shippingCost.value);
      technicalSpecs['Coste de envío'] = cost > 0
        ? `${cost.toFixed(2)} ${shipping.shippingCost.currency ?? currency}`
        : 'Gratis';
    }

    // eBay Browse API no da comisión por ítem → 0 (evita celdas vacías sin inventar %)
    const commissionRate = 0;

    const inStock = item.buyingOptions ? item.buyingOptions.includes('FIXED_PRICE') : true;

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
      estimatedCommission: 0,
      category,
      brand: item.product?.brand?.trim() || undefined,
      merchantName,
      merchantId: item.seller?.username || undefined,
      rating,
      reviewCount,
      mainImage,
      extraImages,
      technicalSpecs: Object.keys(technicalSpecs).length ? technicalSpecs : undefined,
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