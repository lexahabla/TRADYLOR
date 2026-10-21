/**
 * ==============================================================================
 * TRADYLOR — INTELIGENCIA DE MARKETING (MÓDULO DE MARKETING)
 * ==============================================================================
 * Calcula, a partir de datos REALES del proyecto, lo que muestran las cuatro
 * secciones del módulo:
 *
 *   - Calendario    → getCampanaCatalogo()      (qué categorías del catálogo
 *                     encajan en cada campaña y con qué margen)
 *   - Market Map    → getMarketMap()             (mercados con audiencia real,
 *                     cobertura de redes y ventana comercial)
 *   - Market Action → getMarketActions()         (embudo real + segmentos de
 *                     la audiencia con valor en riesgo y acción concreta)
 *   - Tendencias    → getTendencias()            (variación por categoría,
 *                     movimientos de precio, señales y estacionalidad)
 *
 * Nada de esto inventa datos: si no hay mediciones, la cifra es 0 y la UI lo
 * dice explícitamente ("sin datos aún").
 * ==============================================================================
 */

import { getCatalogProducts } from './catalog';
import { getCategories, type Category } from './categories';
import { getAnalyticsEvents } from './analytics';
import { getMesesAnalitica } from './analyticsMonths';
import { getAudience360 } from './marketingAudience';
import {
  getMomentosComerciales,
  getProximoMomento,
  normalizarTexto,
  type MomentoResuelto,
} from './marketingCalendar';

/* ------------------------------------------------------------------ helpers */

const DAY_MS = 86_400_000;

function redondear(value: number, decimales = 1): number {
  const factor = 10 ** decimales;
  return Math.round(value * factor) / factor;
}

function media(valores: number[]): number {
  if (!valores.length) return 0;
  return valores.reduce((suma, valor) => suma + valor, 0) / valores.length;
}

/** Etiquetas legibles de las redes de afiliados. */
export const ETIQUETAS_RED: Record<string, string> = {
  amazon: 'Amazon Associates',
  aliexpress: 'AliExpress',
  ebay: 'eBay Partner Network',
  awin: 'Awin',
  cj: 'CJ Affiliate',
  admitad: 'Admitad',
  tradedoubler: 'Tradedoubler',
  kwanko: 'Kwanko',
  etsy: 'Etsy',
};

/** Porcentaje de descuento real de un producto (0 si no hay precio original). */
export function descuentoDe(product: { price: number; originalPrice?: number }): number {
  const original = Number(product.originalPrice) || 0;
  const precio = Number(product.price) || 0;
  if (original <= precio || precio <= 0) return 0;
  return Math.round(((original - precio) / original) * 100);
}

/* ------------------------------------------------------- resumen de catálogo */

export interface ResumenCatalogo {
  productos: number;
  categorias: number;
  subcategorias: number;
  precioMedio: number;
  descuentoMedio: number;
  valorCatalogo: number;
  redes: { id: string; etiqueta: string; productos: number }[];
}

/** Fotografía del catálogo actual (productos, precio, descuento y redes). */
export function getResumenCatalogo(): ResumenCatalogo {
  const productos = getCatalogProducts();
  const categorias = getCategories();
  const precios = productos.map((p) => Number(p.price)).filter((v) => Number.isFinite(v) && v > 0);
  const descuentos = productos.map(descuentoDe).filter((d) => d > 0);
  const porRed = new Map<string, number>();
  for (const producto of productos) {
    const red = (producto.network ?? 'sin-red').toLowerCase();
    porRed.set(red, (porRed.get(red) ?? 0) + 1);
  }
  return {
    productos: productos.length,
    categorias: categorias.filter((c) => !c.parentId).length,
    subcategorias: categorias.filter((c) => Boolean(c.parentId)).length,
    precioMedio: redondear(media(precios), 2),
    descuentoMedio: redondear(media(descuentos), 1),
    valorCatalogo: redondear(precios.reduce((suma, valor) => suma + valor, 0), 2),
    redes: [...porRed.entries()]
      .map(([id, total]) => ({
        id,
        etiqueta: ETIQUETAS_RED[id] ?? (id === 'sin-red' ? 'Sin red asignada' : id),
        productos: total,
      }))
      .sort((a, b) => b.productos - a.productos),
  };
}

