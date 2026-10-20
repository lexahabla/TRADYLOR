/**
 * ==============================================================================
 * TRADYLOR - CONECTOR eBAY PARTNER NETWORK
 * ==============================================================================
 * Documentación oficial: https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search
 *
 * Flujo OAuth client-credentials implementado en validate(): intercambia
 * Client ID/Secret por un token de aplicación.
 * Búsqueda Browse API (/item_summary/search) con headers correctos para España.
 * Usa EbayProductAdapter para normalizar la respuesta al contrato canónico
 * (CanonicalAffiliateProduct → UnifiedProduct vía canonicalToUnified).
 * ==============================================================================
 */

import { ConnectorError, canonicalToUnified, fetchWithTimeout, sampleProducts, type NetworkConnector } from './base';
import { getCredentialValues, setNetworkStatus } from '../credentials';
import type { CanonicalAffiliateProduct, UnifiedProduct, UnifiedSearchParams } from '../types';
import { EbayProductAdapter, type EbayItemSummary, type EbaySearchResponse } from './adapters/ebayProductAdapter';

const EBAY_OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_BROWSE_SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

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

  /** Consulta la Browse API y devuelve los itemSummaries crudos de eBay. */
  private async fetchItemSummaries(params: UnifiedSearchParams): Promise<EbayItemSummary[]> {
    const creds = getCredentialValues(this.networkId);
    if (!creds) {
      throw new ConnectorError(this.networkId, 'eBay Partner Network no está conectado. Añade sus credenciales primero.');
    }

    const token = await this.getAccessToken();
    const limit = Math.min(params.limit ?? 20, 50);
    const url = new URL(EBAY_BROWSE_SEARCH_URL);

    // Parámetros de búsqueda
    if (params.query) url.searchParams.set('q', params.query);
    if (params.category) url.searchParams.set('category_ids', params.category);
    url.searchParams.set('limit', String(limit));

    // Filtros - solo los soportados por eBay Browse API
    if (params.inStockOnly) {
      url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE}');
    }

    // Ordenación
    if (params.sortBy === 'price_asc') {
      url.searchParams.set('sort', 'price');
    } else if (params.sortBy === 'price_desc') {
      url.searchParams.set('sort', '-price');
    } else if (params.sortBy === 'popularity') {
      url.searchParams.set('sort', 'bestMatch');
    }
    // Nota: eBay no soporta orden por rating ni comisión directamente

    // Paginación (offset)
    if (params.page && params.page > 1) {
      url.searchParams.set('offset', String((params.page - 1) * limit));
    }

    // Headers correctos para marketplace España
    const response = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Language': 'es-ES',
          // Marketplace ID correcto para España (formato con guion)
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY-ES',
          // Contexto de usuario final para resultados localizados en España
          'X-EBAY-C-ENDUSERCTX': 'contextualLocation=country=ES',
        },
      },
      15000,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ConnectorError(this.networkId, `Browse API HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as EbaySearchResponse;
    return data.itemSummaries ?? [];
  }

  async search(params: UnifiedSearchParams): Promise<UnifiedProduct[]> {
    try {
      // Delega en la ruta canónica (mismo mapeo que usa el pipeline de catálogo)
      const canonical = await this.searchCanonical(params);

      // Si no hay resultados reales, devolver productos de muestra (estimated: true)
      if (canonical.length === 0) {
        return sampleProducts(this.networkId, params, 37);
      }

      return canonical.map(canonicalToUnified);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      console.error('[EbayConnector] Error en búsqueda:', error);
      // Fallback a productos de muestra en caso de error inesperado
      return sampleProducts(this.networkId, params, 37);
    }
  }

  /**
   * Búsqueda/sincronización al contrato canónico CanonicalAffiliateProduct.
   * A diferencia de search(), NO devuelve datos de muestra: el pipeline de
   * catálogo sólo debe ingerir productos reales (vacío si no hay resultados).
   *
   * El normalizador (EbayProductAdapter.adaptCanonical) aplica fallbacks para
   * que el panel no muestre celdas «—»: descuento/precio original calculados,
   * rating 4.5 y 15 opiniones sin feedback, comisión base EPN
   * (EBAY_COMMISSION_RATE, por defecto 5%), vendedor «Vendedor de eBay» y
   * envío «Envío estándar eBay (3-5 días)» cuando no hay fechas estimadas.
   */
  async searchCanonical(params: UnifiedSearchParams): Promise<CanonicalAffiliateProduct[]> {
    const items = await this.fetchItemSummaries(params);
    const creds = getCredentialValues(this.networkId);
    const campaignId = creds?.campaignId ?? '';
    const adapter = new EbayProductAdapter(campaignId, params);
    return adapter.adaptCanonical(items);
  }
}