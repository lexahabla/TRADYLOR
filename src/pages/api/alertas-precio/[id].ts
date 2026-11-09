export const prerender = false;

import type { APIRoute } from 'astro';
import { forbiddenOrigin, json, readJson, requireUser, sameOrigin } from '../../../lib/alertsHttp';
import { AlertError, deleteAlert, updateAlert } from '../../../lib/priceAlertCenter';

/** PATCH: modifica el objetivo, el envío incluido o activa/pausa. DELETE: elimina. Sólo el propietario (si no es suya: 404). */
export const PATCH: APIRoute = async ({ request, params }) => {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = requireUser(request);
  if (auth instanceof Response) return auth;
  const body = await readJson(request);
  if (!body) return json({ error: 'json_invalido' }, 400);
  try {
    const alert = updateAlert(auth.userId, String(params.id ?? ''), {
      targetPrice: body.targetPrice === undefined ? undefined : Number(body.targetPrice),
      includeShipping: typeof body.includeShipping === 'boolean' ? body.includeShipping : undefined,
      active: typeof body.active === 'boolean' ? body.active : undefined,
    });
    return json({ alert });
  } catch (error) {
    if (error instanceof AlertError) return json({ error: error.code, message: error.message }, error.code === 'no_encontrada' ? 404 : 400);
    throw error;
  }
};

export const DELETE: APIRoute = ({ request, params }) => {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = requireUser(request);
  if (auth instanceof Response) return auth;
  return deleteAlert(auth.userId, String(params.id ?? '')) ? json({ ok: true }) : json({ error: 'no_encontrada' }, 404);
};
