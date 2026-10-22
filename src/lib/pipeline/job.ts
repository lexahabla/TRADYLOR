/**
 * ==============================================================================
 * TRADYLOR - PIPELINE · EJECUCIÓN EN SEGUNDO PLANO (jobs)
 * ==============================================================================
 * Reprocesar TODO el catálogo con la IA de texto es una operación LENTA: 262
 * productos × 1 llamada al proveedor ≈ 30-60 minutos. Hacerlo dentro de una
 * petición HTTP síncrona moría por timeout del proxy a mitad del catálogo (y
 * el resultado se perdía).
 *
 * Este módulo lanza la misma tarea en segundo plano y persiste el progreso en
 * `pipeline-job.json` (dentro del DATA_DIR, o sea el volumen en prod) para que:
 *   - la petición HTTP devuelva AL INMEDIATO (`{ started: true }`);
 *   - el panel pueda consultar el avance (GET /api/admin/pipeline) sin que el
 *     servidor tenga que mantener la petición abierta;
 *   - el proceso se pueda detener (POST { mode: 'cancel' }).
 *
 * Patrón equivalente al resto de schedulers del proyecto (setInterval/unref en
 * src/middleware.ts): el trabajo vive en el proceso SSR y sobrevive a la
 * respuesta HTTP porque el servidor es un Node standalone (no serverless).
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from '../paths';
import { readProductsFromFile } from '../productStore';
import { runProductPipeline } from './index';

export type JobStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'interrupted' | 'error';

export interface JobResultRow {
  id: string | null;
  title: string | null;
  ok: boolean;
  stage: string;
  audit_status?: string;
  audit_score?: number | null;
  ai_enriched?: boolean;
  ai_error?: string;
  message?: string;
}

export interface PipelineJobState {
  /** Identificador de la ejecución (timestamp). */
  id: string;
  status: JobStatus;
  scope: 'all' | 'ids';
  /** Productos que forman parte del lote. */
  total: number;
  /** Productos ya procesados. */
  processed: number;
  /** Productos que fallaron (pipeline ok=false). */
  failed: number;
  /** Productos cuyo enriquecimiento con IA falló (se quedaron con la plantilla local). */
  aiFailed: number;
  /** Productos enriquecidos con IA correctamente. */
  aiEnriched: number;
  /** Producto en curso. */
  current: string | null;
  currentTitle: string | null;
  /** Proveedor de IA forzado para esta tanda (null = el de por defecto). */
  provider: string | null;
  /** Modelo de IA forzado para esta tanda (null = el del proveedor). */
  model: string | null;
  /** Si la tanda usa la IA de texto. */
  enrich: boolean;
  /** Si la tanda es una simulación (no escribe). */
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** Mensaje de estado para el panel. */
  message: string;
  /** Últimos errores (acotado). */
  errors: { id: string | null; title: string | null; message: string }[];
  /** Últimos resultados (acotado) para la tabla del panel. */
  recent: JobResultRow[];
}

export interface StartJobOptions {
  ids?: string[];
  scope?: 'all' | 'ids';
  dryRun?: boolean;
  enrich?: boolean;
  provider?: 'openai' | 'anthropic' | 'groq';
  /** Modelo de IA para esta tanda (los límites de Groq son por modelo). */
  model?: string;
}

const JOB_FILE = dataFile('pipeline-job.json');

/** Nº máximo de resultados y errores que se guardan (el resto se descarta). */
const MAX_RECENT = 60;
const MAX_ERRORS = 20;

