import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { getCategories, suggestCategory } from '../../../lib/categories';
import {
  readProductsFromFile,
  writeProductsToFile,
  slugify,
  type Product,
} from '../../../lib/productStore';

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
function extractMetadata(html: string, targetUrl: string) {
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
  const rawPriceMeta = findMetaContent('product:price:amount', 'og:price:amount', 'price');
  if (rawPriceMeta) {
    price = parsePrice(rawPriceMeta);
  }
  originalPrice = parsePrice(findMetaContent('product:price:original', 'product:original_price', 'og:price:standard'));

  // Si no hay precio en meta tags, buscar en bloques JSON-LD Schema.org
  if (price === null) {
    const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    if (jsonLdMatches) {
      for (const block of jsonLdMatches) {
        try {
          const content = block.replace(/<script[^>]*>|<\/script>/gi, '').trim();
          const parsedJson = JSON.parse(content);

          const searchSchemaForPrice = (obj: any): number | null => {
            if (!obj || typeof obj !== 'object') return null;
            if (!brand && obj.brand) brand = cleanExtractedText(typeof obj.brand === 'object' ? obj.brand.name : obj.brand);
            if (!rating && obj.aggregateRating?.ratingValue) rating = parsePrice(obj.aggregateRating.ratingValue);
            if (!reviewsCount && obj.aggregateRating?.reviewCount) reviewsCount = parsePrice(obj.aggregateRating.reviewCount);
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
            if (obj.offers) {
              const offer = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
              const offerPrice = parsePrice(offer?.price ?? offer?.lowPrice);
              const offerHighPrice = parsePrice(offer?.highPrice ?? offer?.priceSpecification?.maxPrice);
              if (offerHighPrice !== null && (offerPrice === null || offerHighPrice > offerPrice)) originalPrice = offerHighPrice;
              if (offerPrice !== null) return offerPrice;
            }
            const objectPrice = parsePrice(obj.price);
            if (objectPrice !== null) return objectPrice;
            for (const value of Object.values(obj)) {
              const nestedPrice = searchSchemaForPrice(value);
              if (nestedPrice !== null) return nestedPrice;
            }
            return null;
          };

          const schemaPrice = Array.isArray(parsedJson)
            ? parsedJson.map(searchSchemaForPrice).find((p) => p !== null)
            : searchSchemaForPrice(parsedJson);

          if (schemaPrice != null) {
            price = schemaPrice;
            break;
          }
        } catch {
          // JSON-LD malformado en página externa, ignorar de forma segura
        }
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

  // Fallbacks específicos para la plantilla dinámica de Amazon.
  if (!image) {
    const dynamicImageMatch = html.match(/id=["']landingImage["'][^>]+data-a-dynamic-image=["']([^"']+)["']/i);
    if (dynamicImageMatch?.[1]) {
      try {
        const imageMap = JSON.parse(decodeHtmlEntities(dynamicImageMatch[1])) as Record<string, number[]>;
        const largestImage = Object.entries(imageMap).sort(([, firstSize], [, secondSize]) =>
          (secondSize[0] * secondSize[1]) - (firstSize[0] * firstSize[1])
        )[0];
        if (largestImage?.[0]) image = largestImage[0];
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
  }

  if (image && !/^https?:\/\//i.test(image)) image = '';

  if (price === null) {
    const amazonOffscreenPrice = html.match(/<span[^>]+class=["'][^"']*a-offscreen[^"']*["'][^>]*>\s*([\d.,]+)\s*€?/i);
    if (amazonOffscreenPrice?.[1]) price = parsePrice(amazonOffscreenPrice[1]);
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
    if (!url || finalGallery.length >= 10) return;
    const id = imageIdOf(url);
    if (seenIds.has(id)) return;
    seenIds.add(id);
    finalGallery.push(url);
  };
  if (image) pushUnique(image);
  for (const url of gallerySet) pushUnique(url);

  return {
    title: title || '',
    image: image || '',
    gallery: finalGallery,
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
  };
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

// ==============================================================================
// 1. GET: Retorna la lista actual de productos
// ==============================================================================
export const GET: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const products = readProductsFromFile();
    return new Response(JSON.stringify({ success: true, count: products.length, products }), {
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

      return new Response(
        JSON.stringify({ success: true, message: 'Producto eliminado correctamente', id: targetId }),
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
      const productId = dataToSave.id || slugify(dataToSave.title);

      const newProduct: Product = {
        id: productId,
        title: String(dataToSave.title).trim(),
        description: String(dataToSave.description || '').trim(),
        price: Number(dataToSave.price) || 0,
        originalPrice: dataToSave.originalPrice ? Number(dataToSave.originalPrice) : undefined,
        image: String(dataToSave.image || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=800&auto=format&fit=crop').trim(),
        gallery: Array.isArray(dataToSave.gallery)
          ? dataToSave.gallery
              .map((g: unknown) => String(g ?? '').trim())
              .filter((g: string) => /^https?:\/\//i.test(g) || g.startsWith('/images/'))
              .slice(0, 10)
          : undefined,
        category: resolveCategory(dataToSave.category, `${dataToSave.title} ${dataToSave.description || ''}`),
        merchant: String(dataToSave.merchant || detectMerchantFromUrl(dataToSave.affiliateUrl)).trim(),
        affiliateUrl: String(dataToSave.affiliateUrl).trim(),
        buyNowUrl: dataToSave.buyNowUrl
          ? String(dataToSave.buyNowUrl).trim()
          : currentProducts.find((p) => p.id === productId)?.buyNowUrl,
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
        badge: dataToSave.badge ? String(dataToSave.badge).trim() : undefined,
        rating: dataToSave.rating ? Number(dataToSave.rating) : 4.8,
        reviewsCount: dataToSave.reviewsCount ? Number(dataToSave.reviewsCount) : 100,
        verdict: dataToSave.verdict ? String(dataToSave.verdict).trim() : undefined,
      };

      // Si ya existe un producto con el mismo ID, se actualiza; si no, se añade al principio
      const existingIndex = currentProducts.findIndex((p) => p.id === productId);
      if (existingIndex >= 0) {
        currentProducts[existingIndex] = newProduct;
      } else {
        currentProducts.unshift(newProduct);
      }

      const saved = writeProductsToFile(currentProducts);
      if (!saved) {
        return new Response(
          JSON.stringify({ success: false, message: 'Error de escritura en el servidor de archivos' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: existingIndex >= 0 ? 'Producto actualizado con éxito' : 'Producto guardado con éxito',
          product: newProduct,
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

    // Intentar fetch con User-Agent de navegador legítimo y timeout seguro
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8500); // 8.5s timeout

    let html = '';
    let fetchBlockedOrFailed = false;
    let failureReason = '';
    // URL final tras seguir redirecciones (enlaces cortos como amzn.to).
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
        fetchBlockedOrFailed = true;
        failureReason = `El comercio respondió con código ${response.status} (${response.statusText})`;
      } else {
        html = await response.text();
        // Tras seguir la redirección (p. ej. amzn.to → /dp/ASIN), la URL final
        // es la del producto real: la usamos para detectar comercio, ASIN y
        // como enlace de afiliado guardado (más fiable que el enlace corto).
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
      fetchBlockedOrFailed = true;
      if (fetchError.name === 'AbortError') {
        failureReason = 'Tiempo de espera agotado al consultar la página externa';
      } else {
        failureReason = fetchError.message || 'Fallo de conexión de red con el comercio de destino';
      }
    } finally {
      clearTimeout(timeout);
    }

    // Detección de página de bloqueo / CAPTCHA (Amazon y otras tiendas). Aunque
    // el status sea 200, si el HTML es un verificador de humanos no hay datos que
    // extraer: se trata como bloqueo para no devolver una ficha vacía como "éxito".
    const botPageRe = /validatecaptcha|robot check|enter the characters you see below|introduce los caracteres que ves|api-services-support@amazon|captcha-form|g-recaptcha|hcaptcha/i;
    if (!fetchBlockedOrFailed && html && botPageRe.test(html)) {
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
            merchant: detectedMerchant,
            affiliateUrl: parsedUrl.href,
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
    if (fetchBlockedOrFailed || !html) {
      return new Response(
        JSON.stringify({
          success: true,
          scraped: false,
          message: `Extracción automática no disponible: ${failureReason}. Completa los datos manualmente.`,
          data: {
            title: '',
            description: '',
            price: null,
            originalPrice: null,
            image: '',
            category: 'Tecnología',
            merchant: detectedMerchant,
            affiliateUrl: parsedUrl.href,
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
    const effectiveUrl = resolvedUrl || parsedUrl.href;
    // Merchant según la URL final (los enlaces cortos ya no engañan a la detección).
    const effectiveMerchant = detectMerchantFromUrl(effectiveUrl);

    // Si obtuvimos el HTML, extraemos OpenGraph y Schemas
    const extracted = extractMetadata(html, effectiveUrl);
    // Comercio detectado con la URL final tiene prioridad sobre el del enlace original.
    const finalMerchant = effectiveMerchant !== 'Comercio Externo' ? effectiveMerchant : (extracted.merchant || detectedMerchant);

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
          gallery: extracted.gallery ?? [],
          category: extracted.category,
          merchant: finalMerchant,
          affiliateUrl: effectiveUrl,
          badge: extracted.badge,
          verdict: extracted.verdict,
          pros: extracted.pros,
          cons: extracted.cons,
          brand: extracted.brand,
          rating: extracted.rating ?? null,
          reviewsCount: extracted.reviewsCount ?? null,
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
