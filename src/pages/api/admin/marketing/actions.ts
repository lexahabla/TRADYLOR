/**
 * GET /api/admin/marketing/actions — Playbooks de conversión (mock).
 *
 * Biblioteca operativa (up-selling, cross-selling, fidelización) lista para
 * persistir en la BD y versionar por campaña.
 */
import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../../lib/adminAuth';
import type { MarketingApiResponse, Playbook } from '../../../../types/marketing';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const MOCK_PLAYBOOKS: Playbook[] = [
  {
    id: 'pb-upsell-ficha',
    title: 'Up-selling en la ficha de producto',
    strategy: 'upselling',
    goal: 'Subir el ticket medio mostrando la alternativa premium en el mismo momento de decisión.',
    steps: [
      'Elegir las 20 categorías con mayor volumen de vistas.',
      'Añadir bloque "La opción premium" con la diferencia de beneficios (no sólo precio).',
      'Incluir prueba social de la versión premium (valoración + nº de reseñas).',
      'Medir % de clics en el bloque y AOV de las sesiones que lo ven.',
    ],
    kpis: ['AOV', '% clic premium', 'Conversión de ficha'],
    estimatedLiftPct: 12,
  },
  {
    id: 'pb-crosssell-postcompra',
    title: 'Cross-selling post-compra (email + carrito delegado)',
    strategy: 'cross-selling',
    goal: 'Aprovechar la confianza de la compra recién hecha para añadir complementos compatibles.',
    steps: [
      'Mapear complementos por producto principal (3 como máximo).',
      'Enviar email D+2 con "Para completar tu compra" y enlace directo al carrito delegado.',
      'Replicar el mismo bloque al final de la ficha de los productos ya comprados.',
      'Rotar los complementos según stock y margen.',
    ],
    kpis: ['Tasa de apertura', 'Ingreso por email', 'Añadidos al carrito'],
    estimatedLiftPct: 9,
  },
  {
    id: 'pb-fidelizacion-radar',
    title: 'Fidelización vía Mi Radar',
    strategy: 'fidelizacion',
    goal: 'Convertir el carrito de deseos (Mi Radar) en segunda compra con alertas de precio.',
    steps: [
      'Segmentar usuarios con ≥3 productos guardados sin comprar.',
      'Aviso de bajada de precio / stock limitado del producto guardado.',
      'Recompensa: envío gratis en la siguiente compra si compran antes de 14 días.',
      'Reactivar a los 30 días con la lista actualizada de su Radar.',
    ],
    kpis: ['Reactivación 30d', 'Productos guardados → compras', 'LTV a 90 días'],
    estimatedLiftPct: 15,
  },
  {
    id: 'pb-bundle-temporada',
    title: 'Bundles de temporada por hobby',
    strategy: 'cross-selling',
    goal: 'Agrupar productos del mismo perfil 360° en packs con ahorro percibido.',
    steps: [
      'Cruzar hobbies más frecuentes con categorías del catálogo.',
      'Definir 5 bundles con precio pack (-10% vs. suma individual).',
      'Página propia del bundle + email a la segmentación del hobby.',
      'Creatividades en Ads apuntando al bundle, no al producto suelto.',
    ],
    kpis: ['Ventas por bundle', 'AOV del pack', 'ROAS de campaña'],
    estimatedLiftPct: 18,
  },
];

export const GET: APIRoute = ({ request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ ok: false, error: 'auth_required' }, 401);
  if (session.role !== 'admin') return json({ ok: false, error: 'forbidden' }, 403);

  const body: MarketingApiResponse<{ playbooks: Playbook[] }> = {
    ok: true,
    source: 'mock',
    generatedAt: new Date().toISOString(),
    data: { playbooks: MOCK_PLAYBOOKS },
  };
  return json(body, 200);
};