/* --------------------------------------------- categorías por campaña (calendario) */

export interface ProductoCampana {
  title: string;
  precio: number;
  rating?: number;
  descuento: number;
  url: string;
}

export interface CategoriaCampana {
  id: string;
  nombre: string;
  slug: string;
  icono: string;
  productos: number;
  precioMedio: number;
  descuentoMedio: number;
  mejor: ProductoCampana | null;
}

/** Categoría efectiva de un producto (subcategoría si la hay). */
function categoriaEfectiva(producto: {
  category?: string;
  category_id?: string;
  subcategory_id?: string;
}): Category | undefined {
  const categorias = getCategories();
  if (producto.subcategory_id) {
    const sub = categorias.find((c) => c.id === producto.subcategory_id);
    if (sub) return sub;
  }
  if (producto.category_id) {
    const raiz = categorias.find((c) => c.id === producto.category_id);
    if (raiz) return raiz;
  }
  const nombre = normalizarTexto(producto.category ?? '');
  return categorias.find((c) => normalizarTexto(c.name) === nombre);
}

/**
 * Categorías del catálogo que encajan en una campaña concreta, con el número
 * de productos, el precio medio y el mejor candidato (mejor conversión).
 */
export function getCampanaCatalogo(momento: MomentoResuelto): CategoriaCampana[] {
  const categorias = getCategories();
  const productos = getCatalogProducts();
  const momentosNormalizados = new Set(momento.keywords.map(normalizarTexto));

  const coincide = (categoria: Category): boolean => {
    if (momentosNormalizados.has(normalizarTexto(categoria.name))) return true;
    return categoria.keywords.some((keyword) => momentosNormalizados.has(normalizarTexto(keyword)));
  };

  const resultado: CategoriaCampana[] = [];
  for (const categoria of categorias) {
    if (!coincide(categoria)) continue;
    const subcategorias = categorias.filter((c) => c.parentId === categoria.id);
    const subIds = new Set(subcategorias.map((c) => c.id));
    const candidatos = productos.filter((producto) => {
      const efectiva = categoriaEfectiva(producto);
      if (!efectiva) return false;
      return efectiva.id === categoria.id || subIds.has(efectiva.id);
    });
    if (!candidatos.length) continue;
    const precios = candidatos.map((p) => Number(p.price)).filter((v) => Number.isFinite(v) && v > 0);
    const descuentos = candidatos.map(descuentoDe).filter((d) => d > 0);
    const mejor = candidatos
      .slice()
      .sort((a, b) => (b.conversion_score ?? 0) - (a.conversion_score ?? 0) || (b.rating ?? 0) - (a.rating ?? 0))[0];
    resultado.push({
      id: categoria.id,
      nombre: categoria.name,
      slug: categoria.slug,
      icono: categoria.icon,
      productos: candidatos.length,
      precioMedio: redondear(media(precios), 2),
      descuentoMedio: redondear(media(descuentos), 1),
      mejor: mejor
        ? {
            title: mejor.title,
            precio: Number(mejor.price) || 0,
            rating: mejor.rating,
            descuento: descuentoDe(mejor),
            url: `/producto/${mejor.slug ?? mejor.id}`,
          }
        : null,
    });
  }
  return resultado.sort((a, b) => b.productos - a.productos);
}

/* ------------------------------------------------------------- market map */

interface MercadoConfig {
  id: string;
  nombre: string;
  bandera: string;
  idioma: string;
  huso: string;
  /** Redes con cobertura en ese mercado. */
  redes: string[];
}

