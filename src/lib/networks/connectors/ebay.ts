/**
 * ==============================================================================
 * TRADYLOR - CONECTOR eBAY PARTNER NETWORK
 * ==============================================================================
 * Documentación oficial: https://developer.ebay.com/api-docs/buy/static/api-browse.html
 *
 * Flujo OAuth client-credentials ya implementado en validate(): intercambia
 * Client ID/Secret por un token de aplicación. La búsqueda Browse API
 * (/item_summary/search) se cablea en fase 2.
 * ==============================================================================
 */

import type { UnifiedProduct } from '../types';

import { ConnectorError, fetchWithTimeout, sampleProducts, type NetworkConnector } from './base';
import { getCredentialValues, setNetworkStatus } from '../credentials';
import type { UnifiedProduct, UnifiedSearchParams } from '../types';

const EBAY_OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

export class EbayConnector implements NetworkConnector {
  readonly networkId = 'ebay';

  async validate(): Promise<{ ok: boolean; message: string }> {
    const creds = getCredentialValues(this.networkId);
    if (!creds?.clientId || !creds?.clientSecret || !creds?.campaignId) {
      const message = 'Faltan credenciales obligatorias (Client ID, Client Secret o Campaign ID).';
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }

    try {
      const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
      const response = await fetchWithTimeout(
        EBAY_OAUTH_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${basicAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
        },
        8000,
      );
      if (response.ok) {
        const message = 'OAuth de eBay verificado: token de aplicación obtenido correctamente.';
        setNetworkStatus(this.networkId, 'connected', message);
        return { ok: true, message };
      }
      const message = `eBay rechazó las credenciales (HTTP ${response.status}). Revisa Client ID y Secret.`;
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    } catch {
      const message = 'No se pudo contactar con api.ebay.com. Revisa la red del servidor.';
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }
  }

  private async getAccessToken(): Promise<string> {
    const creds = getCredentialValues(this.networkId);
    if (!creds?.clientId || !creds?.clientSecret) {
      throw new ConnectorError(this.networkId, 'Faltan credenciales de eBay (Client ID o Client Secret).');
    }
    const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const response = await fetchWithTimeout(
      EBAY_OAUTH_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
      },
      10000,
    );
    if (!response.ok) {
      throw new ConnectorError(this.networkId, `eBay OAuth falló (HTTP ${response.status}).`);
    }
    const data = (await response.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new ConnectorError(this.networkId, 'eBay no devolvió access_token.');
    }
    return data.access_token;
  }

  async search(params: UnifiedSearchParams): Promise<UnifiedProduct[]> {
    const creds = getCredentialValues(this.networkId);
    if (!creds) throw new ConnectorError(this.networkId, 'eBay Partner Network no está conectado. Añade sus credenciales primero.');

    try {
      const token = await this.getAccessToken();
      const limit = Math.min(params.limit ?? 8, 50);
      const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
      if (params.query) url.searchParams.set('q', params.query);
      if (params.category) url.searchParams.set('category_ids', params.category);
      url.searchParams.set('limit', String(limit));
      if (params.inStockOnly) url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE}');
      if (params.sortBy === 'price_asc') url.searchParams.set('sort', 'price');
      else if (params.sortBy === 'price_desc') url.searchParams.set('sort', '-price');
      else if (params.sortBy === 'popularity') url.searchParams.set('sort', 'bestMatch');

      const response = await fetchWithTimeout(
        url.toString(),
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Language': 'es-ES',
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_ES',
          },
        },
        12000,
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new ConnectorError(this.networkId, `Browse API HTTP ${response.status}: ${text.slice(0, 120)}`);
      }

      const data = (await response.json()) as {
        itemSummaries?: Array<{
          itemId?: string;
          title?: string;
          price?: { value?: string; currency?: string };
          image?: { imageUrl?: string };
          itemWebUrl?: string;
          itemAffiliateWebUrl?: string;
          categories?: Array<{ categoryName?: string }>;
          condition?: string;
          buyingOptions?: string[];
          shippingOptions?: Array<{ shippingCost?: { value?: string } }>;
        }>;
      };

      const items = data.itemSummaries ?? [];
      const campaignId = creds.campaignId;

      return items
        .filter((item) => item.itemId && item.price?.value)
        .map((item) => {
          const price = parseFloat(item.price?.value ?? '0') || 0;
          const baseUrl = item.itemAffiliateWebUrl || item.itemWebUrl || '';
          const productUrl = campaignId && baseUrl.includes('?')
            ? `${baseUrl}&mkmk=${campaignId}`
            : campaignId
              ? `${baseUrl}?mkmk=${campaignId}`
              : baseUrl;

          const product: UnifiedProduct = {
            network: this.networkId,
            externalId: item.itemId!,
            title: item.title ?? 'Producto eBay',
            description: '',
            price,
            currency: item.price?.currency ?? 'EUR',
            image: item.image?.imageUrl ?? '',
            category: params.category || item.categories?.[0]?.categoryName || 'General',
            productUrl,
            inStock: item.buyingOptions?.includes('FIXED_PRICE') ?? true,
            estimated: false,
          };
          if (item.shippingOptions?.[0]?.shippingCost?.value === '0.0') {
            product.shippingInfo = 'Envío gratis';
          }
          return product;
        });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      return sampleProducts(this.networkId, params, 37);
    }
  }
}
