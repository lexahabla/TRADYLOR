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

export interface EnrichedText {
  description: string;
  specs: Record<string, string>;
  pros: string[];
  cons: string[];
  verdict: string;
  category?: string;
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
  '- Nunca inventes precios, números de ventas ni especificaciones que no puedas deducir del texto de entrada.',
  '- Tono divulgativo y directo, sin superlativos comerciales ("lo mejor del mercado", "imbatible") y sin llamadas a la acción de compra.',
  '- pros: 3 a 5 puntos concretos y verificables.',
  '- cons: 2 a 4 puntos reales o de contexto (disponibilidad, garantía, accesorios), no relleno.',
  '- verdict: 1 o 2 frases neutras indicando para quién encaja el producto.',
  '- specs: entre 4 y 8 pares clave/valor cortos (p. ej. "Autonomía": "Hasta 30 horas"). Omite las que no conozcas.',
  '- category: nombre corto de categoría (ej. "Audio & Sonido").',
  '- description: 2 o 3 frases en español, orientadas a decisión de compra.',
  'Responde SOLO con JSON válido con claves: description, specs, pros, cons, verdict, category.',
].join('\n');

/**
 * Paso 1 — Enriquecimiento de texto con IA.
 * Genera descripción, ficha técnica estructurada, pros, contras y veredicto neutral.
 */
export async function enrichProductText(input: {
  title: string;
  description?: string;
  category?: string;
  url?: string;
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
    // Groq es compatible con la API de OpenAI; modelo rápido y con nivel gratuito.
    const model = env('GROQ_MODEL') || 'llama-3.3-70b-versatile';
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
    description: String(raw?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
    specs,
    pros: toStringArray(raw?.pros, 5),
    cons: toStringArray(raw?.cons, 4),
    verdict: String(raw?.verdict ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
    category: String(raw?.category ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || undefined,
  };
}

/**
 * Prompt de fotografía comercial (fondo #F8F9FA, encuadre con margen de seguridad
 * del 15% y sin recorte de bordes) para que la imagen encaje en los contenedores
 * aspect-square con object-contain de la interfaz.
 */
export function buildProductImagePrompt(title: string): string {
  return `High-end commercial product photography of ${title}. Centered studio shot with professional lighting, crisp details, and soft realistic shadows underneath. Studio light gray or off-white clean minimalist background (#F8F9FA). Perfect composition: centered product with 15% safety margin padding on all sides (no edge cropping). Ultra-sharp focus, 8k resolution, photorealistic, professional e-commerce product asset.`;
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
