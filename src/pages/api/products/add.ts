import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { getCategories, suggestCategory, resolveCategoryIds } from '../../../lib/categories';
import {
  readProductsFromFile,
  writeProductsToFile,
  slugify,
  findDuplicateProduct,
  normalizeProductKey,
  type Product,
} from '../../../lib/productStore';
import { addDeletedId, removeDeletedId } from '../../../lib/deletedProducts';
import { enrichProductsForAdmin, autoLinkAlternatives, computeBadge } from '../../../lib/curation';
import { extractProductPageFields, hasTextCredentials, type ProductPageAiFields } from '../../../lib/ai';

export const prerender = false;

// El modelo de producto vive en src/lib/productStore.ts (compartido con
// /api/admin/add-product). Se re-exporta el tipo para no romper imports previos.
export type { Product };

/**
 * Decodifica entidades HTML básicas (e.g. &amp;, &quot;, &#39;, etc.)
 */
function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  const decoded = str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&euro;/g, '€')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();

  // Algunas respuestas de Amazon llegan con UTF-8 interpretado como Latin-1.
  if (/[ÃÂ]/.test(decoded)) {
    try {
      return Buffer.from(decoded, 'latin1').toString('utf8').trim();
    } catch {
      return decoded;
    }
  }

  return decoded;
}

/**
 * Deduce el nombre del comercio a partir de la URL del producto.
 */
function detectMerchantFromUrl(urlStr: string): string {
  try {
    const { hostname } = new URL(urlStr);
    const host = hostname.toLowerCase();

    // Amazon y sus enlaces cortos de afiliado (amzn.to, a.co, amzn.eu...).
    if (host.includes('amazon.') || host === 'amzn.to' || host === 'a.co' || host === 'amzn.eu' || host === 'amzn.asia') return 'Amazon';
    if (host.includes('pccomponentes.')) return 'PcComponentes';
    if (host.includes('elcorteingles.')) return 'El Corte Inglés';
    if (host.includes('mediamarkt.')) return 'MediaMarkt';
    if (host.includes('aliexpress.')) return 'AliExpress';
    if (host.includes('fnac.')) return 'Fnac';
    if (host.includes('carrefour.')) return 'Carrefour';
    if (host.includes('apple.')) return 'Apple';

    // Extracción limpia del dominio
    const parts = host.replace(/^www\./, '').split('.');
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  } catch {
    return 'Comercio Externo';
  }
}

/**
 * Limpia sufijos publicitarios típicos en títulos (ej: " | Amazon.es", " - PcComponentes").
 */
function cleanTitle(title: string, merchant: string): string {
  let cleaned = title.replace(/\s*[\-\|:]\s*(Amazon\.es|PcComponentes|El Corte Inglés|MediaMarkt|Fnac|AliExpress).*$/i, '');
  cleaned = cleaned.replace(/^Amazon\.es\s*:\s*/i, '');
  return cleaned.trim();
}

