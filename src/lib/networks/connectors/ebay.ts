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

  async search(params: UnifiedSearchParams): Promise<UnifiedProduct[]> {
    const creds = getCredentialValues(this.networkId);
    if (!creds) throw new ConnectorError(this.networkId, 'eBay Partner Network no está conectado. Añade sus credenciales primero.');

    // TODO (fase 2): GET https://api.ebay.com/buy/browse/v1/item_summary/search?q=...
    //   con token OAuth y mkmk/affiliate tracking por campaignId
    return sampleProducts(this.networkId, params, 37);
  }
}
