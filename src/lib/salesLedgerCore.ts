/**
 * ==============================================================================
 * TRADYLOR — LIBRO DE VENTAS: NÚCLEO PURO (seguro para cliente Y servidor)
 * ==============================================================================
 * Tipos y funciones puras del bloque "Control de Ventas, Comisiones e
 * Ingresos", sin ninguna dependencia de Node (fs, analytics, catálogo...).
 * Se separan de `salesLedger.ts` a propósito: los `<script>` de cliente de
 * FinancialHeaderCards/SalesAITips necesitan recalcular al vuelo al cambiar
 * el filtro de fechas, y si importaran `salesLedger.ts` (que sí usa `node:fs`
 * a través de analytics.ts/catalog.ts) Vite intentaría meter esos módulos de
 * servidor en el bundle del navegador y la build fallaba.
 * ==============================================================================
 */

export type TipoVenta = 'directa' | 'afiliado' | 'comision';

/** Una venta confirmada del historial. */
export interface RegistroVenta {
  id: string;
  /** Fecha de la confirmación en formato YYYY-MM-DD. */
  fecha: string;
  productoNombre: string;
  /** Importe bruto de la venta, antes de comisión. */
  montoTotalBruto: number;
  /** Comisión neta estimada para Tradylor por esta venta. */
  comisionNeta: number;
  tipo: TipoVenta;
  /** Red / proveedor de afiliado real del producto (Amazon, Awin, eBay...). */
  proveedorAfiliado: string;
}

/** Agregado financiero de un periodo filtrado. */
export interface ResumenFinancieroPeriodo {
  facturacionTotal: number;
  comisionNetaTotal: number;
  ingresosAfiliacion: number;
  ingresosDirectos: number;
  porcentajeComisionMedio: number;
}

/** Punto de la serie del gráfico de ingresos (bruto vs comisión neta). */
export interface PuntoIngreso {
  /** ISO yyyy-mm-dd: permite filtrar bien en el cliente aunque cambie el año. */
  fecha: string;
  etiqueta: string;
  facturacionBruta: number;
  comisionNeta: number;
}

/** Consejo de IA para mejorar el margen de comisiones. */
export interface ConsejoVentasIA {
  id: string;
  titulo: string;
  detalle: string;
  tipo: 'oportunidad' | 'alerta' | 'info';
}

/** Suma y agrega el resumen financiero de un conjunto de registros. */
export function computeResumen(registros: RegistroVenta[]): ResumenFinancieroPeriodo {
  const facturacionTotal = registros.reduce((sum, r) => sum + r.montoTotalBruto, 0);
  const comisionNetaTotal = registros.reduce((sum, r) => sum + r.comisionNeta, 0);
  const ingresosAfiliacion = registros
    .filter((r) => r.tipo === 'afiliado' || r.tipo === 'comision')
    .reduce((sum, r) => sum + r.comisionNeta, 0);
  const ingresosDirectos = registros
    .filter((r) => r.tipo === 'directa')
    .reduce((sum, r) => sum + r.comisionNeta, 0);
  const porcentajeComisionMedio = facturacionTotal > 0
    ? Math.round((comisionNetaTotal / facturacionTotal) * 1000) / 10
    : 0;

  return { facturacionTotal, comisionNetaTotal, ingresosAfiliacion, ingresosDirectos, porcentajeComisionMedio };
}

/** Filtra registros por rango de fechas (inclusive), en formato YYYY-MM-DD. */
export function filtrarPorRango(registros: RegistroVenta[], desdeISO: string, hastaISO: string): RegistroVenta[] {
  return registros.filter((r) => r.fecha >= desdeISO && r.fecha <= hastaISO);
}

/** Serie diaria bruta vs comisión neta de un conjunto de registros (orden cronológico). */
export function getSerieIngresos(registros: RegistroVenta[]): PuntoIngreso[] {
  const porDia = new Map<string, { facturacionBruta: number; comisionNeta: number }>();
  for (const r of registros) {
    const actual = porDia.get(r.fecha) ?? { facturacionBruta: 0, comisionNeta: 0 };
    actual.facturacionBruta += r.montoTotalBruto;
    actual.comisionNeta += r.comisionNeta;
    porDia.set(r.fecha, actual);
  }
  return [...porDia.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fecha, valores]) => {
      const [, mes, dia] = fecha.split('-');
      return {
        fecha,
        etiqueta: `${dia}/${mes}`,
        facturacionBruta: Math.round(valores.facturacionBruta * 100) / 100,
        comisionNeta: Math.round(valores.comisionNeta * 100) / 100,
      };
    });
}

