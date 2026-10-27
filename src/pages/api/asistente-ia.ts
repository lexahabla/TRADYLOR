import type { APIRoute } from 'astro';
import { GoogleGenAI } from '@google/genai';

/**
 * =============================================================================
 * TRADYLOR — ASISTENTE IA (Gemini en Vertex AI)
 * =============================================================================
 * POST /api/asistente-ia  { mensajeUsuario, contextoProducto? }
 *
 * Endpoint de chat flotante impulsado por Gemini (@google/genai) en modo
 * Vertex AI (Google Cloud / credenciales de cuenta de servicio mediante
 * Application Default Credentials). No usa claves API de AI Studio.
 *
 * Se integra en el servidor SSR de Astro (mismo proceso, mismo puerto 4321).
 *
 * Fallback automático de modelos: si el modelo configurado en VERTEX_AI_MODEL
 * devuelve 404 / NOT_FOUND (modelo no disponible en el proyecto o región de
 * Google Cloud), se prueban los siguientes de la lista ordenada hasta que uno
 * responda. Así el widget sigue funcionando aunque el modelo favorito no
 * esté disponible temporalmente.
 *
 * Responde con { respuesta: string, modelo?: string } o { error: string } + status.
 * =============================================================================
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

/** Modelos de Vertex AI probados como estables para asistencia al usuario,
 * ordenados de más recomendado a menos. El primero es el valor por defecto
 * cuando no hay VERTEX_AI_MODEL definido. */
const VERTEX_FALLBACK_MODELS: string[] = [
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-2.0-flash',
];

function isModelNotFoundError(msg: string): boolean {
  return /404|NOT_FOUND|not found|no tiene acceso|does not have access|model.*not found/i.test(msg);
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

    const project = process.env.VERTEX_AI_PROJECT ?? 'project-14150355-54ed-40a4-80e';
    const location = process.env.VERTEX_AI_LOCATION ?? 'europe-west1';

    // Orden de modelos: el configurado por el usuario primero, luego los de fallback.
    const configured = process.env.VERTEX_AI_MODEL?.trim();
    const models: string[] = [];
    if (configured) models.push(configured);
    for (const m of VERTEX_FALLBACK_MODELS) {
      if (!models.includes(m)) models.push(m);
    }

    const ai = new GoogleGenAI({
      vertexAI: true,
      project,
      location,
    });

    const systemInstruction = `
Eres el Dependiente IA de Tradylor.com, un asistente de compras experto y objetivo.
Tu objetivo es orientar al usuario utilizando la información de nuestro método (pros, contras y especificaciones).
Sé claro, conciso y transparente.
Responde en español.
`.trim();

    const contents = [
      { role: 'user', parts: [{ text: systemInstruction }] },
      { role: 'user', parts: [{ text: `Contexto del usuario/catálogo: ${JSON.stringify(contextoProducto || {})}` }] },
      { role: 'user', parts: [{ text: mensajeUsuario }] },
    ];

    const config = {
      temperature: 0.7,
      maxOutputTokens: 800,
    };

    let lastError: unknown;
    for (const model of models) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config,
        });
        return json({ respuesta: response.text ?? '', modelo: model });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[Asistente IA / Gemini] modelo ${model} falló:`, msg);
        if (!isModelNotFoundError(msg)) {
          // Error que no es de modelo no disponible: no hacemos fallback, lanzamos.
          throw error;
        }
        lastError = error;
        // continuar con el siguiente modelo de la lista (fallback automático)
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Ningún modelo de Vertex AI disponible pudo responder.');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Asistente IA / Gemini]:', msg);
    return json(
      { error: `No se ha podido procesar la respuesta del asistente: ${msg}` },
      500,
    );
  }
};
