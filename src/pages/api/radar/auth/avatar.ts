import fs from 'node:fs';
import type { APIRoute } from 'astro';
import {
  RadarAuthError,
  getRadarSessionUser,
  radarAvatarPath,
  setRadarAvatar,
  clearRadarAvatar,
} from '../../../../lib/radarAuth';
import { RADAR_AVATARS_DIR } from '../../../../lib/paths';

export const prerender = false;

const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Sirve el avatar del usuario autenticado (sólo suyo: la sesión es la cookie). */
export const GET: APIRoute = ({ request }) => {
  const user = getRadarSessionUser(request);
  if (!user) return json({ success: false, message: 'Autenticación requerida.' }, 401);
  if (!user.avatar) return json({ success: false, message: 'Este usuario no tiene foto de perfil.' }, 404);

  const filePath = radarAvatarPath(user.avatar);
  if (!fs.existsSync(filePath)) return json({ success: false, message: 'Avatar no encontrado.' }, 404);

  const ext = user.avatar.split('.').pop()?.toLowerCase() ?? 'png';
  const data = fs.readFileSync(filePath);
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
    },
  });
};

/** Sube o elimina el avatar del usuario autenticado. */
export const POST: APIRoute = async ({ request }) => {
  const session = getRadarSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticación requerida.' }, 401);

  try {
    const formData = await request.formData();
    const action = formData.get('action');

    if (action === 'delete') {
      const user = clearRadarAvatar(session.id);
      return json({ success: true, user }, 200);
    }

    const file = formData.get('avatar');
    if (!(file instanceof File)) return json({ success: false, message: 'Falta la imagen (campo avatar).' }, 400);

    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    const extByType: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
    const normalizedExt = extByType[file.type] ?? (MIME_BY_EXT[ext] ? ext : '');
    if (!normalizedExt) return json({ success: false, message: 'Formato no admitido. Usa JPG, PNG o WebP.' }, 415);
    if (file.size > MAX_BYTES) return json({ success: false, message: 'La imagen supera el máximo de 2MB.' }, 413);

    const buffer = Buffer.from(await file.arrayBuffer());
    fs.mkdirSync(RADAR_AVATARS_DIR, { recursive: true });
    const filename = `${session.id}.${normalizedExt}`;
    fs.writeFileSync(radarAvatarPath(filename), buffer);

    const user = setRadarAvatar(session.id, filename);
    return json({ success: true, user }, 200);
  } catch (error) {
    if (error instanceof RadarAuthError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'No se pudo subir la imagen.' }, 400);
  }
};
