/**
 * Proyección del catálogo para los agentes (API de automatización, alcance `catalog:read`).
 * MÍNIMO NECESARIO: nada de enlaces de afiliado ni de salida, comisiones, descripciones completas, datos de usuarios ni campos internos
 * (`extra`). Los datos de confianza (descuento verificado, valoración sustentada, stock) usan las MISMAS reglas que la web pública
 * (`commercialClaims.ts`, `stock.ts`); sólo se leen, nunca se escriben.
 */
import { ratingSupport, verifiedAtOf, captureDateOf, verifiedDiscountOf } from './commercialClaims';
import { stockOf } from './stock';

type Any = Record<string, any>;

export interface AutomationProduct {
  id: string;
  title: string;
  category: string | null;
  categoryId: string | null;
  subcategoryId: string | null;
  network: string | null;
  merchant: string | null;
  price: number | null;
  currency: 'EUR';
  /** Precio anterior DECLARADO por la fuente (no verificado). */
  declaredPreviousPrice: number | null;
  /** Descuento demostrado por una lectura verificada reciente; null si no se puede demostrar. */
  verifiedDiscount: { pct: number; previousPrice: number; asOf: string } | null;
  stock: 'in_stock' | 'low_stock' | 'out_of_stock' | 'unknown';
  rating: number | null;
  reviewsCount: number | null;
  /** «por_defecto» si el catálogo trae el valor 4,8 / 100 del alta (no es una valoración real); entonces rating y reviewsCount van a null. */
  ratingFlag: 'por_defecto' | 'recuento_por_defecto' | null;
  image: string | null;
  descriptionLength: number;
  hasAffiliateLink: boolean;
  capturedAt: string | null;
  verifiedAt: string | null;
  addedAt: string | null;
}

const text = (v: unknown, max = 300): string | null => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t.slice(0, max) : null;
};
const money = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

export function projectProduct(p: Any): AutomationProduct {
  const support = ratingSupport(p);
  const discount = verifiedDiscountOf(p);
  const hidden = support.hidden ?? '';
  return {
    id: String(p.id),
    title: String(p.title ?? '').slice(0, 300),
    category: text(p.category, 80),
    categoryId: text(p.category_id, 80),
    subcategoryId: text(p.subcategory_id, 80),
    network: text(p.network, 30),
    merchant: text(p.merchant, 80),
    price: money(p.price),
    currency: 'EUR',
    declaredPreviousPrice: money(p.originalPrice),
    verifiedDiscount: discount.verified && discount.pct !== null && discount.previousPrice !== undefined ? { pct: discount.pct, previousPrice: discount.previousPrice, asOf: discount.asOf ?? '' } : null,
    stock: stockOf(p).state,
    rating: support.rating,
    reviewsCount: support.count,
    ratingFlag: /valor_por_defecto/.test(hidden) ? 'por_defecto' : /recuento_por_defecto/.test(hidden) ? 'recuento_por_defecto' : null,
    image: text(p.image, 300),
    descriptionLength: String(p.description ?? '').trim().length,
    hasAffiliateLink: Boolean(text(p.affiliateUrl, 10)),
    capturedAt: captureDateOf(p),
    verifiedAt: verifiedAtOf(p),
    addedAt: text(p.extra?.importMeta?.importedAt, 40),
  };
}

export interface CatalogQuery {
  limit: number;
  page: number;
  category: string | null;
  network: string | null;
}

const ALLOWED = new Set(['limit', 'page', 'category', 'network']);

/** Valida la consulta. Parámetros desconocidos o repetidos → error (nada se ignora en silencio). */
export function parseCatalogQuery(search: URLSearchParams): { ok: true; query: CatalogQuery } | { ok: false; message: string } {
  const seen = new Set<string>();
  for (const [k] of search) {
    if (!ALLOWED.has(k)) return { ok: false, message: `Parámetro desconocido: ${k.slice(0, 40)}` };
    if (seen.has(k)) return { ok: false, message: `Parámetro repetido: ${k}` };
    seen.add(k);
  }
  const int = (name: string, def: number, min: number, max: number): number | null => {
    const raw = search.get(name);
    if (raw === null) return def;
    if (!/^\d{1,6}$/.test(raw)) return null;
    const n = Number(raw);
    return n >= min && n <= max ? n : null;
  };
  const limit = int('limit', 50, 1, 100);
  const page = int('page', 1, 1, 10000);
  if (limit === null) return { ok: false, message: 'limit debe ser un entero de 1 a 100' };
  if (page === null) return { ok: false, message: 'page debe ser un entero de 1 a 10000' };
  const word = (name: string): string | null | undefined => {
    const raw = search.get(name);
    if (raw === null) return null;
    return raw.length >= 1 && raw.length <= 80 && !/[\u0000-\u001f<>]/.test(raw) ? raw : undefined;
  };
  const category = word('category');
  const network = word('network');
  if (category === undefined) return { ok: false, message: 'category no válido' };
  if (network === undefined) return { ok: false, message: 'network no válido' };
  return { ok: true, query: { limit, page, category, network } };
}

const fold = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function buildCatalogPage(products: Any[], q: CatalogQuery) {
  let list = products.filter((p) => p && typeof p.id === 'string' && p.id);
  if (q.category) list = list.filter((p) => fold(p.category) === fold(q.category));
  if (q.network) list = list.filter((p) => fold(p.network) === fold(q.network));
  list = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // orden estable por id
  const total = list.length;
  const totalPages = Math.ceil(total / q.limit);
  const items = list.slice((q.page - 1) * q.limit, q.page * q.limit).map(projectProduct);
  return { total, page: q.page, limit: q.limit, totalPages, products: items };
}
