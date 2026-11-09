export const prerender = false;

import type { APIRoute } from 'astro';
import { json, requireUser } from '../../../lib/alertsHttp';
import { unreadCount } from '../../../lib/priceAlertCenter';

/** GET: sólo el nº de avisos sin leer (lo consulta la campana del menú de usuario). */
export const GET: APIRoute = ({ request }) => {
  const auth = requireUser(request);
  if (auth instanceof Response) return auth;
  return json({ unread: unreadCount(auth.userId) });
};
