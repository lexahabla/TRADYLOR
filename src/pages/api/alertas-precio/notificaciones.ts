export const prerender = false;

import type { APIRoute } from 'astro';
import { forbiddenOrigin, json, readJson, requireUser, sameOrigin } from '../../../lib/alertsHttp';
import { markRead, unreadCount } from '../../../lib/priceAlertCenter';

/** POST { ids: string[] } o { all: true }: marca como leídas las notificaciones del propio usuario. */
export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = requireUser(request);
  if (auth instanceof Response) return auth;
  const body = await readJson(request);
  if (!body) return json({ error: 'json_invalido' }, 400);
  const ids = body.all === true ? 'all' : Array.isArray(body.ids) ? body.ids.map(String).slice(0, 500) : [];
  const marked = markRead(auth.userId, ids as string[] | 'all');
  return json({ marked, unread: unreadCount(auth.userId) });
};
