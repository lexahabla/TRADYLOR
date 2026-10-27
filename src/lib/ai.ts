import fs from 'node:fs';
import path from 'node:path';
import { CLIENT_IMAGES_DIR, IMAGES_DIR } from './paths';
import { storedKeyForEnv } from './aiKeysStore';

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

export type TextProvider = 'openai' | 'anthropic' | 'groq' | 'nvidia' | 'openrouter';
export type ImageProvider = 'openai' | 'flux';

/**
 * Proveedores de texto con modelos gratuitos, en orden de preferencia para el
 * fallback automático. Cuando un proveedor gratuito responde 410 Gone o 404
 * Not Found (modelo obsoleto/desactivado), el sistema conmuta al siguiente
 * de esta lista que tenga clave configurada.
 */
export const FREE_TEXT_PROVIDERS: TextProvider[] = ['groq', 'nvidia', 'openrouter'];

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
  /** Texto libre de ficha técnica (consulta en la página del producto). */
  techSheet?: string;
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

/** Variables de IA cuyo valor puede venir también del almacén del panel. */
const AI_KEY_ENVS = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GROQ_API_KEY',
  'NVIDIA_API_KEY',
  'OPENROUTER_API_KEY',
]);

/** Lee variables de entorno con el patrón del proyecto (process.env ?? import.meta.env). */
export function env(name: string): string {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  const fromAstro = (import.meta.env as Record<string, string | undefined>)[name];
  if (fromAstro !== undefined && fromAstro !== '') return fromAstro;
  // Fallback: claves guardadas desde el panel (Transparencia › Conectividad IA).
  if (AI_KEY_ENVS.has(name)) {
    try {
      return storedKeyForEnv(name);
    } catch {
      return '';
    }
  }
  return '';
}

export function textProvider(): TextProvider {
  const value = env('TEXT_AI_PROVIDER').toLowerCase();
  if (value === 'anthropic') return 'anthropic';
  if (value === 'groq') return 'groq';
  if (value === 'nvidia') return 'nvidia';
  if (value === 'openrouter') return 'openrouter';
  return 'openai';
}

export function imageProvider(): ImageProvider {
  return env('IMAGE_AI_PROVIDER').toLowerCase() === 'flux' ? 'flux' : 'openai';
}

export function hasTextCredentials(providerOverride?: TextProvider): boolean {
  const provider = providerOverride ?? textProvider();
  if (provider === 'anthropic') return Boolean(env('ANTHROPIC_API_KEY'));
  if (provider === 'groq') return Boolean(env('GROQ_API_KEY'));
  if (provider === 'nvidia') return Boolean(env('NVIDIA_API_KEY'));
  if (provider === 'openrouter') return Boolean(env('OPENROUTER_API_KEY'));
  return Boolean(env('OPENAI_API_KEY'));
}

/** Clave de entorno que necesita cada proveedor de texto (para mensajes de error). */
function textKeyEnvName(provider: TextProvider): string {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (provider === 'groq') return 'GROQ_API_KEY';
  if (provider === 'nvidia') return 'NVIDIA_API_KEY';
  if (provider === 'openrouter') return 'OPENROUTER_API_KEY';
  return 'OPENAI_API_KEY';
}

/**
 * Configuración de los proveedores compatibles con la API de OpenAI
 * (openai, groq, nvidia, openrouter): mismo contrato, distinto endpoint,
 * clave y modelo por defecto. NVIDIA y OpenRouter no admiten
 * `response_format: json_object` en todos sus modelos, así que `jsonMode`
 * sólo se activa donde es seguro (OpenAI y Groq).
 */
interface OpenAiCompatConfig {
  url: string;
  key: string;
  model: string;
  label: string;
  jsonMode: boolean;
  extraHeaders?: Record<string, string>;
}

function openAiCompat(provider: TextProvider, forcedModel?: string): OpenAiCompatConfig {
  if (provider === 'groq') {
    return {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: env('GROQ_API_KEY'),
      model: forcedModel || env('GROQ_MODEL') || 'openai/gpt-oss-120b',
      label: 'Groq',
      jsonMode: true,
    };
  }
  if (provider === 'nvidia') {
    return {
      url: 'https://integrate.api.nvidia.com/v1/chat/completions',
      key: env('NVIDIA_API_KEY'),
      model: forcedModel || env('NVIDIA_MODEL') || 'meta/llama-3.3-70b-instruct',
      label: 'NVIDIA',
      jsonMode: false,
    };
  }
  if (provider === 'openrouter') {
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      key: env('OPENROUTER_API_KEY'),
      model: forcedModel || env('OPENROUTER_MODEL') || 'deepseek/deepseek-chat-v3-0324:free',
      label: 'OpenRouter',
      jsonMode: false,
      extraHeaders: { 'HTTP-Title': 'Tradylor' },
    };
  }
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    key: env('OPENAI_API_KEY'),
    model: forcedModel || env('OPENAI_MODEL') || 'gpt-4o-mini',
    label: 'OpenAI',
    jsonMode: true,
  };
}

