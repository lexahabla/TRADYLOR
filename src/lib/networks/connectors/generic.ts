/**
 * ==============================================================================
 * TRADYLOR - CONECTOR GENÉRICO
 * ==============================================================================
 * Conector de arranque para el resto de redes registradas (AliExpress, CJ,
 * Admitad, Tradedoubler, Kwanko, Etsy, Webgains, Partnerize, Rakuten...).
 * Comprueba que los campos obligatorios tengan valor y devuelve resultados de
 * muestra marcados como `estimated` hasta que se implemente la API oficial.
 *
 * `searchCanonical()` traduce siempre esas entradas de prueba al contrato
 * estricto `CanonicalAffiliateProduct` (con fallbacks seguros en cada campo),
 * de modo que el 100 % de los conectores declara la ruta canónica; al ir
 * marcadas `estimated: true`, `searchCatalogBatch` las excluye del catálogo
 * real. `search()` delega en ese método (único normalizador).
 *
 * Para promover una red a conector real: crea connectors/<id>.ts con su clase
 * y sustitúyela en CONNECTORS (src/lib/networks/index.ts).
 * ==============================================================================
 */

import { ConnectorError, canonicalToUnified, sampleProducts, type NetworkConnector } from './base';
import { getCredentialValues, setNetworkStatus } from '../credentials';
import { getNetworkDefinition } from '../registry';
import type { CanonicalAffiliateProduct, UnifiedProduct, UnifiedSearchParams } from '../types';

function seedOf(networkId: string): number {
  return networkId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 97;
}

/** Último recurso si la muestra venía sin URL: nunca un enlace vacío. */
const DEMO_FALLBACK_URL = 'https://example.com/';

function extraText(extra: UnifiedProduct['extra'], key: string): string {
  const value = extra?.[key];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

/**
 * Convierte una entrada de muestra en un `CanonicalAffiliateProduct` estricto:
 * todos los campos obligatorios reciben un valor seguro (0, '' o el de la
 * muestra) para que ningún consumidor del contrato reciba `undefined`.
 */
function sampleToCanonical(sample: UnifiedProduct): CanonicalAffiliateProduct {
  const price = Number.isFinite(sample.price) && sample.price > 0 ? sample.price : 0;
  const originalPrice = sample.originalPrice && sample.originalPrice > price ? sample.originalPrice : price;
  const discountPercentage = originalPrice > price
    ? Math.round(((originalPrice - price) / originalPrice) * 10000) / 100
    : 0;

  const commissionRate = sample.commissionRate ?? 0;
  const estimatedCommission = sample.commissionAmount
    ?? (price > 0 && commissionRate > 0 ? Math.round(price * (commissionRate / 100) * 100) / 100 : 0);

  const directUrl = sample.productUrl || '';
  const affiliateUrl = extraText(sample.extra, 'Enlace de afiliado') || directUrl;

  const shippingDays = sample.shippingDays
    ?? (extraText(sample.extra, 'Días de envío') ? Number(extraText(sample.extra, 'Días de envío')) : undefined);
  const technicalSpecs: Record<string, string> = {};
  if (shippingDays != null && Number.isFinite(shippingDays)) technicalSpecs['Días de envío'] = String(shippingDays);
  else if (sample.shippingInfo) technicalSpecs['Envío'] = sample.shippingInfo;

  return {
    network: sample.network,
    externalId: sample.externalId || `${sample.network}-demo`,
    affiliateUrl: affiliateUrl || directUrl || DEMO_FALLBACK_URL,
    directUrl: directUrl || affiliateUrl,
    title: sample.title || 'Producto de muestra',
    description: sample.description || sample.title || 'Entrada de prueba pendiente de conectar con la API oficial.',
    price,
    originalPrice,
    currency: sample.currency || 'EUR',
    discountPercentage,
    inStock: sample.inStock !== false,
    commissionRate,
    estimatedCommission,
    category: sample.category || 'General',
    brand: extraText(sample.extra, 'Marca') || undefined,
    merchantName: extraText(sample.extra, 'Tienda') || sample.network,
    merchantId: extraText(sample.extra, 'ID tienda') || undefined,
    rating: Number.isFinite(sample.rating) ? (sample.rating ?? 0) : 0,
    reviewCount: Number.isFinite(sample.reviewsCount) ? (sample.reviewsCount ?? 0) : 0,
    sales: sample.popularity ?? undefined,
    mainImage: sample.image || '',
    extraImages: sample.gallery ?? [],
    technicalSpecs: Object.keys(technicalSpecs).length ? technicalSpecs : undefined,
    estimated: sample.estimated === true,
    syncedAt: new Date().toISOString(),
  };
}

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
    const seed = seedOf(this.networkId);
    try {
      // Delega en la ruta canónica: mismo contrato que usa el pipeline de catálogo
      const canonical = await this.searchCanonical(params);
      if (!canonical.length) return sampleProducts(this.networkId, params, seed);
      return canonical.map(canonicalToUnified);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      console.warn(`[GenericConnector:${this.networkId}] Error en búsqueda:`, error);
      return sampleProducts(this.networkId, params, seed);
    }
  }

  /**
   * Entradas genéricas/de prueba al contrato canónico estricto. Siempre devuelve
   * objetos completos `CanonicalAffiliateProduct` (fallbacks seguros) y nunca
   * datos reales: van `estimated: true`, por lo que `searchCatalogBatch` no los
   * ingiere en el catálogo. Falta de credenciales → ConnectorError, igual que
   * antes en search().
   */
  async searchCanonical(params: UnifiedSearchParams): Promise<CanonicalAffiliateProduct[]> {
    const creds = getCredentialValues(this.networkId);
    if (!creds) {
      throw new ConnectorError(this.networkId, `${this.networkId} no está conectado. Añade sus credenciales primero.`);
    }
    return sampleProducts(this.networkId, params, seedOf(this.networkId)).map(sampleToCanonical);
  }
}
