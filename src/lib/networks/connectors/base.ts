/**
 * ==============================================================================
 * TRADYLOR - CONECTOR BASE
 * ==============================================================================
 * Contrato que cumple cada conector de red. Los conectores reales llaman a las
 * APIs oficiales (PA-API 5.0, Browse API, Awin Publisher API...); cuando la red
 * no tiene credenciales o la API aún no está cableada, devuelven datos de
 * muestra claramente marcados con `estimated: true` para no bloquear la UI.
 * ==============================================================================
 */

import type { UnifiedProduct, UnifiedSearchParams } from '../types';

export interface NetworkConnector {
  readonly networkId: string;
  /** Valida las credenciales almacenadas contra la API real de la red. */
  validate(): Promise<{ ok: boolean; message: string }>;
  /** Busca productos normalizados en la red. */
  search(params: UnifiedSearchParams): Promise<UnifiedProduct[]>;
}

/** Error estándar de conector con mensaje legible para el panel. */
export class ConnectorError extends Error {
  constructor(
    public readonly networkId: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/** Helper: fetch con timeout para que una red caída nunca bloquee la búsqueda global. */
export async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Genera productos de muestra normalizados para maquetar la UI antes de cablear la API real. */
export function sampleProducts(networkId: string, params: UnifiedSearchParams, base: number): UnifiedProduct[] {
  const term = (params.query || 'producto').slice(0, 40);
  const count = Math.min(params.limit ?? 8, 8);
  return Array.from({ length: count }, (_, index) => {
    const price = Math.round((base + index * 17.49 + (term.length * 1.3)) * 100) / 100;
    const commissionRate = 2 + ((base + index) % 9);
    return {
      network: networkId,
      externalId: `${networkId}-demo-${base}-${index}`,
      title: `${term.charAt(0).toUpperCase()}${term.slice(1)} — modelo destacado ${index + 1} (${networkId})`,
      description: `Resultado de muestra de la red ${networkId} para “${term}”. Conecta la API oficial para datos reales.`,
      price,
      originalPrice: Math.round(price * 1.18 * 100) / 100,
      currency: 'EUR',
      image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?q=80&w=800&auto=format&fit=crop',
      category: params.category || 'Tecnología',
      productUrl: `https://example.com/${networkId}/producto/${index}`,
      commissionRate,
      commissionAmount: Math.round(price * (commissionRate / 100) * 100) / 100,
      rating: Math.round((3.6 + ((base + index) % 14) / 10) * 10) / 10,
      reviewsCount: 40 + base * 13 + index * 57,
      popularity: 50 + ((base + index * 7) % 50),
      inStock: (index + base) % 5 !== 0,
      shippingInfo: 'Envío estándar',
      estimated: true,
    };
  });
}
