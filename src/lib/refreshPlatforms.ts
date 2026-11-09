/**
 * ==============================================================================
 * TREIDILOR — ESTADO POR PLATAFORMA DE LA ACTUALIZACIÓN DE PRECIOS (solo lectura)
 * ==============================================================================
 * Alimenta el apartado «Precios» del panel: por cada plataforma (Amazon, AliExpress, eBay, Temu) indica si hay credenciales, si el adaptador está
 * cargado, si la programación está activa/desactivada/detenida, cuántas fichas tienen fuente, la última verificación, los errores recientes y el
 * consumo de hoy. No consulta ninguna tienda ni servicio de pago.
 * ==============================================================================
 */

import { detectNetworkId } from './productNetwork';
import {
  classifyFailure,
  readRefreshMeta,
  sanitizeMessage,
  type RunLogEntry,
  type SourceAdapter,
  type SourceSchedule,
} from './offerRefresh';

export type Connection = 'conectada' | 'pendiente_credenciales' | 'error_autorizacion';

export interface RawConnection {
  status: 'connected' | 'pending' | 'error';
  detail?: string;
}

export interface PlatformStatus {
  network: string;
  label: string;
  /** Servicio que responde por esta plataforma. */
  source: string;
  products: number;
  withSource: number;
  adapterLoaded: boolean;
  connection: Connection;
  /** Estado combinado para mostrar en el panel. */
  stateLabel: string;
  enabled: boolean;
  everyHours: number | null;
  maxPerDay: number | null;
  pausedReason: string | null;
  lastVerifiedAt: string | null;
  attemptsToday: number;
  consumedToday: number;
  consumptionUnit: string;
  unitCost: number;
  recentErrors: string[];
  /** Qué falta para poder activarla (vacío = nada). */
  needs: string[];
}

const PLATFORMS: Array<{ network: string; label: string; source: string; unitCost: number; unit: string }> = [
  { network: 'amazon', label: 'Amazon', source: 'ScraperAPI (structured/amazon/product)', unitCost: 5, unit: 'créditos de ScraperAPI (estimación: 5 por consulta)' },
  { network: 'aliexpress', label: 'AliExpress', source: 'API de afiliados (productdetail.get)', unitCost: 0, unit: 'sin coste (cuota de la API)' },
  { network: 'ebay', label: 'eBay', source: 'API Browse (getItem)', unitCost: 0, unit: 'sin coste (cuota de la API)' },
  { network: 'temu', label: 'Temu', source: 'Apify (hypebridge/temu-scraper)', unitCost: 0.046, unit: 'USD de Apify (estimación)' },
];

/** Variable de entorno que habilita el adaptador de cada fuente adicional. */
const EXTRA_ENV_VALUE: Record<string, string> = { aliexpress: 'aliexpress', ebay: 'ebay', temu: 'temu' };

export function buildPlatformStatuses(input: {
  products: Array<Record<string, any>>;
  schedule: Record<string, SourceSchedule>;
  adapters: SourceAdapter[];
  connections: Record<string, RawConnection>;
  runs: RunLogEntry[];
  attemptsToday: Record<string, number>;
  schedulerEnabled: boolean;
}): PlatformStatus[] {
  return PLATFORMS.map((p) => {
    const mine = input.products.filter((x) => detectNetworkId(x as never) === p.network);
    const adapter = input.adapters.find((a) => a.networks.includes(p.network));
    const withSource = adapter ? mine.filter((x) => adapter.resolveSource(x as never)).length : 0;
    const cfg = input.schedule[p.network];
    const raw = input.connections[p.network] ?? { status: 'pending' as const };
    const connection: Connection =
      raw.status === 'pending' ? 'pendiente_credenciales'
      : raw.status === 'error' && classifyFailure(raw.detail ?? '') !== 'quota' ? 'error_autorizacion'
      : 'conectada';
    const lastVerifiedAt = mine.map((x) => readRefreshMeta(x as never).lastVerifiedAt ?? '').reduce((m, v) => (v > m ? v : m), '') || null;
    const attempts = input.attemptsToday[p.network] ?? 0;
    const recentErrors = input.runs
      .slice()
      .reverse()
      .flatMap((r) => (r.errorSamples ?? []).filter((e) => e.startsWith(p.network + ':')))
      .slice(0, 3)
      .map((e) => sanitizeMessage(e));
    const needs: string[] = [];
    if (connection === 'pendiente_credenciales') needs.push(p.network === 'amazon' ? 'SCRAPER_API_KEY' : p.network === 'temu' ? 'APIFY_TOKEN' : 'credenciales de la red');
    if (connection === 'error_autorizacion') needs.push('revisar la cuenta/credenciales: ' + sanitizeMessage(raw.detail ?? 'autorización rechazada').slice(0, 120));
    if (!adapter && EXTRA_ENV_VALUE[p.network]) needs.push('OFFER_REFRESH_EXTRA_SOURCES=' + EXTRA_ENV_VALUE[p.network]);
    const paused = cfg?.pausedReason ?? null;
    const stateLabel = paused
      ? 'Detenida: ' + paused
      : connection === 'pendiente_credenciales' ? 'Pendiente de credenciales'
      : connection === 'error_autorizacion' ? 'Error de autorización'
      : !adapter ? 'Desactivada (adaptador no cargado)'
      : !cfg?.enabled ? 'Desactivada'
      : input.schedulerEnabled ? 'Activa' : 'Conectada (programador apagado)';
    return {
      network: p.network,
      label: p.label,
      source: p.source,
      products: mine.length,
      withSource,
      adapterLoaded: Boolean(adapter),
      connection,
      stateLabel,
      enabled: Boolean(cfg?.enabled),
      everyHours: cfg?.everyHours ?? null,
      maxPerDay: cfg?.maxPerDay ?? null,
      pausedReason: paused,
      lastVerifiedAt,
      attemptsToday: attempts,
      consumedToday: Math.round(attempts * p.unitCost * 1000) / 1000,
      consumptionUnit: p.unit,
      unitCost: p.unitCost,
      recentErrors,
      needs,
    };
  });
}

/** Conexión de cada plataforma: credenciales guardadas (eBay, AliExpress) o variables de entorno del servicio de pago (Amazon, Temu). */
export async function readConnections(): Promise<Record<string, RawConnection>> {
  const out: Record<string, RawConnection> = {};
  out.amazon = { status: String(process.env.SCRAPER_API_KEY ?? '').trim() ? 'connected' : 'pending' };
  out.temu = { status: String(process.env.APIFY_TOKEN ?? '').trim() ? 'connected' : 'pending' };
  try {
    const { getNetworksOverview } = await import('./networks');
    for (const view of getNetworksOverview()) {
      if (view.id === 'ebay' || view.id === 'aliexpress') {
        out[view.id] = { status: view.status === 'connected' ? 'connected' : view.status === 'error' ? 'error' : 'pending', detail: view.statusDetail };
      }
    }
  } catch {
    /* sin datos de credenciales: se muestra pendiente */
  }
  return out;
}
