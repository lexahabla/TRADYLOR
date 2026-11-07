/**
 * ==============================================================================
 * TREIDILOR — ADAPTADOR DEL ACTOR APIFY «hypebridge/temu-scraper» AL MODELO DE IMPORTACIÓN JSON
 * ==============================================================================
 * Esquema de salida consultado en el build público del actor (id 2CKn7F7pA4eH2mVRm, v0.2.13, 7-nov-2026):
 * `goodsId`, `title`, `price`/`priceText`, `marketPrice`, `currency` (ISO), `discountPercentage`, `imageUrl`,
 * `galleryImages[]`, `rating`, `reviewCount`, `inStock`, `mallId`/`mallName`, `skus[]`, `specifications{}`, `description`,
 * `highlights[]`, `categoryPath`, `shippingFeeText`, `estimatedDelivery`, `dealInfo`, `productUrl`, `sourcePageType`,
 * `sourceUrl`, `enrichError`, `extractedAt`. Funciones puras: sin red, sin ficheros y sin IA. NO inventa datos.
 *
 * Reglas (todas con prueba):
 *  - Moneda: sólo la que declara el actor (ISO). Si no es EUR → REVISIÓN (`moneda_no_euro`): no se convierte ni se asume
 *    mercado español. Un prefijo de mercado en la URL distinto de /es/ también va a revisión. VERIFICADO con ejecuciones reales
 *    (7-nov-2026): una URL sin prefijo devuelve el mercado de EE. UU. en USD; con /es/ devuelve EUR y títulos en español.
 *  - Precio «desde» (texto «desde/from/+»), precio que varía entre variantes, oferta relámpago y descuentos con cupón/código
 *    → REVISIÓN: nunca se presentan como precio final garantizado.
 *  - Las variantes (`skus`) no se importan como fichas (una ficha = una variante): se avisa de cuántas hay; no heredan el
 *    precio principal. Las imágenes propias de cada SKU no se mezclan con las del producto.
 *  - Envío: sólo «gratis» si el texto lo afirma sin condiciones; si no, queda desconocido (el texto se conserva).
 *  - Enlaces: `url` = enlace de ORIGEN (Temu). `affiliateUrl` sólo se rellena con el enlace corto de afiliado que el usuario pegó (ctx.affiliateUrl); Apify no da enlace de afiliado.
 *  - Identidad: plataforma `temu` + `goodsId`. No se compara con Amazon por título ni imagen (lo decide el motor).
 *  - Categoría: sólo si UNA categoría raíz del catálogo encaja claramente; si no, vacía (revisión `sin_categoria`).
 * ==============================================================================
 */
import type { AdaptContext, ImportMeta } from './apifyAmazon';

type Any = Record<string, unknown>;

const asObject = (v: unknown): Any => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Any) : {});
const text = (v: unknown, max = 300): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const money = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** ¿Es un elemento del dataset del actor de Temu de Apify? (`goodsId` + URL de Temu o campo propio de su esquema). */
export function isApifyTemuItem(raw: unknown): boolean {
  const o = asObject(raw);
  if (typeof o.goodsId !== 'string' && typeof o.goodsId !== 'number') return false;
  const url = text(o.productUrl ?? o.sourceUrl, 600);
  return /(^|\/\/|\.)temu\.com/i.test(url) || ['sourcePageType', 'salesTip', 'skus', 'mallId', 'categoryPath', 'enrichError'].some((k) => k in o);
}

const FROM_PRICE = /(\bfrom\b|\bdesde\b|\bab\b|\bà partir\b|\bda\b\s*[\d€]|\+\s*$)/i;
const CONDITIONAL_DISCOUNT = /(coupon|cup[oó]n|code|c[oó]digo|promo\s*code|with\s+code|con\s+c[oó]digo|new\s+(user|customer)|nuevo\s+usuario|first\s+order|primer\s+pedido|min\.?\s*(spend|order)|on orders? over)/i;
const FREE_SHIPPING = /(free\s+(standard\s+)?shipping|env[ií]o\s+gratis(uito)?|livraison\s+gratuite|kostenloser\s+versand)/i;
const UNCONDITIONAL_SHIPPING = /(on all orders|en todos los pedidos|en todas las compras|sin m[ií]nimo)/i;
const SHIPPING_CONDITION = /(over|above|min|from|when|if|orders?|pedidos?|compras?|superior|a partir|desde|m[aá]s de|m[ií]nimo|\d)/i;

