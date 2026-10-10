/**
 * ==============================================================================
 * TRADYLOR — EXPORTACIÓN DE ANALÍTICA A EXCEL (XLSX)
 * ==============================================================================
 * Genera un libro estilado (exceljs) con la paleta del panel:
 *
 *   - "Resumen":     una fila por mes con todas las métricas + barras de datos.
 *   - "Año XXXX":    una hoja por año con el resumen mensual de ese año.
 *   - "2026-10 ...": una hoja por mes con KPIs, fuentes, evolución diaria y
 *                    top de productos, todo con tablas formateadas y barras.
 * ==============================================================================
 */
import ExcelJS from 'exceljs';
import type { MesAnalitica } from './analyticsMonths';

const PALETA = {
  navy: 'FF0F172A',
  navySoft: 'FF1E293B',
  accent: 'FF38BDF8',
  accentDark: 'FF0284C7',
  texto: 'FF0F172A',
  textoSuave: 'FF64748B',
  linea: 'FFCBD5E1',
  filaPar: 'FFF8FAFC',
  blanco: 'FFFFFFFF',
  verde: 'FF10B981',
  ambar: 'FFF59E0B',
};

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: PALETA.navy },
};
const SUBHEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: PALETA.navySoft },
};
const ALT_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: PALETA.filaPar },
};
const BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: PALETA.linea } },
  left: { style: 'thin', color: { argb: PALETA.linea } },
  bottom: { style: 'thin', color: { argb: PALETA.linea } },
  right: { style: 'thin', color: { argb: PALETA.linea } },
};

const FMT_ENTERO = '#,##0';
const FMT_DECIMAL = '#,##0.00';
const FMT_PORCENTAJE = '0.0"%"';
const FMT_EURO = '#,##0.00" €"';

function escribirTitulo(ws: ExcelJS.Worksheet, texto: string, columnas: number, fila: number): number {
  ws.mergeCells(fila, 1, fila, columnas);
  const celda = ws.getCell(fila, 1);
  celda.value = texto;
  celda.font = { bold: true, size: 16, color: { argb: PALETA.blanco } };
  celda.fill = HEADER_FILL;
  celda.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(fila).height = 30;
  return fila + 1;
}

function escribirSeccion(ws: ExcelJS.Worksheet, texto: string, columnas: number, fila: number): number {
  ws.mergeCells(fila, 1, fila, columnas);
  const celda = ws.getCell(fila, 1);
  celda.value = texto;
  celda.font = { bold: true, size: 11, color: { argb: PALETA.blanco } };
  celda.fill = SUBHEADER_FILL;
  celda.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(fila).height = 20;
  return fila + 1;
}