/** Mercados objetivo del portal (cobertura de redes por país). */
const MERCADOS: MercadoConfig[] = [
  { id: 'ES', nombre: 'España', bandera: '🇪🇸', idioma: 'es', huso: 'UTC+1', redes: ['amazon', 'aliexpress', 'ebay', 'awin', 'cj', 'admitad', 'tradedoubler', 'kwanko', 'etsy'] },
  { id: 'MX', nombre: 'México', bandera: '🇲🇽', idioma: 'es', huso: 'UTC-6', redes: ['amazon', 'aliexpress', 'ebay', 'awin', 'cj', 'admitad', 'tradedoubler', 'etsy'] },
  { id: 'AR', nombre: 'Argentina', bandera: '🇦🇷', idioma: 'es', huso: 'UTC-3', redes: ['amazon', 'aliexpress', 'ebay', 'awin', 'admitad', 'tradedoubler'] },
  { id: 'CO', nombre: 'Colombia', bandera: '🇨🇴', idioma: 'es', huso: 'UTC-5', redes: ['amazon', 'aliexpress', 'ebay', 'awin', 'admitad', 'tradedoubler'] },
  { id: 'CL', nombre: 'Chile', bandera: '🇨🇱', idioma: 'es', huso: 'UTC-4', redes: ['amazon', 'aliexpress', 'ebay', 'awin', 'admitad'] },
  { id: 'PE', nombre: 'Perú', bandera: '🇵🇪', idioma: 'es', huso: 'UTC-5', redes: ['amazon', 'aliexpress', 'ebay', 'awin', 'tradedoubler'] },
  { id: 'DE', nombre: 'Alemania', bandera: '🇩🇪', idioma: 'de', huso: 'UTC+1', redes: ['amazon', 'aliexpress', 'ebay', 'awin', 'cj', 'admitad', 'tradedoubler', 'kwanko', 'etsy'] },
  { id: 'FR', nombre: 'Francia', bandera: '🇫🇷', idioma: 'fr', huso: 'UTC+1', redes: ['amazon', 'aliexpress', 'ebay', 'awin', 'cj', 'admitad', 'tradedoubler', 'kwanko', 'etsy'] },
  { id: 'IT', nombre: 'Italia', bandera: '🇮🇹', idioma: 'it', huso: 'UTC+1', redes: ['amazon', 'aliexpress', 'ebay', 'awin', 'cj', 'admitad', 'tradedoubler', 'kwanko', 'etsy'] },
  { id: 'PT', nombre: 'Portugal', bandera: '🇵🇹', idioma: 'pt', huso: 'UTC+0', redes: ['amazon', 'aliexpress', 'ebay', 'awin', 'cj', 'admitad', 'tradedoubler', 'etsy'] },
  { id: 'NL', nombre: 'Países Bajos', bandera: '🇳🇱', idioma: 'nl', huso: 'UTC+1', redes: ['amazon', 'aliexpress', 'ebay', 'awin', 'tradedoubler', 'etsy'] },
  { id: 'US', nombre: 'Estados Unidos', bandera: '🇺🇸', idioma: 'en', huso: 'UTC-5', redes: ['amazon', 'aliexpress', 'ebay', 'awin', 'cj', 'admitad', 'etsy'] },
  { id: 'GB', nombre: 'Reino Unido', bandera: '🇬🇧', idioma: 'en', huso: 'UTC+0', redes: ['amazon', 'aliexpress', 'ebay', 'awin', 'cj', 'tradedoubler', 'kwanko', 'etsy'] },
];

/** Sinónimos de país → id de mercado. */
const ALIAS_PAIS: Record<string, string> = {
  espana: 'ES', spain: 'ES', esp: 'ES',
  mexico: 'MX', mex: 'MX',
  argentina: 'AR', arg: 'AR',
  colombia: 'CO', col: 'CO',
  chile: 'CL',
  peru: 'PE', perú: 'PE',
  alemania: 'DE', germany: 'DE', deutschland: 'DE',
  francia: 'FR', france: 'FR',
  italia: 'IT', italy: 'IT',
  portugal: 'PT',
  'paises bajos': 'NL', holanda: 'NL', netherlands: 'NL',
  'estados unidos': 'US', usa: 'US', 'united states': 'US', america: 'US',
  'reino unido': 'GB', 'united kingdom': 'GB', uk: 'GB', inglaterra: 'GB',
};

/** Normaliza el país declarado por un usuario al id de mercado. */
export function idMercadoDe(pais?: string): string | null {
  if (!pais) return null;
  const clave = normalizarTexto(pais);
  if (!clave) return null;
  if (ALIAS_PAIS[clave]) return ALIAS_PAIS[clave];
  const superior = clave.toUpperCase();
  if (MERCADOS.some((m) => m.id === superior)) return superior;
  return null;
}

export interface FilaMercado {
  id: string;
  nombre: string;
  bandera: string;
  idioma: string;
  huso: string;
  usuarios: number;
  ltv: number;
  leadScore: number;
  carrito: number;
  porcentajeUsuarios: number;
  redes: string[];
  productos: number;
  precioMedio: number;
  prioridad: 'alta' | 'media' | 'baja';
  accion: string;
  ventana: string;
}

