import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { requireAdminAuth } from '../../../lib/adminAuth';

export const prerender = false;

// Interfaz para el producto
export interface Product {
  id: string;
  title: string;
  description: string;
  price: number;
  originalPrice?: number;
  image: string;
  category: string;
  merchant: string;
  affiliateUrl: string;
  pros: string[];
  cons: string[];
  badge?: string;
  rating?: number;
  reviewsCount?: number;
  verdict?: string;
}

// Ruta al archivo de persistencia JSON
const DATA_FILE_PATH = path.join(process.cwd(), 'src', 'data', 'products.json');

/**
 * Lee de forma segura los productos almacenados en el archivo JSON local.
 */
function readProductsFromFile(): Product[] {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      return [];
    }
    const raw = fs.readFileSync(DATA_FILE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    console.error('[API Products] Error al leer products.json:', error);
    return [];
  }
}

/**
 * Escribe los productos en el archivo JSON local garantizando el formateo.
 */
function writeProductsToFile(products: Product[]): boolean {
  try {
    const dir = path.dirname(DATA_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(products, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('[API Products] Error al guardar en products.json:', error);
    return false;
  }
}

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

    if (host.includes('amazon.')) return 'Amazon';
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

          if (schemaPrice !== null) {
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
      } catch {
        // Amazon puede entregar el atributo incompleto; se usa el fallback siguiente.
      }
    }

    if (!image) {
      const amazonImageMatch = html.match(/data-old-hires=["']([^"']+)["']/i);
      if (amazonImageMatch?.[1]) image = decodeHtmlEntities(amazonImageMatch[1]);
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

  // Amazon y muchas tiendas publican prestaciones como elementos de lista.
  const bulletMatches = html.match(/<(?:li|span)[^>]+(?:a-list-item|feature-bullet|bullet)[^>]*>([\s\S]*?)<\/(?:li|span)>/gi) || [];
  for (const match of bulletMatches) {
    const bullet = cleanExtractedText(match.replace(/<[^>]+>/g, ' '));
    if (bullet.length >= 12 && bullet.length <= 220 && !pros.includes(bullet)) pros.push(bullet);
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

  // Deducir categoría inicial sugerida basada en título
  let suggestedCategory = 'Tecnología';
  const lowerTitle = (title + ' ' + description).toLowerCase();
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

  return {
    title: title || '',
    image: image || '',
    description: description || '',
    price: price !== null ? price : undefined,
    originalPrice: originalPrice !== null && price !== null && originalPrice > price ? originalPrice : undefined,
    category: suggestedCategory,
    merchant,
    badge: price !== null ? 'Oferta detectada' : '',
    verdict: title ? `Una opción interesante para quienes buscan ${title.toLowerCase()}.` : '',
    pros: pros.slice(0, 5),
    cons: cons.length > 0 ? cons.slice(0, 3) : ['Revisa disponibilidad, garantía y condiciones del vendedor.'],
    brand,
    rating: rating ?? undefined,
    reviewsCount: reviewsCount ?? undefined,
  };
}

/**
 * Genera un ID limpio tipo slug a partir del título
 */
function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 50);
  return base || `producto-${Date.now().toString(36)}`;
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
        category: String(dataToSave.category || 'Tecnología').trim(),
        merchant: String(dataToSave.merchant || detectMerchantFromUrl(dataToSave.affiliateUrl)).trim(),
        affiliateUrl: String(dataToSave.affiliateUrl).trim(),
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

    try {
      const response = await fetch(parsedUrl.href, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
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
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!response.ok) {
        fetchBlockedOrFailed = true;
        failureReason = `El comercio respondió con código ${response.status} (${response.statusText})`;
      } else {
        html = await response.text();
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

    // Si obtuvimos el HTML, extraemos OpenGraph y Schemas
    const extracted = extractMetadata(html, parsedUrl.href);

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
          category: extracted.category,
          merchant: extracted.merchant,
          affiliateUrl: parsedUrl.href,
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
