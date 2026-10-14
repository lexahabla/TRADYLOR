/**
 * POST /api/admin/marketing/agency-ai — Ejecución del agente (mock).
 *
 * Recibe { skillId, brief, ... } y devuelve un AgentRunResult estructurado con
 * la salida típica de esa skill. Punto único de sustitución: cuando entre un
 * LLM real (OpenAI/Anthropic), se reemplaza el builder MOCK por la llamada al
 * modelo manteniendo el mismo contrato AgentRunResult.
 */
import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../../lib/adminAuth';
import { isAgentSkillId } from '../../../../lib/marketingSkills';
import type {
  AgentRunRequest,
  AgentRunResult,
  EmailSequenceDraft,
  GrowthInsightDraft,
  PaidMediaDraft,
  SocialCalendarDraft,
} from '../../../../types/marketing';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

function buildPaidMedia(request: AgentRunRequest): PaidMediaDraft {
  const niche = request.niche?.trim() || 'compradores del catálogo TRADYLOR';
  const objective = request.objective?.trim() || 'maximizar el ROAS del catálogo top';
  return {
    kind: 'paid_media',
    campaigns: [
      {
        channel: 'meta_ads',
        campaignName: `TRADYLOR | ${niche} | Ventas (ventana 7d)`,
        audiences: [
          `Intereses relacionados con ${niche}`,
          'Público similar 1% de compradores (ventana 180d)',
          'Retargeting: vistas de ficha sin compra (7d)',
        ],
        ads: [
          {
            headline: `Lo que todo ${niche} necesita`,
            primaryText: `${request.brief.trim()}\nEnvío rápido, comparativas reales y enlace directo a la ficha.`,
            cta: 'Comprar ahora',
          },
          {
            headline: 'Comparado, probado, recomendado',
            primaryText: `Seleccionamos lo mejor de ${niche} para que no pierdas tiempo comparando. ${objective}.`,
            cta: 'Ver la selección',
          },
        ],
        dailyBudgetHint: '15–25 €/día por campaña; escalar +20% si el ROAS supera 2,5 durante 48h.',
      },
      {
        channel: 'google_ads',
        campaignName: `Search | ${niche} | Intención alta`,
        audiences: [
          `Keywords: "${niche} mejor", "${niche} barato", "comprar ${niche}"`,
          'Exclusión: términos gratuitos y de soporte',
        ],
        ads: [
          {
            headline: `${niche}: top valorados`,
            primaryText: `Comparativa actualizada de ${niche}. Opiniones verificadas y precio actualizado hoy.`,
            cta: 'Comparar ahora',
          },
        ],
        dailyBudgetHint: 'Puja manual en primera posición para brand/comparativa; tCPA = margen unitario × 0,3.',
      },
    ],
  };
}

function buildEmailSequence(request: AgentRunRequest): EmailSequenceDraft {
  const niche = request.niche?.trim() || 'tus productos guardados';
  return {
    kind: 'email_sequence',
    sequenceName: `Recuperación de carrito · ${niche}`,
    emails: [
      {
        step: 1,
        delayDays: 0,
        subject: 'Te lo hemos guardado (pero no por mucho tiempo)',
        body: `Vi que miraste ${niche} y dejaste algo atrás. Aquí tienes el enlace directo para retomarlo en 20 segundos. ${request.brief.trim()}`,
      },
      {
        step: 2,
        delayDays: 1,
        subject: 'La duda que suele frenar la compra',
        body: 'Resolvemos envío, devoluciones y garantía en 3 bullets. Si te encaja, tu carrito sigue exactamente donde lo dejaste.',
      },
      {
        step: 3,
        delayDays: 3,
        subject: 'Última llamada: precio y stock de hoy',
        body: 'Cerramos la reserva del precio actual. Si el producto sigue disponible, es el mejor momento para decidir.',
      },
      {
        step: 4,
        delayDays: 7,
        subject: 'Opción alternativa por si no era el indicado',
        body: `Si ${niche} no era lo tuyo, mira esta alternativa mejor valorada por el mismo presupuesto.`,
      },
    ],
  };
}

