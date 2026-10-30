import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import {
  enrichProductText,
  enforceMoreProsThanCons,
  generateProductImage,
  hasTextCredentials,
  hasImageCredentials,
  overlayEnrichedText,
  mergeWithMinimum,
  textProvider,
  imageProvider,
  enrichConcurrency,
  type EnrichedText,
} from '../../../lib/ai';
import { enrichProductLocally, type LocalEnrichInput } from '../../../lib/localEnrich';
import {
  readProductsFromFile,
  upsertProduct,
  writeProductsToFile,
  slugify,
  type Product,
} from '../../../lib/productStore';
import {
  normalizeTagsForProducts,
  extractNormalizedTags,
  autoLinkAlternatives,
  roleIdsOf,
  computeBadge,
} from '../../../lib/curation';
import { toHiResImageUrl } from '../../../lib/imageQuality';
import { detectMerchantFromHost, defaultFulfillmentFor } from '../../../lib/merchant';

const DEFAULT_IMAGE =
  'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=800&auto=format&fit=crop';

const MIN_IMAGE_BYTES = 8_000; // umbral aproximado de imagen "útil" (sin el contenido exacto)

// ─── Helpers ──────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * Intenta descartar una imagen si es evidente que es muy pequeña o de baja
 * resolución. Devuelve true si la imagen se considera válida.
 * Estrategia (sin librerías de imagen):
 *  1) URLs locales (/images/…): comprueba que el archivo exista y supere
 *     MIN_IMAGE_BYTES.
 *  2) URLs remotas: hace HEAD/GET con rango pequeño y comprueba Content-Length
 *     si el servidor lo expone; si no se sabe, se asume válida.
 *  3) En caso de duda → se conserva (no descartar imágenes buenas).
 */
async function isImageUsable(url: string | null | undefined): Promise<boolean> {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;

  // Imagen local del volumen → comprobar tamaño en disco.
  if (trimmed.startsWith('/images/')) {
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      // IMAGES_DIR apunta al volumen en producción; en local a public/images.
      const { IMAGES_DIR } = await import('../../../lib/paths');
      const filePath = path.join(IMAGES_DIR, trimmed.replace(/^\/images\//, ''));
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        return stat.size >= MIN_IMAGE_BYTES;
      }
      // Si no existe en disco, conservar (puede servirse desde el build).
      return true;
    } catch {
      return true; // duda → conservar
    }
  }

  // Remota → HEAD rápido para leer Content-Length.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(trimmed, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { Range: 'bytes=0-0' },
    });
    clearTimeout(timer);
    if (!res.ok) return true; // duda → conservar
    const len = res.headers.get('content-length');
    if (len) {
      const bytes = Number(len);
      return Number.isFinite(bytes) ? bytes >= MIN_IMAGE_BYTES : true;
    }
    return true;
  } catch {
    return true; // duda → conservar
  }
}

/** Filtra la galería eliminando imágenes que no sean utilizables. */
async function filterGallery(gallery: string[] | undefined): Promise<string[]> {
  if (!Array.isArray(gallery) || !gallery.length) return [];
  const kept: string[] = [];
  for (const url of gallery) {
    if (await isImageUsable(url)) kept.push(url);
  }
  // Nunca dejar la galería vacía: si todo se descartó, conserva la original.
  return kept.length ? kept : gallery;
}

