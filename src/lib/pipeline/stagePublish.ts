/**
 * ==============================================================================
 * TREIDILOR - PIPELINE · ETAPA 4: PUBLICACIÓN "LISTO PARA CATÁLOGO"
 * ==============================================================================
 * Persiste el producto mediante las funciones EXISTENTES:
 *   1) `upsertCatalogProduct()` (contrato n8n, tombstones, buyNowUrl Amazon).
 *   2) `upsertProduct()` para escribir los PipelineFields nuevos (el primero
 *      blanquea campos desconocidos ⇒ doble escritura documentada).
 *
 * Tras esta etapa el producto cumple category + subcategory_id + ia_status +
 * link_status, así encaja con el preset "⭐ Listos para Publicar" del panel.
 * ==============================================================================
 */

import { upsertCatalogProduct } from '../catalogStore';
import { readProductsFromFile, threeWayMerge, upsertProduct, type Product } from '../productStore';
import type { PipelineFields, PipelineProduct, StageResult } from './types';

/** Extrae sólo los campos nuevos del pipeline para la segunda escritura. */
function extractPipelineFields(product: PipelineProduct): PipelineFields {
  return {
    audit_status: product.audit_status,
    audit_score: product.audit_score,
    audit_reasons: product.audit_reasons,
    pipeline_version: product.pipeline_version,
    pipeline_run_at: product.pipeline_run_at,
    ai_enriched: product.ai_enriched,
    ai_error: product.ai_error,
  };
}

/** Ejecuta la Etapa 4 (publicación/persistencia en products.json). */
export function runStagePublish(product: PipelineProduct, base?: Product): StageResult {
  // Toda la publicación es SÍNCRONA (sin `await`): lo leído aquí no puede cambiar
  // hasta que se escribe. `base` es la ficha como estaba cuando el pipeline la leyó
  // (antes de la IA); sólo se aplican los campos que el pipeline cambió respecto de
  // ella, y el resto conserva el valor ACTUAL (ofertas, precios, ediciones ajenas).
  const freshBefore = base ? readProductsFromFile().find((p) => p.id === product.id) : undefined;
  const saved = upsertCatalogProduct(product as any);
  if (!saved.ok || !saved.product) {
    return { ok: false, stage: 'publish', message: saved.message || 'No se pudo persistir el producto.' };
  }

  // Segunda escritura: `upsertCatalogProduct` conserva SOLO los campos del
  // contrato n8n y blanquea los de curación/pipeline, así que se re-escribe el
  // producto completo (con `product` en último lugar gana sobre `saved.product`).
  const fields = extractPipelineFields(product);
  const ours = { ...(saved.product as any), ...fields, ...product } as Product;
  const persisted = freshBefore && base ? threeWayMerge(base, ours, freshBefore) : ours;
  upsertProduct(persisted);

  return {
    ok: true,
    stage: 'publish',
    product: persisted as PipelineProduct,
    message: saved.message,
  };
}
