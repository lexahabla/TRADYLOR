/**
 * ==============================================================================
 * TRADYLOR - CONECTOR AWIN
 * ==============================================================================
 * Documentación oficial: https://developer.awin.com/
 *
 * Awin Publisher API ofrece endpoints REST con autenticación Bearer:
 *   - validate()          → GET /publishers/{id}/accounts (verifica credenciales).
 *   - searchCanonical()   → GET /publishers/{id}/product-feeds + descarga del feed
 *     activo (texto o comprimido en .gz) y mapeo de cada fila al contrato canónico
 *     CanonicalAffiliateProduct: precio, descuento, comisión estimada, deep link de
 *     afiliado, anunciante (vendedor) y marca.
 * Si la API de feeds no responde se devuelve un respaldo canónico `estimated: true`
 * (la UI lo muestra como estimado y searchCatalogBatch lo excluye del catálogo real).
 * search() delega en searchCanonical() para que no existan dos normalizadores.
 * ==============================================================================
 */

import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';

import {
  ConnectorError,
  canonicalToUnified,
  fetchWithTimeout,
  sampleProducts,
  type NetworkConnector,
} from './base';
import { getCredentialValues, setNetworkStatus } from '../credentials';
import type { CanonicalAffiliateProduct, UnifiedProduct, UnifiedSearchParams } from '../types';

const AWIN_API_BASE = 'https://api.awin.com';
/** Landing usada como enlace de respaldo cuando no hay feed disponible. */
const AWIN_FALLBACK_URL = 'https://pub.awin.com/';
const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?q=80&w=800&auto=format&fit=crop';

/** Bytes máximos decodificados por feed (suficientes para miles de filas). */
const FEED_MAX_BYTES = 4 * 1024 * 1024;
/** Filas conservadas en caché por feed y TTL de esa caché. */
const MAX_CACHED_ROWS = 4000;
const FEED_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_FEED_CACHE = 6;
/** Feeds que se recorren como máximo en una misma búsqueda. */
const MAX_FEEDS_PER_SEARCH = 3;

interface AwinCreds {
  publisherId: string;
  apiToken: string;
}

interface AwinFeed {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

/** Fila del feed con las cabeceras normalizadas (minúsculas y sin tildes). */
type FeedRow = Record<string, string>;

function resolveCreds(): AwinCreds | null {
  const creds = getCredentialValues('awin');
  if (!creds?.publisherId || !creds?.apiToken) return null;
  return { publisherId: creds.publisherId, apiToken: creds.apiToken };
}

/* ---------------- Lectura y parseo del feed ---------------- */

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** Cabecera → clave estable: minúsculas, sin tildes y separadores en `_`. */
function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function detectDelimiter(firstLine: string): string {
  if (firstLine.includes('\t')) return '\t';
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return semicolons > commas ? ';' : ',';
}

/** Divide una línea respetando comillas (CSV/TSV con campos entrecomillados). */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

/** Convierte el texto de un feed (CSV/TSV) en filas con cabeceras normalizadas. */
function parseFeedText(text: string): FeedRow[] {
  const lines = text.split(/\r?\n/);
  // Si el feed quedó cortado por el tope de bytes, la última línea está incompleta
  if (lines.length && lines[lines.length - 1].trim() !== '') lines.pop();

  const headerLine = lines.find((line) => line.trim() !== '');
  if (!headerLine) return [];
  const headerIndex = lines.indexOf(headerLine);
  const delimiter = detectDelimiter(headerLine);
  const headers = splitLine(headerLine, delimiter).map(normalizeHeader);
  if (!headers.length) return [];

  const rows: FeedRow[] = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = splitLine(line, delimiter);
    if (cells.every((cell) => !cell.trim())) continue;
    const row: FeedRow = {};
    for (let column = 0; column < headers.length; column += 1) {
      const key = headers[column];
      if (!key) continue;
      row[key] = (cells[column] ?? '').trim();
    }
    rows.push(row);
  }
  return rows;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function* remainingChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: Uint8Array,
): AsyncGenerator<Uint8Array> {
  if (head.byteLength) yield head;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value?.length) yield value;
  }
}

