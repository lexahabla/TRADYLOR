/**
 * ==============================================================================
 * TRADYLOR — CALENDARIO COMERCIAL (MÓDULO DE MARKETING)
 * ==============================================================================
 * Fechas clave del año (Black Friday, Cyber Monday, Singles' Day, Navidad…) con:
 *   - la antelación de aviso (3-4 semanas antes),
 *   - el mix de canales sugerido,
 *   - los ángulos de copy para esa campaña,
 *   - los términos que se cruzan con las keywords de las categorías del
 *     catálogo (ver lib/marketingInsights.ts → getCampanaCatalogo).
 *
 * Las fechas se calculan con reglas deterministas (día fijo, n-ésimo día de la
 * semana de un mes, Computus para la Semana Santa), así que el calendario
 * sirve para cualquier año: el panel permite elegirlo (?ano=2026).
 *
 * Este módulo NO lee datos: es la fuente de verdad del calendario y lo
 * consumen el panel de Marketing y lib/marketingInsights.ts.
 * ==============================================================================
 */

export type TipoMomento = 'descuento' | 'temporada' | 'evento' | 'estacional';
export type PrioridadMomento = 'alta' | 'media' | 'baja';
export type IdCanal = 'email' | 'social' | 'editorial' | 'catalogo' | 'afiliados';

export interface CanalMarketing {
  id: IdCanal;
  etiqueta: string;
  /** Peso relativo del canal dentro de la campaña (0-100). */
  peso: number;
}

export interface MomentoComercial {
  id: string;
  nombre: string;
  icono: string;
  tipo: TipoMomento;
  prioridad: PrioridadMomento;
  /** Días de antelación: hay que empezar a preparar la campaña entonces. */
  leadDays: number;
  /** Duración de la ventana comercial en días. */
  duracionDias: number;
  canales: CanalMarketing[];
  /** Ángulos de copy para la campaña. */
  copy: string[];
  /** Términos que se cruzan con las keywords de las categorías del catálogo. */
  keywords: string[];
  /** Acción comercial concreta que hay que ejecutar. */
  accion: string;
  /** Checklist de preparación (qué debe estar listo antes del aviso). */
  preparacion: string[];
}

/** Definición interna de una fecha: día fijo, n-ésimo día de la semana o Pascua. */
interface ReglaFecha {
  /** Día fijo del mes (1-31). */
  dia?: number;
  /** Mes (1-12). */
  mes?: number;
  /** n-ésimo día de la semana del mes (1 = primero). */
  n?: number;
  /** 0 = domingo … 6 = sábado. */
  diaSemana?: number;
  /** Días respecto al Domingo de Pascua (negativo = antes). */
  offsetPascua?: number;
  /** Días que se suman al final (p. ej. Cyber Monday = Black Friday + 3). */
  offsetDias?: number;
}

interface MomentoBase extends MomentoComercial {
  inicio: ReglaFecha;
  /** Regla del final de la ventana (si la campaña dura varios días). */
  fin?: ReglaFecha;
}

const CANALES = {
  email: { id: 'email', etiqueta: 'Email / CRM' },
  social: { id: 'social', etiqueta: 'Redes sociales' },
  editorial: { id: 'editorial', etiqueta: 'Contenido SEO' },
  catalogo: { id: 'catalogo', etiqueta: 'Novedades en catálogo' },
  afiliados: { id: 'afiliados', etiqueta: 'Campañas de afiliados' },
} as const;

/* ------------------------------------------------------------------ helpers */

