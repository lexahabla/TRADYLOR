import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { getCategories, suggestCategory } from '../../../lib/categories';
import {
  readProductsFromFile,
  writeProductsToFile,
  slugify,
  findDuplicateProduct,
  type Product,
} from '../../../lib/productStore';
import { addDeletedId, removeDeletedId } from '../../../lib/deletedProducts';
import { enrichProductsForAdmin } from '../../../lib/curation';

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
  if (gallerySet.size < 3) {
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
    for (const url of htmlGalleryUrls) addGallery(url);
  }

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

  // ── ESPECIFICACIONES (specs clave/valor) ────────────────────────────────
  // 1ª fuente: meta de marca (comercios que no publican JSON-LD).
  if (!brand) {
    const brandMeta = findMetaContent('brand', 'product:brand', 'twitter:data1');
    if (brandMeta) brand = cleanExtractedText(brandMeta);
  }

  // 2ª fuente: Amazon usa tablas técnicas y listas de detalle.
  const specs: Record<string, string> = {};
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
    fulfillmentProvider = cleanExtractedText(sellerMatch[1]);
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
    if (cleanDelivery && cleanDelivery.length <= 160) shippingInfo = cleanDelivery;
    const daysMatch = cleanDelivery.match(/(\d+)\s*(?:-|–|a|y)?\s*(\d+)?\s*(?:días|día|days|day)\b/i);
    if (daysMatch) {
      const last = daysMatch[2] ? parseInt(daysMatch[2], 10) : parseInt(daysMatch[1], 10);
      if (Number.isFinite(last)) shippingDays = last;
    }
  }
  if (!shippingInfo && merchant === 'AliExpress') {
    const aliDays = html.match(/(\d{1,3})\s*(?:días|días de|days)\s*(?:de\s*)?(?:envío|entrega)/i);
    if (aliDays?.[1]) {
      shippingDays = parseInt(aliDays[1], 10);
      shippingInfo = `Envío en ${shippingDays} días`;
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
    specs: Object.keys(specs).length ? specs : undefined,
    fulfillmentProvider,
    shippingInfo: shippingInfo || undefined,
    shippingDays,
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
      const productId = dataToSave.id || slugify(dataToSave.title);
      const existingProduct = currentProducts.find((p) => p.id === productId);

      // Duplicados: si OTRA fila del catálogo ya comparte URL de afiliado o
      // título (normalizados), no se crea una segunda copia. El propio id del
      // producto se ignora para no bloquear sus actualizaciones.
      const duplicate = findDuplicateProduct(
        currentProducts,
        {
          id: productId,
          title: dataToSave.title,
          urls: [dataToSave.affiliateUrl, dataToSave.buyNowUrl, (dataToSave as { url?: string }).url],
        },
        productId,
      );
      if (duplicate) {
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

      const newProduct: Product = {
        id: productId,
        title: String(dataToSave.title).trim(),
        description: String(dataToSave.description || '').trim(),
        price: Number(dataToSave.price) || 0,
        originalPrice: numField(dataToSave.originalPrice, existingProduct?.originalPrice),
        image: resolvedImage,
        gallery: gallery.slice(0, 10),
        category: resolveCategory(dataToSave.category, `${dataToSave.title} ${dataToSave.description || ''}`),
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
      };

      // Si ya existe un producto con el mismo ID, se actualiza; si no, se añade al principio.
      // Al actualizar se conservan los campos de curación que el formulario no
      // edita (IDs jerárquicos, historial de precio, score, alternativas...).
      const existingIndex = currentProducts.findIndex((p) => p.id === productId);
      let productToSave: Product = newProduct;
      if (existingIndex >= 0 && existingProduct) {
        const categoryChanged = newProduct.category !== existingProduct.category;
        productToSave = {
          ...existingProduct,
          ...newProduct,
          // Un cambio de categoría invalida los IDs jerárquicos asignados antes.
          category_id: categoryChanged ? undefined : existingProduct.category_id,
          subcategory_id: categoryChanged ? undefined : existingProduct.subcategory_id,
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

      return new Response(
        JSON.stringify({
          success: true,
          message: existingIndex >= 0 ? 'Producto actualizado con éxito' : 'Producto guardado con éxito',
          product: productToSave,
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
          specs: extracted.specs ?? null,
          fulfillmentProvider: extracted.fulfillmentProvider ?? '',
          shippingInfo: extracted.shippingInfo ?? '',
          shippingDays: extracted.shippingDays ?? null,
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
