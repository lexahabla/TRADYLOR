import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { readProductsFromFile } from '../../../../lib/productStore';
import { detectNetworkId } from '../../../../lib/productNetwork';
import {
  DEFAULT_ADAPTERS,
  getRefreshStatus,
  readRefreshMeta,
  readScheduleConfig,
  refreshOffers,
  summarizeCoverage,
  writeScheduleConfig,
} from '../../../../lib/offerRefresh';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * GET /api/admin/offers/refresh
 * Estado del servicio: ejecución en curso / última ejecución, cobertura y
 * frescura por fuente, frecuencia configurada y ofertas sin fuente.
 */
export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const products = readProductsFromFile();
  const schedule = await readScheduleConfig();
  const noSource = products
    .filter((p) => !DEFAULT_ADAPTERS.some((a) => a.networks.includes(detectNetworkId(p)) && a.resolveSource(p)))
    .map((p) => ({ id: p.id, title: p.title_short || p.title, lastVerifiedAt: readRefreshMeta(p).lastVerifiedAt ?? null }));

  const lastVerifiedAt = products
    .map((p) => readRefreshMeta(p).lastVerifiedAt ?? '')
    .reduce((max, iso) => (iso > max ? iso : max), '');

  return json({
    success: true,
    lastVerifiedAt: lastVerifiedAt || null,
    schedulerEnabled: String(process.env.OFFER_REFRESH_ENABLED ?? '').trim().toLowerCase() === 'true',
    schedule,
    status: getRefreshStatus(),
    coverage: summarizeCoverage(products, DEFAULT_ADAPTERS, schedule),
    noSource: noSource.slice(0, 200),
    noSourceTotal: noSource.length,
  });
};

/**
 * POST /api/admin/offers/refresh
 * Body: { ids?: string[], all?: boolean, limit?: number, dryRun?: boolean, wait?: boolean }
 *  - una oferta  → ids: ['id']
 *  - una selección → ids: [...]
 *  - todo el catálogo → all: true
 * Misma cola, validación y bloqueo que el programador. Por defecto se ejecuta
 * en segundo plano y se consulta el progreso con GET (`wait: true` espera).
 * Consume créditos de la fuente (Amazon vía ScraperAPI) al ejecutarse.
 */
export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  // Frecuencia por fuente: { action: 'config', network: 'amazon', everyHours: 24, enabled: true }
  if (body?.action === 'config') {
    try {
      const schedule = await writeScheduleConfig(String(body?.network ?? ''), {
        enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
        everyHours: body?.everyHours !== undefined ? Number(body.everyHours) : undefined,
      });
      return json({ success: true, schedule });
    } catch (error) {
      return json({ success: false, message: error instanceof Error ? error.message : 'Configuración no válida.' }, 400);
    }
  }

  const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : undefined;
  const all = body?.all === true;
  if (!ids?.length && !all) {
    return json({ success: false, message: 'Indica "ids" (una oferta o una selección) o "all": true.' }, 400);
  }
  if (getRefreshStatus().running) {
    return json({ success: false, message: 'Ya hay una actualización en curso. Consulta su progreso con GET.' }, 409);
  }

  const options = {
    ids,
    all,
    limit: Number.isFinite(Number(body?.limit)) && Number(body.limit) > 0 ? Number(body.limit) : undefined,
    dryRun: body?.dryRun === true,
    mode: 'manual' as const,
    betweenMs: 3000,
  };

  if (body?.wait === true || (ids && ids.length <= 3)) {
    const report = await refreshOffers(options);
    if (!report) return json({ success: false, message: 'Ya hay una actualización en curso.' }, 409);
    return json({ success: true, report });
  }

  void refreshOffers(options).catch((error) => console.error('[OfferRefresh] Ejecución manual falló:', error));
  return json({ success: true, started: true, message: 'Actualización iniciada en segundo plano.' }, 202);
};