/** Etiqueta legible de un tipo de venta (para badges). */
export const etiquetaTipoVenta: Record<TipoVenta, string> = {
  directa: 'Directa',
  afiliado: 'Afiliado',
  comision: 'Comisión',
};

/** Formatea un importe en euros (es-ES). */
export function formatEUR(valor: number): string {
  return `${valor.toFixed(2).replace('.', ',')} €`;
}

/** Consejos de IA: reglas sobre agregados reales por proveedor; honesto si faltan datos. */
export function getConsejosVentasIA(registros: RegistroVenta[]): ConsejoVentasIA[] {
  if (registros.length < 3) {
    return [{
      id: 'cv-sin-datos',
      titulo: 'Aún no hay suficientes ventas confirmadas',
      detalle: 'Estos consejos se calculan a partir de las compras que los propios usuarios confirman en el Return Flow de Mi Radar ("¿Llegaste a comprar?"). En cuanto haya varias confirmaciones en el periodo, aquí aparecerán oportunidades y alertas reales sobre tu mix de comisiones.',
      tipo: 'info',
    }];
  }

  const porProveedor = new Map<string, { bruto: number; comision: number; n: number }>();
  for (const r of registros) {
    const actual = porProveedor.get(r.proveedorAfiliado) ?? { bruto: 0, comision: 0, n: 0 };
    actual.bruto += r.montoTotalBruto;
    actual.comision += r.comisionNeta;
    actual.n += 1;
    porProveedor.set(r.proveedorAfiliado, actual);
  }

  const resumen = computeResumen(registros);
  const filas = [...porProveedor.entries()].map(([proveedor, v]) => ({
    proveedor,
    ...v,
    pctBruto: resumen.facturacionTotal > 0 ? (v.bruto / resumen.facturacionTotal) * 100 : 0,
    pctComision: v.bruto > 0 ? (v.comision / v.bruto) * 100 : 0,
  }));

  const consejos: ConsejoVentasIA[] = [];
  const pct = (n: number) => n.toFixed(1).replace('.', ',');

  if (filas.length > 1) {
    const mejorMargen = [...filas].sort((a, b) => b.pctComision - a.pctComision)[0];
    consejos.push({
      id: 'cv-mejor-margen',
      titulo: `${mejorMargen.proveedor} tiene tu mejor margen`,
      detalle: `Su comisión media es del ${pct(mejorMargen.pctComision)}% sobre lo vendido, con ${mejorMargen.n} venta(s) confirmada(s) en el periodo. Prioriza sus productos en portada y en el Dependiente IA para ganar ingreso sin necesitar más tráfico.`,
      tipo: 'oportunidad',
    });
  }

  const peorMargen = [...filas]
    .filter((f) => f.n >= 2 && f.pctComision < resumen.porcentajeComisionMedio)
    .sort((a, b) => a.pctComision - b.pctComision)[0];
  if (peorMargen) {
    consejos.push({
      id: 'cv-peor-margen',
      titulo: `Revisa el margen de ${peorMargen.proveedor}`,
      detalle: `Convierte (${peorMargen.n} ventas confirmadas) pero su comisión media (${pct(peorMargen.pctComision)}%) está por debajo de tu media del periodo (${pct(resumen.porcentajeComisionMedio)}%). Compara con otro programa de la misma categoría antes de seguir promocionándolo igual.`,
      tipo: 'alerta',
    });
  }

  const mayorVolumen = [...filas].sort((a, b) => b.bruto - a.bruto)[0];
  if (mayorVolumen && (filas.length === 1 || consejos.length < 3)) {
    consejos.push({
      id: 'cv-mayor-volumen',
      titulo: `${mayorVolumen.proveedor} concentra tu facturación`,
      detalle: `Supone el ${mayorVolumen.pctBruto.toFixed(0)}% de la facturación bruta confirmada del periodo (${mayorVolumen.n} venta(s)). Si su margen se mantiene estable, es tu red más previsible para planificar el promocionado.`,
      tipo: 'info',
    });
  }

  return consejos.slice(0, 3);
}
