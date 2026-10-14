/**
 * ==============================================================================
 * TRADYLOR — AUDIENCIA DE MARKETING (USUARIOS DE MI RADAR)
 * ==============================================================================
 * Combina tres fuentes para la ficha de Usuario 360 del panel de Marketing:
 *
 *  1. radar-users.json  → datos declarados (nombre, hobbies, perfil, cumpleaños…)
 *  2. radar-data.json   → clics en "Comprar" (Return Flow: pending / purchased /
 *                         dismissed), productos guardados y avisos de carrito
 *  3. catálogo          → precio de cada producto (para LTV y valor de carrito)
 *
 * La captura de comportamiento (última categoría visitada, productos vistos)
 * la hace lib/radarAuth.recordRadarUserVisit() desde el middleware. Los avisos
 * de carrito se envían desde lib/marketingEmail.ts (manual o cada 24 h).
 *
 * El lead score (0-100) puntúa la intención de compra observada. NO es un
 * modelo de machine learning: son reglas explícitas, visibles en la UI.
 * ==============================================================================
 */

import { findCatalogProduct } from './catalog';
import { getAllRadarUsers } from './radarAuth';
import { getRadar } from './radarStore';
import type { PublicRadarUser } from './radarAuth';
import type { PendingExit, SavedProduct } from '../types/radar';

/** Un producto del carrito (clic de salida aún no resuelto). */
export interface CartItemMetric {
  productId: string;
  title: string;
  atISO: string;
  /** Precio actual del catálogo o del radar (0 si no se conoce). */
  value: number;
}

/** Una compra confirmada (salida resuelta como 'purchased'). */
export interface PurchaseMetric {
  productId: string;
  title: string;
  atISO: string;
  value: number;
}

/** Un producto visto en ficha que nunca se compró. */
export interface ViewedNotBoughtMetric {
  id: string;
  title: string;
  atISO: string;
}

export interface LeadScoreFactor {
  label: string;
  points: number;
}

export interface LeadScore {
  /** 0-100. */
  value: number;
  band: 'caliente' | 'tibio' | 'frio';
  factors: LeadScoreFactor[];
}

/** Ficha completa de un usuario de Mi Radar vista desde Marketing. */
export interface AudienceUser360 {
  id: string;
  email: string;
  name?: string;
  provider: string;
  createdAtISO: string;
  declared: {
    hobbies: string[];
    hobbiesOther?: string;
    profileType?: string;
    preferredCategories: string[];
    city?: string;
    country?: string;
    birthDate?: string;
  };
  behavior: {
    lastCategoryId?: string;
    lastCategoryLabel?: string;
    lastVisitAtISO?: string;
    /** Visitas acumuladas a fichas de producto (captura automática). */
    visits: number;
    /** Suma de precios de las compras confirmadas (Return Flow). */
    ltv: number;
    purchaseCount: number;
    lastPurchaseAtISO?: string;
    /** Clics en botones de salida a la tienda (comprar / afiliado). */
    affiliateClicks: number;
    dismissedCount: number;
    /** Salidas pendientes = carrito de compra abandonado. */
    cartItems: CartItemMetric[];
    cartTotal: number;
    /** % de salidas que quedaron pendientes (abandono). null sin salidas. */
    cartAbandonRatePct: number | null;
    cartReminder?: { sentAtISO: string; count: number };
    purchases: PurchaseMetric[];
    viewedNotBought: ViewedNotBoughtMetric[];
    savedCount: number;
  };
  leadScore: LeadScore;
}

