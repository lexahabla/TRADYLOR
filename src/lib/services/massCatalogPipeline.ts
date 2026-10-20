/**
 * ==============================================================================
 * TRADYLOR - PIPELINE MASIVO DE INGESTA, ENRIQUECIMIENTO Y AUTO-CURACIÓN
 * ==============================================================================
 * Orquesta el flujo completo:
 *  1. INGESTA RAW: Captura payloads completos via AffiliateAdapter → raw_affiliate_products
 *  2. ENRIQUECIMIENTO IA: Prompt maestro → ficha editorial completa + categorización + tags + matching_key
 *  3. RESOLUCIÓN CATEGORÍAS: Crea/usa categorías y subcategorías del catálogo jerárquico
 *  4. CRUCE ALTERNATIVAS: Cross-matching bidireccional via product_alternatives + products.json
 *  5. PERSISTENCIA: Upsert en products.json con campos enriquecidos (no destructivo)
 * ==============================================================================
 */

import { AffiliateAdapter, createAdapter, enrichCapturedProduct, rawPayloadToUnified, type AdaptedProduct } from './affiliateAdapter';
import {
  buildFullMasterPrompt,
  parseMasterPromptResponse,
  type MasterPromptInput,
  type MasterPromptOutput,
} from './aiMasterPrompt';
import {
  readRawAffiliateProducts,
  upsertRawAffiliateProduct,
  readProductAlternatives,
  upsertProductAlternative,
  linkAlternativesBidirectional,
  generateMatchingKey,
  generateCompetitorTerms,
  generateShortDescription,
  generateHighlights,
  structureProsCons,
  type RawAffiliateProduct,
  type ProductAlternative,
  type EnrichedProduct,
} from './databaseSchema';
import { enrichProductText, hasTextCredentials, textProvider, type EnrichedText } from '../ai';
import { enrichProductLocally } from '../localEnrich';
import { getCategories, createCategory, getCategoryById, type Category } from '../categories';
import { suggestCategory } from '../categories';
import { readProductsFromFile, upsertProduct, writeProductsToFile, type Product } from '../productStore';
import { autoLinkAlternatives, computeConversionScore, extractNormalizedTags } from '../curation';
import { slugify } from '../productStore';
import { env } from '../ai';

/**
 * Configuración del pipeline
 */
export interface PipelineConfig {
  /** Red de afiliación a procesar */
  network: string;
  /** Límite de productos a procesar (0 = todos) */
  limit?: number;
  /** Saltar productos ya procesados (processed: true en raw_affiliate_products) */
  skipProcessed?: boolean;
  /** Usar IA para enriquecimiento (requiere claves) */
  useAI?: boolean;
  /** Hacer scraping de páginas de producto */
  scrapePages?: boolean;
  /** Auto-vincular alternativas */
  autoLinkAlternatives?: boolean;
  /** Procesar en lotes de N productos */
  batchSize?: number;
  /** Pausa entre lotes (ms) */
  batchDelayMs?: number;
  /** Solo simulación (dry-run): no guarda en products.json */
  dryRun?: boolean;
}

/**
 * Resultado del procesamiento de un producto
 */
export interface ProcessedProductResult {
  rawId: string;
  externalId: string;
  success: boolean;
  productId?: string;
  product?: EnrichedProduct;
  enrichment?: MasterPromptOutput;
  warnings: string[];
  error?: string;
  isNew: boolean;
  isUpdated: boolean;
}

/**
 * Estadísticas del pipeline
 */
export interface PipelineStats {
  totalRaw: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  newProducts: number;
  updatedProducts: number;
  alternativesLinked: number;
  categoriesCreated: number;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  errors: Array<{ externalId: string; error: string }>;
}

/**
 * Clase principal: Pipeline Masivo de Catálogo
 */
export class MassCatalogPipeline {
  private config: Required<PipelineConfig>;
  private stats: PipelineStats;
  private adapter: AffiliateAdapter;

