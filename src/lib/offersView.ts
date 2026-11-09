/**
 * ==============================================================================
 * TREIDILOR — VISTA DEL COMPARADOR DE OFERTAS DEL MISMO PRODUCTO (#ofertas)
 * ==============================================================================
 * Modelo de vista PURO sobre `getComparableOffers`: convierte cada oferta en las SIETE columnas del comparador (Producto, Precio y gastos,
 * Métodos de pago, Condiciones de envío, Descuento, Tienda y valoración, Acción) ya con sus textos. El componente Astro sólo los pinta.
 *
 * Reglas (decisiones del 09/11/2026):
 *  - Una fila por identidad comercial; las ofertas de otra variante/cantidad/condición NO se mezclan (van aparte).
 *  - Nada inventado: lo que no consta se rotula «No indicado»; los datos de proveedor van con su fecha de captura, nunca como «hoy».
 *  - «Más barata» sólo si `getComparableOffers` la acredita (2+ ofertas y TODOS los totales conocidos).
 *  - Descuento sólo si está verificado con una observación real; si no, «—».
 *  - El enlace de cada fila es /api/redirect?id=<ficha>&offer=<offerId>: el enlace de afiliado nunca viaja en el HTML.
 * ==============================================================================
 */

import { formatDateEs, NOT_INDICATED } from './commercialClaims';
import { getComparableOffers, type ComparableOffer, type ComparableOffersResult, type OtherVersion } from './comparableOffers';
import { networkLabel } from './productNetwork';
import { productKey } from './catalog';
import type { Product } from './productStore';

const eur = (n: number): string => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);
const num = (n: number, digits = 1): string => n.toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: digits });

export const CONDITION_LABELS: Record<string, string> = {
  new: 'Nueva',
  used: 'Usada',
  refurbished: 'Reacondicionada',
  open_box: 'Abierta, sin usar',
  unknown: 'Condición no indicada',
};

export const VERSION_REASON_LABELS: Record<string, string> = {
  condicion_distinta: 'otra condición',
  variante_distinta: 'otra variante',
  cantidad_distinta: 'otra cantidad',
};

/** «Envío rápido»: plazo declarado de 3 días o menos. Sólo existe si algún dato lo permite. */
export const FAST_SHIPPING_MAX_DAYS = 3;

export interface OfferRow {
  offerId: string;
  origin: 'implicit' | 'explicit';
  /** 1 · Producto */
  title: string;
  conditionLabel: string;
  variantLabels: string[];
  quantityLabel: string | null;
  /** 2 · Precio y gastos */
  priceValue: number;
  priceText: string;
  shippingText: string;
  shippingKnown: boolean;
  totalValue: number | null;
  totalText: string;
  asOfLabel: string;
  /** 3 · Métodos de pago */
  paymentText: string;
  /** 4 · Condiciones de envío */
  deliveryText: string;
  returnsText: string;
  fastShipping: boolean | null;
  /** 5 · Descuento */
  discountText: string;
  discountVerified: boolean;
  discountNote: string;
  /** 6 · Tienda y valoración */
  sellerLabel: string;
  sellerKnown: boolean;
  platformLabel: string;
  ratingText: string;
  /** 7 · Acción */
  href: string;
  ariaLabel: string;
  isCheapest: boolean;
  verified: boolean;
}

export interface OtherVersionRow {
  offerId: string;
  reasonLabel: string;
  conditionLabel: string;
  sellerLabel: string;
  platformLabel: string;
  priceText: string;
  href: string;
}

export interface OffersView {
  state: 'none' | 'single' | 'multiple';
  rows: OfferRow[];
  otherVersions: OtherVersionRow[];
  /** Mensaje informativo del estado (sin afirmar nada sobre el mercado). */
  message: string;
  /** Aviso adicional (p. ej. por qué no se indica «la más barata»). */
  note: string;
  sort: { priceEnabled: boolean; totalEnabled: boolean; totalReason: string };
  filters: {
    fastShipping: { enabled: boolean; reason: string };
    freeReturn: { enabled: boolean; reason: string };
  };
  footer: string;
  verifiedCount: number;
  comparisonReady: boolean;
}

