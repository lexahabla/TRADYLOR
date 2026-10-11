import type { Product } from '../data/products';
import { appendAmazonTag } from '../utils/amazon';

const FALLBACK_ASSOCIATE_TAG = 'tradylor-21';
const AMAZON_HOST_RE = /(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/i;
const AMAZON_ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?]|$)/i;

function associateTag(): string {
  const fromEnv = process.env.AMAZON_ASSOCIATE_TAG ?? import.meta.env.AMAZON_ASSOCIATE_TAG;
  return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : FALLBACK_ASSOCIATE_TAG;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function extractAmazonAsin(url: URL): string | null {
  const fromQuery = url.searchParams.get('asin');
  if (fromQuery && /^[A-Z0-9]{10}$/i.test(fromQuery)) return fromQuery.toUpperCase();
  const match = AMAZON_ASIN_RE.exec(url.pathname);
  return match ? match[1].toUpperCase() : null;
}

function amazonCartUrl(affiliateUrl: string): string | null {
  const url = parseHttpUrl(affiliateUrl);
  if (!url || !AMAZON_HOST_RE.test(url.hostname)) return null;

  const asin = extractAmazonAsin(url);
  if (!asin) return null;

  const tag = url.searchParams.get('tag')?.trim() || associateTag();
  const cart = new URL(`https://${url.hostname}/gp/aws/cart/add.html`);
  cart.searchParams.set('ASIN.1', asin);
  cart.searchParams.set('Quantity.1', '1');
  cart.searchParams.set('AssociateTag', tag);
  return cart.toString();
}

export function buildPurchaseUrl(product: Pick<Product, 'affiliateUrl' | 'buyNowUrl'>): string {
  const override = product.buyNowUrl?.trim();
  if (override && parseHttpUrl(override)) {
    // Compra directa configurada en el admin: si es de Amazon y no trae el
    // tag de afiliado, se añade automáticamente (best effort).
    return appendAmazonTag(override);
  }

  const affiliateUrl = (product.affiliateUrl ?? '').trim();
  if (!affiliateUrl) return '';
  if (!parseHttpUrl(affiliateUrl)) return affiliateUrl;

  return amazonCartUrl(affiliateUrl) ?? affiliateUrl;
}
