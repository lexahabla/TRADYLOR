/**
 * ==============================================================================
 * TRADYLOR - ADAPTADOR AMAZON PA-API 5.0 → CANONICALAFFILIATEPRODUCT
 * ==============================================================================
 * Parsea la respuesta de SearchItems (POST /paapi5/searchitems) al contrato
 * canónico del pipeline: imágenes variantes, valoraciones (CustomerReviews),
 * precio de la oferta, marca y categoría de browse node.
 *
 * Documentación: https://webservices.amazon.com/paapi5/documentation/
 * ==============================================================================
 */

import type { CanonicalAffiliateProduct } from '../../types';

/** Subset de la respuesta SearchItems de PA-API 5.0 */
export interface AmazonSearchItemsResponse {
  SearchMetaData?: {
    TotalResultCount?: number;
    SearchIndex?: string;
    Keywords?: string;
  };
  SearchResult?: {
    Items?: AmazonItem[];
    TotalResultCount?: number;
    SearchURL?: string;
  };
  Errors?: Array<{
    Code?: string;
    Message?: string;
  }>;
}

export interface AmazonItem {
  ASIN?: string;
  DetailPageURL?: string;
  ItemInfo?: {
    Title?: { DisplayValue?: string };
    Features?: { DisplayValues?: string[] };
    ByLineInfo?: {
      Brand?: { DisplayValue?: string };
      Manufacturer?: { DisplayValue?: string };
    };
    Classifications?: {
      ProductGroup?: { DisplayValue?: string };
      ProductTypeName?: { DisplayValue?: string };
    };
  };
  Images?: {
    Primary?: {
      Small?: { URL?: string };
      Medium?: { URL?: string };
      Large?: { URL?: string };
    };
    Variants?: Array<{
      Small?: { URL?: string };
      Medium?: { URL?: string };
      Large?: { URL?: string };
    }>;
  };
  Offers?: {
    Listings?: Array<{
      Price?: { Amount?: number; Currency?: string };
      Saving?: { Amount?: number; Percentage?: number };
      Availability?: { Message?: string; MinOrderQuantity?: number };
      Merchant?: { Name?: string; Identifier?: string };
    }>;
    Summaries?: Array<{
      Condition?: { Value?: string };
      LowestPrice?: { Amount?: number; Currency?: string };
    }>;
  };
  CustomerReviews?: {
    Count?: number;
    AverageRating?: number;
    StarRating?: { Value?: number };
  };
  BrowseNodeInfo?: {
    BrowseNodes?: Array<{
      Id?: string;
      DisplayName?: string;
      SalesRank?: number;
    }>;
  };
}

/** Parámetros de la petición SearchItems (cuerpo JSON) */
export interface AmazonSearchItemsRequest {
  Keywords?: string;
  ASIN?: string;
  SearchIndex?: string;
  ItemCount?: number;
  PartnerTag: string;
  PartnerType: 'Associates';
  Marketplace: string;
  Resources: string[];
  Filter?: string;
  SortBy?: string;
}

export const AMAZON_RESOURCES = [
  'Images.Primary.Medium',
  'Images.Primary.Large',
  'Images.Variants.Medium',
  'Images.Variants.Large',
  'ItemInfo.Title',
  'ItemInfo.Features',
  'ItemInfo.ByLineInfo',
  'ItemInfo.Classifications',
  'Offers.Listings.Price',
  'Offers.Listings.Saving',
  'Offers.Listings.Availability',
  'Offers.Listings.Merchant',
  'Offers.Summaries.LowestPrice',
  'CustomerReviews.Count',
  'CustomerReviews.AverageRating',
  'CustomerReviews.StarRating',
  'BrowseNodeInfo.BrowseNodes',
];

/**
 * Adaptador que transforma los items de PA-API 5.0 a CanonicalAffiliateProduct.
 */
export class AmazonProductAdapter {
  private readonly partnerTag: string;

  constructor(partnerTag: string) {
    this.partnerTag = partnerTag;
  }

  adapt(items: AmazonItem[]): CanonicalAffiliateProduct[] {
    return items
      .map((item) => this.adaptSingle(item))
      .filter((product): product is CanonicalAffiliateProduct => product !== null);
  }

