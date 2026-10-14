/**
 * GET /api/admin/marketing/users — Audiencias y perfiles 360° (mock).
 *
 * Contrato preparado para sustituir MOCK por lecturas reales de
 * radar-users.json + analítica de la tienda (LTV, carrito, favoritos).
 */
import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../../lib/adminAuth';
import type { AudienceProfile360, AudienceSegment, AudienceSync, MarketingApiResponse } from '../../../../types/marketing';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const MOCK_PROFILES: AudienceProfile360[] = [
  {
    id: 'u-1001',
    email: 'laura.garcia@ejemplo.es',
    name: 'Laura García',
    declared: { hobbies: ['decoración', 'cocina', 'bienestar'], profileType: 'particular', city: 'Valencia', country: 'España' },
    behavior: {
      ltv: 412.9,
      currency: 'EUR',
      lastPurchaseAt: '2026-09-18T10:24:00.000Z',
      favoriteProducts: [
        { id: 'lampara-led-smart-3', title: 'Lámpara LED smart', category: 'Hogar', timesSaved: 4 },
        { id: 'sartén-antiadherente-28', title: 'Sartén antiadherente 28 cm', category: 'Cocina', timesSaved: 2 },
      ],
      cart: { items: 2, total: 89.98, currency: 'EUR', updatedAt: '2026-10-11T19:02:00.000Z' },
      sessions: 37,
    },
    leadScore: {
      value: 84,
      band: 'caliente',
      factors: [
        { key: 'profile_complete', label: 'Perfil completado', points: 25 },
        { key: 'recurrent_buyer', label: 'Compras recurrentes', points: 30 },
        { key: 'active_cart', label: 'Carrito activo', points: 15 },
        { key: 'engagement', label: 'Sesiones (30d)', points: 14 },
      ],
    },
  },
  {
    id: 'u-1002',
    email: 'carlos.mendez@ejemplo.com',
    name: 'Carlos Méndez',
    declared: { hobbies: ['tecnología', 'gaming', 'fotografía'], profileType: 'autonomo', city: 'Madrid', country: 'España' },
    behavior: {
      ltv: 156.4,
      currency: 'EUR',
      lastPurchaseAt: '2026-07-02T17:45:00.000Z',
      favoriteProducts: [{ id: 'auriculares-inalambricos-7', title: 'Auriculares inalámbricos', category: 'Tecnología', timesSaved: 6 }],
      cart: { items: 0, total: 0, currency: 'EUR', updatedAt: null },
      sessions: 12,
    },
    leadScore: {
      value: 57,
      band: 'tibio',
      factors: [
        { key: 'profile_complete', label: 'Perfil completado', points: 25 },
        { key: 'one_time_buyer', label: 'Compra única', points: 15 },
        { key: 'stale_cart', label: 'Sin carrito activo', points: 0 },
        { key: 'engagement', label: 'Sesiones (30d)', points: 17 },
      ],
    },
  },
  {
    id: 'u-1003',
    email: 'compras@estudio-norte.es',
    name: 'Estudio Norte S.L.',
    declared: { hobbies: ['oficina', 'iluminación', 'ergonomía'], profileType: 'empresa', city: 'Bilbao', country: 'España' },
    behavior: {
      ltv: 1240.0,
      currency: 'EUR',
      lastPurchaseAt: '2026-10-01T09:15:00.000Z',
      favoriteProducts: [{ id: 'silla-ergonomica-pro', title: 'Silla ergonómica Pro', category: 'Oficina', timesSaved: 9 }],
      cart: { items: 4, total: 596.0, currency: 'EUR', updatedAt: '2026-10-13T08:30:00.000Z' },
      sessions: 54,
    },
    leadScore: {
      value: 92,
      band: 'caliente',
      factors: [
        { key: 'profile_complete', label: 'Perfil completado', points: 25 },
        { key: 'high_ltv', label: 'LTV elevado', points: 35 },
        { key: 'active_cart', label: 'Carrito activo', points: 15 },
        { key: 'engagement', label: 'Sesiones (30d)', points: 17 },
      ],
    },
  },
];

const MOCK_SEGMENTS: AudienceSegment[] = [
  { id: 'seg-calientes', name: 'Lead score ≥ 80', filters: ['leadScore >= 80', 'carrito activo'], size: 1, avgLeadScore: 88 },
  { id: 'seg-b2b', name: 'Perfiles empresa (B2B)', filters: ['profileType = empresa'], size: 1, avgLeadScore: 92 },
  { id: 'seg-rosca', name: 'Compra única sin recurrencia', filters: ['compras = 1', 'ultima compra > 90d'], size: 1, avgLeadScore: 57 },
];

const MOCK_SYNC: AudienceSync = {
  platform: 'brevo',
  status: 'disconnected',
  lastSyncAt: null,
  audienceSize: 0,
};

export const GET: APIRoute = ({ request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ ok: false, error: 'auth_required' }, 401);
  if (session.role !== 'admin') return json({ ok: false, error: 'forbidden' }, 403);

  const body: MarketingApiResponse<{
    profiles: AudienceProfile360[];
    segments: AudienceSegment[];
    sync: AudienceSync;
  }> = {
    ok: true,
    source: 'mock',
    generatedAt: new Date().toISOString(),
    data: { profiles: MOCK_PROFILES, segments: MOCK_SEGMENTS, sync: MOCK_SYNC },
  };
  return json(body, 200);
};
