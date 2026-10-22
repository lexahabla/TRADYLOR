import { z, defineCollection } from 'astro:content';

/**
 * ==============================================================================
 * TRADYLOR — PRODUCT SCHEMA (Zod + Content Collections)
 * ==============================================================================
 *
 * Schema Zod para la colección "products". Define todos los campos necesarios
 * para renderizado automático de:
 *   - Fichas de producto (ProductCard, [id].astro)
 *   - Tablas comparativas (ComparisonTable)
 *   - Métricas de confianza (trust metrics, badges, E-E-A-T)
 *   - Disclosure de afiliación y transparencia
 *   - Hooks de conversión (CTAs, pros/cons, verdict)
 *   - Alternativas y cross-selling
 *
 * Valores por defecto y optional guards previenen errores de build/compilación
 * cuando un producto nuevo no incluye todos los campos.
 * ==============================================================================
 */

const productSchema = z.object({
  // ─── Identificación ───────────────────────────────────────────────────────
  id: z.string(),
  slug: z.string().optional(), // ruta canónica /producto/[slug] (contrato n8n)
  title: z.string(),
  description: z.string().default(''),

  // ─── Ficha técnica objetiva (contrato n8n: { "Autonomía": "30 horas" }) ────
  specs: z.record(z.string()).optional(),

  // ─── Product Classification ───────────────────────────────────────────────
  category: z.string(),
  productType: z.enum([
    'Laptop',
    'Tablet',
    'Smartphone',
    'Smartwatch',
    'Auriculares',
    'Monitor',
    'Electrodoméstico',
    'Otros',
  ]),
  brand: z.string(),
  model: z.string(),
  awardBadge: z.string().optional(), // e.g., "Mejor Calidad/Precio", "Elección Top"

  // ─── Pricing & Stock Intelligence ──────────────────────────────────────────
  pricing: z.object({
    currentPrice: z.number(),
    originalPrice: z.number().optional(),
    discountPercentage: z.number().optional(),
    priceLastChecked: z
      .string()
      .default(() => new Date().toISOString().split('T')[0]),
    freeShipping: z.boolean().default(false),
    stockStatus: z
      .enum(['En stock', 'Pocas unidades', 'Agotado'])
      .default('En stock'),
  }),

  // ─── Price history (capturado en cada visita a la ficha, 1 punto/día) ──────
  priceHistory: z
    .array(z.object({ date: z.string(), price: z.number() }))
    .optional(),

  // ─── Conversion & Trust Metrics ────────────────────────────────────────────
  conversionHooks: z.object({
    idealFor: z.string().optional(),
    notRecommendedFor: z.string().optional(),
    returnPolicyDays: z.number().default(30),
    rating: z.number().min(0).max(5).default(4.5),
    totalReviewsCount: z.number().default(0),
    satisfactionScore: z.object({
      positivePercentage: z.number().min(0).max(100).default(85),
      negativePercentage: z.number().min(0).max(100).default(15),
    }).default({ positivePercentage: 85, negativePercentage: 15 }),
  }),

  // ─── Methodology & Analysis Metrics ────────────────────────────────────────
  investigation: z.object({
    hoursInvestigated: z.number().default(10),
    modelsCompared: z.number().default(5),
    hiddenDrawbacks: z.array(z.string()).default([]),
    pros: z.array(z.string()).default([]),
    cons: z.array(z.string()).default([]),
  }),

  // ─── Affiliate & External Links ────────────────────────────────────────────
  affiliate: z.object({
    primaryStore: z.string().default('Amazon'),
    primaryUrl: z.string().url(),
    buyNowUrl: z.string().url().optional(),
    asin: z.string().optional(),
    alternativeStore: z.string().optional(),
    alternativeUrl: z.string().optional(),
  }),

  // ─── Alternative Products Cross-Referencing ────────────────────────────────
  alternatives: z.object({
    cheaperOptionId: z.string().optional(),
    premiumOptionId: z.string().optional(),
    similarOptionId: z.string().optional(),
    cheaperOptionIds: z.array(z.string()).optional(),
    similarOptionIds: z.array(z.string()).optional(),
  }).optional(),

  // ─── Curación avanzada (opcionales; se gestionan desde el panel admin) ─────
  /** ID externo del producto (ASIN / Item ID de AliExpress). */
  sourceId: z.string().optional(),
  /** ID de la categoría padre (catálogo jerárquico de categories.json). */
  category_id: z.string().optional(),
  /** ID de la subcategoría (categoría-hija con parentId). */
  subcategory_id: z.string().optional(),
  /** Estado del enriquecimiento con IA: pending | completed | error. */
  ia_status: z.string().optional(),
  /** Estado del enlace de afiliación: active | pending | broken. */
  link_status: z.string().optional(),
  /** Tags técnicos normalizados (matriz de atributos; filtros públicos). */
  normalized_tags: z.array(z.string()).optional(),
  /** Alternativas vinculadas (cross-matching bidireccional). */
  alternative_product_ids: z.array(z.string()).optional(),
  /** Puntuación de conversión/rentabilidad 0-100 (calculada en el panel). */
  conversion_score: z.number().optional(),

  // ─── Pipeline de automatización (opcionales; alimentan las métricas de transparencia) ──
  /** Estado de auditoría "Test & Proof": approved | rejected | pending. */
  audit_status: z.enum(['approved', 'rejected', 'pending']).optional(),
  /** Puntuación de auditoría 0-100 (Etapa 2 del pipeline). */
  audit_score: z.number().min(0).max(100).optional(),
  /** Motivos de rechazo de la auditoría (códigos; Etapa 2 del pipeline). */
  audit_reasons: z.array(z.string()).optional(),
  /** Versión del pipeline que lastró por última vez el producto. */
  pipeline_version: z.number().optional(),
  /** Timestamp ISO de la última ejecución del pipeline sobre el producto. */
  pipeline_run_at: z.string().optional(),
  /** `true` si la IA de texto enriquecido la ficha (Etapa 3 del pipeline). */
  ai_enriched: z.boolean().optional(),
  /** Motivo por el que la IA de texto no pudo enriquecer la ficha. */
  ai_error: z.string().optional(),
  /** Título sintetizado y corto (para product-cards). Si falta, se usa `title`. */
  title_short: z.string().optional(),
  /** Descripción original del comercio (sin bloques generados por el enrichment). */
  sourceDescription: z.string().optional(),

  // ─── Media & Visual ────────────────────────────────────────────────────────
  image: z.string().default('/images/placeholder-product.jpg'),
  /** Galería completa del producto (vistas adicionales para el carrusel). */
  gallery: z.array(z.string()).optional(),
  badge: z.string().optional(),
  /** Texto de ficha técnica (consulta en la página del producto). */
  techSheet: z.string().optional(),
  verdict: z.string().optional(),

  // ─── Compra delegada (Delegated Checkout) ──────────────────────────────────
  fulfillmentProvider: z.string().optional(), // distribuidor que cobra, envía y gestiona la garantía

  // ─── Envío (datos del comerciante; los usa ficha y checkout) ───────────────
  shippingInfo: z.string().optional(), // texto visible: "Envío en 15 días"
  shippingDays: z.number().optional(),  // días estimados (entero)
  freeShipping: z.boolean().optional(), // envío estándar gratuito confirmado
});

export type Product = z.infer<typeof productSchema>;
export { productSchema };

export const collections = {
  products: defineCollection({
    type: 'content',
    schema: productSchema,
  }),
};
