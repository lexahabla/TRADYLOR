import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { buildAnalyticsWorkbook } from '../../../../lib/excelExport';
import { getMesesAnalitica, seleccionarMeses } from '../../../../lib/analyticsMonths';

export const prerender = false;

/**
 * GET /api/admin/analytics/export?months=2026-09,2026-10
 * POST { months: ["2026-09", ...] }
 *
 * Descarga un XLSX con tablas estiladas y barras (gráficos en celda).
 * Sin `months` exporta todo el histórico.
 */
async function handle(request: Request): Promise<Response> {
  const denied = requireAdminAuth(request);
  if (denied) return denied;

  let claves: string[] = [];
  if (request.method === 'POST') {
    try {
      const body = (await request.json()) as { months?: unknown };
      if (Array.isArray(body.months)) {
        claves = body.months.filter((m): m is string => typeof m === 'string');
      }
    } catch {
      return new Response('Cuerpo inválido', { status: 400 });
    }
  } else {
    const query = new URL(request.url).searchParams.get('months') ?? '';
    claves = query.split(',').map((m) => m.trim()).filter(Boolean);
  }

  const resumen = getMesesAnalitica();
  const meses = claves.length ? seleccionarMeses(resumen, claves) : resumen.meses;
  if (!meses.length) {
    return new Response('No hay meses que exportar', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const buffer = await buildAnalyticsWorkbook(meses);
  const nombre = `tradylor-analitica-${new Date().toISOString().slice(0, 10)}.xlsx`;
  return new Response(buffer as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${nombre}"`,
      'Cache-Control': 'no-store',
    },
  });
}

export const GET: APIRoute = ({ request }) => handle(request);
export const POST: APIRoute = ({ request }) => handle(request);
