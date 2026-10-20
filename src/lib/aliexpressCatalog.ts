/**
 * ==============================================================================
 * TRADYLOR - CACHÉ DEL CATÁLOGO ALIEXPRESS (aliexpress-catalog.json)
 * ==============================================================================
 * El panel de Afiliados no debe llamar a la TOP API en cada carga: guarda el
 * catálogo en el volumen (DATA_DIR) y sólo lo refresca con el botón
 * "Sincronizar" (POST). Si la caché supera las 6 horas se avisa en la UI.
 *
 *   - readAliCatalog()  -> snapshot canónico completo o null (sin caché)
 *   - readAliCatalogUnified() -> misma caché proyectada a UnifiedProduct (UI)
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
import { canonicalToUnified, normalizeCatalogProducts, searchCatalogBatch } from './networks/connectors/base';
import { CATALOG_KEYWORDS } from './networks/connectors/aliexpress';
import { stampFirstSeen } from './aliCatalogMerge';
import type { CanonicalAffiliateProduct, UnifiedProduct } from './networks/types';

export const ALI_CATALOG_STALE_MS = 6 * 60 * 60 * 1000; // 6 horas
export const ALI_CATALOG_TARGET = 150; // productos por sync inicial
const KEYWORD_PAGE_SIZE = 20; // por keyword y página
const APPEND_MAX_PAGE = 3; // «Cargar más» recorre hasta la página 3 de cada keyword

const CATALOG_FILE = dataFile('aliexpress-catalog.json');

/** Snapshot persistido en el volumen: SIEMPRE en el contrato canónico (PASO 6). */
export interface AliCatalogSnapshot {
  syncedAt: string;
  products: CanonicalAffiliateProduct[];
}

/** Proyección para la UI/filtros (mismo shape que siempre consumió el panel). */
export interface AliCatalogUnifiedSnapshot {
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

/**
 * Lee el snapshot del volumen. Las cachés escritas antes del PASO 6 guardan
 * `UnifiedProduct[]`: se migran a canónico en memoria (la próxima escritura las
 * reconsolida en disco).
 */
export function readAliCatalog(): AliCatalogSnapshot | null {
  try {
    if (!fs.existsSync(CATALOG_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8')) as Partial<AliCatalogSnapshot>;
    if (!parsed || !Array.isArray(parsed.products)) return null;
    const syncedAt = typeof parsed.syncedAt === 'string' ? parsed.syncedAt : '';
    return {
      syncedAt,
      products: normalizeCatalogProducts(parsed.products, syncedAt),
    };
  } catch (error) {
    log('Error al leer la caché:', error);
    return null;
  }
}

/** Lectura en forma UnifiedProduct (panel, alertas de precio, envíos). */
export function readAliCatalogUnified(): AliCatalogUnifiedSnapshot | null {
  const snapshot = readAliCatalog();
  if (!snapshot) return null;
  return {
    syncedAt: snapshot.syncedAt,
    products: snapshot.products.map(canonicalToUnified),
  };
}

export function writeAliCatalog(snapshot: AliCatalogSnapshot): boolean {
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

function byPopularity(a: CanonicalAffiliateProduct, b: CanonicalAffiliateProduct): number {
  return (b.sales ?? 0) - (a.sales ?? 0);
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
 *  - sync normal: refresca la página 1 de cada keyword y la mezcla con la
 *    caché actual (no borra productos ya descargados).
 *  - append («Cargar más»): además descarga las páginas 2 y 3 de cada keyword
 *    para ampliar el catálogo con productos nuevos.
 */
export function syncAliCatalog(options: { append?: boolean } = {}): Promise<AliCatalogSyncResult> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSync(Boolean(options.append)).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function runSync(append: boolean): Promise<AliCatalogSyncResult> {
  const connector = getConnector('aliexpress');
  if (!connector) {
    return { ok: false, syncedAt: null, count: 0, message: 'El conector de AliExpress no está disponible.', stale: getAliCatalogState().stale };
  }

  const previous = readAliCatalog();
  const existing = previous?.products ?? [];
  const mergedById = new Map<string, CanonicalAffiliateProduct>();
  for (const product of existing) mergedById.set(product.externalId, product);
  const baseCount = mergedById.size;

  const errors: string[] = [];
  let queries = 0;
  const pages = append && existing.length ? [1, 2, APPEND_MAX_PAGE] : [1];

  for (const page of pages) {
    for (const keyword of CATALOG_KEYWORDS) {
      try {
        const params = { query: keyword, limit: KEYWORD_PAGE_SIZE, page };
        // Ruta canónica (contrato único persistible); si el conector no la
        // declara, searchCatalogBatch migra su salida legada a canónico.
        const batch = await searchCatalogBatch(connector, params);
        queries += 1;
        for (const product of batch) mergedById.set(product.externalId, product);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `Fallo con "${keyword}" (página ${page}).`);
      }
    }
  }

  if (!queries) {
    const message = errors[0] || 'AliExpress no respondió a ninguna petición.';
    log('sync fallida:', message);
    return { ok: false, syncedAt: null, count: getAliCatalogState().count, message, stale: getAliCatalogState().stale };
  }

  // Los productos frescos de la API reemplazan a los cacheados: `firstSeenAt` hay que
  // arrastrarlo (o fijarlo si es nuevo). El mismo instante va en `syncedAt` y en las altas.
  const syncedAt = new Date().toISOString();
  const merged = stampFirstSeen([...mergedById.values()], existing, previous?.syncedAt, syncedAt).sort(byPopularity);
  if (!merged.length) {
    const message = errors[0] || 'AliExpress no devolvió productos (¿sin credenciales o sin resultados?).';
    log('sync sin resultados:', message);
    return { ok: false, syncedAt: null, count: 0, message, stale: getAliCatalogState().stale };
  }

  const snapshot: AliCatalogSnapshot = { syncedAt, products: merged };
  const saved = writeAliCatalog(snapshot);
  const partial = errors.length > 0;
  const added = merged.length - baseCount;

  let message: string;
  if (!saved) message = 'No se pudo escribir la caché en el volumen.';
  else if (append) message = `Catálogo ampliado: ${merged.length} productos en total (+${added} nuevos).`;
  else if (partial) message = `Catálogo actualizado con ${merged.length} productos (parcial: ${errors[0]}).`;
  else message = `Catálogo sincronizado: ${merged.length} productos de AliExpress.`;
  log(message);

  return { ok: saved, syncedAt: saved ? snapshot.syncedAt : null, count: snapshot.products.length, message, stale: false };
}
