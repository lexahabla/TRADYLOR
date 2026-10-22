/**
 * Lectura del catálogo unificado de afiliados (DATA_DIR/affiliate-catalog.json).
 *
 * El catálogo de afiliados vive en el volumen (no en git). Este módulo es la
 * única fuente de verdad para leerlo desde la lógica de negocio (el endpoint
 * /api/admin/catalog reutiliza readAffiliateCatalog()).
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from './paths';
import { normalizeCatalogProducts } from './networks/connectors/base';

const CATALOG_FILE = dataFile('affiliate-catalog.json');

export interface AffiliateCatalogSnapshot {
  syncedAt: string;
  products: any[];
}

export function readAffiliateCatalog(): AffiliateCatalogSnapshot | null {
  try {
    if (!fs.existsSync(CATALOG_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8')) as Partial<AffiliateCatalogSnapshot>;
    if (!parsed || !Array.isArray(parsed.products)) return null;
    const syncedAt = typeof parsed.syncedAt === 'string' ? parsed.syncedAt : '';
    return {
      syncedAt,
      products: normalizeCatalogProducts(parsed.products, syncedAt),
    };
  } catch {
    return null;
  }
}

// Caché en memoria del mapa externalId → description (el catálogo no cambia
// dentro de un reproceso; evita releer 1.3 MB en cada uno de los 69 productos).
let cache: Map<string, string> | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60_000;

function buildCache(): Map<string, string> {
  const map = new Map<string, string>();
  const snap = readAffiliateCatalog();
  if (snap) {
    for (const p of snap.products) {
      const id = String(p.externalId || '').trim();
      const desc = String(p.description || '').trim();
      if (id && desc) {
        map.set(id, desc);
        if (p.network) map.set(`${String(p.network).trim().toLowerCase()}:${id}`, desc);
      }
    }
  }
  return map;
}

/**
 * Devuelve la descripción original del catálogo de afiliados para un producto,
 * a partir de su red (`network`) y su id externo (`externalId`/`sourceId`).
 */
export function findAffiliateDescription(network: string, externalId: string): string | undefined {
  const now = Date.now();
  if (!cache || now - cacheAt > CACHE_TTL_MS) {
    cache = buildCache();
    cacheAt = now;
  }
  const id = String(externalId || '').trim();
  if (!id) return undefined;
  const net = String(network || '').trim().toLowerCase();
  return (net && cache.get(`${net}:${id}`)) || cache.get(id);
}
