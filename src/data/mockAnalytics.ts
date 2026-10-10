/**
 * ==============================================================================
 * TRADYLOR — DATOS MOCK DEL MÓDULO TRÁFICO Y VENTAS
 * ==============================================================================
 * Datos de prueba realistas que alimentan el dashboard mientras se conecta la
 * fuente real (GA4 / Search Console / tracker propio). Toda la presentación
 * (tarjetas, barras, tabla y tarjetas de tendencia) se calcula a partir de
 * estos arrays: sustituirlos por datos reales no requiere tocar la interfaz.
 * ==============================================================================
 */

/** Formato de presentación numérica de una métrica. */
export type FormatoValor = 'numero' | 'decimal' | 'percent' | 'moneda' | 'duracion';

/** Tarjeta de métrica global del dashboard (con enlace al glosario). */
export interface MetricaGlobal {
  id: string;
  etiqueta: string;
  valor: number;
  formato: FormatoValor;
  /** Variación respecto al periodo anterior, en %. */
  variacion: number;
  /** true si el movimiento es bueno para el negocio (ej: bajar el rebote). */
  favorable: boolean;
  /** id del glosario que alimenta el tooltip `?`. */
  glosarioId: string;
  periodo: string;
}

/** Barra de origen del tráfico (orgánico, directo, social...). */
export interface FuenteTrafico {
  id: string;
  etiqueta: string;
  sesiones: number;
  porcentaje: number;
  color: string;
}

/** Punto de la serie temporal de visitas. */
export interface PuntoEvolucion {
  etiqueta: string;
  visitas: number;
}

export type EstadoProducto = 'alta' | 'estable' | 'friccion';

/** Rendimiento de un producto en la tabla del dashboard. */
export interface ProductoMetrico {
  id: string;
  titulo: string;
  red: string;
  visitas: number;
  conversiones: number;
  /** % de fichas con salida a la tienda (visitas → conversión). */
  tasaConversion: number;
  estado: EstadoProducto;
  nota: string;
}

/** Tarjeta de recomendación generada por IA. */
export interface RecomendacionIA {
  id: string;
  titulo: string;
  detalle: string;
  tipo: 'oportunidad' | 'alerta' | 'info';
  glosarioId: string;
}

export const metricasGlobales: MetricaGlobal[] = [
  { id: 'sesiones', etiqueta: 'Sesiones', valor: 12480, formato: 'numero', variacion: 12.4, favorable: true, glosarioId: 'sesiones', periodo: 'Últimos 30 días' },
  { id: 'usuarios', etiqueta: 'Usuarios únicos', valor: 8932, formato: 'numero', variacion: 9.1, favorable: true, glosarioId: 'usuarios-unicos', periodo: 'Últimos 30 días' },
  { id: 'paginas', etiqueta: 'Páginas / sesión', valor: 3.4, formato: 'decimal', variacion: 4.2, favorable: true, glosarioId: 'paginas-por-sesion', periodo: 'Últimos 30 días' },
  { id: 'permanencia', etiqueta: 'Permanencia media', valor: 142, formato: 'duracion', variacion: 6.8, favorable: true, glosarioId: 'permanencia', periodo: 'Últimos 30 días' },
  { id: 'rebote', etiqueta: 'Tasa de rebote', valor: 38.6, formato: 'percent', variacion: -2.1, favorable: true, glosarioId: 'tasa-rebote', periodo: 'Últimos 30 días' },
  { id: 'conversion', etiqueta: 'Tasa de conversión', valor: 3.7, formato: 'percent', variacion: 0.6, favorable: true, glosarioId: 'tasa-conversion', periodo: 'Últimos 30 días' },
  { id: 'aov', etiqueta: 'Valor medio del pedido', valor: 68.4, formato: 'moneda', variacion: 3.2, favorable: true, glosarioId: 'aov', periodo: 'Últimos 30 días' },
];

export const fuentesTrafico: FuenteTrafico[] = [
  { id: 'organico', etiqueta: 'Orgánico', sesiones: 5254, porcentaje: 42.1, color: '#38bdf8' },
  { id: 'directo', etiqueta: 'Directo', sesiones: 3470, porcentaje: 27.8, color: '#34d399' },
  { id: 'social', etiqueta: 'Redes sociales', sesiones: 2047, porcentaje: 16.4, color: '#a78bfa' },
  { id: 'referido', etiqueta: 'Referido', sesiones: 1211, porcentaje: 9.7, color: '#fbbf24' },
  { id: 'email', etiqueta: 'Email / otros', sesiones: 498, porcentaje: 4.0, color: '#fb7185' },
];

