/**
 * ==============================================================================
 * TRADYLOR — LIBRO DE VENTAS REAL (bloque "Control de Ventas, Comisiones e Ingresos")
 * ==============================================================================
 * Sustituye los datos de ejemplo (antiguo `data/mockVentas.ts`, hoy retirado)
 * por el único dato de venta que Tradylor puede dar por 100% real sin
 * checkout propio ni webhooks de conversión de las redes de afiliados: la
 * confirmación "Sí, compré" del Return Flow de Mi Radar
 * (`radarStore.ts` → `resolveExit()` → `trackEvent({type:'purchase'})`).
 *
 * Cada compra confirmada se cruza con el catálogo para obtener el importe
 * real (precio del producto en el momento de consultar) y una comisión neta
 * estimada: `commissionEstimate` del producto si existe, o el 5% de
 * referencia que ya usa `computeConversionScore` en curation.ts.
 *
 * Si todavía no hay compras confirmadas, todo son ceros y la UI lo dice
 * explícitamente ("sin ventas confirmadas aún"); nunca se inventan datos
 * (mismo criterio que `marketingInsights.ts`).
 *
 * SÓLO para uso en frontmatter de Astro (servidor) o endpoints: usa
 * `node:fs` a través de `analytics.ts`/`catalog.ts`. Los `<script>` de
 * cliente que necesiten recalcular al vuelo deben importar en su lugar
 * `./salesLedgerCore` (puro, sin dependencias de Node).
 * ==============================================================================
 */
import { getAnalyticsEvents } from './analytics';
import { findCatalogProduct } from './catalog';
import { ETIQUETAS_RED } from './marketingInsights';
import type { RegistroVenta } from './salesLedgerCore';

export type {
  TipoVenta,
  RegistroVenta,
  ResumenFinancieroPeriodo,
  PuntoIngreso,
  ConsejoVentasIA,
} from './salesLedgerCore';
export {
  computeResumen,
  filtrarPorRango,
  getSerieIngresos,
  etiquetaTipoVenta,
  formatEUR,
  getConsejosVentasIA,
} from './salesLedgerCore';

/** Misma referencia que `computeConversionScore` (curation.ts): 5% medio de afiliación. */
const DEFAULT_COMMISSION_RATE = 0.05;
/** Historial que se embebe para el filtrado en cliente (cubre de sobra "Este Año"). */
const HISTORY_DAYS = 400;

/** Comisión neta real de una venta: `commissionEstimate` del producto escalado
 *  al importe real de esta venta, o el 5% de referencia si no hay dato. */
function comisionDe(monto: number, product?: { price: number; commissionEstimate?: number }): number {
  if (product && product.price > 0 && typeof product.commissionEstimate === 'number' && product.commissionEstimate > 0) {
    const ratio = product.commissionEstimate / product.price;
    return Math.round(monto * ratio * 100) / 100;
  }
  return Math.round(monto * DEFAULT_COMMISSION_RATE * 100) / 100;
}

function proveedorDe(product?: { network?: string; merchant?: string }): string {
  if (!product) return 'Afiliado';
  const red = (product.network ?? '').toLowerCase();
  return ETIQUETAS_RED[red] ?? product.merchant ?? (red || 'Afiliado');
}

/** Compras confirmadas (Return Flow) de los últimos `dias` días, recientes primero. */
export function getRegistrosVentas(dias = HISTORY_DAYS): RegistroVenta[] {
  const desdeMs = Date.now() - dias * 86_400_000;
  const eventos = getAnalyticsEvents().filter(
    (e) => e.type === 'purchase' && Number.isFinite(Date.parse(e.createdAt)) && Date.parse(e.createdAt) >= desdeMs,
  );

  return eventos
    .map((evento, index) => {
      const product = evento.productId ? findCatalogProduct(evento.productId) : undefined;
      const monto = typeof evento.amount === 'number' && evento.amount > 0
        ? evento.amount
        : (product?.price ?? 0);
      return {
        id: `v-${Date.parse(evento.createdAt) || index}-${index}`,
        fecha: evento.createdAt.slice(0, 10),
        productoNombre: product?.title ?? evento.productId ?? 'Producto ya no disponible',
        montoTotalBruto: Math.round(monto * 100) / 100,
        comisionNeta: comisionDe(monto, product),
        tipo: 'afiliado' as const,
        proveedorAfiliado: proveedorDe(product),
      };
    })
    .filter((registro) => registro.montoTotalBruto > 0)
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.id.localeCompare(a.id));
}