  constructor(config: PipelineConfig) {
    this.config = {
      network: config.network,
      limit: config.limit ?? 0,
      skipProcessed: config.skipProcessed ?? true,
      useAI: config.useAI ?? hasTextCredentials(),
      scrapePages: config.scrapePages ?? true,
      autoLinkAlternatives: config.autoLinkAlternatives ?? true,
      batchSize: config.batchSize ?? 10,
      batchDelayMs: config.batchDelayMs ?? 500,
      dryRun: config.dryRun ?? false,
    };

    this.adapter = createAdapter(this.config.network, {
      scrapeProductPage: this.config.scrapePages,
    });

    this.stats = {
      totalRaw: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      newProducts: 0,
      updatedProducts: 0,
      alternativesLinked: 0,
      categoriesCreated: 0,
      startTime: new Date().toISOString(),
      errors: [],
    };
  }

  /**
   * Ejecuta el pipeline completo sobre el catálogo sincronizado
   */
  async run(): Promise<PipelineStats> {
    console.log(`[MassCatalogPipeline] Iniciando para red: ${this.config.network}`);

    // 1. Obtener productos raw pendientes
    const rawProducts = await this.getPendingRawProducts();
    this.stats.totalRaw = rawProducts.length;

    if (this.config.limit > 0) {
      rawProducts.splice(this.config.limit);
    }

    console.log(`[MassCatalogPipeline] ${rawProducts.length} productos pendientes de procesar`);

    // 2. Procesar en lotes
    for (let i = 0; i < rawProducts.length; i += this.config.batchSize) {
      const batch = rawProducts.slice(i, i + this.config.batchSize);
      await this.processBatch(batch);

      // Pausa entre lotes
      if (i + this.config.batchSize < rawProducts.length) {
        await new Promise(r => setTimeout(r, this.config.batchDelayMs));
      }
    }

    this.stats.endTime = new Date().toISOString();
    this.stats.durationMs = new Date(this.stats.endTime).getTime() - new Date(this.stats.startTime).getTime();

    console.log(`[MassCatalogPipeline] Completado:`, this.stats);
    return this.stats;
  }

  /**
   * Obtiene productos raw pendientes de procesar
   */
  private async getPendingRawProducts(): Promise<RawAffiliateProduct[]> {
    const allRaw = readRawAffiliateProducts();
    const networkRaw = allRaw.filter(r => r.network === this.config.network);

    if (this.config.skipProcessed) {
      return networkRaw.filter(r => !r.processed);
    }
    return networkRaw;
  }

  /**
   * Procesa un lote de productos raw
   */
  private async processBatch(rawBatch: RawAffiliateProduct[]): Promise<void> {
    for (const raw of rawBatch) {
      try {
        const result = await this.processSingleRaw(raw);
        this.stats.processed++;

        if (result.success) {
          this.stats.succeeded++;
          if (result.isNew) this.stats.newProducts++;
          if (result.isUpdated) this.stats.updatedProducts++;
        } else {
          this.stats.failed++;
          this.stats.errors.push({ externalId: raw.externalId, error: result.error || 'Error desconocido' });
        }
      } catch (error) {
        this.stats.processed++;
        this.stats.failed++;
        this.stats.errors.push({ externalId: raw.externalId, error: error instanceof Error ? error.message : 'Error desconocido' });
        console.error(`[MassCatalogPipeline] Error procesando ${raw.externalId}:`, error);
      }
    }
  }

