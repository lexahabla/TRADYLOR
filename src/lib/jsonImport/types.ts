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
/** `open_box` (abierto, sin usar) es una condición PROPIA: no es «nuevo» ni «usado». Valor añadido (aditivo): las fichas guardadas no cambian. */
export type Condition = 'new' | 'used' | 'refurbished' | 'open_box' | 'unknown';

export interface OfferShipping {
  /** Coste de envío; null = desconocido (0 = gratis confirmado). */
  cost: number | null;
  /** true sólo si la fuente lo confirma; null = desconocido. */
  free: boolean | null;
  /** Días de entrega estimados; null = desconocido. */
  days: number | null;
  text?: string;
  /** Fecha (ISO) a la que se refiere el dato de envío: la CAPTURA de la fuente. Sólo existe si esa fecha es fiable (no inferida). */
  asOf?: string;
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
  /**
   * Variante de la oferta (sólo valores CONOCIDOS y fiables que declaró la fuente). Opcional: las ofertas guardadas antes de la etapa 1.5
   * no lo tienen y NO se completan (ni se migran). Lo lee `getComparableOffers`.
   */
  variant?: { color?: string; size?: string; capacity?: string; pack?: string };
  /** Cantidad/pack de la oferta cuando la fuente la declara (mismo criterio que `variant`). */
  quantity?: string;
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
  /** Envío de la oferta principal (sólo valores declarados) y fecha de captura que lo respalda (`asOf`, sólo si es fiable). */
  shipping?: { cost?: number | null; free?: boolean | null; days?: number | null; text?: string; asOf?: string };
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
  /** Motivos en lenguaje comprensible para el administrador (misma posición que `reasons`). Sólo en la respuesta; no se persiste. */
  reasonTexts?: string[];
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