/** Pausa entre productos (ms). Evita saturar el proveedor con ráfagas de peticiones. */
function jobDelayMs(): number {
  const raw = Number(process.env.PIPELINE_JOB_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
}

/** Espera(ms) sin bloquear el bucle de eventos. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Id del job que se está ejecutando EN ESTE proceso (null si no hay ninguno). */
let activeJobId: string | null = null;
/** Se pone a true para detener el job en curso tras el producto actual. */
let cancelRequested = false;

function emptyState(): PipelineJobState {
  return {
    id: '',
    status: 'idle',
    scope: 'all',
    total: 0,
    processed: 0,
    failed: 0,
    aiFailed: 0,
    aiEnriched: 0,
    current: null,
    currentTitle: null,
    provider: null,
    model: null,
    enrich: false,
    dryRun: false,
    startedAt: '',
    finishedAt: null,
    message: '',
    errors: [],
    recent: [],
  };
}

/** Escribe el estado de forma atómica (tmp + rename). */
function writeState(state: PipelineJobState): boolean {
  try {
    fs.mkdirSync(path.dirname(JOB_FILE), { recursive: true });
    const tmpPath = `${JOB_FILE}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, JOB_FILE);
    return true;
  } catch (error) {
    console.error('[PipelineJob] Error al guardar pipeline-job.json:', error);
    return false;
  }
}

/**
 * Estado actual del job. Si el fichero dice "running" pero en este proceso no
 * hay ningún job activo, el proceso se reinició a mitad: se marca como
 * "interrupted" para que el panel no muestre un progreso fantasma.
 */
export function getPipelineJob(): PipelineJobState | null {
  let parsed: Partial<PipelineJobState> | null = null;
  try {
    if (!fs.existsSync(JOB_FILE)) return null;
    parsed = JSON.parse(fs.readFileSync(JOB_FILE, 'utf-8')) as Partial<PipelineJobState>;
  } catch (error) {
    console.error('[PipelineJob] Error al leer pipeline-job.json:', error);
    return null;
  }
  if (!parsed || !parsed.id) return null;

  const state: PipelineJobState = { ...emptyState(), ...parsed } as PipelineJobState;
  if (state.status === 'running' && state.id !== activeJobId) {
    state.status = 'interrupted';
    state.message = 'El servidor se reinició durante la ejecución: el lote quedó incompleto.';
    state.finishedAt = state.finishedAt || new Date().toISOString();
  }
  return state;
}

/** ¿Hay un job ejecutándose en este proceso? */
export function isPipelineJobRunning(): boolean {
  return activeJobId !== null;
}

/**
 * Lanza el reproceso en segundo plano. Devuelve AL INMEDIATO.
 * Si ya hay un job en curso no se lanza otro (evita escrituras concurrentes).
 */
export function startPipelineJob(
  options: StartJobOptions = {},
): { ok: boolean; state?: PipelineJobState; message?: string } {
  if (activeJobId) {
    return { ok: false, message: 'Ya hay un reproceso en marcha. Espera a que termine o deténlo.' };
  }

  const ids = (options.ids ?? []).filter(Boolean);
  const scope: 'all' | 'ids' = options.scope ?? (ids.length ? 'ids' : 'all');
  const products = readProductsFromFile();
  const targets = scope === 'ids' ? products.filter((p) => ids.includes(p.id)) : products;

  if (!targets.length) {
    return { ok: false, message: 'No hay productos que reprocesar con ese ámbito.' };
  }

  const state: PipelineJobState = {
    ...emptyState(),
    id: new Date().toISOString(),
    status: 'running',
    scope,
    total: targets.length,
    provider: options.provider ?? null,
    model: options.model?.trim() || null,
    enrich: options.enrich !== false,
    dryRun: options.dryRun === true,
    startedAt: new Date().toISOString(),
    message: `Reprocesando ${targets.length} producto(s)…`,
  };
  state.status = 'running';

  activeJobId = state.id;
  cancelRequested = false;
  writeState(state);

  // Fuera de la petición: el proceso sigue vivo y el job avanza solo.
  void runJob(state, targets);

  return { ok: true, state };
}

/** Pide detener el job en curso (termina tras el producto actual). */
export function cancelPipelineJob(): { ok: boolean; message: string } {
  if (!activeJobId) {
    return { ok: false, message: 'No hay ningún reproceso en marcha.' };
  }
  cancelRequested = true;
  const state = getPipelineJob();
  if (state) {
    state.message = 'Deteniendo tras el producto en curso…';
    writeState(state);
  }
  return { ok: true, message: 'Se ha pedido detener el reproceso.' };
}

/** ¿El error es de límite de peticiones del proveedor? (429 / rate limit) */
function isRateLimitError(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('429') || text.includes('rate limit') || text.includes('too many requests');
}

/** Bucle del job: procesa el lote y persiste el avance tras cada producto. */
async function runJob(state: PipelineJobState, targets: any[]): Promise<void> {
  const delay = jobDelayMs();
  // El proveedor se estrecha al tipo que entiende la IA: si el estado guarda
  // otra cosa (fichero editado a mano) se usa el proveedor por defecto.
  const provider: 'openai' | 'anthropic' | 'groq' | undefined =
    state.provider === 'openai' || state.provider === 'anthropic' || state.provider === 'groq'
      ? state.provider
      : undefined;
  // Modelo forzado para la tanda (los límites de Groq son por modelo).
  const model = state.model?.trim() || undefined;

  try {
    for (const product of targets) {
      if (cancelRequested) {
        state.status = 'cancelled';
        state.message = `Reproceso detenido tras ${state.processed} de ${state.total} producto(s).`;
        break;
      }

      state.current = product.id ?? null;
      state.currentTitle = product.title ?? null;
      writeState(state);

      let result = await runProductPipeline(product, {
        ignoreId: product.id,
        enrich: state.enrich,
        provider,
        model,
        dryRun: state.dryRun,
      });

      // Si el proveedor se quedó sin margen (429), se espera y se reintenta una
      // vez: con el proveedor por defecto (límite bajo) era justo lo que
      // dejaba media catálogo con la plantilla local.
      if (!result.ai_enriched && result.ai_error && isRateLimitError(result.ai_error)) {
        await sleep(20_000);
        if (!cancelRequested) {
          result = await runProductPipeline(product, {
            ignoreId: product.id,
            enrich: state.enrich,
            provider,
            model,
            dryRun: state.dryRun,
          });
        }
      }

      state.processed += 1;
      if (!result.ok) state.failed += 1;
      if (result.ai_enriched) state.aiEnriched += 1;
      if (result.ai_error) {
        state.aiFailed += 1;
        state.errors.unshift({
          id: result.product?.id ?? product.id ?? null,
          title: result.product?.title ?? product.title ?? null,
          message: result.ai_error.slice(0, 200),
        });
        state.errors = state.errors.slice(0, MAX_ERRORS);
      }

      state.recent.unshift({
        id: result.product?.id ?? product.id ?? null,
        title: result.product?.title ?? product.title ?? null,
        ok: result.ok,
        stage: result.stage,
        audit_status: result.audit_status,
        audit_score: result.audit_score ?? null,
        ai_enriched: result.ai_enriched,
        ai_error: result.ai_error,
        message: result.message,
      });
      state.recent = state.recent.slice(0, MAX_RECENT);

      state.message = `Procesados ${state.processed} de ${state.total}…`;
      writeState(state);

      if (delay > 0) await sleep(delay);
    }

    if (state.status === 'running') {
      state.status = 'done';
      state.message = `Reproceso terminado: ${state.processed} producto(s), ${state.failed} con error, ${state.aiFailed} sin enriquecimiento de IA.`;
    }
  } catch (error: any) {
    state.status = 'error';
    state.message = `Error inesperado en el reproceso: ${error?.message || error}`;
    console.error('[PipelineJob] Error en el job:', error);
  } finally {
    state.current = null;
    state.currentTitle = null;
    state.finishedAt = new Date().toISOString();
    writeState(state);
    activeJobId = null;
    cancelRequested = false;
  }
}