/** Mensaje de chat estándar (compatible con OpenAI y Anthropic). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Llamada de chat a un proveedor compatible con OpenAI. */
async function callOpenAiCompat(
  provider: TextProvider,
  opts: {
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    forcedModel?: string;
    timeoutMs?: number;
    /** Sobrescribe el jsonMode del proveedor (útil para chat libre que no necesita JSON). */
    jsonMode?: boolean;
  }
): Promise<string> {
  const compat = openAiCompat(provider, opts.forcedModel);
  const body: Record<string, unknown> = {
    model: compat.model,
    temperature: opts.temperature ?? 0.4,
    messages: opts.messages,
  };
  // jsonMode de las opciones tiene prioridad sobre el del proveedor
  const useJsonMode = opts.jsonMode ?? compat.jsonMode;
  if (useJsonMode) body.response_format = { type: 'json_object' };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  const response = await fetchWithTimeout(
    compat.url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${compat.key}`,
        ...(compat.extraHeaders || {}),
      },
      body: JSON.stringify(body),
    },
    opts.timeoutMs ?? 60_000
  );
  if (!response.ok) {
    throw new Error(`${compat.label} respondió ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content ?? '';
}

/**
 * Chat multi-turno con el proveedor de IA configurado (o uno forzado).
 * Lo usa la consola del panel (`/api/admin/ai-console`); lanza si no hay
 * credenciales o el proveedor responde con error.
 */
export async function chatComplete(
  messages: ChatMessage[],
  opts: { provider?: TextProvider; model?: string; temperature?: number; timeoutMs?: number; jsonMode?: boolean } = {}
): Promise<string> {
  const requested = opts.provider ?? textProvider();
  if (!hasTextCredentials(requested)) {
    throw new Error(`Falta ${textKeyEnvName(requested)} (entorno o claves del panel) para conversar con ${requested}`);
  }

  /** Intenta una llamada real a un proveedor; relanza si el error NO es 410/404. */
  const tryProvider = async (provider: TextProvider, model: string | undefined): Promise<string> => {
    if (!hasTextCredentials(provider)) {
      throw new Error(`Falta ${textKeyEnvName(provider)} (entorno o claves del panel) para conversar con ${provider}`);
    }
    if (provider === 'anthropic') {
      const modelName = model?.trim() || env('ANTHROPIC_MODEL') || 'claude-3-5-sonnet-latest';
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const turns = messages.filter((m) => m.role !== 'system');
      const response = await fetchWithTimeout(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: anthropicHeaders(),
          body: JSON.stringify({
            model: modelName,
            max_tokens: 1500,
            temperature: opts.temperature ?? 0.6,
            ...(system ? { system } : {}),
            messages: turns.map((m) => ({ role: m.role, content: m.content })),
          }),
        },
        opts.timeoutMs ?? 90_000
      );
      if (!response.ok) {
        throw new Error(`Anthropic respondió ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const payload = await response.json();
      return (payload?.content ?? []).map((block: any) => block?.text ?? '').join('');
    }
    return callOpenAiCompat(provider, {
      messages,
      temperature: opts.temperature ?? 0.6,
      forcedModel: model?.trim() || undefined,
      timeoutMs: opts.timeoutMs ?? 90_000,
      jsonMode: opts.jsonMode,
    });
  };

  /** Candidatos para fallback: el proveedor solicitado primero, luego los
   *  gratuitos restantes que tengan clave, en orden de preferencia. */
  const isFree = FREE_TEXT_PROVIDERS.includes(requested);
  const candidates: TextProvider[] = isFree
    ? [requested, ...FREE_TEXT_PROVIDERS.filter((p) => p !== requested)]
    : [requested];

  let lastError: unknown;
  for (const provider of candidates) {
    if (!hasTextCredentials(provider)) continue;
    // Sólo se reenvía el modelo explícito al proveedor solicitado; los demás
    // usan su modelo por defecto (los modelos son específicos de cada proveedor).
    const modelToUse = provider === requested ? opts.model : undefined;
    try {
      return await tryProvider(provider, modelToUse);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isGoneOrNotFound = /respondió (410|404)\b/.test(msg);
      if (!isGoneOrNotFound) throw error;
      lastError = error;
      // continuar con el siguiente candidato (fallback automático)
    }
  }
  throw lastError;
}

export function hasImageCredentials(providerOverride?: ImageProvider): boolean {
  const provider = providerOverride ?? imageProvider();
  return provider === 'flux' ? Boolean(env('FLUX_API_KEY')) : Boolean(env('OPENAI_API_KEY'));
}

/**
 * Cabeceras de la API de Anthropic.
 *
 * `ANTHROPIC_WORKSPACE_ID` es opcional: sólo hace falta cuando la clave NO está
 * vinculada a un workspace (claves de administración de la organización). En ese
 * caso Anthropic responde 400 con "This API key is not scoped to a workspace,
 * so this request must include the anthropic-workspace-id header".
 */
function anthropicHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': env('ANTHROPIC_API_KEY'),
    'anthropic-version': '2023-06-01',
  };
  const workspace = env('ANTHROPIC_WORKSPACE_ID').trim();
  if (workspace) headers['anthropic-workspace-id'] = workspace;
  return headers;
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
  'Tu trabajo es preparar una ficha de producto honesta y neutral en el tono (estilo redacción técnica, no publicitaria), pero pensada para VENDER: la tienda vive de que el lector decida comprar.',
  'Reglas estrictas:',
  '- Nunca inventes especificaciones ni números de ventas que no puedas deducir del texto de entrada. Si recibes "Especificaciones ya extraídas de la página del comercio (eBay/AliExpress/Amazon/etc.)", esas son la fuente de verdad de la ficha técnica: tu trabajo es ordenarlas y redactarlas, no inventar otras ni contradecirlas (solo puedes añadir muy pocas adicionales si son evidentes por el contexto).',
  '- Tono divulgativo y directo, sin superlativos comerciales ("lo mejor del mercado", "imbatible") y sin llamadas a la acción de compra: la persuasión viene de los HECHOS (pros concretos y bien elegidos), no del tono.',
  '- title: título SINTETIZADO en español, de 35 a 70 caracteres. REGLA OBLIGATORIA: empieza SIEMPRE definiendo qué es el producto (su categoría o naturaleza) antes que la marca o el modelo. Ejemplos: "SSD 1TB" → "Disco duro SSD 1TB"; "Power bank 10000mAh" → "Batería portátil Power bank 10000mAh"; "Anker 737" (una batería externa) → "Batería externa Anker 737"; "USB-C a HDMI 2m" → "Cable adaptador USB-C a HDMI 2m"; "Xiaomi Pro 2" (un patinete eléctrico) → "Patinete eléctrico Xiaomi Pro 2"; "40L impermeable" (una mochila) → "Mochila impermeable 40L"; "65W GaN" (un cargador) → "Cargador rápido 65W GaN"; "Cecotec Conga" → "Robot aspirador Cecotec Conga"; "Air Fryer 5L" → "Freidora de aire Cecotec 5L". Estructura: [Categoría/Naturaleza del producto] + [Marca / Modelo] + [Capacidad o rasgo clave]. Sin precios ni argumentos comerciales.',
  '- pros: 3 a 5 puntos concretos, verificables y persuasivos para la decisión de compra (precio/descuento, valoración, autonomía, materiales, garantía, envío...). Elige siempre los datos que más ayuden a vender el producto.',
  '- cons: 1 a 3 matices menores, constructivos y poco disuasorios (p. ej. "Disponible en pocas opciones de color", "Cable de carga de longitud estándar", "Requiere configuración inicial sencilla", "Manual en formato digital"), evitando siempre aspectos graves o disuasorios que desinteresen al usuario o perjudiquen la conversión de compra.',
  '- REGLA OBLIGATORIA DE VENTA (muy importante): cons SIEMPRE debe tener MENOS elementos que pros, nunca el mismo número ni más. Si tienes dudas entre añadir un contra más o no, no lo añadas.',
  '- verdict: 1 o 2 frases neutras indicando para quién encaja el producto.',
  '- specs: entre 4 y 8 pares clave/valor cortos (p. ej. "Autonomía": "Hasta 30 horas"). Si te dieron especificaciones del comercio, prioriza usar esas tal cual (o muy ligeramente reformateadas); si no, omite las que no conozcas.',
  '- techSheet: párrafo de 3 a 6 líneas en español con datos objetivos de la ficha técnica (materiales, medidas, peso, conectividad, compatibilidades, garantía, contenido de la caja). Usa " · " para separar datos. Básate en las especificaciones del comercio si te las dieron; no inventes cifras que no conozcas.',
  '- category: nombre corto de categoría (ej. "Audio & Sonido").',
  '- description: 2 o 3 frases en español de REDACCIÓN TÉCNICA CONCISA, orientadas a decisión de compra. Si se aporta una descripción previa, reescríbela mejorando claridad, precisión y fluidez (sin inventar datos ni superlativos).',
  '- pricing: objeto { currentPrice, originalPrice } en euros. Si en la entrada ya hay un precio de oferta, consérvalo EXACTAMENTE como currentPrice y genera un originalPrice superior con un descuento realista (entre 15% y 35%, nunca más del 40%). Si no hay ningún precio, propón un par realista para la categoría del producto. Formato: dos decimales terminando en ,99 o ,95. originalPrice SIEMPRE mayor que currentPrice. Descuentos absurdos (>50%) o mínimos (<10%) quedan prohibidos.',
  'Responde SOLO con JSON válido con claves: title, description, specs, techSheet, pros, cons, verdict, category, pricing.',
].join('\n');

/**
 * Orden de candidatos para el fallback automático de texto: el proveedor por
 * defecto (o el forzado explícitamente) se intenta primero; si falla (límite
 * de peticiones agotado, modelo caído/retirado, error de red...) se prueban
 * estos por orden, saltando los que no tengan clave configurada. Sólo se usa
 * cuando el llamante NO fuerza un proveedor concreto: una elección explícita
 * (p. ej. desde el Pipeline) se respeta siempre, sin fallback.
 */
const TEXT_PROVIDER_FALLBACK_ORDER: TextProvider[] = ['openai', 'anthropic', 'groq', 'nvidia', 'openrouter'];

/**
 * Paso 1 — Enriquecimiento de texto con IA.
 * Genera descripción, ficha técnica estructurada, pros/contras, veredicto
 * y par de precios (oferta + original) con descuento realista.
 *
 * Con fallback automático entre proveedores: si no se fuerza `options.provider`
 * y el proveedor por defecto falla (p. ej. Groq agota su límite de peticiones
 * en un enriquecimiento masivo), se reintenta con cualquier otro proveedor que
 * tenga credenciales configuradas antes de rendirse. Así "Enriquecer" en lote
 * no degrada en silencio a la plantilla local a mitad de catálogo.
 */
export async function enrichProductText(input: {
  title: string;
  description?: string;
  category?: string;
  url?: string;
  /** Precio de oferta de referencia (si el scraping/usuario ya lo conoce). */
  price?: number;
  originalPrice?: number;
  /** Especificaciones ya extraídas de la página del comercio (scraping): se
   *  pasan a la IA como fuente de verdad para specs/techSheet, para que no
   *  tenga que inventarlas (la ficha técnica la marca el comercio, no la IA). */
  specs?: Record<string, string>;
}, options: { provider?: TextProvider; model?: string } = {}): Promise<EnrichedText> {
  const forcedProvider = Boolean(options.provider);
  // El modelo sólo se reenvía al proveedor solicitado explícitamente: los
  // modelos son específicos de cada proveedor y los límites diarios de Groq
  // son POR MODELO (quedarse sin TPD en uno no agota el resto).
  const forcedModel = options.model?.trim();
  const primary = options.provider ?? textProvider();
  if (!hasTextCredentials(primary)) {
    throw new Error(`Falta ${textKeyEnvName(primary)} para enriquecer el texto`);
  }

  const specsEntries = input.specs ? Object.entries(input.specs).filter(([, v]) => String(v ?? '').trim()) : [];

  const userContext = [
    `Producto: ${input.title}`,
    input.category ? `Categoría sugerida: ${input.category}` : '',
    input.description ? `Descripción disponible: ${input.description}` : '',
    input.price ? `Precio de oferta de referencia: ${input.price.toFixed(2)} EUR` : '',
    input.originalPrice ? `Precio original de referencia: ${input.originalPrice.toFixed(2)} EUR` : '',
    input.url ? `Página de origen: ${input.url}` : '',
    specsEntries.length
      ? `Especificaciones ya extraídas de la página del comercio (fuente de verdad, no las contradigas): ${specsEntries.map(([k, v]) => `${k}: ${v}`).join(' · ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const callProvider = async (provider: TextProvider, modelForThis: string | undefined): Promise<EnrichedText> => {
    if (provider === 'anthropic') {
      const model = modelForThis || env('ANTHROPIC_MODEL') || 'claude-3-5-sonnet-latest';
      const response = await fetchWithTimeout(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: anthropicHeaders(),
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

    // Compatibles con OpenAI: openai, groq (plan gratuito), nvidia (NIM) y
    // openrouter (modelos ":free"). Mismo contrato, distinto endpoint/modelo.
    const text = await callOpenAiCompat(provider, {
      messages: [
        { role: 'system', content: TEXT_SYSTEM_PROMPT },
        { role: 'user', content: userContext },
      ],
      temperature: 0.4,
      forcedModel: modelForThis,
      timeoutMs: 60_000,
    });
    return normalizeEnrichedText(parseLooseJson(text));
  };

  // Proveedor forzado explícitamente (p. ej. una tanda del Pipeline que elige
  // "openai" a propósito para evitar Groq): se respeta sin fallback.
  if (forcedProvider) {
    return callProvider(primary, forcedModel);
  }

  // Automático: el por defecto primero y, si falla, cualquier otro proveedor
  // con credenciales configuradas (sin repetir el ya intentado).
  const candidates = [primary, ...TEXT_PROVIDER_FALLBACK_ORDER.filter((p) => p !== primary)];
  let lastError: unknown;
  for (const candidate of candidates) {
    if (!hasTextCredentials(candidate)) continue;
    try {
      return await callProvider(candidate, candidate === primary ? forcedModel : undefined);
    } catch (error) {
      lastError = error;
      // Se prueba el siguiente proveedor disponible (fallback automático).
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Ningún proveedor de IA de texto disponible pudo enriquecer el producto.');
}

/**
 * Combina una lista de pros/cons de la IA con la lista local, exigiendo un
 * mínimo de elementos. Antes el criterio era "todo o nada": si la IA devolvía
 * aunque fuera 1 solo elemento, se usaba ese array completo descartando los
 * locales (que podían tener 3-5 más sólidos). Los modelos gratuitos (Groq y
 * similares) no siempre cumplen la instrucción de "3 a 5 pros" al pie de la
 * letra, sobre todo bajo carga en un enriquecimiento masivo: con el criterio
 * antiguo, esas respuestas cortas se aceptaban como "éxito" y, al forzar
 * después que haya más pros que contras (ver enforceMoreProsThanCons), los
 * contras se recortaban a 0 o casi 0.
 *
 * Con esta función: si la IA ya alcanza el mínimo, se usa tal cual (su
 * redacción suele ser mejor); si se queda corta, se completa con elementos
 * locales que no se solapen textualmente, SIN descartar lo que la IA sí
 * aportó.
 */
export function mergeWithMinimum(aiList: string[], localList: string[], minimum: number): string[] {
  if (aiList.length >= minimum) return aiList;
  if (!aiList.length) return localList;
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const seen = new Set(aiList.map(normalize));
  const merged = [...aiList];
  for (const candidate of localList) {
    if (merged.length >= minimum) break;
    const key = normalize(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }
  return merged;
}

/**
 * Combina una ficha LOCAL (base, siempre presente, gratis) con el resultado
 * de la IA (overlay opcional): la IA mejora lo local, pero nunca borra datos
 * con campos vacíos. Patrón único compartido por el alta/edición de producto
 * (`add-product.ts`), "Construir Catálogo" (`build-catalog.ts`) y el Pipeline
 * (`stageCategorize.ts`): los tres deben enriquecer EXACTAMENTE igual.
 */
export function overlayEnrichedText(local: EnrichedText, ai: EnrichedText): EnrichedText {
  const pick = (aiValue: any, localValue: any) => {
    if (typeof aiValue === 'string') return aiValue.trim() ? aiValue : localValue;
    if (Array.isArray(aiValue)) return aiValue.length ? aiValue : localValue;
    return aiValue ?? localValue;
  };
  // Pros: mínimo 3 (lo que pide el prompt a la IA). Cons: cualquier respuesta
  // no vacía de la IA se respeta tal cual (el prompt sólo pide 1-3), y sólo
  // se recurre a los locales si la IA no devolvió ninguno.
  const mergedPros = mergeWithMinimum(
    Array.isArray(ai.pros) ? ai.pros : [],
    Array.isArray(local.pros) ? local.pros : [],
    3
  );
  const { pros, cons } = enforceMoreProsThanCons(mergedPros, pick(ai.cons, local.cons));
  return {
    ...local,
    ...ai,
    title: pick(ai.title, local.title),
    description: pick(ai.description, local.description),
    verdict: pick(ai.verdict, local.verdict),
    category: pick(ai.category, local.category),
    // La ficha técnica la marca el comercio: lo ya extraído localmente
    // prevalece sobre lo que "adivine" la IA para las mismas claves; la IA
    // sólo aporta claves adicionales que falten.
    specs: { ...(ai.specs ?? {}), ...(local.specs ?? {}) },
    techSheet: pick(ai.techSheet, local.techSheet),
    pros,
    cons,
    pricing: ai.pricing ?? local.pricing,
  };

}

/**
 * Garantiza que SIEMPRE haya más pros que contras: el objetivo de la ficha es
 * vender, así que un empate o unos contras de más (por un despiste de la IA o
 * de la plantilla local) nunca debe llegar a publicarse. No inventa pros
 * nuevos: sólo recorta contras hasta dejar como máximo pros.length - 1.
 */
export function enforceMoreProsThanCons(pros: string[], cons: string[]): { pros: string[]; cons: string[] } {
  const maxCons = Math.max(0, pros.length - 1);
  return { pros, cons: cons.length > maxCons ? cons.slice(0, maxCons) : cons };
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

  // Siempre más pros que contras: la ficha está para vender (ver enforceMoreProsThanCons).
  const { pros, cons } = enforceMoreProsThanCons(toStringArray(raw?.pros, 5), toStringArray(raw?.cons, 3));

  return {
    title: String(raw?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || undefined,
    description: String(raw?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
    specs,
    techSheet: String(raw?.techSheet ?? '').replace(/\s+/g, ' ').trim().slice(0, 800) || undefined,
    pros,
    cons,
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

// ─── Extracción de ficha desde el HTML de una página de producto ─────────────

export interface ProductPageAiFields {
  brand?: string;
  rating?: number;
  reviewsCount?: number;
  specs?: Record<string, string>;
  fulfillmentProvider?: string;
  shippingInfo?: string;
  shippingDays?: number;
  buyNowUrl?: string;
  /** Índices (1-based) de las imágenes candidatas que son fotos del producto. */
  galleryIndices?: number[];
}

const PAGE_EXTRACT_SYSTEM_PROMPT = [
  'Eres un extractor de datos de fichas de producto de tiendas online (Amazon, PcComponentes, MediaMarkt, El Corte Inglés, AliExpress...).',
  'Recibirás: la URL del producto, texto visible de la página (ya sin etiquetas HTML) y una lista numerada de URLs de imágenes candidatas.',
  'Devuelve SOLO JSON válido con estas claves (usa null cuando no haya dato fiable en el texto):',
  '- brand: marca del producto (string corto, p.ej. "Samsung").',
  '- rating: valoración media 0-5 (número; si el texto trae porcentaje súbelo a escala 0-5).',
  '- reviewsCount: nº entero de opiniones/resenas.',
  '- specs: objeto con 3-8 pares clave/valor cortos (p.ej. {"Pantalla":"6.7\\" AMOLED"}).',
  '- fulfillmentProvider: vendedor/distribuidor responsable del envío y pago (p.ej. "Vendido por TechStore", nombre del marketplace seller).',
  '- shippingInfo: texto tal cual del plazo/condiciones de envío (p.ej. "Llega gratis el martes").',
  '- shippingDays: días enteros de entrega estimados (si pone "2-4 días" devuelve 4).',
  '- buyNowUrl: URL absoluta de compra directa/checkout si aparece en el texto; si no, null.',
  '- galleryIndices: array de índices (empezando en 1) de la lista de imágenes que sean FOTOS DEL PRODUCTO (frente, dorso, laterales, detalles); excluye logos, iconos, banners, personas y placeholders.',
  'Nunca inventes datos que no estén en el texto. Responde SOLO el JSON.',
].join('\n');

/** Quita etiquetas HTML y colapsa espacios para mandar sólo texto legible a la IA. */
function htmlToDigestText(html: string, maxChars: number): string {
  // Las tiendas SPA (MediaMarkt, PcComponentes, AliExpress…) guardan los datos
  // del producto dentro de <script> como JSON embebido. Antes de descartar esos
  // scripts se arrancan los pares clave/valor relevantes para que la IA los vea.
  const scriptSnippets: string[] = [];
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  const keyRe =
    /"?\b(?:brand|marca|brandName|seller|vendor|vendorName|soldBy|soldByInfo|merchant|rating|ratingValue|averageRating|starRating|reviewCount|reviewsCount|reviewNum|reviews|evaluateRate|evaluateSummary|price|salePrice|originalPrice|listPrice|discount|shipping|shippingFee|shippingInfo|shippingMethod|delivery|deliveryInfo|shipToDays|checkoutUrl|buyNowUrl|addToCartUrl|cartUrl|orderUrl|imageUrl|imageUrls|imageList|mainImage|images|gallery|videoUrl)"?\s*:\s*("(?:[^"\\]|\\.){1,300}"|\d+(?:\.\d+)?|true|false)/gi;
  for (const script of scripts) {
    let match: RegExpExecArray | null;
    while ((match = keyRe.exec(script)) !== null) {
      if (scriptSnippets.length >= 60) break;
      scriptSnippets.push(`${match[1]}: ${match[2]}`);
    }
  }

  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  const digest = text.slice(0, maxChars);
  if (!scriptSnippets.length) return digest;
  return `${digest}\n\nDATOS EMBEBIDOS EN SCRIPTS:\n${scriptSnippets.join('\n')}`.slice(0, maxChars + 3_000);
}

/**
 * Paso 2 (fallback) — Extracción de ficha con IA a partir del HTML de la página.
 *
 * Se usa cuando el scraping por regex no consiguió marca, specs, distribuidor,
 * valoración, opiniones, envío o la galería completa: la IA lee el texto de la
 * página (y una lista de imágenes candidatas) y devuelve los campos faltantes.
 */
export async function extractProductPageFields(input: {
  url: string;
  merchant?: string;
  knownTitle?: string;
  html: string;
  candidateImages?: string[];
  missing?: string[];
}): Promise<ProductPageAiFields> {
  if (!hasTextCredentials()) {
    throw new Error('Falta la clave de la IA de texto para complementar el análisis de la página');
  }

  const digest = htmlToDigestText(input.html, 14_000);
  const images = (input.candidateImages ?? []).slice(0, 40);
  const userContext = [
    `URL del producto: ${input.url}`,
    input.merchant ? `Comercio: ${input.merchant}` : '',
    input.knownTitle ? `Título ya detectado: ${input.knownTitle}` : '',
    input.missing?.length ? `Completar preferentemente: ${input.missing.join(', ')}` : '',
    '',
    'TEXTO DE LA PÁGINA:',
    digest || '(sin texto)',
    '',
    images.length
      ? 'IMÁGENES CANDIDATAS (numéralas desde 1):\n' + images.map((u, i) => `${i + 1}. ${u}`).join('\n')
      : '(sin imágenes candidatas)',
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  const provider = textProvider();
  let raw: any;

  if (provider === 'anthropic') {
    const model = env('ANTHROPIC_MODEL') || 'claude-3-5-sonnet-latest';
    const response = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: anthropicHeaders(),
        body: JSON.stringify({ model, max_tokens: 1000, temperature: 0.2, system: PAGE_EXTRACT_SYSTEM_PROMPT, messages: [{ role: 'user', content: userContext }] }),
      },
      55_000
    );
    if (!response.ok) {
      throw new Error(`Anthropic respondió ${response.status}`);
    }
    const payload = await response.json();
    raw = parseLooseJson((payload?.content ?? []).map((block: any) => block?.text ?? '').join(''));
  } else {
    raw = parseLooseJson(await callOpenAiCompat(provider, {
      messages: [
        { role: 'system', content: PAGE_EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: userContext },
      ],
      temperature: 0.2,
      timeoutMs: 55_000,
    }));
  }

  return normalizePageFields(raw, images);
}

/** Sanea la respuesta del extractor de página (tipos, rangos y límites). */
function normalizePageFields(raw: any, candidateImages: string[]): ProductPageAiFields {
  const str = (value: unknown, max: number): string | undefined => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, max) : undefined;
  };
  const numIn = (value: unknown, min: number, max: number): number | undefined => {
    if (value == null || value === '') return undefined;
    const parsed = Number(String(value).replace(/[^\d.,-]/g, '').replace(',', '.'));
    if (!Number.isFinite(parsed)) return undefined;
    return Math.min(max, Math.max(min, parsed));
  };

  const specs: Record<string, string> = {};
  if (raw?.specs && typeof raw.specs === 'object' && !Array.isArray(raw.specs)) {
    for (const [key, value] of Object.entries(raw.specs as Record<string, unknown>)) {
      const label = str(key, 60);
      const text = str(value, 120);
      if (label && text) specs[label] = text;
      if (Object.keys(specs).length >= 8) break;
    }
  }

  const galleryIndices = Array.isArray(raw?.galleryIndices)
    ? (raw.galleryIndices as unknown[])
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= candidateImages.length)
    : [];

  return {
    brand: str(raw?.brand, 60),
    rating: numIn(raw?.rating, 0, 5) != null ? Math.round(numIn(raw!.rating, 0, 5)! * 10) / 10 : undefined,
    reviewsCount: numIn(raw?.reviewsCount, 0, 1_000_000) != null ? Math.round(numIn(raw!.reviewsCount, 0, 1_000_000)!) : undefined,
    specs: Object.keys(specs).length ? specs : undefined,
    fulfillmentProvider: str(raw?.fulfillmentProvider, 80),
    shippingInfo: str(raw?.shippingInfo, 160),
    shippingDays: numIn(raw?.shippingDays, 0, 365) != null ? Math.round(numIn(raw!.shippingDays, 0, 365)!) : undefined,
    buyNowUrl: str(raw?.buyNowUrl, 500) && /^https?:\/\//i.test(String(raw.buyNowUrl)) ? String(raw.buyNowUrl).trim() : undefined,
    galleryIndices: galleryIndices.length ? galleryIndices : undefined,
  };
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

  // Anteponer explícitamente categoría o naturaleza del producto si inicia abreviado
  if (/^\b(?:nvme|m\.?2\s+ssd|ssd)\b/i.test(t) && !/^\bdisco\s+duro\b/i.test(t)) {
    t = `Disco duro ${t}`;
  } else if (/^\b(?:crucial|samsung\s+9[89]0|kingston|wd_black|sandisk)\b/i.test(t) && /\b(?:ssd|nvme|1tb|2tb|500gb)\b/i.test(t) && !/^\bdisco\s+duro\b/i.test(t)) {
    t = `Disco duro SSD ${t}`;
  } else if (/^\bpower\s*bank\b/i.test(t) && !/^\bbater[íi]a\b/i.test(t)) {
    t = `Batería portátil ${t}`;
  } else if (/^\bbattery\b/i.test(t) && !/^\bbater[íi]a\b/i.test(t)) {
    t = `Batería externa ${t}`;
  } else if (/^\b(?:tws|earbuds?)\b/i.test(t) && !/^\bauriculares\b/i.test(t)) {
    t = `Auriculares inalámbricos ${t}`;
  } else if (/^\bsmartwatch\b/i.test(t) && !/^\breloj\b/i.test(t)) {
    t = `Reloj inteligente ${t}`;
  } else if (/^\b(?:air\s*fryer|airfryer)\b/i.test(t) && !/^\bfreidora\b/i.test(t)) {
    t = `Freidora de aire ${t.replace(/^\b(?:air\s*fryer|airfryer)\b\s*/i, '')}`.trim();
  } else if (/^\b(?:conga|roomba)\b/i.test(t) && !/^\brobot\s+aspirador\b/i.test(t)) {
    t = `Robot aspirador ${t}`;
  } else if (/^\b(?:usb-?c|usb-?a|micro-?usb|hdmi|lightning|type-?c)\b/i.test(t) && !/^\bcable\b/i.test(t)) {
    t = `Cable ${t}`;
  } else if (/^\bscooter\b/i.test(t) && !/^\bpatinete\b/i.test(t)) {
    t = `Patinete eléctrico ${t.replace(/^\bscooter\b\s*/i, '')}`.trim();
  } else if (/^\bbackpack\b/i.test(t) && !/^\bmochila\b/i.test(t)) {
    t = `Mochila ${t.replace(/^\bbackpack\b\s*/i, '')}`.trim();
  } else if (/^\b(?:charger|gan\s*charger)\b/i.test(t) && !/^\bcargador\b/i.test(t)) {
    t = `Cargador ${t}`;
  }

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
  'Sintetiza y optimiza el título del producto para tarjetas y tablas de productos.',
  'Reglas estrictas:',
  `- Máximo ${MAX_TITLE_LENGTH} caracteres (entre 35 y 70 caracteres).`,
  '- REGLA OBLIGATORIA: empieza SIEMPRE definiendo qué es el producto (su categoría o naturaleza) antes que la marca o el modelo (ejemplos: "SSD 1TB" → "Disco duro SSD 1TB"; "Power bank 10000mAh" → "Batería portátil Power bank 10000mAh"; "Anker 737" (una batería externa) → "Batería externa Anker 737"; "USB-C a HDMI 2m" → "Cable adaptador USB-C a HDMI 2m"; "Xiaomi Pro 2" (un patinete eléctrico) → "Patinete eléctrico Xiaomi Pro 2"; "40L impermeable" (una mochila) → "Mochila impermeable 40L"; "65W GaN" (un cargador) → "Cargador rápido 65W GaN"; "Air Fryer 5L" → "Freidora de aire Cecotec 5L").',
  '- Estructura: [Categoría/Naturaleza del producto] + [Marca / Modelo] + [Capacidad o rasgo clave].',
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
    throw new Error(`Falta ${textKeyEnvName(provider)} para sintetizar el título`);
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
        headers: anthropicHeaders(),
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
  } else {
    text = await callOpenAiCompat(provider, {
      messages: [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: userContext },
      ],
      temperature: 0.3,
      maxTokens: 150,
      timeoutMs: 45_000,
    });
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
 *
 * Con fallback automático: si no se fuerza `options.provider` y el proveedor
 * configurado por defecto falla (créditos agotados, error del servicio...), se
 * reintenta con el otro proveedor de imagen si tiene clave configurada.
 */
export async function generateProductImage(
  title: string,
  options: { provider?: ImageProvider } = {},
): Promise<ImageGenerationResult> {
  const forcedProvider = Boolean(options.provider);
  const primary = options.provider ?? imageProvider();

  const run = async (provider: ImageProvider): Promise<ImageGenerationResult> => {
    if (provider === 'flux') {
      if (!env('FLUX_API_KEY')) throw new Error('Falta FLUX_API_KEY para generar la imagen con Flux');
      return generateWithFlux(title);
    }
    if (!env('OPENAI_API_KEY')) throw new Error('Falta OPENAI_API_KEY para generar la imagen');
    return generateWithOpenAI(title);
  };

  if (forcedProvider) return run(primary);

  try {
    return await run(primary);
  } catch (error) {
    const alternate: ImageProvider = primary === 'flux' ? 'openai' : 'flux';
    if (!hasImageCredentials(alternate)) throw error;
    try {
      return await run(alternate);
    } catch {
      throw error;
    }
  }
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
