/**
 * ==============================================================================
 * TREIDILOR — FUENTES ADICIONALES DE ACTUALIZACIÓN (AliExpress y eBay, por id, APIs oficiales)
 * ==============================================================================
 * Amplían el servicio único de actualización (offerRefresh.ts) a las fichas que hoy salen como «sin fuente reconsultable». NO son scraping ni
 * servicios de pago: usan las credenciales de afiliado ya conectadas (AliExpress Portals / eBay Partner Network).
 *
 * OPT-IN: no se activan sin `OFFER_REFRESH_EXTRA_SOURCES=aliexpress,ebay` en el entorno. Aun activadas, el programador NO las ejecuta hasta que su
 * frecuencia se habilita en el panel (`enabled:false` por defecto); el botón manual sí.
 * Marcadas `experimental`: un precio que cambia más del 50 % respecto al guardado no se aplica (va a revisión), porque estos adaptadores aún no se
 * han contrastado con respuestas reales de producción. Un fallo conserva el último valor válido, como en Amazon.
 * ==============================================================================
 */

import type { Product } from './productStore';
import { normalizeSourceId } from './offerIdentity';
import { RefreshError, type RefreshReading, type SourceAdapter } from './offerRefresh';

/** Transporte inyectable (pruebas sin red): por defecto los conectores reales. */
export interface ExtraTransports {
  aliexpress?: (id: string) => Promise<{ price?: number; originalPrice?: number; currency: string; title?: string } | null>;
  ebay?: (id: string) => Promise<{ price?: number; currency?: string; inStock?: boolean | null; shippingCost?: number | null; title?: string } | null>;
}
export const transports: ExtraTransports = {};

export const aliexpressAdapter: SourceAdapter = {
  id: 'aliexpress-affiliate-api',
  networks: ['aliexpress'],
  experimental: true,
  resolveSource(product: Product) {
    for (const candidate of [product.sourceId, (product.extra as Record<string, unknown> | undefined)?.['ID externo']]) {
      const id = normalizeSourceId(candidate == null ? '' : String(candidate));
      if (/^\d{8,20}$/.test(id)) return { type: 'ali_product', id };
    }
    return null;
  },
  async fetch(_product, source): Promise<RefreshReading> {
    let result;
    try {
      if (transports.aliexpress) result = await transports.aliexpress(source.id);
      else {
        const { AliExpressConnector } = await import('./networks/connectors/aliexpress');
        result = await new AliExpressConnector().getProductPrice(source.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RefreshError(message, !/Faltan|credencial|signature|sign/i.test(message));
    }
    if (!result) throw new RefreshError('AliExpress no devolvió este anuncio (¿retirado?).', false);
    return { price: result.price ?? null, originalPrice: result.originalPrice ?? null, currency: result.currency, inStock: null, shippingCost: null, identity: { title: result.title, sourceId: source.id } };
  },
};

export const ebayAdapter: SourceAdapter = {
  id: 'ebay-browse-api',
  networks: ['ebay'],
  experimental: true,
  resolveSource(product: Product) {
    const raw = String(product.sourceId ?? '').trim();
    if (/^v1\|\d{9,14}\|\d+$/.test(raw)) return { type: 'ebay_item', id: raw };
    const fromUrl = String(product.affiliateUrl ?? '').match(/ebay\.[a-z.]+\/itm\/(?:[^/?#]+\/)?(\d{9,14})/i)?.[1];
    const legacy = /^\d{9,14}$/.test(raw) ? raw : fromUrl;
    return legacy ? { type: 'ebay_item', id: legacy } : null;
  },
  async fetch(_product, source): Promise<RefreshReading> {
    let result;
    try {
      if (transports.ebay) result = await transports.ebay(source.id);
      else {
        const { EbayConnector } = await import('./networks/connectors/ebay');
        result = await new EbayConnector().getItemSnapshot(source.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RefreshError(message, !/Faltan credenciales|OAuth/i.test(message));
    }
    if (!result) throw new RefreshError('eBay no encuentra este artículo (¿finalizado o retirado?).', false);
    return { price: result.price ?? null, currency: result.currency ?? 'EUR', inStock: result.inStock ?? null, shippingCost: result.shippingCost ?? null, identity: { title: result.title } };
  },
};

/** Adaptadores activados por el entorno (`OFFER_REFRESH_EXTRA_SOURCES=aliexpress,ebay`). Vacío por defecto. */
export function extraAdaptersFromEnv(env: string | undefined = process.env.OFFER_REFRESH_EXTRA_SOURCES): SourceAdapter[] {
  const wanted = new Set(String(env ?? '').toLowerCase().split(/[\s,;]+/).filter(Boolean));
  const out: SourceAdapter[] = [];
  if (wanted.has('aliexpress')) out.push(aliexpressAdapter);
  if (wanted.has('ebay')) out.push(ebayAdapter);
  return out;
}