  /**
   * Procesa UN producto raw: ingest → enrich → categorize → link → persist
   */
  private async processSingleRaw(raw: RawAffiliateProduct): Promise<ProcessedProductResult> {
    const warnings: string[] = [];

    try {
      // Reconstruir UnifiedProduct desde rawPayload (canónico desde el PASO 6;
      // los raws legados siguen siendo UnifiedProduct y también se aceptan)
      const unifiedProduct = rawPayloadToUnified(raw.rawPayload);

      // 1. ENRIQUECIMIENTO IA (prompt maestro)
      let enrichment: MasterPromptOutput | null = null;
      let aiEnrichment: EnrichedText | null = null;

      if (this.config.useAI) {
        try {
          enrichment = await this.runMasterPrompt(unifiedProduct, warnings);
        } catch (aiError) {
          warnings.push(`IA falló: ${aiError instanceof Error ? aiError.message : 'desconocido'}, usando enriquecimiento local`);
          aiEnrichment = this.localEnrichmentFallback(unifiedProduct);
        }
      } else {
        aiEnrichment = this.localEnrichmentFallback(unifiedProduct);
      }

      // 2. RESOLVER CATEGORÍA/SUBCATEGORÍA
      const { categoryId, subcategoryId, categoryWarnings } = await this.resolveCategories(
        enrichment?.category,
        enrichment?.subcategory,
        unifiedProduct.category,
        unifiedProduct.title
      );
      warnings.push(...categoryWarnings);

      // 3. CONSTRUIR PRODUCTO ENRIQUECIDO FINAL
      const enrichedProduct = this.buildEnrichedProduct(
        unifiedProduct,
        enrichment,
        aiEnrichment,
        categoryId,
        subcategoryId,
        warnings
      );

      // 4. DUPLICADOS: buscar si ya existe en products.json
      const existingProduct = this.findExistingProduct(enrichedProduct);
      const isNew = !existingProduct;
      const isUpdated = !!existingProduct;

      // 5. PERSISTENCIA (upsert en products.json)
      if (!this.config.dryRun) {
        const savedProduct = upsertProduct(enrichedProduct);
        enrichedProduct.id = savedProduct.product.id;
      }

      // 6. AUTO-VINCULAR ALTERNATIVAS (cross-matching)
      let alternativesLinked = 0;
      if (this.config.autoLinkAlternatives && !this.config.dryRun) {
        alternativesLinked = await this.linkAlternatives(enrichedProduct, warnings);
        this.stats.alternativesLinked += alternativesLinked;
      }

      // 7. MARCAR RAW COMO PROCESADO
      raw.processed = true;
      raw.processedAt = new Date().toISOString();
      raw.sourceProductId = enrichedProduct.id;
      upsertRawAffiliateProduct(raw);

      return {
        rawId: raw.id,
        externalId: raw.externalId,
        success: true,
        productId: enrichedProduct.id,
        product: enrichedProduct,
        enrichment: enrichment || undefined,
        warnings,
        isNew,
        isUpdated,
      };
    } catch (error) {
      // Marcar raw con error
      raw.processed = true;
      raw.processedAt = new Date().toISOString();
      raw.error = error instanceof Error ? error.message : 'Error desconocido';
      upsertRawAffiliateProduct(raw);

      return {
        rawId: raw.id,
        externalId: raw.externalId,
        success: false,
        warnings,
        error: error instanceof Error ? error.message : 'Error desconocido',
        isNew: false,
        isUpdated: false,
      };
    }
  }