/** Enriquece un único producto con texto (IA o local) + título corto. */
async function enrichSingleText(
  product: Product,
  forceImage: boolean
): Promise<{ product: Product; textStatus: 'ok' | 'local' | 'skipped'; imageStatus: 'ok' | 'skipped' | 'error'; warnings: string[] }> {
  const warnings: string[] = [];
  let textStatus: 'ok' | 'local' | 'skipped' = 'skipped';
  let imageStatus: 'ok' | 'skipped' | 'error' = 'skipped';
  let enrichment: EnrichedText | null = null;

  const input: LocalEnrichInput = {
    title: product.title,
    description: product.description,
    sourceDescription: product.sourceDescription,
    category: product.category,
    brand: product.brand,
    merchant: product.merchant,
    price: product.price,
    originalPrice: product.originalPrice,
    rating: product.rating,
    reviewsCount: product.reviewsCount,
    url: product.affiliateUrl,
    specs: product.specs,
    pros: product.pros,
    cons: product.cons,
  };

  // Paso 1 — Texto.
  if (hasTextCredentials()) {
    try {
      const localEnrichment = enrichProductLocally(input);
      const ai = await enrichProductText({
        title: product.title,
        description: product.description,
        category: product.category,
        url: product.affiliateUrl,
        price: product.price,
        originalPrice: product.originalPrice,
        // Specs ya extraídas por el scraping: fuente de verdad para que la IA
        // no invente ficha técnica (paridad con /api/admin/add-product).
        specs: product.specs,
      });
      // Overlay: la IA mejora lo local, pero NO borra datos con campos vacíos
      // (mismo helper que /api/admin/add-product y "Construir Catálogo", para
      // mantener la paridad de verdad entre todos los caminos de enriquecimiento).
      enrichment = overlayEnrichedText(localEnrichment, ai);
      textStatus = 'ok';
    } catch (err: any) {
      textStatus = 'local';
      enrichment = enrichProductLocally(input);
      warnings.push(`IA de texto no disponible: ${err?.message ?? err}`);
    }
  } else {
    textStatus = 'local';
    enrichment = enrichProductLocally(input);
    warnings.push(`Ficha generada localmente (sin claves de IA de texto).`);
  }

  // Título sintetizado corto para las product-cards (siempre se calcula,
  // sea con IA o localmente).
  const titleShort =
    enrichment?.title?.trim()?.slice(0, 80) ||
    product.title.slice(0, 80);

  // Paso 2 — Imagen (solo si no hay imagen real o se pide forzar). Un
  // placeholder ('—' o la imagen de stock por defecto) cuenta como "sin
  // imagen": si no, un producto importado sin foto real se quedaba sin
  // imagen de IA para siempre.
  const currentImage = String(product.image || '').trim();
  const hasUsableImage = Boolean(currentImage) && currentImage !== '—' && currentImage !== DEFAULT_IMAGE;
  const needsImage = !hasUsableImage || forceImage;
  if (needsImage && hasImageCredentials()) {
    try {
      const result = await generateProductImage(enrichment?.title || product.title);
      product.image = result.url;
      imageStatus = 'ok';
    } catch (err: any) {
      imageStatus = 'error';
      warnings.push(`Fallo al generar imagen: ${err?.message ?? err}`);
    }
  } else if (needsImage && !hasImageCredentials()) {
    imageStatus = 'skipped';
    warnings.push('Imagen no generada: falta clave de IA de imagen.');
  }

  // Paso 3 — Filtrar galería (quitar imágenes bajas/pequeñas).
  const filteredGallery = await filterGallery(product.gallery);
  if (filteredGallery.length !== (product.gallery?.length ?? 0)) {
    product.gallery = filteredGallery.length ? filteredGallery : undefined;
  }

  // Composición final del producto. Pros: se exige un mínimo de 3 (ver
  // mergeWithMinimum), completando con los que ya tenía el producto si el
  // enriquecimiento se queda corto, en vez de descartarlos por completo
  // (antes: "todo o nada", lo que podía dejar sólo 1 pro y, tras forzar el
  // balance pros>cons, 0 contras). Contras: se respeta la respuesta no vacía
  // del enriquecimiento; si viene vacía, se usan los previos del producto.
  const enrichmentPros = Array.isArray(enrichment?.pros) ? enrichment.pros : [];
  const finalPros = mergeWithMinimum(enrichmentPros, product.pros ?? [], 3);
  const finalCons = Array.isArray(enrichment?.cons) && enrichment.cons.length ? enrichment.cons : (product.cons ?? []);
  const { pros: balancedPros, cons: balancedCons } = enforceMoreProsThanCons(finalPros, finalCons);
  const updated: Product = {
    ...product,
    id: product.id,
    title: enrichment?.title?.trim() || product.title,
    title_short: titleShort,
    description: enrichment?.description?.trim() || product.description,
    pros: balancedPros,
    cons: balancedCons,
    verdict: enrichment?.verdict || product.verdict,
    techSheet: enrichment?.techSheet?.trim() || product.techSheet,
    specs: enrichment?.specs && Object.keys(enrichment.specs).length
      ? { ...(product.specs ?? {}), ...enrichment.specs }
      : product.specs,
    // Categoría: si el producto NO tiene ninguna (importación de JSON con
    // keepUncategorized), el enriquecimiento NO la rellena — se asigna después
    // en masa desde el panel. Los productos ya categorizados conservan el
    // comportamiento anterior (la IA puede refinarla).
    category: product.category ? (enrichment?.category || product.category) : '',
    price: enrichment?.pricing?.price ?? product.price,
    originalPrice: enrichment?.pricing?.originalPrice ?? product.originalPrice,
    // Marca: sólo se rellena si faltaba (nunca sustituye una marca ya
    // curada/verificada por la "mejor suposición" de la IA).
    brand: product.brand || enrichment?.brand || undefined,
    // Comerciante/distribuidor: si por lo que sea faltan (productos antiguos,
    // altas manuales incompletas...) se deducen del propio enlace de
    // afiliado, igual que hace el alta manual («Analizar Enlace»). Nunca
    // sustituye un valor ya guardado.
    merchant: product.merchant || detectMerchantFromHost(product.affiliateUrl || product.buyNowUrl) || product.merchant,
    ia_status: textStatus === 'ok' || textStatus === 'local' ? 'completed' : product.ia_status,
    ai_enriched: textStatus === 'ok',
    // textStatus nunca llega 'skipped' aquí (sin claves se marca 'local' y se
    // avisa en `warnings`), así que se conserva el error previo del producto.
    ai_error: product.ai_error,
  };
  if (!updated.fulfillmentProvider && updated.merchant) {
    updated.fulfillmentProvider = defaultFulfillmentFor(updated.merchant);
  }
  // Etiqueta destacada: sólo se calcula si el producto no tiene ninguna ya
  // asignada (a mano o por «Construir Catálogo»); nunca se reemplaza una
  // badge elegida explícitamente por el admin.
  if (!updated.badge) {
    updated.badge = computeBadge(updated as Product & { hsrScore?: number });
  }

  return { product: updated, textStatus, imageStatus, warnings };
}

