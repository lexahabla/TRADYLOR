/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: CLIENTES DE LA API DE AUTOMATIZACIÓN (tokens propios, caducidad, revocación)
 * ==============================================================================
 * GET  /api/admin/automation-clients[?audit=N]   Lista los clientes (sin sal ni huella) y, con `audit`, las últimas N entradas de auditoría.
 * POST { action:'create', name, scopes:['catalog:read'], ttlDays?, ratePerMinute?, dailyQuota? }
 *        → { client, token }  El token se muestra UNA sola vez y no se puede recuperar.
 * POST { action:'revoke', id }                   Revocación inmediata.
 * Seguridad: administrador (401), CSRF (`sameOrigin` + X-Automation-Admin: 1 + JSON), cuerpo ≤ 4 KiB, otros métodos 405.
 * Desactivada por defecto (404 sin AUTOMATION_API_ENABLED=true). Archivo dañado → 423 y no se sobrescribe.
 * ==============================================================================
 */
import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../lib/adminAuth';
import { sameOrigin } from '../../../lib/alertsHttp';
import { AUTOMATION_SCOPES, automationEnabled, automationJson, createClient, disabledResponse, listClients, readAudit, revokeClient } from '../../../lib/automationApi';

export const prerender = false;

const MAX_BODY = 4096;
const err = (status: number, code: string, message: string) => automationJson(status, { success: false, code, message });

export const GET: APIRoute = ({ request }) => {
  if (!automationEnabled()) return disabledResponse();
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  const list = listClients();
  if (list.status !== 'ok') return err(423, 'almacen_ilegible', 'El archivo de clientes está dañado y no se sobrescribe.');
  const n = Number(new URL(request.url).searchParams.get('audit'));
  return automationJson(200, {
    success: true,
    scopesAvailable: AUTOMATION_SCOPES,
    clients: list.clients,
    ...(Number.isInteger(n) && n > 0 ? { audit: readAudit(n) } : {}),
  });
};

export const POST: APIRoute = async ({ request }) => {
  if (!automationEnabled()) return disabledResponse();
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  if (!sameOrigin(request) || request.headers.get('x-automation-admin') !== '1' || !/application\/json/i.test(request.headers.get('content-type') ?? '')) {
    return err(403, 'peticion_no_permitida', 'Petición no permitida.');
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY) return err(413, 'cuerpo_demasiado_grande', 'Cuerpo demasiado grande.');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('no objeto');
  } catch {
    return err(400, 'json_no_valido', 'JSON no válido.');
  }
  if (body.action === 'create') {
    const r = createClient(body);
    return r.ok ? automationJson(201, { success: true, client: r.client, token: r.token, notice: 'Guarda el token ahora: no se puede volver a ver.' }) : err(r.status, r.code, r.message);
  }
  if (body.action === 'revoke') {
    if (typeof body.id !== 'string') return err(400, 'id_obligatorio', 'Falta el id del cliente.');
    const r = revokeClient(body.id);
    return r.ok ? automationJson(200, { success: true, client: r.client }) : err(r.status, r.code, r.message);
  }
  return err(400, 'accion_desconocida', 'Acción desconocida.');
};

export const ALL: APIRoute = () => {
  if (!automationEnabled()) return disabledResponse();
  return automationJson(405, { success: false, code: 'metodo_no_permitido', message: 'Sólo GET y POST.' }, { Allow: 'GET, POST' });
};
