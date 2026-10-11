import fs from 'node:fs';
import path from 'node:path';
import { CLIENT_IMAGES_DIR, IMAGES_DIR } from './paths';

/**
 * Integración de IA para Compra Delegada.
 *
 * Todo se ejecuta en el servidor de Astro (SSR endpoints), sin dependencias
 * externas de orquestación: texto editorial con OpenAI/Anthropic y imagen de
 * producto con OpenAI Images o Flux (Black Forest Labs).
 *
 * Variables de entorno (ver .env.example):
 *   TEXT_AI_PROVIDER   openai (por defecto) | anthropic
 *   OPENAI_API_KEY / OPENAI_MODEL            (por defecto gpt-4o-mini)
 *   ANTHROPIC_API_KEY / ANTHROPIC_MODEL      (por defecto claude-3-5-sonnet-latest)
 *   IMAGE_AI_PROVIDER  openai (por defecto) | flux
 *   IMAGE_MODEL        (por defecto gpt-image-1; acepta dall-e-3)
 *   FLUX_API_KEY / FLUX_ENDPOINT
 */

export type TextProvider = 'openai' | 'anthropic' | 'groq';
export type ImageProvider = 'openai' | 'flux';

export interface EnrichedPricing {
  /** Precio de oferta (el que ve el usuario como precio actual). */
  price: number;
  /** Precio original tachado; SIEMPRE mayor que `price`. */
  originalPrice: number;
  /** Descuento resultante redondeado a entero (15–40). */
  discountPercentage: number;
}

export interface EnrichedText {
  /** Título sintetizado y corto (legible en las product-cards). */
  title?: string;
  description: string;
  specs: Record<string, string>;
  pros: string[];
  cons: string[];
  verdict: string;
  category?: string;
  /** Par oferta/original con descuento realista (EUR). */
  pricing?: EnrichedPricing;
}

export interface ImageGenerationResult {
  /** Ruta pública servible por Astro, p. ej. /images/products/foo-abc.png */
  url: string;
  provider: ImageProvider;
  /** URL original del proveedor (sólo informativa; se descarga y guarda en local) */
  sourceUrl?: string;
}

/** Lee variables de entorno con el patrón del proyecto (process.env ?? import.meta.env). */
export function env(name: string): string {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  const fromAstro = (import.meta.env as Record<string, string | undefined>)[name];
  return fromAstro ?? '';
}

export function textProvider(): TextProvider {
  const value = env('TEXT_AI_PROVIDER').toLowerCase();
  if (value === 'anthropic') return 'anthropic';
  if (value === 'groq') return 'groq';
  return 'openai';
}

export function imageProvider(): ImageProvider {
  return env('IMAGE_AI_PROVIDER').toLowerCase() === 'flux' ? 'flux' : 'openai';
}

export function hasTextCredentials(): boolean {
  const provider = textProvider();
  if (provider === 'anthropic') return Boolean(env('ANTHROPIC_API_KEY'));
  if (provider === 'groq') return Boolean(env('GROQ_API_KEY'));
  return Boolean(env('OPENAI_API_KEY'));
}

