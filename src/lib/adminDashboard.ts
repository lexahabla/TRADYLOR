import fs from 'node:fs';
import { DATA_DIR, dataFile } from './paths';
import {
  createCategory as createCategoryResult,
  getCategories as getRichCategories,
  getCategoryBySlug,
  removeCategory as removeCategoryBySlug,
} from './categories';

export const AFFILIATE_PROVIDERS = [
  { id: 'amazon', name: 'Amazon Associates', description: 'Programa de asociados de Amazon.', envKeys: ['AMAZON_ASSOCIATE_TAG', 'AMAZON_PA_API_KEY', 'AMAZON_PA_SECRET'] },
  { id: 'aliexpress', name: 'AliExpress Portals / Official Affiliate Program', description: 'Catálogo y enlaces de AliExpress.', envKeys: ['ALIEXPRESS_APP_KEY', 'ALIEXPRESS_APP_SECRET', 'ALIEXPRESS_TRACKING_ID'] },
  { id: 'ebay', name: 'eBay Partner Network', description: 'Ofertas, campañas y enlaces de eBay.', envKeys: ['EBAY_CAMPAIGN_ID', 'EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET'] },
  { id: 'awin', name: 'Awin', description: 'Red de anunciantes y feeds de producto.', envKeys: ['AWIN_PUBLISHER_ID', 'AWIN_API_TOKEN'] },
  { id: 'cj', name: 'CJ Affiliate', description: 'Anunciantes, enlaces profundos y productos CJ.', envKeys: ['CJ_WEBSITE_ID', 'CJ_API_TOKEN'] },
  { id: 'admitad', name: 'Admitad', description: 'Ofertas y feeds de la red Admitad.', envKeys: ['ADMITAD_WEBSITE_ID', 'ADMITAD_API_TOKEN'] },
  { id: 'tradedoubler', name: 'Tradedoubler / Metapic', description: 'Campañas y monetización de Tradedoubler.', envKeys: ['TRADEDOUBLER_PARTNER_ID', 'TRADEDOUBLER_API_TOKEN'] },
  { id: 'kwanko', name: 'Kwanko (NetAffiliation)', description: 'Campañas y tracking de Kwanko.', envKeys: ['KWANKO_PUBLISHER_ID', 'KWANKO_API_TOKEN'] },
  { id: 'etsy', name: 'Etsy Affiliate Program', description: 'Productos y enlaces de Etsy.', envKeys: ['ETSY_API_KEY', 'ETSY_AFFILIATE_ID'] },
] as const;

const ANALYTICS_PATH = dataFile('analytics.json');

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (error) {
    console.error('[Admin dashboard] Error leyendo datos:', error);
  }
  return fallback;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

/** Nombres de categoría (esquema legado string[] consumido por el panel). */
export function getCategories(): string[] {
  return getRichCategories().map((category) => category.name);
}

export function addCategory(name: string): string[] {
  const normalized = String(name ?? '').trim();
  if (!normalized) return getCategories();
  const existing = getRichCategories().some(
    (category) => category.name.toLowerCase() === normalized.toLowerCase() || category.slug === normalized,
  );
  if (!existing) createCategoryResult({ name: normalized });
  return getCategories();
}

export function removeCategory(nameOrSlug: string): string[] {
  const target = getCategoryBySlug(nameOrSlug) ?? getRichCategories().find((c) => c.name === nameOrSlug);
  if (target) removeCategoryBySlug(target.slug);
  return getCategories();
}

export interface AnalyticsEvent {
  type: 'page_view' | 'product_click' | 'cart_add' | 'outbound_click';
  productId?: string;
  path?: string;
  createdAt: string;
}

export function getAnalyticsEvents(): AnalyticsEvent[] {
  return readJson<AnalyticsEvent[]>(ANALYTICS_PATH, []);
}

export function recordAnalyticsEvent(event: AnalyticsEvent): void {
  const events = getAnalyticsEvents();
  events.push(event);
  writeJson(ANALYTICS_PATH, events.slice(-10000));
}

export function getMarketingTools() {
  return [
    { id: 'meta', name: 'Meta / Facebook', envKeys: ['META_ACCESS_TOKEN', 'META_PAGE_ID'], status: 'Preparado para conectar' },
    { id: 'instagram', name: 'Instagram Business', envKeys: ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_BUSINESS_ID'], status: 'Preparado para conectar' },
    { id: 'google', name: 'Google Analytics 4', envKeys: ['GA4_MEASUREMENT_ID', 'GA4_API_SECRET'], status: 'Preparado para conectar' },
    { id: 'tiktok', name: 'TikTok Business', envKeys: ['TIKTOK_ACCESS_TOKEN', 'TIKTOK_ADVERTISER_ID'], status: 'Preparado para conectar' },
    { id: 'mailchimp', name: 'Mailchimp', envKeys: ['MAILCHIMP_API_KEY', 'MAILCHIMP_AUDIENCE_ID'], status: 'Preparado para conectar' },
    { id: 'webhooks', name: 'Webhooks y automatizaciones', envKeys: ['MARKETING_WEBHOOK_URL'], status: 'Preparado para conectar' },
  ];
}

export function getAffiliateProviders() {
  return AFFILIATE_PROVIDERS.map((provider) => ({
    ...provider,
    configured: provider.envKeys.every((key) => Boolean(process.env[key])),
  }));
}