  /**
   * Ejecuta el prompt maestro de IA
   */
  private async runMasterPrompt(
    unifiedProduct: AdaptedProduct['product'],
    warnings: string[]
  ): Promise<MasterPromptOutput> {
    // Preparar input para el prompt maestro
    const categories = getCategories();
    const existingProducts = readProductsFromFile().map(p => ({
      id: p.id,
      title: p.title,
      category: p.category,
      subcategory_id: p.subcategory_id,
      price: p.price,
      brand: p.brand,
      matching_key: (p as EnrichedProduct).matching_key,
    }));

    const input: MasterPromptInput = {
      product: unifiedProduct,
      availableCategories: categories,
      existingProducts,
      knownOfferPrice: unifiedProduct.price,
      knownOriginalPrice: unifiedProduct.originalPrice,
    };

    const { system, user } = buildFullMasterPrompt(input);

    // Llamar a la IA (reutilizar la infraestructura de ai.ts)
    const provider = textProvider();
    let rawResponse: string;

    if (provider === 'anthropic') {
      const model = env('ANTHROPIC_MODEL') || 'claude-3-5-sonnet-latest';
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env('ANTHROPIC_API_KEY'),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2500,
          temperature: 0.3,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!response.ok) throw new Error(`Anthropic ${response.status}`);
      const payload = await response.json();
      rawResponse = (payload?.content ?? []).map((b: any) => b?.text ?? '').join('');
    } else if (provider === 'groq') {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env('GROQ_API_KEY')}`,
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          temperature: 0.3,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!response.ok) throw new Error(`Groq ${response.status}`);
      const payload = await response.json();
      rawResponse = payload?.choices?.[0]?.message?.content ?? '';
    } else {
      const model = env('OPENAI_MODEL') || 'gpt-4o-mini';
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env('OPENAI_API_KEY')}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!response.ok) throw new Error(`OpenAI ${response.status}`);
      const payload = await response.json();
      rawResponse = payload?.choices?.[0]?.message?.content ?? '';
    }

    return parseMasterPromptResponse(rawResponse);
  }

  /**
   * Fallback de enriquecimiento local (sin IA)
   */
  private localEnrichmentFallback(unifiedProduct: AdaptedProduct['product']): EnrichedText {
    return enrichProductLocally({
      title: unifiedProduct.title,
      description: unifiedProduct.description,
      category: unifiedProduct.category,
      brand: unifiedProduct.extra?.['Marca'] as string || unifiedProduct.extra?.['brand'] as string,
      merchant: unifiedProduct.network,
      price: unifiedProduct.price,
      originalPrice: unifiedProduct.originalPrice,
      rating: unifiedProduct.rating,
      reviewsCount: unifiedProduct.reviewsCount,
      url: unifiedProduct.productUrl,
      specs: unifiedProduct.extra as Record<string, string> || undefined,
    });
  }

  /**
   * Resuelve categoría y subcategoría (crea si no existen)
   */
  private async resolveCategories(
    aiCategory?: string,
    aiSubcategory?: string,
    networkCategory?: string,
    titleHint?: string
  ): Promise<{ categoryId?: string; subcategoryId?: string; categoryWarnings: string[] }> {
    const warnings: string[] = [];
    let categoryId: string | undefined;
    let subcategoryId: string | undefined;

    // 1. Intentar categoría de la IA
    let targetCategoryName = aiCategory;
    if (!targetCategoryName) {
      // Fallback: sugerencia por keywords del título+categoría de red
      const suggestion = suggestCategory(`${titleHint ?? ''} ${networkCategory ?? ''}`.trim().toLowerCase());
      targetCategoryName = suggestion?.category.name;
    }

    if (targetCategoryName) {
      const cat = getCategoryById(targetCategoryName);
      if (cat) {
        categoryId = cat.id;
      } else {
        // Crear categoría si no existe
        const created = createCategory({ name: targetCategoryName, icon: '📦', keywords: [] });
        if (created.ok && created.category) {
          categoryId = created.category.id;
          this.stats.categoriesCreated++;
          warnings.push(`Categoría "${targetCategoryName}" creada automáticamente`);
        } else {
          warnings.push(`No se pudo crear/encuentra categoría "${targetCategoryName}"`);
        }
      }
    }

    // 2. Subcategoría
    if (aiSubcategory && categoryId) {
      const parentCat = getCategoryById(categoryId);
      if (parentCat) {
        const sub = getCategories().find(c => c.parentId === parentCat.id && c.name.toLowerCase() === aiSubcategory.toLowerCase());
        if (sub) {
          subcategoryId = sub.id;
        } else {
          // Crear subcategoría
          const created = createCategory({ name: aiSubcategory, icon: '📦', keywords: [], parentId: parentCat.id });
          if (created.ok && created.category) {
            subcategoryId = created.category.id;
            this.stats.categoriesCreated++;
            warnings.push(`Subcategoría "${aiSubcategory}" creada automáticamente`);
          }
        }
      }
    }

    return { categoryId, subcategoryId, categoryWarnings: warnings };
  }

  /**
   * Construye el producto enriquecido final combinando todas las fuentes
   */
  private buildEnrichedProduct(
    unified: AdaptedProduct['product'],
    enrichment: MasterPromptOutput | null,
    aiEnrichment: EnrichedText | null,
    categoryId?: string,
    subcategoryId?: string,
    warnings: string[] = []
  ): EnrichedProduct {
    const now = new Date().toISOString();

    // Título final: IA > local > original
    const finalTitle = enrichment?.title || aiEnrichment?.title || unified.title;

    // Descripción: IA > local > original
    const finalDescription = enrichment?.description || aiEnrichment?.description || unified.description;

    // Specs: merge IA + local + red
    const mergedSpecs: Record<string, string> = {
      ...(unified.extra as Record<string, string> || {}),
      ...(aiEnrichment?.specs || {}),
      ...(enrichment?.specs || {}),
    };

    // Pros/Cons: estructurados de IA > planos de local/red
    let finalPros: string[] = [];
    let finalCons: string[] = [];
    let finalProsCons: EnrichedProduct['pros_cons'] = { pros: [], cons: [] };

    if (enrichment?.pros_cons) {
      finalProsCons = enrichment.pros_cons;
      finalPros = enrichment.pros_cons.pros.map(p => p.text);
      finalCons = enrichment.pros_cons.cons.map(c => c.text);
    } else {
      finalPros = aiEnrichment?.pros || [];
      finalCons = aiEnrichment?.cons || [];
      finalProsCons = structureProsCons(finalPros, finalCons);
    }

    // Highlights
    const highlights = enrichment?.highlights || generateHighlights(finalPros, mergedSpecs);

    // Short description
    const short_description = enrichment?.short_description || generateShortDescription(finalDescription);

    // TechSheet
    const techSheet = enrichment?.techSheet || aiEnrichment?.techSheet;

    // Veredicto
    const verdict = enrichment?.verdict || aiEnrichment?.verdict;

    // Pricing: IA > local > buildRealisticPricing
    let finalPrice = unified.price || 0;
    let finalOriginalPrice = unified.originalPrice;
    if (enrichment?.pricing) {
      finalPrice = enrichment.pricing.price;
      finalOriginalPrice = enrichment.pricing.originalPrice;
    } else if (aiEnrichment?.pricing) {
      finalPrice = aiEnrichment.pricing.price;
      finalOriginalPrice = aiEnrichment.pricing.originalPrice;
    }

    // Imágenes: todas las capturadas
    const allImages = unified.allImages || unified.gallery || [];
    const mainImage = allImages[0] || unified.image;

    // Tags normalizados
    const normalized_tags = enrichment?.normalized_tags || extractNormalizedTags({
      title: finalTitle,
      techSheet: techSheet || '',
      description: finalDescription,
      specs: mergedSpecs,
    } as Product);

    // Matching key
    const matching_key = enrichment?.matching_key || generateMatchingKey(
      finalTitle,
      (unified.extra?.['Marca'] as string) || (unified.extra?.['brand'] as string),
      undefined
    );

    // Competitor terms
    const competitor_terms = enrichment?.competitor_terms || generateCompetitorTerms(finalTitle);

    // Conversion score
    const conversion_score = computeConversionScore({
      price: finalPrice,
      originalPrice: finalOriginalPrice,
      commissionEstimate: unified.commissionAmount,
      sales30d: unified.popularity,
      rating: unified.rating,
      reviewsCount: unified.reviewsCount,
    } as Product);

    // ID del producto (slug del título enriquecido o original)
    const productId = slugify(finalTitle);

    return {
      id: productId,
      title: finalTitle,
      description: finalDescription,
      price: finalPrice,
      originalPrice: finalOriginalPrice,
      image: mainImage,
      gallery: allImages.slice(0, 10),
      images: allImages,
      category: enrichment?.category || unified.category,
      merchant: unified.network,
      affiliateUrl: unified.productUrl,
      buyNowUrl: undefined,
      asin: unified.network === 'amazon' ? unified.externalId : undefined,
      pros: finalPros,
      cons: finalCons,
      techSheet,
      specs: mergedSpecs,
      badge: enrichment?.pricing ? `Oferta ${enrichment.pricing.discountPercentage}%` : undefined,
      rating: unified.rating,
      reviewsCount: unified.reviewsCount,
      verdict,
      fulfillmentProvider: unified.extra?.['Distribuidor'] as string || unified.network,
      shippingInfo: unified.shippingInfo,
      shippingDays: undefined,
      freeShipping: undefined,
      priceHistory: [],
      // Campos de curación avanzada
      sourceId: unified.externalId,
      category_id: categoryId,
      subcategory_id: subcategoryId,
      ia_status: enrichment ? 'completed' : (aiEnrichment ? 'completed' : 'pending'),
      link_status: unified.productUrl ? 'active' : 'pending',
      normalized_tags,
      alternative_product_ids: [],
      alternatives: {},
      conversion_score,
      commissionEstimate: unified.commissionAmount,
      sales30d: unified.popularity,
      // Extensiones de enriquecimiento
      short_description,
      highlights,
      pros_cons: finalProsCons,
      matching_key,
      competitor_terms,
    };
  }

  /**
   * Busca producto existente en products.json por duplicados (sourceId, URL, título)
   */
  private findExistingProduct(enriched: EnrichedProduct): Product | undefined {
    const products = readProductsFromFile();

    // 1. Por sourceId (más fuerte)
    if (enriched.sourceId) {
      const found = products.find(p => p.sourceId === enriched.sourceId);
      if (found) return found;
    }

    // 2. Por URL canónica (afiliado/producto)
    const { normalizeProductKey } = require('../productStore');
    const candidateUrls = [enriched.affiliateUrl].filter(Boolean);
    for (const product of products) {
      for (const url of candidateUrls) {
        if (product.affiliateUrl && normalizeProductKey(product.affiliateUrl) === normalizeProductKey(url)) return product;
        if (product.buyNowUrl && normalizeProductKey(product.buyNowUrl) === normalizeProductKey(url)) return product;
      }
    }

    // 3. Por matching_key (nuevo)
    if (enriched.matching_key) {
      const found = products.find(p => (p as EnrichedProduct).matching_key === enriched.matching_key);
      if (found) return found;
    }

    // 4. Por título limpio en misma categoría (posible duplicado)
    const { cleanTitleKey } = require('../curation');
    const titleKey = cleanTitleKey(enriched.title);
    if (titleKey.length >= 8) {
      const found = products.find(p =>
        cleanTitleKey(p.title) === titleKey &&
        String(p.category || '').trim().toLowerCase() === String(enriched.category || '').trim().toLowerCase()
      );
      if (found) return found;
    }

    return undefined;
  }

  /**
   * Vincula alternativas (cross-matching) usando la lógica de curation.ts + nueva tabla
   */
  private async linkAlternatives(enriched: EnrichedProduct, warnings: string[]): Promise<number> {
    const products = readProductsFromFile();
    const allProducts = [...products, enriched]; // incluir el nuevo para matching

    // Usar autoLinkAlternatives de curation.ts (que ya hace matching por título/categoría)
    const result = autoLinkAlternatives(enriched.id);

    if (result.ok && result.linked > 0) {
      warnings.push(`${result.linked} alternativa(s) vinculada(s) automáticamente`);
      return result.linked;
    }

    // Fallback: matching por matching_key si existe
    if (enriched.matching_key) {
      const similar = allProducts.filter(p =>
        p.id !== enriched.id &&
        (p as EnrichedProduct).matching_key === enriched.matching_key
      );

      for (const alt of similar.slice(0, 3)) {
        linkAlternativesBidirectional(enriched.id, alt.id, 'similar', 80, 'auto');
      }
      return similar.length;
    }

    return 0;
  }

  /**
   * Obtiene estadísticas actuales
   */
  getStats(): PipelineStats {
    return { ...this.stats };
  }
}

/**
 * Función helper: ejecuta pipeline para una red
 */
export async function runMassCatalogPipeline(config: PipelineConfig): Promise<PipelineStats> {
  const pipeline = new MassCatalogPipeline(config);
  return pipeline.run();
}

/**
 * Función helper: procesa un array de productos ya adaptados (para API batch)
 */
export async function processAdaptedProductsBatch(
  adaptedProducts: AdaptedProduct[],
  options: {
    useAI?: boolean;
    autoLinkAlternatives?: boolean;
    dryRun?: boolean;
  } = {}
): Promise<{
  results: Array<{ success: boolean; productId?: string; error?: string; warnings: string[] }>;
  stats: { total: number; succeeded: number; failed: number; newProducts: number; updatedProducts: number };
}> {
  const results: Array<{ success: boolean; productId?: string; error?: string; warnings: string[] }> = [];
  const stats = { total: adaptedProducts.length, succeeded: 0, failed: 0, newProducts: 0, updatedProducts: 0 };

  for (const adapted of adaptedProducts) {
    try {
      // Enriquecer con scraping + IA si se pide
      let enrichedAdapted = adapted;
      if (options.useAI && hasTextCredentials()) {
        enrichedAdapted = await enrichCapturedProduct(adapted);
      }

      // Construir input para prompt maestro
      const categories = getCategories();
      const existingProducts = readProductsFromFile().map(p => ({
        id: p.id,
        title: p.title,
        category: p.category,
        subcategory_id: p.subcategory_id,
        price: p.price,
        brand: p.brand,
        matching_key: (p as EnrichedProduct).matching_key,
      }));

      const input: MasterPromptInput = {
        product: enrichedAdapted.product,
        availableCategories: categories,
        existingProducts,
        knownOfferPrice: enrichedAdapted.product.price,
        knownOriginalPrice: enrichedAdapted.product.originalPrice,
      };

      // Ejecutar prompt maestro
      let enrichment: MasterPromptOutput | null = null;
      if (options.useAI && hasTextCredentials()) {
        const { system, user } = buildFullMasterPrompt(input);
        const provider = textProvider();
        let rawResponse: string;

        if (provider === 'anthropic') {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env('ANTHROPIC_API_KEY'),
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: env('ANTHROPIC_MODEL') || 'claude-3-5-sonnet-latest',
              max_tokens: 2500,
              temperature: 0.3,
              system,
              messages: [{ role: 'user', content: user }],
            }),
          });
          const payload = await response.json();
          rawResponse = (payload?.content ?? []).map((b: any) => b?.text ?? '').join('');
        } else if (provider === 'groq') {
          const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${env('GROQ_API_KEY')}`,
            },
            body: JSON.stringify({
              model: 'openai/gpt-oss-120b',
              temperature: 0.3,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
            }),
          });
          const payload = await response.json();
          rawResponse = payload?.choices?.[0]?.message?.content ?? '';
        } else {
          const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${env('OPENAI_API_KEY')}`,
            },
            body: JSON.stringify({
              model: env('OPENAI_MODEL') || 'gpt-4o-mini',
              temperature: 0.3,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
            }),
          });
          const payload = await response.json();
          rawResponse = payload?.choices?.[0]?.message?.content ?? '';
        }

        enrichment = parseMasterPromptResponse(rawResponse);
      }

      // Resolver categorías
      const { categoryId, subcategoryId } = await (async () => {
        let categoryId: string | undefined;
        let subcategoryId: string | undefined;

        if (enrichment?.category) {
          const cat = getCategoryById(enrichment.category);
          if (cat) categoryId = cat.id;
          else {
            const created = createCategory({ name: enrichment.category, icon: '📦', keywords: [] });
            if (created.ok && created.category) categoryId = created.category.id;
          }
        }

        if (enrichment?.subcategory && categoryId) {
          const parentCat = getCategoryById(categoryId);
          if (parentCat) {
            const sub = getCategories().find(c => c.parentId === parentCat.id && c.name.toLowerCase() === enrichment!.subcategory!.toLowerCase());
            if (sub) subcategoryId = sub.id;
            else {
              const created = createCategory({ name: enrichment!.subcategory!, icon: '📦', keywords: [], parentId: parentCat.id });
              if (created.ok && created.category) subcategoryId = created.category.id;
            }
          }
        }

        return { categoryId, subcategoryId };
      })();

      // Construir producto final (reutilizar lógica del pipeline)
      // Nota: buildEnrichedProduct es método privado, replicamos lógica aquí simplificada
      const finalProduct = buildEnrichedProductForBatch(enrichedAdapted.product, enrichment, categoryId, subcategoryId);

      // Duplicados
      const adaptedSourceId = (enrichedAdapted.product as { sourceId?: string }).sourceId;
      const existing = readProductsFromFile().find(p => p.id === finalProduct.id || (adaptedSourceId && p.sourceId === adaptedSourceId));
      const isNew = !existing;
      const isUpdated = !!existing;

      if (!options.dryRun) {
        upsertProduct(finalProduct);
      }

      // Alternativas
      if (options.autoLinkAlternatives !== false && !options.dryRun) {
        autoLinkAlternatives(finalProduct.id);
      }

      results.push({
        success: true,
        productId: finalProduct.id,
        warnings: enrichedAdapted.warnings,
      });
      stats.succeeded++;
      if (isNew) stats.newProducts++;
      if (isUpdated) stats.updatedProducts++;
    } catch (error) {
      results.push({
        success: false,
        error: error instanceof Error ? error.message : 'Error desconocido',
        warnings: [],
      });
      stats.failed++;
    }
  }

  return { results, stats };
}

/**
 * Versión simplificada de buildEnrichedProduct para uso en batch API
 */
function buildEnrichedProductForBatch(
  unified: AdaptedProduct['product'],
  enrichment: MasterPromptOutput | null,
  categoryId?: string,
  subcategoryId?: string
): EnrichedProduct {
  const aiEnrichment = enrichProductLocally({
    title: unified.title,
    description: unified.description,
    category: unified.category,
    brand: unified.extra?.['Marca'] as string || unified.extra?.['brand'] as string,
    merchant: unified.network,
    price: unified.price,
    originalPrice: unified.originalPrice,
    rating: unified.rating,
    reviewsCount: unified.reviewsCount,
    url: unified.productUrl,
    specs: unified.extra as Record<string, string> || undefined,
  });

  const finalTitle = enrichment?.title || aiEnrichment?.title || unified.title;
  const finalDescription = enrichment?.description || aiEnrichment?.description || unified.description;
  const mergedSpecs = { ...(unified.extra as Record<string, string> || {}), ...(aiEnrichment?.specs || {}), ...(enrichment?.specs || {}) };
  const finalPros = enrichment?.pros_cons?.pros.map(p => p.text) || aiEnrichment?.pros || [];
  const finalCons = enrichment?.pros_cons?.cons.map(c => c.text) || aiEnrichment?.cons || [];
  const finalProsCons = enrichment?.pros_cons || structureProsCons(finalPros, finalCons);
  const highlights = enrichment?.highlights || generateHighlights(finalPros, mergedSpecs);
  const short_description = enrichment?.short_description || generateShortDescription(finalDescription);
  const techSheet = enrichment?.techSheet || aiEnrichment?.techSheet;
  const verdict = enrichment?.verdict || aiEnrichment?.verdict;

  let finalPrice = unified.price || 0;
  let finalOriginalPrice = unified.originalPrice;
  if (enrichment?.pricing) {
    finalPrice = enrichment.pricing.price;
    finalOriginalPrice = enrichment.pricing.originalPrice;
  } else if (aiEnrichment?.pricing) {
    finalPrice = aiEnrichment.pricing.price;
    finalOriginalPrice = aiEnrichment.pricing.originalPrice;
  }

  const allImages = unified.allImages || unified.gallery || [];
  const mainImage = allImages[0] || unified.image;

  const normalized_tags = enrichment?.normalized_tags || extractNormalizedTags({
    title: finalTitle,
    techSheet: techSheet || '',
    description: finalDescription,
    specs: mergedSpecs,
  } as Product);

  const matching_key = enrichment?.matching_key || generateMatchingKey(finalTitle, unified.extra?.['Marca'] as string);
  const competitor_terms = enrichment?.competitor_terms || generateCompetitorTerms(finalTitle);

  const conversion_score = computeConversionScore({
    price: finalPrice,
    originalPrice: finalOriginalPrice,
    commissionEstimate: unified.commissionAmount,
    sales30d: unified.popularity,
    rating: unified.rating,
    reviewsCount: unified.reviewsCount,
  } as Product);

  const productId = slugify(finalTitle);

  return {
    id: productId,
    title: finalTitle,
    description: finalDescription,
    price: finalPrice,
    originalPrice: finalOriginalPrice,
    image: mainImage,
    gallery: allImages.slice(0, 10),
    images: allImages,
    category: enrichment?.category || unified.category,
    merchant: unified.network,
    affiliateUrl: unified.productUrl,
    buyNowUrl: undefined,
    asin: unified.network === 'amazon' ? unified.externalId : undefined,
    pros: finalPros,
    cons: finalCons,
    techSheet,
    specs: mergedSpecs,
    badge: enrichment?.pricing ? `Oferta ${enrichment.pricing.discountPercentage}%` : undefined,
    rating: unified.rating,
    reviewsCount: unified.reviewsCount,
    verdict,
    fulfillmentProvider: unified.extra?.['Distribuidor'] as string || unified.network,
    shippingInfo: unified.shippingInfo,
    shippingDays: undefined,
    freeShipping: undefined,
    priceHistory: [],
    sourceId: unified.externalId,
    category_id: categoryId,
    subcategory_id: subcategoryId,
    ia_status: enrichment ? 'completed' : 'completed',
    link_status: unified.productUrl ? 'active' : 'pending',
    normalized_tags,
    alternative_product_ids: [],
    alternatives: {},
    conversion_score,
    commissionEstimate: unified.commissionAmount,
    sales30d: unified.popularity,
    short_description,
    highlights,
    pros_cons: finalProsCons,
    matching_key,
    competitor_terms,
  };
}