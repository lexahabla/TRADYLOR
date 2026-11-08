import { dataFile } from './paths';
import { readJsonArrayFile, writeJsonArrayFile } from './jsonStore';
import { sameSourceId } from './offerIdentity';
import { mergeReimport } from './reimportMerge';
import { withResolvedBrand } from './brandResolve';

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
  /** Divisa declarada por la red de origen (normalmente EUR). */
  currency?: string;
  /** Comisión de afiliación (%) declarada por la red de origen (distinto de `commissionEstimate`, que es el importe en EUR). */
  commissionRate?: number;
  /** Disponibilidad declarada por la red de origen en el momento de importar/sincronizar. */
  inStock?: boolean;
  /** Visitas/alcance del producto cuando la red las facilita (AliExpress no las da). */
  visits?: number;
  affiliateUrl: string;
  buyNowUrl?: string;
  /** Datos extra del catálogo multi-red (incluye `crossMerchant.networks`) y campos personalizados
   *  añadidos desde «Campos visibles en la ficha» (ver lib/productFieldsStore.ts). */
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

  /** Grupo de variantes: productos de la misma marca/modelo pero con una
   * característica diferente (ej: disco duro 2 TB / 4 TB). Todos los productos
   * de un mismo grupo comparten este ID. Los productos sin grupo tienen este
   * campo undefined. */
  variantGroup?: string;

  /** Característica que diferencia a esta variante dentro de su grupo
   * (ej: "2 TB", "4 TB", "256 GB", "Negro", "Azul"). Se muestra en la ficha
   * del producto junto a la tarjeta de la variante relacionada. */
  variantFeature?: string;

  /** Última sincronización de precio con la fuente (ISO). La escribe el servicio de actualización. */
  lastPriceSync?: string;
  /** Etiqueta legible de la red (compatibilidad con el panel de sincronización). */
  network_label?: string;
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
  // Punto único de escritura del catálogo: TODA vía de ingesta (JSON, API v1, conectores, alta manual) pasa por aquí, así que la marca
  // real del fabricante se valida una sola vez (una tienda como «AliExpress» no es marca; se busca en las especificaciones).
  return writeJsonArrayFile(DATA_FILE_PATH, products.map((p) => withResolvedBrand(p as any) as Product));
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
 * Detecta si una URL es un placeholder de Amazon (sin affiliate_url real de
 * ScraperAPI). Cuando ScraperAPI no devuelve `affiliate_url`, el pipeline de
 * importación genera `https://www.amazon.es/dp/B000000000?tag=tradylor-21`
 * (con el ASIN placeholder B000000000). Todos los productos de Amazon sin
 * URL real comparten esta misma URL normalizada, lo que provocaba falsos
 * positivos de duplicado al editar cualquiera de ellos.
 */
export function isPlaceholderUrl(value: string | null | undefined): boolean {
  const key = normalizeProductKey(value);
  return /amazon\.es\/dp\/b000000000/i.test(key) || /amazon\.\w+\/dp\/b000000000/i.test(key);
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
  candidate: {
    id?: string | null;
    title?: string | null;
    urls?: Array<string | null | undefined>;
    /** Id externo (ASIN, Item ID de AliExpress, itemId de eBay): misma oferta aunque cambie el enlace. */
    sourceId?: string | null;
  },
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
      .filter(Boolean)
      // Excluir URLs placeholder de Amazon: no sirven para detectar duplicados
      // porque todos los productos importados sin affiliate_url real las comparten.
      .filter((key) => !isPlaceholderUrl(key)),
  );
  const titleKey = normalizeProductKey(candidate.title);
  if (!urls.size && !titleKey) return undefined;

  return products.find((item) => {
    if (ignored.has(item.id)) return false;
    if (candidate.sourceId && (sameSourceId(candidate.sourceId, item.sourceId) || sameSourceId(candidate.sourceId, item.asin))) {
      return true;
    }
    if (item.affiliateUrl && !isPlaceholderUrl(item.affiliateUrl) && urls.has(normalizeProductKey(item.affiliateUrl)))
      return true;
    if (item.buyNowUrl && !isPlaceholderUrl(item.buyNowUrl) && urls.has(normalizeProductKey(item.buyNowUrl)))
      return true;
    return Boolean(titleKey) && titleKey === normalizeProductKey(item.title);
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * ACTUALIZACIÓN PROTEGIDA DEL CATÁLOGO (lectura → cambio → escritura)
 * ────────────────────────────────────────────────────────────────────────────
 * Problema que resuelve: varios procesos leen el catálogo, esperan red o IA y
 * después escriben el array/ficha que leyeron al principio, pisando lo que otras
 * escrituras hicieron mientras tanto (fichas nuevas, ofertas, precios, ediciones).
 *
 * Garantía: `updateCatalog` y `commitOwnChanges` hacen leer → aplicar → escribir
 * dentro de UNA SOLA función síncrona, sin `await` en medio. JavaScript ejecuta
 * una función síncrona hasta el final sin ceder el turno, y `fs.*Sync` bloquea
 * el hilo; por eso ninguna otra petición, tarea programada ni escritor del mismo
 * proceso puede intercalar su lectura o escritura entre las nuestras. La
 * escritura sigue siendo atómica (temporal + rename).
 * Límite declarado: la garantía es por PROCESO. Treidilor se despliega como un
 * único proceso Node con un volumen; con varias réplicas escribiendo el mismo
 * fichero haría falta un bloqueo de fichero o una base de datos.
 *
 * Qué se escribe: sólo los campos que la operación pretendía cambiar (los que
 * difieren entre la ficha `base` que leyó y la ficha `ours` que construyó). El
 * resto de la ficha es el valor ACTUAL del disco (`theirs`).
 * ──────────────────────────────────────────────────────────────────────────── */

const stableJson = (value: unknown): string => {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value));
};
const sameValue = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b);

