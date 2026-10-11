import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { suggestCategory } from '../../../lib/categories';
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
import { readProductsFromFile, slugify, upsertProduct, type Product } from '../../../lib/productStore';
import { extractAsinFromUrl } from '../../../utils/amazon';

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

    const warnings: string[] = [];
    let textStatus: 'ok' | 'local' | 'skipped' | 'error' = 'skipped';
    let imageStatus: 'ok' | 'skipped' | 'error' = 'skipped';
    let enrichment: EnrichedText | null = null;
    let generatedImageUrl: string | null = null;

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
      buyNowUrl: body?.buyNowUrl ? String(body.buyNowUrl).trim() : undefined,
      asin: (() => {
        const fromBody = String(body?.asin ?? '').trim().toUpperCase();
        if (/^[A-Z0-9]{10}$/.test(fromBody)) return fromBody;
        return extractAsinFromUrl(String(body?.affiliateUrl ?? body?.url ?? '')) || undefined;
      })(),
      pros: [],
      cons: [],
      badge: body?.badge ? String(body.badge).trim() : undefined,
      rating: body?.rating ? Number(body.rating) : 4.8,
      reviewsCount: body?.reviewsCount ? Number(body.reviewsCount) : 100,
      specs: body?.specs && typeof body.specs === 'object' ? body.specs : undefined,
      fulfillmentProvider: body?.fulfillmentProvider
        ? String(body.fulfillmentProvider).trim()
        : undefined,
    };

    if (enrichment) {
      // La descripción SIEMPRE se mejora con la del enriquecimiento (IA o
      // local): el botón "Enriquecer con IA" reescribe la redacción técnica.
      if (enrichment.description?.trim()) base.description = enrichment.description;
      if (enrichment.pros.length) base.pros = enrichment.pros;
      if (enrichment.cons.length) base.cons = enrichment.cons;
      if (enrichment.verdict) base.verdict = enrichment.verdict;
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
      const exists = readProductsFromFile().some((item) => item.id === base.id);
      upsertProduct(base);
      saved = true;
      if (exists) warnings.push('Producto existente actualizado (upsert por id).');
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