function marketOf(url: string): string {
  try {
    const m = new URL(url).pathname.toLowerCase().match(/^\/([a-z]{2})(?:-[a-z]{2})?(?:\/|$)/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function images(item: Any): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (v: unknown) => {
    const url = typeof v === 'string' ? v.trim() : '';
    if (!url.startsWith('https://') || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };
  add(item.imageUrl);
  if (Array.isArray(item.galleryImages)) item.galleryImages.forEach(add);
  return out.slice(0, 12);
}

function specsOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const o = asObject(value);
  for (const [k, v] of Object.entries(o)) {
    const key = text(k, 80);
    const val = text(v, 300);
    if (!key || !val || /^(unknown|n\/a|none|ninguno)$/i.test(val)) continue;
    out[key] = val;
    if (Object.keys(out).length >= 60) break;
  }
  return out;
}

export function adaptApifyTemuItem(rawInput: unknown, ctx: AdaptContext = {}): Any {
  const item = asObject(rawInput);
  const meta: ImportMeta = { warnings: ['origen_apify_temu_scraper', 'enlace_de_origen_sin_afiliar'], review: [], errors: [] };
  const goodsId = text(item.goodsId, 24);
  const title = text(item.title, 300);
  if (!/^\d{6,20}$/.test(goodsId)) meta.errors.push('goods_id_invalido');
  const actorError = text(item.errorDescription ?? item.error ?? item.errorMessage, 200);
  if (actorError) meta.errors.push(`apify_error: ${actorError}`);

  // Enlace de origen: el canónico del actor; sólo si falta se construye desde el id (con aviso).
  let url = text(item.productUrl, 600);
  if (!/^https:\/\/([a-z0-9-]+\.)*temu\.com\//i.test(url)) {
    url = /^\d{6,20}$/.test(goodsId) ? `https://www.temu.com/-g-${goodsId}.html` : '';
    if (url) meta.warnings.push('url_construida_desde_goods_id');
  }

  // ── Moneda y mercado ──
  const currencyRaw = text(item.currency, 8).toUpperCase();
  const currency = /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : '';
  if (!currency) meta.errors.push('moneda_ausente_no_se_asume');
  else if (currency !== 'EUR') meta.review.push(`moneda_no_euro:${currency}`);
  const market = marketOf(text(item.sourceUrl, 600)) || marketOf(text(item.productUrl, 600));
  // EUR + prefijo /es/ en la URL de origen = mercado español comprobado; EUR sin prefijo no lo demuestra (también es la moneda de DE/FR/IT…).
  if (currency === 'EUR' && market !== 'es') meta.warnings.push('mercado_espana_no_verificable_por_la_moneda');
  if (market && market !== 'es') meta.review.push(`mercado_distinto_de_espana:${market}`);

  // ── Precio: sólo el que el actor da como actual; «desde», variable o condicionado → revisión ──
  const price = money(item.price);
  const priceText = text(item.priceText, 60);
  if (price !== undefined && FROM_PRICE.test(priceText)) meta.review.push('precio_desde');
  const skus = Array.isArray(item.skus) ? item.skus.map(asObject) : [];
  const skuPrices = [...new Set(skus.map((s) => money(s.price)).filter((n): n is number => n !== undefined))].sort((a, b) => a - b);
  if (skuPrices.length > 1) meta.review.push(`precio_varia_segun_variante:${skuPrices[0]}-${skuPrices[skuPrices.length - 1]}`);
  else if (skuPrices.length === 1 && price !== undefined && Math.abs(skuPrices[0] - price) > 0.005) meta.review.push(`precio_distinto_en_variante:${price}/${skuPrices[0]}`);
  const deal = asObject(item.dealInfo);
  const flash = deal.isFlashSale === true;
  if (flash) meta.review.push('precio_promocional_temporal');
  const promoText = [item.discountText, item.savingsText, ...(Array.isArray(item.tags) ? item.tags : [])].map((x) => text(x, 120)).join(' ');
  if (CONDITIONAL_DISCOUNT.test(promoText)) meta.review.push('descuento_condicionado');
  const marketPrice = money(item.marketPrice);
  // El precio de referencia de Temu es una referencia del comercio, no un precio anterior verificado.
  const originalPrice = price !== undefined && marketPrice !== undefined && marketPrice > price && !flash ? marketPrice : undefined;
  if (originalPrice !== undefined) meta.warnings.push('precio_anterior_es_referencia_de_temu');

  if (item.enrichError === true) meta.warnings.push('detalle_no_disponible_solo_datos_de_listado');
  else if (!skus.length && !Object.keys(asObject(item.specifications)).length) meta.warnings.push('ficha_de_listado_sin_detalle');
  if (/(^|\s)\*(\s|$)/.test(title)) meta.warnings.push('titulo_con_terminos_enmascarados_por_temu');

  // Variantes: sin ficha propia; no heredan el precio principal.
  if (skus.length > 1) meta.warnings.push(`variantes_no_importadas:${skus.length}`);

  // ── Envío: «gratis» sólo si se afirma sin condiciones ──
  const shippingText = [text(item.shippingFeeText, 100), text(item.estimatedDelivery, 60)].filter(Boolean).join(' · ');
  const fee = text(item.shippingFeeText, 100);
  const shipping: Any = {};
  if (fee && FREE_SHIPPING.test(fee) && !SHIPPING_CONDITION.test(fee.replace(UNCONDITIONAL_SHIPPING, ''))) shipping.free = true;
  if (shippingText) shipping.text = shippingText.slice(0, 160);

  const availability = typeof item.inStock === 'boolean' ? (item.stockQuantity === 0 ? false : item.inStock) : undefined;
  const specs = specsOf(item.specifications);
  const brandSpec = Object.entries(specs).find(([k]) => /^brand$/i.test(k))?.[1];
  const brand = brandSpec && !/^\*+$/.test(brandSpec) ? brandSpec : undefined;

  const category = (() => {
    if (!ctx.resolveCategory) return undefined;
    const found = ctx.resolveCategory(`${text(item.categoryPath, 300)} ${text(item.categoryName, 100)} ${title}`);
    if (found.name) return found.name;
    meta.warnings.push(found.ambiguous ? 'categoria_ambigua' : 'categoria_no_determinada');
    return undefined;
  })();

  const highlights = Array.isArray(item.highlights) ? item.highlights.map((h) => text(h, 300)).filter(Boolean) : [];
  const description = text(item.description, 5000) || highlights.join(' · ').slice(0, 5000) || text(item.shortDescription, 600) || undefined;
  const rating = Number(item.rating);
  const reviews = Number(item.reviewCount);
  const capturedAt = text(item.extractedAt, 40) || ctx.capturedAt;

  // Enlace de afiliado (el enlace corto que pegó el usuario): sólo si pertenece a ESTE producto; el de origen sigue siendo /es/-g-<id>.
  const affiliateUrl = ctx.affiliateUrl && ctx.affiliateGoodsId === goodsId ? ctx.affiliateUrl : undefined;
  if (affiliateUrl) {
    meta.warnings = meta.warnings.filter((w) => w !== 'enlace_de_origen_sin_afiliar');
    meta.warnings.push('enlace_de_afiliado_corto_de_temu');
  }

  const offer: Any = {
    platform: 'temu',
    externalId: goodsId || undefined,
    url,
    affiliateUrl,
    price,
    currency: currency || undefined,
    originalPrice,
    sellerName: text(item.mallName, 120) || undefined,
    sellerId: text(item.mallId, 80) || undefined,
    availability,
    shipping: Object.keys(shipping).length ? shipping : undefined,
    capturedAt,
  };
  for (const k of Object.keys(offer)) if (offer[k] === undefined) delete offer[k];

  const product: Any = {
    title,
    brand,
    category,
    description,
    images: images(item),
    specs,
    rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    reviewsCount: Number.isFinite(reviews) && reviews >= 0 ? reviews : undefined,
  };
  for (const k of Object.keys(product)) if (product[k] === undefined) delete product[k];

  return { product, variant: {}, offer, __import: meta };
}