function redirectHref(productId: string, offerId: string): string {
  return `/api/redirect?id=${encodeURIComponent(productId)}&offer=${encodeURIComponent(offerId)}&src=ofertas`;
}

function shippingPart(offer: ComparableOffer): { text: string; known: boolean } {
  const s = offer.shipping;
  if (s.conflict) return { text: 'Envío: datos contradictorios, no indicado', known: false };
  if (s.free === true) return { text: 'Envío gratis', known: true };
  if (s.cost !== null && s.cost > 0) return { text: `+ ${eur(s.cost)} de envío`, known: true };
  if (s.cost === 0) return { text: 'Envío gratis', known: true };
  return { text: `Envío: ${NOT_INDICATED.toLowerCase()}`, known: false };
}

function deliveryPart(offer: ComparableOffer): string {
  const s = offer.shipping;
  if (s.days !== null && s.days !== undefined) {
    const asOf = s.asOf || offer.capturedAt;
    const when = asOf ? ` (declarado a fecha de captura ${formatDateEs(asOf)}; puede haber cambiado)` : ' (sin fecha de captura; puede haber cambiado)';
    return `Plazo declarado: ${s.days} ${s.days === 1 ? 'día' : 'días'}${when}`;
  }
  return `Entrega: ${NOT_INDICATED}`;
}

function ratingPart(offer: ComparableOffer): string {
  const r = offer.rating;
  if (!r) return 'Sin valoración sustentada';
  const stars = `★ ${num(r.value)}`;
  const who = r.origin === 'vendedor' ? 'del vendedor' : 'del producto';
  const count = r.count ? ` (${r.count.toLocaleString('es-ES')} ${r.countLabel ?? 'valoraciones'})` : '';
  return `${stars} · ${who}${count}`;
}

function discountPart(offer: ComparableOffer): { text: string; verified: boolean; note: string } {
  const d = offer.discount;
  if (d?.verified && d.pct !== null) {
    return { text: `−${num(d.pct)} %`, verified: true, note: `Verificado el ${formatDateEs(d.asOf)} sobre un precio anterior de ${eur(d.previousPrice ?? 0)}` };
  }
  return { text: '—', verified: false, note: 'Sin descuento verificado' };
}

function variantLabels(offer: ComparableOffer): string[] {
  const names: Record<string, string> = { color: 'Color', size: 'Talla', capacity: 'Capacidad' };
  return Object.entries(offer.variant)
    .filter(([key]) => key !== 'pack')
    .map(([key, value]) => `${names[key] ?? key}: ${value}`);
}

export function rowOf(offer: ComparableOffer, product: Pick<Product, 'id' | 'title' | 'slug'>, cheapestId: string | null): OfferRow {
  const ship = shippingPart(offer);
  const key = productKey(product as Product);
  const platform = networkLabel(offer.platform) || offer.platform;
  const discount = discountPart(offer);
  const asOf = offer.shipping.asOf || offer.capturedAt || '';
  const days = offer.shipping.days;
  return {
    offerId: offer.offerId,
    origin: offer.origin,
    title: product.title,
    conditionLabel: CONDITION_LABELS[offer.condition] ?? CONDITION_LABELS.unknown,
    variantLabels: variantLabels(offer),
    quantityLabel: offer.quantity ? `Cantidad: ${offer.quantity}` : null,
    priceValue: offer.price,
    priceText: eur(offer.price),
    shippingText: ship.text,
    shippingKnown: ship.known,
    totalValue: offer.totalPrice,
    totalText: offer.totalPrice !== null ? `Total ${eur(offer.totalPrice)}` : 'Total no calculable',
    asOfLabel: asOf && (ship.known || days != null) ? `Dato de envío a fecha de captura (${formatDateEs(asOf)})` : '',
    paymentText: NOT_INDICATED,
    deliveryText: deliveryPart(offer),
    returnsText: `Devolución: ${NOT_INDICATED}`,
    fastShipping: days === null || days === undefined ? null : days <= FAST_SHIPPING_MAX_DAYS,
    discountText: discount.text,
    discountVerified: discount.verified,
    discountNote: discount.note,
    sellerLabel: offer.sellerLabel,
    sellerKnown: offer.seller.known,
    platformLabel: platform,
    ratingText: ratingPart(offer),
    href: redirectHref(key, offer.offerId),
    ariaLabel: `Ver oferta de ${offer.sellerLabel} en ${platform}`,
    isCheapest: cheapestId !== null && cheapestId === offer.offerId,
    verified: offer.verified,
  };
}

