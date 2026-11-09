export const prerender = false;

import type { APIRoute } from 'astro';
import { json, readJson, requireUser, sameOrigin } from '../../../lib/alertsHttp';
import { clearVisits, getPrefs, setPrefs } from '../../../lib/priceAlertCenter';

/** GET/PUT de las preferencias: avisos internos y correos, por separado, para cada tipo de aviso. Se aplican de inmediato. */
export const GET: APIRoute = ({ request }) => {
  const auth = requireUser(request);
  if (auth instanceof Response) return auth;
  return json({ prefs: getPrefs(auth.userId) });
};

export const PUT: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ error: 'origen_no_permitido' }, 403);
  const auth = requireUser(request);
  if (auth instanceof Response) return auth;
  const body = await readJson(request);
  if (!body) return json({ error: 'json_invalido' }, 400);
  const prefs = setPrefs(auth.userId, { targets: body.targets, drops: body.drops });
  // Desactivar TODOS los avisos de bajada elimina además las visitas guardadas de este usuario.
  if (prefs.drops.inApp === false && prefs.drops.email === false) clearVisits(auth.userId);
  return json({ prefs });
};
