import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { suggestCategory, resolveCategoryIds } from '../../../lib/categories';
import {
  buildRealisticPricing,
  enrichProductText,
  generateProductImage,
  hasImageCredentials,
  hasTextCredentials,
  imageProvider,
  textProvider,
  type EnrichedText,
} from '../../../lib/ai';
import { enrichProductLocally } from '../../../lib/localEnrich';
import { findDuplicateProduct, readProductsFromFile, slugify, upsertProduct, writeProductsToFile, type Product } from '../../../lib/productStore';
import { autoLinkAlternatives } from '../../../lib/curation';
import { extractAsinFromUrl, getAmazonAddToCartUrl } from '../../../utils/amazon';
import { complementProductFromPage } from '../products/add';

export const prerender = false;

/**
 * POST /api/admin/add-product
 *
 * Alta/actualización de producto 100% interna (sustituye al pipeline externo de n8n):
 *   1) Enriquecimiento de texto con IA → descripción, ficha técnica, pros/contras y veredicto.
 *   2) Generación de imagen de producto con IA (OpenAI Images / Flux) en el prompt
 *      comercial de fotografía de e-commerce, guardada en local.
 *   3) Persistencia opcional en src/data/products.json.
 *
 * Requiere sesión de admin (cookie tradylor_admin_session).
 *
 * Body JSON:
 * {
 *   "title": "Auriculares...",            // obligatorio
 *   "description": "...", "category": "Audio & Sonido",
 *   "price": 129.99, "originalPrice": 149.99,
 *   "image": "https://...",               // respaldo si la IA de imagen falla
 *   "affiliateUrl": "https://...", "merchant": "Amazon",
 *   "url": "https://tienda...",           // contexto extra para la IA
 *   "id": "auriculares-...",              // para actualizar
 *   "options": { "text": true, "image": true, "save": true }
 * }
 *
 * Respuesta: { success, saved, product, enrichment: { text, image, warnings } }
 */

const DEFAULT_IMAGE =
  'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=800&auto=format&fit=crop';

function detectMerchant(url?: string, explicit?: string): string {
  const given = String(explicit ?? '').trim();
  if (given) return given;
  if (!url) return 'Comercio Externo';
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('amazon.')) return 'Amazon';
    if (host.includes('pccomponentes.')) return 'PcComponentes';
    if (host.includes('elcorteingles.')) return 'El Corte Inglés';
    if (host.includes('mediamarkt.')) return 'MediaMarkt';
    if (host.includes('aliexpress.')) return 'AliExpress';
    if (host.includes('fnac.')) return 'Fnac';
    if (host.includes('carrefour.')) return 'Carrefour';
    if (host.includes('apple.')) return 'Apple';
    const parts = host.replace(/^www\./, '').split('.');
    return parts[0] ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1) : 'Comercio Externo';
  } catch {
    return 'Comercio Externo';
  }
}

