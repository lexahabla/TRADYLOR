/**
 * ==============================================================================
 * TRADYLOR - CONECTOR GENÉRICO
 * ==============================================================================
 * Conector de arranque para el resto de redes registradas (AliExpress, CJ,
 * Admitad, Tradedoubler, Kwanko, Etsy, Webgains, Partnerize, Rakuten...).
 * Comprueba que los campos obligatorios tengan valor y devuelve resultados de
 * muestra marcados como `estimated` hasta que se implemente la API oficial.
 *
 * Para promover una red a conector real: crea connectors/<id>.ts con su clase
 * y sustitúyela en CONNECTORS (src/lib/networks/index.ts).
 * ==============================================================================
 */

import { ConnectorError, sampleProducts, type NetworkConnector } from './base';
import { getCredentialValues, setNetworkStatus } from '../credentials';
import { getNetworkDefinition } from '../registry';
import type { UnifiedProduct, UnifiedSearchParams } from '../types';

export class GenericConnector implements NetworkConnector {
  constructor(public readonly networkId: string) {}

  async validate(): Promise<{ ok: boolean; message: string }> {
    const definition = getNetworkDefinition(this.networkId);
    const creds = getCredentialValues(this.networkId);
    if (!definition || !creds) {
      const message = 'La red no tiene credenciales almacenadas.';
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }

    const missing = definition.fields.filter((f) => f.required && !creds[f.key]).map((f) => f.label);
    if (missing.length > 0) {
      const message = `Faltan campos obligatorios: ${missing.join(', ')}.`;
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }

    const message = 'Credenciales completas. La validación contra la API oficial se implementará en la fase 2.';
    setNetworkStatus(this.networkId, 'connected', message);
    return { ok: true, message };
  }

  async search(params: UnifiedSearchParams): Promise<UnifiedProduct[]> {
    const creds = getCredentialValues(this.networkId);
    if (!creds) {
      throw new ConnectorError(this.networkId, `${this.networkId} no está conectado. Añade sus credenciales primero.`);
    }
    const seed = this.networkId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return sampleProducts(this.networkId, params, seed % 97);
  }
}
