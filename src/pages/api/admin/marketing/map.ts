/**
 * GET /api/admin/marketing/map — Market Map (mock).
 *
 * Tráfico y ventas por país + señales de mercados emergentes. Preparado para
 * sustituir MOCK por la analítica real por geolocalización de la tienda.
 */
import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../../lib/adminAuth';
import type { CountryMetric, EmergingMarketSignal, MarketMapSnapshot, MarketingApiResponse } from '../../../../types/marketing';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const MOCK_COUNTRIES: CountryMetric[] = [
  { iso: 'ES', country: 'España', sessions: 48210, sales: 512, revenue: 24180.5, conversionRate: 1.06, trafficChangePct: 8.4, emerging: false },
  { iso: 'FR', country: 'Francia', sessions: 15870, sales: 121, revenue: 5980.2, conversionRate: 0.76, trafficChangePct: 12.1, emerging: false },
  { iso: 'DE', country: 'Alemania', sessions: 12440, sales: 87, revenue: 4410.9, conversionRate: 0.7, trafficChangePct: 6.2, emerging: false },
  { iso: 'IT', country: 'Italia', sessions: 9830, sales: 64, revenue: 3120.4, conversionRate: 0.65, trafficChangePct: 9.8, emerging: false },
  { iso: 'PT', country: 'Portugal', sessions: 6120, sales: 41, revenue: 1870.7, conversionRate: 0.67, trafficChangePct: 14.5, emerging: false },
  { iso: 'MX', country: 'México', sessions: 5340, sales: 12, revenue: 512.3, conversionRate: 0.22, trafficChangePct: 86.4, emerging: true },
  { iso: 'CO', country: 'Colombia', sessions: 3110, sales: 5, revenue: 198.9, conversionRate: 0.16, trafficChangePct: 64.2, emerging: true },
  { iso: 'PL', country: 'Polonia', sessions: 2870, sales: 9, revenue: 387.5, conversionRate: 0.31, trafficChangePct: 51.7, emerging: true },
  { iso: 'US', country: 'Estados Unidos', sessions: 7420, sales: 38, revenue: 2450.8, conversionRate: 0.51, trafficChangePct: 3.9, emerging: false },
  { iso: 'GB', country: 'Reino Unido', sessions: 6690, sales: 33, revenue: 1930.1, conversionRate: 0.49, trafficChangePct: -2.4, emerging: false },
];

const MOCK_EMERGING: EmergingMarketSignal[] = [
  {
    iso: 'MX',
    country: 'México',
    trafficChangePct: 86.4,
    conversionRate: 0.22,
    severity: 'alta',
    recommendation:
      'Pico de tráfico con conversión muy por debajo de la media: activar envío con precio local, checkout en MXN y campaña de confianza (envío + devoluciones).',
  },
  {
    iso: 'CO',
    country: 'Colombia',
    trafficChangePct: 64.2,
    conversionRate: 0.16,
    severity: 'media',
    recommendation:
      'Interés creciente sin conversión: probar enlaces de afiliado con creatividades en español neutro y oferta de estreno.',
  },
  {
    iso: 'PL',
    country: 'Polonia',
    trafficChangePct: 51.7,
    conversionRate: 0.31,
    severity: 'media',
    recommendation:
      'Conversión intermedia con tráfico al alza: localizar fichas de los 20 productos top y comparar precios con el mercado local.',
  },
];

export const GET: APIRoute = ({ request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ ok: false, error: 'auth_required' }, 401);
  if (session.role !== 'admin') return json({ ok: false, error: 'forbidden' }, 403);

  const body: MarketingApiResponse<MarketMapSnapshot> = {
    ok: true,
    source: 'mock',
    generatedAt: new Date().toISOString(),
    data: { activeLayer: 'traffic', countries: MOCK_COUNTRIES, emergingMarkets: MOCK_EMERGING },
  };
  return json(body, 200);
};
