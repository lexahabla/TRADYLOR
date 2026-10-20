/**
 * ==============================================================================
 * TRADYLOR - CONECTOR ALIEXPRESS AFFILIATE API
 * ==============================================================================
 * Open Platform (TOP):
 *   - aliexpress.affiliate.product.query   búsqueda de productos
 *   - aliexpress.affiliate.link.generate   enlace de afiliado con tracking
 *   - aliexpress.affiliate.category.get    validación de credenciales
 *
 * Firma: HMAC-SHA256 del string method+sorted(params) con el App Secret.
 * Gateway: https://api-sg.aliexpress.com/sync
 * ==============================================================================
 */

import { createHmac } from 'node:crypto';
import { ConnectorError, fetchWithTimeout, type NetworkConnector } from './base';
import { getMergedCredentialValues, setNetworkStatus } from '../credentials';
import type { CanonicalAffiliateProduct, UnifiedProduct, UnifiedSearchParams } from '../types';

function gateways(): string[] {
  const configured = envValue('ALIEXPRESS_SERVER_URL');
  return [...new Set([configured, 'https://api-sg.aliexpress.com/sync', 'https://eco.taobao.com/router/rest'].filter(Boolean))];
}

export const CATALOG_KEYWORDS = [
  'auriculares bluetooth',
  'robot aspirador',
  'smartwatch',
  'cargador usb c',
  'teclado mecanico',
  'camara seguridad wifi',
  'lampara led escritorio',
  'mochila viaje',
];

interface AliProduct {
  product_id?: number | string;
  product_title?: string;
  product_main_image_url?: string;
  product_small_image_urls?: { string?: string[] } | string[];
  product_detail_url?: string;
  promotion_link?: string;
  target_sale_price?: string;
  target_original_price?: string;
  target_app_sale_price?: string;
  sale_price?: string;
  original_price?: string;
  app_sale_price?: string;
  discount?: string;
  commission_rate?: string;
  hot_product_commission_rate?: string;
  relevant_market_commission_rate?: string;
  lastest_volume?: number | string;
  evaluate_rate?: string;
  product_brand_name?: string;
  shop_name?: string;
  shop_url?: string;
  shop_id?: number | string;
  first_level_category_name?: string;
  second_level_category_name?: string;
  first_level_category_id?: number | string;
  second_level_category_id?: number | string;
  platform_product_type?: string;
  ship_to_days?: string;
  product_video_url?: string;
}

function envValue(name: string): string {
  const fromProcess = process.env[name];
  const fromMeta = (import.meta.env as Record<string, string | undefined>)[name];
  return String(fromProcess ?? fromMeta ?? '').trim();
}

/**
 * Credenciales del panel (credentials.json) o, si faltan, las variables de
 * EasyPanel: ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET, ALIEXPRESS_TRACKING_ID
 * y ALIEXPRESS_SERVER_URL (el tracking ID es opcional pero recomendable: es el
 * que acredita las comisiones de la cuenta de afiliados de AliExpress).
 */
function resolveCreds(): Record<string, string> | null {
  const stored = getMergedCredentialValues('aliexpress');
  const creds = {
    appKey: stored.appKey || '',
    appSecret: stored.appSecret || '',
    trackingId: stored.trackingId || '',
  };
  return creds.appKey && creds.appSecret ? creds : null;
}

function sign(params: Record<string, string>, secret: string): string {
  const base = Object.keys(params)
    .filter((key) => key !== 'sign')
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('');
  return createHmac('sha256', secret).update(base, 'utf8').digest('hex').toUpperCase();
}

