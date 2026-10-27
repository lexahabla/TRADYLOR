import type { APIRoute } from 'astro';
import { chatComplete, hasTextCredentials, type ChatMessage } from '../../lib/ai';
import { dependienteIaSystemPrompt, withSkills } from '../../lib/aiPersonas';
import { getSkillsForPersona } from '../../lib/aiSkillsStore';
import { getRadarSessionUser } from '../../lib/radarAuth';

/**
 * ==============================================================================
 * TRADYLOR — ASISTENTE IA (Dependiente IA, chat flotante)
 * ==============================================================================
 * POST /api/asistente-ia  { mensajeUsuario, contextoProducto? }
 *
 * Widget flotante (#ia-chat-window). Usa la MISMA personalidad que la página
 * dedicada /herramientas/dependiente-ia (ver lib/aiPersonas.ts): un único
 * system prompt compartido, con jsonMode:true para el formato de tarjetas.
 * Motor: `chatComplete` (NVIDIA Nemotron por defecto, con fallback).
 *
 * Devuelve respuestas estructuradas:
 *   { respuesta, tipo, productos?, usuario? }
 *   - tipo 'saludo': bienvenida, usa nombre si está logueado, sino pide el nombre.
 *   - tipo 'recomendacion': hasta 3 productos reales con { slug, title, price, image, reason }.
 *   - tipo 'general': texto plano.
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

const SALUDOS = ['hola', 'buenos días', 'buenas tardes', 'buenas noches', 'hey', 'hi', 'buenas'];

function esSaludo(texto: string): boolean {
  const t = texto.trim().toLowerCase();
  return SALUDOS.some((s) => t === s || t.startsWith(s + ' '));
}

/**
 * System prompt del widget: MISMA personalidad que la página Dependiente IA
 * (lib/aiPersonas.ts), en formato JSON para las tarjetas del chat.
 */
function systemPrompt(nombreUsuario?: string): string {
  return withSkills(
    dependienteIaSystemPrompt({ nombreUsuario, jsonMode: true }),
    getSkillsForPersona('dependiente'),
  );
}

export const POST: APIRoute = async ({ request }) => {
  if (!hasTextCredentials()) {
    // 200 (no 5xx): el proxy de Easy Panel enmascara los 5xx con HTML propio.
    return json(
      { error: 'El asistente IA no está disponible ahora mismo (sin proveedor de IA configurado en el servidor).' },
      200,
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

    const esSaludoInicial = esSaludo(mensajeUsuario);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(nombreUsuario) },
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
    // NUNCA 5xx: el proxy de Easy Panel sustituye los códigos 5xx por su propia
    // página HTML y el frontend no puede parsearla (mostraría un error genérico).
    return json(
      { error: 'Ups, se me ha atragantado la respuesta. Vuelve a preguntar en unos segundos y lo intento de nuevo.' },
      200,
    );
  }
};
