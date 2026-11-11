/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · MODELO DE DATOS (etapa 1)
 * ==============================================================================
 * Un bloque separa cuatro cosas independientes:
 *   · modalidad  — CÓMO se obtiene el contenido (manual, automática, sección, editorial);
 *   · formato    — CÓMO se presenta (banner, cuadrícula 2×2, carrusel…);
 *   · ancho      — cuánto ocupa de una rejilla de 12 columnas;
 *   · tarjeta    — el componente reutilizable que se pinta (producto, categoría, promoción).
 *
 * Las modalidades son una clasificación PROVISIONAL aprobada el 10/11/2026 (no es la definición original recuperada). Se añaden nuevas
 * modalidades o formatos registrándolos en `validate.ts` (MODALITY_REGISTRY / FORMAT_REGISTRY) sin tocar el resto.
 *
 * Los productos, categorías y secciones se REFERENCIAN por id (nunca se copian). Nada de este módulo modifica el catálogo, `sections.json`
 * ni la portada pública.
 * ==============================================================================
 */

export const SCHEMA_VERSION = 1;

/** Modalidades provisionales (ver cabecera). */
export const MODALITIES = ['manual', 'automatica', 'seccion', 'editorial'] as const;
export type Modality = (typeof MODALITIES)[number];

/** Formatos visuales provisionales: no son modalidades. */
/** `lista` (rediseño): lista numerada de hasta 10 productos (1, 2, 3…); en las tarjetas de categoría, cuadrícula de teselas. */
export const FORMATS = ['banner', 'cuadricula2x2', 'carrusel', 'lista'] as const;
export type Format = (typeof FORMATS)[number];

/** Anchos sobre 12 columnas: ¼, ⅓, ½, ⅔, ¾ y completo. */
export const WIDTHS = [3, 4, 6, 8, 9, 12] as const;
export type Width = (typeof WIDTHS)[number];

/** Componentes reutilizables que puede pintar un bloque (no son modalidades). */
export const CARD_KINDS = ['producto', 'categoria', 'promocion'] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export type RefKind = 'product' | 'category' | 'section' | 'promotion';
export interface ContentRef {
  kind: RefKind;
  id: string;
}

/** Criterios de la modalidad automática en la primera versión (solo con datos fiables). El motor NO existe todavía. */
/** `descuento_desc` (rediseño): mayor bajada VERIFICADA primero (sólo productos con descuento acreditado; nunca el «precio de lista» del comercio). */
export const AUTO_ORDERS = ['recientes', 'precio_asc', 'precio_desc', 'descuento_desc'] as const;
export type AutoOrder = (typeof AUTO_ORDERS)[number];
export interface AutomaticRules {
  /** Categoría real del catálogo (id de categories.json). */
  categoryId?: string;
  subcategoryId?: string;
  /** Comercio o plataforma (amazon, aliexpress, ebay, temu…). */
  merchant?: string;
  order: AutoOrder;
  limit: number;
  onlyWithPrice?: boolean;
  /** Rediseño: sólo productos con bajada de precio VERIFICADA (misma prueba que la insignia «-N %» y el filtro «Gangas»). */
  onlyVerifiedDiscount?: boolean;
}

export type LinkType = 'path' | 'url' | 'product' | 'category' | 'section';
export interface EditorialLink {
  type: LinkType;
  target: string;
}
/** Variantes de presentación de un bloque editorial (rediseño). Sin `variant` = `plain` (el aspecto original). */
export const EDITORIAL_VARIANTS = ['plain', 'hero', 'campaign', 'guide', 'trust'] as const;
export type EditorialVariant = (typeof EDITORIAL_VARIANTS)[number];
export interface EditorialItem {
  title: string;
  text?: string;
}
export interface EditorialConfig {
  /** Rediseño (todos opcionales y aditivos): */
  variant?: EditorialVariant;
  /** Rótulo pequeño sobre el titular («SEMANA DE OFERTAS», «GUÍA DE COMPRA»…). */
  eyebrow?: string;
  /** Cifra o fecha grande de la variante `campaign` («27·11»). */
  kicker?: string;
  /** Segunda imagen de la variante `hero` (se muestra solapada con la primera). */
  imageUrl2?: string;
  /** Hasta 4 mensajes cortos de la variante `trust` (franja de confianza). */
  items?: EditorialItem[];
  headline: string;
  text?: string;
  imageUrl?: string;
  buttonLabel?: string;
  link?: EditorialLink;
}

export interface ManualConfig {}
export interface SectionConfig {}
export interface AutomaticConfig {
  rules: AutomaticRules;
}

export type BlockConfig = ManualConfig | AutomaticConfig | SectionConfig | EditorialConfig;

export interface Block {
  id: string;
  modality: Modality;
  format: Format;
  width: Width;
  title: string;
  card: CardKind;
  config: BlockConfig;
  /** Contenido referenciado (manual: elementos elegidos; sección: una sección; automática y editorial: vacío). */
  refs: ContentRef[];
  visible: boolean;
  /** Rediseño (opcionales): enlace «Ver todo ›» del título del bloque y subtítulo corto. */
  link?: EditorialLink;
  subtitle?: string;
}

export interface BlockSet {
  blocks: Block[];
  updatedAt: string | null;
}

export interface PublishedLayout {
  version: number;
  publishedAt: string;
  blocks: Block[];
}

export interface LayoutDocument {
  schemaVersion: number;
  /** La nueva portada permanece DESACTIVADA por defecto; mientras no exista una portada publicada y activada se usa la actual. */
  activation: { enabled: boolean };
  draft: BlockSet;
  published: PublishedLayout | null;
  /** Reservado para la etapa 4 (versiones archivadas). */
  versions: PublishedLayout[];
  /**
   * Número más alto que se ha usado nunca (también el de versiones ELIMINADAS). Las versiones nuevas siempre son `lastVersion + 1`: un número
   * eliminado no se reutiliza. Opcional: los documentos antiguos no lo tienen y se calcula con las versiones existentes.
   */
  lastVersion?: number;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type HomeMode = 'legacy' | 'layout';
