/**
 * TRADYLOR — Definición de las skills del agente (TRADYLOR AI Agency).
 *
 * Se consumen desde la página /admin/marketing/agency-ai (render SSR de las
 * tarjetas) y desde el endpoint POST /api/admin/marketing/agency-ai (validación
 * de la skill ejecutada).
 */
import type { AgentSkillDefinition, AgentSkillId } from '../types/marketing';

export const AGENT_SKILLS: AgentSkillDefinition[] = [
  {
    id: 'paid_media',
    name: 'Paid Media Specialist',
    role: 'Meta Ads · Google Ads',
    description:
      'Diseña estructuras de campañas de pago por nicho y hobbies, con segmentación, anuncios de conversión y presupuesto orientado.',
    capabilities: [
      'Estructura de campaña (campaña → grupo → anuncio)',
      'Segmentación por nicho, hobbies y perfil 360°',
      'Copy de anuncio: headline, texto principal y CTA',
      'Pista de presupuesto diario y puja inicial',
    ],
  },
  {
    id: 'copywriter',
    name: 'E-commerce Copywriter',
    role: 'Email marketing · Automatizaciones',
    description:
      'Escribe secuencias automáticas de email (bienvenida, recuperación de carrito, venta cruzada) adaptadas a cada idioma del catálogo.',
    capabilities: [
      'Secuencias: bienvenida, carrito abandonado, post-compra',
      'Asuntos + cuerpo con tono de marca por idioma',
      'Cross-sell / up-sell en el email de post-compra',
      'Variantes A/B de asunto',
    ],
  },
  {
    id: 'social_media',
    name: 'Social Media Strategist',
    role: 'TikTok · Instagram · YouTube',
    description:
      'Construye calendarios semanales de contenido orgánico a partir de los productos destacados, con gancho, formato y CTA por pieza.',
    capabilities: [
      'Calendario semanal por canal y formato',
      'Hook + guion corto + CTA por publicación',
      'Vinculación con productos destacados del catálogo',
      'Reutilización de un mismo producto en 3 formatos',
    ],
  },
  {
    id: 'growth_consultant',
    name: 'Business Growth Consultant',
    role: 'Estrategia · Datos cruzados',
    description:
      'Cruza Market Map y Audiencias para proponer ajustes de precio, envíos internacionales, bundles y palancas de conversión.',
    capabilities: [
      'Análisis cruzado /map + /users',
      'Recomendaciones de precio y bundles',
      'Oportunidades de envío internacional',
      'Impacto estimado y prioridad (alto/medio/bajo)',
    ],
  },
];

export function isAgentSkillId(value: unknown): value is AgentSkillId {
  return typeof value === 'string' && AGENT_SKILLS.some((skill) => skill.id === value);
}
