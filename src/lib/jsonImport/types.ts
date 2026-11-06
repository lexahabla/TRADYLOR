/**
 * ==============================================================================
 * TREIDILOR — IMPORTACIÓN JSON · TIPOS
 * ==============================================================================
 * Modelo de la importación JSON (Etapa A). Distingue tres niveles:
 *
 *   PRODUCTO  → datos del artículo (título, marca, identificadores, imágenes…)
 *   VARIANTE  → lo que lo diferencia de otro del mismo modelo (estado, color,
 *               talla, capacidad, pack). Una ficha del catálogo = una variante.
 *   OFERTA    → condiciones comerciales de UN comerciante/vendedor (precio,
 *               moneda, disponibilidad, envío, URL, fecha de captura).
 *
 * `null`/`'unknown'` significan DESCONOCIDO: nunca se interpretan como gratis,
 * disponible ni como ningún otro valor confirmado.
 * ==============================================================================
 */

export type Availability = 'in_stock' | 'out_of_stock' | 'unknown';
export type Condition = 'new' | 'used' | 'refurbished' | 'unknown';

export interface OfferShipping {
  /** Coste de envío; null = desconocido (0 = gratis confirmado). */
  cost: number | null;
  /** true sólo si la fuente lo confirma; null = desconocido. */
  free: boolean | null;
  /** Días de entrega estimados; null = desconocido. */
  days: number | null;
  text?: string;
}

/** Oferta almacenada (en `product.extra.offers` o derivada de los campos planos). */
export interface StoredOffer {
  offerId: string;
  offerKey: string;
  platform: string;
  sellerId?: string;
  sellerName?: string;
  externalId?: string;
  url: string;
  canonicalUrl: string;
  affiliateUrl?: string;
  price: number;
  currency: string;
  originalPrice?: number;
  availability: Availability;
  shipping: OfferShipping;
  condition: Condition;
  /** OBSERVACIÓN: cuándo se obtuvo la lectura en la fuente (ISO). */
  capturedAt: string;
  /** true si `capturedAt` se infirió de la fecha de recepción (la fuente no la daba). */
  capturedAtInferred?: boolean;
  /** RECEPCIÓN: cuándo la recibió Treidilor (ISO). No prueba que el precio siga vigente. */
  receivedAt: string;
  /** VERIFICACIÓN contra la fuente (ISO): sólo la fija el servicio de actualización; vacío si nunca se verificó. */
  verifiedAt: string;
  source: { channel: 'json'; batchId: string; adapter: string };
  status: 'active';
  /** true = oferta derivada de los campos planos de la ficha (no se persiste). */
  implicit?: boolean;
}

/**
 * Lectura de la oferta PRINCIPAL recibida por JSON (`product.extra.priceReading`). Es independiente de
 * `lastPriceSync` / `extra.refresh.lastVerifiedAt` (VERIFICACIÓN contra la tienda): recibir un JSON no verifica nada.
 */
export interface PriceReading {
  /** CAPTURA: cuándo la obtuvo la fuente (ISO). Si `capturedAtInferred` es true, es la fecha de recepción y NO es fiable. */
  capturedAt: string;
  capturedAtInferred: boolean;
  /** RECEPCIÓN: cuándo la recibió Treidilor. */
  receivedAt: string;
  source: { channel: 'json'; batchId: string; adapter: string };
  /** Verificaciones anteriores que ya NO corresponden al precio actual (conservadas como histórico). */
  verifiedBefore?: Array<{ verifiedAt: string; price: number; currency: string; supersededAt: string; supersededBy: string }>;
}

export interface VariantAttributes {
  condition: Condition;
  color?: string;
  size?: string;
  capacity?: string;
  pack?: string;
}

export interface CanonicalRecord {
  index: number;
  product: {
    title: string;
    description?: string;
    brand?: string;
    mpn?: string;
    /** GTIN con dígito de control válido (los inválidos se descartan con aviso). */
    gtin?: string;
    category?: string;
    images: string[];
    specs?: Record<string, string>;
    rating?: number;
    reviewsCount?: number;
  };
  variant: VariantAttributes;
  offer: Omit<StoredOffer, 'offerId' | 'offerKey' | 'receivedAt' | 'verifiedAt' | 'source' | 'status' | 'implicit'>;
  warnings: string[];
  /** Motivos por los que el registro NO debe aplicarse solo (p. ej. contradicciones de datos): va a revisión. */
  reviewReasons?: string[];
}

export type Outcome = 'created' | 'linked' | 'updated' | 'unchanged' | 'review' | 'rejected' | 'error';

export interface ReviewCandidate {
  productId: string;
  title: string;
  reason: string;
}

export interface RecordResult {
  index: number;
  outcome: Outcome;
  title?: string;
  productId?: string;
  offerKey?: string;
  /** Motivos (códigos legibles) de rechazo, revisión o actualización. */
  reasons: string[];
  warnings: string[];
  entities: { productsCreated: number; offersCreated: number; offersUpdated: number };
  candidates?: ReviewCandidate[];
  /** Destino aplicado a una ficha NUEVA (sólo si se eligió uno): «Categoría» o «Categoría › Subcategoría». */
  categoryApplied?: string;
  /** Registro normalizado (sólo en revisiones: permite resolverlas más adelante). */
  record?: CanonicalRecord;
}

/** Destino de las fichas NUEVAS del lote (ya validado en el servidor contra categories.json). */
export interface ImportTarget {
  category: string;
  categoryId: string;
  subcategoryId?: string;
  subcategoryName?: string;
}

export interface ImportDefaults {
  platform?: string;
  currency?: string;
  sellerName?: string;
  condition?: string;
  category?: string;
  capturedAt?: string;
}

export const EMPTY_ENTITIES = () => ({ productsCreated: 0, offersCreated: 0, offersUpdated: 0 });
