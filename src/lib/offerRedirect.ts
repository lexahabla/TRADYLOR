/**
 * Resolución PURA del destino de salida de UNA oferta concreta del comparador (#ofertas).
 *
 * Regla de seguridad comercial: la oferta se busca SÓLO entre las ofertas de la ficha pedida (`getComparableOffers`). Un `offerId`
 * desconocido nunca cae en la oferta principal ni en la de otro vendedor: devuelve `null` y el endpoint regresa a `#ofertas`.
 * Sólo se admiten destinos http(s).
 */

import { getComparableOffers, type ComparableOffer } from './comparableOffers';
import { buildPurchaseUrl } from './purchaseUrl';

export interface OfferDestination {
  offer: ComparableOffer;
  destination: string;
}

const isHttp = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u.trim());

export function resolveOfferDestination(product: any, offerId: string, catalog?: any[]): OfferDestination | null {
  if (!offerId) return null;
  const result = getComparableOffers(product, catalog ? { catalog } : undefined);
  const offer = result.offers.find((o) => o.offerId === offerId) ?? result.otherVersions.find((v) => v.offer.offerId === offerId)?.offer;
  if (!offer) return null;
  const destination =
    offer.origin === 'implicit'
      ? buildPurchaseUrl(product) || product.affiliateUrl
      : buildPurchaseUrl({ affiliateUrl: offer.affiliateUrl || offer.url, buyNowUrl: undefined } as any);
  return isHttp(destination) ? { offer, destination: destination.trim() } : null;
}
