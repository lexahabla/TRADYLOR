/**
 * GET /api/admin/marketing/calendar — Calendario comercial global (mock).
 *
 * Hitos e-commerce con semanas de antelación, alerta calculada y mix de
 * canales sugerido. Preparado para persistir campañas propias en la BD.
 */
import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../../lib/adminAuth';
import type { CommercialCampaign, MarketingApiResponse } from '../../../../types/marketing';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** Próxima ocurrencia (año actual o siguiente) de un mes/día concretos. */
function nextOccurrence(month: number, day: number): string {
  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getTime() < now.getTime()) year += 1;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

/** Fecha ISO de la alerta: N semanas antes de la campaña. */
function alertFor(campaignDate: string, leadTimeWeeks: number): string {
  const date = new Date(`${campaignDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - leadTimeWeeks * 7);
  return date.toISOString().slice(0, 10);
}

const CAMPAIGN_DEFS: Omit<CommercialCampaign, 'alertAt'>[] = [
  {
    id: 'black-friday',
    name: 'Black Friday',
    date: nextOccurrence(11, 28),
    scope: 'internacional',
    leadTimeWeeks: 4,
    channelMix: [
      { channel: 'paid_ads', weight: 3, role: 'Principal: pujas y remarketing' },
      { channel: 'email', weight: 3, role: 'Principal: lista de espera + early access' },
      { channel: 'seo', weight: 2, role: 'Páginas de ofertas y comparativas' },
      { channel: 'social', weight: 1, role: 'Contenido de expectación' },
    ],
    copySuggestions: [
      { angle: 'Acceso anticipado para la lista de correo ("todo el catálogo, un solo día")', cta: 'Avísame el jueves' },
      { angle: 'Countdown + top-10 productos con mayor descuento', cta: 'Ver el top de ofertas' },
    ],
  },
  {
    id: 'cyber-monday',
    name: 'Cyber Monday',
    date: nextOccurrence(12, 1),
    scope: 'internacional',
    leadTimeWeeks: 3,
    channelMix: [
      { channel: 'paid_ads', weight: 3, role: 'Prórroga de campañas del viernes' },
      { channel: 'email', weight: 3, role: 'Segmento "añadido al carrito sin comprar"' },
      { channel: 'social', weight: 2, role: 'Urgencia: últimas horas' },
    ],
    copySuggestions: [
      { angle: 'Último día: refuerzo de los productos vistos pero no comprados', cta: 'Cerrar el carrito ahora' },
    ],
  },
  {
    id: 'singles-day',
    name: "Singles' Day (11.11)",
    date: nextOccurrence(11, 11),
    scope: 'internacional',
    leadTimeWeeks: 3,
    channelMix: [
      { channel: 'paid_ads', weight: 3, role: 'Principal en social' },
      { channel: 'email', weight: 2, role: 'Regalo para uno mismo' },
      { channel: 'seo', weight: 2, role: 'Ideas de regalo personal' },
    ],
    copySuggestions: [{ angle: '"El mejor regalo eres tú": auto-regalo con descuento', cta: 'Regálalo hoy' }],
  },
  {
    id: 'navidad',
    name: 'Navidad',
    date: nextOccurrence(12, 25),
    scope: 'internacional',
    leadTimeWeeks: 4,
    channelMix: [
      { channel: 'seo', weight: 3, role: 'Guías de regalo por destinatario' },
      { channel: 'email', weight: 3, role: 'Cascada: guía → stock → envíos → últimas horas' },
      { channel: 'paid_ads', weight: 2, role: 'Retargeting de visitantes de guías' },
    ],
    copySuggestions: [
      { angle: 'Guía de regalos por perfil (para él, para ella, para casa)', cta: 'Ver la guía' },
      { angle: 'Corte de envíos con fecha límite visible', cta: 'Comprar antes del corte' },
    ],
  },
  {
    id: 'prime-day',
    name: 'Prime Day (referencia)',
    date: nextOccurrence(7, 15),
    scope: 'internacional',
    leadTimeWeeks: 3,
    channelMix: [
      { channel: 'paid_ads', weight: 2, role: 'Contraoferta en redes' },
      { channel: 'email', weight: 3, role: '"Mismos precios sin membresía"' },
      { channel: 'seo', weight: 2, role: 'Comparativa alternativas al catálogo Amazon' },
    ],
    copySuggestions: [{ angle: 'Alternativas al mismo precio con envío propio y garantía', cta: 'Comparar opciones' }],
  },
  {
    id: 'rebajas-verano',
    name: 'Rebajas de verano',
    date: nextOccurrence(7, 1),
    scope: 'local',
    leadTimeWeeks: 3,
    channelMix: [
      { channel: 'email', weight: 3, role: 'Segmentación por categoría favorita' },
      { channel: 'paid_ads', weight: 2, role: 'Catálogo dinámico' },
      { channel: 'seo', weight: 1, role: 'Fichas de producto con precio tachado' },
    ],
    copySuggestions: [{ angle: 'Liquidación de temporada por categoría', cta: 'Ver rebajas' }],
  },
  {
    id: 'san-valentin',
    name: 'San Valentín',
    date: nextOccurrence(2, 14),
    scope: 'local',
    leadTimeWeeks: 3,
    channelMix: [
      { channel: 'seo', weight: 3, role: 'Ideas de regalo por presupuesto' },
      { channel: 'social', weight: 2, role: 'Contenido de pareja / auto-regalo' },
      { channel: 'email', weight: 2, role: 'Recordatorio de corte de envíos' },
    ],
    copySuggestions: [{ angle: 'Regalos por presupuesto (20€, 50€, 100€)', cta: 'Elegir por precio' }],
  },
  {
    id: 'vuelta-colegio',
    name: 'Vuelta al cole / oficina',
    date: nextOccurrence(9, 1),
    scope: 'local',
    leadTimeWeeks: 4,
    channelMix: [
      { channel: 'seo', weight: 3, role: 'Listas por perfil (estudiante, teletrabajo)' },
      { channel: 'email', weight: 2, role: 'Bundles de escritorio' },
      { channel: 'paid_ads', weight: 2, role: 'Remarketing de guías' },
    ],
    copySuggestions: [{ angle: 'Bundles de teletrabajo: silla + iluminación + organizador', cta: 'Montar mi setup' }],
  },
];

export const GET: APIRoute = ({ request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ ok: false, error: 'auth_required' }, 401);
  if (session.role !== 'admin') return json({ ok: false, error: 'forbidden' }, 403);

  const campaigns: CommercialCampaign[] = CAMPAIGN_DEFS.map((campaign) => ({
    ...campaign,
    alertAt: alertFor(campaign.date, campaign.leadTimeWeeks),
  }));

  const body: MarketingApiResponse<{ campaigns: CommercialCampaign[] }> = {
    ok: true,
    source: 'mock',
    generatedAt: new Date().toISOString(),
    data: { campaigns },
  };
  return json(body, 200);
};