export interface CoberturaRed {
  red: string;
  etiqueta: string;
  productos: number;
  mercados: string[];
}

export interface MarketMap {
  mercados: FilaMercado[];
  cobertura: CoberturaRed[];
  totalUsuarios: number;
  totalLtv: number;
  proximo: MomentoResuelto | null;
  sinCobertura: string[];
}

/**
 * Mapa de mercados: audiencia real por país + cobertura de redes del catálogo
 * y ventana comercial vigente.
 */
export function getMarketMap(anio = new Date().getFullYear()): MarketMap {
  const usuarios = getAudience360();
  const resumen = getResumenCatalogo();
  const productos = getCatalogProducts();
  const momentos = getMomentosComerciales(anio);
  const proximo = getProximoMomento(anio);

  const porMercado = new Map<string, { usuarios: number; ltv: number; score: number; carrito: number; n: number }>();
  for (const usuario of usuarios) {
    const id = idMercadoDe(usuario.declared.country);
    if (!id) continue;
    const actual = porMercado.get(id) ?? { usuarios: 0, ltv: 0, score: 0, carrito: 0, n: 0 };
    actual.usuarios += 1;
    actual.ltv += usuario.behavior.ltv;
    actual.score += usuario.leadScore.value;
    actual.carrito += usuario.behavior.cartTotal;
    actual.n += 1;
    porMercado.set(id, actual);
  }

  const totalUsuarios = usuarios.length;
  const totalLtv = redondear(usuarios.reduce((suma, u) => suma + u.behavior.ltv, 0), 2);

  const filas: FilaMercado[] = MERCADOS.map((mercado) => {
    const datos = porMercado.get(mercado.id);
    const nUsuarios = datos?.usuarios ?? 0;
    const ltv = redondear(datos?.ltv ?? 0, 2);
    const leadScore = datos?.n ? redondear((datos?.score ?? 0) / datos.n, 1) : 0;
    const carrito = redondear(datos?.carrito ?? 0, 2);
    const porcentajeUsuarios = totalUsuarios ? redondear((nUsuarios / totalUsuarios) * 100, 1) : 0;
    const prioridad: FilaMercado['prioridad'] =
      nUsuarios === 0 ? 'baja' : leadScore >= 60 || porcentajeUsuarios >= 25 ? 'alta' : 'media';
    const ventana = proximo ? `${proximo.nombre} · ${proximo.fecha.slice(8, 10)}/${proximo.fecha.slice(5, 7)}` : 'Sin campañas en el año';
    return {
      id: mercado.id,
      nombre: mercado.nombre,
      bandera: mercado.bandera,
      idioma: mercado.idioma,
      huso: mercado.huso,
      usuarios: nUsuarios,
      ltv,
      leadScore,
      carrito,
      porcentajeUsuarios,
      redes: mercado.redes,
      productos: resumen.productos,
      precioMedio: resumen.precioMedio,
      prioridad,
      accion:
        prioridad === 'alta'
          ? 'Campaña email + redes sobre los productos guardados por esta audiencia'
          : prioridad === 'media'
            ? 'Insertar en el calendario comercial y captar con contenido SEO'
            : 'Mercado sin audiencia: sólo cobertura técnica, activar con contenido',
      ventana,
    };
  })
    .sort((a, b) => b.usuarios - a.usuarios || b.ltv - a.ltv);

  const redesUsadas = new Set(
    productos.map((p) => (p.network ?? '').toLowerCase()).filter(Boolean),
  );
  const cobertura: CoberturaRed[] = [...redesUsadas].map((red) => ({
    red,
    etiqueta: ETIQUETAS_RED[red] ?? red,
    productos: productos.filter((p) => (p.network ?? '').toLowerCase() === red).length,
    mercados: MERCADOS.filter((m) => m.redes.includes(red)).map((m) => m.id),
  }));
  cobertura.sort((a, b) => b.productos - a.productos);

  const sinCobertura = MERCADOS.filter((m) => !m.redes.some((red) => redesUsadas.has(red))).map((m) => m.nombre);

  return { mercados: filas, cobertura, totalUsuarios, totalLtv, proximo, sinCobertura };
}