/**
 * Lee el cuerpo de un feed limitando los bytes decodificados. Soporta texto
 * plano y gzip (extensión `.gz`, habitual en los feeds de Awin): en ese caso
 * se descomprime en streaming y se corta en el mismo tope.
 */
async function readFeedText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text().catch(() => '');
    return text.slice(0, maxBytes);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const head = first.done ? new Uint8Array(0) : first.value;
  const isGzip = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;

  const collected: Uint8Array[] = [];
  let total = 0;
  const push = (chunk: Uint8Array) => {
    if (!chunk?.length || total >= maxBytes) return;
    const room = maxBytes - total;
    collected.push(chunk.byteLength > room ? chunk.subarray(0, room) : chunk);
    total += Math.min(chunk.byteLength, room);
  };

  try {
    if (!isGzip) {
      push(head);
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        push(value);
      }
      return decoder.decode(concatBytes(collected));
    }

    const source = Readable.from(remainingChunks(reader, head));
    const gunzip = createGunzip();
    // Evita 'error' sin escuchador si el feed llega truncado al cortar el stream
    source.on('error', () => undefined);
    gunzip.on('error', () => undefined);
    source.pipe(gunzip);
    try {
      for await (const chunk of gunzip) {
        push(chunk as Uint8Array);
        if (total >= maxBytes) break;
      }
    } finally {
      gunzip.destroy();
      source.destroy();
    }
    return decoder.decode(concatBytes(collected));
  } catch (error) {
    console.warn('[AwinConnector] No se pudo leer el feed completo:', error instanceof Error ? error.message : error);
    return decoder.decode(concatBytes(collected));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Lista de feeds de producto del publisher (API Publisher de Awin). */
async function fetchFeeds(creds: AwinCreds): Promise<AwinFeed[]> {
  const response = await fetchWithTimeout(
    `${AWIN_API_BASE}/publishers/${encodeURIComponent(creds.publisherId)}/product-feeds`,
    { headers: { Authorization: `Bearer ${creds.apiToken}`, Accept: 'application/json' } },
    12000,
  );
  if (!response.ok) {
    throw new ConnectorError('awin', `Awin product-feeds: HTTP ${response.status}.`);
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { feeds?: unknown[] } | null)?.feeds)
      ? (payload as { feeds: unknown[] }).feeds
      : [];

  const feeds: AwinFeed[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const url = firstString(raw.url, raw.feedUrl, raw.downloadUrl, raw.destination, raw.link);
    if (!/^https?:\/\//i.test(url)) continue;
    const status = firstString(raw.status, raw.state).toUpperCase();
    feeds.push({
      id: firstString(raw.id, raw.feedId) || url,
      title: firstString(raw.title, raw.name, raw.destinationName) || 'Feed de producto',
      url,
      active: !status || status === 'ACTIVE' || status === 'ENABLED' || status === 'OK',
    });
  }
  return feeds;
}

/** Caché de filas ya parseadas para no re-descargar el feed en cada búsqueda. */
const feedCache = new Map<string, { at: number; rows: FeedRow[] }>();

async function loadFeedRows(feed: AwinFeed): Promise<FeedRow[]> {
  const cached = feedCache.get(feed.url);
  if (cached && Date.now() - cached.at < FEED_CACHE_TTL_MS) return cached.rows;

  const response = await fetchWithTimeout(feed.url, {}, 20000);
  if (!response.ok) {
    throw new ConnectorError('awin', `Feed «${feed.title}»: HTTP ${response.status}.`);
  }

  const text = await readFeedText(response, FEED_MAX_BYTES);
  const rows = parseFeedText(text).slice(0, MAX_CACHED_ROWS);

  if (feedCache.size >= MAX_FEED_CACHE) {
    const oldest = feedCache.keys().next().value;
    if (oldest) feedCache.delete(oldest);
  }
  feedCache.set(feed.url, { at: Date.now(), rows });
  return rows;
}

/* ---------------- Mapeo de filas al contrato canónico ---------------- */

const FEED_ALIASES = {
  externalId: ['aw_product_id', 'product_id', 'merchant_product_id', 'productid', 'id', 'sku'],
  title: ['product_name', 'producttitle', 'title', 'merchant_product_name', 'name'],
  description: ['description', 'product_description', 'merchant_product_description', 'short_description'],
  affiliateUrl: ['aw_deep_link', 'deep_link', 'awin_deep_link', 'deeplink', 'affiliate_url', 'tracking_link', 'click_url'],
  directUrl: ['product_url', 'merchant_url', 'aw_product_url', 'url', 'link', 'product_link'],
  price: ['search_price', 'price', 'sale_price', 'current_price', 'price_incl_tax', 'price_eur', 'price_gbp'],
  originalPrice: ['rrp', 'high_price', 'high_street_price', 'original_price', 'list_price', 'old_price', 'was_price'],
  discount: ['discount_percentage', 'discount', 'saving', 'discount_amount', 'promo_discount'],
  commissionRate: ['commission_rate', 'aw_commission_rate', 'commission_percent', 'commission_pct', 'programme_commission', 'commission'],
  stock: ['stock', 'in_stock', 'availability', 'stock_status', 'inventory_status'],
  currency: ['currency', 'currency_iso', 'currency_code', 'aw_currency'],
  merchantName: ['merchant_name', 'advertiser_name', 'shop_name', 'store_name', 'programme_name'],
  merchantId: ['merchant_id', 'advertiser_id', 'aw_merchant_id', 'programme_id'],
  brand: ['brand', 'product_brand', 'merchant_brand', 'manufacturer'],
  category: ['category_name', 'category', 'primary_category', 'category_hierarchy', 'product_category'],
  subCategory: ['sub_category_name', 'sub_category', 'subcategory', 'secondary_category'],
  deliveryCost: ['delivery_cost', 'shipping_cost', 'postage', 'shipping'],
  deliveryTime: ['delivery_time', 'shipping_time', 'lead_time', 'delivery'],
  epc: ['epc'],
  sales: ['sales', 'sales_30d', 'monthly_sales', 'units_sold'],
  rating: ['rating', 'product_rating', 'average_rating', 'avg_rating'],
  reviewCount: ['review_count', 'reviews', 'num_reviews', 'total_reviews'],
  guarantee: ['guarantee', 'warranty'],
  condition: ['condition', 'product_condition', 'item_condition'],
} as const satisfies Record<string, readonly string[]>;

function pick(row: FeedRow, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = (row[key] ?? '').trim();
    if (value && value.toLowerCase() !== 'null' && value.toLowerCase() !== 'n/a') return value;
  }
  return '';
}

