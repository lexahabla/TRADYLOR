import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { suggestCategory } from '../../../lib/categories';
import {
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
          });
          // Overlay: la IA mejora lo local, pero no borra datos que ya había.
          enrichment = {
            ...localEnrichment,
            ...aiEnrichment,
            specs: { ...(localEnrichment.specs ?? {}), ...(aiEnrichment.specs ?? {}) },
            pros: aiEnrichment.pros?.length ? aiEnrichment.pros : localEnrichment.pros,
            cons: aiEnrichment.cons?.length ? aiEnrichment.cons : localEnrichment.cons,
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
    // ------------------------------------------------------------------
    if (options.image) {
      if (!hasImageCredentials()) {
        imageStatus = 'skipped';
        warnings.push(
          `Imagen no generada: falta la clave de ${imageProvider() === 'flux' ? 'Flux (FLUX_API_KEY)' : 'OpenAI (OPENAI_API_KEY)'}.`
        );
      } else {
        try {
          const result = await generateProductImage(title);
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
    const base: Product = {
      id: String(body?.id ?? '').trim() || slugify(title),
      title,
      description: String(body?.description ?? '').trim(),
      price: Number(body?.price) || 0,
      originalPrice: body?.originalPrice ? Number(body.originalPrice) : undefined,
      image:
        generatedImageUrl ||
        String(body?.image ?? '').trim() ||
        DEFAULT_IMAGE,
      category: String(body?.category ?? '').trim(),
      merchant: detectMerchant(body?.affiliateUrl || body?.url, body?.merchant),
      affiliateUrl: String(body?.affiliateUrl ?? body?.url ?? '').trim(),
      buyNowUrl: body?.buyNowUrl ? String(body.buyNowUrl).trim() : undefined,
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
      if (!base.description) base.description = enrichment.description;
      if (enrichment.pros.length) base.pros = enrichment.pros;
      if (enrichment.cons.length) base.cons = enrichment.cons;
      if (enrichment.verdict) base.verdict = enrichment.verdict;
      if (enrichment.specs && Object.keys(enrichment.specs).length) {
        base.specs = { ...(base.specs ?? {}), ...enrichment.specs };
      }
      if (!base.category && enrichment.category) base.category = enrichment.category;
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
