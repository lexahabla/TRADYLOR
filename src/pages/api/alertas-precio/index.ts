export const prerender = false;

import type { APIRoute } from 'astro';
import { forbiddenOrigin, json, readJson, requireUser, sameOrigin } from '../../../lib/alertsHttp';
import { AlertError, alertValue, createAlert, currentPriceOf, dropVisitsEnabled, evaluateAlerts, getPrefs, listAlerts, listNotifications, unreadCount } from '../../../lib/priceAlertCenter';
import { productKey } from '../../../lib/catalog';

/** GET: alertas, notificaciones y preferencias del PROPIO usuario. POST: crea (o actualiza) una alerta por precio objetivo. */
export const GET: APIRoute = ({ request }) => {
  const auth = requireUser(request);
  if (auth instanceof Response) return auth;
  const alerts = listAlerts(auth.userId).map((a) => {
    const cur = currentPriceOf(a.productId);
    return {
      ...a,
      href: cur ? `/producto/${encodeURIComponent(productKey(cur.product))}` : `/producto/${encodeURIComponent(a.productId)}`,
      current: cur ? { price: cur.price, value: alertValue(a, cur), total: cur.total, asOf: cur.asOf } : null,
    };
  });
  const notifications = listNotifications(auth.userId).slice(0, 100).map((n) => ({ ...n, href: `/producto/${encodeURIComponent(n.productId)}` }));
  return json({ alerts, notifications, unread: unreadCount(auth.userId), prefs: getPrefs(auth.userId), dropAlertsAvailable: dropVisitsEnabled() });
};

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = requireUser(request);
  if (auth instanceof Response) return auth;
  const body = await readJson(request);
  if (!body) return json({ error: 'json_invalido' }, 400);
  try {
    const alert = createAlert(auth.userId, { productId: String(body.productId ?? ''), targetPrice: Number(body.targetPrice), includeShipping: body.includeShipping === true });
    // Comprobación inmediata: si el precio registrado ya cumple el objetivo, se avisa en el acto (sin esperar al siguiente ciclo).
    const run = await evaluateAlerts();
    const fresh = listAlerts(auth.userId).find((a) => a.id === alert.id) ?? alert;
    return json({ alert: fresh, alreadyMet: fresh.status === 'met', run: { alertsChecked: run.alertsChecked } }, 201);
  } catch (error) {
    if (error instanceof AlertError) return json({ error: error.code, message: error.message }, 400);
    throw error;
  }
};