function resolveFulfillment(merchant: string): string {
  return merchant === 'Amazon' ? 'Amazon Logistics' : merchant;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ success: false, message: 'Cuerpo JSON inválido' }, 400);
    }

    const title = String(body?.title ?? '').trim();
    if (!title) {
      return jsonResponse({ success: false, message: 'El campo "title" es obligatorio' }, 400);
    }

    const options = {
      text: body?.options?.text !== false,
      image: body?.options?.image !== false,
      save: body?.options?.save !== false,
    };

    // ------------------------------------------------------------------
    // DUPLICADOS: si el producto ya está en el catálogo (misma URL de
    // afiliado/tienda o mismo título normalizados) NO se vuelve a dar de
    // alta ni se gastan llamadas de IA. El id propio nunca cuenta.
    // ------------------------------------------------------------------
    if (options.save) {
      const requestedId = String(body?.id ?? '').trim();
      const duplicate = findDuplicateProduct(readProductsFromFile(), {
        id: requestedId,
        title,
        urls: [body?.affiliateUrl, body?.url, body?.buyNowUrl],
      });
      if (duplicate) {
        // Auto-sanado: si venía de la tabla de afiliados y la fila existente
        // no guarda el ID externo, se le estampa AHORA (una sola vez). Así el
        // filtro «En catálogo › Añadidos» reconoce el producto para siempre.
        const incomingSourceId = String(body?.sourceId ?? '').trim();
        if (incomingSourceId && !String(duplicate.sourceId ?? '').trim()) {
          const all = readProductsFromFile();
          const target = all.find((item) => item.id === duplicate.id);
          if (target) {
            target.sourceId = incomingSourceId;
            writeProductsToFile(all);
            duplicate.sourceId = incomingSourceId;
          }
        }
        return jsonResponse(
          {
            success: true,
            saved: false,
            duplicate: true,
            message: `Ya está en el catálogo («${duplicate.title}»): no se ha añadido un duplicado.`,
            product: duplicate,
            enrichment: {
              text: 'skipped',
              image: 'skipped',
              warnings: ['Duplicado evitado: el producto ya existía en el catálogo.'],
            },
          },
          200
        );
      }
    }

    const warnings: string[] = [];
    let textStatus: 'ok' | 'local' | 'skipped' | 'error' = 'skipped';
    let imageStatus: 'ok' | 'skipped' | 'error' = 'skipped';
    let enrichment: EnrichedText | null = null;
    let generatedImageUrl: string | null = null;

    // ------------------------------------------------------------------
    // PASO 0 — Complemento desde la página del producto (best-effort)
    //   Cuando faltan datos de la ficha (marca, specs, valoración, opiniones,
    //   distribuidor, envío, compra directa, galería…) se lee la URL en el
    //   servidor (scrape por regex + fallback de IA) y se rellenan los huecos.
    //   Si la tienda bloquea, el alta continúa igualmente con lo recibido.
    // ------------------------------------------------------------------
    const complementNotes: string[] = [];
    await complementProductFromPage(body as Record<string, any>, complementNotes, { title });
    warnings.push(...complementNotes);

    // ------------------------------------------------------------------
    // PASO 1 — Enriquecimiento de texto
    //   Base SIEMPRE local (gratis, sin claves ni créditos).
    //   Si hay claves de IA y funciona, se mejora por encima (overlay).
    // ------------------------------------------------------------------
    const localEnrichment = enrichProductLocally({
      title,
      description: body?.description,
      category: body?.category,
      brand: body?.brand,
      merchant: body?.merchant,
      price: body?.price ? Number(body.price) : undefined,
      originalPrice: body?.originalPrice ? Number(body.originalPrice) : undefined,
      rating: body?.rating ? Number(body.rating) : undefined,
      reviewsCount: body?.reviewsCount ? Number(body.reviewsCount) : undefined,
      url: body?.url,
      specs: body?.specs && typeof body.specs === 'object' ? body.specs : undefined,
      pros: Array.isArray(body?.pros) ? body.pros : undefined,
      cons: Array.isArray(body?.cons) ? body.cons : undefined,
    });

    if (options.text) {
      if (!hasTextCredentials()) {
        warnings.push(
          `Ficha generada localmente (sin IA). Para texto con IA añade ${textProvider() === 'anthropic' ? 'ANTHROPIC_API_KEY' : textProvider() === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY'}.`
        );
        enrichment = localEnrichment;
        textStatus = 'local';
      } else {
        try {
          const aiEnrichment = await enrichProductText({
            title,
            description: body?.description,
            category: body?.category,
            url: body?.url,
            price: body?.price ? Number(body.price) : undefined,
            originalPrice: body?.originalPrice ? Number(body.originalPrice) : undefined,
          });
          // Overlay: la IA mejora lo local, pero NO borra datos con campos vacíos.
          const pick = (aiValue: any, localValue: any) => {
            if (typeof aiValue === 'string') return aiValue.trim() ? aiValue : localValue;
            if (Array.isArray(aiValue)) return aiValue.length ? aiValue : localValue;
            return aiValue ?? localValue;
          };
          enrichment = {
            ...localEnrichment,
            ...aiEnrichment,
            title: pick(aiEnrichment.title, localEnrichment.title),
            description: pick(aiEnrichment.description, localEnrichment.description),
            verdict: pick(aiEnrichment.verdict, localEnrichment.verdict),
            category: pick(aiEnrichment.category, localEnrichment.category),
            specs: { ...(localEnrichment.specs ?? {}), ...(aiEnrichment.specs ?? {}) },
            pros: pick(aiEnrichment.pros, localEnrichment.pros),
            cons: pick(aiEnrichment.cons, localEnrichment.cons),
            pricing: aiEnrichment.pricing ?? localEnrichment.pricing,
          };
          textStatus = 'ok';
        } catch (error: any) {
          textStatus = 'local';
          enrichment = localEnrichment;
          warnings.push(`IA no disponible (${error?.message ?? error}). Ficha generada localmente.`);
        }
      }
    }

    // ------------------------------------------------------------------
    // PASO 2 — Generación/acondicionamiento de imagen (IA)
    //   El prompt usa el título sintetizado (más limpio y descriptivo).
    // ------------------------------------------------------------------
    const imagePromptTitle = enrichment?.title?.trim() || title;
    if (options.image) {
      if (!hasImageCredentials()) {
        imageStatus = 'skipped';
        warnings.push(
          `Imagen no generada: falta la clave de ${imageProvider() === 'flux' ? 'Flux (FLUX_API_KEY)' : 'OpenAI (OPENAI_API_KEY)'}.`
        );
      } else {
        try {
          const result = await generateProductImage(imagePromptTitle);
          generatedImageUrl = result.url;
          imageStatus = 'ok';
        } catch (error: any) {
          imageStatus = 'error';
          warnings.push(`Fallo al generar la imagen: ${error?.message ?? error}`);
        }
      }
    }

    // ------------------------------------------------------------------
    // Composición del producto (base + enriquecimiento)
    // ------------------------------------------------------------------
    const finalTitle = enrichment?.title?.trim() || title;

    const bodyGallery = Array.isArray(body?.gallery)
      ? (body.gallery as unknown[])
          .map((g) => String(g ?? '').trim())
          .filter((g) => /^https?:\/\//i.test(g) || g.startsWith('/images/'))
          .slice(0, 10)
      : [];

    // ASIN: del body o autodetectado desde el enlace de afiliado/URL del producto.
    const resolvedAsin = (() => {
      const fromBody = String(body?.asin ?? '').trim().toUpperCase();
      if (/^[A-Z0-9]{10}$/.test(fromBody)) return fromBody;
      return extractAsinFromUrl(String(body?.affiliateUrl ?? body?.url ?? '')) || undefined;
    })();

    const base: Product = {
      id: String(body?.id ?? '').trim() || slugify(finalTitle),
      title: finalTitle,
      description: String(body?.description ?? '').trim(),
      price: Number(body?.price) || 0,
      originalPrice: body?.originalPrice ? Number(body.originalPrice) : undefined,
      image:
        generatedImageUrl ||
        String(body?.image ?? '').trim() ||
        DEFAULT_IMAGE,
      gallery: (() => {
        const gallery = bodyGallery.slice();
        if (generatedImageUrl && !gallery.includes(generatedImageUrl)) gallery.unshift(generatedImageUrl);
        const mainImage = generatedImageUrl || String(body?.image ?? '').trim();
        if (mainImage && !gallery.includes(mainImage)) gallery.unshift(mainImage);
        return gallery.length ? gallery : undefined;
      })(),
      category: String(body?.category ?? '').trim(),
      merchant: detectMerchant(body?.affiliateUrl || body?.url, body?.merchant),
      affiliateUrl: String(body?.affiliateUrl ?? body?.url ?? '').trim(),
      // Compra directa: si no se envía una URL manual y hay ASIN, se genera la
      // cesta de Amazon con el tag de afiliado (flujo de tramitación del pedido).
      buyNowUrl: body?.buyNowUrl
        ? String(body.buyNowUrl).trim()
        : resolvedAsin
          ? getAmazonAddToCartUrl(resolvedAsin)
          : undefined,
      asin: resolvedAsin,
      pros: [],
      cons: [],
      techSheet: body?.techSheet ? String(body.techSheet).trim() : undefined,
      badge: body?.badge ? String(body.badge).trim() : undefined,
      rating: body?.rating ? Number(body.rating) : 4.8,
      reviewsCount: body?.reviewsCount ? Number(body.reviewsCount) : 100,
      specs: body?.specs && typeof body.specs === 'object' ? body.specs : undefined,
      fulfillmentProvider: body?.fulfillmentProvider
        ? String(body.fulfillmentProvider).trim()
        : undefined,
      shippingInfo: body?.shippingInfo ? String(body.shippingInfo).trim() : undefined,
      shippingDays:
        body?.shippingDays != null && Number.isFinite(Number(body.shippingDays))
          ? Math.max(0, Math.round(Number(body.shippingDays)))
          : undefined,
      freeShipping: typeof body?.freeShipping === 'boolean' ? body.freeShipping : undefined,
    };

    if (enrichment) {
      // La descripción SIEMPRE se mejora con la del enriquecimiento (IA o
      // local): el botón "Enriquecer con IA" reescribe la redacción técnica.
      if (enrichment.description?.trim()) base.description = enrichment.description;
      if (enrichment.pros.length) base.pros = enrichment.pros;
      if (enrichment.cons.length) base.cons = enrichment.cons;
      if (enrichment.verdict) base.verdict = enrichment.verdict;
      if (enrichment.techSheet?.trim() && !base.techSheet) base.techSheet = enrichment.techSheet;
      if (enrichment.specs && Object.keys(enrichment.specs).length) {
        base.specs = { ...(base.specs ?? {}), ...enrichment.specs };
      }
      if (!base.category && enrichment.category) base.category = enrichment.category;
    }

    // ------------------------------------------------------------------
    // Precios: par oferta + original tachado con descuento realista (15–35 %)
    //   - Sin oferta conocida → se usa el par generado (IA o local).
    //   - Con oferta (manual o scrape) → se respeta y sólo se completa el
    //     original tachado si falta o no es mayor que la oferta.
    // ------------------------------------------------------------------
    if (enrichment?.pricing) {
      const { price: enrichedOffer, originalPrice: enrichedOriginal } = enrichment.pricing;
      if (!base.price || base.price <= 0) {
        base.price = enrichedOffer;
        base.originalPrice = enrichedOriginal;
      } else if (!base.originalPrice || base.originalPrice <= base.price) {
        base.originalPrice =
          enrichedOriginal > base.price
            ? enrichedOriginal
            : buildRealisticPricing(base.price).originalPrice;
      }
    }

    if (!base.category) {
      const suggestion = suggestCategory(`${base.title} ${base.description}`.toLowerCase());
      base.category = suggestion?.category.name || 'Tecnología';
    }
    if (!base.fulfillmentProvider) base.fulfillmentProvider = resolveFulfillment(base.merchant);

    // ------------------------------------------------------------------
    // PASO 3 — Persistencia
    // ------------------------------------------------------------------
    let saved = false;
    if (options.save) {
      const existing = readProductsFromFile().find((item) => item.id === base.id);
      if (existing) {
        // Curación: el upsert conserva los campos de catálogo jerárquico y
        // cross-matching que el formulario de enriquecimiento no conoce.
        const CURATION_FIELDS = [
          'sourceId', 'category_id', 'subcategory_id', 'ia_status', 'link_status',
          'normalized_tags', 'alternative_product_ids', 'alternatives',
          'conversion_score', 'commissionEstimate', 'sales30d',
          'audit_status', 'audit_score', 'audit_reasons',
          'pipeline_version', 'pipeline_run_at', 'ai_enriched', 'ai_error',
          'sourceDescription',
        ] as const;
        for (const field of CURATION_FIELDS) {
          if ((existing as any)[field] !== undefined) {
            (base as any)[field] = (existing as any)[field];
          }
        }
        // Categorización jerárquica: si la categoría o la subcategoría han
        // cambiado, se recalculan los ids de categories.json (la curación
        // heredada no debe dejar ids de la categoría anterior).
        const categoryChanged = base.category !== existing.category;
        if (categoryChanged || body?.subcategory !== undefined) {
          const resolvedIds = resolveCategoryIds(
            base.category,
            String(body?.subcategory ?? '').trim()
          );
          if (resolvedIds.category_id) base.category_id = resolvedIds.category_id;
          else if (categoryChanged) delete base.category_id;
          if (resolvedIds.subcategory_id) base.subcategory_id = resolvedIds.subcategory_id;
          else if (categoryChanged || String(body?.subcategory ?? '').trim()) {
            delete base.subcategory_id;
          }
        }
      }
      // sourceId del payload (ID externo: ASIN / Item ID de AliExpress) gana
      // sobre el heredado: los productos importados antes de persistirlo ya
      // no se pierden en el filtro «En catálogo ».
      const incomingSourceId = String(body?.sourceId ?? '').trim();
      if (incomingSourceId) base.sourceId = incomingSourceId;
      // Estado editorial: el enriquecimiento de texto completado marca ia_status.
      if (textStatus === 'ok' || textStatus === 'local') base.ia_status = 'completed';
      else if (textStatus === 'error') base.ia_status = 'error';
      if (base.affiliateUrl && !base.link_status) base.link_status = 'active';
      upsertProduct(base);
      saved = true;
      if (existing) warnings.push('Producto existente actualizado (upsert por id).');
      // Vinculación automática de alternativas (sólo si el producto no tiene
      // ninguna a mano); la respuesta lo informa para el aviso en el panel.
      const autoAlt = autoLinkAlternatives(base.id);
      if (autoAlt.ok && autoAlt.linked) {
        warnings.push(`${autoAlt.linked} alternativa(s) vinculada(s) automáticamente.`);
        const refreshed = readProductsFromFile().find((item) => item.id === base.id);
        if (refreshed) Object.assign(base, refreshed);
      }
    }

    const failed = options.text && options.image && textStatus === 'error' && imageStatus === 'error';
    if (failed) {
      return jsonResponse(
        {
          success: false,
          saved: false,
          message: 'Los dos pasos de IA fallaron; revisa las claves y los logs del servidor.',
          warnings,
          product: base,
          enrichment: { text: textStatus, image: imageStatus, warnings },
        },
        502
      );
    }

    return jsonResponse(
      {
        success: true,
        saved,
        message: saved
          ? 'Producto creado/actualizado con IA (texto + imagen).'
          : 'Vista previa generada con IA; revisa y guarda desde el formulario.',
        product: base,
        enrichment: { text: textStatus, image: imageStatus, warnings },
      },
      200
    );
  } catch (error: any) {
    console.error('[API admin/add-product] Error no controlado:', error);
    return jsonResponse(
      { success: false, message: error?.message || 'Error inesperado al procesar la solicitud' },
      500
    );
  }
};
