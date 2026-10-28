/**
 * ==============================================================================
 * TRADYLOR — GEMINI GROUNDED SERVICE (Google Search / Web Grounding)
 * ==============================================================================
 * Capa de servicio dedicada (SDK oficial `@google/genai`) que da a los DOS
 * asistentes de IA de Tradylor —la Consola IA del backend (panel admin) y el
 * Asesor IA / Dependiente IA de cara al usuario (widget flotante + Centro de
 * Herramientas)— la capacidad de fundamentar sus respuestas con búsquedas web
 * EN TIEMPO REAL (`googleSearch`), para poder debatir con criterio sobre
 * especificaciones técnicas, lanzamientos, precios de mercado o benchmarks
 * que superen su fecha de corte de entrenamiento.
 *
 * Diseño:
 *   - Módulo independiente y opt-in: si no hay `GEMINI_API_KEY` configurada,
 *     `isGroundingAvailable()` devuelve `false` y los endpoints que lo
 *     consumen (ai-console.ts, asistente-ia.ts, radar/ai-assistant.ts) caen
 *     automáticamente al `chatComplete` de siempre (lib/ai.ts), sin tocar su
 *     comportamiento ni el proveedor de texto por defecto configurado
 *     (Groq/OpenAI/...): esta capacidad es específica de Gemini (es la única
 *     API que integra Google Search como tool de primera clase) y se añade
 *     POR ENCIMA, nunca sustituye al enriquecimiento de productos ni al resto
 *     de proveedores de texto.
 *   - Usa el SDK oficial (`@google/genai`, ya en package.json) en vez de la
 *     llamada REST cruda que usa lib/ai.ts para el resto de usos de Gemini
 *     (enriquecimiento/extracción), porque `tools:[{googleSearch:{}}]` sólo
 *     tiene sentido en una conversación abierta, nunca en una extracción
 *     estructurada: mezclar ambos caminos habría arriesgado el pipeline de
 *     enriquecimiento ya en producción.
 *   - Reintento de modelo igual que lib/ai.ts (gemini-3.6/3.7/3.8 han dado
 *     503/429 bajo demanda real; 3.5 es el valor estable, ver AGENTS.md).
 * ==============================================================================
 */
import { GoogleGenAI } from '@google/genai';
import { env } from './ai';
import type { ChatMessage } from './ai';

/** Mismo criterio de reserva que GEMINI_FALLBACK_MODEL en lib/ai.ts. */
const GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash';
const GROUNDED_DEFAULT_TIMEOUT_MS = 25_000;

export interface GroundingCitation {
  title: string;
  url: string;
}

export interface GroundedChatResult {
  text: string;
  grounded: true;
  /** Consultas que el propio modelo lanzó a Google Search para fundamentar la respuesta. */
  searchQueries: string[];
  /** Fuentes web citadas (deduplicadas, máx. 6). */
  citations: GroundingCitation[];
}

/**
 * Contexto técnico completo de Tradylor. Se antepone a la personalidad de
 * cada asistente (lib/aiPersonas.ts `adminIaSystemPrompt`/`asesorIaSystemPrompt`,
 * que siguen mandando en el tono y las reglas de cada uno) para que, además de
 * su rol, el modelo conozca la arquitectura REAL del proyecto y pueda
 * debatir con criterio en vez de responder en abstracto.
 */
