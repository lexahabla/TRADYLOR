import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { ensureSnapshot, removeSnapshot } from '../../../lib/topSelections';
import { readSections, upsertSection, deleteSection, findSection, slugifySection, type WebSection, type SectionSpeed } from '../../../lib/sections';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  return new Response(JSON.stringify({ success: true, sections: readSections() }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  const body = await request.json().catch(() => ({}));
  const action = String(body?.action || 'create');

  if (action === 'create' || action === 'update') {
    const rawId = body?.id ? String(body.id).trim() : '';
    const existing = rawId ? findSection(rawId) : undefined;
    const title = String(body?.title !== undefined ? body.title : (existing?.title || '')).trim();
    if (!title) {
      return new Response(JSON.stringify({ success: false, message: 'El título es obligatorio' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const id = rawId || slugifySection(title);
    const position = body?.position ? (body.position === 'above' ? 'above' : 'below') : (existing?.position || 'below');
    const rawSpeed = body?.speed !== undefined ? String(body.speed).toLowerCase().trim() : (existing?.speed || 'normal');
    const speed: SectionSpeed = ['slow', 'normal', 'fast', 'none'].includes(rawSpeed)
      ? (rawSpeed as SectionSpeed)
      : 'normal';

    const section: WebSection = {
      id,
      title,
      description: body?.description !== undefined ? (body.description ? String(body.description) : undefined) : existing?.description,
      productIds: Array.isArray(body?.productIds) ? body.productIds.map((x: unknown) => String(x)) : (existing?.productIds || []),
      published: typeof body?.published === 'boolean' ? body.published : (existing ? existing.published : true),
      order: typeof body?.order === 'number' ? body.order : (existing?.order ?? readSections().length),
      position,
      speed,
      createdAt: existing?.createdAt || (body?.createdAt ? String(body.createdAt) : new Date().toISOString()),
    };
    // Crear una sección NO la añade al menú «Top Selecciones»: antes se fija el menú vigente (si todavía no hay configuración manual). Si no se puede
    // fijar, la sección NO se crea (sin estados parciales); si la creación falla después, se deshace la copia fija recién hecha.
    let snapshotCreated = false;
    if (!existing) {
      const snap = ensureSnapshot();
      if (!snap.ok) {
        return new Response(JSON.stringify({ success: false, code: snap.reason, message: `No se creó la sección: ${snap.errors[0] ?? 'no se pudo fijar el menú «Top Selecciones»'}` }), {
          status: snap.reason === 'archivo_protegido' ? 423 : 500, headers: { 'Content-Type': 'application/json' },
        });
      }
      snapshotCreated = snap.created;
    }
    const ok = upsertSection(section);
    if (!ok && snapshotCreated) removeSnapshot();
    return new Response(JSON.stringify({ success: ok, section }), {
      status: ok ? 200 : 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (action === 'delete') {
    const id = String(body?.id || '');
    if (!id) return new Response(JSON.stringify({ success: false, message: 'ID requerido' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const ok = deleteSection(id);
    return new Response(JSON.stringify({ success: ok }), { status: ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ success: false, message: 'Acción no reconocida' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
};
