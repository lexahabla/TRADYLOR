/**
 * ==============================================================================
 * TRADYLOR - PIPELINE DE AUTOMATIZACIÓN DE PRODUCTOS (configuración)
 * ==============================================================================
 * Umbrales auditables (override por variables de entorno), lista blanca de
 * marketplaces de confianza y mapa de keywords → subcategoría para inferir la
 * subcategoría hija cuando el catálogo no la tiene aún.
 * ==============================================================================
 */

export interface PipelineConfig {
  /** Descuento mínimo (%) para puntuar el bloque de descuento/histórico. */
  minDiscountPercent: number;
  /** Score mínimo (0-100) para marcar el producto como `approved`. */
  minAuditScore: number;
  /** Valoración mínima (0-5) exigida en el bloque de reseñas. */
  minRating: number;
  /** Nº mínimo de reseñas exigido en el bloque de reseñas. */
  minReviewsCount: number;
  /** Substrings (minúsculas) de marketplaces de confianza. */
  trustedMerchants: string[];
  /** Mapa subcategoría → keywords para inferir la subcategoría hija. */
  subcategoryKeywords: Record<string, string[]>;
  /** Versión del pipeline estampada en `pipeline_version`. */
  version: number;
}

/** Lee una variable de entorno con el patrón del proyecto (process.env ?? import.meta.env). */
function env(name: string): string {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  const fromAstro = (import.meta.env as Record<string, string | undefined>)[name];
  return fromAstro ?? '';
}

function envNumber(name: string, fallback: number): number {
  const raw = env(name).trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Lista blanca de marketplaces de confianza (minúsculas, comparación por substring). */
export const TRUSTED_MERCHANTS = [
  'amazon',
  'amazon logistics',
  'ebay',
  'aliexpress',
  'aliexpress official',
  'etsy',
  'pccomponentes',
  'el corte inglés',
  'el corte ingles',
  'mediamarkt',
  'fnac',
  'carrefour',
  'apple',
  'walmart',
  'best buy',
  'official store',
  'tienda oficial',
];

/** Mapa de keywords → nombre de subcategoría hija (se crea si no existe). */
export const SUBCATEGORY_KEYWORDS: Record<string, string[]> = {
  'Auriculares': ['auricular', 'auriculares', 'earbuds', 'cascos', 'headphone', 'headset'],
  'Altavoces': ['altavoz', 'altavoces', 'speaker', 'soundbar', 'barra de sonido'],
  'Smartwatches': ['smartwatch', 'reloj inteligente', 'smart band', 'wearable'],
  'Portátiles': ['portátil', 'portatil', 'laptop', 'macbook', 'notebook', 'chromebook'],
  'Monitores': ['monitor', 'pantalla', 'display'],
  'Teclados': ['teclado', 'keyboard'],
  'Ratones': ['ratón', 'raton', 'mouse'],
  'Almacenamiento': ['ssd', 'disco duro', 'hdd', 'almacenamiento', 'nvme', 'm.2'],
  'Robot Aspirador': ['robot aspirador', 'aspirador', 'aspiradora', 'roborock', 'roomba'],
  'Iluminación': ['bombilla', 'iluminación', 'iluminacion', 'led', 'lámpara', 'lampara'],
  'Cámaras de Vigilancia': ['cámara vigilancia', 'camara vigilancia', 'cámara', 'camara', 'videovigilancia'],
  'Taladros': ['taladro', 'atornillador', 'drill'],
  'Herramientas Manuales': ['destornillador', 'llave', 'martillo', 'alicate', 'sierra'],
  'Cafeteras': ['cafetera', 'café', 'cafe', 'espresso'],
  'Freidoras': ['freidora', 'airfryer', 'air fryer'],
};

/** Devuelve la configuración activa del pipeline (umbrales override por env). */
export function getPipelineConfig(): PipelineConfig {
  return {
    minDiscountPercent: envNumber('PIPELINE_MIN_DISCOUNT_PERCENT', 5),
    minAuditScore: envNumber('PIPELINE_MIN_AUDIT_SCORE', 60),
    minRating: envNumber('PIPELINE_MIN_RATING', 4),
    minReviewsCount: envNumber('PIPELINE_MIN_REVIEWS', 20),
    trustedMerchants: TRUSTED_MERCHANTS,
    subcategoryKeywords: SUBCATEGORY_KEYWORDS,
    version: envNumber('PIPELINE_VERSION', 1),
  };
}