/* ---------------------------------------------------------- market action */

export interface EmbudoMarketing {
  dias: number;
  visitas: number;
  fichas: number;
  salidas: number;
  compras: number;
  conversionPct: number;
  CarritoAbandonoPct: number | null;
}

export interface AccionMarketing {
  id: string;
  titulo: string;
  icono: string;
  prioridad: 'alta' | 'media' | 'baja';
  usuarios: number;
  valor: number;
  canal: string;
  plazo: string;
  pasos: string[];
  enlace: string;
  etiquetaEnlace: string;
}

/** Días hasta el cumpleaños (o null si no hay fecha). */
function diasParaCumpleanos(fecha?: string): number | null {
  if (!fecha) return null;
  const [mes, dia] = fecha.split('-').map((part) => Number(part));
  if (!mes || !dia) return null;
  const hoy = new Date();
  const este = new Date(Date.UTC(hoy.getUTCFullYear(), mes - 1, dia));
  const ahora = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate());
  let diff = Math.round((este.getTime() - ahora) / DAY_MS);
  if (diff < 0) diff += 365;
  return diff;
}

/**
 * Embudo real de los últimos 30 días + acciones de conversión segmentadas por
 * comportamiento de la audiencia (con valor en riesgo y pasos concretos).
 */
export function getMarketActions(dias = 30): { embudo: EmbudoMarketing; acciones: AccionMarketing[]; totalUsuarios: number } {
  const ahora = Date.now();
  const desde = ahora - dias * DAY_MS;
  const eventos = getAnalyticsEvents().filter((evento) => {
    const ts = Date.parse(evento.createdAt);
    return Number.isFinite(ts) && ts >= desde && ts <= ahora;
  });

  const visitas = eventos.filter((e) => e.type === 'page_view').length;
  const fichas = eventos.filter((e) => e.type === 'page_view' && Boolean(e.productId)).length;
  const salidas = eventos.filter((e) => e.type === 'outbound_click').length;
  const compras = eventos.filter((e) => e.type === 'purchase').length;
  const conversiones = new Set(
    eventos
      .filter((e) => e.type === 'outbound_click' || e.type === 'purchase')
      .map((e) => e.sessionId ?? e.visitorId ?? e.createdAt),
  );
  const sesiones = new Set(
    eventos.filter((e) => e.type === 'page_view').map((e) => e.sessionId ?? e.visitorId ?? e.createdAt),
  );

  const embudo: EmbudoMarketing = {
    dias,
    visitas,
    fichas,
    salidas,
    compras,
    conversionPct: sesiones.size ? redondear((conversiones.size / sesiones.size) * 100, 1) : 0,
    CarritoAbandonoPct: null,
  };

  const audiencia = getAudience360();
  const conCarrito = audiencia.filter((u) => u.behavior.cartItems.length > 0);
  const calorosos = audiencia.filter(
    (u) => u.leadScore.value >= 70 && u.behavior.purchaseCount === 0,
  );
  const guardados = audiencia.filter((u) => u.behavior.savedCount > 0 && u.behavior.purchaseCount === 0);
  const vistos = audiencia.filter((u) => u.behavior.viewedNotBought.length > 0);
  const cumpleaños = audiencia.filter((u) => {
    const dias = diasParaCumpleanos(u.declared.birthDate);
    return dias !== null && dias <= 30;
  });
  const sinPerfil = audiencia.filter(
    (u) => u.declared.hobbies.length === 0 && u.declared.preferredCategories.length === 0,
  );
  const inactivos = audiencia.filter((u) => {
    if (!u.behavior.lastVisitAtISO) return u.behavior.visits === 0;
    return Date.now() - Date.parse(u.behavior.lastVisitAtISO) > 60 * DAY_MS;
  });

  const sumaCarrito = conCarrito.reduce((suma, u) => suma + u.behavior.cartTotal, 0);
  const sumaLtvCaliente = calorosos.reduce((suma, u) => suma + u.behavior.cartTotal, 0);

  embudo.CarritoAbandonoPct = conCarrito.length
    ? redondear((conCarrito.length / audiencia.length) * 100, 1)
    : audiencia.length
      ? 0
      : null;

  const acciones: AccionMarketing[] = [
    {
      id: 'carrito-abandonado',
      titulo: 'Recuperar carritos abandonados',
      icono: '🛒',
      prioridad: 'alta',
      usuarios: conCarrito.length,
      valor: redondear(sumaCarrito, 2),
      canal: 'Email de recordatorio (SMTP / n8n)',
      plazo: '24-48 h desde el clic de salida',
      pasos: [
        'Filtrar la audiencia con producto en el carrito (hasCart=1)',
        'Enviar el email de carrito con el producto exacto y su precio actual',
        'Si no hay respuesta en 72 h, segundo email con el descuento real del producto',
      ],
      enlace: '/upayp1b4/marketing/usuarios?hasCart=1',
      etiquetaEnlace: 'Ver usuarios con carrito',
    },
    {
      id: 'leads-calientes',
      titulo: 'Activar leads calientes sin compra',
      icono: '🔥',
      prioridad: 'alta',
      usuarios: calorosos.length,
      valor: redondear(sumaLtvCaliente, 2),
      canal: 'Secuencia de email + redes',
      plazo: '72 h',
      pasos: [
        'Filtrar por lead score ≥ 70 sin compras (minScore=70)',
        'Enviar la comparativa de la categoría queinteresta a cada usuario',
        'Insertar en la cola social el mismo producto con el ángulo de su hobby',
      ],
      enlace: '/upayp1b4/marketing/usuarios?minScore=70',
      etiquetaEnlace: 'Ver leads calientes',
    },
    {
      id: 'guardados-sin-comprar',
      titulo: 'Cerrar guardados en Mi Radar',
      icono: '⭐',
      prioridad: 'media',
      usuarios: guardados.length,
      valor: redondear(
        guardados.reduce(
          (suma, u) => suma + u.behavior.savedProducts.reduce((s, p) => s + (p.priceValue ?? 0), 0),
          0,
        ),
        2,
      ),
      canal: 'Email con la lista de guardados',
      plazo: '7-10 días',
      pasos: [
        'Listar los productos guardados con su precio actual',
        'Avisar si el precio ha bajado desde que se guardó',
        'Enlace directo a la ficha (no al catálogo completo)',
      ],
      enlace: '/upayp1b4/marketing/usuarios',
      etiquetaEnlace: 'Ver usuarios con guardados',
    },
    {
      id: 'vistos-sin-comprar',
      titulo: 'Recuperar fichas vistas sin compra',
      icono: '👀',
      prioridad: 'media',
      usuarios: vistos.length,
      valor: 0,
      canal: 'Email deAlternativa',
      plazo: '48 h',
      pasos: [
        'Enviar la alternativa más barata del producto que visitaron',
        'Incluir el veredicto de la comparativa (por qué no es la mejor opción)',
        'Un solo enlace por email',
      ],
      enlace: '/upayp1b4/marketing/usuarios',
      etiquetaEnlace: 'Ver fichas sin compra',
    },
    {
      id: 'cumpleanos',
      titulo: 'Saludo de cumpleaños con regalo',
      icono: '🎂',
      prioridad: 'media',
      usuarios: cumpleaños.length,
      valor: redondear(
        cumpleaños.reduce(
          (suma, u) => suma + u.behavior.savedProducts.reduce((s, p) => s + (p.priceValue ?? 0), 0),
          0,
        ),
        2,
      ),
      canal: 'Email personalizado',
      plazo: 'El día del cumpleaños',
      pasos: [
        'Saludo con su hobby y 3 productos del catálogo que encajan',
        'Insertar el enlace de salida de afiliado directo',
        'Anotar el envío para no repetir el año siguiente',
      ],
      enlace: '/upayp1b4/marketing/usuarios',
      etiquetaEnlace: 'Ver cumpleaños próximos',
    },
    {
      id: 'perfil-incompleto',
      titulo: 'Completar el perfil de la audiencia',
      icono: '🧭',
      prioridad: 'media',
      usuarios: sinPerfil.length,
      valor: 0,
      canal: 'Email de onboarding',
      plazo: '7 días',
      pasos: [
        'Pedir 3 hobbies (el perfil alimenta la segmentación por afinidad)',
        'Regalar valor: comparativa de su hobby antes de pedir nada más',
        'Medir la tasa de respuesta y usarlo en el calendario',
      ],
      enlace: '/upayp1b4/marketing/usuarios',
      etiquetaEnlace: 'Ver perfiles por completar',
    },
    {
      id: 'reactivacion',
      titulo: 'Reactivar usuarios dormidos',
      icono: '💤',
      prioridad: 'baja',
      usuarios: inactivos.length,
      valor: 0,
      canal: 'Email + push de catálogo',
      plazo: 'Mensual',
      pasos: [
        'Seleccionar a los que no visitan desde hace más de 60 días',
        'Enviar el "lo mejor de este mes" en vez de un discount genérico',
        'Medir si vuelven a la web en los 7 días siguientes',
      ],
      enlace: '/upayp1b4/marketing/usuarios',
      etiquetaEnlace: 'Ver usuarios inactivos',
    },
  ];

  return { embudo, acciones, totalUsuarios: audiencia.length };
}

