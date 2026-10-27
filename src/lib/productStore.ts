import { dataFile } from './paths';
import { readJsonArrayFile, writeJsonArrayFile } from './jsonStore';

// Interfaz del producto (compartida por el panel admin y los endpoints de alta)
export interface Product {
  id: string;
  /** Ruta canónica `/producto/[slug]` (contrato n8n; si falta, se usa el `id`). */
  slug?: string;
  title: string;
  description: string;
  /** Descripción original del comercio (sin bloques generados por el enrichment). */
  sourceDescription?: string;
  price: number;
  originalPrice?: number;
  image: string;
  /** Galería de imágenes del producto (la primera suele ser la principal). */
  gallery?: string[];
  category: string;
  merchant: string;
  /** Red de afiliados a la que pertenece el producto (amazon, aliexpress, ebay…). */
  network?: string;
  affiliateUrl: string;
  buyNowUrl?: string;
  /** Datos extra del catálogo multi-red (incluye `crossMerchant.networks`). */
  extra?: Record<string, unknown>;
  /** Código ASIN de Amazon (autodetectado desde el enlace de afiliado). */
  asin?: string;
  pros: string[];
  cons: string[];
  badge?: string;
  rating?: number;
  reviewsCount?: number;
  /** Marca del producto (ej: Samsung); se muestra en la ficha y en JSON-LD. */
  brand?: string;
  /** Estado físico del producto (Nuevo/Usado/Reacondicionado...). Clave para
   *  poder filtrar y señalizar los productos de segunda mano en el panel. */
  condition?: string;
  verdict?: string;
  specs?: Record<string, string>;
  /** Texto de ficha técnica (consulta en la página del producto). */
  techSheet?: string;
  fulfillmentProvider?: string;
  /** Texto de envío mostrado en checkout y ficha (ej: "Envío en 15 días"). */
  shippingInfo?: string;
  /** Días estimados de envío (entero; filtros y estimaciones). */
  shippingDays?: number;
  /** Envío estándar gratuito confirmado en la ficha del comerciante. */
  freeShipping?: boolean;
  /** Histórico de precio (1 punto por día; lo completa lib/priceHistory.ts). */
  priceHistory?: { date: string; price: number }[];

  // ─── Curación avanzada (campos opcionales; retrocompatibles) ───────────────
  /** ID externo del producto (ASIN de Amazon, Item ID de AliExpress, etc.). */
  sourceId?: string;
  /** ID de la categoría padre en categories.json (catálogo jerárquico). */
  category_id?: string;
  /** ID de la subcategoría (categoría-hija con parentId) en categories.json. */
  subcategory_id?: string;
  /** Estado del enriquecimiento con IA: pending | completed | error. */
  ia_status?: string;
  /** Estado del enlace de afiliación: active | pending | broken. */
  link_status?: string;
  /** Tags técnicos normalizados (extraídos en lote; filtros públicos futuros). */
  normalized_tags?: string[];
  /** IDs de productos alternativos vinculados (cross-matching bidireccional). */
  alternative_product_ids?: string[];
  /**
   * Slots de rol de las alternativas (cross-matching). Los campos en plural son
   * los que usa el panel (se pueden elegir VARIAS económicas / competidores);
   * los singulares se mantienen sincronizados con el primero de cada lista para
   * no romper la PDP ni los datos antiguos.
   */
  alternatives?: {
    premiumOptionId?: string;
    cheaperOptionId?: string;
    similarOptionId?: string;
    cheaperOptionIds?: string[];
    similarOptionIds?: string[];
  };
  /** Puntuación de rentabilidad/conversión 0-100 (calculada; ver lib/curation.ts). */
  conversion_score?: number;
  /** Comisión estimada en € por venta (opcional; alimenta el conversion_score). */
  commissionEstimate?: number;
  /** Ventas estimadas en los últimos 30 días (opcional; alimenta el score). */
  sales30d?: number;

