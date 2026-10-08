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
    alternativeStore: z.string().optional(),
    alternativeUrl: z.string().url().optional(),
  }),

  // ─── Alternative Products Cross-Referencing ────────────────────────────────
  alternatives: z.object({
    cheaperOptionId: z.string().optional(),
    premiumOptionId: z.string().optional(),
    similarOptionId: z.string().optional(),
  }).optional(),

  // ─── Media & Visual ────────────────────────────────────────────────────────
  image: z.string().default('/images/placeholder-product.jpg'),
  badge: z.string().optional(),
  verdict: z.string().optional(),

  // ─── Compra delegada (Delegated Checkout) ──────────────────────────────────
  fulfillmentProvider: z.string().optional(), // distribuidor que cobra, envía y gestiona la garantía
});

export type Product = z.infer<typeof productSchema>;
export { productSchema };

export const collections = {
  products: defineCollection({
    type: 'content',
    schema: productSchema,
  }),
};
