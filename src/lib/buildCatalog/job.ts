/**
 * ============================================================================
 * TRADYLOR - BUILD-CATALOG · EJECUCIÓN EN SEGUNDO PLANO (jobs)
 * ============================================================================
 * Construir el catálogo multi-comerciante (ingesta × redes × keywords,
 * dedupe, categorización, enriquecimiento IA por grupo) es una operación LENTA
 * que puede superar el timeout del proxy (Easy Panel). Este módulo la lanza en
 * segundo plano y persiste el progreso en `build-catalog-job.json` (DATA_DIR /
 * volumen en prod) para que:
 *   - la petición HTTP devuelva AL INMEDIATO (`{ started: true }`);
 *   - el panel consulte el avance con GET sin mantener abierta la petición;
 *   - el proceso sobreviva al cierre de la respuesta HTTP (servidor Node
 *     standalone, no serverless).
 *
 * Patrón espejo de src/lib/pipeline/job.ts.
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from '../paths';
import {
  ingestAllNetworks,
  qualityFilter,
  deduplicateCrossMerchant,
  autoCategorize,
  detectHSR,
  smartSort,
  buildAndUpsertProducts,
} from '../../pages/api/v1/products/build-catalog';

export type JobStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'interrupted' | 'error';

export interface BuildCatalogJobState {
  id: string;
  status: JobStatus;
  networksQueried: string[];
  rawTotal: number;
  afterQualityFilter: number;
  crossMerchantGroups: number;
  processed: number;
  upserted: number;
  updated: number;
  current: string | null;
  enrich: boolean;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  message: string;
  errors: string[];
  report: any | null;
}

const JOB_FILE = dataFile('build-catalog-job.json');
const MAX_ERRORS = 20;

function jobDelayMs(): number {
  const raw = Number(process.env.BUILD_CATALOG_JOB_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let activeJobId: string | null = null;
let cancelRequested = false;

function emptyState(): BuildCatalogJobState {
  return {
    id: '',
    status: 'idle',
    networksQueried: [],
    rawTotal: 0,
    afterQualityFilter: 0,
    crossMerchantGroups: 0,
    processed: 0,
    upserted: 0,
    updated: 0,
    current: null,
    enrich: true,
    dryRun: false,
    startedAt: '',
    finishedAt: null,
    message: '',
    errors: [],
    report: null,
  };
}

function writeState(state: BuildCatalogJobState): boolean {
  try {
    fs.mkdirSync(path.dirname(JOB_FILE), { recursive: true });
    const tmpPath = `${JOB_FILE}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, JOB_FILE);
    return true;
  } catch (error) {
    console.error('[BuildCatalogJob] Error al guardar build-catalog-job.json:', error);
    return false;
  }
}

export function getBuildCatalogJob(): BuildCatalogJobState | null {
  let parsed: Partial<BuildCatalogJobState> | null = null;
  try {
    if (!fs.existsSync(JOB_FILE)) return null;
    parsed = JSON.parse(fs.readFileSync(JOB_FILE, 'utf-8')) as Partial<BuildCatalogJobState>;
  } catch (error) {
    console.error('[BuildCatalogJob] Error al leer build-catalog-job.json:', error);
    return null;
  }
  if (!parsed || !parsed.id) return null;

  const state: BuildCatalogJobState = { ...emptyState(), ...parsed } as BuildCatalogJobState;
  if (state.status === 'running' && state.id !== activeJobId) {
    state.status = 'interrupted';
    state.message = 'El servidor se reinició durante la ejecución: el lote quedó incompleto.';
    state.finishedAt = state.finishedAt || new Date().toISOString();
  }
  return state;
}

export function isBuildCatalogJobRunning(): boolean {
  return activeJobId !== null;
}

export function startBuildCatalogJob(options: {
  enrich?: boolean;
  dryRun?: boolean;
  concurrency?: number;
}): { ok: boolean; state?: BuildCatalogJobState; message?: string } {
  if (activeJobId) {
    return { ok: false, message: 'Ya hay una construcción de catálogo en marcha. Espera a que termine o deténla.' };
  }

  const state: BuildCatalogJobState = {
    ...emptyState(),
    id: new Date().toISOString(),
    status: 'running',
    enrich: options.enrich !== false,
    dryRun: options.dryRun === true,
    startedAt: new Date().toISOString(),
    message: 'Construyendo catálogo multi-comerciante… (iniciado)',
  };
  state.status = 'running';

  activeJobId = state.id;
  cancelRequested = false;
  writeState(state);

  void runJob(state, options.concurrency ?? 2);

  return { ok: true, state };
}

export function cancelBuildCatalogJob(): { ok: boolean; message: string } {
  if (!activeJobId) {
    return { ok: false, message: 'No hay ninguna construcción de catálogo en marcha.' };
  }
  cancelRequested = true;
  const state = getBuildCatalogJob();
  if (state) {
    state.message = 'Deteniendo tras el lote en curso…';
    writeState(state);
  }
  return { ok: true, message: 'Se ha pedido detener la construcción del catálogo.' };
}

async function runJob(state: BuildCatalogJobState, concurrency: number): Promise<void> {
  const delay = jobDelayMs();
  try {
    // 1. Ingesión paralela por red
    const { canonicalProducts, byNetwork, networksQueried, errors: ingestErrors } = await ingestAllNetworks();
    state.networksQueried = networksQueried;
    state.rawTotal = canonicalProducts.length;
    state.errors = ingestErrors.slice(0, MAX_ERRORS);
    state.message = `Ingestadas ${canonicalProducts.length} producto(s) de ${networksQueried.length} red(es).`;
    writeState(state);
    if (cancelRequested) throw new Error('cancelled');

    // 2. Filtro de calidad
    const filterStats: Record<string, number> = {};
    const qualityProducts = qualityFilter(canonicalProducts, filterStats);
    state.afterQualityFilter = qualityProducts.length;
    state.message = `${qualityProducts.length} de ${canonicalProducts.length} producto(s) pasan el filtro de calidad.`;
    writeState(state);
    if (cancelRequested) throw new Error('cancelled');

    // 3. Deduplicación cross-merchant
    const groups = deduplicateCrossMerchant(qualityProducts);
    state.crossMerchantGroups = groups.length;
    state.message = `${groups.length} grupo(s) cross-merchant tras deduplicar.`;
    writeState(state);
    if (cancelRequested) throw new Error('cancelled');

    // 4. Categorización
    const { categorizedGroups, categoryBreakdown, uncategorized } = await autoCategorize(groups);
    state.message = `${categorizedGroups.length - uncategorized} grupo(s) categorizado(s), ${uncategorized} sin categoría.`;
    writeState(state);
    if (cancelRequested) throw new Error('cancelled');

    // 5. HSR + ordenación
    const withHSR = detectHSR(categorizedGroups);
    const sortedGroups = smartSort(withHSR);
    const hsrCount = withHSR.filter((g) => g.isHSR).length;
    state.message = `${hsrCount} oferta(s) estrella detectada(s). Procesando grupos…`;
    writeState(state);
    if (cancelRequested) throw new Error('cancelled');

    // 6. Build + upsert por lotes con progreso por grupo
    const onProgress = (p: { processed: number; total: number; upserted: number; updated: number; current: string | null }) => {
      state.processed = p.processed;
      state.upserted = p.upserted;
      state.updated = p.updated;
      state.current = p.current;
      state.message = `Procesados ${p.processed} de ${p.total} grupo(s) (${p.upserted} nuevos, ${p.updated} actualizados).`;
      writeState(state);
    };

    await buildAndUpsertProducts(sortedGroups, state.dryRun, state.enrich, {
      onProgress,
      concurrency,
    });

    if (state.status === 'running') {
      state.status = 'done';
      state.message = `Construcción terminada: ${state.upserted} producto(s) nuevo(s), ${state.updated} actualizado(s).`;
    }
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      state.status = 'error';
      state.message = `Error inesperado al construir el catálogo: ${error?.message || error}`;
      console.error('[BuildCatalogJob] Error en el job:', error);
    }
  } finally {
    state.current = null;
    state.finishedAt = new Date().toISOString();
    state.report = {
      success: state.status === 'done',
      networksQueried: state.networksQueried,
      rawTotal: state.rawTotal,
      afterQualityFilter: state.afterQualityFilter,
      crossMerchantGroups: state.crossMerchantGroups,
      upserted: state.upserted,
      updated: state.updated,
      errors: state.errors,
      durationMs: Date.now() - new Date(state.startedAt).getTime(),
    };
    if (state.status === 'cancelled') {
      state.message = `Construcción detenida tras ${state.processed} de ${state.crossMerchantGroups} grupo(s).`;
    }
    writeState(state);
    activeJobId = null;
    cancelRequested = false;
  }
}
