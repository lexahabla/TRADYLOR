import fs from 'node:fs';
import type { APIRoute } from 'astro';
import { getSessionUser } from '../../../../../lib/adminAuth';
import { AVATARS_DIR } from '../../../../../lib/paths';
import { avatarPath, findUserById, setAvatar, UserError } from '../../../../../lib/userStore';

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

export const GET: APIRoute = ({ params, request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticacion requerida.' }, 401);

  const user = findUserById(params.id ?? '');
  if (!user) return json({ success: false, message: 'Usuario no encontrado.' }, 404);
  if (!user.avatar) return json({ success: false, message: 'Este usuario no tiene foto de perfil.' }, 404);

  const filePath = avatarPath(user.avatar);
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

export const POST: APIRoute = async ({ params, request }) => {
  const session = getSessionUser(request);
  if (!session) return json({ success: false, message: 'Autenticacion requerida.' }, 401);

  const id = params.id ?? '';
  if (id !== session.id && session.role !== 'admin') {
    return json({ success: false, message: 'No tienes permisos para cambiar la foto de este usuario.' }, 403);
  }
  const target = findUserById(id);
  if (!target) return json({ success: false, message: 'Usuario no encontrado.' }, 404);
  if (target.master && id !== session.id) {
    return json({ success: false, message: 'Solo el usuario master puede cambiar su foto.' }, 403);
  }
  if (target.role === 'admin' && id !== session.id && !session.master) {
    return json({ success: false, message: 'Solo el usuario master puede cambiar la foto de administradores.' }, 403);
  }

  try {
    const formData = await request.formData();
    const file = formData.get('avatar');
    if (!(file instanceof File)) return json({ success: false, message: 'Falta la imagen (campo avatar).' }, 400);

    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    const extByType: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
    const normalizedExt = extByType[file.type] ?? (MIME_BY_EXT[ext] ? ext : '');
    if (!normalizedExt) return json({ success: false, message: 'Formato no admitido. Usa JPG, PNG o WebP.' }, 415);
    if (file.size > MAX_BYTES) return json({ success: false, message: 'La imagen supera el máximo de 2MB.' }, 413);

    const buffer = Buffer.from(await file.arrayBuffer());
    fs.mkdirSync(AVATARS_DIR, { recursive: true });
    const filename = `${target.id}.${normalizedExt}`;
    fs.writeFileSync(avatarPath(filename), buffer);

    const user = setAvatar(target.id, filename);
    return json({ success: true, user }, 200);
  } catch (error) {
    if (error instanceof UserError) return json({ success: false, message: error.message }, error.status);
    return json({ success: false, message: 'No se pudo subir la imagen.' }, 400);
  }
};
