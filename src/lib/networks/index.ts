/**
 * ==============================================================================
 * TRADYLOR - MOTOR DE BÚSQUEDA UNIFICADO MULTI-RED
 * ==============================================================================
 * Punto de entrada del módulo:
 *   - getConnector(id): resuelve el conector de cada red.
 *   - unifiedSearch(params): consulta EN PARALELO todas las redes conectadas,
 *     aplica filtros cruzados (precio, comisión, rating, stock) y ordena.
 * Una red caída o sin conectar nunca rompe la búsqueda global: su resultado se
 * devuelve como entrada de error en `byNetwork`.
 * ==============================================================================
 */

import { getAllNetworks } from './registry';
import { getConnectedNetworkIds, getAllNetworkViews } from './credentials';
import type { NetworkConnector } from './connectors/base';
import { AmazonConnector } from './connectors/amazon';
import { AwinConnector } from './connectors/awin';
import { EbayConnector } from './connectors/ebay';
import { AliExpressConnector } from './connectors/aliexpress';
import { GenericConnector } from './connectors/generic';
import type {
  NetworkSearchResult,
  NetworkView,
  UnifiedProduct,
  UnifiedSearchParams,
  UnifiedSearchResponse,
} from './types';

/** Mapa de conectores reales; el resto usa el conector genérico de arranque. */
const CONNECTORS: Record<string, NetworkConnector> = {
  amazon: new AmazonConnector(),
  awin: new AwinConnector(),
  ebay: new EbayConnector(),
  aliexpress: new AliExpressConnector(),
};

export function getConnector(networkId: string): NetworkConnector | null {
  if (!getAllNetworks().some((network) => network.id === networkId)) return null;
  return CONNECTORS[networkId] ?? new GenericConnector(networkId);
}

/** Estado público de todas las redes para el panel. */
export function getNetworksOverview(): NetworkView[] {
  return getAllNetworkViews();
}

function matchesFilters(product: UnifiedProduct, params: UnifiedSearchParams): boolean {
  if (params.minPrice != null && product.price < params.minPrice) return false;
  if (params.maxPrice != null && product.price > params.maxPrice) return false;
  if (params.minCommission != null && (product.commissionRate ?? 0) < params.minCommission) return false;
  if (params.minRating != null && (product.rating ?? 0) < params.minRating) return false;
  if (params.inStockOnly && !product.inStock) return false;
  if (params.category && product.category.toLowerCase() !== params.category.toLowerCase()) return false;
  return true;
}

function sortResults(products: UnifiedProduct[], sortBy: UnifiedSearchParams['sortBy']): UnifiedProduct[] {
  const sorted = [...products];
  switch (sortBy) {
    case 'price_asc':
      return sorted.sort((a, b) => a.price - b.price);
    case 'price_desc':
      return sorted.sort((a, b) => b.price - a.price);
    case 'rating':
      return sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    case 'popularity':
      return sorted.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
    case 'commission':
    default:
      return sorted.sort((a, b) => (b.commissionAmount ?? 0) - (a.commissionAmount ?? 0));
  }
}

/** Búsqueda paralela en todas las redes conectadas (o en `params.networks`). */
export async function unifiedSearch(params: UnifiedSearchParams): Promise<UnifiedSearchResponse> {
  const connected = new Set(getConnectedNetworkIds());
  const requested = params.networks?.length ? params.networks : [...connected];
  const targets = requested.filter((id) => connected.has(id));

  const settled = await Promise.allSettled(
    targets.map(async (networkId): Promise<NetworkSearchResult> => {
      const connector = getConnector(networkId);
      if (!connector) return { network: networkId, ok: false, message: 'Red no registrada.', products: [] };
      const products = await connector.search(params);
      return { network: networkId, ok: true, products };
    }),
  );

  const byNetwork: NetworkSearchResult[] = settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    return {
      network: targets[index],
      ok: false,
      message: result.reason instanceof Error ? result.reason.message : 'Error desconocido en el conector.',
      products: [],
    };
  });

  const merged = byNetwork.flatMap((entry) => entry.products);
  const filtered = merged.filter((product) => matchesFilters(product, params));
  const sorted = sortResults(filtered, params.sortBy);
  const limited = params.limit ? sorted.slice(0, params.limit) : sorted;

  return {
    success: true,
    query: params,
    total: limited.length,
    results: limited,
    byNetwork,
    searchedAt: new Date().toISOString(),
  };
}