export interface AudienceFilters {
  /** Busca por email o nombre. */
  q?: string;
  /** Hobby exacto (chips del perfil). */
  hobby?: string;
  /** Tipo de visitante: particular | profesional | empresa. */
  profile?: string;
  /** Lead score mínimo (0-100). */
  minScore?: number;
  /** Sólo usuarios con producto en el carrito (pendiente de compra). */
  hasCart?: boolean;
  /** Compró dentro de los últimos N días. */
  boughtDays?: number;
  /** Sin compras en los últimos N días (incluye quienes nunca compran). */
  notBoughtDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const VISIT_HOT_MS = 30 * DAY_MS;

const PROFILE_LABELS: Record<string, string> = {
  particular: 'Particular',
  profesional: 'Profesional / Autónomo',
  empresa: 'Empresa',
};

/** Etiqueta legible del tipo de visitante. */
export function profileTypeLabel(profileType?: string): string {
  if (!profileType) return 'Sin definir';
  return PROFILE_LABELS[profileType] ?? profileType;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Precio en euros: primero el radar del usuario, después el catálogo. */
function productValue(productId: string, savedById: Map<string, SavedProduct>): number {
  const saved = savedById.get(productId);
  if (saved && typeof saved.priceValue === 'number' && saved.priceValue > 0) {
    return saved.priceValue;
  }
  const catalog = findCatalogProduct(productId);
  if (catalog && typeof catalog.price === 'number' && catalog.price > 0) {
    return catalog.price;
  }
  return 0;
}

function savedProductsById(radar: ReturnType<typeof getRadar>): Map<string, SavedProduct> {
  const map = new Map<string, SavedProduct>();
  for (const project of radar.projects ?? []) {
    for (const product of project.products ?? []) {
      map.set(product.id, product);
    }
  }
  return map;
}

function computeLeadScore(input: {
  hasProfile: boolean;
  lastVisitAtMs: number | null;
  affiliateClicks: number;
  hasCart: boolean;
  purchaseCount: number;
}): LeadScore {
  const factors: LeadScoreFactor[] = [];
  if (input.hasProfile) {
    factors.push({ label: 'Perfil declarado completo (hobbies o intereses)', points: 15 });
  }
  if (input.lastVisitAtMs !== null && Date.now() - input.lastVisitAtMs <= VISIT_HOT_MS) {
    factors.push({ label: 'Actividad reciente (ficha visitada en los últimos 30 días)', points: 15 });
  }
  if (input.affiliateClicks > 0) {
    factors.push({ label: 'Clic en botón de compra (salida a tienda)', points: 25 });
  }
  if (input.hasCart) {
    factors.push({ label: 'Producto en el carrito sin comprar', points: 25 });
  }
  if (input.purchaseCount > 0) {
    factors.push({ label: 'Compra confirmada', points: 20 });
  }
  const value = Math.min(100, factors.reduce((sum, f) => sum + f.points, 0));
  const band: LeadScore['band'] = value >= 70 ? 'caliente' : value >= 40 ? 'tibio' : 'frio';
  return { value, band, factors };
}

/** Convierte un usuario + sus datos de radar en la ficha 360. */
export function buildAudienceUser360(user: PublicRadarUser): AudienceUser360 {
  const radar = getRadar(user.id);
  const savedById = savedProductsById(radar);
  const exits: PendingExit[] = radar.pendingExits ?? [];

  const cartItems: CartItemMetric[] = exits
    .filter((exit) => exit.status === 'pending')
    .map((exit) => ({
      productId: exit.productId,
      title: exit.title,
      atISO: new Date(exit.timestamp).toISOString(),
      value: productValue(exit.productId, savedById),
    }));

  const purchases: PurchaseMetric[] = exits
    .filter((exit) => exit.status === 'purchased')
    .map((exit) => ({
      productId: exit.productId,
      title: exit.title,
      atISO: new Date(exit.timestamp).toISOString(),
      value: productValue(exit.productId, savedById),
    }));

  const purchasedIds = new Set(purchases.map((p) => p.productId));
  const cartIds = new Set(cartItems.map((c) => c.productId));
  const viewedNotBought: ViewedNotBoughtMetric[] = (user.viewedProducts ?? [])
    .filter((view) => !purchasedIds.has(view.id) && !cartIds.has(view.id))
    .map((view) => ({ id: view.id, title: view.title, atISO: view.at }));

  const ltv = round2(purchases.reduce((sum, p) => sum + p.value, 0));
  const cartTotal = round2(cartItems.reduce((sum, c) => sum + c.value, 0));
  const lastPurchase = purchases.slice().sort((a, b) => b.atISO.localeCompare(a.atISO))[0];
  const lastVisitAtMs = user.lastVisitAt ? Date.parse(user.lastVisitAt) || null : null;
  const hasProfile =
    (user.hobbies?.length ?? 0) > 0 || (user.preferences?.categories?.length ?? 0) > 0;

  const leadScore = computeLeadScore({
    hasProfile,
    lastVisitAtMs,
    affiliateClicks: exits.length,
    hasCart: cartItems.length > 0,
    purchaseCount: purchases.length,
  });

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    provider: user.provider,
    createdAtISO: user.createdAt,
    declared: {
      hobbies: user.hobbies ?? [],
      hobbiesOther: user.hobbiesOther,
      profileType: user.profileType ? profileTypeLabel(user.profileType) : undefined,
      preferredCategories: user.preferences?.categories ?? [],
      city: user.city,
      country: user.country,
      birthDate: user.birthDate,
    },
    behavior: {
      lastCategoryId: user.lastCategoryId,
      lastCategoryLabel: user.lastCategoryLabel,
      lastVisitAtISO: user.lastVisitAt,
      visits: user.visitCount ?? 0,
      ltv,
      purchaseCount: purchases.length,
      lastPurchaseAtISO: lastPurchase?.atISO,
      affiliateClicks: exits.length,
      dismissedCount: exits.filter((e) => e.status === 'dismissed').length,
      cartItems,
      cartTotal,
      cartAbandonRatePct: exits.length > 0
        ? Math.round((cartItems.length / exits.length) * 100)
        : null,
      cartReminder: user.cartReminder
        ? { sentAtISO: user.cartReminder.sentAt, count: user.cartReminder.count }
        : undefined,
      purchases,
      viewedNotBought,
      savedCount: savedById.size,
    },
    leadScore,
  };
}

/** Aplica los filtros del segmentador sobre la ficha ya construida. */
export function matchesAudienceFilters(user: AudienceUser360, filters: AudienceFilters): boolean {
  const q = filters.q?.trim().toLowerCase();
  if (q) {
    const haystack = `${user.email} ${user.name ?? ''}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (filters.hobby && !user.declared.hobbies.includes(filters.hobby)) return false;
  if (filters.profile && user.declared.profileType !== profileTypeLabel(filters.profile)) {
    return false;
  }
  if (typeof filters.minScore === 'number' && user.leadScore.value < filters.minScore) {
    return false;
  }
  if (filters.hasCart !== undefined && (user.behavior.cartItems.length > 0) !== filters.hasCart) {
    return false;
  }
  if (typeof filters.boughtDays === 'number') {
    const last = user.behavior.lastPurchaseAtISO ? Date.parse(user.behavior.lastPurchaseAtISO) : null;
    if (last === null || Date.now() - last > filters.boughtDays * DAY_MS) return false;
  }
  if (typeof filters.notBoughtDays === 'number') {
    const last = user.behavior.lastPurchaseAtISO ? Date.parse(user.behavior.lastPurchaseAtISO) : null;
    if (last !== null && Date.now() - last <= filters.notBoughtDays * DAY_MS) return false;
  }
  return true;
}

/**
 * Audiencia completa de Marketing. Si llegan filtros se devuelven sólo los
 * usuarios que los cumplen (segmentador); sin filtros, todos, ordenados por
 * lead score (de más a menos caliente).
 */
export function getAudience360(filters?: AudienceFilters): AudienceUser360[] {
  const users = getAllRadarUsers()
    .map(buildAudienceUser360)
    .filter((user) => (filters ? matchesAudienceFilters(user, filters) : true))
    .sort((a, b) => b.leadScore.value - a.leadScore.value);
  return users;
}

/** Extrae los filtros del query string de la API (?q=…&hasCart=1…). */
export function parseAudienceFilters(url: URL): AudienceFilters {
  const params = url.searchParams;
  const num = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return undefined;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : undefined;
  };
  const filters: AudienceFilters = {
    q: params.get('q') ?? undefined,
    hobby: params.get('hobby') ?? undefined,
    profile: params.get('profile') ?? undefined,
    minScore: num('minScore'),
    hasCart: params.get('hasCart') === '1' ? true : params.get('hasCart') === '0' ? false : undefined,
    boughtDays: num('boughtDays'),
    notBoughtDays: num('notBoughtDays'),
  };
  // Limpia claves vacías para no filtrar por ''.
  for (const key of Object.keys(filters) as Array<keyof AudienceFilters>) {
    if (filters[key] === undefined || filters[key] === '') delete filters[key];
  }
  return filters;
}