type AnyRecord = Record<string, unknown>;

/**
 * Fusión a tres bandas: aplica sobre `theirs` (estado actual) SÓLO lo que `ours`
 * cambió respecto de `base` (lo que la operación leyó). `extra` se fusiona clave
 * a clave para no perder ofertas, observaciones ni campos de otros procesos.
 */
export function threeWayMerge<T extends object>(
  base: T | undefined,
  ours: T,
  theirs: T,
  /**
   * Campos que pertenecen a OTRA fuente (p. ej. el precio, que lo fijan la importación o el
   * refresco de ofertas): si han cambiado en el disco desde que se leyeron, gana el valor del
   * disco aunque esta operación haya derivado uno nuevo a partir de la lectura antigua.
   */
  protectIfChanged: readonly string[] = [],
): T {
  const b = (base ?? {}) as AnyRecord;
  const o = ours as unknown as AnyRecord;
  const t = theirs as unknown as AnyRecord;
  const result: AnyRecord = { ...t };
  const keys = new Set([...Object.keys(b), ...Object.keys(o)]);
  for (const key of keys) {
    if (sameValue(b[key], o[key])) continue; // la operación no tocó este campo
    if (base && protectIfChanged.includes(key) && !sameValue(b[key], t[key])) continue; // otro proceso lo cambió
    if (key === 'extra') {
      const be = (b.extra ?? {}) as AnyRecord;
      const oe = (o.extra ?? {}) as AnyRecord;
      const merged: AnyRecord = { ...((result.extra ?? {}) as AnyRecord) };
      for (const ek of new Set([...Object.keys(be), ...Object.keys(oe)])) {
        if (sameValue(be[ek], oe[ek])) continue;
        if (oe[ek] === undefined) delete merged[ek];
        else merged[ek] = oe[ek];
      }
      if (Object.keys(merged).length) result.extra = merged;
      else delete result.extra;
      continue;
    }
    if (o[key] === undefined) delete result[key];
    else result[key] = o[key];
  }
  return result as T;
}

/**
 * Lee el catálogo ACTUAL, aplica `mutate` sobre él y lo escribe una sola vez, todo
 * de forma síncrona (ver garantía arriba). `mutate` edita el array en sitio y
 * devuelve `{ changed, result }`; si `changed` es false no se escribe.
 */
export function updateCatalog<T>(
  mutate: (products: Product[]) => { changed: boolean; result: T },
): { result: T; written: boolean } {
  const products = readProductsFromFile();
  const outcome = mutate(products);
  if (!outcome.changed) return { result: outcome.result, written: false };
  if (!writeProductsToFile(products)) throw new Error('No se pudo escribir products.json');
  return { result: outcome.result, written: true };
}

/**
 * Guarda los cambios propios de UNA operación sobre la ficha `id`: relee la ficha
 * actual y le aplica sólo lo que `ours` cambió respecto de `base`. Si la ficha no
 * existe: si la operación partía de una ficha existente (`base`) se omite (se eliminó mientras esperaba);
 * si era un alta (sin `base`) se inserta `ours` al principio.
 */
export function commitOwnChanges(args: {
  id: string;
  base?: Product;
  ours: Product;
  /** Ver `threeWayMerge`. */
  protectIfChanged?: readonly string[];
}): { product: Product; updated: boolean; skipped?: 'eliminada_durante_la_operacion' } {
  const { result } = updateCatalog<{ product: Product; updated: boolean; skipped?: 'eliminada_durante_la_operacion' }>((products) => {
    const index = products.findIndex((p) => p.id === args.id);
    if (index < 0) {
      // La operación ACTUALIZABA una ficha que existía al leer (`base`) y ya no está: se eliminó mientras
      // esperaba (red/IA). No se recrea. Sólo se inserta si era un alta (sin `base`).
      if (args.base) return { changed: false, result: { product: args.ours, updated: false, skipped: 'eliminada_durante_la_operacion' } };
      products.unshift(args.ours);
      return { changed: true, result: { product: args.ours, updated: false } };
    }
    const merged = threeWayMerge(args.base, args.ours, products[index], args.protectIfChanged);
    products[index] = merged;
    return { changed: true, result: { product: merged, updated: true } };
  });
  return result;
}

/**
 * Alta o actualización FUSIONADA de una ficha construida desde cero (p. ej. por la
 * auto-curación): si ya existe se fusiona con `mergeReimport` (conserva
 * `extra` —ofertas, observaciones, campos bloqueados—, curación, slug, histórico y
 * lo enriquecido) en vez de sustituir el registro entero; todo en una sola sección
 * síncrona sobre el catálogo ACTUAL.
 */
export function upsertMergedProduct(product: Product): { product: Product; updated: boolean } {
  const { result } = updateCatalog<{ product: Product; updated: boolean }>((products) => {
    const index = products.findIndex((item) => item.id === product.id);
    if (index < 0) {
      products.unshift(product);
      return { changed: true, result: { product, updated: false } };
    }
    const merged = mergeReimport(products[index] as unknown as Record<string, unknown>, product as unknown as Record<string, unknown>) as unknown as Product;
    products[index] = merged;
    return { changed: true, result: { product: merged, updated: true } };
  });
  return result;
}
