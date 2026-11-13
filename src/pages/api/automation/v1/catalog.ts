/**
 * ==============================================================================
 * TREIDILOR — API DE AUTOMATIZACIÓN v1: CATÁLOGO (sólo lectura, mínimo necesario)
 * ==============================================================================
 * GET /api/automation/v1/catalog?limit=1-100&page=1-10000[&category=…][&network=…]
 * Autenticación: Authorization: Bearer tai_<id>_<secreto>   (alcance `catalog:read`; NUNCA el token general)
 *
 * Desactivada por defecto: sin `AUTOMATION_API_ENABLED=true` responde 404 como una ruta inexistente.
 * Respuesta: { success, schema, total, page, limit, totalPages, generatedAt, products:[AutomationProduct] } (ver `automationCatalog.ts`).
 * Sin enlaces de afiliado ni de salida, sin comisiones, sin descripciones, sin datos de usuarios. Sólo GET: otros métodos → 405.
 * ==============================================================================
 */
import type { APIRoute } from 'astro';
import { getCatalogProducts } from '../../../../lib/catalog';
import { audit, authenticate, authFailureResponse, automationEnabled, automationJson, clientIpOf, disabledResponse } from '../../../../lib/automationApi';
import { buildCatalogPage, parseCatalogQuery } from '../../../../lib/automationCatalog';

export const prerender = false;

export const GET: APIRoute = ({ request }) => {
  if (!automationEnabled()) return disabledResponse();
  const auth = authenticate(request, 'catalog:read');
  if (!auth.ok) return authFailureResponse(auth);
  const url = new URL(request.url);
  const parsed = parseCatalogQuery(url.searchParams);
  const base = { clientId: auth.client.id, scope: 'catalog:read', method: 'GET', path: url.pathname, query: url.search.slice(0, 120), ip: clientIpOf(request) };
  if (!parsed.ok) {
    audit({ ...base, event: 'peticion', status: 400, reason: 'parametros' });
    return automationJson(400, { success: false, code: 'parametros_no_validos', message: parsed.message });
  }
  try {
    const page = buildCatalogPage(getCatalogProducts() as Array<Record<string, any>>, parsed.query);
    audit({ ...base, event: 'peticion', status: 200, items: page.products.length });
    return automationJson(200, { success: true, schema: 'automation-catalog/1', generatedAt: new Date().toISOString(), ...page });
  } catch {
    audit({ ...base, event: 'peticion', status: 500, reason: 'error_interno' });
    return automationJson(500, { success: false, code: 'error_interno', message: 'No se pudo leer el catálogo.' });
  }
};

export const ALL: APIRoute = ({ request }) => {
  if (!automationEnabled()) return disabledResponse();
  return automationJson(405, { success: false, code: 'metodo_no_permitido', message: 'Sólo GET.' }, { Allow: 'GET' });
};