function escribirCabecera(ws: ExcelJS.Worksheet, labels: string[], fila: number): number {
  const row = ws.getRow(fila);
  labels.forEach((label, index) => {
    const celda = row.getCell(index + 1);
    celda.value = label;
    celda.font = { bold: true, size: 10, color: { argb: PALETA.blanco } };
    celda.fill = HEADER_FILL;
    celda.border = BORDER;
    celda.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  row.height = 26;
  return fila + 1;
}

function pintarFila(row: ExcelJS.Row, index: number): void {
  const fill = index % 2 === 1 ? ALT_FILL : undefined;
  row.eachCell({ includeEmpty: true }, (celda) => {
    celda.border = BORDER;
    if (fill) celda.fill = fill;
    celda.font = { size: 10, color: { argb: PALETA.texto } };
    celda.alignment = { vertical: 'middle' };
  });
}

function ajustarAnchos(ws: ExcelJS.Worksheet, anchos: number[]): void {
  anchos.forEach((ancho, index) => {
    ws.getColumn(index + 1).width = ancho;
  });
}

/** Barras de datos: el equivalente en celda a un gráfico de barras. */
function barras(ws: ExcelJS.Worksheet, ref: string, color = PALETA.accent): void {
  ws.addConditionalFormatting({
    ref,
    rules: [
      {
        type: 'dataBar',
        cfvo: [{ type: 'min' }, { type: 'max' }],
        color: { argb: color },
        gradient: true,
      } as ExcelJS.ConditionalFormattingRule,
    ],
  });
}

const MESES_CORTOS = [
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
];

function nombreHojaMes(mes: MesAnalitica): string {
  const [year, month] = mes.month.split('-');
  return `${mes.month} ${MESES_CORTOS[Number(month) - 1] ?? month} ${year}`.slice(0, 31);
}

function hojaResumen(wb: ExcelJS.Workbook, meses: MesAnalitica[]): void {
  const ws = wb.addWorksheet('Resumen', {
    views: [{ state: 'frozen', ySplit: 4 }],
    properties: { tabColor: { argb: PALETA.accent } },
  });
  let fila = escribirTitulo(ws, 'TRADYLOR · Analítica mensual', 13, 1);
  ws.mergeCells(fila, 1, fila, 13);
  const sub = ws.getCell(fila, 1);
  sub.value = `Exportado el ${new Date().toLocaleDateString('es-ES', { dateStyle: 'long' })} · ${meses.length} mes(es) incluido(s)`;
  sub.font = { size: 10, italic: true, color: { argb: PALETA.textoSuave } };
  fila += 2;

  fila = escribirSeccion(ws, 'Métricas por mes', 13, fila);
  fila = escribirCabecera(
    ws,
    [
      'Mes',
      'Sesiones',
      'Usuarios únicos',
      'Páginas',
      'Páginas / sesión',
      'Permanencia (s)',
      'Rebote %',
      'Visitas',
      'Salidas a tienda',
      'Carritos',
      'Compras',
      'Conversión %',
      'AOV (€)',
    ],
    fila,
  );

  const primeraFilaDatos = fila;
  meses.forEach((mes, index) => {
    const row = ws.getRow(fila);
    const m = mes.metrics;
    row.values = [
      mes.label,
      m.sesiones,
      m.usuariosUnicos,
      m.paginas,
      m.paginasPorSesion,
      m.permanenciaMediaSeg,
      m.rebotePct,
      m.visitas,
      m.salidas,
      m.carritos,
      m.compras,
      m.conversionPct,
      m.aov,
    ];
    pintarFila(row, index);
    row.getCell(1).font = { size: 10, bold: true, color: { argb: PALETA.texto } };
    [2, 3, 4, 8, 9, 10, 11].forEach((col) => (row.getCell(col).numFmt = FMT_ENTERO));
    row.getCell(5).numFmt = FMT_DECIMAL;
    row.getCell(6).numFmt = FMT_ENTERO;
    row.getCell(7).numFmt = FMT_PORCENTAJE;
    row.getCell(12).numFmt = FMT_PORCENTAJE;
    row.getCell(13).numFmt = FMT_EURO;
    fila += 1;
  });

  if (meses.length) {
    barras(ws, `B${primeraFilaDatos}:B${fila - 1}`, PALETA.accent);
    barras(ws, `H${primeraFilaDatos}:H${fila - 1}`, PALETA.verde);
  }

  ajustarAnchos(ws, [20, 12, 15, 11, 14, 15, 11, 11, 15, 11, 11, 12, 11]);
}

function hojaAnio(wb: ExcelJS.Workbook, anio: string, meses: MesAnalitica[]): void {
  const ws = wb.addWorksheet(`Año ${anio}`.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 4 }],
    properties: { tabColor: { argb: PALETA.accentDark } },
  });
  let fila = escribirTitulo(ws, `Resumen del año ${anio}`, 8, 1);
  ws.mergeCells(fila, 1, fila, 8);
  const sub = ws.getCell(fila, 1);
  sub.value = `${meses.length} mes(es) exportado(s)`;
  sub.font = { size: 10, italic: true, color: { argb: PALETA.textoSuave } };
  fila += 2;

  fila = escribirCabecera(
    ws,
    ['Mes', 'Visitas', 'Sesiones', 'Salidas a tienda', 'Compras', 'Conversión %', 'Rebote %', 'Permanencia (s)'],
    fila,
  );
  const primera = fila;
  meses.forEach((mes, index) => {
    const row = ws.getRow(fila);
    row.values = [
      mes.label,
      mes.metrics.visitas,
      mes.metrics.sesiones,
      mes.metrics.salidas,
      mes.metrics.compras,
      mes.metrics.conversionPct,
      mes.metrics.rebotePct,
      mes.metrics.permanenciaMediaSeg,
    ];
    pintarFila(row, index);
    row.getCell(1).font = { size: 10, bold: true, color: { argb: PALETA.texto } };
    [2, 3, 4, 5, 8].forEach((col) => (row.getCell(col).numFmt = FMT_ENTERO));
    row.getCell(6).numFmt = FMT_PORCENTAJE;
    row.getCell(7).numFmt = FMT_PORCENTAJE;
    fila += 1;
  });
  if (meses.length) {
    barras(ws, `B${primera}:B${fila - 1}`, PALETA.accent);
    barras(ws, `E${primera}:E${fila - 1}`, PALETA.verde);
  }
  ajustarAnchos(ws, [20, 12, 12, 16, 11, 13, 11, 16]);
}