/* -------------------------------------------------------------- tendencias */

export interface TendenciaCategoria {
  slug: string;
  nombre: string;
  icono: string;
  visitas: number;
  visitasAnterior: number;
  variacion: number;
  productos: number;
  precioMedio: number;
  descuentoMedio: number;
}

export interface TendenciaPrecio {
  id: string;
  titulo: string;
  precio: number;
  anterior: number;
  variacion: number;
  categoria: string;
  url: string;
}

export interface SenalTendencia {
  tag: string;
  productos: number;
  precioMedio: number;
}

export interface Tendencias {
  categorias: TendenciaCategoria[];
  alAlza: TendenciaPrecio[];
  aLaBaja: TendenciaPrecio[];
  senales: SenalTendencia[];
  estacionalidad: { mes: number; etiqueta: string; indice: number; visitas: number }[];
  previstas: MomentoResuelto[];
  totalVisitas: number;
}

const MESES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

/**
 * Tendencias reales: variación de visitas por categoría (30 días vs 30
 * anteriores), movimientos de precio del histórico, señales (tags) y
 * estacionalidad mensual con la previsión de campañas.
 */
export function getTendencias(dias = 30, anio = new Date().getFullYear()): Tendencias {
  const ahora = Date.now();
  const desde = ahora - dias * DAY_MS;
  const desdeAnterior = desde - dias * DAY_MS;
  const eventos = getAnalyticsEvents();
  const actuales = eventos.filter((e) => {
    const ts = Date.parse(e.createdAt);
    return Number.isFinite(ts) && ts >= desde && ts <= ahora && e.type === 'page_view';
  });
  const anteriores = eventos.filter((e) => {
    const ts = Date.parse(e.createdAt);
    return Number.isFinite(ts) && ts >= desdeAnterior && ts < desde && e.type === 'page_view';
  });

  const productos = getCatalogProducts();
  const categorias = getCategories();
  const slugPorProducto = new Map<string, string>();
  for (const producto of productos) {
    const efectiva = categoriaEfectiva(producto);
    if (!efectiva) continue;
    const raiz = efectiva.parentId
      ? categorias.find((c) => c.id === efectiva.parentId) ?? efectiva
      : efectiva;
    // La analítica guarda el slug de la ficha; el catálogo, el id. Mapeamos ambos.
    slugPorProducto.set(producto.id, raiz.slug);
    if (producto.slug) slugPorProducto.set(producto.slug, raiz.slug);
  }

  const visitasPorSlug = new Map<string, number>();
  for (const evento of actuales) {
    if (!evento.productId) continue;
    const slug = slugPorProducto.get(evento.productId);
    if (!slug) continue;
    visitasPorSlug.set(slug, (visitasPorSlug.get(slug) ?? 0) + 1);
  }
  const visitasAnterioresPorSlug = new Map<string, number>();
  for (const evento of anteriores) {
    if (!evento.productId) continue;
    const slug = slugPorProducto.get(evento.productId);
    if (!slug) continue;
    visitasAnterioresPorSlug.set(slug, (visitasAnterioresPorSlug.get(slug) ?? 0) + 1);
  }

  const productosPorSlug = new Map<string, typeof productos>();
  for (const producto of productos) {
    const slug = slugPorProducto.get(producto.id);
    if (!slug) continue;
    const lista = productosPorSlug.get(slug) ?? [];
    lista.push(producto);
    productosPorSlug.set(slug, lista);
  }

  const tendenciasCategorias: TendenciaCategoria[] = categorias
    .filter((categoria) => !categoria.parentId)
    .map((categoria) => {
      const lista = productosPorSlug.get(categoria.slug) ?? [];
      const precios = lista.map((p) => Number(p.price)).filter((v) => Number.isFinite(v) && v > 0);
      const descuentos = lista.map(descuentoDe).filter((d) => d > 0);
      const visitas = visitasPorSlug.get(categoria.slug) ?? 0;
      const visitasAnterior = visitasAnterioresPorSlug.get(categoria.slug) ?? 0;
      const variacion = visitasAnterior > 0
        ? redondear(((visitas - visitasAnterior) / visitasAnterior) * 100, 1)
        : visitas > 0
          ? 100
          : 0;
      return {
        slug: categoria.slug,
        nombre: categoria.name,
        icono: categoria.icon,
        visitas,
        visitasAnterior,
        variacion,
        productos: lista.length,
        precioMedio: redondear(media(precios), 2),
        descuentoMedio: redondear(media(descuentos), 1),
      };
    })
    .sort((a, b) => b.visitas - a.visitas || b.productos - a.productos);

  // Movimientos de precio a partir del histórico guardado en cada producto.
  const movimientos: TendenciaPrecio[] = [];
  for (const producto of productos) {
    const historia = producto.priceHistory ?? [];
    if (historia.length < 2) continue;
    const ultimo = historia[historia.length - 1];
    const previo = historia[historia.length - 2];
    if (!ultimo || !previo || !previo.price) continue;
    const variacion = redondear(((ultimo.price - previo.price) / previo.price) * 100, 1);
    if (variacion === 0) continue;
    movimientos.push({
      id: producto.id,
      titulo: producto.title,
      precio: ultimo.price,
      anterior: previo.price,
      variacion,
      categoria: producto.category,
      url: `/producto/${producto.slug ?? producto.id}`,
    });
  }
  const alAlza = movimientos
    .filter((m) => m.variacion > 0)
    .sort((a, b) => b.variacion - a.variacion)
    .slice(0, 8);
  const aLaBaja = movimientos
    .filter((m) => m.variacion < 0)
    .sort((a, b) => a.variacion - b.variacion)
    .slice(0, 8);

  // Señales: tags técnicos de los productos con mejor conversión.
  const porTag = new Map<string, { productos: number; precios: number[] }>();
  for (const producto of productos) {
    const score = producto.conversion_score ?? 0;
    for (const tag of producto.normalized_tags ?? []) {
      const clave = normalizarTexto(tag);
      if (!clave) continue;
      const actual = porTag.get(clave) ?? { productos: 0, precios: [] };
      actual.productos += 1;
      if (score >= 60) actual.precios.push(Number(producto.price) || 0);
      porTag.set(clave, actual);
    }
  }
  const senales: SenalTendencia[] = [...porTag.entries()]
    .map(([tag, datos]) => ({
      tag,
      productos: datos.productos,
      precioMedio: redondear(media(datos.precios.filter((v) => v > 0)), 2),
    }))
    .filter((senal) => senal.productos > 0)
    .sort((a, b) => b.productos - a.productos)
    .slice(0, 12);

  // Estacionalidad: visitas por mes (histórico) e índice relativo.
  const meses = getMesesAnalitica().meses;
  const visitasPorMes = new Map<number, number>();
  for (const mes of meses) {
    const numero = Number(mes.month.slice(5, 7));
    visitasPorMes.set(numero, (visitasPorMes.get(numero) ?? 0) + mes.metrics.visitas);
  }
  const mediaMensual = media([...visitasPorMes.values()]);
  const estacionalidad = [...visitasPorMes.entries()]
    .map(([mes, visitas]) => ({
      mes,
      etiqueta: MESES_ES[mes - 1] ?? String(mes),
      indice: mediaMensual ? redondear((visitas / mediaMensual) * 100, 1) : 0,
      visitas,
    }))
    .sort((a, b) => a.mes - b.mes);

  const previstas = getMomentosComerciales(anio)
    .filter((momento) => momento.diasHasta >= 0)
    .slice(0, 4);

  return {
    categorias: tendenciasCategorias,
    alAlza,
    aLaBaja,
    senales,
    estacionalidad,
    previstas,
    totalVisitas: actuales.length,
  };
}
