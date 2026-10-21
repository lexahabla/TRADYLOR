/**
 * ==============================================================================
 * TRADYLOR - PIPELINE DE AUTOMATIZACIÓN DE PRODUCTOS (métricas)
 * ==============================================================================
 * Contadores de ejecución del pipeline persistidos en `pipeline-metrics.json`
 * dentro del DATA_DIR (volumen en prod). Escritura atómica (tmp + rename) para
 * no dejar el fichero a medias. Se crea bajo demanda: no se sube a git si
 * contiene datos.
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from '../paths';

export interface PipelineMetrics {
  /** Ejecuciones completadas del pipeline (productos publicados). */
  runs: number;
  /** Productos procesados (ingest correctos, incluidos los ya existentes). */
  productsProcessed: number;
  /** Duplicados detectados y descartados en la Etapa 1. */
  duplicatesDiscarded: number;
  /** Productos aprobados por la auditoría (Etapa 2). */
  approved: number;
  /** Productos rechazados por la auditoría (Etapa 2). */
  rejected: number;
  /** Timestamp ISO de la última ejecución. */
  lastRun: string;
}

const METRICS_FILE = dataFile('pipeline-metrics.json');

function emptyMetrics(): PipelineMetrics {
  return {
    runs: 0,
    productsProcessed: 0,
    duplicatesDiscarded: 0,
    approved: 0,
    rejected: 0,
    lastRun: '',
  };
}

/** Lee las métricas persistidas; devuelve contadores a cero si no hay fichero. */
export function readPipelineMetrics(): PipelineMetrics {
  try {
    if (!fs.existsSync(METRICS_FILE)) return emptyMetrics();
    const parsed = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf-8')) as Partial<PipelineMetrics>;
    const base = emptyMetrics();
    return {
      runs: Number(parsed?.runs) || 0,
      productsProcessed: Number(parsed?.productsProcessed) || 0,
      duplicatesDiscarded: Number(parsed?.duplicatesDiscarded) || 0,
      approved: Number(parsed?.approved) || 0,
      rejected: Number(parsed?.rejected) || 0,
      lastRun: typeof parsed?.lastRun === 'string' ? parsed.lastRun : '',
    };
  } catch (error) {
    console.error('[PipelineMetrics] Error al leer pipeline-metrics.json:', error);
    return emptyMetrics();
  }
}

function writeMetrics(metrics: PipelineMetrics): boolean {
  try {
    fs.mkdirSync(path.dirname(METRICS_FILE), { recursive: true });
    const tmpPath = `${METRICS_FILE}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(metrics, null, 2), 'utf-8');
    fs.renameSync(tmpPath, METRICS_FILE);
    return true;
  } catch (error) {
    console.error('[PipelineMetrics] Error al guardar pipeline-metrics.json:', error);
    return false;
  }
}

/** Incrementa un contador numérico (operación atómica de lectura/escritura). */
export function incrementMetric(key: keyof PipelineMetrics, by = 1): void {
  if (key === 'lastRun') return;
  const metrics = readPipelineMetrics();
  metrics[key] = (metrics[key] as number) + by;
  writeMetrics(metrics);
}

/** Sella la fecha de la última ejecución. */
export function touchMetrics(): void {
  const metrics = readPipelineMetrics();
  metrics.lastRun = new Date().toISOString();
  writeMetrics(metrics);
}