export const TRADYLOR_GROUNDED_CONTEXT = `
# CONTEXTO TÉCNICO DE TRADYLOR (lectura obligatoria antes de responder)

Tradylor.com es un portal de recomendación, curación y comparativas de productos de
alta conversión orientado a marketing de afiliación (Astro 4.x SSR sobre Node,
Docker/EasyPanel, despliegue automático al hacer push a main).

## Herramientas de cara al usuario
- **Mi Radar**: seguimiento de precios/stock y alertas (offline-first: LocalStorage +
  sincronización en la nube con sesión).
- **Perfilador** («SmartMatcherWizard»): NO son "6 perfiles de producto" genéricos, es
  una combinatoria cerrada de 72 resultados = 6 usos (Productividad, Entretenimiento,
  Creatividad, Hogar Inteligente, Movilidad, Fitness y Salud) × 4 presupuestos (hasta
  100€ / 100-400€ / 400-1000€ / +1000€) × 3 prioridades (Precio, Calidad, Equilibrio).
  El resultado es un badge VISUAL "Encaja con tu perfil" en el catálogo: nunca oculta
  productos, sólo resalta.
- **Comparador**: análisis técnico diferencial entre productos del catálogo real.
- **Asesor IA / Dependiente IA** (el asistente que TÚ eres si te invocan de cara al
  usuario, en el widget flotante o en /herramientas/dependiente-ia): sólo puede
  recomendar productos que existan de verdad en el catálogo (por su slug exacto),
  nunca inventar productos, precios ni tiendas.

## Panel de administración («/upayp1b4», lo gestiona el equipo de Tradylor)
1. **Extracción & Alta de Producto**: pega una URL y se scrapea OpenGraph/JSON-LD/HTML
   (título, precio, marca, specs, envío...); con el botón "Enriquecer con IA" se genera
   título sintetizado, descripción, ficha técnica, pros/contras, veredicto y una imagen
   de producto generada por IA si falta. El admin puede ocultar/mostrar campos de la
   ficha pública y añadir campos personalizados nuevos desde "Campos visibles en la
   ficha" (viven en product.extra).
2. **Catálogo de Productos Registrados**: tabla con selección masiva, asignación de
   categorías/subcategorías/badges, borrado y el botón "Enriquecer" (enriquecimiento
   MASIVO con concurrencia acotada por proveedor: ver TEXT_PROVIDER_CONCURRENCY).
3. **Afiliados**: credenciales de cada red (Amazon, AliExpress, eBay, Awin, CJ,
   Admitad, Tradedoubler, Kwanko, Etsy), caché sincronizable del catálogo de cada red
   ("Importar") y el botón "Construir Catálogo" (ingesta paralela multi-red, descarta
   segunda mano/sin stock, deduplica cross-merchant, autoclasifica en categorías
   existentes, detecta ofertas estrella y enriquece con IA en un solo clic).
4. **Categorías**, **Tráfico y Ventas** (analítica), **Transparencia** (auditoría
   "Test & Proof" + conectividad de IA + Pipeline) y **Desarrollo IA** (esta misma
   Consola + el Asesor IA, y los "skills" que el admin entrena para cada uno).

## Pipeline automatizado de producto (4 etapas, lib/pipeline/)
ingest (limpieza + deduplicación) → audit ("Test & Proof": aprueba o rechaza con un
score 0-100) → categorize (clasifica + enriquece con IA) → publish (listo para el
catálogo público). Lo ejecuta POST /api/v1/products/import (integraciones
externas/n8n) y el "Pipeline" de reproceso del panel.

## Modelo de producto (Product, lib/productStore.ts)
title/description, price/originalPrice, image/gallery, category/subcategory, brand,
merchant/fulfillmentProvider, condition (Nuevo/Usado/"RxV" = Reacondicionado por el
vendedor), pros/cons, badge, rating/reviewsCount, verdict, specs (tabla clave/valor),
techSheet (texto libre), shippingInfo/shippingDays/freeShipping, affiliateUrl/buyNowUrl
(el enlace real NUNCA se expone: el flujo es ProductCard → /producto/[slug] →
/checkout/[id] → /api/redirect → 302 a la tienda), extra (datos crudos de la red de
origen + campos personalizados), campos de pipeline (audit_status/score, ia_status,
link_status, conversion_score, normalized_tags) y alternativas vinculadas
(premium/económica/similar).

## Proveedores de IA configurables (lib/ai.ts)
Texto: OpenAI, Anthropic, Groq (gratuito, proveedor por defecto en producción, con
límite de peticiones bajo), NVIDIA NIM, OpenRouter y Gemini (Google AI Studio; modelo
por defecto gemini-3.5-flash porque las versiones 3.6-3.8 han dado 503/429 por alta
demanda en pruebas reales). Imagen: OpenAI Images o Flux. Tú (esta conversación) usas
el SDK oficial @google/genai con la tool googleSearch activada: tienes permiso y se
espera que la uses de forma autónoma siempre que la pregunta se beneficie de datos
verificables y actuales (especificaciones reales de hardware, lanzamientos, precios de
mercado, benchmarks, comparativas con la competencia...).

## Cómo debatir
Eres un interlocutor técnico riguroso, no un asistente complaciente: contrasta,
matiza y fundamenta tus opiniones en fuentes verificables cuando la pregunta lo pida,
cita de dónde sale el dato si es relevante, y dilo claramente cuando una afirmación es
una opinión/estimación y no un hecho contrastado.
`.trim();

