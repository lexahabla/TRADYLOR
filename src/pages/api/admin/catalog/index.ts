/**
 * ==============================================================================
 * TRADYLOR - API ADMIN: CATÁLOGO UNIFICADO MULTI-RED
 * ==============================================================================
 * GET  /api/admin/catalog
 *   -> { success, connected, syncedAt, stale, count, products, networks }
 *      Lee el snapshot guardado en el volumen. NO consulta las APIs.
 *
 * POST /api/admin/catalog
 *   -> { success, ok, syncedAt, stale, count, message, products, networks }
 *      Fuerza una sincronización contra TODAS las redes conectadas.
 *      Body opcional { append: true } descarga más páginas de cada keyword.
 *
 * Ambas protegidas por sesión de administrador.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import {
  ALI_CATALOG_STALE_MS,
  getAliCatalogState,
  readAliCatalog,
  syncAliCatalog,
} from '../../../../lib/aliexpressCatalog';
import { getConnectedNetworkIds } from '../../../../lib/networks/credentials';
import { getConnector } from '../../../../lib/networks';
import { canonicalToUnified } from '../../../../lib/networks/connectors/base';
import { CATALOG_KEYWORDS } from '../../../../lib/networks/connectors/aliexpress';
import { stampFirstSeen } from '../../../../lib/aliCatalogMerge';
import type { UnifiedProduct } from '../../../../lib/networks/types';
import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from '../../../../lib/paths';

export const prerender = false;

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const CATALOG_FILE = dataFile('affiliate-catalog.json');

export interface AffiliateCatalogSnapshot {
  syncedAt: string;
  products: UnifiedProduct[];
}

function readAffiliateCatalog(): AffiliateCatalogSnapshot | null {
  try {
    if (!fs.existsSync(CATALOG_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8')) as Partial<AffiliateCatalogSnapshot>;
    if (!parsed || !Array.isArray(parsed.products)) return null;
    return {
      syncedAt: typeof parsed.syncedAt === 'string' ? parsed.syncedAt : '',
      products: parsed.products,
    };
  } catch {
    return null;
  }
}

function writeAffiliateCatalog(snapshot: AffiliateCatalogSnapshot): boolean {
  try {
    fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true });
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(snapshot), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function currentStatePayload() {
  const state = getAliCatalogState();
  const snapshot = readAffiliateCatalog();
  const connected = getConnectedNetworkIds();
  return {
    success: true,
    connected,
    staleMs: ALI_CATALOG_STALE_MS,
    syncedAt: state.syncedAt,
    stale: state.stale,
    count: snapshot?.products.length ?? 0,
    products: snapshot?.products ?? [],
    networks: connected,
  };
}

export const GET: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;
  return new Response(JSON.stringify(currentStatePayload()), { status: 200, headers: jsonHeaders });
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  const body = (await request.json().catch(() => ({}))) as { append?: boolean; networkId?: string };
  const connected = getConnectedNetworkIds();
  const targetNetworkId = body?.networkId;
  const networksToSync = targetNetworkId ? (connected.includes(targetNetworkId) ? [targetNetworkId] : []) : connected;
  const errors: string[] = [];
  let totalAdded = 0;

  const previous = readAffiliateCatalog();
  const existing = previous?.products ?? [];
  const mergedById = new Map<string, UnifiedProduct>();
  for (const product of existing) mergedById.set(`${product.network}:${product.externalId}`, product);

  for (const networkId of networksToSync) {
    const connector = getConnector(networkId);
    if (!connector) {
      errors.push(`Conector no disponible para ${networkId}`);
      continue;
    }

    try {
      if (networkId === 'aliexpress') {
        const result = await syncAliCatalog({ append: body?.append === true });
        if (result.ok) {
          const aliSnapshot = readAliCatalog();
          if (aliSnapshot) {
            for (const product of aliSnapshot.products) {
              mergedById.set(`${product.network}:${product.externalId}`, product);
            }
          }
          totalAdded += result.count;
        } else {
          errors.push(result.message);
        }
      } else {
        const pages = body?.append ? [1, 2, 3] : [1];
        for (const page of pages) {
          for (const keyword of CATALOG_KEYWORDS) {
            try {
              let batch: UnifiedProduct[];
              if (connector.searchCanonical) {
                const canonicalBatch = await connector.searchCanonical({ query: keyword, limit: 20, page });
                batch = canonicalBatch.map(canonicalToUnified);
              } else {
                const legacyBatch = await connector.search({ query: keyword, limit: 20, page });
                // Nunca ingerir productos de muestra (estimated) en la caché real
                batch = legacyBatch.filter((product) => !product.estimated);
              }
              for (const product of batch) {
                mergedById.set(`${product.network}:${product.externalId}`, product);
              }
              totalAdded += batch.length;
            } catch (error) {
              errors.push(error instanceof Error ? error.message : `Fallo con "${keyword}" en ${networkId} (página ${page})`);
            }
          }
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Error desconocido en ${networkId}`);
    }
  }

  if (targetNetworkId && !networksToSync.length) {
    errors.push(`La red "${targetNetworkId}" no está conectada o no tiene credenciales válidas.`);
  }

  const syncedAt = new Date().toISOString();
  const merged = stampFirstSeen([...mergedById.values()], existing, previous?.syncedAt, syncedAt);
  const snapshot: AffiliateCatalogSnapshot = { syncedAt, products: merged };
  const saved = writeAffiliateCatalog(snapshot);

  const message = saved
    ? `Catálogo sincronizado: ${merged.length} productos de ${networksToSync.length} red${networksToSync.length !== 1 ? 'es' : ''}.`
    : 'No se pudo guardar la caché en el volumen.';

  return new Response(
    JSON.stringify({
      ...currentStatePayload(),
      success: saved,
      ok: saved,
      message,
      errors: errors.length ? errors : undefined,
    }),
    { status: 200, headers: jsonHeaders },
  );
};
