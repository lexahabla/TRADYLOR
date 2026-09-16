/**
 * ==============================================================================
 * TRADYLOR - CONECTOR AWIN
 * ==============================================================================
 * Documentación oficial: https://developer.awin.com/
 *
 * Awin Publisher API ofrece endpoints REST con autenticación Bearer que ya
 * pueden consultarse: accounts, programmes y feeds. La búsqueda de producto se
 * resuelve vía feeds descargables por anunciante (fase 2).
 * ==============================================================================
 */

import { ConnectorError, fetchWithTimeout, sampleProducts, type NetworkConnector } from './base';
import { getCredentialValues, setNetworkStatus } from '../credentials';
import type { UnifiedProduct, UnifiedSearchParams } from '../types';

const AWIN_API_BASE = 'https://api.awin.com';

export class AwinConnector implements NetworkConnector {
  readonly networkId = 'awin';

  async validate(): Promise<{ ok: boolean; message: string }> {
    const creds = getCredentialValues(this.networkId);
    if (!creds?.publisherId || !creds?.apiToken) {
      const message = 'Faltan credenciales obligatorias (Publisher ID o API Token).';
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }

    try {
      const response = await fetchWithTimeout(
        `${AWIN_API_BASE}/publishers/${encodeURIComponent(creds.publisherId)}/accounts`,
        { headers: { Authorization: `Bearer ${creds.apiToken}`, Accept: 'application/json' } },
        8000,
      );
      if (response.ok) {
        const message = 'Conexión verificada con la API de Awin.';
        setNetworkStatus(this.networkId, 'connected', message);
        return { ok: true, message };
      }
      const message = `Awin rechazó las credenciales (HTTP ${response.status}). Revisa el Publisher ID y el token.`;
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    } catch {
      const message = 'No se pudo contactar con api.awin.com. Revisa la red del servidor.';
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }
  }

  async search(params: UnifiedSearchParams): Promise<UnifiedProduct[]> {
    const creds = getCredentialValues(this.networkId);
    if (!creds) throw new ConnectorError(this.networkId, 'Awin no está conectado. Añade sus credenciales primero.');

    // TODO (fase 2): descargar feed de producto por anunciante
    //   GET /publishers/{publisherId}/product-feeds  →  feedUrl
    //   y normalizar filas (price, commission_group, stock, aw_deep_link)
    return sampleProducts(this.networkId, params, 23);
  }
}
