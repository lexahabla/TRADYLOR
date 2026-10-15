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
import { getCredentialValues, setNetworkStatus } from '../credentials';
import type { UnifiedProduct, UnifiedSearchParams } from '../types';

const GATEWAYS = ['https://api-sg.aliexpress.com/sync', 'https://eco.taobao.com/router/rest'];

const CATALOG_KEYWORDS = [
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
 * EasyPanel: ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET, ALIEXPRESS_TRACKING_ID.
 */
function resolveCreds(): Record<string, string> | null {
  const stored = getCredentialValues('aliexpress') ?? {};
  const creds = {
    appKey: stored.appKey || envValue('ALIEXPRESS_APP_KEY'),
    appSecret: stored.appSecret || envValue('ALIEXPRESS_APP_SECRET'),
    trackingId: stored.trackingId || envValue('ALIEXPRESS_TRACKING_ID'),
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
    simplify: 'true',
    ...biz,
  };
  if (creds.trackingId) params.tracking_id = creds.trackingId;
  params.sign = sign(params, creds.appSecret);

  const body = new URLSearchParams(params).toString();
  let lastError = 'AliExpress no respondió.';
  let raw = '';
  for (const gateway of GATEWAYS) {
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
      raw = await response.text();
      if (raw) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
    }
  }
  if (!raw) throw new ConnectorError('aliexpress', lastError);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ConnectorError('aliexpress', 'AliExpress devolvió una respuesta que no es JSON.');
  }
  const errorResponse = parsed.error_response as { code?: string | number; msg?: string; sub_msg?: string } | undefined;
  if (errorResponse) {
    const detail = errorResponse.sub_msg || errorResponse.msg || `código ${errorResponse.code ?? 'desconocido'}`;
    throw new ConnectorError('aliexpress', `AliExpress: ${detail}`);
  }
  return parsed;
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

async function queryProducts(
  creds: Record<string, string>,
  keywords: string,
  pageSize: number,
): Promise<UnifiedProduct[]> {
  const payload = await callApi('aliexpress.affiliate.product.query', creds, {
    keywords: keywords || 'best seller',
    target_currency: 'EUR',
    target_language: 'ES',
    ship_to_country: 'ES',
    page_size: String(Math.min(Math.max(pageSize, 1), 50)),
    page_no: '1',
    sort: 'LAST_VOLUME_DESC',
  });
  return extractProducts(payload)
    .map((item) => mapProduct(item, 'EUR'))
    .filter((item): item is UnifiedProduct => item !== null);
}

export class AliExpressConnector implements NetworkConnector {
  readonly networkId = 'aliexpress';

  async validate(): Promise<{ ok: boolean; message: string }> {
    const creds = resolveCreds();
    if (!creds?.appKey || !creds?.appSecret || !creds?.trackingId) {
      const message = 'Faltan credenciales obligatorias (App Key, App Secret o Tracking ID).';
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
    if (params.query) return queryProducts(creds, params.query, limit);

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
}
