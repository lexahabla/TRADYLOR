/**
 * ==============================================================================
 * TREIDILOR — IMPORTACIÓN JSON · SERVICIO (persistencia por lotes)
 * ==============================================================================
 * Envuelve el motor puro con el almacenamiento real:
 *
 *  - `startBatch`: copia de seguridad recuperable de `products.json`, hecha
 *    justo ANTES del primer bloque que modifica el catálogo (se conservan las
 *    últimas `KEEP_BACKUPS`).
 *  - `processChunk`: lee el catálogo, aplica el plan y escribe UNA vez, de forma
 *    atómica, dentro de una sección crítica SÍNCRONA (sin `await` entre leer y
 *    escribir), de modo que dos peticiones simultáneas nunca se pisan ni crean
 *    copias. Reintentar un bloque es idempotente.
 *  - Informe por lote (`import-reports.json`) y cola de revisión
 *    (`import-review.json`) en el volumen de datos.
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, dataFile } from '../paths';
import { readJsonArrayFile, writeJsonArrayFile } from '../jsonStore';
import { DATA_FILE_PATH, readProductsFromFile, writeProductsToFile } from '../productStore';
import { loadDeletedSnapshot, matchDeletedOffer, matchDeletedProduct } from '../deletedIdentity';
import { invalidateCatalogCache } from '../catalog';
import { runImport } from './engine';
import { explainReasons } from './reasonLabels';
import type { ImportDefaults, ImportTarget, Outcome, RecordResult } from './types';
import { adaptApifyAmazonItem, isApifyAmazonItem } from './apifyAmazon';
import { adaptApifyTemuItem, isApifyTemuItem } from './apifyTemu';
import { resolveCatalogCategory } from './categoryResolver';

const KEEP_BACKUPS = 5;
const KEEP_REPORTS = 20;
export const MAX_CHUNK_RECORDS = 100;

const REPORTS_FILE = () => dataFile('import-reports.json');
const REVIEW_FILE = () => dataFile('import-review.json');
const BACKUP_DIR = () => path.join(DATA_DIR, 'import-backups');

export interface BatchReport {
  batchId: string;
  startedAt: string;
  updatedAt: string;
  dryRun: boolean;
  backup?: string;
  results: RecordResult[];
}

export const safeBatchId = (value: unknown): string => {
  const id = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : '';
};

/** Copia de seguridad de `products.json` para el lote (idempotente por lote). */
export function startBatch(batchId: string, dryRun: boolean): { backup?: string } {
  if (dryRun) return {};
  const dir = BACKUP_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).find((f) => f.endsWith(`.${batchId}.json`));
  if (existing) return { backup: existing };
  if (!fs.existsSync(DATA_FILE_PATH)) return {};
  const name = `products.${new Date().toISOString().replace(/[:.]/g, '-')}.${batchId}.json`;
  fs.copyFileSync(DATA_FILE_PATH, path.join(dir, name));
  const all = fs.readdirSync(dir).filter((f) => f.startsWith('products.') && f.endsWith('.json')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.rmSync(path.join(dir, old), { force: true });
  return { backup: name };
}

export interface ChunkOutput {
  results: RecordResult[];
  changed: boolean;
}