/** ─── Endpoint ─── */

export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, message: 'Cuerpo JSON inválido' }, 400);
  }

  const ids = Array.isArray(body?.ids) ? body.ids.map((v: unknown) => String(v || '').trim()).filter(Boolean) : [];
  const forceImage = Boolean(body?.forceImage);
  const dryRun = Boolean(body?.dryRun);

  const allProducts = readProductsFromFile();
  const targets = ids.length
    ? allProducts.filter((p) => ids.includes(p.id))
    : allProducts;

  if (!targets.length) {
    return jsonResponse({ success: false, message: 'No hay productos que enriquecer.' }, 400);
  }

  const resultsByIndex: Array<{ id: string; title: string; ok: boolean; textStatus: string; imageStatus: string; warnings: string[] }> = new Array(targets.length);
  let processed = 0;
  let failed = 0;

  // Concurrencia acotada por proveedor (ver TEXT_PROVIDER_CONCURRENCY en
  // lib/ai.ts): permite procesar varios productos EN PARALELO sin saturar al
  // proveedor de IA ni depender de que el llamante trocee la petición. Cada
  // `upsertProduct`/lectura de products.json es síncrona (fs.*Sync, sin
  // await de por medio), así que Node la ejecuta de un tirón: dos workers no
  // pueden entrelazar su lectura+escritura y perderse cambios entre sí.
  const concurrency = Math.max(1, Math.min(enrichConcurrency(), targets.length));
  let cursor = 0;
  async function processOne(index: number): Promise<void> {
    const product = targets[index];
    try {
      const { product: updated, textStatus, imageStatus, warnings } = await enrichSingleText(product, forceImage);

      // Normalizar tags técnicos.
      updated.normalized_tags = extractNormalizedTags(updated);

      // IMPORTANTE: se guarda el enriquecimiento ANTES de auto-vincular
      // alternativas. autoLinkAlternatives relee products.json desde disco; si
      // se llamaba antes de upsertProduct, esa relectura devolvía el producto
      // tal cual estaba ANTES de enriquecerlo, y el Object.assign(updated,
      // fresh) posterior sobrescribía título/descripción/pros/contras recién
      // generados con los valores viejos justo antes de guardar (bug real:
      // el enriquecimiento "se perdía" en productos que entraban en el
      // auto-link, que es el caso más común en un enriquecimiento masivo).
      if (!dryRun) {
        upsertProduct(updated);

        // Auto-vincular alternativas (económicas + competidor directo) si no las tiene.
        const stored = roleIdsOf(updated);
        const hasLinks = Array.isArray(updated.alternative_product_ids) && updated.alternative_product_ids.length > 0;
        const hasRoles = Boolean(stored.premium.length || stored.cheaper.length || stored.similar.length);
        if (!hasLinks || !hasRoles) {
          const ensured = autoLinkAlternatives(updated.id);
          if (ensured.ok) {
            // El archivo ya tiene el enriquecimiento guardado arriba, así que
            // esta relectura sólo aporta los campos de alternativas/roles.
            const fresh = readProductsFromFile().find((p) => p.id === updated.id);
            if (fresh) Object.assign(updated, fresh);
          }
        }
      }

      resultsByIndex[index] = { id: updated.id, title: updated.title, ok: true, textStatus, imageStatus, warnings };
      processed += 1;
    } catch (err: any) {
      failed += 1;
      resultsByIndex[index] = { id: product.id, title: product.title, ok: false, textStatus: 'error', imageStatus: 'error', warnings: [err?.message ?? String(err)] };
    }
  }
  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const index = cursor++;
      await processOne(index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const results = resultsByIndex;

  // Si se pidió normalización de tags en lote (ya se hizo por producto arriba),
  // persistir de forma explícita (upsertProduct ya escribe).

  return jsonResponse({
    success: true,
    dryRun,
    total: targets.length,
    processed,
    failed,
    concurrency,
    results,
    message: dryRun
      ? `Simulación: ${processed} producto(s) se enriquecerían (${failed} con error).`
      : `Enriquecido ${processed} producto(s)${failed ? ` · ${failed} con error` : ''}.`,
  }, 200);
};
