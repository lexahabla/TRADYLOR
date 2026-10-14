/**
 * GET /api/admin/marketing/trends — Escucha activa y matriz de canales (mock).
 *
 * Tendencias de búsqueda por categoría del catálogo + recomendación de redes
 * sociales por tipo de producto. Preparado para conectarse a Google Trends /
 * APIs de escucha social.
 */
import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../../lib/adminAuth';
import type { MarketingApiResponse, TrendsSnapshot } from '../../../../types/marketing';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const MOCK_TRENDS: TrendsSnapshot['trends'] = [
  { id: 'tr-1', category: 'Tecnología', keyword: 'auriculares inalámbricos cancelación ruido', source: 'google_trends', volumeIndex: 87, changePct: 24.5, window: '90d' },
  { id: 'tr-2', category: 'Hogar', keyword: 'lámpara led ambiental', source: 'google_trends', volumeIndex: 74, changePct: 18.2, window: '90d' },
  { id: 'tr-3', category: 'Oficina', keyword: 'silla ergonómica barata', source: 'google_trends', volumeIndex: 69, changePct: 31.8, window: '90d' },
  { id: 'tr-4', category: 'Cocina', keyword: 'air fryer accesorios', source: 'social_listening', volumeIndex: 81, changePct: 42.1, window: '30d' },
  { id: 'tr-5', category: 'Belleza', keyword: 'pestañas postizas imán', source: 'social_listening', volumeIndex: 77, changePct: 55.4, window: '30d' },
  { id: 'tr-6', category: 'Mascotas', keyword: 'fuente de agua gatos', source: 'google_trends', volumeIndex: 58, changePct: -6.3, window: '90d' },
];

const MOCK_MATRIX: TrendsSnapshot['channelMatrix'] = [
  {
    categoryType: 'Producto visual / decoración',
    channels: [
      { channel: 'instagram', fit: 'alto', reason: 'Reels de transformación antes/después y estética de marca.', bestFormat: 'Reel 15s + carrusel' },
      { channel: 'pinterest', fit: 'alto', reason: 'Búsqueda inspiracional con intención de compra alta.', bestFormat: 'Pin vertical con precio' },
      { channel: 'tiktok', fit: 'medio', reason: 'Funciona con hook de "finds" y hauls.', bestFormat: 'Vídeo UGC 20s' },
    ],
  },
  {
    categoryType: 'Producto técnico / especificaciones',
    channels: [
      { channel: 'youtube', fit: 'alto', reason: 'Comparativas y reviews resuelven dudas de compra caras.', bestFormat: 'Review 8-12 min' },
      { channel: 'tiktok', fit: 'medio', reason: 'Demos rápidas y "test de 30 días".', bestFormat: 'Demo corta con caption técnico' },
      { channel: 'linkedin', fit: 'bajo', reason: 'Poco volumen de conversión directa B2C.', bestFormat: 'Caso de uso' },
    ],
  },
  {
    categoryType: 'Perfil profesional / B2B',
    channels: [
      { channel: 'linkedin', fit: 'alto', reason: 'Targeting por puesto y sector para compras de empresa.', bestFormat: 'Post + documento' },
      { channel: 'youtube', fit: 'medio', reason: 'Contenido de productividad y setups de oficina.', bestFormat: 'Tutorial' },
      { channel: 'pinterest', fit: 'bajo', reason: 'Poca presencia del comprador B2B.', bestFormat: '—' },
    ],
  },
  {
    categoryType: 'Belleza / personal care',
    channels: [
      { channel: 'tiktok', fit: 'alto', reason: 'Tendencia de routine y demos con conversión viral.', bestFormat: 'Tutorial 30s' },
      { channel: 'instagram', fit: 'alto', reason: 'Confianza con creadoras y Stories con enlace.', bestFormat: 'Reel + Stories' },
      { channel: 'youtube', fit: 'medio', reason: 'Reseñas largas de rutina completa.', bestFormat: 'Review 10 min' },
    ],
  },
  {
    categoryType: 'Mascotas',
    channels: [
      { channel: 'tiktok', fit: 'alto', reason: 'Contenido de mascotas con altísimo engagement orgánico.', bestFormat: 'Vídeo cute + producto' },
      { channel: 'instagram', fit: 'medio', reason: 'Comunidad y colaboración con perfiles de nicho.', bestFormat: 'Reel + colaboración' },
      { channel: 'youtube', fit: 'medio', reason: 'Guías de cuidado y entrenamiento.', bestFormat: 'Tutorial 6 min' },
    ],
  },
];

export const GET: APIRoute = ({ request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ ok: false, error: 'auth_required' }, 401);
  if (session.role !== 'admin') return json({ ok: false, error: 'forbidden' }, 403);

  const body: MarketingApiResponse<TrendsSnapshot> = {
    ok: true,
    source: 'mock',
    generatedAt: new Date().toISOString(),
    data: { trends: MOCK_TRENDS, channelMatrix: MOCK_MATRIX },
  };
  return json(body, 200);
};
