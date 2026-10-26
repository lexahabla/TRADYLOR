import type { APIRoute } from 'astro';
import { GoogleGenAI } from '@google/genai';

/**
 * ==============================================================================
 * TRADYLOR — ASISTENTE IA (Gemini en Vertex AI)
 * ==============================================================================
 * POST /api/asistente-ia  { mensajeUsuario, contextoProducto? }
 *
 * Endpoint de chat flotante impulsado por Gemini (@google/genai) en modo
 * Vertex AI (Google Cloud / credenciales de cuenta de servicio mediante
 * Application Default Credentials). No usa claves API de AI Studio.
 *
 * Se integra en el servidor SSR de Astro (mismo proceso, mismo puerto 4321),
 * por lo que no hace falta levantar un servidor Express aparte ni exponer un
 * puerto adicional en el contenedor de producción.
 *
 * Responde con { respuesta: string } o { error: string } + status 500.
 * ==============================================================================
 */

export const prerender = false;

const ai = new GoogleGenAI({
  vertexAI: true,
  project: process.env.VERTEX_AI_PROJECT ?? 'gen-lang-client-0762423530',
  location: process.env.VERTEX_AI_LOCATION ?? 'us-central1',
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export const POST: APIRoute = async ({ request }) => {
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

    const systemInstruction = `
Eres el Dependiente IA de Tradylor.com, un asistente de compras experto y objetivo.
Tu objetivo es orientar al usuario utilizando la información de nuestro método (pros, contras y especificaciones).
Sé claro, conciso y transparente.
Responde en español.
`.trim();

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        { role: 'user', parts: [{ text: systemInstruction }] },
        { role: 'user', parts: [{ text: `Contexto del usuario/catálogo: ${JSON.stringify(contextoProducto || {})}` }] },
        { role: 'user', parts: [{ text: mensajeUsuario }] },
      ],
      config: {
        temperature: 0.7,
        maxOutputTokens: 800,
      },
    });

    return json({ respuesta: response.text ?? '' });
  } catch (error) {
    console.error('[Asistente IA / Gemini]:', error);
    return json(
      { error: 'No se ha podido procesar la respuesta del asistente.' },
      500,
    );
  }
};