function buildSocialCalendar(request: AgentRunRequest): SocialCalendarDraft {
  const niche = request.niche?.trim() || 'producto destacado';
  return {
    kind: 'social_calendar',
    days: [
      { day: 'Lunes', channel: 'tiktok', format: 'Demo rápida 20s', hook: `3 cosas que nadie te cuenta de ${niche}`, script: 'Enfoque: error #1 que comete el 90% al elegirlo.', cta: 'Ficha en el perfil' },
      { day: 'Martes', channel: 'instagram', format: 'Reel + carrusel', hook: 'Antes / después con el producto', script: 'Carrusel con 3 comparativas de precio-real.', cta: 'Desliza para comparar' },
      { day: 'Miércoles', channel: 'youtube', format: 'Review 8 min', hook: `¿Vale la pena ${niche}? (respuesta honesta)`, script: 'Estructura: quién lo necesita / quién no / alternativa top.', cta: 'Enlace en descripción' },
      { day: 'Jueves', channel: 'tiktok', format: 'Test 7 días', hook: `Le di uso real a ${niche} una semana`, script: 'Clip de testimonio con resultado concreto.', cta: 'Prueba el tuyo' },
      { day: 'Viernes', channel: 'instagram', format: 'Stories encuesta', hook: '¿Cuál eliges?', script: 'Encuesta de 2 opciones → respuesta con el recomendado.', cta: 'Vota y descubre' },
    ],
  };
}

function buildGrowthInsights(): GrowthInsightDraft {
  return {
    kind: 'growth_insights',
    insights: [
      {
        title: 'México: pico de tráfico sin conversión',
        analysis: 'El tráfico crece +86% mientras la conversión se queda en 0,22% (media ES: 1,06%).',
        recommendation: 'Habilitar precios en MXN, mensaje de envío/devolución local y campaña de confianza antes de subir presupuesto.',
        impact: 'alto',
      },
      {
        title: 'Segmento B2B con mayor LTV y carrito activo',
        analysis: 'Los perfiles "empresa" concentran el mayor LTV (1.240 €) y el 62% de los carritos > 200 €.',
        recommendation: 'Pack de oficina con factura, descuento por volumen y flujo de nurturing en email.',
        impact: 'alto',
      },
      {
        title: 'Bundle de temporada infrarepresentado',
        analysis: 'Los hobbies "decoración + iluminación" generan 3,4 vistas/usuario pero casi nulas ventas cruzadas.',
        recommendation: 'Lanzar bundle "Ambienta tu hogar" (-10%) con email a la segmentación y Ads creativos de pack.',
        impact: 'medio',
      },
    ],
  };
}

export const POST: APIRoute = async ({ request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ ok: false, error: 'auth_required' }, 401);
  if (session.role !== 'admin') return json({ ok: false, error: 'forbidden' }, 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const payload = (body ?? {}) as Partial<AgentRunRequest>;
  if (!isAgentSkillId(payload.skillId)) return json({ ok: false, error: 'unknown_skill' }, 400);
  if (typeof payload.brief !== 'string' || payload.brief.trim().length < 10) {
    return json({ ok: false, error: 'brief_too_short' }, 400);
  }

  const runRequest: AgentRunRequest = {
    skillId: payload.skillId,
    brief: payload.brief.trim(),
    niche: typeof payload.niche === 'string' ? payload.niche : undefined,
    objective: typeof payload.objective === 'string' ? payload.objective : undefined,
    languages: Array.isArray(payload.languages) ? payload.languages : undefined,
  };

  const output =
    runRequest.skillId === 'paid_media'
      ? buildPaidMedia(runRequest)
      : runRequest.skillId === 'copywriter'
        ? buildEmailSequence(runRequest)
        : runRequest.skillId === 'social_media'
          ? buildSocialCalendar(runRequest)
          : buildGrowthInsights();

  const result: AgentRunResult = {
    skillId: runRequest.skillId,
    request: runRequest,
    output,
    generatedAt: new Date().toISOString(),
    model: 'mock',
  };
  return json({ ok: true, source: 'mock', generatedAt: result.generatedAt, data: result }, 200);
};
