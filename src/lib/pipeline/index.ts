/**
 * ==============================================================================
 * TRADYLOR - PIPELINE DE AUTOMATIZACIÓN DE PRODUCTOS (orquestador)
 * ==============================================================================
 * Encadena las 4 etapas en orden: ingest → audit → categorize → publish, con
 * parada temprana (un duplicado no sigue) y resultado agregado por producto.
 *
 * Es ADITIVO: no modifica ninguna función existente y el contrato de
 * `/api/v1/products/import` es retrocompatible (sólo se añaden claves).
 * ==============================================================================
 */

import { readProductsFromFile } from '../productStore';
import { getPipelineConfig } from './config';
import { incrementMetric, touchMetrics } from './metrics';
import { runStageIngest } from './stageIngest';
import { runStageAudit } from './stageAudit';
import { runStageCategorize } from './stageCategorize';
import { runStagePublish } from './stagePublish';
import type { PipelineInput, PipelineResult, PipelineTrace, StageResult } from './types';

export * from './types';

export interface PipelineOptions {
  /** ID que no debe contarse como duplicado (reproceso del propio producto). */
  ignoreId?: string;
  /** Desactiva la llamada a la IA de texto en la Etapa 3 (default: activada). */
  enrich?: boolean;
  /** Fuerza el proveedor de IA de texto para esta ejecución. */
  provider?: 'openai' | 'anthropic' | 'groq' | 'nvidia' | 'openrouter';
  /**
   * Fuerza el MODELO de IA para esta ejecución. Los límites de peticiones de
   * Groq son por modelo: agotar el TPD de uno no agota el de los demás.
   */
  model?: string;
  /** No persiste: sólo ejecuta ingest → audit → categorize. */
  dryRun?: boolean;
}

/** Ejecuta el pipeline completo sobre un producto individual. */
export async function runProductPipeline(
  raw: PipelineInput,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const started = Date.now();
  const config = getPipelineConfig();

  const makeTrace = (partial: Partial<PipelineTrace>): PipelineTrace => ({
    ingest: false,
    audit: false,
    categorize: false,
    publish: false,
    version: config.version,
    durationMs: Date.now() - started,
    ...partial,
  });

  // ── Etapa 1: ingesta, limpieza y duplicados ─────────────────────────────
  const ingest: StageResult = runStageIngest(raw, { ignoreId: options.ignoreId });
  if (!ingest.ok) {
    if (ingest.duplicate) incrementMetric('duplicatesDiscarded');
    return { ...ingest, pipeline: makeTrace({}) };
  }
  incrementMetric('productsProcessed');
  let product = ingest.product!;

  // ── Etapa 2: auditoría "Test & Proof" ───────────────────────────────────
  const audit = runStageAudit(product, config);
  if (!audit.ok) {
    return { ...audit, pipeline: makeTrace({ ingest: true }) };
  }
  product = audit.product!;
  if (product.audit_status === 'approved') incrementMetric('approved');
  else incrementMetric('rejected');

  // ── Etapa 3: categorización + enriquecimiento ───────────────────────────
  const categorize = await runStageCategorize(product, config, {
    enrich: options.enrich,
    provider: options.provider,
    model: options.model,
  });
  if (!categorize.ok) {
    return { ...categorize, pipeline: makeTrace({ ingest: true, audit: true }) };
  }
  product = categorize.product!;

  product = {
    ...product,
    pipeline_version: config.version,
    pipeline_run_at: new Date().toISOString(),
  };

  const auditStatus = product.audit_status;
  const auditScore = product.audit_score;
  const aiEnriched = categorize.ai_enriched;
  const aiError = categorize.ai_error;

  // Modo dry-run: no se persiste nada.
  if (options.dryRun) {
    return {
      ok: true,
      stage: 'categorize',
      product,
      audit_status: auditStatus,
      audit_score: auditScore,
      ai_enriched: aiEnriched,
      ai_error: aiError,
      pipeline: makeTrace({ ingest: true, audit: true, categorize: true }),
    };
  }

  // ── Etapa 4: publicación "Listo para Catálogo" ──────────────────────────
  const publish = runStagePublish(product);
  if (!publish.ok) {
    return {
      ...publish,
      audit_status: auditStatus,
      audit_score: auditScore,
      ai_enriched: aiEnriched,
      ai_error: aiError,
      pipeline: makeTrace({ ingest: true, audit: true, categorize: true }),
    };
  }

  incrementMetric('runs');
  touchMetrics();

  return {
    ok: true,
    stage: 'publish',
    product: publish.product,
    audit_status: auditStatus,
    audit_score: auditScore,
    ai_enriched: aiEnriched,
    ai_error: aiError,
    pipeline: makeTrace({ ingest: true, audit: true, categorize: true, publish: true }),
  };
}

/** Ejecuta el pipeline en un lote (secuencial, sin concurrencia). */
export async function runProductPipelineBatch(
  items: PipelineInput[],
  options: PipelineOptions = {},
): Promise<PipelineResult[]> {
  const results: PipelineResult[] = [];
  for (const item of items) {
    results.push(await runProductPipeline(item, options));
  }
  return results;
}

export interface ReprocessResult {
  total: number;
  results: PipelineResult[];
}

/**
 * Re-ejecuta las 4 etapas sobre productos YA existentes del catálogo.
 * La Etapa 1 usa `ignoreId` para no auto-detectarse como duplicado.
 */
export async function reprocessCatalog(
  ids?: string[],
  options: {
    dryRun?: boolean;
    enrich?: boolean;
    provider?: 'openai' | 'anthropic' | 'groq' | 'nvidia' | 'openrouter';
    model?: string;
  } = {},
): Promise<ReprocessResult> {
  const products = readProductsFromFile();
  const targets = ids && ids.length ? products.filter((p) => ids.includes(p.id)) : products;

  const results: PipelineResult[] = [];
  for (const product of targets) {
    results.push(
      await runProductPipeline(product as PipelineInput, {
        ignoreId: product.id,
        enrich: options.enrich,
        provider: options.provider,
        model: options.model,
        dryRun: options.dryRun,
      }),
    );
  }

  return { total: targets.length, results };
}
