/**
 * ==============================================================================
 * TREIDILOR — OFERTAS DE UNA FICHA (modelo común, funciones puras)
 * ==============================================================================
 * Una FICHA del catálogo = una variante vendible. Sus ofertas son la oferta
 * «implícita» (campos planos: network/sourceId/price/affiliateUrl…, tal y como
 * la crean hoy la API y el flujo Amazon) + `extra.offers[]` (ofertas adicionales
 * de otros comerciantes/vendedores). Lo usan el importador JSON y la memoria de
 * eliminados, para que todos los canales reconozcan «la misma oferta».
 * ==============================================================================
 */

import { createHash } from 'node:crypto';
import { canonicalProductUrl, extractSourceId } from './curation';
import { normalizeSourceId, offerKey as baseOfferKey } from './offerIdentity';
import { normalizeCondition } from './jsonImport/normalize';
import type { Product } from './productStore';
import type { Condition, StoredOffer } from './jsonImport/types';

type Any = Record<string, unknown>;
export type P = Product & { extra?: Any };

/* ───────────────────────── Claves de identidad ───────────────────────── */

export function fold(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Vendedor comparable; si es la propia plataforma (p. ej. «Amazon») se considera sin vendedor. */
export function sellerKey(platform: string, sellerId?: string, sellerName?: string): string {
  const seller = fold(sellerId || sellerName);
  return seller && seller !== fold(platform) ? seller : '';
}

export function computeOfferKey(o: { platform: string; externalId?: string; sellerId?: string; sellerName?: string; canonicalUrl?: string }): string {
  const platform = fold(o.platform).replace(/ /g, '');
  const seller = sellerKey(o.platform, o.sellerId, o.sellerName);
  const id = normalizeSourceId(o.externalId);
  if (id) return baseOfferKey({ network: platform, externalId: id, merchantId: seller });
  if (o.canonicalUrl) return `${platform}:url:${o.canonicalUrl}${seller ? `:${seller}` : ''}`;
  return '';
}

export function platformIdKey(platform: string, externalId?: string): string {
  const id = normalizeSourceId(externalId);
  return id ? `${fold(platform).replace(/ /g, '')}:${id.toLowerCase()}` : '';
}

export const shortHash = (value: string, len = 6) => createHash('sha1').update(value).digest('hex').slice(0, len);

/* ───────────────────────── Ofertas de una ficha ───────────────────────── */

export function productCondition(p: P): Condition {
  return normalizeCondition(p.condition);
}

/** Oferta «implícita»: los campos planos de la ficha vistos como una oferta. */
export function implicitOffer(p: P): StoredOffer | null {
  const reading = (p.extra as Record<string, unknown> | undefined)?.priceReading as
    | { capturedAt?: string; capturedAtInferred?: boolean; receivedAt?: string }
    | undefined;
  const platform = fold(p.network || p.merchant).replace(/ /g, '');
  const externalId = extractSourceId(p as never) || undefined;
  const url = String(p.affiliateUrl || p.buyNowUrl || '');
  const canonicalUrl = canonicalProductUrl(url);
  // Vendedor de la oferta principal cuando NO es la propia plataforma (p. ej. una tienda de Temu): lo guarda la importación
  // JSON en `extra.offerSeller`. Sin él, reimportar el mismo anuncio con su vendedor lo trataría como otra oferta.
  const seller = ((p.extra as Record<string, unknown> | undefined)?.offerSeller ?? {}) as { id?: string; name?: string };
  const sellerId = seller.id ? String(seller.id) : undefined;
  const sellerName = seller.name ? String(seller.name) : undefined;
  const offerKey = computeOfferKey({ platform, externalId, canonicalUrl, sellerId, sellerName });
  if (!platform || !offerKey || !(Number(p.price) > 0)) return null;
  return {
    offerId: shortHash(offerKey, 10),
    offerKey,
    platform,
    externalId,
    sellerId,
    sellerName,
    url,
    canonicalUrl,
    price: Number(p.price),
    currency: String(p.currency || 'EUR').toUpperCase(),
    originalPrice: Number(p.originalPrice) > Number(p.price) ? Number(p.originalPrice) : undefined,
    availability: p.inStock === true ? 'in_stock' : p.inStock === false ? 'out_of_stock' : 'unknown',
    shipping: {
      cost: null,
      free: p.freeShipping === true ? true : null,
      days: typeof p.shippingDays === 'number' ? p.shippingDays : null,
      text: p.shippingInfo || undefined,
    },
    condition: productCondition(p),
    // CAPTURA: la de la última lectura recibida por JSON (si existe); si no, la verificación del refresco.
    capturedAt: String(reading?.capturedAt || p.lastPriceSync || ''),
    capturedAtInferred: reading ? reading.capturedAtInferred === true : undefined,
    receivedAt: String(reading?.receivedAt || ''),
    // VERIFICACIÓN: sólo la del servicio de actualización (nunca la de un JSON).
    verifiedAt: String(p.lastPriceSync || ''),
    source: { channel: 'json', batchId: '', adapter: 'implicit' },
    status: 'active',
    implicit: true,
  };
}

export function storedOffers(p: P): StoredOffer[] {
  const list = p.extra?.offers;
  return Array.isArray(list) ? (list as StoredOffer[]) : [];
}

/** Todas las ofertas de la ficha: implícita + `extra.offers`. */
export function getOffers(p: P): StoredOffer[] {
  const implicit = implicitOffer(p);
  return implicit ? [implicit, ...storedOffers(p)] : storedOffers(p);
}