  // ─── Pipeline de automatización (campos opcionales; retrocompatibles) ───────
  /** Estado de auditoría "Test & Proof": approved | rejected | pending. */
  audit_status?: 'approved' | 'rejected' | 'pending';
  /** Puntuación de auditoría 0-100 (Etapa 2 del pipeline). */
  audit_score?: number;
  /** Motivos de rechazo de la auditoría (códigos; Etapa 2 del pipeline). */
  audit_reasons?: string[];
  /** Versión del pipeline que lastró por última vez el producto. */
  pipeline_version?: number;
  /** Timestamp ISO de la última ejecución del pipeline sobre el producto. */
  pipeline_run_at?: string;
  /** `true` si la IA de texto enriquecido la ficha (Etapa 3 del pipeline). */
  ai_enriched?: boolean;
  /** Motivo por el que la IA de texto no pudo enriquecer la ficha. */
  ai_error?: string;
  /** Título sintetizado y corto (para product-cards). Si falta, se usa `title`. */
  title_short?: string;
}

// Ruta al archivo de persistencia JSON
export const DATA_FILE_PATH = dataFile('products.json');

/**
 * Lee de forma segura los productos almacenados en el archivo JSON local.
 * Tolera un fichero truncado (reintenta y, si sigue roto, devuelve la última
 * versión válida en memoria): devolver `[]` aquí hacía que el siguiente
 * `upsert` borrase el catálogo entero.
 */
export function readProductsFromFile(): Product[] {
  return readJsonArrayFile<Product>(DATA_FILE_PATH);
}

/**
 * Escribe los productos en el archivo JSON local garantizando el formateo.
 * Escritura ATÓMICA (temporal + rename): si el proceso se cae a mitad, el
 * fichero bueno sigue intacto.
 */
export function writeProductsToFile(products: Product[]): boolean {
  return writeJsonArrayFile(DATA_FILE_PATH, products);
}

/**
 * Genera un ID limpio tipo slug a partir del título.
 */
export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 50);
  return base || `producto-${Date.now().toString(36)}`;
}

/**
 * Inserta o actualiza un producto en products.json (upsert por `id`).
 * Devuelve el producto guardado y si fue una actualización.
 */
export function upsertProduct(product: Product): { product: Product; updated: boolean } {
  const products = readProductsFromFile();
  const index = products.findIndex((item) => item.id === product.id);
  const updated = index >= 0;
  if (updated) {
    products[index] = product;
  } else {
    products.unshift(product);
  }
  writeProductsToFile(products);
  return { product, updated };
}

/**
 * Clave normalizada para comparar productos (misma regla que el panel admin
 * usa con el catálogo AliExpress): minúsculas, sin esquema, sin `www`, sin
 * query/hash y sin barra final. Así un enlace de afiliado con parámetros de
 * tracking se considera IGUAL que la URL limpia del producto.
 */
export function normalizeProductKey(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

/**
 * Busca en el catálogo un producto que YA exista y coincida con el candidato
 * por URL de afiliado/tienda o por título (normalizados). Sirve para no crear
 * filas repetidas en products.json.
 *
 * @param ignoreId  id del producto que se está actualizando (no cuenta como duplicado).
 */
export function findDuplicateProduct(
  products: Product[],
  candidate: { id?: string | null; title?: string | null; urls?: Array<string | null | undefined> },
  ignoreId?: string | null,
): Product | undefined {
  const ignored = new Set(
    [candidate.id, ignoreId]
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );
  const urls = new Set(
    (candidate.urls ?? [])
      .map((value) => normalizeProductKey(value))
      .filter(Boolean),
  );
  const titleKey = normalizeProductKey(candidate.title);
  if (!urls.size && !titleKey) return undefined;

  return products.find((item) => {
    if (ignored.has(item.id)) return false;
    if (item.affiliateUrl && urls.has(normalizeProductKey(item.affiliateUrl))) return true;
    if (item.buyNowUrl && urls.has(normalizeProductKey(item.buyNowUrl))) return true;
    return Boolean(titleKey) && titleKey === normalizeProductKey(item.title);
  });
}
