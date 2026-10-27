import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { addSkill, listSkills, removeSkill, type AiPersonaId } from '../../../lib/aiSkillsStore';

/**
 * ==============================================================================
 * TRADYLOR — DESARROLLO IA · Skills de entrenamiento
 * ==============================================================================
 * GET    /api/admin/ai-skills                 → lista (¿persona=dependiente|admin?)
 * POST   /api/admin/ai-skills { persona, text }  → crea
 * DELETE /api/admin/ai-skills?id=<skillId>       → elimina
 *
 * Los skills alimentan el system prompt de cada personalidad (ver
 * lib/aiPersonas.ts `withSkills`). Sólo admin autenticado.
 * ==============================================================================
 */

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const PERSONAS: AiPersonaId[] = ['dependiente', 'admin'];

export const GET: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const persona = new URL(request.url).searchParams.get('persona');
  const validPersona = PERSONAS.includes(persona as AiPersonaId) ? (persona as AiPersonaId) : undefined;

  return json({
    success: true,
    skills: listSkills(validPersona),
    personas: PERSONAS,
  });
};

export const POST: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null) as { persona?: string; text?: string } | null;
  const persona = String(body?.persona ?? '') as AiPersonaId;
  const text = String(body?.text ?? '');

  if (!PERSONAS.includes(persona)) {
    return json({ success: false, message: 'Persona inválida (usa "dependiente" o "admin").' }, 400);
  }
  if (!text.trim()) {
    return json({ success: false, message: 'La instrucción no puede estar vacía.' }, 400);
  }

  const skill = addSkill(persona, text);
  if (!skill) {
    return json({ success: false, message: 'No se pudo añadir: repetida o límite de 40 skills por persona alcanzado.' }, 409);
  }

  return json({ success: true, skill });
};

export const DELETE: APIRoute = async ({ request }) => {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json({ success: false, message: 'Falta el id de la skill.' }, 400);

  const removed = removeSkill(id);
  if (!removed) return json({ success: false, message: 'Skill no encontrada.' }, 404);

  return json({ success: true });
};
