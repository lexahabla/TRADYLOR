import type { APIRoute } from 'astro';
import { chatComplete, hasTextCredentials, type ChatMessage } from '../../lib/ai';
import { getCatalogProducts } from '../../lib/catalog';

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
 * Se integra en el servidor SSR de Astro (mismo proceso, mismo puerto 4321).
 *
 * Responde con { respuesta: string } o { error: string } + status.
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
    .slice(0, 40);

  return products
    .map((p) => {
      const slug = p.slug || p.id;
      const price = p.price ? `${p.price.toFixed(2)}€` : 'sin precio';
      return `- [${slug}] "${p.title}" · ${p.category || 'General'} · ${price}`;
    })
    .join('\n');
}

const SYSTEM_INSTRUCTION = `
Eres el "Dependiente IA" de Tradylor.com, asistente de compras experto y objetivo.
REGLAS ESTRICTAS:
1. Recomienda SOLO productos de la lista del catálogo de abajo (nunca inventes modelos, precios ni tiendas).
2. Máximo 3 productos por respuesta.
3. Sé MÁS CORTO y conciso: máximo 4-5 líneas en total, sin tablas ni secciones numeradas.
4. Por cada producto: nombre, precio, enlace "/producto/<slug>" y una razón de UNA frase por la que lo recomiendas.
5. Si no hay nada adecuado, dilo con honestidad y pide presupuesto o uso.
6. Responde en español, tono directo y profesional.
---
CATÁLOGO DISPONIBLE:
{{CATALOGO}}
`.trim();

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

    const catalogo = buildCatalogExcerpt() || '(catálogo vacío por ahora)';

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_INSTRUCTION.replace('{{CATALOGO}}', catalogo) },
      {
        role: 'user',
        content: `Contexto del usuario/catálogo: ${JSON.stringify(contextoProducto || {})}`,
      },
      { role: 'user', content: mensajeUsuario },
    ];

    /** Timeout propio (25s) para que el servidor siempre responda antes que el
     * proxy/load balancer de Easy Panel y evitar 502 HTML del gateway. */
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);

    let respuesta: string;
    try {
      respuesta = await Promise.race([
        chatComplete(messages, { temperature: 0.5, timeoutMs: 25_000, jsonMode: false }),
        new Promise<string>((_, reject) =>
          controller.signal.addEventListener('abort', () =>
            reject(new Error('Tiempo de espera agotado. Inténtalo de nuevo.')),
          ),
        ),
      ]);
    } finally {
      clearTimeout(timeout);
    }

    const trimmed = respuesta.trim()
      || 'No he encontrado una recomendación clara con esos datos: cuéntame tu presupuesto y para qué lo vas a usar.';

    return json({ respuesta: trimmed });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Asistente IA]:', msg);
    return json(
      { error: `No se ha podido procesar la respuesta del asistente: ${msg}` },
      502,
    );
  }
};