function otherRow(v: OtherVersion, product: Pick<Product, 'id' | 'slug'>): OtherVersionRow {
  const o = v.offer;
  const platform = networkLabel(o.platform) || o.platform;
  return {
    offerId: o.offerId,
    reasonLabel: VERSION_REASON_LABELS[v.reason] ?? v.reason,
    conditionLabel: CONDITION_LABELS[o.condition] ?? CONDITION_LABELS.unknown,
    sellerLabel: o.sellerLabel,
    platformLabel: platform,
    priceText: eur(o.price),
    href: redirectHref(productKey(product as Product), o.offerId),
  };
}

/** Construye la vista del comparador a partir del resultado de la capa de lectura (o lo calcula si no se pasa). */
export function buildOffersView(product: Product, catalog: Product[], precomputed?: ComparableOffersResult): OffersView {
  const result = precomputed ?? getComparableOffers(product as never, { catalog: catalog as never });
  const rows = result.offers.map((o) => rowOf(o, product, result.cheapest?.offerId ?? null));
  const otherVersions = result.otherVersions.map((v) => otherRow(v, product));

  const allTotalsKnown = rows.length >= 2 && rows.every((r) => r.totalValue !== null);
  const anyFast = rows.some((r) => r.fastShipping === true);
  const anyDays = rows.some((r) => r.fastShipping !== null);

  const dates = result.offers.map((o) => Date.parse(o.shipping.asOf || o.capturedAt || '')).filter((n) => Number.isFinite(n));
  const newest = dates.length ? new Date(Math.max(...dates)).toISOString() : '';
  const footer = [
    newest ? `Datos capturados el ${formatDateEs(newest)}` : 'Fecha de captura no disponible',
    result.verifiedCount > 0 ? `${result.verifiedCount} de ${rows.length} verificada${result.verifiedCount === 1 ? '' : 's'} con la tienda` : 'Sin verificar con la tienda',
  ].join(' · ');

  let message = '';
  let note = '';
  if (result.state === 'none') {
    message = 'Todavía no hay ofertas confirmadas de este producto.';
  } else if (result.state === 'single') {
    message = 'Todavía no hay otras ofertas comparables registradas en Treidilor.';
  } else if (!result.cheapest) {
    note = allTotalsKnown
      ? 'Hay un empate en el total con envío: no se indica una oferta más barata.'
      : 'No se indica cuál es la más barata: el envío de alguna oferta no consta y no se puede comparar el total.';
  }

  return {
    state: result.state,
    rows,
    otherVersions,
    message,
    note,
    sort: {
      priceEnabled: rows.length > 1,
      totalEnabled: allTotalsKnown,
      totalReason: allTotalsKnown ? '' : 'Ordenar por total no está disponible: el envío de alguna oferta no consta.',
    },
    filters: {
      fastShipping: anyDays ? { enabled: anyFast, reason: anyFast ? '' : 'Ninguna oferta declara un plazo de 3 días o menos.' } : { enabled: false, reason: 'Sin datos de plazo confirmados.' },
      freeReturn: { enabled: false, reason: 'Sin datos de devolución confirmados.' },
    },
    footer,
    verifiedCount: result.verifiedCount,
    comparisonReady: result.comparisonReady,
  };
}
