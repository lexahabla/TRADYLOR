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
export const FORMATS = ['banner', 'cuadricula2x2', 'carrusel'] as const;
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
export const AUTO_ORDERS = ['recientes', 'precio_asc', 'precio_desc'] as const;
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
}

export type LinkType = 'path' | 'url' | 'product' | 'category' | 'section';
export interface EditorialLink {
  type: LinkType;
  target: string;
}
export interface EditorialConfig {
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
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type HomeMode = 'legacy' | 'layout';