export function processChunk(input: {
  batchId: string;
  records: unknown[];
  defaults: ImportDefaults;
  dryRun: boolean;
  indexOffset: number;
  /** Destino ya validado de las fichas nuevas (opcional). */
  target?: ImportTarget;
  /** Sólo productos nuevos: omitir los que ya existen (ver `EngineOptions.onlyNew`). */
  onlyNew?: boolean;
}): ChunkOutput & { backup?: string } {
  const nowIso = new Date().toISOString();
  // ── Sección crítica síncrona: leer → aplicar → escribir una sola vez. ──
  const catalog = readProductsFromFile();
  const snapshot = loadDeletedSnapshot();
  // Elementos crudos del actor de Amazon de Apify (pegados o subidos): se adaptan al modelo antes de importar.
  const records = input.records.map((r) =>
    isApifyAmazonItem(r)
      ? adaptApifyAmazonItem(r, { resolveCategory: resolveCatalogCategory })
      : isApifyTemuItem(r)
        ? adaptApifyTemuItem(r, { resolveCategory: resolveCatalogCategory })
        : r,
  );
  const out = runImport(catalog, records, input.defaults, {
    batchId: input.batchId,
    nowIso,
    deletedIds: new Set(snapshot.ids),
    deleted: {
      product: (candidate, includeGtin) => matchDeletedProduct(candidate as never, { includeGtin, snapshot }),
      offer: (offerKey) => matchDeletedOffer(offerKey, snapshot),
    },
    indexOffset: input.indexOffset,
    target: input.target,
    onlyNew: input.onlyNew === true,
  });
  let backup: string | undefined;
  if (out.changed && !input.dryRun) {
    // Copia de seguridad del estado ANTERIOR, sólo si este bloque va a modificar el catálogo.
    backup = startBatch(input.batchId, false).backup;
    if (!writeProductsToFile(out.products)) {
      throw new Error('No se pudo escribir products.json; no se ha aplicado ningún cambio de este bloque.');
    }
    invalidateCatalogCache();
  }
  // ── Fin de la sección crítica ──

  if (!input.dryRun) {
    persistReport(input.batchId, nowIso, out.results, backup);
    persistReview(input.batchId, nowIso, out.results);
  }
  return {
    changed: out.changed,
    backup,
    results: out.results.map((r) => {
      const { record: _omit, ...rest } = r;
      return { ...rest, reasonTexts: explainReasons(rest.reasons) };
    }),
  };
}

function persistReport(batchId: string, nowIso: string, results: RecordResult[], backup?: string) {
  const reports = readJsonArrayFile<BatchReport>(REPORTS_FILE());
  let report = reports.find((r) => r.batchId === batchId);
  if (!report) {
    report = { batchId, startedAt: nowIso, updatedAt: nowIso, dryRun: false, backup, results: [] };
    reports.push(report);
  }
  report.updatedAt = nowIso;
  // Idempotente: un bloque reenviado sustituye los resultados de sus mismos índices.
  const byIndex = new Map(report.results.map((r) => [r.index, r]));
  for (const r of results) {
    const { record: _omit, ...rest } = r;
    byIndex.set(r.index, rest);
  }
  report.results = [...byIndex.values()].sort((a, b) => a.index - b.index);
  writeJsonArrayFile(REPORTS_FILE(), reports.slice(-KEEP_REPORTS));
}

export interface ReviewItem {
  id: string;
  batchId: string;
  status: 'pending';
  createdAt: string;
  title?: string;
  offerKey?: string;
  reasons: string[];
  candidates: RecordResult['candidates'];
  record: RecordResult['record'];
}

function persistReview(batchId: string, nowIso: string, results: RecordResult[]) {
  const reviews = results.filter((r) => r.outcome === 'review');
  if (!reviews.length) return;
  const list = readJsonArrayFile<ReviewItem>(REVIEW_FILE());
  const byId = new Map(list.map((i) => [i.id, i]));
  for (const r of reviews) {
    const id = `${batchId}:${r.index}`;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      batchId,
      status: 'pending',
      createdAt: nowIso,
      title: r.title,
      offerKey: r.offerKey,
      reasons: r.reasons,
      candidates: r.candidates ?? [],
      record: r.record,
    });
  }
  writeJsonArrayFile(REVIEW_FILE(), [...byId.values()]);
}

export function readBatchReport(batchId: string): BatchReport | undefined {
  return readJsonArrayFile<BatchReport>(REPORTS_FILE()).find((r) => r.batchId === batchId);
}

/** Resumen de un conjunto de resultados con los contadores definidos en el diseño. */
export function summarize(results: RecordResult[]) {
  const outcomes: Record<Outcome, number> = { created: 0, linked: 0, updated: 0, unchanged: 0, review: 0, rejected: 0, error: 0 };
  const entities = { productsCreated: 0, offersCreated: 0, offersUpdated: 0 };
  for (const r of results) {
    outcomes[r.outcome] += 1;
    entities.productsCreated += r.entities.productsCreated;
    entities.offersCreated += r.entities.offersCreated;
    entities.offersUpdated += r.entities.offersUpdated;
  }
  return { processed: results.length, outcomes, entities };
}