/** Normaliza texto para comparar keywords (sin acentos, en minúsculas). */
export function normalizarTexto(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Día del mes del n-ésimo día de la semana (0 = domingo … 6 = sábado). */
function nEsimoDiaSemana(anio: number, mes: number, diaSemana: number, n: number): number {
  const primero = new Date(Date.UTC(anio, mes - 1, 1)).getUTCDay();
  const offset = (diaSemana - primero + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

/** Domingo de Pascua (algoritmo de Meeus/Jones/Butcher). */
function domingoPascua(anio: number): Date {
  const a = anio % 19;
  const b = Math.floor(anio / 100);
  const c = anio % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(anio, mes - 1, dia));
}

/** Resuelve una regla de fecha a un yyyy-mm-dd. */
function resolverFecha(anio: number, regla: ReglaFecha): string {
  let fecha: Date;
  if (regla.offsetPascua !== undefined) {
    fecha = domingoPascua(anio);
    fecha.setUTCDate(fecha.getUTCDate() + regla.offsetPascua);
  } else if (regla.n !== undefined && regla.diaSemana !== undefined && regla.mes !== undefined) {
    fecha = new Date(
      Date.UTC(anio, regla.mes - 1, nEsimoDiaSemana(anio, regla.mes, regla.diaSemana, regla.n)),
    );
  } else {
    fecha = new Date(Date.UTC(anio, (regla.mes ?? 1) - 1, regla.dia ?? 1));
  }
  if (regla.offsetDias) fecha.setUTCDate(fecha.getUTCDate() + regla.offsetDias);
  return fecha.toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

function sumarDias(fechaISO: string, dias: number): string {
  const fecha = new Date(`${fechaISO}T00:00:00Z`);
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

function diasEntre(desdeISO: string, hastaISO: string): number {
  const desde = Date.parse(`${desdeISO}T00:00:00Z`);
  const hasta = Date.parse(`${hastaISO}T00:00:00Z`);
  if (!Number.isFinite(desde) || !Number.isFinite(hasta)) return 0;
  return Math.round((hasta - desde) / DAY_MS);
}

/** Formatea un yyyy-mm-dd como dd/mm/yyyy. */
export function fechaCorta(fechaISO: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaISO)) return fechaISO;
  const [anio, mes, dia] = fechaISO.split('-');
  return `${dia}/${mes}/${anio}`;
}

/* ------------------------------------------------------------- definiciones */

/**
 * Fechas clave del año. Las reglas de fecha son deterministas, de modo que el
 * mismo conjunto sirve para cualquier año (el panel deja elegirlo).
 */
const MOMENTOS: MomentoBase[] = [
  {
    id: 'reyes',
    nombre: 'Reyes Magos',
    icono: '🎁',
    tipo: 'estacional',
    prioridad: 'media',
    leadDays: 21,
    duracionDias: 10,
    inicio: { mes: 1, dia: 6 },
    fin: { mes: 1, dia: 15 },
    canales: [
      { ...CANALES.email, peso: 30 },
      { ...CANALES.social, peso: 25 },
      { ...CANALES.editorial, peso: 25 },
      { ...CANALES.catalogo, peso: 20 },
    ],
    copy: [
      'El regalo que se pidió y no llegó: comparativa por precio real',
      'Regalos que llegan antes de la fecha (envío y stock verificados)',
    ],
    keywords: [
      'auriculares', 'altavoz', 'smartwatch', 'reloj inteligente', 'camara', 'cámara', 'movil', 'movíl',
      'smartphone', 'consola', 'nintendo switch', 'portatil', 'portátil', 'tablet', 'monitor', 'teclado',
      'raton', 'ratón', 'gimbal', 'tripode', 'trípode', 'funda movil', 'funda móvil',
      'powerbank', 'power bank', 'freidora aire', 'robot aspirador', 'smart home',
    ],
    accion: 'Publicar comparativa "Regalos por presupuesto" y activar el bloque de novedades en portada.',
    preparacion: [
      'Fijar el presupuesto de regalo por tramo (20 €, 50 €, 100 €, 200 €)',
      'Revisar stock y fecha de envío de los 20 productos candidatos',
      'Preparar el email con 3 bloques: audio, hogar y gamers',
    ],
  },
  {
    id: 'san-valentin',
    nombre: 'San Valentín',
    icono: '💝',
    tipo: 'evento',
    prioridad: 'media',
    leadDays: 14,
    duracionDias: 5,
    inicio: { mes: 2, dia: 14 },
    fin: { mes: 2, dia: 18 },
    canales: [
      { ...CANALES.email, peso: 35 },
      { ...CANALES.social, peso: 35 },
      { ...CANALES.catalogo, peso: 20 },
      { ...CANALES.editorial, peso: 10 },
    ],
    copy: [
      'Regalos que "dejan huella": prueba real y garantía, no promesas',
      'A juego con su hobby: afinidad de intereses en lugar de precio',
    ],
    keywords: [
      'auriculares', 'smartwatch', 'reloj inteligente', 'camara', 'cámara', 'altavoz', 'microfono',
      'micrófono', 'consola', 'mando', 'funda movil', 'funda móvil', 'smart home', 'freidora aire',
      'auriculares bluetooth', 'auriculares inalambricos', 'auriculares inalámbricos',
    ],
    accion: 'Segmentar por hobby declarado y enviar la lista "para su hobby" (afinidad real, no descuento).',
    preparacion: [
      'Cruzar la lista de usuarios de Mi Radar con sus hobbies',
      'Elegir un producto por hobby con valoración ≥ 4,5',
      'Dejar programado el email del 14 con un único enlace por hobby',
    ],
  },
  {
    id: 'dia-mujer',
    nombre: 'Día de la Mujer',
    icono: '🌷',
    tipo: 'evento',
    prioridad: 'baja',
    leadDays: 10,
    duracionDias: 3,
    inicio: { mes: 3, dia: 8 },
    fin: { mes: 3, dia: 10 },
    canales: [
      { ...CANALES.social, peso: 40 },
      { ...CANALES.email, peso: 35 },
      { ...CANALES.editorial, peso: 25 },
    ],
    copy: [
      'Autonomía y tiempo: gadgets que ahorran tiempo y espacio',
      'Reseñas verificadas de compradoras reales (no características de catálogo)',
    ],
    keywords: [
      'aspiradora robot', 'robot aspirador', 'fregasuelos', 'freidora aire', 'plancha',
      'smartwatch', 'auriculares', 'monitor', 'portatil', 'portátil', 'impresora',
    ],
    accion: 'Publicar un especial de "tiempo libre" con los productos de hogar y oficina mejor valorados.',
    preparacion: [
      'Seleccionar 8-10 productos con rating ≥ 4,3 y reseñas verificadas',
      'Escribir micro-copy de 3 líneas por producto',
    ],
  },
  {
    id: 'semana-santa',
    nombre: 'Semana Santa',
    icono: '🚴',
    tipo: 'temporada',
    prioridad: 'media',
    leadDays: 21,
    duracionDias: 12,
    inicio: { offsetPascua: -3 },
    fin: { offsetPascua: 0 },
    canales: [
      { ...CANALES.social, peso: 35 },
      { ...CANALES.editorial, peso: 30 },
      { ...CANALES.email, peso: 20 },
      { ...CANALES.catalogo, peso: 15 },
    ],
    copy: [
      'Escapada con kit: cámara de acción, estabilizador y batería externa',
      'Ruta ligera: lo que cabe en una mochila de 15 L',
    ],
    keywords: [
      'camara accion', 'cámara acción', 'gopro', 'dji osmo', 'gimbal', 'estabilizador', 'dron',
      'powerbank', 'power bank', 'bateria externa', 'batería externa', 'auriculares deportivos',
      'mochila', 'bicicleta', 'funda movil', 'funda móvil',
    ],
    accion: 'Crear la comparativa "Escapada con cámara" y capturarla con una campaña de email.',
    preparacion: [
      'Revisar envío: los productos con más de 7 días de entrega no sirven para la fecha',
      'Preparar 3 rutas (montaña, costa, ciudad) con 2 productos cada una',
    ],
  },
  {
    id: 'dia-madre',
    nombre: 'Día de la Madre',
    icono: '🌸',
    tipo: 'evento',
    prioridad: 'alta',
    leadDays: 21,
    duracionDias: 5,
    inicio: { mes: 5, n: 1, diaSemana: 0 },
    fin: { mes: 5, n: 1, diaSemana: 0 },
    canales: [
      { ...CANALES.email, peso: 35 },
      { ...CANALES.social, peso: 30 },
      { ...CANALES.editorial, peso: 25 },
      { ...CANALES.catalogo, peso: 10 },
    ],
    copy: [
      'Regalo que sí se usa: poco ruido, mucha utilidad',
      'Comparativa "cocina y hogar" con precio real y envío verificado',
    ],
    keywords: [
      'cafetera inteligente', 'freidora aire', 'freidora sin aceite', 'horno inteligente', 'aspiradora robot',
      'robot aspirador', 'fregasuelos', 'lavadora inteligente', 'secadora inteligente', 'plancha',
      'purificador aire', 'humidificador inteligente', 'smart home',
    ],
    accion: 'Enviar el bloque "Hogar" a la audiencia que ya guardó productos de esa categoría.',
    preparacion: [
      'Cruzar usuarios guardados con la categoría Hogar',
      'Comprobar que el envío llega antes del día D',
    ],
  },
  {
    id: 'hot-sale',
    nombre: 'Hot Sale',
    icono: '🔥',
    tipo: 'descuento',
    prioridad: 'alta',
    leadDays: 21,
    duracionDias: 7,
    inicio: { mes: 6, dia: 1 },
    fin: { mes: 6, dia: 7 },
    canales: [
      { ...CANALES.afiliados, peso: 30 },
      { ...CANALES.email, peso: 25 },
      { ...CANALES.social, peso: 25 },
      { ...CANALES.editorial, peso: 20 },
    ],
    copy: [
      'El descuento que se ve en la ficha (porcentaje real, no precio tachado inventado)',
      'Lo que sigue siendo buena compra después del descuento',
    ],
    keywords: [
      'descuento', 'oferta', 'precio', 'barato', 'auriculares', 'smartwatch', 'portatil', 'portátil',
      'monitor', 'camara', 'cámara', 'gaming', 'teclado', 'raton', 'ratón', 'funda movil', 'funda móvil',
    ],
    accion: 'Publicar el especial "Hot Sale" con los productos de mayor descuento real del catálogo.',
    preparacion: [
      'Validar que el descuento de cada producto es verificable (precio actual < precio original)',
      'Preparar el email por categorías (informática, audio, hogar)',
    ],
  },
  {
    id: 'dia-padre',
    nombre: 'Día del Padre',
    icono: '🛠️',
    tipo: 'evento',
    prioridad: 'media',
    leadDays: 21,
    duracionDias: 5,
    inicio: { mes: 6, n: 2, diaSemana: 0 },
    fin: { mes: 6, n: 2, diaSemana: 0 },
    canales: [
      { ...CANALES.social, peso: 35 },
      { ...CANALES.email, peso: 30 },
      { ...CANALES.editorial, peso: 25 },
      { ...CANALES.afiliados, peso: 10 },
    ],
    copy: [
      'Herramienta que trabaja: comparativa con garantía y precio real',
      'Lo que se usa a diario: smartwatch, audio y herramientas',
    ],
    keywords: [
      'taladro', 'atornillador', 'martillo percutor', 'rotomartillo', 'sierra', 'amoladora',
      'multimetro', 'multímetro', 'destornillador', 'juego llaves', 'nivel laser', 'nivel láser',
      'smartwatch', 'reloj inteligente', 'auriculares', 'altavoz', 'monitor',
    ],
    accion: 'Activar el bloque "Bricolaje" en la home y añadirlo a la secuencia de email.',
    preparacion: [
      'Elegir 6 herramientas con ficha completa (specs + precio + envío)',
      'Verificar marcas disponibles en el catálogo (Bosch, DeWalt, Makita…)',
    ],
  },
  {
    id: 'prime-day',
    nombre: 'Prime Day',
    icono: '📦',
    tipo: 'descuento',
    prioridad: 'alta',
    leadDays: 14,
    duracionDias: 4,
    inicio: { mes: 7, dia: 15 },
    fin: { mes: 7, dia: 18 },
    canales: [
      { ...CANALES.afiliados, peso: 35 },
      { ...CANALES.social, peso: 25 },
      { ...CANALES.email, peso: 20 },
      { ...CANALES.editorial, peso: 20 },
    ],
    copy: [
      'Solo 48 horas: lo que baja de precio y lo que no',
      'Comparativa previa al evento (el precio se actualiza el mismo día)',
    ],
    keywords: [
      'amazon', 'auriculares', 'altavoz', 'smartwatch', 'portatil', 'portátil', 'tablet', 'monitor',
      'teclado mecanico', 'teclado mecánico', 'raton gaming', 'ratón gaming', 'powerbank', 'power bank',
      'funda movil', 'funda móvil', 'cargador rapido', 'cargador rápido',
    ],
    accion: 'Preparar el especial Amazon con los productos de mayor comisión de la red.',
    preparacion: [
      'Ordenar el catálogo por comisión estimada (conversion_score + commissionEstimate)',
      'Dejar el especial listo con fecha de publicación automática',
    ],
  },
  {
    id: 'back-to-school',
    nombre: 'Vuelta al cole',
    icono: '🎒',
    tipo: 'estacional',
    prioridad: 'media',
    leadDays: 21,
    duracionDias: 21,
    inicio: { mes: 9, dia: 1 },
    fin: { mes: 9, dia: 21 },
    canales: [
      { ...CANALES.editorial, peso: 30 },
      { ...CANALES.email, peso: 30 },
      { ...CANALES.social, peso: 25 },
      { ...CANALES.catalogo, peso: 15 },
    ],
    copy: [
      'Kit de estudio: lo que hace falta de verdad (nada de adornos)',
      'Portátil, tablet y periféricos: comparativa por euros de uso real',
    ],
    keywords: [
      'portatil', 'portátil', 'macbook', 'laptop', 'chromebook', 'tablet', 'monitor', 'teclado',
      'raton', 'ratón', 'impresora', 'scanner', 'adaptador', 'hub usb', 'cable hdmi', 'webcam',
      'funda movil', 'funda móvil', 'mochila',
    ],
    accion: 'Publicar la comparativa "Kit de estudio" y capturarla con email + redes.',
    preparacion: [
      'Agrupar productos por precio (menos de 300 €, 300-600 €, más de 600 €)',
      'Comprobar que la comparativa tiene al menos 3 productos por tramo',
    ],
  },
  {
    id: 'halloween',
    nombre: 'Halloween',
    icono: '🎃',
    tipo: 'evento',
    prioridad: 'baja',
    leadDays: 10,
    duracionDias: 4,
    inicio: { mes: 10, dia: 27 },
    fin: { mes: 10, dia: 31 },
    canales: [
      { ...CANALES.social, peso: 45 },
      { ...CANALES.afiliados, peso: 25 },
      { ...CANALES.catalogo, peso: 20 },
      { ...CANALES.email, peso: 10 },
    ],
    copy: [
      'Ambiente con poco presupuesto: luces, audio y proyector',
      'Disfraz + gadget: combos por menos de 50 €',
    ],
    keywords: [
      'luz video', 'panel led', 'softbox', 'ring light', 'luz anillo', 'altavoz', 'proyector',
      'cable hdmi', 'adaptador', 'hub usb', 'funda movil', 'funda móvil',
    ],
    accion: 'Publicar un post corto de combos por presupuesto (no hace falta campaña completa).',
    preparacion: ['Elegir 6 productos de menos de 60 €', 'Verificar disponibilidad'],
  },
  {
    id: 'cyber-week',
    nombre: 'Cyber Week',
    icono: '💠',
    tipo: 'descuento',
    prioridad: 'alta',
    leadDays: 28,
    duracionDias: 10,
    inicio: { mes: 11, n: 4, diaSemana: 5, offsetDias: -7 },
    fin: { mes: 11, n: 4, diaSemana: 5, offsetDias: 3 },
    canales: [
      { ...CANALES.afiliados, peso: 35 },
      { ...CANALES.email, peso: 25 },
      { ...CANALES.social, peso: 20 },
      { ...CANALES.editorial, peso: 20 },
    ],
    copy: [
      'La semana previa: precio más bajo que en Black Friday',
      'Lo que comprar ahora y lo que esperar (recomendación honesta)',
    ],
    keywords: [
      'descuento', 'oferta', 'precio', 'auriculares', 'smartwatch', 'portatil', 'portátil', 'tablet',
      'monitor', 'camara', 'cámara', 'gaming', 'consola', 'funda movil', 'funda móvil',
    ],
    accion: 'Arrancar la semana previa con el email a la audiencia caliente y specials por categoría.',
    preparacion: [
      'Preparar el calendario de emails de los 9 días (uno por día clave)',
      'Tener los specials listos para publicar el mismo día',
    ],
  },
  {
    id: 'black-friday',
    nombre: 'Black Friday',
    icono: '🖤',
    tipo: 'descuento',
    prioridad: 'alta',
    leadDays: 28,
    duracionDias: 3,
    inicio: { mes: 11, n: 4, diaSemana: 5 },
    fin: { mes: 11, n: 4, diaSemana: 5 },
    canales: [
      { ...CANALES.afiliados, peso: 35 },
      { ...CANALES.email, peso: 25 },
      { ...CANALES.social, peso: 25 },
      { ...CANALES.editorial, peso: 15 },
    ],
    copy: [
      'El precio que ves es el precio final (sin letras pequeñas)',
      'Histórico de precio: cuánto ha bajado de verdad este producto',
    ],
    keywords: [
      'descuento', 'oferta', 'precio', 'barato', 'auriculares', 'smartwatch', 'portatil', 'portátil',
      'tablet', 'monitor', 'teclado mecanico', 'teclado mecánico', 'camara', 'cámara', 'gaming',
      'consola', 'funda movil', 'funda móvil', 'powerbank', 'power bank', 'freidora aire',
    ],
    accion: 'Publicar el especial Black Friday con el histórico de precio de cada producto.',
    preparacion: [
      'Revisar el histórico de precio de los 40 candidatos y quedarse con los que más han bajado',
      'Congelar el precio en la ficha (no actualizarlo durante el evento)',
      'Programar el email del viernes a las 8:00',
    ],
  },
  {
    id: 'cyber-monday',
    nombre: 'Cyber Monday',
    icono: '💻',
    tipo: 'descuento',
    prioridad: 'alta',
    leadDays: 28,
    duracionDias: 1,
    inicio: { mes: 11, n: 4, diaSemana: 5, offsetDias: 3 },
    fin: { mes: 11, n: 4, diaSemana: 5, offsetDias: 3 },
    canales: [
      { ...CANALES.afiliados, peso: 40 },
      { ...CANALES.email, peso: 30 },
      { ...CANALES.social, peso: 30 },
    ],
    copy: [
      'Últimas 24 horas: lo que se agota primero',
      'Sin prisas: los que quedan con stock verificado',
    ],
    keywords: ['descuento', 'oferta', 'precio', 'auriculares', 'smartwatch', 'portatil', 'portátil', 'tablet'],
    accion: 'Email de cierre el lunes y priorización de los productos con stock limitado.',
    preparacion: ['Comprobar el stock antes del email', 'Marcar en la ficha "últimas unidades"'],
  },
  {
    id: 'singles-day',
    nombre: "Singles' Day",
    icono: '💘',
    tipo: 'descuento',
    prioridad: 'media',
    leadDays: 21,
    duracionDias: 3,
    inicio: { mes: 11, dia: 11 },
    fin: { mes: 11, dia: 13 },
    canales: [
      { ...CANALES.afiliados, peso: 35 },
      { ...CANALES.social, peso: 30 },
      { ...CANALES.email, peso: 25 },
      { ...CANALES.editorial, peso: 10 },
    ],
    copy: [
      'Regalos de San Valentín adelantados con descuento verificable',
      'Parejas: dos productos que encajan (no dos modelos parecidos)',
    ],
    keywords: [
      'auriculares', 'auriculares inalambricos', 'auriculares inalámbricos', 'smartwatch', 'reloj inteligente',
      'camara', 'cámara', 'movil', 'movíl', 'smartphone', 'funda movil', 'funda móvil', 'altavoz',
      'consola', 'freidora aire',
    ],
    accion: 'Campaña de San Valentín adelantada con los productos de AliExpress con mejor descuento.',
    preparacion: ['Elegir 12 productos (6 parejas de regalo)', 'Verificar la comisión de la red AliExpress'],
  },
  {
    id: 'navidad',
    nombre: 'Navidad',
    icono: '🎄',
    tipo: 'temporada',
    prioridad: 'alta',
    leadDays: 28,
    duracionDias: 17,
    inicio: { mes: 12, dia: 15 },
    fin: { mes: 12, dia: 31 },
    canales: [
      { ...CANALES.email, peso: 30 },
      { ...CANALES.social, peso: 25 },
      { ...CANALES.editorial, peso: 25 },
      { ...CANALES.catalogo, peso: 20 },
    ],
    copy: [
      'Fecha de entrega real: cada producto dice cuándo llega',
      'Regalo con garantía y devolución: lo que nadie te cuenta',
    ],
    keywords: [
      'auriculares', 'altavoz', 'smartwatch', 'reloj inteligente', 'camara', 'cámara', 'dron', 'gimbal',
      'movil', 'movíl', 'smartphone', 'funda movil', 'funda móvil', 'powerbank', 'power bank',
      'consola', 'nintendo switch', 'portatil', 'portátil', 'tablet', 'monitor', 'teclado mecanico',
      'teclado mecánico', 'freidora aire', 'smart home',
    ],
    accion: 'Plan de Navidad: comparativas por presupuesto con fecha de entrega garantizada.',
    preparacion: [
      'Filtrar el catálogo por fecha de envío (descartar lo que llega después del 24)',
      'Publicar la guía de regalos por precio antes del 15 de diciembre',
      'Dejar la última semana solo con stock verificado y envío urgente',
    ],
  },
  {
    id: 'nochevieja',
    nombre: 'Nochevieja',
    icono: '🥂',
    tipo: 'evento',
    prioridad: 'media',
    leadDays: 21,
    duracionDias: 1,
    inicio: { mes: 12, dia: 31 },
    fin: { mes: 12, dia: 31 },
    canales: [
      { ...CANALES.social, peso: 40 },
      { ...CANALES.email, peso: 30 },
      { ...CANALES.afiliados, peso: 30 },
    ],
    copy: [
      'Cena y audio: altavoz, recetas y números redondo',
      'Regalo de última hora que llega en 24 h (solo stock verificado)',
    ],
    keywords: ['altavoz', 'auriculares', 'smartwatch', 'freidora aire', 'funda movil', 'funda móvil', 'powerbank'],
    accion: 'Email de última hora sólo con productos con entrega garantizada en 24-48 h.',
    preparacion: ['Filtrar por envío ≤ 2 días', 'Desactivar los specials de categorías sin stock'],
  },
];

/* ------------------------------------------------------------------ público */

export interface MomentoResuelto extends MomentoComercial {
  /** yyyy-mm-dd */
  fecha: string;
  /** yyyy-mm-dd */
  fin: string;
  /** Días hasta el inicio (negativo si ya ha pasado). */
  diasHasta: number;
  estado: 'pasada' | 'en-curso' | 'preparacion' | 'programada';
  /** Fecha en la que hay que empezar a preparar la campaña. */
  alertaDesde: string;
  /** 1-4 */
  trimestre: number;
  /** 1-12 */
  mes: number;
}

/** Resuelve todos los momentos comerciales de un año, ordenados por fecha. */
export function getMomentosComerciales(anio: number): MomentoResuelto[] {
  const hoy = new Date().toISOString().slice(0, 10);
  const momentos: MomentoResuelto[] = MOMENTOS.map((momento) => {
    const fecha = resolverFecha(anio, momento.inicio);
    let fin = fecha;
    if (momento.fin) fin = resolverFecha(anio, momento.fin);
    if (fin < fecha) {
      // La ventana cruza el cambio de año (p. ej. Navidad → Nochevieja).
      fin = `${anio + 1}-${fin.slice(5)}`;
    }
    const diasHasta = diasEntre(hoy, fecha);
    const alertaDesde = sumarDias(fecha, -momento.leadDays);
    const enCurso = hoy >= fecha && hoy <= fin;
    const estado: MomentoResuelto['estado'] = enCurso
      ? 'en-curso'
      : diasHasta < 0
        ? 'pasada'
        : diasHasta <= momento.leadDays
          ? 'preparacion'
          : 'programada';
    return {
      ...momento,
      fecha,
      fin,
      diasHasta,
      estado,
      alertaDesde,
      trimestre: Math.ceil(Number(fecha.slice(5, 7)) / 3) as 1 | 2 | 3 | 4,
      mes: Number(fecha.slice(5, 7)),
    };
  });
  return momentos.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/** El próximo momento comercial (o el que está en curso) de un año. */
export function getProximoMomento(anio: number): MomentoResuelto | null {
  const momentos = getMomentosComerciales(anio);
  return (
    momentos.find((m) => m.estado === 'en-curso') ??
    momentos.find((m) => m.estado === 'preparacion') ??
    momentos.find((m) => m.estado === 'programada') ??
    null
  );
}

/** Momentos cuya ventana de preparación (aviso) está abierta o ya ha empezado. */
export function getMomentosEnVentana(anio: number): MomentoResuelto[] {
  return getMomentosComerciales(anio).filter(
    (m) => m.estado === 'preparacion' || m.estado === 'en-curso',
  );
}

/** Etiqueta corta del tipo de momento. */
export const ETIQUETAS_TIPO: Record<TipoMomento, string> = {
  descuento: 'Descuento',
  temporada: 'Temporada',
  evento: 'Evento',
  estacional: 'Estacional',
};

/** Etiqueta de la prioridad. */
export const ETIQUETAS_PRIORIDAD: Record<PrioridadMomento, string> = {
  alta: 'Alta',
  media: 'Media',
  baja: 'Baja',
};
