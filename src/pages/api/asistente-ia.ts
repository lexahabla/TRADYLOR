import type { APIRoute } from 'astro';
import { chatComplete, hasTextCredentials, type ChatMessage } from '../../lib/ai';
import { getCatalogProducts } from '../../lib/catalog';
import { getRadarSessionUser } from '../../lib/radarAuth';

/**
 * ==============================================================================
 * TRADYLOR — ASISTENTE IA (Dependiente IA, chat flotante)
 * ==============================================================================
 * POST /api/asistente-ia  { mensajeUsuario, contextoProducto? }
 *
 * Endpoint de chat flotante impulsado por el mismo motor de IA del servidor
 * (`chatComplete` de src/lib/ai): OpenAI, Anthropic, Groq, NVIDIA y OpenRouter
 * con fallback automático entre los proveedores gratuitos que tengan clave
 * configurada. NO usa Gemini ni Vertex AI.
 *
 * Devuelve respuestas estructuradas:
 *   { respuesta, tipo, productos?, usuario? }
 *   - tipo 'saludo': bienvenida, usa nombre si está logueado, sino pide el nombre.
 *   - tipo 'recomendacion': hasta 3 productos reales con { slug, title, price, image, reason }.
 *   - tipo 'general': texto plano.
 *
 * Se integra en el servidor SSR de Astro (mismo proceso, mismo puerto 4321).
 * ==============================================================================
 */

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** Extracto compacto del catálogo aprobado para anclar al modelo a productos reales. */
function buildCatalogExcerpt(): string {
  const products = getCatalogProducts()
    .filter((p) => p.audit_status !== 'rejected')
    .sort((a, b) => (b.conversion_score ?? 0) - (a.conversion_score ?? 0))
    .slice(0, 60);

  return products
    .map((p) => {
      const slug = p.slug || p.id;
      const price = p.price ? `${p.price.toFixed(2)}€` : 'sin precio';
      return `- [${slug}] "${p.title}" · ${p.category || 'General'} · ${price} · Imagen: ${p.image || 'sin imagen'}`;
    })
    .join('\n');
}

const SALUDOS = ['hola', 'buenos días', 'buenas tardes', 'buenas noches', 'hey', 'hi', 'buenas'];

function esSaludo(texto: string): boolean {
  const t = texto.trim().toLowerCase();
  return SALUDOS.some((s) => t === s || t.startsWith(s + ' '));
}

/**
 * System prompt con "skills" de conversación para una tienda de productos.
 * Guía al modelo para respuestas cortas, estructuradas y con enlaces reales.
 */
function systemPrompt(catalogo: string, nombreUsuario?: string): string {
  const saludoInicial = nombreUsuario
    ? `El usuario se llama ${nombreUsuario}. Úsalo para saludarle por nombre.`
    : 'El usuario NO está logueado. Pídele amablemente su nombre para poder tratarle de forma personalizada.';

  return `
Eres el "Dependiente IA" de Tradylor.com, asistente de compras experto y objetivo.
HABILIDADES DE CONVERSACIÓN:
1. Si el usuario dice "hola" o similar, saluda calurosamente: "Hola, ¿cómo estás? ¿En qué puedo ayudarte? ¿Buscas algún producto en concreto?"
2. ${saludoInicial}
3. Si ya conoces su nombre, úsalo de vez en cuando (no en cada frase).

REGLAS PARA RECOMENDAR PRODUCTOS:
1. Recomienda SOLO productos de la lista del catálogo de abajo (nunca inventes modelos, precios ni tiendas).
2. Máximo 3 productos por respuesta.
3. Responde ÚNICAMENTE en formato JSON válido con esta estructura:
   { "productos": [ { "slug": "<slug>", "title": "<título>", "pro": "<una ventaja corta>" } ] }
4. No incluyas texto adicional fuera del JSON. Sin precios, sin tablas, sin secciones numeradas.
5. Si no hay nada adecuado, devuelve { "productos": [] } y el sistema pedirá presupuesto o uso.
6. Responde en español.

---
CATÁLOGO DISPONIBLE:
${catalogo}
`.trim();
}