function hojaMes(wb: ExcelJS.Workbook, mes: MesAnalitica): void {
  const ws = wb.addWorksheet(nombreHojaMes(mes), {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { tabColor: { argb: PALETA.verde } },
  });
  const m = mes.metrics;
  let fila = escribirTitulo(ws, `Analítica de ${mes.label}`, 6, 1);
  ws.mergeCells(fila, 1, fila, 6);
  const sub = ws.getCell(fila, 1);
  sub.value = `Datos agregados del mes · actualizado el ${new Date(mes.generadoEn).toLocaleString('es-ES')}`;
  sub.font = { size: 10, italic: true, color: { argb: PALETA.textoSuave } };
  fila += 2;

  fila = escribirSeccion(ws, 'Métricas clave', 6, fila);
  fila = escribirCabecera(ws, ['Métrica', 'Valor'], fila);
  const kpis: Array<[string, number | string, string | null]> = [
    ['Sesiones', m.sesiones, FMT_ENTERO],
    ['Usuarios únicos', m.usuariosUnicos, FMT_ENTERO],
    ['Páginas vistas', m.paginas, FMT_ENTERO],
    ['Páginas / sesión', m.paginasPorSesion, FMT_DECIMAL],
    ['Permanencia media (s)', m.permanenciaMediaSeg, FMT_ENTERO],
    ['Tasa de rebote', m.rebotePct, FMT_PORCENTAJE],
    ['Visitas', m.visitas, FMT_ENTERO],
    ['Salidas a tienda', m.salidas, FMT_ENTERO],
    ['Añadidos al carrito', m.carritos, FMT_ENTERO],
    ['Compras', m.compras, FMT_ENTERO],
    ['Clics de contacto', m.contactos, FMT_ENTERO],
    ['Tasa de conversión', m.conversionPct, FMT_PORCENTAJE],
    ['Valor medio del pedido (AOV)', m.aov, FMT_EURO],
  ];
  kpis.forEach(([etiqueta, valor, formato], index) => {
    const row = ws.getRow(fila);
    row.values = [etiqueta, valor];
    pintarFila(row, index);
    row.getCell(1).font = { size: 10, bold: true, color: { argb: PALETA.texto } };
    row.getCell(2).numFmt = formato ?? FMT_ENTERO;
    row.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' };
    fila += 1;
  });
  fila += 1;

  fila = escribirSeccion(ws, 'Fuentes de tráfico', 6, fila);
  fila = escribirCabecera(ws, ['Fuente', 'Sesiones', '% del total'], fila);
  const primeraFuente = fila;
  mes.fuentes.forEach((fuente, index) => {
    const row = ws.getRow(fila);
    row.values = [fuente.etiqueta, fuente.sesiones, fuente.porcentaje];
    pintarFila(row, index);
    row.getCell(1).font = { size: 10, bold: true, color: { argb: PALETA.texto } };
    row.getCell(2).numFmt = FMT_ENTERO;
    row.getCell(3).numFmt = FMT_PORCENTAJE;
    fila += 1;
  });
  if (mes.fuentes.length) barras(ws, `C${primeraFuente}:C${fila - 1}`, PALETA.accent);
  fila += 1;

  fila = escribirSeccion(ws, 'Evolución diaria de visitas', 6, fila);
  fila = escribirCabecera(ws, ['Día', 'Visitas'], fila);
  const primeraDia = fila;
  mes.evolucion.forEach((punto, index) => {
    const row = ws.getRow(fila);
    row.values = [`${punto.etiqueta} (${punto.fecha})`, punto.visitas];
    pintarFila(row, index);
    row.getCell(1).font = { size: 10, bold: true, color: { argb: PALETA.texto } };
    row.getCell(2).numFmt = FMT_ENTERO;
    fila += 1;
  });
  if (mes.evolucion.length) barras(ws, `B${primeraDia}:B${fila - 1}`, PALETA.accent);
  fila += 1;

  fila = escribirSeccion(ws, 'Productos más visitados', 6, fila);
  fila = escribirCabecera(ws, ['Producto', 'ID', 'Visitas', 'Salidas', 'Compras', 'Tasa salida %'], fila);
  const primeraProd = fila;
  mes.topProductos.forEach((producto, index) => {
    const row = ws.getRow(fila);
    row.values = [producto.titulo, producto.productId, producto.visitas, producto.salidas, producto.compras, producto.tasa];
    pintarFila(row, index);
    row.getCell(1).font = { size: 10, bold: true, color: { argb: PALETA.texto } };
    [3, 4, 5].forEach((col) => (row.getCell(col).numFmt = FMT_ENTERO));
    row.getCell(6).numFmt = FMT_PORCENTAJE;
    fila += 1;
  });
  if (mes.topProductos.length) barras(ws, `C${primeraProd}:C${fila - 1}`, PALETA.verde);

  ajustarAnchos(ws, [30, 26, 11, 11, 11, 13]);
}

/** Genera el libro XLSX completo para los meses seleccionados. */
export async function buildAnalyticsWorkbook(meses: MesAnalitica[]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Tradylor Admin';
  workbook.created = new Date();

  const ordenados = [...meses].sort((a, b) => a.month.localeCompare(b.month));
  hojaResumen(workbook, ordenados);

  const anios = [...new Set(ordenados.map((mes) => mes.month.slice(0, 4)))];
  for (const anio of anios) {
    hojaAnio(workbook, anio, ordenados.filter((mes) => mes.month.startsWith(anio)));
  }
  for (const mes of ordenados) {
    hojaMes(workbook, mes);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer as ArrayBuffer);
}