export const evolucionVisitas: PuntoEvolucion[] = [
  { etiqueta: '27/09', visitas: 612 },
  { etiqueta: '28/09', visitas: 684 },
  { etiqueta: '29/09', visitas: 731 },
  { etiqueta: '30/09', visitas: 702 },
  { etiqueta: '01/10', visitas: 815 },
  { etiqueta: '02/10', visitas: 776 },
  { etiqueta: '03/10', visitas: 858 },
  { etiqueta: '04/10', visitas: 940 },
  { etiqueta: '05/10', visitas: 903 },
  { etiqueta: '06/10', visitas: 987 },
  { etiqueta: '07/10', visitas: 1024 },
  { etiqueta: '08/10', visitas: 968 },
  { etiqueta: '09/10', visitas: 1096 },
  { etiqueta: '10/10', visitas: 1143 },
];

export const productos: ProductoMetrico[] = [
  {
    id: 'p-robot-aspirador',
    titulo: 'Robot aspirador con mapeo LiDAR X20',
    red: 'Amazon',
    visitas: 3241,
    conversiones: 148,
    tasaConversion: 4.6,
    estado: 'alta',
    nota: 'Convierte un 25% por encima de la media de la categoría.',
  },
  {
    id: 'p-auriculares-anc',
    titulo: 'Auriculares inalámbricos con cancelación ANC Pro',
    red: 'AliExpress',
    visitas: 2876,
    conversiones: 96,
    tasaConversion: 3.3,
    estado: 'estable',
    nota: 'Rendimiento estable; precio competitivo frente a la competencia.',
  },
  {
    id: 'p-batidora',
    titulo: 'Batidora de vaso 1200W con jarra de cristal',
    red: 'eBay',
    visitas: 1954,
    conversiones: 74,
    tasaConversion: 3.8,
    estado: 'alta',
    nota: 'Buen ratio de salida a tienda desde tráfico orgánico.',
  },
  {
    id: 'p-cafetera',
    titulo: 'Cafetera espresso compacta 15 bar',
    red: 'Awin',
    visitas: 1622,
    conversiones: 31,
    tasaConversion: 1.9,
    estado: 'friccion',
    nota: 'Muchas visitas y pocas salidas: revisa precio y fotos.',
  },
  {
    id: 'p-taladro',
    titulo: 'Taladro inalámbrico 20V con 2 baterías',
    red: 'CJ Affiliate',
    visitas: 1410,
    conversiones: 52,
    tasaConversion: 3.7,
    estado: 'estable',
    nota: 'Estable; responde bien a las comparativas de la categoría.',
  },
  {
    id: 'p-lampara',
    titulo: 'Lámpara LED de escritorio con carga inalámbrica',
    red: 'Etsy',
    visitas: 1187,
    conversiones: 22,
    tasaConversion: 1.9,
    estado: 'friccion',
    nota: 'Atención media baja: la ficha es larga y el precio no se ve pronto.',
  },
];

export const recomendacionesIA: RecomendacionIA[] = [
  {
    id: 'ri-1',
    titulo: 'Reescribe la ficha de la cafetera espresso',
    detalle: 'Recibe 1.622 visitas pero sólo convierte al 1,9% (media de categoría: 3,4%). Mueve precio y pros justo debajo del título y vuelve a medir 7 días.',
    tipo: 'alerta',
    glosarioId: 'friccion-venta',
  },
  {
    id: 'ri-2',
    titulo: 'Amplía la categoría Hogar Inteligente',
    detalle: 'El tráfico orgánico crece un 12,4% y "robot aspirador" ya rankea en posiciones 4-8. Publicar 3 comparativas similares capitaliza esa demanda.',
    tipo: 'oportunidad',
    glosarioId: 'growth-opportunities',
  },
  {
    id: 'ri-3',
    titulo: 'Optimiza las imágenes de las 3 fichas top',
    detalle: 'El LCP de las fichas con más visitas supera los 2,5 s en móvil. Convertir a WebP y servir tamaños adecuados mejora ranking y conversión.',
    tipo: 'alerta',
    glosarioId: 'core-web-vitals',
  },
  {
    id: 'ri-4',
    titulo: 'Aplica 2 tips de optimización esta semana',
    detalle: 'El algoritmo interno marca 2 productos con alto Internal Rank potencial y bajo posicionimiento actual: actualiza precio y veredicto de ambos.',
    tipo: 'info',
    glosarioId: 'tips-optimizacion',
  },
];

/** Formatea un valor numérico según su formato de presentación (es-ES). */
export function formatValor(valor: number, formato: FormatoValor): string {
  switch (formato) {
    case 'decimal':
      return valor.toFixed(1).replace('.', ',');
    case 'percent':
      return `${valor.toFixed(1).replace('.', ',')}%`;
    case 'moneda':
      return `${valor.toFixed(2).replace('.', ',')} €`;
    case 'duracion': {
      const minutos = Math.floor(valor / 60);
      const segundos = Math.round(valor % 60);
      return `${minutos} min ${String(segundos).padStart(2, '0')} s`;
    }
    case 'numero':
    default:
      return new Intl.NumberFormat('es-ES').format(valor);
  }
}

/** Texto corto de la variación de una métrica (ej: "+12,4%"). */
export function formatVariacion(variacion: number): string {
  const signo = variacion > 0 ? '+' : '';
  return `${signo}${variacion.toFixed(1).replace('.', ',')}%`;
}
