/**
 * ==============================================================================
 * TRADYLOR - CACHÉ DEL CATÁLOGO ALIEXPRESS (aliexpress-catalog.json)
 * ==============================================================================
 * El panel de Afiliados no debe llamar a la TOP API en cada carga: guarda el
 * catálogo en el volumen (DATA_DIR) y sólo lo refresca con el botón
 * "Sincronizar" (POST). Si la caché supera las 6 horas se avisa en la UI.
 *
 *   - readAliCatalog()  -> snapshot completo o null (sin caché)
 *   - isAliCatalogStale() -> true si tiene >6h o no existe
 *   - syncAliCatalog()  -> consulta la API, deduplica y persiste
 *
 * Protegido por un guard en memoria para no lanzar dos sincronizaciones
 * simultáneas desde el panel.
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from './paths';
import { getConnector } from './networks';
import { CATALOG_KEYWORDS } from './networks/connectors/aliexpress';
import type { UnifiedProduct } from './networks/types';

export const ALI_CATALOG_STALE_MS = 6 * 60 * 60 * 1000; // 6 horas
export const ALI_CATALOG_TARGET = 150; // productos por sync
const KEYWORD_PAGE_SIZE = 20; // por keyword (50 peticido = 8 keywords x 20)

const CATALOG_FILE = dataFile('aliexpress-catalog.json');

export interface AliCatalogSnapshot {
  syncedAt: string;
  products: UnifiedProduct[];
}

export interface AliCatalogState {
  exists: boolean;
  syncedAt: string | null;
  stale: boolean;
  count: number;
}

function log(...args: unknown[]): void {
  console.log('[AliCatalog]', ...args);
}

export function readAliCatalog(): AliCatalogSnapshot | null {
  try {
    if (!fs.existsSync(CATALOG_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8')) as Partial<AliCatalogSnapshot>;
    if (!parsed || !Array.isArray(parsed.products)) return null;
    return {
      syncedAt: typeof parsed.syncedAt === 'string' ? parsed.syncedAt : '',
      products: parsed.products,
    };
  } catch (error) {
    log('Error al leer la caché:', error);
    return null;
  }
}

function writeAliCatalog(snapshot: AliCatalogSnapshot): boolean {
  try {
    fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true });
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(snapshot), 'utf-8');
    return true;
  } catch (error) {
    log('Error al guardar la caché:', error);
    return false;
  }
}

export function getAliCatalogState(): AliCatalogState {
  const snapshot = readAliCatalog();
  if (!snapshot) return { exists: false, syncedAt: null, stale: true, count: 0 };
  const syncedAt = snapshot.syncedAt ? new Date(snapshot.syncedAt) : null;
  const stale = !syncedAt || Number.isNaN(syncedAt.getTime()) || Date.now() - syncedAt.getTime() > ALI_CATALOG_STALE_MS;
  return { exists: true, syncedAt: snapshot.syncedAt || null, stale, count: snapshot.products.length };
}

export function isAliCatalogStale(): boolean {
  return getAliCatalogState().stale;
}

function byPopularity(a: UnifiedProduct, b: UnifiedProduct): number {
  return (b.popularity ?? 0) - (a.popularity ?? 0);
}

let syncInFlight: Promise<AliCatalogSyncResult> | null = null;

export interface AliCatalogSyncResult {
  ok: boolean;
  syncedAt: string | null;
  count: number;
  message: string;
  stale: boolean;
}

/**
 * Consulta la TOP API con cada keyword de catálogo, deduplica por externalId,
 * ordena por popularidad y persiste el snapshot en el volumen.
 */
export function syncAliCatalog(target = ALI_CATALOG_TARGET): Promise<AliCatalogSyncResult> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSync(target).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function runSync(target: number): Promise<AliCatalogSyncResult> {
  const connector = getConnector('aliexpress');
  if (!connector) {
    return { ok: false, syncedAt: null, count: 0, message: 'El conector de AliExpress no está disponible.', stale: getAliCatalogState().stale };
  }

  const seen = new Set<string>();
  const merged: UnifiedProduct[] = [];
  const errors: string[] = [];
  let queries = 0;

  for (const keyword of CATALOG_KEYWORDS) {
    if (merged.length >= target) break;
    try {
      const batch = await connector.search({ query: keyword, limit: KEYWORD_PAGE_SIZE });
      queries += 1;
      for (const product of batch) {
        if (seen.has(product.externalId)) continue;
        seen.add(product.externalId);
        merged.push(product);
        if (merged.length >= target) break;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Fallo con "${keyword}".`);
    }
  }

  if (!queries) {
    const message = errors[0] || 'AliExpress no respondió a ninguna petición.';
    log('sync fallida:', message);
    return { ok: false, syncedAt: null, count: getAliCatalogState().count, message, stale: getAliCatalogState().stale };
  }

  if (!merged.length) {
    const message = errors[0] || 'AliExpress no devolvió productos (¿sin credenciales o sin resultados?).';
    log('sync sin resultados:', message);
    return { ok: false, syncedAt: null, count: 0, message, stale: getAliCatalogState().stale };
  }

  const snapshot: AliCatalogSnapshot = { syncedAt: new Date().toISOString(), products: merged.sort(byPopularity) };
  const saved = writeAliCatalog(snapshot);
  const partial = errors.length > 0;

  let message: string;
  if (!saved) message = 'No se pudo escribir la caché en el volumen.';
  else if (partial) message = `Catálogo actualizado con ${merged.length} productos (parcial: ${errors[0]}).`;
  else message = `Catálogo sincronizado: ${merged.length} productos de AliExpress.`;
  log(message);

  return { ok: saved, syncedAt: saved ? snapshot.syncedAt : null, count: snapshot.products.length, message, stale: false };
}
