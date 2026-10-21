/**
 * ==============================================================================
 * TRADYLOR - PIPELINE DE AUTOMATIZACIÓN DE PRODUCTOS (tipos)
 * ==============================================================================
 * Tipos compartidos del pipeline de 4 etapas (ingest → audit → categorize →
 * publish). Sólo añaden campos OPCIONALES al modelo canónico `Product`, por lo
 * que los productos antiguos siguen validando sin cambios.
 * ==============================================================================
 */

import type { Product } from '../productStore';

/** Estado de auditoría "Test & Proof" de un producto. */
export type AuditStatus = 'approved' | 'rejected' | 'pending';

/** Campos nuevos que el pipeline estampa en el producto (todos opcionales). */
export interface PipelineFields {
  audit_status?: AuditStatus;
  audit_score?: number;
  audit_reasons?: string[];
  pipeline_version?: number;
  pipeline_run_at?: string;
}

/** Producto interno del pipeline: el modelo canónico + los campos nuevos. */
export type PipelineProduct = Product & PipelineFields;

/**
 * Entrada del pipeline. Acepta el contrato de n8n (affiliateDeepLink /
 * referencePrice / analystVerdict) además de los campos planos del catálogo.
 */
export interface PipelineInput {
  id?: string;
  title?: string;
  description?: string;
  price?: number | string;
  originalPrice?: number | string;
  referencePrice?: number | string;
  image?: string;
  category?: string;
  merchant?: string;
  affiliateUrl?: string;
  affiliateDeepLink?: string;
  buyNowUrl?: string;
  asin?: string;
  sourceId?: string;
  pros?: string[];
  cons?: string[];
  badge?: string;
  rating?: number | string;
  reviewsCount?: number | string;
  verdict?: string;
  analystVerdict?: string;
  slug?: string;
  specs?: Record<string, string>;
  fulfillmentProvider?: string;
  techSheet?: string;
  shippingInfo?: string;
  shippingDays?: number | string;
  freeShipping?: boolean;
  [key: string]: unknown;
}

/** Resultado de una etapa individual (éxito o parada temprana). */
export interface StageResult {
  ok: boolean;
  stage: 'ingest' | 'audit' | 'categorize' | 'publish';
  message?: string;
  duplicate?: boolean;
  duplicate_reason?: string;
  audit_status?: AuditStatus;
  audit_score?: number;
  product?: PipelineProduct;
}

/** Trazabilidad de la ejecución del pipeline en cada producto. */
export interface PipelineTrace {
  ingest: boolean;
  audit: boolean;
  categorize: boolean;
  publish: boolean;
  version: number;
  durationMs: number;
}

/** Resultado agregado de ejecutar el pipeline sobre un producto. */
export interface PipelineResult extends StageResult {
  audit_status?: AuditStatus;
  audit_score?: number;
  pipeline?: PipelineTrace;
}