export const POST: APIRoute = async ({ request }) => {
  if (!hasTextCredentials()) {
    return json(
      { error: 'El asistente IA no está disponible ahora mismo (sin proveedor de IA configurado en el servidor).' },
      503,
    );
  }

  try {
    const body = (await request.json().catch(() => null)) as {
      mensajeUsuario?: string;
      contextoProducto?: Record<string, unknown>;
    } | null;

    const mensajeUsuario = body?.mensajeUsuario;
    const contextoProducto = body?.contextoProducto;

    if (!mensajeUsuario || typeof mensajeUsuario !== 'string') {
      return json({ error: 'mensajeUsuario es obligatorio.' }, 400);
    }

    // Sesión de Mi Radar (para saber si está logueado y su nombre).
    const radarUser = getRadarSessionUser(request);
    const nombreUsuario = radarUser?.name ?? undefined;

    const catalogo = buildCatalogExcerpt() || '(catálogo vacío por ahora)';

    const esSaludoInicial = esSaludo(mensajeUsuario);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(catalogo, nombreUsuario) },
    ];

    if (esSaludoInicial) {
      // Flujo de bienvenida: no necesitamos llamar a la IA, respondemos directo.
      const saludoTexto = nombreUsuario
        ? `Hola ${nombreUsuario}, ¿cómo estás? ¿En qué puedo ayudarte hoy? ¿Buscas algún producto en concreto?`
        : 'Hola, ¿cómo estás? ¿En qué puedo ayudarte hoy? ¿Buscas algún producto en concreto?';
      return json({
        respuesta: saludoTexto,
        tipo: 'saludo',
        productos: [],
        usuario: nombreUsuario ?? null,
      });
    }

    messages.push(
      { role: 'user', content: `Contexto del usuario/catálogo: ${JSON.stringify(contextoProducto || {})}` },
      { role: 'user', content: mensajeUsuario },
    );

    /** Timeout propio (25s) para que el servidor siempre responda antes que el
     * proxy/load balancer de Easy Panel y evitar 502 HTML del gateway. */
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);

    let respuesta: string;
    try {
      respuesta = await Promise.race([
        chatComplete(messages, { temperature: 0.5, timeoutMs: 25_000, jsonMode: true }),
        new Promise<string>((_, reject) =>
          controller.signal.addEventListener('abort', () =>
            reject(new Error('Tiempo de espera agotado. Inténtalo de nuevo.')),
          ),
        ),
      ]);
    } finally {
      clearTimeout(timeout);
    }

    // Intentar parsear JSON estructurado de productos. Si falla, devolver texto plano.
    let productos: Array<{ slug: string; title: string; pro: string }> = [];
    let textoPlano = '';
    try {
      const parsed = JSON.parse(respuesta);
      if (parsed?.productos && Array.isArray(parsed.productos)) {
        productos = parsed.productos
          .filter((p: any) => p?.slug && p?.title)
          .map((p: any) => ({
            slug: String(p.slug),
            title: String(p.title),
            pro: String(p.pro || ''),
          }))
          .slice(0, 3);
      } else {
        textoPlano = respuesta.trim();
      }
    } catch {
      textoPlano = respuesta.trim();
    }

    if (productos.length > 0) {
      return json({
        respuesta: '',
        tipo: 'recomendacion',
        productos,
        usuario: nombreUsuario ?? null,
      });
    }

    const trimmed = textoPlano
      || 'No he encontrado una recomendación clara con esos datos: cuéntame tu presupuesto y para qué lo vas a usar.';

    return json({ respuesta: trimmed, tipo: 'general', productos: [], usuario: nombreUsuario ?? null });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Asistente IA]:', msg);
    return json(
      { error: `No se ha podido procesar la respuesta del asistente: ${msg}` },
      502,
    );
  }
};