function parsePrice(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[^\d,.\-]/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanExtractedText(value: unknown): string {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extrae metadatos OpenGraph, Twitter Cards, Schema.org y etiquetas meta estándar del HTML.
 */
export function extractMetadata(html: string, targetUrl: string) {
  const merchant = detectMerchantFromUrl(targetUrl);

  // Helper para buscar meta tags con atributos en cualquier orden
  const findMetaContent = (...namesOrProperties: string[]): string => {
    for (const prop of namesOrProperties) {
      // Formato: <meta property="og:title" content="..." /> o <meta content="..." property="og:title" />
      const regex1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
      const match1 = html.match(regex1);
      if (match1 && match1[1]) return decodeHtmlEntities(match1[1]);

      const regex2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
      const match2 = html.match(regex2);
      if (match2 && match2[1]) return decodeHtmlEntities(match2[1]);
    }
    return '';
  };

  // 1. TÍTULO
  let title = findMetaContent('og:title', 'twitter:title');
  if (!title) {
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      title = decodeHtmlEntities(titleMatch[1]);
    }
  }
  if (merchant === 'Amazon') {
    const amazonProductTitle = html.match(/id=["']productTitle["'][^>]*>([\s\S]*?)<\//i);
    if (amazonProductTitle?.[1]) title = cleanExtractedText(decodeHtmlEntities(amazonProductTitle[1]));
  }
  if (title) {
    title = cleanTitle(title, merchant);
  }

  // 2. IMAGEN
  let image = findMetaContent('og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src');
  // Galería: colección de imágenes del producto (se deduplica y limpia al final).
  const gallerySet = new Set<string>();
  const addGallery = (url?: string | null) => {
    if (!url || typeof url !== 'string') return;
    let u = decodeHtmlEntities(url).trim();
    if (!/^https?:\/\//i.test(u)) return;
    // Omite miniaturas de tracking/1x1 y logos de reseñas.
    if (/sprite|icon|logo|spacer|blank|pixel|transparent|1x1/i.test(u)) return;
    gallerySet.add(u);
  };
  addGallery(image);
  
  // 3. DESCRIPCIÓN
  let description = findMetaContent('og:description', 'twitter:description', 'description');

  // 4. PRECIO (Detección por Schema.org JSON-LD o meta tags de producto)
  let price: number | null = null;
  let originalPrice: number | null = null;
  let brand = '';
  let rating: number | null = null;
  let reviewsCount: number | null = null;
  const pros: string[] = [];
  const cons: string[] = [];
  // Specs recogidas del JSON-LD (additionalProperty): la base sobre la que las
  // tablas HTML del comercio añaden más pares clave/valor más adelante.
  const schemaSpecs: Record<string, string> = {};
  const addSchemaSpec = (key: unknown, value: unknown) => {
    const k = cleanExtractedText(String(key ?? '').replace(/<[^>]+>/g, ' '));
    const v = cleanExtractedText(String(value ?? '').replace(/<[^>]+>/g, ' '));
    if (k && v && v.length <= 160 && k.length <= 60 && v.toLowerCase() !== k.toLowerCase() && !schemaSpecs[k]) {
      schemaSpecs[k] = v;
    }
  };
  const rawPriceMeta = findMetaContent('product:price:amount', 'og:price:amount', 'price');
  if (rawPriceMeta) {
    price = parsePrice(rawPriceMeta);
  }
  originalPrice = parsePrice(findMetaContent('product:price:original', 'product:original_price', 'og:price:standard'));

  // Bloques JSON-LD Schema.org: se recorren SIEMPRE (no sólo cuando falta el
  // precio). Casi todas las tiendas publican el precio en meta tags Y los datos
  // ricos (marca, valoración, opiniones, galería, specs) en el JSON-LD: antes,
  // si había meta-precio, todo el schema se ignoraba y esos campos quedaban
  // vacíos en el formulario.
  const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatches) {
    for (const block of jsonLdMatches) {
      try {
        const content = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
        const parsedJson = JSON.parse(content);

        const searchSchemaForPrice = (obj: any): number | null => {
          if (!obj || typeof obj !== 'object') return null;
          if (!brand && obj.brand) brand = cleanExtractedText(typeof obj.brand === 'object' ? obj.brand.name : obj.brand);
          const agg = obj.aggregateRating;
          if (agg && typeof agg === 'object') {
            if (rating == null && agg.ratingValue != null) {
              const parsedRating = parsePrice(String(agg.ratingValue).replace(/\/\s*5\s*$/i, ''));
              if (parsedRating != null && parsedRating > 5 && parsedRating <= 100) {
                // Algunas tiendas publican la valoración como porcentaje (0-100).
                rating = Math.round((parsedRating / 20) * 10) / 10;
              } else if (parsedRating != null && parsedRating <= 5) {
                rating = parsedRating;
              }
            }
            if (reviewsCount == null) {
              const countRaw = agg.reviewCount ?? agg.ratingCount ?? agg.userCount ?? agg.ratingCount;
              const parsedCount = parsePrice(String(countRaw ?? ''));
              if (parsedCount != null) reviewsCount = parsedCount;
            }
          }
          if (!image && obj.image) {
            const schemaImg = Array.isArray(obj.image) ? obj.image[0] : obj.image;
            image = typeof schemaImg === 'string' ? schemaImg : schemaImg?.url || '';
          }
          // Galería: recolecta todas las imágenes del schema (si hay varias).
          if (Array.isArray(obj.image)) {
            for (const img of obj.image) {
              addGallery(typeof img === 'string' ? img : img?.url);
            }
          } else if (typeof obj.image === 'string') {
            addGallery(obj.image);
          }
          if (!description && obj.description) description = cleanExtractedText(obj.description);
          // Especificaciones: additionalProperty / additionalType del schema.
          if (Array.isArray(obj.additionalProperty)) {
            for (const prop of obj.additionalProperty) {
              if (prop && typeof prop === 'object') addSchemaSpec(prop.name, prop.value);
            }
          }
          if (obj.color) addSchemaSpec('Color', obj.color);
          if (obj.material) addSchemaSpec('Material', obj.material);
          if (obj.model) addSchemaSpec('Modelo', obj.model);
          if (obj.mpn) addSchemaSpec('MPN', obj.mpn);
          if (obj.offers) {
            const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
            const offerPrice = parsePrice(offer?.price ?? offer?.lowPrice);
            const offerHighPrice = parsePrice(offer?.highPrice ?? offer?.priceSpecification?.maxPrice);
            if (offerHighPrice !== null && (price === null || offerHighPrice > price)) originalPrice = offerHighPrice;
            if (offerPrice !== null && price === null) return offerPrice;
          }
          const objectPrice = parsePrice(obj.price);
          if (objectPrice !== null && price === null) return objectPrice;
          for (const value of Object.values(obj)) {
            const nestedPrice = searchSchemaForPrice(value);
            if (nestedPrice !== null) return nestedPrice;
          }
          return null;
        };

        const schemaPrice = Array.isArray(parsedJson)
          ? parsedJson.map(searchSchemaForPrice).find((p) => p !== null)
          : searchSchemaForPrice(parsedJson);

        if (price === null && schemaPrice != null) {
          price = schemaPrice;
        }
      } catch {
        // JSON-LD malformado en página externa, ignorar de forma segura
      }
    }
  }

  // Respaldo de precio para patrones habituales de tiendas online si aún no se detectó
  if (price === null) {
    // Amazon a-price-whole
    const amazonPriceMatch = html.match(/class=["']a-price-whole["'][^>]*>([^<]+)<\/span>(?:<span class=["']a-price-fraction["'][^>]*>([^<]+)<\/span>)?/i);
    if (amazonPriceMatch) {
      const whole = amazonPriceMatch[1].replace(/[^\d]/g, '');
      const fraction = amazonPriceMatch[2] ? amazonPriceMatch[2].replace(/[^\d]/g, '') : '00';
      price = parsePrice(`${whole}.${fraction}`);
    }
  }

  // Amazon no siempre publica JSON-LD: marca, valoración y reseñas se leen del HTML.
  if (merchant === 'Amazon') {
    // Marca: #bylineInfo ("Visita la tienda de X" / "Marca: X" / "X Official Store").
    if (!brand) {
      const bylineMatch = html.match(/id=["']bylineInfo["'][^>]*>([\s\S]*?)<\/a>/i);
      if (bylineMatch?.[1]) {
        const raw = cleanExtractedText(bylineMatch[1].replace(/<[^>]+>/g, ' '));
        brand = raw
          .replace(/^(visita la tienda de|marca\s*:?\s*|tienda oficial de|official store)\s*/i, '')
          .replace(/\s*(en amazon\.es|on amazon)\s*$/i, '')
          .trim();
      }
    }
    // Valoración: texto de .a-icon-alt ("5,0 de 5 estrellas").
    if (rating === null) {
      const ratingMatch = html.match(/class=["'][^"']*a-icon-alt[^"']*["'][^>]*>\s*([\d.,]+)\s*de\s*5/i);
      if (ratingMatch?.[1]) rating = parsePrice(ratingMatch[1]);
    }
    // Nº de reseñas: #acrCustomerReviewText ("(7)", "7 valoraciones", "1.234 opiniones").
    if (reviewsCount === null) {
      const reviewsMatch = html.match(/id=["']acrCustomerReviewText["'][^>]*>([\s\S]*?)<\//i);
      if (reviewsMatch?.[1]) {
        const digits = reviewsMatch[1].replace(/<[^>]+>/g, '').replace(/[^\d]/g, '');
        if (digits) reviewsCount = Number.parseInt(digits, 10);
      }
    }
  }

  // Fallbacks genéricos de valoración y opiniones para el resto de comercios
  // (PcComponentes, MediaMarkt, El Corte Inglés, Fnac, AliExpress…): datos
  // embebidos en JSON, atributos data-rating y textos «N opiniones».
  if (rating === null) {
    const genericRatingMatch =
      html.match(/"ratingValue"\s*:\s*"?\s*([\d.,]+)\s*"?/i) ||
      html.match(/itemprop=["']ratingValue["'][^>]*content=["']([\d.,]+)["']/i) ||
      html.match(/data-rating=["']\s*([\d.,]+)\s*["']/i) ||
      html.match(/"rating"\s*:\s*"?\s*([\d.,]+)\s*"?/i) ||
      html.match(/([\d.,]+)\s*\/\s*5\s*(?:estrellas|★|stars)/i) ||
      html.match(/(?:valoraci[oó]n|rating)[^0-9<]{0,50}([\d.,]+)\s*(?:de|\/)\s*5/i);
    if (genericRatingMatch?.[1]) {
      const parsed = parsePrice(genericRatingMatch[1]);
      if (parsed != null && parsed > 5 && parsed <= 100) rating = Math.round((parsed / 20) * 10) / 10;
      else if (parsed != null && parsed <= 5) rating = parsed;
    }
  }
  if (reviewsCount === null) {
    const genericReviewsMatch =
      html.match(/"reviewCount"\s*:\s*"?\s*([\d.,\s]+)\s*"?/i) ||
      html.match(/"ratingCount"\s*:\s*"?\s*([\d.,\s]+)\s*"?/i) ||
      html.match(/"totalReview"\s*:\s*"?\s*([\d.,\s]+)\s*"?/i) ||
      html.match(/(\d[\d.,\s]*)\s*(?:opiniones|valoraciones|rese[nñ]as|reviews)/i);
    if (genericReviewsMatch?.[1]) {
      const digits = genericReviewsMatch[1].replace(/[^\d]/g, '');
      if (digits) reviewsCount = Number.parseInt(digits, 10);
    }
  }

  // Fallbacks específicos para la plantilla dinámica de Amazon.
  // IMPORTANTE: la recolección de la galería se hace SIEMPRE, no solo cuando
  // falta `og:image`. En Amazon casi siempre hay og:image, así que antes la
  // galería de `colorImages` nunca se leía y el análisis dejaba una sola foto.
  const dynamicImageMatch = html.match(/id=["']landingImage["'][^>]+data-a-dynamic-image=["']([^"']+)["']/i);
  if (dynamicImageMatch?.[1]) {
    try {
      const imageMap = JSON.parse(decodeHtmlEntities(dynamicImageMatch[1])) as Record<string, number[]>;
      const largestImage = Object.entries(imageMap).sort(([, firstSize], [, secondSize]) =>
        (secondSize[0] * secondSize[1]) - (firstSize[0] * firstSize[1])
      )[0];
      if (largestImage?.[0]) image = image || largestImage[0];
      // La galería se lleva las URLs de mayor resolución de cada imagen.
      for (const [url, size] of Object.entries(imageMap)) {
        if (Array.isArray(size) && size[0] >= 500) addGallery(url);
      }
    } catch {        // Amazon puede entregar el atributo incompleto; se usa el fallback siguiente.
    }
  }

  if (!image) {
    const amazonImageMatch = html.match(/data-old-hires=["']([^"']+)["']/i);
    if (amazonImageMatch?.[1]) image = decodeHtmlEntities(amazonImageMatch[1]);
  }

  // Vistas distintas del producto: Amazon las guarda en ImageBlockAtlas/colorImages
  // (cada objeto tiene "large"/"initial" con una foto diferente: frente, dorso, laterales…).
  const colorImagesMatch = html.match(/"colorImages"\s*:\s*\[([\s\S]*?)\]\s*(?:,|\})/i);
  if (colorImagesMatch?.[1]) {
    const largeUrls = colorImagesMatch[1].match(/"large"\s*:\s*"([^"]+)"/gi) || [];
    for (const raw of largeUrls) {
      const urlMatch = raw.match(/"large"\s*:\s*"([^"]+)"/i);
      if (urlMatch?.[1]) addGallery(urlMatch[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/'));
    }
  }

  if (image && !/^https?:\/\//i.test(image)) image = '';

  // Galería genérica: recoge TODAS las imágenes grandes del HTML (también en
  // comercios que no publican JSON-LD, como MediaMarkt, PcComponentes, Fnac…).
  // Se prefieren los atributos de alta resolución (data-zoom-image, data-original,
  // data-src, srcset) y se descartan logos, iconos, avatares y miniaturas.
  // Sólo se aplica si aún no hay una galería decente (Amazon ya trae `colorImages`).
  const imgSkipRe = /logo|icon|sprite|pixel|transparent|placeholder|avatar|badge|payment|flag|banner|tracking|1x1|spacer|blank|emoji|favicon|loading|sprite|\bthumb|\bmini\b|miniatura|small|\bcrop\b|avatar|_100x100|100x100|s150|s300|x150|x300|star-rating|related|recommend|also|suggest/i;
  const htmlGalleryUrls: string[] = [];
  const htmlGallerySeen = new Set<string>();
  const pushHtmlGallery = (raw?: string | null) => {
    if (!raw) return;
    const u = decodeHtmlEntities(raw).trim();
    if (!/^https?:\/\//i.test(u)) return;
    if (imgSkipRe.test(u)) return;
    if (htmlGallerySeen.has(u)) return;
    htmlGallerySeen.add(u);
    htmlGalleryUrls.push(u);
  };
  if (gallerySet.size < 6) {
    const imgTagRe = /<img\b[^>]*>/gi;
    let imgTagMatch: RegExpExecArray | null;
    while ((imgTagMatch = imgTagRe.exec(html)) !== null) {
      const tag = imgTagMatch[0];
      const attr = (name: string): string => {
        const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
        return m ? m[1] : '';
      };
      // Descarta por tamaño declarado: las miniaturas de navegación ensucian la galería.
      const width = parseInt(attr('width').replace(/\D/g, ''), 10);
      const height = parseInt(attr('height').replace(/\D/g, ''), 10);
      if (Number.isFinite(width) && width > 0 && width < 120) continue;
      if (Number.isFinite(height) && height > 0 && height < 120) continue;

      const zoom = attr('data-zoom-image');
      const original = attr('data-original');
      const lazy = attr('data-lazy-src');
      const src = attr('data-src') || attr('data-image') || attr('src');
      const srcset = attr('srcset') || attr('data-srcset');

      // srcset: se queda con la URL de mayor ancho declarado.
      let bestSrcset = '';
      if (srcset) {
        let bestWidth = -1;
        for (const part of srcset.split(',')) {
          const [url, descriptor] = part.trim().split(/\s+/);
          const w = descriptor ? parseInt(descriptor.replace(/\D/g, ''), 10) : 0;
          if (url && Number.isFinite(w) && w >= bestWidth) {
            bestSrcset = url;
            bestWidth = w;
          } else if (url && !descriptor && !bestSrcset) {
            bestSrcset = url;
          }
        }
      }

      // Orden de prioridad: zoom > original > lazy > srcset > src.
      for (const candidate of [zoom, original, lazy, bestSrcset, src]) pushHtmlGallery(candidate);
    }

    // <link rel="preload" as="image">: la imagen principal que el navegador
    // prioriza (habitual en SPAs como MediaMarkt o El Corte Inglés).
    const preloadRe = /<link\b[^>]*rel=["']preload["'][^>]*as=["']image["'][^>]*>/gi;
    let preloadMatch: RegExpExecArray | null;
    while ((preloadMatch = preloadRe.exec(html)) !== null) {
      const hrefMatch = preloadMatch[0].match(/\bhref=["']([^"']+)["']/i);
      if (hrefMatch?.[1]) pushHtmlGallery(hrefMatch[1]);
    }

    // Imágenes embebidas en JSON/JS (SPAs y catálogos que guardan la galería en
    // un estado de página): se exigen indicios de tamaño grande para no llenar
    // la galería de iconos y avatares.
    const embeddedRe = /https?:\\?\/\\?\/[^"'\\\s)\]]+\.(?:jpe?g|png|webp)(?:\?[^"'\\\s)\]]*)?/gi;
    let embeddedMatch: RegExpExecArray | null;
    let embeddedCount = 0;
    while ((embeddedMatch = embeddedRe.exec(html)) !== null && embeddedCount < 60) {
      const u = embeddedMatch[0].replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
      if (!/(\d{3,4}\s?[xX×]\s?\d{3,4}|_AC_|_SX\d+|_SL\d+|highres|hi_?res|1000|1200|1500|2000|zoom|full|original|grande|large)/i.test(u)) continue;
      embeddedCount++;
      pushHtmlGallery(u);
    }

    for (const url of htmlGalleryUrls) addGallery(url);
  }

  if (price === null) {
    const amazonOffscreenPrice = html.match(/<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>\s*([\d.,]+)\s*€?/i);
    if (amazonOffscreenPrice?.[1]) price = parsePrice(amazonOffscreenPrice[1]);
  }

  // Precio embebido en JSON/JS (SPAs sin JSON-LD): sólo se acepta si el valor
  // aparece junto a un indicador de moneda (priceCurrency, EUR, €) para no
  // confundirlo con otros importes de la página (gastos de envío, banners…).
  if (price === null) {
    const embeddedPriceRe = /"?\b(?:price|salePrice|currentPrice|finalPrice|target_sale_price|offerPrice)\b"?\s*:\s*"?(\d+(?:[.,]\d{1,2})?)"?(?=[\s\S]{0,250}?(?:priceCurrency|EUR|€)|[\s\S]{0,120}?"(?:priceCurrency|currency)"\s*:\s*"EUR")/i;
    const embeddedPriceMatch = html.match(embeddedPriceRe);
    if (embeddedPriceMatch?.[1]) price = parsePrice(embeddedPriceMatch[1]);
    if (price === null) {
      const loosePriceMatch = html.match(/"priceCurrency"\s*:\s*"EUR"[\s\S]{0,200}?"price"\s*:\s*"?(\d+(?:[.,]\d{1,2})?)"?/i);
      if (loosePriceMatch?.[1]) price = parsePrice(loosePriceMatch[1]);
    }
  }
  if (originalPrice === null && price !== null) {
    const embeddedOriginalRe = /"?\b(?:originalPrice|listPrice|priceOriginal|compareAtPrice|target_original_price)\b"?\s*:\s*"?(\d+(?:[.,]\d{1,2})?)"?/i;
    const embeddedOriginalMatch = html.match(embeddedOriginalRe);
    if (embeddedOriginalMatch?.[1]) originalPrice = parsePrice(embeddedOriginalMatch[1]);
  }

  if (!description) {
    const amazonDescriptionMatch = html.match(/<(?:div|span)[^>]+(?:id|class)=["'][^"']*(?:productDescription|feature-bullets|productFactsDesktop)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i);
    if (amazonDescriptionMatch?.[1]) description = cleanExtractedText(amazonDescriptionMatch[1]);
  }

  if (!image) {
    const asinMatch = targetUrl.match(/(?:\/dp\/|\/gp\/product\/|[?&]asin=)([A-Z0-9]{10})/i);
    if (asinMatch?.[1] && merchant === 'Amazon') {
      image = `https://images-na.ssl-images-amazon.com/images/P/${asinMatch[1].toUpperCase()}.01.LZZZZZZZ.jpg`;
    }
  }

  if (!description && title) {
    description = `Información y características principales de ${title}.`;
  }

  // Amazon publica las prestaciones de dos formas: un <ul id="feature-bullets">
  // (cuando se sirve completo) o la tabla "Lo esencial" (#productOverview_feature_div).
  // El resto de elementos "a-list-item" suelen ser navegación o textos legales de
  // relleno, así que NO se usan como respaldo para evitar pros basura.
  const boilerplateRe = /^(dispositivos internos|los productos internacionales|es posible que la garant|se vende|sold by|country of origin|información del producto|acerca de este artículo|imagen no disponible|¿?quieres reciclar|obtén más información)/i;
  const cleanBullet = (raw: string): string => {
    const text = cleanExtractedText(raw.replace(/<[^>]+>/g, ' ')).trim();
    if (text.length < 4 || text.length > 220) return '';
    if (boilerplateRe.test(text)) return '';
    return text;
  };

  // 1ª fuente: el bloque feature-bullets de Amazon. El <div> puede venir vacío
  // (lo carga JavaScript), así que sólo se extrae si hay un <ul> real justo después.
  const fbIdx = html.search(/id=["']feature-bullets["']/i);
  if (fbIdx !== -1) {
    const ulStart = html.indexOf('<ul', fbIdx);
    const nextDiv = html.indexOf('<div', fbIdx + 10);
    // El <ul> debe estar antes del siguiente <div> hermano y razonablemente cerca.
    if (ulStart !== -1 && (nextDiv === -1 || ulStart < nextDiv) && ulStart - fbIdx < 3000) {
      const ulEnd = html.indexOf('</ul>', ulStart);
      if (ulEnd !== -1 && ulEnd - ulStart < 15000) {
        const items = html.slice(ulStart, ulEnd).match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
        for (const item of items) {
          const bullet = cleanBullet(item);
          if (bullet && !pros.includes(bullet)) pros.push(bullet);
        }
      }
    }
  }

  // 2ª fuente: la tabla "Lo esencial" (#productOverview_feature_div). Cada <tr>
  // es un par etiqueta/valor (<span class="a-text-bold"> / <span class="po-break-word">).
  // Se acota por índices a la primera <table> tras el div para no capturar la navegación.
  if (pros.length === 0) {
    const overviewIdx = html.search(/id=["']productOverview_feature_div["']/i);
    if (overviewIdx !== -1) {
      const tableStart = html.indexOf('<table', overviewIdx);
      const tableEnd = tableStart !== -1 ? html.indexOf('</table>', tableStart) : -1;
      if (tableStart !== -1 && tableEnd > tableStart && tableEnd - tableStart < 20000) {
        const tableHtml = html.slice(tableStart, tableEnd);
        const rows = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
        for (const row of rows) {
          const labelMatch = row.match(/<span[^>]+a-text-bold[^>]*>([\s\S]*?)<\/span>/i);
          const valueMatch = row.match(/<span[^>]+po-break-word[^>]*>([\s\S]*?)<\/span>/i);
          const label = labelMatch ? cleanExtractedText(labelMatch[1].replace(/<[^>]+>/g, ' ')).trim() : '';
          const value = valueMatch ? cleanExtractedText(valueMatch[1].replace(/<[^>]+>/g, ' ')).trim() : '';
          const bullet = cleanBullet(value ? `${label}: ${value}` : label);
          if (bullet && !pros.includes(bullet)) pros.push(bullet);
        }
      }
    }
  }

  if (originalPrice === null) {
    originalPrice = parsePrice(findMetaContent('product:price:original', 'price:was', 'og:price:original'));
  }

  // Asegurar que la URL de la imagen sea absoluta
  if (image && !image.startsWith('http://') && !image.startsWith('https://')) {
    try {
      image = new URL(image, targetUrl).href;
    } catch {
      image = '';
    }
  }

  // Deducir categoría inicial sugerida: primero por keywords del catálogo real,
  // y si no hay coincidencia, por el heurístico histórico de palabras clave.
  const lowerTitle = (title + ' ' + description).toLowerCase();
  const keywordSuggestion = suggestCategory(lowerTitle);
  let suggestedCategory = keywordSuggestion?.category.name ?? '';
  if (!suggestedCategory) {
    suggestedCategory = 'Tecnología';
    if (/auricular|sonido|noise cancelling|altavoz|headphone|audio/i.test(lowerTitle)) {
      suggestedCategory = 'Audio & Sonido';
    } else if (/portátil|laptop|macbook|ordenador|procesador|ram|ssd/i.test(lowerTitle)) {
      suggestedCategory = 'Informática & Laptops';
    } else if (/kindle|e-reader|libro digital|ereader|tinta electrónica/i.test(lowerTitle)) {
      suggestedCategory = 'Lectura Digital';
    } else if (/aspirador|robot|fregasuelos|hogar|freidora|cafetera/i.test(lowerTitle)) {
      suggestedCategory = 'Hogar Inteligente';
    } else if (/cámara|objetivo|trípode|fotografía|gopro/i.test(lowerTitle)) {
      suggestedCategory = 'Fotografía & Vídeo';
    }
  }

  // ── ESPECIFICACIONES (specs clave/valor) ────────────────────────────────
  // 1ª fuente: meta de marca (comercios que no publican JSON-LD).
  if (!brand) {
    const brandMeta = findMetaContent('brand', 'product:brand', 'twitter:data1');
    if (brandMeta) brand = cleanExtractedText(brandMeta);
  }

  // ── ESTADO DEL PRODUCTO (Nuevo/Usado/Reacondicionado) ───────────────────
  // Dato clave para poder filtrar después los artículos de segunda mano.
  // eBay lo publica en <div class="x-item-condition-text"><span
  // class="clipped">Usado</span></div>; se añade un fallback genérico
  // (microdato itemCondition / JSON embebido / etiqueta "Estado:") por si
  // otros comercios usan un campo semejante.
  let condition = '';
  const ebayConditionMatch = html.match(/x-item-condition-text[\s\S]{0,400}?class=["']clipped["'][^>]*>\s*([^<]+?)\s*</i);
  if (ebayConditionMatch?.[1]) {
    condition = cleanExtractedText(ebayConditionMatch[1]);
  }
  if (!condition) {
    const genericConditionMatch =
      html.match(/itemprop=["']itemCondition["'][^>]*content=["'][^"']*?(New|Used|Refurbished|UsedCondition|NewCondition|RefurbishedCondition)["']/i) ||
      html.match(/"itemCondition"\s*:\s*"[^"]*?(New|Used|Refurbished)[^"]*"/i) ||
      html.match(/(?:estado|condici[oó]n)\s*(?:del producto)?\s*:?\s*(?:<\/[^>]+>\s*)?<[^>]*>\s*(Nuevo|Usado|Reacondicionado|Seminuevo|De exposición)\s*</i);
    if (genericConditionMatch?.[1]) {
      const map: Record<string, string> = { New: 'Nuevo', Used: 'Usado', Refurbished: 'Reacondicionado' };
      condition = map[genericConditionMatch[1]] ?? cleanExtractedText(genericConditionMatch[1]);
    }
  }

  // 2ª fuente: Amazon usa tablas técnicas y listas de detalle. El objeto nace
  // con las specs ya recogidas del JSON-LD (additionalProperty) para que las
  // tablas del HTML sólo añadan las que falten.
  const specs: Record<string, string> = { ...schemaSpecs };
  const addSpec = (key: unknown, value: unknown) => {
    const k = cleanExtractedText(key);
    const v = cleanExtractedText(value);
    if (k && v && v.toLowerCase() !== k.toLowerCase() && !specs[k]) specs[k] = v;
  };

  // Tabla "Especificaciones técnicas" (#productDetails_techSpec_section_1) y
  // tabla de detalles (#productDetails_detailBullets_sections1): <tr><th>k</th><td>v</td></tr>.
  for (const tableId of ['productDetails_techSpec_section_1', 'productDetails_detailBullets_sections1']) {
    const idx = html.search(new RegExp(`id=["']${tableId}["']`, 'i'));
    if (idx === -1) continue;
    const tableStart = html.indexOf('<table', idx);
    const tableEnd = tableStart !== -1 ? html.indexOf('</table>', tableStart) : -1;
    if (tableStart === -1 || tableEnd === -1 || tableEnd - tableStart > 40000) continue;
    const rows = html.slice(tableStart, tableEnd).match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
      if (cells.length >= 2) addSpec(cells[0], cells[1]);
    }
  }

  // 3ª fuente: #detailBullets_feature_div (lista dt/dd de especificaciones).
  const detailBulletsIdx = html.search(/id=["']detailBullets_feature_div["']/i);
  if (detailBulletsIdx !== -1) {
    const bulletsHtml = html.slice(detailBulletsIdx, detailBulletsIdx + 30000);
    const bulletItems = bulletsHtml.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
    for (const item of bulletItems) {
      const text = cleanExtractedText(item.replace(/<[^>]+>/g, ' '));
      const pair = text.split(/\s*:\s*/);
      if (pair.length >= 2 && pair[0].length <= 60) addSpec(pair[0], pair.slice(1).join(': '));
    }
  }

  // 4ª fuente genérica: tablas/atributos con aspecto de ficha técnica y <dl>.
  const specTableRe = /<(?:table|dl)[^>]+(?:id|class)=["'][^"']*(?:spec|technical|caracter|attribute|ficha|product-detail|product-detail)[^"']*["'][^>]*>([\s\S]*?)<\/(?:table|dl)>/gi;
  let specBlockMatch: RegExpExecArray | null;
  while ((specBlockMatch = specTableRe.exec(html)) !== null) {
    const block = specBlockMatch[1];
    const rowRe = /<(?:tr|div)[^>]*>\s*<(?:th|dt)[^>]*>([\s\S]*?)<\/(?:th|dt)>\s*<(?:td|dd)[^>]*>([\s\S]*?)<\/(?:td|dd)>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(block)) !== null) addSpec(rowMatch[1], rowMatch[2]);
    // Pares clave/valor separados por «:» dentro del bloque.
    for (const line of block.split(/(?:<br\s*\/?>|<\/li>|<\/p>)/i)) {
      const text = cleanExtractedText(line);
      const pair = text.split(/\s*:\s*/);
      if (pair.length === 2 && pair[0].length <= 60 && pair[1].length >= 2) addSpec(pair[0], pair[1]);
    }
  }

  // ── DISTRIBUIDOR (envío y pago) ──────────────────────────────────────────
  // Amazon: "Vendido por X" / "Ships from Y" en el buybox y el bloque de vendedor.
  let fulfillmentProvider = '';
  const sellerMatch =
    html.match(/id=["']merchantInfoFeature_feature_div["'][\s\S]{0,1500}?>\s*([^<]{2,80})\s*<\/span>/i) ||
    html.match(/(?:Sold by|Vendido por|Enviado por)\s*(?:&nbsp;|\s)*<\/span>\s*<span[^>]*>\s*([^<]{2,80})/i) ||
    html.match(/id=["']sellerProfileTriggerId["'][^>]*>\s*([^<]{2,80})/i);
  if (sellerMatch?.[1]) {
    const cleaned = cleanExtractedText(sellerMatch[1]).trim();
    // Guardia anti-basura: sólo texto legible (nada de JSON/plantillas).
    if (cleaned && cleaned.length <= 70 && !/[{}"\\<>]/.test(cleaned)) {
      fulfillmentProvider = cleaned;
    }
  }
  // Genérico para el resto de comercios: «Vendido por X», «Ships from X»,
  // «Tienda oficial de X», «Enviado y gestionado por X» (PcComponentes, ECI…).
  // Se busca SOLO en el texto visible (sin <script>/<style>): en las SPAs el
  // JSON embebido contiene claves tipo "seller" que romperían la extracción.
  if (!fulfillmentProvider) {
    const visibleHtml = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
    const looksLikeSellerName = (value: string): boolean =>
      value.length >= 2 &&
      value.length <= 70 &&
      !/[{}"\\<>|@=]/.test(value) &&
      /[a-záéíóúñ]/i.test(value) &&
      !/^(?:env[ií]o|pago|devoluci[oó]n|garant[ií]a|amazon|elige|ver|todo|desde|desp[uú]es)/i.test(value);
    const genericSellerMatch =
      visibleHtml.match(/(?:Vendido por|Sold by|Ships from|Enviado y gestionado por|Gestionado por|Tienda oficial de|Vendedor)\s*:?\s*(?:<\/(?:span|a|b|div|strong)>\s*)?<[^>]*>\s*([^<]{2,70})/i) ||
      visibleHtml.match(/(?:Vendido por|Sold by|Ships from|Vendedor|Tienda oficial)\s*:?\s*([^<>\n]{3,70})/i);
    if (genericSellerMatch?.[1]) {
      const cleaned = cleanExtractedText(genericSellerMatch[1])
        .replace(/^(?:y|\|)\s+/i, '')
        .replace(/\s*[·|•]\s*(?:env[ií]o|pago|devoluci).*$/i, '')
        .trim();
      if (looksLikeSellerName(cleaned)) {
        fulfillmentProvider = cleaned;
      }
    }
  }

  // ── ENVÍO: texto + días ───────────────────────────────────────────────────
  let shippingInfo = '';
  let shippingDays: number | undefined;
  const deliveryMatch =
    html.match(/id=["']deliveryBlockMessage["'][\s\S]{0,400}?<\/span>/i) ||
    html.match(/id=["']mirageDeliveryBlock["'][\s\S]{0,600}?<\/span>/i) ||
    html.match(/class=["'][^"']*(?:delivery|shipping)[^"']*["'][^>]*>([\s\S]{5,160}?)<\/(?:div|span|p)>/i);
  if (deliveryMatch) {
    const rawDelivery = (deliveryMatch[1] ?? deliveryMatch[0]).replace(/<[^>]+>/g, ' ');
    const cleanDelivery = cleanExtractedText(rawDelivery);
    if (cleanDelivery && cleanDelivery.length <= 160 && !/[{}"\\<>]/.test(cleanDelivery)) {
      shippingInfo = cleanDelivery;
    }
    const daysMatch = cleanDelivery.match(/(\d+)\s*(?:-|–|a|y)?\s*(\d+)?\s*(?:días|día|days|day)\b/i);
    if (daysMatch) {
      const last = daysMatch[2] ? parseInt(daysMatch[2], 10) : parseInt(daysMatch[1], 10);
      if (Number.isFinite(last)) shippingDays = last;
    }
  }
  // Genérico: «Llega en 3-5 días», «Envío gratis el martes», «Recíbelo mañana»…
  // Ojo con el orden: primero se busca el patrón con DÍAS (si existe, manda);
  // sólo si no aparece se cae a «gratis/mañana/hoy», porque el no-goloso se
  // detendría antes en «gratis» y se perderían los días de entrega.
  if (!shippingInfo) {
    const genericDeliveryMatch =
      html.match(/(?:Llega|Rec[ií]bete?|Entrega|Env[ií]o)[^<>]{0,120}?\d{1,3}\s*(?:[-–a]\s*)?\d{0,3}\s*d[ií]as/i) ||
      html.match(/(?:Llega|Rec[ií]bete?|Entrega|Env[ií]o)[^<>]{0,120}?(?:ma[ñn]ana|hoy|gratis)/i);
    if (genericDeliveryMatch) {
      const cleanDelivery = cleanExtractedText(genericDeliveryMatch[0]);
      // Texto humano y no fragmento de JSON/plantilla ({{ }}, comillas…).
      const validDelivery = cleanDelivery && cleanDelivery.length <= 160 && !/[{}"\\<>]/.test(cleanDelivery);
      if (validDelivery) shippingInfo = cleanDelivery;
      const daysMatch = cleanDelivery.match(/(\d+)\s*(?:-|–|a|y)?\s*(\d+)?\s*(?:días|día|days|day)\b/i);
      if (daysMatch && shippingDays == null) {
        const last = daysMatch[2] ? parseInt(daysMatch[2], 10) : parseInt(daysMatch[1], 10);
        if (Number.isFinite(last)) shippingDays = last;
      } else if (!daysMatch && /ma[ñn]ana/i.test(cleanDelivery)) {
        shippingDays = 1;
      }
    }
  }
  if (!shippingInfo && merchant === 'AliExpress') {
    const aliDays = html.match(/(\d{1,3})\s*(?:días|días de|days)\s*(?:de\s*)?(?:envío|entrega)/i);
    if (aliDays?.[1]) {
      shippingDays = parseInt(aliDays[1], 10);
      shippingInfo = `Envío en ${shippingDays} días`;
    }
  }

  // ── ENLACE DE COMPRA DIRECTA (Buy Now) ────────────────────────────────────
  // Amazon: el botón #buy-now-button apunta al checkout/compra inmediata.
  let buyNowUrl = '';
  const amazonBuyNow =
    html.match(/id=["']buy-now-button["'][^>]*\bhref=["']([^"']+)["']/i) ||
    html.match(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*id=["']buy-now-button["']/i);
  if (amazonBuyNow?.[1] && /^https?:\/\//i.test(amazonBuyNow[1])) {
    buyNowUrl = amazonBuyNow[1];
  } else if (amazonBuyNow?.[1]) {
    try {
      buyNowUrl = new URL(amazonBuyNow[1], targetUrl).href;
    } catch { /* href ilegible */ }
  }
  // Genérico: cualquier ancla cuyo texto sea «Comprar ahora»/«Buy now» y que
  // apunte a un checkout, carrito o flujo de compra directa.
  if (!buyNowUrl) {
    const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let anchorMatch: RegExpExecArray | null;
    while ((anchorMatch = anchorRe.exec(html)) !== null) {
      const anchorText = cleanExtractedText(anchorMatch[2]);
      if (!/^(?:comprar ahora|compra directa|buy\s?now|c[oó]mpralo ya|comprar ya|compra inmediata|ir a pagar)\b/i.test(anchorText)) continue;
      const hrefMatch = anchorMatch[1].match(/\bhref=["']([^"']+)["']/i);
      const href = hrefMatch?.[1] || '';
      if (!href || !/checkout|cart|buy|order|buybox|express|pagar/i.test(href)) continue;
      if (/^https?:\/\//i.test(href)) {
        buyNowUrl = href;
      } else {
        try {
          buyNowUrl = new URL(href, targetUrl).href;
        } catch { continue; }
      }
      break;
    }
  }
  // Compra directa embebida en JSON/JS (SPAs): checkoutUrl, buyNowUrl,
  // addToCartUrl… guardadas en el estado de página.
  if (!buyNowUrl) {
    const embeddedBuyRe = /"?\b(?:checkoutUrl|buyNowUrl|buyNowURL|addToCartUrl|cartUrl|orderUrl|expressCheckoutUrl)\b"?\s*:\s*"((?:https?:)?\\?\/\\?\/[^"]+|[a-z0-9][^"]{2,180})"/i;
    const embeddedBuyMatch = html.match(embeddedBuyRe);
    if (embeddedBuyMatch?.[1]) {
      const raw = embeddedBuyMatch[1].replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
      const candidate = /^https?:\/\//i.test(raw) ? raw : raw.replace(/^(?:\/\/)/, 'https://');
      try {
        buyNowUrl = new URL(candidate, targetUrl).href;
      } catch {
        buyNowUrl = '';
      }
    }
  }

  // Galería final: la imagen principal la encabeza, sin duplicados y limitada.
  // En Amazon, la misma foto aparece a varios tamaños (mismo ID antes de "._AC_",
  // "_SX", etc.), así que se deduplica por ID de imagen para quedarse con vistas distintas.
  const imageIdOf = (url: string): string => {
    const m = url.match(/\/images\/([IOr])\/([A-Za-z0-9%]+)\./i);
    return m ? `${m[1]}/${m[2]}` : url.split('?')[0];
  };
  const seenIds = new Set<string>();
  const finalGallery: string[] = [];
  const pushUnique = (url: string) => {
    if (!url || finalGallery.length >= 15) return;
    const id = imageIdOf(url);
    if (seenIds.has(id)) return;
    seenIds.add(id);
    finalGallery.push(url);
  };
  if (image) pushUnique(image);
  for (const url of gallerySet) pushUnique(url);

  // Candidatas extra para el filtro de la IA: todas las URLs recogidas, por si
  // el regex se quedó con poquitas vistas y el modelo puede seleccionar más.
  const imageCandidates = [...new Set([...finalGallery, ...gallerySet, ...htmlGalleryUrls])]
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 40);

  return {
    title: title || '',
    image: image || '',
    gallery: finalGallery,
    imageCandidates,
    description: description || '',
    price: price !== null ? price : undefined,
    originalPrice: originalPrice !== null && price !== null && originalPrice > price ? originalPrice : undefined,
    category: suggestedCategory,
    merchant,
    // Sólo es "oferta" si hay un precio tachado superior al actual (descuento real).
    badge: price !== null && originalPrice !== null && originalPrice > price ? 'Oferta detectada' : '',
    verdict: title ? `Una opción interesante para quienes buscan ${title.toLowerCase()}.` : '',
    pros: pros.slice(0, 5),
    cons: cons.length > 0 ? cons.slice(0, 3) : ['Revisa disponibilidad, garantía y condiciones del vendedor.'],
    brand,
    rating: rating ?? undefined,
    reviewsCount: reviewsCount ?? undefined,
    condition: condition || undefined,
    specs: (() => {
      if (condition) specs['Estado'] = condition;
      return Object.keys(specs).length ? specs : undefined;
    })(),
    fulfillmentProvider,
    shippingInfo: shippingInfo || undefined,
    shippingDays,
    buyNowUrl: buyNowUrl || undefined,
  };
}

export interface ScrapePageResult {
  ok: boolean;
  blocked?: boolean;
  message?: string;
  requestedUrl: string;
  effectiveUrl: string;
  merchant: string;
  html: string;
  data?: ReturnType<typeof extractMetadata>;
}

/**
 * Descarga una página de producto con cabeceras de navegador y extrae sus
 * metadatos. No lanza excepciones: devuelve ok:false con el motivo para que
 * cada endpoint decida cómo responder (scraped:false, fallback IA, etc.).
 */
export async function scrapeProductPage(
  rawUrl: string,
  options: { timeoutMs?: number } = {}
): Promise<ScrapePageResult> {
  const requestedUrl = String(rawUrl ?? '').trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(requestedUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Protocolo inválido');
  } catch {
    return {
      ok: false,
      message: 'La URL proporcionada no tiene un formato web válido (http/https).',
      requestedUrl,
      effectiveUrl: requestedUrl,
      merchant: 'Comercio Externo',
      html: '',
    };
  }

  const detectedMerchant = detectMerchantFromUrl(requestedUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8500);

  let html = '';
  let httpOk = true;
  let failureReason = '';
  let resolvedUrl = '';

  try {
    const response = await fetch(parsedUrl.href, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'Connection': 'keep-alive',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      httpOk = false;
      failureReason = `El comercio respondió con código ${response.status} (${response.statusText})`;
    } else {
      html = await response.text();
      const finalUrl = response.url?.trim();
      if (finalUrl) {
        try {
          resolvedUrl = new URL(finalUrl).href;
        } catch {
          resolvedUrl = '';
        }
      }
    }
  } catch (fetchError: any) {
    httpOk = false;
    if (fetchError?.name === 'AbortError') {
      failureReason = 'Tiempo de espera agotado al consultar la página externa';
    } else {
      failureReason = fetchError?.message || 'Fallo de conexión de red con el comercio de destino';
    }
  } finally {
    clearTimeout(timeout);
  }

  const effectiveUrl = resolvedUrl || parsedUrl.href;
  const finalMerchant = (() => {
    const fromFinal = detectMerchantFromUrl(effectiveUrl);
    return fromFinal !== 'Comercio Externo' ? fromFinal : detectedMerchant;
  })();

  // Página de bloqueo / CAPTCHA: aunque el status sea 200, no hay datos que extraer.
  const botPageRe =
    /validatecaptcha|robot check|enter the characters you see below|introduce los caracteres que ves|api-services-support@amazon|captcha-form|g-recaptcha|hcaptcha/i;
  if (httpOk && html && botPageRe.test(html)) {
    return {
      ok: false,
      blocked: true,
      message:
        'La tienda bloqueó la extracción automática desde el servidor con un verificador de humanos.',
      requestedUrl,
      effectiveUrl,
      merchant: finalMerchant,
      html,
    };
  }

  if (!httpOk || !html) {
    return {
      ok: false,
      message: failureReason || 'Sin contenido HTML',
      requestedUrl,
      effectiveUrl,
      merchant: finalMerchant,
      html: '',
    };
  }

  return {
    ok: true,
    requestedUrl,
    effectiveUrl,
    merchant: finalMerchant,
    html,
    data: extractMetadata(html, effectiveUrl),
  };
}

/**
 * Complementa un producto con los datos de su propia página cuando el payload
 * llega con huecos (marca, specs, valoración, opiniones, distribuidor, envío,
 * compra directa, descripción o galería): scrape por regex + fallback de IA.
 *
 * - Muta `data` en el sitio (rellena sólo lo vacío).
 * - Nunca lanza: si la tienda bloquea o falla la red, añade un aviso y sigue.
 * - `data.complement === false` desactiva la lectura (p.ej. edición manual).
 */
export async function complementProductFromPage(
  data: Record<string, any>,
  warnings: string[],
  options: { title?: string; timeoutMs?: number } = {},
): Promise<void> {
  if (data?.complement === false) return;
  const pageUrl = String(data?.url ?? data?.productUrl ?? data?.affiliateUrl ?? '').trim();
  if (!/^https?:\/\//i.test(pageUrl)) return;

  const emptyStr = (value: unknown): boolean => value == null || String(value).trim() === '';
  const galleryList: unknown[] = Array.isArray(data.gallery) ? data.gallery : [];
  const needsScrape =
    emptyStr(data.brand) ||
    !data.specs ||
    Object.keys(data.specs).length === 0 ||
    emptyStr(data.fulfillmentProvider) ||
    emptyStr(data.shippingInfo) ||
    emptyStr(data.buyNowUrl) ||
    emptyStr(data.description) ||
    emptyStr(data.condition) ||
    // `rating`/`reviewsCount`: sólo si el cliente NO los envió (undefined);
    // un null explícito significa "limpiarlo" y no se rellena. La galería se
    // lee sólo si viene VACÍA (con ≥1 imagen el flujo de análisis ya cubrió el
    // resto de vistas y no interesa re-scrapear en cada guardado).
    data.rating === undefined ||
    data.reviewsCount === undefined ||
    galleryList.length === 0;
  if (!needsScrape) return;

  try {
    const page = await scrapeProductPage(pageUrl, { timeoutMs: options.timeoutMs ?? 8000 });
    if (!page.ok || !page.data) {
      if (page.blocked) {
        warnings.push('La tienda bloqueó la lectura de su página; se usan los datos recibidos.');
      } else {
        warnings.push(`Lectura de la página no disponible (${page.message ?? 'sin datos'}).`);
      }
      return;
    }

    const scraped = page.data;
    if (emptyStr(data.brand) && scraped.brand) data.brand = scraped.brand;
    if ((!data.specs || Object.keys(data.specs).length === 0) && scraped.specs && Object.keys(scraped.specs).length) {
      data.specs = scraped.specs;
    }
    if (data.rating === undefined && scraped.rating != null) data.rating = scraped.rating;
    if (data.reviewsCount === undefined && scraped.reviewsCount != null) data.reviewsCount = scraped.reviewsCount;
    if (emptyStr(data.fulfillmentProvider) && scraped.fulfillmentProvider) data.fulfillmentProvider = scraped.fulfillmentProvider;
    if (emptyStr(data.shippingInfo) && scraped.shippingInfo) {
      data.shippingInfo = scraped.shippingInfo;
      if (scraped.shippingDays != null && data.shippingDays == null) data.shippingDays = scraped.shippingDays;
    }
    if (emptyStr(data.buyNowUrl) && scraped.buyNowUrl) data.buyNowUrl = scraped.buyNowUrl;
    if (emptyStr(data.description) && scraped.description) data.description = scraped.description;
    if (emptyStr(data.condition) && scraped.condition) data.condition = scraped.condition;
    if (scraped.gallery?.length) {
      const merged = (Array.isArray(data.gallery) ? data.gallery.map((g: unknown) => String(g ?? '').trim()) : [])
        .filter(Boolean);
      for (const img of scraped.gallery) {
        if (merged.length >= 10) break;
        if (!merged.includes(img)) merged.push(img);
      }
      data.gallery = merged;
    }

    // Huecos que el regex no cubrió → complemento con IA (si hay clave).
    const stillMissing: string[] = [];
    if (emptyStr(data.brand)) stillMissing.push('brand');
    if (!data.specs || Object.keys(data.specs).length < 3) stillMissing.push('specs');
    if (data.rating === undefined) stillMissing.push('rating');
    if (data.reviewsCount === undefined) stillMissing.push('reviewsCount');
    if (emptyStr(data.fulfillmentProvider)) stillMissing.push('fulfillmentProvider');
    if (emptyStr(data.shippingInfo)) stillMissing.push('shippingInfo');
    if (emptyStr(data.buyNowUrl)) stillMissing.push('buyNowUrl');
    if (Array.isArray(data.gallery) && data.gallery.length < 3) stillMissing.push('gallery');

    if (stillMissing.length && hasTextCredentials()) {
      try {
        const candidates: string[] = (Array.isArray(data.gallery) ? data.gallery : []).map((g: unknown) => String(g ?? ''));
        const aiFields: ProductPageAiFields = await extractProductPageFields({
          url: page.effectiveUrl,
          merchant: page.merchant,
          knownTitle: options.title || String(data.title ?? ''),
          html: page.html,
          candidateImages: candidates,
          missing: stillMissing,
        });
        if (emptyStr(data.brand) && aiFields.brand) data.brand = aiFields.brand;
        if ((!data.specs || Object.keys(data.specs).length < 3) && aiFields.specs && Object.keys(aiFields.specs).length) {
          data.specs = { ...(data.specs ?? {}), ...aiFields.specs };
        }
        if (data.rating === undefined && aiFields.rating != null) data.rating = aiFields.rating;
        if (data.reviewsCount === undefined && aiFields.reviewsCount != null) data.reviewsCount = aiFields.reviewsCount;
        if (emptyStr(data.fulfillmentProvider) && aiFields.fulfillmentProvider) data.fulfillmentProvider = aiFields.fulfillmentProvider;
        if (emptyStr(data.shippingInfo) && aiFields.shippingInfo) {
          data.shippingInfo = aiFields.shippingInfo;
          if (aiFields.shippingDays != null && data.shippingDays == null) data.shippingDays = aiFields.shippingDays;
        }
        if (emptyStr(data.buyNowUrl) && aiFields.buyNowUrl) data.buyNowUrl = aiFields.buyNowUrl;
        const aiGallery = (aiFields.galleryIndices ?? [])
          .map((index) => candidates[index - 1])
          .filter((img): img is string => typeof img === 'string' && /^https?:\/\//i.test(img));
        for (const img of aiGallery) {
          const list: string[] = Array.isArray(data.gallery) ? data.gallery : (data.gallery = []);
          if (list.length >= 10) break;
          if (!list.includes(img)) list.push(img);
        }
      } catch (aiError: any) {
        warnings.push(`Complemento IA de ficha no disponible (${aiError?.message ?? aiError}).`);
      }
    }
    warnings.push('Ficha complementada con los datos de la página del producto.');
  } catch (scrapeError: any) {
    warnings.push(`Lectura de la página fallida (${scrapeError?.message ?? scrapeError}); se sigue con los datos recibidos.`);
  }
}

/**
 * Resuelve la categoría de un producto:
 *  - Si el cliente envía una categoría explícita, se respeta tal cual.
 *  - Si no, se sugiere automáticamente por palabras clave (keywords de categories.json)
 *    y, en último caso, se usa la primera categoría disponible.
 */
function resolveCategory(explicit: unknown, haystack: string): string {
  const given = String(explicit ?? '').trim();
  if (given) return given;

  const suggestion = suggestCategory(haystack);
  if (suggestion) return suggestion.category.name;

  const names = getCategories().map((category) => category.name);
  return names[0] || 'Tecnología';
}

/**
 * Resuelve los ids jerárquicos (category_id / subcategory_id) a partir del
 * nombre de la categoría y de la subcategoría elegidas en el panel. Si el
 * nombre no existe en categories.json no se devuelve id (el producto guarda
 * sólo el texto, como antes).
 */

// ==============================================================================
// 1. GET: Retorna la lista actual de productos
// ==============================================================================
export const GET: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const products = readProductsFromFile();
    // Enriquecimiento adicional de curación (sólo en la respuesta, no persiste):
    // conversion_score, is_duplicate (+motivo) y defaults de ia_status/link_status.
    const enriched = enrichProductsForAdmin(products);
    return new Response(JSON.stringify({ success: true, count: enriched.length, products: enriched }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, message: error.message || 'Error al obtener productos' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

// ==============================================================================
// 2. POST: Maneja Scraping Híbrido, Guardado y Eliminación de Productos
// ==============================================================================
export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ success: false, message: 'Cuerpo de la petición JSON inválido' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { action, url, product, id } = body;

    // --------------------------------------------------------------------------
    // CASO A: ELIMINAR PRODUCTO ({ action: 'delete', id: '...' })
    // --------------------------------------------------------------------------
    if (action === 'delete' || (id && !url && !product && !body.title)) {
      const targetId = id || body.id;
      if (!targetId) {
        return new Response(
          JSON.stringify({ success: false, message: 'ID del producto requerido para eliminar' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const currentProducts = readProductsFromFile();
      const updatedProducts = currentProducts.filter((p) => p.id !== targetId);

      if (updatedProducts.length === currentProducts.length) {
        return new Response(
          JSON.stringify({ success: false, message: `No se encontró ningún producto con ID "${targetId}"` }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const saved = writeProductsToFile(updatedProducts);
      if (!saved) {
        return new Response(
          JSON.stringify({ success: false, message: 'Error al escribir los cambios en el disco' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Tombstone: evita que el producto reaparezca vía el catálogo curado
      // (src/data/products.ts) o por cualquier re-sync posterior.
      addDeletedId(targetId);

      return new Response(
        JSON.stringify({ success: true, message: 'Producto eliminado correctamente', id: targetId }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // --------------------------------------------------------------------------
    // CASO A2: ASIGNAR CATEGORÍA EN MASA ({ action: 'set-category', ids, category })
    // --------------------------------------------------------------------------
    if (action === 'set-category') {
      const ids = Array.isArray(body.ids) ? body.ids.map((v: unknown) => String(v)) : [];
      const category = String(body.category || '').trim();
      // Categorización bidireccional: además del nombre legado (category),
      // se persisten los IDs jerárquicos (category_id / subcategory_id).
      const categoryId = String(body.category_id ?? '').trim();
      const subcategoryId = String(body.subcategory_id ?? '').trim();
      if (!ids.length || !category) {
        return new Response(
          JSON.stringify({ success: false, message: 'Se requiere al menos un ID y una categoría.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const currentProducts = readProductsFromFile();
      const wanted = new Set(ids);
      let updated = 0;
      for (const p of currentProducts) {
        if (!wanted.has(p.id)) continue;
        let changed = false;
        if (p.category !== category) {
          p.category = category;
          changed = true;
        }
        if (categoryId && p.category_id !== categoryId) {
          p.category_id = categoryId;
          changed = true;
        }
        if (subcategoryId && p.subcategory_id !== subcategoryId) {
          p.subcategory_id = subcategoryId;
          changed = true;
        } else if (!subcategoryId && p.subcategory_id && categoryId) {
          // Cambiar de categoría raíz invalida la subcategoría anterior.
          delete p.subcategory_id;
          changed = true;
        }
        if (changed) updated++;
      }

      if (updated > 0 && !writeProductsToFile(currentProducts)) {
        return new Response(
          JSON.stringify({ success: false, message: 'Error al escribir los cambios en el disco' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, updated, total: ids.length, category, category_id: categoryId, subcategory_id: subcategoryId }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // --------------------------------------------------------------------------
    // CASO A3: ASIGNAR ETIQUETA DESTACADA (BADGE) EN MASA
    //         ({ action: 'set-badge', ids, badge })
    // --------------------------------------------------------------------------
    if (action === 'set-badge') {
      const ids = Array.isArray(body.ids) ? body.ids.map((v: unknown) => String(v)) : [];
      const badge = String(body.badge ?? '').trim();
      if (!ids.length) {
        return new Response(
          JSON.stringify({ success: false, message: 'Se requiere al menos un ID.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const currentProducts = readProductsFromFile();
      const wanted = new Set(ids);
      let updated = 0;
      for (const p of currentProducts) {
        if (!wanted.has(p.id)) continue;
        const next = badge || undefined;
        if ((p.badge || undefined) === next) continue;
        if (next) p.badge = next; else delete p.badge;
        updated++;
      }

      if (updated > 0 && !writeProductsToFile(currentProducts)) {
        return new Response(
          JSON.stringify({ success: false, message: 'Error al escribir los cambios en el disco' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, updated, total: ids.length, badge }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // --------------------------------------------------------------------------
    // CASO B: GUARDAR PRODUCTO ({ action: 'save', product } o payload directo)
    // --------------------------------------------------------------------------
    if (action === 'save' || product || (body.title && body.affiliateUrl && !url)) {
      const dataToSave: Partial<Product> = product || body;

      if (!dataToSave.title || !dataToSave.affiliateUrl) {
        return new Response(
          JSON.stringify({
            success: false,
            message: 'Los campos "title" y "affiliateUrl" son obligatorios para guardar.',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const currentProducts = readProductsFromFile();
      // Cuando se edita un producto existente, el id es la fuente de verdad.
      // Solo usamos fallback por URL/ASIN/sourceId para altas nuevas (sin id).
      let productId = String(dataToSave.id || '').trim();
      if (!productId || !currentProducts.some((p) => p.id === productId)) {
        productId =
          currentProducts.find((p) => p.affiliateUrl === dataToSave.affiliateUrl)?.id ||
          currentProducts.find((p) => p.asin === dataToSave.asin)?.id ||
          currentProducts.find((p) => p.sourceId === dataToSave.sourceId)?.id ||
          slugify(dataToSave.title);
      }
      const existingProduct = currentProducts.find((p) => p.id === productId);

      // Duplicados: si OTRA fila del catálogo ya comparte URL de afiliado o
      // título (normalizados), no se crea una segunda copia. El propio id del
      // producto se ignora para no bloquear sus actualizaciones.
      //
      // Al editar, excluimos de la comprobación las URLs que el producto
      // YA tiene guardadas (no son cambios → no deben bloquear). Esto es
      // crítico para productos de Amazon importados desde JSON que, al no
      // tener affiliate_url real de ScraperAPI, comparten el placeholder
      // https://www.amazon.es/dp/B000000000?tag=tradylor-21 y, sin esta
      // exclusión, cualquier producto de Amazon se considera duplicado de
      // cualquier otro.
      const existingUrls = existingProduct
        ? [existingProduct.affiliateUrl, existingProduct.buyNowUrl]
        : [];
      const urlsToCheck = [dataToSave.affiliateUrl, dataToSave.buyNowUrl, (dataToSave as { url?: string }).url]
        .map((u) => {
          if (!u) return undefined;
          const normalized = normalizeProductKey(u);
          // Si el producto existente ya tiene esta URL normalizada, no es un cambio: excluir.
          if (existingUrls.some((eu) => eu && normalizeProductKey(eu) === normalized)) return undefined;
          return u;
        })
        .filter(Boolean);

      const duplicate = findDuplicateProduct(
        currentProducts,
        {
          id: productId,
          title: dataToSave.title,
          urls: urlsToCheck,
        },
        productId,
      );
      if (duplicate) {
        // Auto-sanado: si la fila existente no tiene el ID externo (productos
        // importados antes de persistirlo) se le estampa ahora, para que el
        // filtro «En catálogo › Añadidos» la reconozca.
        const incomingSourceId = String((dataToSave as { sourceId?: string }).sourceId || '').trim();
        if (incomingSourceId && !String(duplicate.sourceId || '').trim()) {
          const target = currentProducts.find((p) => p.id === duplicate.id);
          if (target) {
            target.sourceId = incomingSourceId;
            duplicate.sourceId = incomingSourceId;
            writeProductsToFile(currentProducts);
          }
        }
        return new Response(
          JSON.stringify({
            success: false,
            duplicate: true,
            message: `Ya existe en el catálogo («${duplicate.title}»): no se ha añadido un duplicado.`,
            product: duplicate,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Complemento best-effort desde la propia página del producto: rellena
      // los huecos de la ficha (marca, specs, valoración, opiniones,
      // distribuidor, envío, compra directa y galería) con scrape + IA.
      const complementNotes: string[] = [];
      await complementProductFromPage(dataToSave as Record<string, any>, complementNotes, {
        title: String(dataToSave.title || ''),
      });

      // Galería: si el cliente no envía ninguna, se conserva la ya guardada
      // (así editar un producto sin re-scrapear no borra sus imágenes).
      let gallery = Array.isArray(dataToSave.gallery)
        ? dataToSave.gallery
            .map((g: unknown) => String(g ?? '').trim())
            .filter((g: string) => /^https?:\/\//i.test(g) || g.startsWith('/images/'))
            .slice(0, 10)
        : Array.isArray(existingProduct?.gallery)
          ? existingProduct.gallery.slice(0, 10)
          : [];

      const resolvedImage = String(
        dataToSave.image ||
          existingProduct?.image ||
          'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=800&auto=format&fit=crop'
      ).trim();

      // La imagen principal debe formar parte de la galería (primera posición).
      if (resolvedImage && !gallery.includes(resolvedImage)) {
        gallery.unshift(resolvedImage);
      }

      // Semántica de los campos opcionales al EDITAR:
      //  - `undefined` (no enviado) → se conserva el valor ya guardado.
      //  - `null` / cadena vacía (envío explícito del panel) → se limpia el campo.
      const strField = (sent: unknown, existing?: string): string | undefined => {
        if (sent === undefined) return existing;
        const value = String(sent ?? '').trim();
        return value || undefined;
      };
      const numField = (sent: unknown, existing?: number): number | undefined => {
        if (sent === undefined) return existing;
        if (sent == null || sent === '' || !Number.isFinite(Number(sent))) return undefined;
        return Number(sent);
      };

      // Categoría y subcategoría elegidas en el panel: se guardan el nombre
      // (legado) y los ids jerárquicos de categories.json.
      //
      // `keepUncategorized` (importación desde el JSON de una red): el cliente
      // pide explícitamente NO categorizar — la categoría queda vacía para
      // asignarla después masivamente desde el panel (preset «Sin Categoria»
      // + «Asignar categoría»). Sin este flag, la categoría vacía caía en el
      // fallback automático (suggestCategory por keywords o primera
      // categoría) y el producto nunca aparecía como «sin categoría».
      const keepUncategorized = body?.keepUncategorized === true;
      const resolvedCategoryName = keepUncategorized
        ? String(dataToSave.category ?? '').trim()
        : resolveCategory(
            dataToSave.category,
            `${dataToSave.title} ${dataToSave.description || ''}`
          );
      const subcategorySent = (dataToSave as Record<string, unknown>).subcategory;
      const subcategoryProvided = subcategorySent !== undefined;
      const requestedSubcategory = String(subcategorySent ?? '').trim();
      const resolvedIds = resolveCategoryIds(resolvedCategoryName, requestedSubcategory);

      const newProduct: Product = {
        id: productId,
        title: String(dataToSave.title).trim(),
        description: String(dataToSave.description || '').trim(),
        price: Number(dataToSave.price) || 0,
        originalPrice: numField(dataToSave.originalPrice, existingProduct?.originalPrice),
        image: resolvedImage,
        gallery: gallery.slice(0, 10),
        category: resolvedCategoryName,
        category_id: resolvedIds.category_id ?? existingProduct?.category_id,
        subcategory_id: resolvedIds.subcategory_id,
        merchant: String(dataToSave.merchant || detectMerchantFromUrl(dataToSave.affiliateUrl)).trim(),
        affiliateUrl: String(dataToSave.affiliateUrl).trim(),
        buyNowUrl: strField(dataToSave.buyNowUrl, existingProduct?.buyNowUrl),
        pros: Array.isArray(dataToSave.pros)
          ? dataToSave.pros.filter(Boolean)
          : typeof dataToSave.pros === 'string'
          ? (dataToSave.pros as string).split('\n').map((s) => s.trim()).filter(Boolean)
          : [],
        cons: Array.isArray(dataToSave.cons)
          ? dataToSave.cons.filter(Boolean)
          : typeof dataToSave.cons === 'string'
          ? (dataToSave.cons as string).split('\n').map((s) => s.trim()).filter(Boolean)
          : [],
        badge: strField(dataToSave.badge, existingProduct?.badge),
        // Rating y reseñas: no enviado → conserva (o default en altas nuevas);
        // enviado vacío/null → se limpian; número → se guarda acotado.
        rating: (() => {
          if (dataToSave.rating === undefined) return existingProduct?.rating ?? 4.8;
          const n = numField(dataToSave.rating);
          return n != null ? Math.min(5, Math.max(0, n)) : undefined;
        })(),
        reviewsCount: (() => {
          if (dataToSave.reviewsCount === undefined) return existingProduct?.reviewsCount ?? 100;
          const n = numField(dataToSave.reviewsCount);
          return n != null ? Math.max(0, Math.round(n)) : undefined;
        })(),
        brand: strField(dataToSave.brand, existingProduct?.brand),
        // Estado físico (Nuevo/Usado/Reacondicionado...): dato clave para
        // poder filtrar después los productos de segunda mano.
        condition: strField(dataToSave.condition, existingProduct?.condition),
        fulfillmentProvider: strField(dataToSave.fulfillmentProvider, existingProduct?.fulfillmentProvider),
        verdict: strField(dataToSave.verdict, existingProduct?.verdict),
        techSheet: strField(dataToSave.techSheet, existingProduct?.techSheet),
        // Specs clave/valor: objeto válido → se guarda; null → se limpia;
        // undefined → se conserva el existente.
        specs:
          dataToSave.specs === undefined
            ? existingProduct?.specs
            : dataToSave.specs && typeof dataToSave.specs === 'object' && !Array.isArray(dataToSave.specs)
              ? (dataToSave.specs as Record<string, string>)
              : undefined,
        shippingInfo: strField(dataToSave.shippingInfo, existingProduct?.shippingInfo),
        shippingDays: (() => {
          const n = numField(dataToSave.shippingDays, existingProduct?.shippingDays);
          return n != null ? Math.max(0, Math.round(n)) : undefined;
        })(),
        freeShipping:
          dataToSave.freeShipping === undefined
            ? existingProduct?.freeShipping
            : typeof dataToSave.freeShipping === 'boolean'
              ? dataToSave.freeShipping
              : undefined,
        // Curación que el formulario de la ficha SÍ puede traer (o que llega
        // desde la tabla de afiliados): ID externo y vínculos/roles de
        // alternativas. `undefined` → se conserva el valor ya guardado.
        sourceId: strField(dataToSave.sourceId, existingProduct?.sourceId),
        alternatives: dataToSave.alternatives === undefined
          ? existingProduct?.alternatives
          : dataToSave.alternatives && typeof dataToSave.alternatives === 'object' && !Array.isArray(dataToSave.alternatives)
            ? (dataToSave.alternatives as Product['alternatives'])
            : undefined,
        alternative_product_ids: Array.isArray(dataToSave.alternative_product_ids)
          ? (dataToSave.alternative_product_ids as unknown[]).map((v) => String(v ?? '').trim()).filter(Boolean)
          : existingProduct?.alternative_product_ids,
        // Datos crudos de la red de origen (Importar/Afiliados): todo lo que la
        // API de la red facilita y antes se descartaba al guardar manualmente
        // desde el panel («Importar» o el formulario de Extracción & Alta).
        // `undefined` → se conserva lo ya guardado; nunca se inventan valores.
        network: strField(dataToSave.network, existingProduct?.network),
        currency: strField(dataToSave.currency, existingProduct?.currency),
        commissionRate: numField(dataToSave.commissionRate, existingProduct?.commissionRate),
        commissionEstimate: numField(dataToSave.commissionEstimate, existingProduct?.commissionEstimate),
        sales30d: numField(dataToSave.sales30d, existingProduct?.sales30d),
        inStock:
          dataToSave.inStock === undefined
            ? existingProduct?.inStock
            : typeof dataToSave.inStock === 'boolean'
              ? dataToSave.inStock
              : undefined,
        visits: numField(dataToSave.visits, existingProduct?.visits),
        // `extra`: fusión superficial (no se pierde lo ya guardado —p. ej. la
        // comparativa multitienda de «Construir Catálogo»— al re-importar o
        // editar manualmente); `null` explícito lo vacía.
        extra: (() => {
          if (dataToSave.extra === undefined) return existingProduct?.extra;
          if (dataToSave.extra && typeof dataToSave.extra === 'object' && !Array.isArray(dataToSave.extra)) {
            return { ...(existingProduct?.extra ?? {}), ...(dataToSave.extra as Record<string, unknown>) };
          }
          return undefined;
        })(),
      };

      // Etiqueta destacada automática basada en datos técnicos e IA.
      // Sólo se calcula si el cliente no envió una badge explícita.
      if (!dataToSave.badge) newProduct.badge = computeBadge(newProduct as Product & { hsrScore?: number });

      // Si ya existe un producto con el mismo ID, se actualiza; si no, se añade al principio.
      // Al actualizar se conservan los campos de curación que el formulario no
      // edita (IDs jerárquicos, historial de precio, score, alternativas...).
      const existingIndex = currentProducts.findIndex((p) => p.id === productId);
      let productToSave: Product = newProduct;
      if (existingIndex >= 0 && existingProduct) {
        // Re-importación con keepUncategorized: si la fila existente ya tenía
        // categoría curada, se conserva (nunca se vacía por re-importar).
        if (keepUncategorized && !newProduct.category && existingProduct.category) {
          newProduct.category = existingProduct.category;
        }
        const categoryChanged = newProduct.category !== existingProduct.category;
        productToSave = {
          ...existingProduct,
          ...newProduct,
          // Un cambio de categoría invalida los IDs jerárquicos asignados antes
          // (salvo que el panel haya indicado una categoría/subcategoría válida).
          category_id:
            newProduct.category_id ??
            (categoryChanged ? undefined : existingProduct.category_id),
          subcategory_id: subcategoryProvided
            ? newProduct.subcategory_id
            : categoryChanged
              ? undefined
              : existingProduct.subcategory_id,
          // Pipeline de automatización: una edición manual no borra la auditoría.
          audit_status: existingProduct.audit_status,
          audit_score: existingProduct.audit_score,
          audit_reasons: existingProduct.audit_reasons,
          pipeline_version: existingProduct.pipeline_version,
          pipeline_run_at: existingProduct.pipeline_run_at,
          ai_enriched: existingProduct.ai_enriched,
          ai_error: existingProduct.ai_error, sourceDescription: existingProduct.sourceDescription,
        };
        currentProducts[existingIndex] = productToSave;
      } else {
        currentProducts.unshift(productToSave);
      }

      const saved = writeProductsToFile(currentProducts);
      if (!saved) {
        return new Response(
          JSON.stringify({ success: false, message: 'Error de escritura en el servidor de archivos' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Si el producto había sido borrado previamente, se revive (quito el tombstone).
      removeDeletedId(productId);

      // Vinculación automática de alternativas: sólo aplica si el producto
      // todavía no tiene ninguna a mano (nunca pisa la curación manual).
      const autoAlt = autoLinkAlternatives(productId);
      if (autoAlt.ok && autoAlt.linked) {
        productToSave = readProductsFromFile().find((p) => p.id === productId) || productToSave;
        complementNotes.push(`${autoAlt.linked} alternativa(s) vinculada(s) automáticamente con roles sugeridos.`);
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: existingIndex >= 0 ? 'Producto actualizado con éxito' : 'Producto guardado con éxito',
          product: productToSave,
          notes: complementNotes,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // --------------------------------------------------------------------------
    // CASO C: SCRAPING HÍBRIDO (Extracción de OpenGraph / Metadatos)
    // --------------------------------------------------------------------------
    const targetUrl = url || body.url;
    if (!targetUrl || typeof targetUrl !== 'string') {
      return new Response(
        JSON.stringify({ success: false, message: 'Se requiere una URL válida para analizar' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validar formato URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl.trim());
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Protocolo inválido');
      }
    } catch {
      return new Response(
        JSON.stringify({ success: false, message: 'La URL proporcionada no tiene un formato web válido (http/https).' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const detectedMerchant = detectMerchantFromUrl(targetUrl);

    // Descarga con cabeceras de navegador + extracción de metadatos
    // (OpenGraph, JSON-LD, datos embebidos y textos visibles).
    const page = await scrapeProductPage(targetUrl);

    // Detección de página de bloqueo / CAPTCHA (Amazon y otras tiendas). Aunque
    // el status sea 200, si el HTML es un verificador de humanos no hay datos que
    // extraer: se trata como bloqueo para no devolver una ficha vacía como "éxito".
    if (!page.ok && page.blocked) {
      return new Response(
        JSON.stringify({
          success: true,
          scraped: false,
          message:
            'La tienda (Amazon) bloqueó la extracción automática desde el servidor con un verificador de humanos. Rellena los datos manualmente o usa un enlace de otra tienda.',
          data: {
            title: '',
            description: '',
            price: null,
            originalPrice: null,
            image: '',
            category: 'Tecnología',
            merchant: page.merchant || detectedMerchant,
            affiliateUrl: page.effectiveUrl || targetUrl,
            badge: '',
            verdict: '',
            pros: [],
            cons: ['Amazon protege su página contra bots de servidor; completar a manual es la opción fiable.'],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // SI LA PÁGINA BLOQUEA EL SCRAPING O FALLA LA RED:
    // NO DEBE FALLAR EL SERVIDOR. Devolvemos respuesta 200 con scraped: false y la URL lista para completar manualmente.
    if (!page.ok || !page.html || !page.data) {
      return new Response(
        JSON.stringify({
          success: true,
          scraped: false,
          message: `Extracción automática no disponible: ${page.message ?? 'sin datos'}. Completa los datos manualmente.`,
          data: {
            title: '',
            description: '',
            price: null,
            originalPrice: null,
            image: '',
            category: 'Tecnología',
            merchant: page.merchant || detectedMerchant,
            affiliateUrl: page.effectiveUrl || targetUrl,
            badge: '',
            verdict: '',
            pros: [],
            cons: ['Completa los datos editoriales si la tienda bloquea la extracción.'],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // URL efectiva del producto: la resuelta tras la redirección si existe
    // (convierte enlaces cortos como amzn.to en la URL real /dp/ASIN), si no la original.
    const effectiveUrl = page.effectiveUrl;
    // Comercio detectado con la URL final tiene prioridad sobre el del enlace original.
    const finalMerchant = page.merchant;
    const extracted = page.data;

    // ── Fallback IA para los huecos que el HTML dejó vacíos ─────────────────
    // El scrape por regex es la fuente principal; la IA sólo completa lo que
    // falta (marca, valoración, opiniones, specs, distribuidor, envío, compra
    // directa) y selecciona más vistas de la galería entre las candidatas.
    const candidateImages = extracted.imageCandidates?.length
      ? extracted.imageCandidates
      : extracted.gallery ?? [];
    const missing: string[] = [];
    if (!extracted.brand) missing.push('brand');
    if (extracted.rating == null) missing.push('rating');
    if (extracted.reviewsCount == null) missing.push('reviewsCount');
    if (!extracted.specs || Object.keys(extracted.specs).length < 3) missing.push('specs');
    if (!extracted.fulfillmentProvider) missing.push('fulfillmentProvider');
    if (!extracted.shippingInfo) missing.push('shippingInfo');
    if (!extracted.buyNowUrl) missing.push('buyNowUrl');
    if (candidateImages.length < 3) missing.push('gallery');

    let aiFields: ProductPageAiFields | null = null;
    if (missing.length && hasTextCredentials()) {
      try {
        aiFields = await extractProductPageFields({
          url: effectiveUrl,
          merchant: finalMerchant,
          knownTitle: extracted.title,
          html: page.html,
          candidateImages,
          missing,
        });
      } catch (aiError: any) {
        console.warn('[API Products Add] Fallback IA de extracción no disponible:', aiError?.message ?? aiError);
      }
    }

    // Combinación: el scrape manda; la IA rellena huecos y añade vistas extra.
    const aiGallery = (aiFields?.galleryIndices ?? [])
      .map((index) => candidateImages[index - 1])
      .filter((img): img is string => typeof img === 'string' && /^https?:\/\//i.test(img));
    const mergedGallery = [...(extracted.gallery ?? [])];
    for (const img of aiGallery) {
      if (mergedGallery.length >= 15) break;
      if (!mergedGallery.includes(img)) mergedGallery.push(img);
    }
    const mergedSpecs =
      extracted.specs && Object.keys(extracted.specs).length > 0
        ? extracted.specs
        : aiFields?.specs && Object.keys(aiFields.specs).length > 0
          ? aiFields.specs
          : undefined;

    return new Response(
      JSON.stringify({
        success: true,
        scraped: true,
        message: 'Metadatos extraídos con éxito.',
        data: {
          title: extracted.title,
          description: extracted.description,
          price: extracted.price ?? null,
          originalPrice: extracted.originalPrice ?? extracted.price ?? null,
          image: extracted.image,
          gallery: mergedGallery,
          category: extracted.category,
          merchant: finalMerchant,
          affiliateUrl: effectiveUrl,
          badge: extracted.badge,
          verdict: extracted.verdict,
          pros: extracted.pros,
          cons: extracted.cons,
          brand: extracted.brand || aiFields?.brand || '',
          rating: extracted.rating ?? aiFields?.rating ?? null,
          reviewsCount: extracted.reviewsCount ?? aiFields?.reviewsCount ?? null,
          specs: mergedSpecs ?? null,
          fulfillmentProvider: extracted.fulfillmentProvider || aiFields?.fulfillmentProvider || '',
          shippingInfo: extracted.shippingInfo || aiFields?.shippingInfo || '',
          shippingDays: extracted.shippingDays ?? aiFields?.shippingDays ?? null,
          buyNowUrl: extracted.buyNowUrl || aiFields?.buyNowUrl || '',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (globalError: any) {
    console.error('[API Products Add] Error no controlado:', globalError);
    // Manejo defensivo para no tumbar el servidor nunca
    return new Response(
      JSON.stringify({
        success: false,
        message: 'Ocurrió un error inesperado al procesar la solicitud en el servidor.',
        error: globalError.message || String(globalError),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

// ==============================================================================
// 3. DELETE: Soporte HTTP DELETE nativo (/api/products/add?id=xyz)
// ==============================================================================
export const DELETE: APIRoute = async ({ request, url }) => {
  try {
    let targetId = url.searchParams.get('id');

    if (!targetId) {
      try {
        const body = await request.json();
        targetId = body.id;
      } catch {
        // Ningún ID proporcionado
      }
    }

    if (!targetId) {
      return new Response(
        JSON.stringify({ success: false, message: 'Parámetro id requerido para eliminar el producto' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const currentProducts = readProductsFromFile();
    const filtered = currentProducts.filter((p) => p.id !== targetId);

    if (filtered.length === currentProducts.length) {
      return new Response(
        JSON.stringify({ success: false, message: `Producto con ID "${targetId}" no encontrado` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    writeProductsToFile(filtered);

    return new Response(
      JSON.stringify({ success: true, message: 'Producto eliminado correctamente', id: targetId }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ success: false, message: error.message || 'Error al eliminar producto' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
