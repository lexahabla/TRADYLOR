/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: PORTADA EDITABLE (etapa 1, SOLO LECTURA)
 * ==============================================================================
 * GET /api/admin/home-layout
 *   -> { success, mode, status, schemaVersion, activation, draft, published, versions, errors, catalog }
 *
 * Solo administradores (comprobado en el servidor). No escribe, no publica y no activa nada. No devuelve rutas del servidor ni datos
 * sensibles: solo recuentos, el estado del almacenamiento y las listas de modalidades, formatos y anchos admitidos.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { readHomeLayout, resolveHomeMode } from '../../../../lib/homeLayout/store';
import { CARD_KINDS, FORMATS, MODALITIES, SCHEMA_VERSION, WIDTHS } from '../../../../lib/homeLayout/types';
import { FORMAT_REGISTRY, MODALITY_REGISTRY } from '../../../../lib/homeLayout/validate';

export const prerender = false;

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const read = readHomeLayout();
  const doc = read.doc;
  return new Response(
    JSON.stringify({
      success: true,
      /** Portada que se sirve hoy: en la etapa 1 siempre `legacy` (la portada actual). */
      mode: resolveHomeMode(),
      /** Estado del almacenamiento: missing | ok | corrupt | invalid | newer. */
      status: read.status,
      errors: read.errors,
      schemaVersion: SCHEMA_VERSION,
      activation: doc.activation,
      draft: { blocks: doc.draft.blocks.length, updatedAt: doc.draft.updatedAt },
      published: doc.published ? { version: doc.published.version, publishedAt: doc.published.publishedAt, blocks: doc.published.blocks.length } : null,
      versions: doc.versions.length,
      catalog: {
        modalities: MODALITIES.map((id) => ({ id, label: MODALITY_REGISTRY[id].label })),
        formats: FORMATS.map((id) => ({ id, label: FORMAT_REGISTRY[id].label })),
        widths: WIDTHS,
        cards: CARD_KINDS,
        provisional: true,
      },
    }),
    { status: 200, headers },
  );
};
