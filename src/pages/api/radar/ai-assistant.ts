import type { APIRoute } from 'astro';
import { chatComplete, hasTextCredentials, type ChatMessage } from '../../../lib/ai';
import { asesorIaSystemPrompt, withSkills } from '../../../lib/aiPersonas';
import { getSkillsForPersona } from '../../../lib/aiSkillsStore';
import { getRadarSessionUser } from '../../../lib/radarAuth';
import { aiAssistantPerIp, aiAssistantPerUser } from '../../../lib/rateLimit';
import { chatCompleteGrounded, isGroundingAvailable } from '../../../lib/geminiGrounded';

/**
 * ==============================================================================
 * TRADYLOR — ASESOR IA (Centro de Herramientas)
 * ==============================================================================
 * POST /api/radar/ai-assistant  { messages: [{role, content}] }
 *
 * Usa la MISMA personalidad que el widget flotante (#ia-chat-window):
 * un único system prompt compartido en lib/aiPersonas.ts
 * (`asesorIaSystemPrompt`) + los skills entrenados por el admin
 * (apartado «Desarrollo IA»). Motor: chatComplete (NVIDIA Nemotron, fallback).
 *
 * Acceso: usuarios anónimos pueden preguntar, pero la respuesta llega
 * recortada (`locked:true`); con sesión de Mi Radar llega completa y el
 * cliente la guarda en su cuenta (ver utils/radarStore.ts `saveAiChat`).
 * ==============================================================================
 */

export const prerender = false;

const MAX_MESSAGES = 12;
/** Caracteres visibles de la respuesta para quien no tiene sesión (resto bloqueado). */
const TEASER_CHARS = 140;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function systemPrompt(nombreUsuario?: string): string {
  return withSkills(
    asesorIaSystemPrompt({ nombreUsuario, jsonMode: false }),
    getSkillsForPersona('dependiente'),
  );
}

export const POST: APIRoute = async ({ request }) => {
  if (!hasTextCredentials()) {
    // 200 (no 5xx): el proxy de Easy Panel enmascara los 5xx con HTML propio.
    return json({ success: false, message: 'El Dependiente IA no está disponible ahora mismo (sin proveedor de IA configurado en el servidor).' }, 200);
  }

  const user = getRadarSessionUser(request);
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const limiter = user ? aiAssistantPerUser : aiAssistantPerIp;
  if (!limiter.hit(user ? user.id : ip)) {
    return json({ success: false, message: 'Has hecho demasiadas preguntas seguidas. Espera unos minutos y vuelve a intentarlo.' }, 429);
  }

  const body = await request.json().catch(() => null) as { messages?: Array<{ role?: string; content?: string }> } | null;
  if (!body || typeof body !== 'object') return json({ success: false, message: 'Cuerpo JSON inválido.' }, 400);

  const history: ChatMessage[] = (Array.isArray(body.messages) ? body.messages : [])
    .slice(-MAX_MESSAGES)
    .map((m) => ({
      role: m?.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: String(m?.content ?? '').slice(0, 1000),
    }))
    .filter((m) => m.content.trim());

  if (!history.length) return json({ success: false, message: 'Escribe tu pregunta para el Dependiente IA.' }, 400);

  try {
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(user?.name ?? undefined) }, ...history];

    // Búsqueda web en tiempo real (Google Search grounding, Gemini): permite
    // al Asesor IA fundamentar comparativas y dudas técnicas con datos
    // actuales. Si Gemini no está configurado o falla, se usa el proveedor de
    // texto configurado de siempre (chatComplete), sin cambiar su respuesta.
    let reply = '';
    let grounded = false;
    let citations: Array<{ title: string; url: string }> = [];
    if (isGroundingAvailable()) {
      try {
        const result = await chatCompleteGrounded(messages, { temperature: 0.5, timeoutMs: 25_000 });
        reply = result.text;
        grounded = true;
        citations = result.citations;
      } catch (error) {
        console.warn('[Dependiente IA] Gemini con Google Search no disponible, se usa el proveedor configurado:', error instanceof Error ? error.message : error);
      }
    }
    if (!reply) {
      reply = await chatComplete(messages, { temperature: 0.5, timeoutMs: 25_000, jsonMode: false });
    }
    const trimmed = reply.trim()
      || 'No he encontrado una recomendación clara con esos datos: cuéntame tu presupuesto y para qué lo vas a usar.';

    if (!user) {
      const teaserLen = Math.min(TEASER_CHARS, trimmed.length);
      const teaser = trimmed.slice(0, teaserLen) + (trimmed.length > teaserLen ? '…' : '');
      return json({ success: true, reply: teaser, locked: true });
    }

    return json({ success: true, reply: trimmed, locked: false, grounded, citations: grounded ? citations : undefined });
  } catch (error) {
    // NOTA: el proxy de Easy Panel sustituye cualquier 5xx por su propia página
    // HTML (el cliente no puede parsearla y muestra un error genérico). Por eso
    // los fallos del proveedor se devuelven con status 200 + success:false:
    // el frontend muestra `message` tal cual.
    const msg = error instanceof Error ? error.message : 'Error del proveedor de IA.';
    console.error('[Dependiente IA] Error al responder:', msg);
    // Mensaje amigable para el usuario (el detalle técnico queda en el log del
    // servidor); jamás status 5xx: el proxy de Easy Panel los enmascara con HTML.
    return json({ success: false, message: 'Ups, se me ha atragantado la respuesta. Vuelve a preguntar en unos segundos y lo intento de nuevo.' }, 200);
  }
};
