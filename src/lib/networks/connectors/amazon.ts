/**
 * ==============================================================================
 * TRADYLOR - CONECTOR AMAZON ASSOCIATES (PA-API 5.0)
 * ==============================================================================
 * Documentación oficial: https://webservices.amazon.com/paapi5/documentation/
 *
 * Estado: listo para cablear. La firma AWS SigV4 requerida por PA-API 5.0 se
 * implementará en `signedRequest()`; mientras tanto, si hay credenciales la
 * validación confirma su formato y la búsqueda devuelve muestra estimada.
 * ==============================================================================
 */

import { ConnectorError, fetchWithTimeout, sampleProducts, type NetworkConnector } from './base';
import { getCredentialValues, setNetworkStatus } from '../credentials';
import type { UnifiedProduct, UnifiedSearchParams } from '../types';

export class AmazonConnector implements NetworkConnector {
  readonly networkId = 'amazon';

  async validate(): Promise<{ ok: boolean; message: string }> {
    const creds = getCredentialValues(this.networkId);
    if (!creds?.accessKey || !creds?.secretKey || !creds?.trackingId) {
      const message = 'Faltan credenciales obligatorias (Access Key, Secret Key o Tracking ID).';
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }

    // TODO (fase 2): llamada real firmada SigV4 a
    // POST https://webservices.amazon.es/paapi5/searchitems
    try {
      await fetchWithTimeout('https://webservices.amazon.es', {}, 5000);
      const message = 'Credenciales con formato válido. Host PA-API accesible (firma SigV4 pendiente).';
      setNetworkStatus(this.networkId, 'connected', message);
      return { ok: true, message };
    } catch {
      const message = 'No se pudo contactar con webservices.amazon.es. Revisa la red del servidor.';
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }
  }

  async search(params: UnifiedSearchParams): Promise<UnifiedProduct[]> {
    const creds = getCredentialValues(this.networkId);
    if (!creds) throw new ConnectorError(this.networkId, 'Amazon no está conectado. Añade sus credenciales primero.');

    // TODO (fase 2): SearchItems real con recursos:
    //   ItemInfo.Title, Offers.Listings.Price, Images.Primary.Large,
    //   CustomerReviews, BrowseNodeInfo, Availability
    return sampleProducts(this.networkId, params, 11);
  }
}
