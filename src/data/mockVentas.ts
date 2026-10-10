/**
 * ==============================================================================
 * TRADYLOR — DATOS MOCK DEL BLOQUE "CONTROL DE VENTAS, COMISIONES E INGRESOS"
 * ==============================================================================
 * Datos de prueba realistas del módulo financiero (segundo bloque de
 * /admin/trafico-ventas). Toda la presentación (tarjetas KPI, gráfico,
 * historial y consejos de IA) se calcula a partir de estas estructuras:
 * sustituirlos por la fuente real (Stripe / redes de afiliados / ERP) no
 * requiere tocar la interfaz.
 * ==============================================================================
 */

/** Tipo de transacción registrada en el historial de ventas. */
export type TipoVenta = 'directa' | 'afiliado' | 'comision';

/** Una transacción del historial de ventas. */
export interface RegistroVenta {
  id: string;
  /** Fecha de la transacción en formato YYYY-MM-DD. */
  fecha: string;
  productoNombre: string;
  /** Importe bruto total de la venta (GMV), antes de comisiones. */
  montoTotalBruto: number;
  /** Comisión neta percibida por Tradylor por esta transacción. */
  comisionNeta: number;
  tipo: TipoVenta;
  /** Red / proveedor de afiliado (Amazon, Awin, eBay...); vacío si es venta directa. */
  proveedorAfiliado: string;
}

/** Agregado financiero de un periodo filtrado. */
export interface ResumenFinancieroPeriodo {
  /** Suma de todos los montos brutos (GMV). */
  facturacionTotal: number;
  /** Suma de todas las comisiones netas percibidas. */
  comisionNetaTotal: number;
  /** Comisiones provenientes de ventas de afiliados. */
  ingresosAfiliacion: number;
  /** Ingresos por ventas directas (sin red de afiliados). */
  ingresosDirectos: number;
  /** % medio de comisión sobre facturación bruta. */
  porcentajeComisionMedio: number;
}