export function hasImageCredentials(): boolean {
  return imageProvider() === 'flux' ? Boolean(env('FLUX_API_KEY')) : Boolean(env('OPENAI_API_KEY'));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Extrae el primer objeto JSON válido aunque el modelo añada ```json o texto alrededor. */
function parseLooseJson(raw: string): any {
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('La IA devolvió un JSON no interpretable');
  }
}

const TEXT_SYSTEM_PROMPT = [
  'Eres el equipo editorial de Tradylor, un portal de análisis y recomendación de productos de alta conversión.',
  'Tu trabajo es preparar una ficha técnica honesta y neutral (estilo redacción técnica, no publicitaria).',
  'Reglas estrictas:',
  '- Nunca inventes especificaciones ni números de ventas que no puedas deducir del texto de entrada.',
  '- Tono divulgativo y directo, sin superlativos comerciales ("lo mejor del mercado", "imbatible") y sin llamadas a la acción de compra.',
  '- title: título SINTETIZADO en español, máximo 70 caracteres, que diga solo qué es el producto (tipo + marca + modelo) y, si cabe, una única característica diferencial importante (ej. "Auriculares Sony WH-1000XM5 con cancelación de ruido"). Sin precios, sin descuentos, sin argumentos de venta, sin el nombre del comercio ni sufijos tipo "| Amazon.es" o "- PcComponentes". Debe leerse bien en una tarjeta de producto.',
  '- pros: 3 a 5 puntos concretos y verificables.',
  '- cons: 2 a 4 puntos reales o de contexto (disponibilidad, garantía, accesorios), no relleno.',
  '- verdict: 1 o 2 frases neutras indicando para quién encaja el producto.',
  '- specs: entre 4 y 8 pares clave/valor cortos (p. ej. "Autonomía": "Hasta 30 horas"). Omite las que no conozcas.',
  '- category: nombre corto de categoría (ej. "Audio & Sonido").',
  '- description: 2 o 3 frases en español de REDACCIÓN TÉCNICA CONCISA, orientadas a decisión de compra. Si se aporta una descripción previa, reescríbela mejorando claridad, precisión y fluidez (sin inventar datos ni superlativos).',
  '- pricing: objeto { currentPrice, originalPrice } en euros. Si en la entrada ya hay un precio de oferta, consérvalo EXACTAMENTE como currentPrice y genera un originalPrice superior con un descuento realista (entre 15% y 35%, nunca más del 40%). Si no hay ningún precio, propón un par realista para la categoría del producto. Formato: dos decimales terminando en ,99 o ,95. originalPrice SIEMPRE mayor que currentPrice. Descuentos absurdos (>50%) o mínimos (<10%) quedan prohibidos.',
  'Responde SOLO con JSON válido con claves: title, description, specs, pros, cons, verdict, category, pricing.',
].join('\n');

/**
 * Paso 1 — Enriquecimiento de texto con IA.
 * Genera descripción, ficha técnica estructurada, pros/contras, veredicto
 * y par de precios (oferta + original) con descuento realista.
 */
export async function enrichProductText(input: {
  title: string;
  description?: string;
  category?: string;
  url?: string;
  /** Precio de oferta de referencia (si el scraping/usuario ya lo conoce). */
  price?: number;
  originalPrice?: number;
}): Promise<EnrichedText> {
  const provider = textProvider();
  if (!hasTextCredentials()) {
    throw new Error(
      provider === 'anthropic'
        ? 'Falta ANTHROPIC_API_KEY para enriquecer el texto'
        : 'Falta OPENAI_API_KEY para enriquecer el texto'
    );
  }

  const userContext = [
    `Producto: ${input.title}`,
    input.category ? `Categoría sugerida: ${input.category}` : '',
    input.description ? `Descripción disponible: ${input.description}` : '',
    input.price ? `Precio de oferta de referencia: ${input.price.toFixed(2)} EUR` : '',
    input.originalPrice ? `Precio original de referencia: ${input.originalPrice.toFixed(2)} EUR` : '',
    input.url ? `Página de origen: ${input.url}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  if (provider === 'anthropic') {
    const model = env('ANTHROPIC_MODEL') || 'claude-3-5-sonnet-latest';
    const response = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env('ANTHROPIC_API_KEY'),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1200,
          temperature: 0.4,
          system: TEXT_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContext }],
        }),
      },
      60_000
    );
    if (!response.ok) {
      throw new Error(`Anthropic respondió ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const payload = await response.json();
    const text = (payload?.content ?? []).map((block: any) => block?.text ?? '').join('');
    return normalizeEnrichedText(parseLooseJson(text));
  }

  if (provider === 'groq') {
    // Groq es compatible con la API de OpenAI; nivel gratuito para desarrolladores.
    // Modelo fijo openai/gpt-oss-120b (disponible en el plan free; llama-3.3-70b es Enterprise).
    // Se ignora GROQ_MODEL para evitar modelos no disponibles en el nivel gratuito.
    const model = 'openai/gpt-oss-120b';
    const response = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env('GROQ_API_KEY')}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: TEXT_SYSTEM_PROMPT },
            { role: 'user', content: userContext },
          ],
        }),
      },
      60_000
    );
    if (!response.ok) {
      throw new Error(`Groq respondió ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content ?? '';
    return normalizeEnrichedText(parseLooseJson(text));
  }

  const model = env('OPENAI_MODEL') || 'gpt-4o-mini';
  const response = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env('OPENAI_API_KEY')}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: TEXT_SYSTEM_PROMPT },
          { role: 'user', content: userContext },
        ],
      }),
    },
    60_000
  );
  if (!response.ok) {
    throw new Error(`OpenAI respondió ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content ?? '';
  return normalizeEnrichedText(parseLooseJson(text));
}

/** Normaliza y sanea la respuesta del modelo (tipos, límites, strings vacíos). */
function normalizeEnrichedText(raw: any): EnrichedText {
  const toStringArray = (value: unknown, max: number): string[] => {
    const list = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split('\n')
        : [];
    return list
      .map((item) => String(item ?? '').replace(/\s+/g, ' ').trim())
      .filter((item) => item.length > 1 && item.length < 260)
      .slice(0, max);
  };

  const specs: Record<string, string> = {};
  if (raw?.specs && typeof raw.specs === 'object' && !Array.isArray(raw.specs)) {
    for (const [key, value] of Object.entries(raw.specs as Record<string, unknown>)) {
      const label = String(key).replace(/\s+/g, ' ').trim().slice(0, 60);
      const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (label && text) specs[label] = text;
      if (Object.keys(specs).length >= 8) break;
    }
  }

  return {
    title: String(raw?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || undefined,
    description: String(raw?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
    specs,
    pros: toStringArray(raw?.pros, 5),
    cons: toStringArray(raw?.cons, 4),
    verdict: String(raw?.verdict ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
    category: String(raw?.category ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || undefined,
    pricing: normalizePricing(raw?.pricing),
  };
}

// ─── Precios con descuento realista ─────────────────────────────────────────

/** Redondea a un precio "de tienda" creíble terminado en ,99 (o ,95 si ya acaba en 95). */
function roundNicePrice(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const rounded = Math.round(value);
  return Math.max(0.99, rounded - 0.01);
}

/** Descuentos habituales en e-commerce: creíbles e incentivadores (15–35 %). */
const DISCOUNT_POOL = [15, 17, 20, 22, 25, 28, 30, 33, 35];

/** Precios de referencia por categoría cuando no hay dato alguno (EUR). */
const REFERENCE_PRICES = [29.99, 39.99, 49.99, 59.99, 79.99, 99.99, 129.99, 149.99, 199.99];

/**
 * Construye un par oferta/original creíble:
 *   - Si hay precio de oferta de referencia (scraping o escrito a mano),
 *     se respeta y se genera el original por encima con descuento 15–35 %.
 *   - Si no hay precio, se propone un par de mercado para la categoría.
 */
export function buildRealisticPricing(knownOfferPrice?: number): EnrichedPricing {
  const discount = DISCOUNT_POOL[Math.floor(Math.random() * DISCOUNT_POOL.length)];
  const offer =
    knownOfferPrice && knownOfferPrice > 0
      ? roundNicePrice(knownOfferPrice)
      : REFERENCE_PRICES[Math.floor(Math.random() * REFERENCE_PRICES.length)];
  const original = roundNicePrice(offer / (1 - discount / 100));
  const realDiscount = Math.max(10, Math.min(40, Math.round((1 - offer / original) * 100)));
  return { price: offer, originalPrice: original, discountPercentage: realDiscount };
}

/** Sanea el par de precios devuelto por el modelo (limita el descuento a 10–40 %). */
function normalizePricing(raw: any): EnrichedPricing | undefined {
  const price = Number(raw?.currentPrice ?? raw?.price);
  if (!Number.isFinite(price) || price <= 0) return undefined;

  const offer = roundNicePrice(price);
  let original = Number(raw?.originalPrice);

  // Sin original válido: se genera uno creíble sobre la oferta.
  if (!Number.isFinite(original) || original <= offer) {
    return buildRealisticPricing(offer);
  }

  // Descuento máximo creíble: 40 % (recorta originales inflados).
  const maxOriginal = roundNicePrice(offer / 0.6);
  if (original > maxOriginal) original = maxOriginal;

  const discountPercentage = Math.round((1 - offer / original) * 100);
  return { price: offer, originalPrice: original, discountPercentage };
}

// ─── Sintetización de títulos ────────────────────────────────────────────────

/** Sufijos de marketplace que ensucian el título de una product-card. */
const MARKETPLACE_SUFFIX_RE =
  /\s*[\-|:•·]\s*(Amazon(?:\.(?:es|com|it|de|fr|co\.uk))?|PcComponentes|El Corte Inglés|MediaMarkt|Fnac|AliExpress|Carrefour|Apple|eBay|Walmart|Best Buy)\b.*$/i;

const MAX_TITLE_LENGTH = 70;

/**
 * Sintetiza un título corto y legible SIN IA (gratis, instantáneo):
 * quita sufijos de tienda, se queda con la definición del producto y
 * recorta a un máximo de 70 caracteres en límite de palabra.
 */
export function synthesizeTitleLocally(title: string): string {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';

  t = t.replace(MARKETPLACE_SUFFIX_RE, '').trim();

  // Si el título usa separadores ("Marca - modelo - features..."), conserva
  // la parte principal (tipo + marca + modelo) y una característica corta.
  const parts = t.split(/\s+[\-–—|]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    let candidate = parts[0];
    for (const part of parts.slice(1)) {
      if (candidate.length + part.length + 1 > MAX_TITLE_LENGTH) break;
      candidate = `${candidate} ${part}`;
      // Con una característica extra es suficiente: el resto es relleno.
      break;
    }
    t = candidate;
  }

  if (t.length > MAX_TITLE_LENGTH) {
    const cut = t.slice(0, MAX_TITLE_LENGTH);
    const lastSpace = cut.lastIndexOf(' ');
    t = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return t;
}

const TITLE_SYSTEM_PROMPT = [
  'Eres el equipo editorial de Tradylor, un portal de análisis y recomendación de productos.',
  'Sintetiza el título del producto para que quepa y se lea bien en una tarjeta de producto.',
  'Reglas estrictas:',
  `- Máximo ${MAX_TITLE_LENGTH} caracteres.`,
  '- Di SOLO qué es el producto: tipo + marca + modelo y, como mucho, una única característica diferencial importante.',
  '- Sin precios, sin descuentos, sin argumentos de venta ni superlativos.',
  '- Sin el nombre del comercio ni sufijos de marketplace ("| Amazon.es", "- PcComponentes", "Envío gratis...").',
  '- Conserva las mayúsculas naturales de marca y modelo.',
  'Responde SOLO con JSON válido: { "title": "..." }',
].join('\n');

/**
 * Sintetiza un título corto con IA (OpenAI / Anthropic / Groq).
 * Lanza si no hay credenciales o el proveedor falla (el caller aplica fallback local).
 */
export async function synthesizeProductTitle(input: {
  title: string;
  description?: string;
  category?: string;
  brand?: string;
}): Promise<string> {
  const provider = textProvider();
  if (!hasTextCredentials()) {
    throw new Error(
      provider === 'anthropic'
        ? 'Falta ANTHROPIC_API_KEY para sintetizar el título'
        : provider === 'groq'
          ? 'Falta GROQ_API_KEY para sintetizar el título'
          : 'Falta OPENAI_API_KEY para sintetizar el título'
    );
  }

  const userContext = [
    `Título original: ${input.title}`,
    input.brand ? `Marca: ${input.brand}` : '',
    input.category ? `Categoría: ${input.category}` : '',
    input.description ? `Descripción disponible: ${input.description.slice(0, 400)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  let text = '';

  if (provider === 'anthropic') {
    const model = env('ANTHROPIC_MODEL') || 'claude-3-5-sonnet-latest';
    const response = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env('ANTHROPIC_API_KEY'),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 150,
          temperature: 0.3,
          system: TITLE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContext }],
        }),
      },
      45_000
    );
    if (!response.ok) {
      throw new Error(`Anthropic respondió ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const payload = await response.json();
    text = (payload?.content ?? []).map((block: any) => block?.text ?? '').join('');
  } else if (provider === 'groq') {
    const response = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/chat/completions',
      {
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
            { role: 'system', content: TITLE_SYSTEM_PROMPT },
            { role: 'user', content: userContext },
          ],
        }),
      },
      45_000
    );
    if (!response.ok) {
      throw new Error(`Groq respondió ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const payload = await response.json();
    text = payload?.choices?.[0]?.message?.content ?? '';
  } else {
    const model = env('OPENAI_MODEL') || 'gpt-4o-mini';
    const response = await fetchWithTimeout(
      'https://api.openai.com/v1/chat/completions',
      {
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
            { role: 'system', content: TITLE_SYSTEM_PROMPT },
            { role: 'user', content: userContext },
          ],
        }),
      },
      45_000
    );
    if (!response.ok) {
      throw new Error(`OpenAI respondió ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const payload = await response.json();
    text = payload?.choices?.[0]?.message?.content ?? '';
  }

  const parsed = parseLooseJson(text);
  const short = String(parsed?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!short) throw new Error('La IA no devolvió un título sintetizado');
  return short;
}

/**
 * Prompt de fotografía comercial: fondo de estudio opaco #F8F9FA a sangre
 * (sin transparencia) y margen de seguridad del 15% para que la imagen encaje
 * y se vea completa en los contenedores aspect-square con object-contain
 * (vista previa del admin, product-cards y carrusel de la ficha).
 */
export function buildProductImagePrompt(title: string): string {
  return `High-end commercial product photography of ${title}. Centered studio shot with professional lighting, crisp details, and soft realistic shadows underneath. Seamless solid light gray (#F8F9FA) background filling the ENTIRE frame edge-to-edge: fully opaque, no transparency, no checkerboard, no vignette, no colored backdrop, no props. Perfect composition: centered product with 15% safety margin padding on all sides (no edge cropping). Ultra-sharp focus, 8k resolution, photorealistic, professional e-commerce product asset.`;
}

function slugifyFilename(text: string): string {
  const base = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 48);
  return base || 'producto';
}

/** Guarda bytes en disco y devuelve la URL pública (/images/products/...). */
function persistImage(bytes: Uint8Array, title: string): string {
  const filename = `${slugifyFilename(title)}-${Date.now().toString(36)}.png`;
  const relativeUrl = `/images/products/${filename}`;

  // 1) Fuente durable: IMAGES_DIR (volumen en producción, public/ en local).
  try {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.writeFileSync(path.join(IMAGES_DIR, filename), bytes);
  } catch (error) {
    console.warn('[AI] No se pudo guardar la imagen en el almacenamiento durable:', error);
  }

  // 2) Build actual: dist/client/images/products (lo sirve el standalone de Node).
  try {
    if (fs.existsSync(path.dirname(CLIENT_IMAGES_DIR))) {
      fs.mkdirSync(CLIENT_IMAGES_DIR, { recursive: true });
      fs.writeFileSync(path.join(CLIENT_IMAGES_DIR, filename), bytes);
    }
  } catch (error) {
    console.warn('[AI] No se pudo copiar la imagen al build actual:', error);
  }

  return relativeUrl;
}

async function downloadBytes(url: string): Promise<Uint8Array> {
  const response = await fetchWithTimeout(url, {}, 60_000);
  if (!response.ok) throw new Error(`No se pudo descargar la imagen (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Paso 2 — Generación de imagen de producto con IA.
 * Descarga el resultado y lo guarda en local para que los componentes de Astro
 * lo sirvan sin depender de URLs temporales de terceros.
 */
export async function generateProductImage(title: string): Promise<ImageGenerationResult> {
  const provider = imageProvider();

  if (provider === 'flux') {
    if (!env('FLUX_API_KEY')) throw new Error('Falta FLUX_API_KEY para generar la imagen con Flux');
    return generateWithFlux(title);
  }

  if (!env('OPENAI_API_KEY')) throw new Error('Falta OPENAI_API_KEY para generar la imagen');
  return generateWithOpenAI(title);
}

async function generateWithOpenAI(title: string): Promise<ImageGenerationResult> {
  const model = env('IMAGE_MODEL') || 'gpt-image-1';
  const response = await fetchWithTimeout(
    'https://api.openai.com/v1/images/generations',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env('OPENAI_API_KEY')}`,
      },
      body: JSON.stringify({
        model,
        prompt: buildProductImagePrompt(title),
        size: '1024x1024',
        n: 1,
        ...(model.startsWith('dall-e') ? { response_format: 'b64_json' } : {}),
      }),
    },
    120_000
  );
  if (!response.ok) {
    throw new Error(`OpenAI Images respondió ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const payload = await response.json();
  const item = payload?.data?.[0];
  if (item?.b64_json) {
    const bytes = Buffer.from(item.b64_json, 'base64');
    return { url: persistImage(bytes, title), provider: 'openai' };
  }
  if (item?.url) {
    const bytes = await downloadBytes(item.url);
    return { url: persistImage(bytes, title), provider: 'openai', sourceUrl: item.url };
  }
  throw new Error('OpenAI Images no devolvió imagen (ni b64_json ni url)');
}

async function generateWithFlux(title: string): Promise<ImageGenerationResult> {
  const endpoint = env('FLUX_ENDPOINT') || 'https://api.bfl.ml/v1/flux-pro-1.1';
  const apiKey = env('FLUX_API_KEY');

  const submit = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-key': apiKey },
      body: JSON.stringify({
        prompt: buildProductImagePrompt(title),
        width: 1024,
        height: 1024,
        safety_tolerance: 2,
        seed: Math.floor(Math.random() * 1_000_000),
      }),
    },
    60_000
  );
  if (!submit.ok) {
    throw new Error(`Flux respondió ${submit.status}: ${(await submit.text()).slice(0, 200)}`);
  }
  const task = await submit.json();
  const taskId = task?.id;
  if (!taskId) throw new Error('Flux no devolvió id de tarea');

  // Flux es asíncrono: se consulta el estado hasta que la imagen esté lista.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const poll = await fetchWithTimeout(
      `https://api.bfl.ml/v1/get_result?id=${encodeURIComponent(taskId)}`,
      { headers: { 'x-key': apiKey } },
      30_000
    );
    if (!poll.ok) continue;
    const result = await poll.json();
    const status = result?.status;
    if (status === 'Ready' && result?.result?.sample) {
      const bytes = await downloadBytes(result.result.sample);
      return { url: persistImage(bytes, title), provider: 'flux', sourceUrl: result.result.sample };
    }
    if (status === 'Error' || status === 'Content Moderated' || status === 'Content Flagged') {
      throw new Error(`Flux rechazó la imagen (${status})`);
    }
  }
  throw new Error('Flux: tiempo de espera agotado generando la imagen');
}