function num(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(String(value).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function callApi(
  method: string,
  creds: Record<string, string>,
  biz: Record<string, string>,
): Promise<Record<string, unknown>> {
  const params: Record<string, string> = {
    method,
    app_key: creds.appKey,
    timestamp: String(Date.now()),
    format: 'json',
    v: '2.0',
    sign_method: 'sha256',
    ...biz,
  };
  if (creds.trackingId) params.tracking_id = creds.trackingId;
  params.sign = sign(params, creds.appSecret);

  // URLSearchParams codifica el espacio como '+' pero la verificación de firma
  // de TOP espera '%20' (los '+' literales ya salen como %2B, así que este
  // replace sólo transforma espacios).
  const body = new URLSearchParams(params).toString().replace(/\+/g, '%20');
  let lastError = 'AliExpress no respondió.';
  let firstError = '';
  let firstErrorGateway = '';
  let success: Record<string, unknown> | null = null;
  for (const gateway of gateways()) {
    try {
      const response = await fetchWithTimeout(
        gateway,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
          body,
        },
        14000,
      );
      const raw = await response.text();
      if (!raw) continue;
      const parsed = safeParse(raw);
      if (!parsed) {
        lastError = 'AliExpress devolvió una respuesta que no es JSON.';
        continue;
      }
      const errorResponse = parsed.error_response as { code?: string | number; msg?: string; sub_msg?: string } | undefined;
      if (errorResponse) {
        // Un error en un gateway no impide probar el siguiente (así un
        // ALIEXPRESS_SERVER_URL mal configurado no bloquea a los demás).
        if (!firstError) {
          firstError = errorResponse.sub_msg || errorResponse.msg || `código ${errorResponse.code ?? 'desconocido'}`;
          firstErrorGateway = hostOf(gateway);
        }
        continue;
      }
      success = parsed;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
    }
  }
  if (!success) {
    if (firstError) throw new ConnectorError('aliexpress', `AliExpress: ${firstError}${firstErrorGateway ? ` [${firstErrorGateway}]` : ''}`);
    throw new ConnectorError('aliexpress', lastError);
  }
  return success;
}

function responseNode(payload: Record<string, unknown>, method: string): Record<string, unknown> {
  const key = `${method.replace(/\./g, '_')}_response`;
  const node = (payload[key] ?? payload.resp_result ?? payload) as Record<string, unknown>;
  const resp = (node.resp_result ?? node) as Record<string, unknown>;
  if (resp && typeof resp === 'object' && 'resp_code' in resp && Number(resp.resp_code) !== 200) {
    throw new ConnectorError('aliexpress', `AliExpress: ${text(resp.resp_msg) || 'petición rechazada'}.`);
  }
  return (resp.result ?? resp) as Record<string, unknown>;
}

function extractProducts(payload: Record<string, unknown>): AliProduct[] {
  const result = responseNode(payload, 'aliexpress.affiliate.product.query');
  const buckets = [result.products, result];
  for (const bucket of buckets) {
    if (Array.isArray(bucket)) return bucket as AliProduct[];
    const nested = bucket as { product?: AliProduct[] } | undefined;
    if (nested && Array.isArray(nested.product)) return nested.product;
  }
  return [];
}

function gallery(item: AliProduct): string[] {
  const raw = item.product_small_image_urls;
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  if (raw && Array.isArray(raw.string)) return raw.string.filter(Boolean);
  return [];
}

function mapProduct(item: AliProduct, currency: string): UnifiedProduct | null {
  const title = text(item.product_title);
  const productUrl = text(item.product_detail_url) || text(item.promotion_link);
  if (!title || !productUrl) return null;

  const price = num(item.target_sale_price) ?? num(item.target_app_sale_price) ?? num(item.sale_price) ?? num(item.app_sale_price) ?? 0;
  const originalPrice = num(item.target_original_price) ?? num(item.original_price);
  const commissionRate = num(item.commission_rate) ?? num(item.hot_product_commission_rate) ?? num(item.relevant_market_commission_rate);
  const sales = num(item.lastest_volume) ?? 0;
  const rating = num(item.evaluate_rate);
  const discount = num(item.discount);
  const images = gallery(item);

  const extra: Record<string, string | number | boolean | null> = {
    'ID producto': text(item.product_id) || null,
    // Marca y distribuidor: el TOP API los trae en product_brand_name /
    // shop_name. Se publican con las claves que la tabla (detalle) y el payload
    // de importación buscan: 'Marca' y 'Distribuidor'.
    'Marca': text(item.product_brand_name) || null,
    'Distribuidor': text(item.shop_name) || null,
    Tienda: text(item.shop_name) || null,
    'ID tienda': text(item.shop_id) || null,
    'URL tienda': text(item.shop_url) || null,
    'Categoría nivel 1': text(item.first_level_category_name) || null,
    'Categoría nivel 2': text(item.second_level_category_name) || null,
    'ID categoría 1': text(item.first_level_category_id) || null,
    'ID categoría 2': text(item.second_level_category_id) || null,
    'Precio de venta': price ? `${price.toFixed(2)} ${currency}` : null,
    'Precio original': originalPrice ? `${originalPrice.toFixed(2)} ${currency}` : null,
    'Precio app': text(item.target_app_sale_price) || text(item.app_sale_price) || null,
    Descuento: discount != null ? `${discount}%` : null,
    'Comisión (%)': commissionRate != null ? `${commissionRate}%` : null,
    'Comisión hot (%)': text(item.hot_product_commission_rate) || null,
    'Comisión mercado (%)': text(item.relevant_market_commission_rate) || null,
    'Comisión estimada': commissionRate != null && price ? `${((price * commissionRate) / 100).toFixed(2)} ${currency}` : null,
    'Ventas (30 días)': sales || null,
    'Valoración (%)': rating != null ? `${rating}%` : null,
    'Días de envío': text(item.ship_to_days) || null,
    Plataforma: text(item.platform_product_type) || null,
    'Imágenes': images.length ? images.join(' | ') : null,
    'Enlace de afiliado': text(item.promotion_link) || null,
    'URL del producto': text(item.product_detail_url) || null,
    Vídeo: text(item.product_video_url) || null,
    'Imágenes extra': images.length || null,
  };

  return {
    network: 'aliexpress',
    externalId: text(item.product_id) || productUrl,
    title,
    description: [text(item.shop_name), text(item.second_level_category_name)].filter(Boolean).join(' · '),
    price,
    originalPrice: originalPrice && originalPrice > price ? originalPrice : undefined,
    currency,
    image: text(item.product_main_image_url) || images[0] || '',
    gallery: images.length ? images : undefined,
    category: text(item.second_level_category_name) || text(item.first_level_category_name) || 'AliExpress',
    productUrl,
    commissionRate,
    commissionAmount: commissionRate != null ? Math.round(price * (commissionRate / 100) * 100) / 100 : undefined,
    rating: rating != null ? Math.round((rating / 20) * 10) / 10 : undefined,
    reviewsCount: undefined,
    popularity: sales,
    inStock: true,
    shippingInfo: text(item.ship_to_days) ? `Envío en ${text(item.ship_to_days)} días` : undefined,
    estimated: false,
    extra,
  };
}

async function queryRaw(
  creds: Record<string, string>,
  keywords: string,
  pageSize: number,
  page = 1,
): Promise<AliProduct[]> {
  const payload = await callApi('aliexpress.affiliate.product.query', creds, {
    keywords: keywords || 'best seller',
    target_currency: 'EUR',
    target_language: 'ES',
    ship_to_country: 'ES',
    page_size: String(Math.min(Math.max(pageSize, 1), 50)),
    page_no: String(Math.max(1, page)),
    sort: 'LAST_VOLUME_DESC',
  });
  return extractProducts(payload);
}

async function queryProducts(
  creds: Record<string, string>,
  keywords: string,
  pageSize: number,
  page = 1,
): Promise<UnifiedProduct[]> {
  const currency = 'EUR';
  return (await queryRaw(creds, keywords, pageSize, page))
    .map((item) => mapProduct(item, currency))
    .filter((item): item is UnifiedProduct => item !== null);
}

/**
 * Mapea un producto TOP al contrato canónico CanonicalAffiliateProduct.
 * - Precio de venta: `target_sale_price` (fallbacks app/sale).
 * - Precio original: `target_original_price` (fallback `original_price`).
 * - Descuento: `discount` de la API o calculado contra el precio original.
 * - Valoración: `evaluate_rate` viene en % (0-100) y se normaliza a escala 5 ★.
 */
function mapCanonicalProduct(item: AliProduct, currency: string): CanonicalAffiliateProduct | null {
  const title = text(item.product_title);
  const directUrl = text(item.product_detail_url);
  const promotionLink = text(item.promotion_link);
  const productUrl = directUrl || promotionLink;
  if (!title || !productUrl) return null;

  const price = num(item.target_sale_price) ?? num(item.target_app_sale_price) ?? num(item.sale_price) ?? num(item.app_sale_price) ?? 0;
  const rawOriginal = num(item.target_original_price) ?? num(item.original_price);
  const originalPrice = rawOriginal && rawOriginal > price ? rawOriginal : price;

  const apiDiscount = num(item.discount);
  const discountPercentage = apiDiscount != null
    ? Math.max(0, Math.round(apiDiscount * 100) / 100)
    : originalPrice > price
      ? Math.round(((originalPrice - price) / originalPrice) * 10000) / 100
      : 0;

  const commissionRate = num(item.commission_rate) ?? num(item.hot_product_commission_rate) ?? num(item.relevant_market_commission_rate) ?? 0;
  const hotCommissionRate = num(item.hot_product_commission_rate) ?? 0;
  const estimatedCommission = price && commissionRate ? Math.round(price * (commissionRate / 100) * 100) / 100 : 0;

  // evaluate_rate es un porcentaje (p. ej. 96 = 96% ≈ 4.8 ★ sobre 5)
  const ratingPercent = num(item.evaluate_rate);
  const rating = ratingPercent != null ? Math.min(5, Math.max(0, Math.round((ratingPercent / 20) * 10) / 10)) : 0;

  const images = gallery(item);
  const mainImage = text(item.product_main_image_url) || images[0] || '';
  const extraImages = images.filter((url) => url !== mainImage);

  const technicalSpecs: Record<string, string> = {};
  const shipDays = text(item.ship_to_days);
  if (shipDays) technicalSpecs['Días de envío'] = shipDays;
  const platform = text(item.platform_product_type);
  if (platform) technicalSpecs['Plataforma'] = platform;

  return {
    network: 'aliexpress',
    externalId: text(item.product_id) || productUrl,
    affiliateUrl: promotionLink || productUrl,
    directUrl,
    title,
    description: [text(item.shop_name), text(item.second_level_category_name)].filter(Boolean).join(' · ') || title,
    price,
    originalPrice,
    currency,
    discountPercentage,
    inStock: true,
    commissionRate,
    hotCommissionRate: hotCommissionRate || undefined,
    estimatedCommission,
    category: text(item.first_level_category_name) || 'AliExpress',
    subCategory: text(item.second_level_category_name) || undefined,
    brand: text(item.product_brand_name) || undefined,
    merchantName: text(item.shop_name) || 'AliExpress',
    merchantId: text(item.shop_id) || undefined,
    rating,
    reviewCount: 0,
    sales: num(item.lastest_volume) || undefined,
    mainImage,
    extraImages,
    technicalSpecs: Object.keys(technicalSpecs).length ? technicalSpecs : undefined,
    syncedAt: new Date().toISOString(),
  };
}

async function queryCanonicalProducts(
  creds: Record<string, string>,
  keywords: string,
  pageSize: number,
  page = 1,
): Promise<CanonicalAffiliateProduct[]> {
  const currency = 'EUR';
  return (await queryRaw(creds, keywords, pageSize, page))
    .map((item) => mapCanonicalProduct(item, currency))
    .filter((item): item is CanonicalAffiliateProduct => item !== null);
}

export class AliExpressConnector implements NetworkConnector {
  readonly networkId = 'aliexpress';

  async validate(): Promise<{ ok: boolean; message: string }> {
    const creds = resolveCreds();
    if (!creds?.appKey || !creds?.appSecret) {
      const message = 'Faltan ALIEXPRESS_APP_KEY o ALIEXPRESS_APP_SECRET.';
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }
    try {
      await callApi('aliexpress.affiliate.category.get', creds, {});
      const message = 'Conexión verificada con la API de afiliados de AliExpress.';
      setNetworkStatus(this.networkId, 'connected', message);
      return { ok: true, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo validar la API de AliExpress.';
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }
  }

  async search(params: UnifiedSearchParams): Promise<UnifiedProduct[]> {
    const creds = resolveCreds();
    if (!creds?.appKey || !creds?.appSecret) {
      throw new ConnectorError(this.networkId, 'AliExpress no está conectado. Añade sus credenciales primero.');
    }

    const limit = Math.min(params.limit ?? 20, 50);
    if (params.query) return queryProducts(creds, params.query, limit, params.page ?? 1);

    const seen = new Set<string>();
    const merged: UnifiedProduct[] = [];
    for (const keyword of CATALOG_KEYWORDS) {
      if (merged.length >= limit) break;
      try {
        const batch = await queryProducts(creds, keyword, 10);
        for (const product of batch) {
          if (seen.has(product.externalId)) continue;
          seen.add(product.externalId);
          merged.push(product);
          if (merged.length >= limit) break;
        }
      } catch (error) {
        if (!merged.length && keyword === CATALOG_KEYWORDS[0]) throw error;
      }
    }
    return merged;
  }

  /** Búsqueda al contrato canónico (pipeline). Mapea precios, descuento y rating /5 ★. */
  async searchCanonical(params: UnifiedSearchParams): Promise<CanonicalAffiliateProduct[]> {
    const creds = resolveCreds();
    if (!creds?.appKey || !creds?.appSecret) {
      throw new ConnectorError(this.networkId, 'AliExpress no está conectado. Añade sus credenciales primero.');
    }

    const limit = Math.min(params.limit ?? 20, 50);
    if (params.query) return queryCanonicalProducts(creds, params.query, limit, params.page ?? 1);

    const seen = new Set<string>();
    const merged: CanonicalAffiliateProduct[] = [];
    for (const keyword of CATALOG_KEYWORDS) {
      if (merged.length >= limit) break;
      try {
        const batch = await queryCanonicalProducts(creds, keyword, 10);
        for (const product of batch) {
          if (seen.has(product.externalId)) continue;
          seen.add(product.externalId);
          merged.push(product);
          if (merged.length >= limit) break;
        }
      } catch (error) {
        if (!merged.length && keyword === CATALOG_KEYWORDS[0]) throw error;
      }
    }
    return merged;
  }
}