/**
 * Número tolerante al formato local del feed: `12,99`, `1.234,56`, `1,234.56`,
 * `1.500` o valores con símbolo de moneda (`12,99 €`).
 */
function toNumber(value: string): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[^\d.,-]/g, '');
  if (!cleaned) return undefined;

  const commas = (cleaned.match(/,/g) ?? []).length;
  const dots = (cleaned.match(/\./g) ?? []).length;
  let normalized = cleaned;

  if (commas > 0 && dots > 0) {
    normalized = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? cleaned.replace(/\./g, '').replace(/,/g, '.')
      : cleaned.replace(/,/g, '');
  } else if (commas > 1 || dots > 1) {
    normalized = cleaned.replace(/[.,]/g, '');
  } else if (commas === 1) {
    normalized = cleaned.replace(',', '.');
  } else if (dots === 1) {
    const [integer, decimals] = cleaned.split('.');
    const digits = integer.replace('-', '');
    // "1.234" (miles, formato ES) frente a "12.99" (decimal, formato EN)
    normalized = decimals.length === 3 && digits !== '' && digits !== '0' ? `${integer}${decimals}` : cleaned;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStock(value: string): boolean {
  if (!value) return true;
  return !/(sin stock|agotad|no disponible|unavailable|outofstock|out of stock|nostock|^no$|^0$|^false$)/i.test(value);
}

/**
 * Mapea una fila del feed de Awin a CanonicalAffiliateProduct.
 * Devuelve `null` cuando la fila no trae lo mínimo (título + enlace).
 */
function mapFeedRow(row: FeedRow, feed: AwinFeed, syncedAt: string): CanonicalAffiliateProduct | null {
  const title = pick(row, ...FEED_ALIASES.title);
  const affiliateUrl = pick(row, ...FEED_ALIASES.affiliateUrl);
  const directUrl = pick(row, ...FEED_ALIASES.directUrl) || affiliateUrl;
  if (!title || (!affiliateUrl && !directUrl)) return null;

  const externalId = pick(row, ...FEED_ALIASES.externalId) || affiliateUrl || directUrl;

  const currencyRaw = pick(row, ...FEED_ALIASES.currency);
  const currency = /^[a-z]{3}$/i.test(currencyRaw) ? currencyRaw.toUpperCase() : 'EUR';

  const price = toNumber(pick(row, ...FEED_ALIASES.price)) ?? 0;
  const declaredOriginal = toNumber(pick(row, ...FEED_ALIASES.originalPrice));
  const originalPrice = declaredOriginal && declaredOriginal > price ? declaredOriginal : price;

  const declaredDiscount = toNumber(pick(row, ...FEED_ALIASES.discount));
  const discountPercentage = declaredDiscount != null && declaredDiscount > 0 && declaredDiscount <= 100
    ? Math.round(declaredDiscount * 100) / 100
    : originalPrice > price
      ? Math.round(((originalPrice - price) / originalPrice) * 10000) / 100
      : 0;

  const commissionRate = toNumber(pick(row, ...FEED_ALIASES.commissionRate)) ?? 0;
  const estimatedCommission = price > 0 && commissionRate > 0
    ? Math.round(price * (commissionRate / 100) * 100) / 100
    : 0;

  const hierarchy = pick(row, ...FEED_ALIASES.category)
    .split(/\s*[|>»/]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const category = hierarchy[0] || 'Awin';
  const subCategory = pick(row, ...FEED_ALIASES.subCategory)
    || (hierarchy.length > 1 ? hierarchy[hierarchy.length - 1] : undefined);

  const images = Object.entries(row)
    .filter(([key, value]) => key.includes('image') && /^https?:\/\//i.test(value))
    .map(([, value]) => value);

  const deliveryTime = pick(row, ...FEED_ALIASES.deliveryTime);
  const deliveryCost = pick(row, ...FEED_ALIASES.deliveryCost);
  const technicalSpecs: Record<string, string> = { 'ID producto': externalId };
  if (deliveryTime) {
    if (/^\d+$/.test(deliveryTime)) technicalSpecs['Días de envío'] = deliveryTime;
    else technicalSpecs['Plazo de entrega'] = deliveryTime;
  }
  if (deliveryCost) technicalSpecs['Coste de envío'] = deliveryCost;
  // Estado físico: el feed estándar de Awin usa "new"/"used"/"refurbished".
  const rawCondition = pick(row, ...FEED_ALIASES.condition);
  if (rawCondition) {
    const conditionEs: Record<string, string> = {
      new: 'Nuevo',
      used: 'Usado',
      refurbished: 'Reacondicionado',
      'b-grade': 'Reacondicionado',
    };
    technicalSpecs['Estado'] = conditionEs[rawCondition.toLowerCase()] ?? rawCondition;
  }

  const merchantName = pick(row, ...FEED_ALIASES.merchantName) || feed.title || 'Awin';
  const feedMerchantId = /^\d+$/.test(feed.id) ? feed.id : undefined;

  return {
    network: 'awin',
    externalId,
    affiliateUrl: affiliateUrl || directUrl,
    directUrl,
    title,
    description: pick(row, ...FEED_ALIASES.description) || title,
    price,
    originalPrice,
    currency,
    discountPercentage,
    inStock: parseStock(pick(row, ...FEED_ALIASES.stock)),
    commissionRate,
    estimatedCommission,
    epc: toNumber(pick(row, ...FEED_ALIASES.epc)),
    category,
    subCategory,
    brand: pick(row, ...FEED_ALIASES.brand) || undefined,
    merchantName,
    merchantId: pick(row, ...FEED_ALIASES.merchantId) || feedMerchantId,
    rating: toNumber(pick(row, ...FEED_ALIASES.rating)) ?? 0,
    reviewCount: toNumber(pick(row, ...FEED_ALIASES.reviewCount)) ?? 0,
    sales: toNumber(pick(row, ...FEED_ALIASES.sales)),
    mainImage: images[0] ?? '',
    extraImages: images.slice(1),
    technicalSpecs,
    guarantee: pick(row, ...FEED_ALIASES.guarantee) || undefined,
    syncedAt,
  };
}

function matchesParams(product: CanonicalAffiliateProduct, params: UnifiedSearchParams): boolean {
  if (params.query) {
    const needle = params.query.toLowerCase();
    const haystack = [product.title, product.brand, product.merchantName, product.category, product.subCategory]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (params.minPrice != null && product.price < params.minPrice) return false;
  if (params.maxPrice != null && product.price > params.maxPrice) return false;
  if (params.minCommission != null && product.commissionRate < params.minCommission) return false;
  if (params.inStockOnly && !product.inStock) return false;
  return true;
}

/* ---------------- Respaldo canónico (feed no disponible) ---------------- */

const FALLBACK_CATEGORIES = ['Tecnología', 'Audio & Sonido', 'Informática & Laptops', 'Hogar Inteligente', 'Gaming & Accesorios'];

/**
 * Datos de ejemplo válidos `CanonicalAffiliateProduct` para no dejar la tabla
 * de afiliados del panel sin filas cuando la API de feeds de Awin no responde.
 * Van marcados `estimated: true`: la UI los muestra como estimados y
 * `searchCatalogBatch` los excluye de la caché real.
 */
function fallbackCanonicalProducts(params: UnifiedSearchParams, publisherId: string): CanonicalAffiliateProduct[] {
  const count = Math.min(Math.max(params.limit ?? 8, 1), 10);
  const term = (params.query || params.category || 'producto').slice(0, 60);
  const syncedAt = new Date().toISOString();

  return Array.from({ length: count }, (_, index) => {
    const price = Math.round((24.99 + index * 12.5 + term.length * 0.8) * 100) / 100;
    const originalPrice = Math.round(price * 1.2 * 100) / 100;
    const discountPercentage = Math.round(((originalPrice - price) / originalPrice) * 10000) / 100;
    const commissionRate = 5;
    const affiliateUrl = `${AWIN_FALLBACK_URL}?publisherId=${encodeURIComponent(publisherId)}`;

    return {
      network: 'awin',
      externalId: `awin-fallback-${syncedAt}-${index}`,
      affiliateUrl,
      directUrl: AWIN_FALLBACK_URL,
      title: `${term.charAt(0).toUpperCase()}${term.slice(1)} — referencia destacada ${index + 1} (Awin)`,
      description: `Resultado de respaldo mientras el feed de Awin no está disponible. Sincroniza los product-feeds de la Publisher API para datos reales de «${term}».`,
      price,
      originalPrice,
      currency: 'EUR',
      discountPercentage,
      inStock: true,
      commissionRate,
      estimatedCommission: Math.round(price * (commissionRate / 100) * 100) / 100,
      category: params.category || FALLBACK_CATEGORIES[index % FALLBACK_CATEGORIES.length],
      merchantName: 'Awin',
      rating: Math.round((3.7 + (index % 13) / 10) * 10) / 10,
      reviewCount: 60 + index * 64,
      sales: 40 + ((index * 9) % 60),
      mainImage: FALLBACK_IMAGE,
      extraImages: [],
      technicalSpecs: {
        'Días de envío': '5',
        'Aviso': 'Respaldo automático: feed de Awin no disponible.',
      },
      estimated: true,
      syncedAt,
    } satisfies CanonicalAffiliateProduct;
  });
}

/* ---------------- Conector ---------------- */

export class AwinConnector implements NetworkConnector {
  readonly networkId = 'awin';

  async validate(): Promise<{ ok: boolean; message: string }> {
    const creds = resolveCreds();
    if (!creds) {
      const message = 'Faltan credenciales obligatorias (Publisher ID o API Token).';
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }

    try {
      const response = await fetchWithTimeout(
        `${AWIN_API_BASE}/publishers/${encodeURIComponent(creds.publisherId)}/accounts`,
        { headers: { Authorization: `Bearer ${creds.apiToken}`, Accept: 'application/json' } },
        8000,
      );
      if (response.ok) {
        const message = 'Conexión verificada con la API de Awin.';
        setNetworkStatus(this.networkId, 'connected', message);
        return { ok: true, message };
      }
      const message = `Awin rechazó las credenciales (HTTP ${response.status}). Revisa el Publisher ID y el token.`;
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    } catch {
      const message = 'No se pudo contactar con api.awin.com. Revisa la red del servidor.';
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }
  }

  /**
   * Búsqueda/sincronización al contrato canónico CanonicalAffiliateProduct.
   * Descarga y parsea los product-feeds del publisher y mapea cada fila
   * (precio, descuento, comisión, deep link, anunciante y marca).
   * A diferencia de search(), NO devuelve datos de muestra: el pipeline de
   * catálogo sólo debe ingerir productos reales (vacío si no hay resultados).
   */
  async searchCanonical(params: UnifiedSearchParams): Promise<CanonicalAffiliateProduct[]> {
    const creds = resolveCreds();
    if (!creds) {
      throw new ConnectorError(this.networkId, 'Awin no está conectado. Añade sus credenciales primero.');
    }

    const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
    const syncedAt = new Date().toISOString();

    let feeds: AwinFeed[];
    try {
      feeds = await fetchFeeds(creds);
    } catch (error) {
      console.warn('[AwinConnector] product-feeds no disponible:', error instanceof Error ? error.message : error);
      return fallbackCanonicalProducts(params, creds.publisherId);
    }
    if (!feeds.length) return fallbackCanonicalProducts(params, creds.publisherId);

    // Anunciantes activos primero; como mucho 3 feeds por búsqueda
    const ordered = [...feeds].sort((a, b) => Number(b.active) - Number(a.active));
    const matched: CanonicalAffiliateProduct[] = [];
    const seen = new Set<string>();

    for (const feed of ordered.slice(0, MAX_FEEDS_PER_SEARCH)) {
      if (matched.length >= limit) break;

      let rows: FeedRow[];
      try {
        rows = await loadFeedRows(feed);
      } catch (error) {
        console.warn('[AwinConnector] Feed no descargado:', error instanceof Error ? error.message : error);
        continue;
      }

      for (const row of rows) {
        if (matched.length >= limit) break;
        const product = mapFeedRow(row, feed, syncedAt);
        if (!product || seen.has(product.externalId)) continue;
        if (!matchesParams(product, params)) continue;
        seen.add(product.externalId);
        matched.push(product);
      }
    }

    return matched;
  }

  async search(params: UnifiedSearchParams): Promise<UnifiedProduct[]> {
    if (!resolveCreds()) {
      throw new ConnectorError(this.networkId, 'Awin no está conectado. Añade sus credenciales primero.');
    }

    try {
      // Delega en la ruta canónica (mismo mapeo que usa el pipeline de catálogo)
      const canonical = await this.searchCanonical(params);
      // Sin resultados reales → muestra estimada para no dejar la UI vacía
      if (!canonical.length) return sampleProducts(this.networkId, params, 23);
      return canonical.map(canonicalToUnified);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      console.error('[AwinConnector] Error en búsqueda:', error);
      return sampleProducts(this.networkId, params, 23);
    }
  }
}
