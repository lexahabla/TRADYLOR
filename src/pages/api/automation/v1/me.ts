/**
 * GET /api/automation/v1/me — quién es el token y qué puede hacer (diagnóstico, sin datos del catálogo).
 * Mismo esquema de seguridad que `catalog`: desactivada por defecto (404), token propio, límites y auditoría.
 * Cualquier token activo puede consultar su propia identidad (alcance mínimo `catalog:read`).
 */
import type { APIRoute } from 'astro';
import { audit, authenticate, authFailureResponse, automationEnabled, automationJson, clientIpOf, disabledResponse } from '../../../../lib/automationApi';

export const prerender = false;

export const GET: APIRoute = ({ request }) => {
  if (!automationEnabled()) return disabledResponse();
  const auth = authenticate(request, 'catalog:read');
  if (!auth.ok) return authFailureResponse(auth);
  const c = auth.client;
  audit({ event: 'peticion', clientId: c.id, scope: 'catalog:read', method: 'GET', path: new URL(request.url).pathname, status: 200, ip: clientIpOf(request) });
  return automationJson(200, {
    success: true,
    client: { id: c.id, name: c.name, scopes: c.scopes, expiresAt: c.expiresAt, ratePerMinute: c.ratePerMinute, dailyQuota: c.dailyQuota },
    readOnly: true,
  });
};

export const ALL: APIRoute = () => {
  if (!automationEnabled()) return disabledResponse();
  return automationJson(405, { success: false, code: 'metodo_no_permitido', message: 'Sólo GET.' }, { Allow: 'GET' });
};