let cachedClient: GoogleGenAI | null = null;
let cachedApiKey = '';

function getClient(): GoogleGenAI {
  const apiKey = env('GEMINI_API_KEY').trim();
  if (!apiKey) {
    throw new Error(
      'Falta GEMINI_API_KEY: la búsqueda web en tiempo real (Google Search grounding) requiere una clave de Google AI Studio.'
    );
  }
  if (apiKey.startsWith('AQ.')) {
    throw new Error(
      "La clave de GEMINI_API_KEY empieza por 'AQ.' (credenciales GCP/OAuth): hace falta una API Key de Google AI Studio ('AIzaSy...')."
    );
  }
  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedClient = new GoogleGenAI({ apiKey });
    cachedApiKey = apiKey;
  }
  return cachedClient;
}

/** `true` si hay clave de Gemini configurada (entorno o claves guardadas en el panel). */
export function isGroundingAvailable(): boolean {
  return Boolean(env('GEMINI_API_KEY').trim());
}

/** Convierte el historial genérico (role system/user/assistant) al formato de Gemini. */
function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction: string;
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
} {
  const systemInstruction = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: m.content }],
    }));
  return { systemInstruction, contents };
}

function extractGroundingMetadata(response: any): { searchQueries: string[]; citations: GroundingCitation[] } {
  const metadata = response?.candidates?.[0]?.groundingMetadata;
  const searchQueries: string[] = Array.isArray(metadata?.webSearchQueries) ? metadata.webSearchQueries.map(String) : [];
  const seen = new Set<string>();
  const citations: GroundingCitation[] = [];
  if (Array.isArray(metadata?.groundingChunks)) {
    for (const chunk of metadata.groundingChunks) {
      const uri = chunk?.web?.uri;
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      citations.push({ title: String(chunk?.web?.title || uri), url: String(uri) });
      if (citations.length >= 6) break;
    }
  }
  return { searchQueries, citations };
}

/**
 * Conversación con Gemini + Google Search activado (`tools:[{googleSearch:{}}]`).
 * Antepone `TRADYLOR_GROUNDED_CONTEXT` al resto de mensajes `system` ya
 * construidos por cada personalidad (lib/aiPersonas.ts), que siguen marcando
 * el tono/las reglas concretas de cada asistente.
 *
 * Lanza si no hay `GEMINI_API_KEY` o si la llamada falla tras el reintento de
 * modelo; el llamante decide el fallback (normalmente `chatComplete`).
 */
export async function chatCompleteGrounded(
  messages: ChatMessage[],
  opts: { temperature?: number; timeoutMs?: number; model?: string } = {},
): Promise<GroundedChatResult> {
  const ai = getClient();
  const { systemInstruction, contents } = toGeminiContents(messages);
  const fullSystemInstruction = [TRADYLOR_GROUNDED_CONTEXT, systemInstruction].filter(Boolean).join('\n\n');
  const modelName = opts.model?.trim() || env('GEMINI_MODEL') || 'gemini-3.5-flash';

  const callModel = (model: string) =>
    ai.models.generateContent({
      model,
      contents,
      config: {
        tools: [{ googleSearch: {} }],
        systemInstruction: fullSystemInstruction,
        temperature: opts.temperature ?? 0.6,
      },
    });

  const withTimeout = async <T>(promise: Promise<T>): Promise<T> => {
    const timeoutMs = opts.timeoutMs ?? GROUNDED_DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Tiempo de espera agotado consultando a Gemini (Google Search).')), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  };

  let response: any;
  try {
    response = await withTimeout(callModel(modelName));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isRetryable = /\b(503|404|429)\b/.test(msg);
    if (!isRetryable || modelName === GEMINI_FALLBACK_MODEL) throw error;
    console.warn(`[GeminiGrounded] ${modelName} no disponible ahora mismo (${msg.slice(0, 90)}…); reintentando con ${GEMINI_FALLBACK_MODEL}.`);
    response = await withTimeout(callModel(GEMINI_FALLBACK_MODEL));
  }

  const { searchQueries, citations } = extractGroundingMetadata(response);
  return {
    text: typeof response?.text === 'string' ? response.text : '',
    grounded: true,
    searchQueries,
    citations,
  };
}