  adaptSingle(item: AmazonItem): CanonicalAffiliateProduct | null {
    const externalId = item.ASIN?.trim();
    const title = item.ItemInfo?.Title?.DisplayValue?.trim();
    // DetailPageURL ya incluye el Associate Tag cuando se envía PartnerTag en la petición
    const detailPageUrl = item.DetailPageURL?.trim() ?? '';
    if (!externalId || !title) return null;

    // Precio: primera oferta con precio; fallback al LowestPrice del resumen
    const listing = item.Offers?.Listings?.find((entry) => typeof entry.Price?.Amount === 'number');
    const lowest = item.Offers?.Summaries?.[0]?.LowestPrice;
    const price = listing?.Price?.Amount ?? lowest?.Amount ?? 0;
    const currency = listing?.Price?.Currency ?? lowest?.Currency ?? 'EUR';

    // Descuento: Saving de la oferta ( Amount + Percentage )
    let discountPercentage = 0;
    const saving = listing?.Saving;
    if (saving?.Percentage && saving.Percentage > 0) {
      discountPercentage = Math.round(saving.Percentage * 100) / 100;
    } else if (saving?.Amount && price > 0) {
      discountPercentage = Math.round((saving.Amount / (price + saving.Amount)) * 10000) / 100;
    }
    const originalPrice = saving?.Amount ? Math.round((price + saving.Amount) * 100) / 100 : price;

    // Valoraciones de producto (CustomerReviews)
    const ratingRaw = item.CustomerReviews?.AverageRating ?? item.CustomerReviews?.StarRating?.Value ?? 0;
    const rating = Math.min(5, Math.max(0, Math.round(ratingRaw * 10) / 10));
    const reviewCount = item.CustomerReviews?.Count ?? 0;

    // Imágenes: principal (Large) + variantes (colores/medidas), sin duplicados
    const mainImage = item.Images?.Primary?.Large?.URL
      ?? item.Images?.Primary?.Medium?.URL
      ?? '';
    const extraImages = (item.Images?.Variants ?? [])
      .map((variant) => variant.Large?.URL ?? variant.Medium?.URL)
      .filter((url): url is string => Boolean(url) && url !== mainImage);

    // Marca / fabricante / disponibilidad
    const brand = item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue?.trim()
      || item.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue?.trim()
      || undefined;
    const merchantName = listing?.Merchant?.Name?.trim() || 'Amazon';
    const merchantId = listing?.Merchant?.Identifier || undefined;
    const availability = listing?.Availability?.Message?.trim();
    const inStock = availability ? !/no hay|agotad|sin stock|unavailable|out of stock/i.test(availability) : true;

    // Categoría: ProductGroup de ItemInfo + browse node principal
    const productGroup = item.ItemInfo?.Classifications?.ProductGroup?.DisplayValue?.trim();
    const browseNode = item.BrowseNodeInfo?.BrowseNodes?.[0]?.DisplayName?.trim();
    const category = productGroup || browseNode || 'Amazon';

    // Descripción: bullet points de Features
    const features = item.ItemInfo?.Features?.DisplayValues ?? [];
    const description = features.filter(Boolean).slice(0, 5).join(' · ')
      || `${title}${brand ? ` (${brand})` : ''} disponible en Amazon.`;

    // PA-API no expone comisión por producto → 0 (evita celdas sin inventar datos)
    const commissionRate = 0;

    const technicalSpecs: Record<string, string> = {};
    if (productGroup) technicalSpecs['Grupo de producto'] = productGroup;
    if (item.ItemInfo?.Classifications?.ProductTypeName?.DisplayValue) {
      technicalSpecs['Tipo'] = item.ItemInfo.Classifications.ProductTypeName.DisplayValue;
    }
    if (availability) technicalSpecs['Disponibilidad'] = availability;
    // Estado físico (PA-API sólo lo informa en listados de Amazon Warehouse /
    // vendedores de segunda mano; en nuevo no suele venir el campo).
    const rawCondition = item.ItemInfo?.Condition?.Value?.trim();
    if (rawCondition) {
      const conditionEs: Record<string, string> = {
        New: 'Nuevo',
        Used: 'Usado',
        Collectible: 'Coleccionable',
        Refurbished: 'Reacondicionado',
      };
      technicalSpecs['Estado'] = conditionEs[rawCondition] ?? rawCondition;
    }
    features.filter(Boolean).slice(0, 5).forEach((feature, index) => {
      technicalSpecs[`Característica ${index + 1}`] = feature;
    });

    return {
      network: 'amazon',
      externalId,
      affiliateUrl: detailPageUrl,
      directUrl: detailPageUrl,
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
      brand,
      merchantName,
      merchantId,
      rating,
      reviewCount,
      mainImage,
      extraImages,
      technicalSpecs: Object.keys(technicalSpecs).length ? technicalSpecs : undefined,
      syncedAt: new Date().toISOString(),
    };
  }
}
