import fs from 'node:fs';
import path from 'node:path';
import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { CLIENT_IMAGES_DIR, IMAGES_DIR } from '../../../lib/paths';

export const prerender = false;

/**
 * POST /api/admin/upload-image
 *
 * Sube imágenes y vídeos de producto desde el panel (multipart/form-data) y
 * los guarda en el directorio durable de medios. Devuelve las URLs públicas
 * (/images/products/...). Acepta varios archivos a la vez (campo "images").
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB por imagen
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB por vídeo
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
};
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

function slugifyFilename(text: string): string {
  const base = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 40);
  return base || 'producto';
}

/** Guarda bytes en las rutas durables y sirvibles, y devuelve la URL pública. */
function persist(bytes: Buffer, originalName: string, ext: string): string {
  const base = slugifyFilename(originalName.replace(/\.[^.]+$/, ''));
  const filename = `${base}-${Date.now().toString(36)}.${ext}`;
  const relativeUrl = `/images/products/${filename}`;

  // 1) Fuente durable: IMAGES_DIR (volumen en producción, public/ en local).
  try {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.writeFileSync(path.join(IMAGES_DIR, filename), bytes);
  } catch (error) {
    console.error('[UploadImage] Error al escribir en IMAGES_DIR:', error);
  }

  // 2) Copia servible por el standalone de Node (dist/client).
  try {
    fs.mkdirSync(CLIENT_IMAGES_DIR, { recursive: true });
    fs.writeFileSync(path.join(CLIENT_IMAGES_DIR, filename), bytes);
  } catch (error) {
    console.error('[UploadImage] Error al escribir en CLIENT_IMAGES_DIR:', error);
  }

  return relativeUrl;
}

export const POST: APIRoute = async ({ request }) => {
  const unauthorizedResponse = requireAdminAuth(request);
  if (unauthorizedResponse) return unauthorizedResponse;

  try {
    const formData = await request.formData();
    const entries = formData.getAll('images').filter((v): v is File => v instanceof File);
    if (!entries.length) {
      return json({ success: false, message: 'No se recibió ningún archivo (campo images).' }, 400);
    }
    if (entries.length > 10) {
      return json({ success: false, message: 'Máximo 10 archivos por subida.' }, 400);
    }

    const urls: string[] = [];
    const errors: string[] = [];

    for (const file of entries) {
      const extFromName = (file.name.split('.').pop() ?? '').toLowerCase();
      const ext = EXT_BY_MIME[file.type] ?? (MIME_BY_EXT[extFromName] ? extFromName : '');
      if (!ext) {
        errors.push(`"${file.name}": formato no admitido (usa JPG, PNG, WebP, MP4 o WebM).`);
        continue;
      }
      const isVideo = file.type.startsWith('video/') || ext === 'mp4' || ext === 'webm';
      const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (file.size > maxBytes) {
        errors.push(
          `"${file.name}": supera el máximo de ${isVideo ? '50MB (vídeo)' : '5MB (imagen)'}.`
        );
        continue;
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      urls.push(persist(buffer, file.name, ext));
    }

    if (!urls.length) {
      return json({ success: false, message: errors.join(' ') || 'Ningún archivo válido.' }, 415);
    }

    return json({ success: true, urls, errors: errors.length ? errors : undefined }, 200);
  } catch (error: any) {
    console.error('[UploadImage] Error no controlado:', error);
    return json({ success: false, message: error?.message || 'No se pudieron subir las imágenes.' }, 400);
  }
};