/** Punto de la serie del gráfico de ingresos (bruto vs comisión neta). */
export interface PuntoIngreso {
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

/* -------------------------------------------------------------------------- */
/*  HISTORIAL DE TRANSACCIONES                                                 */
/* -------------------------------------------------------------------------- */

export const registrosVentas: RegistroVenta[] = [
  { id: 'v-1042', fecha: '2026-10-10', productoNombre: 'Robot aspirador con mapeo LiDAR X20', montoTotalBruto: 429.99, comisionNeta: 21.5, tipo: 'afiliado', proveedorAfiliado: 'Amazon' },
  { id: 'v-1041', fecha: '2026-10-10', productoNombre: 'Auriculares inalámbricos con cancelación ANC Pro', montoTotalBruto: 129.9, comisionNeta: 9.09, tipo: 'afiliado', proveedorAfiliado: 'AliExpress' },
  { id: 'v-1040', fecha: '2026-10-09', productoNombre: 'Cafetera espresso compacta 15 bar', montoTotalBruto: 89.0, comisionNeta: 4.45, tipo: 'afiliado', proveedorAfiliado: 'Awin' },
  { id: 'v-1039', fecha: '2026-10-09', productoNombre: 'Pack de 2 baterías 20V compatibles', montoTotalBruto: 39.99, comisionNeta: 8.0, tipo: 'comision', proveedorAfiliado: 'Programa propio' },
  { id: 'v-1038', fecha: '2026-10-08', productoNombre: 'Taladro inalámbrico 20V con 2 baterías', montoTotalBruto: 149.5, comisionNeta: 10.47, tipo: 'afiliado', proveedorAfiliado: 'CJ Affiliate' },
  { id: 'v-1037', fecha: '2026-10-08', productoNombre: 'Lámpara LED de escritorio con carga inalámbrica', montoTotalBruto: 54.99, comisionNeta: 12.0, tipo: 'directa', proveedorAfiliado: '' },
  { id: 'v-1036', fecha: '2026-10-07', productoNombre: 'Batidora de vaso 1200W con jarra de cristal', montoTotalBruto: 74.9, comisionNeta: 5.24, tipo: 'afiliado', proveedorAfiliado: 'eBay' },
  { id: 'v-1035', fecha: '2026-10-06', productoNombre: 'Robot aspirador con mapeo LiDAR X20', montoTotalBruto: 429.99, comisionNeta: 21.5, tipo: 'afiliado', proveedorAfiliado: 'Amazon' },
  { id: 'v-1034', fecha: '2026-10-05', productoNombre: 'Suscripción Tradylor Pro (anual)', montoTotalBruto: 59.0, comisionNeta: 59.0, tipo: 'directa', proveedorAfiliado: '' },
  { id: 'v-1033', fecha: '2026-10-04', productoNombre: 'Auriculares inalámbricos con cancelación ANC Pro', montoTotalBruto: 129.9, comisionNeta: 9.09, tipo: 'afiliado', proveedorAfiliado: 'AliExpress' },
  { id: 'v-1032', fecha: '2026-10-03', productoNombre: 'Cafetera espresso compacta 15 bar', montoTotalBruto: 89.0, comisionNeta: 15.0, tipo: 'comision', proveedorAfiliado: 'Programa propio' },
  { id: 'v-1031', fecha: '2026-10-02', productoNombre: 'Taladro inalámbrico 20V con 2 baterías', montoTotalBruto: 149.5, comisionNeta: 10.47, tipo: 'afiliado', proveedorAfiliado: 'CJ Affiliate' },
  { id: 'v-1030', fecha: '2026-10-01', productoNombre: 'Batidora de vaso 1200W con jarra de cristal', montoTotalBruto: 74.9, comisionNeta: 5.24, tipo: 'afiliado', proveedorAfiliado: 'eBay' },
  { id: 'v-1029', fecha: '2026-09-30', productoNombre: 'Lámpara LED de escritorio con carga inalámbrica', montoTotalBruto: 54.99, comisionNeta: 12.0, tipo: 'directa', proveedorAfiliado: '' },
  { id: 'v-1028', fecha: '2026-09-29', productoNombre: 'Robot aspirador con mapeo LiDAR X20', montoTotalBruto: 429.99, comisionNeta: 21.5, tipo: 'afiliado', proveedorAfiliado: 'Amazon' },
  { id: 'v-1027', fecha: '2026-09-28', productoNombre: 'Auriculares inalámbricos con cancelación ANC Pro', montoTotalBruto: 129.9, comisionNeta: 9.09, tipo: 'afiliado', proveedorAfiliado: 'AliExpress' },
];

/* -------------------------------------------------------------------------- */
/*  SERIE DEL GRÁFICO (bruto vs comisión neta por día)                        */
/* -------------------------------------------------------------------------- */

export const serieIngresos: PuntoIngreso[] = [
  { etiqueta: '27/09', facturacionBruta: 482.89, comisionNeta: 34.59 },
  { etiqueta: '28/09', facturacionBruta: 559.89, comisionNeta: 30.59 },
  { etiqueta: '29/09', facturacionBruta: 389.0, comisionNeta: 27.45 },
  { etiqueta: '30/09', facturacionBruta: 614.98, comisionNeta: 33.5 },
  { etiqueta: '01/10', facturacionBruta: 518.99, comisionNeta: 29.59 },
  { etiqueta: '02/10', facturacionBruta: 679.49, comisionNeta: 41.97 },
  { etiqueta: '03/10', facturacionBruta: 448.9, comisionNeta: 36.45 },
  { etiqueta: '04/10', facturacionBruta: 728.98, comisionNeta: 44.0 },
  { etiqueta: '05/10', facturacionBruta: 589.0, comisionNeta: 40.24 },
  { etiqueta: '06/10', facturacionBruta: 812.47, comisionNeta: 48.5 },
  { etiqueta: '07/10', facturacionBruta: 654.9, comisionNeta: 43.95 },
  { etiqueta: '08/10', facturacionBruta: 783.48, comisionNeta: 51.97 },
  { etiqueta: '09/10', facturacionBruta: 528.99, comisionNeta: 40.95 },
  { etiqueta: '10/10', facturacionBruta: 559.89, comisionNeta: 30.59 },
];

/* -------------------------------------------------------------------------- */
/*  CONSEJOS DE IA PARA MEJORAR EL MARGEN                                     */
/* -------------------------------------------------------------------------- */

export const consejosVentasIA: ConsejoVentasIA[] = [
  {
    id: 'cv-1',
    titulo: 'Sube la comisión del programa propio',
    detalle: 'Las 2 líneas de "Programa propio" (baterías y suscripción) generan el 34% de la comisión neta con sólo el 8% del volumen. Un +2% de margen en esas líneas aportaría ~+18 €/mes sin tocar tráfico.',
    tipo: 'oportunidad',
  },
  {
    id: 'cv-2',
    titulo: 'Revisa la cafetera espresso en Awin',
    detalle: 'Convierte en volumen pero su comisión media (5%) está por debajo de la media del catálogo (7,2%). Compara con otro advertiser de la misma categoría antes de mantenerla en portada.',
    tipo: 'alerta',
  },
  {
    id: 'cv-3',
    titulo: 'Concentra el promocionado en Amazon',
    detalle: 'Amazon concentra el 41% de la facturación bruta con la comisión más estable. Prioriza sus productos en el bloque de recomendaciones de la home para maximizar GMV previsible.',
    tipo: 'info',
  },
];

/* -------------------------------------------------------------------------- */
/*  CÁLCULOS Y FILTRADO                                                        */
/* -------------------------------------------------------------------------- */

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
