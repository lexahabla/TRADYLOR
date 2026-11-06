/**
 * ==============================================================================
 * TREIDILOR — FILTROS DEL CATÁLOGO: ATRIBUTOS NORMALIZADOS, OFERTAS Y FACETAS
 * ==============================================================================
 * Una sola regla para API, JSON individual y JSON masivo: los filtros se
 * calculan SIEMPRE a partir de los productos publicados (`getCatalogProducts`),
 * no de la fuente de importación.
 *
 *  - Marca (fabricante) vía `normalizeBrand`; plataforma y vendedor quedan
 *    aparte (ofertas) y NO hay filtro de tienda.
 *  - Atributos técnicos como valores estructurados `{key, type, value, unit}`:
 *    `1 TB` ≡ `1000 GB`; ausente ≠ falso ≠ cero.
 *  - Condiciones comerciales (precio, envío, plazo) se evalúan sobre UNA misma
 *    oferta válida; un dato desconocido NO cuenta como 0.
 *  - Los recuentos son de productos ÚNICOS (un producto con dos ofertas cuenta
 *    una vez) y cada faceta se cuenta con el resto de filtros aplicados
 *    (patrón «faceta disyuntiva»), conservando las selecciones activas.
 *  - Mismo filtro: O (cualquiera de los valores). Filtros distintos: Y.
 *
 * Funciones puras: no leen disco; al cambiar el catálogo basta recalcular.
 * ==============================================================================
 */

import { normalizeBrand } from './offerIdentity';
import { freshnessOf, DEFAULT_MAX_AGE_HOURS, type OfferObservation } from './offerObservations';

type AnyRecord = Record<string, any>;
export type FacetProduct = AnyRecord;

/* ───────────────────────────── ATRIBUTOS ───────────────────────────── */

export type AttrType = 'number' | 'text' | 'boolean';
export type AttrSource = 'provider' | 'ai' | 'manual' | 'unknown';

export interface AttrValue {
  /** Clave canónica del atributo (p. ej. 'almacenamiento'). */
  key: string;
  type: AttrType;
  /** Número en la unidad base, texto normalizado o booleano. */
  value: number | string | boolean;
  /** Unidad base del número ('GB', 'g', 'mAh', 'in', 'W', 'mm', 'h'). */
  unit?: string;
  /** Texto original (para mostrar en la ficha). */
  raw: string;
  source: AttrSource;
}

/** Sinónimos de nombres de atributo → clave canónica. */
const ATTR_ALIASES: Record<string, string> = {
  almacenamiento: 'almacenamiento', capacidad: 'almacenamiento', 'capacidad de almacenamiento': 'almacenamiento', storage: 'almacenamiento', 'memoria interna': 'almacenamiento',
  ram: 'ram', 'memoria ram': 'ram', memory: 'ram',
  peso: 'peso', weight: 'peso', 'peso del producto': 'peso',
  bateria: 'bateria', 'capacidad de la bateria': 'bateria', battery: 'bateria', 'capacidad de bateria': 'bateria',
  pantalla: 'pantalla', 'tamano de pantalla': 'pantalla', 'tamano de la pantalla': 'pantalla', 'screen size': 'pantalla',
  potencia: 'potencia', power: 'potencia', wattage: 'potencia', 'potencia de salida': 'potencia',
  autonomia: 'autonomia', 'duracion de la bateria': 'autonomia', 'horas de reproduccion': 'autonomia',
  color: 'color', colour: 'color',
  conectividad: 'conectividad', 'tecnologia de conectividad': 'conectividad', connectivity: 'conectividad',
  resolucion: 'resolucion', resolution: 'resolucion',
  material: 'material',
  'cancelacion de ruido': 'cancelacion-ruido', anc: 'cancelacion-ruido',
  impermeable: 'impermeable', 'resistente al agua': 'impermeable',
};

const UNITS: Record<string, { base: string; factor: number }> = {
  tb: { base: 'GB', factor: 1000 }, gb: { base: 'GB', factor: 1 }, mb: { base: 'GB', factor: 0.001 },
  kg: { base: 'g', factor: 1000 }, g: { base: 'g', factor: 1 }, gr: { base: 'g', factor: 1 }, mg: { base: 'g', factor: 0.001 },
  mah: { base: 'mAh', factor: 1 }, ah: { base: 'mAh', factor: 1000 },
  w: { base: 'W', factor: 1 }, kw: { base: 'W', factor: 1000 },
  mm: { base: 'mm', factor: 1 }, cm: { base: 'mm', factor: 10 }, m: { base: 'mm', factor: 1000 },
  h: { base: 'h', factor: 1 }, horas: { base: 'h', factor: 1 }, hora: { base: 'h', factor: 1 }, min: { base: 'h', factor: 1 / 60 },
  in: { base: 'in', factor: 1 }, pulgadas: { base: 'in', factor: 1 }, '"': { base: 'in', factor: 1 }, pulg: { base: 'in', factor: 1 },
  hz: { base: 'Hz', factor: 1 }, khz: { base: 'Hz', factor: 1000 },
};

const TRUE_WORDS = new Set(['si', 'sí', 'yes', 'true', 'verdadero', 'incluido', 'incluye']);
const FALSE_WORDS = new Set(['no', 'false', 'falso', 'no incluido']);

const fold = (v: string): string =>
  v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function canonicalAttrKey(name: string): string {
  const folded = fold(name).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return ATTR_ALIASES[folded] ?? folded.replace(/ /g, '-');
}

/**
 * Normaliza un atributo. Devuelve null cuando NO hay dato (vacío, '—', 'n/d'):
 * ausencia ≠ falso ≠ cero.
 */
export function normalizeAttribute(name: string, rawValue: unknown, source: AttrSource = 'unknown'): AttrValue | null {
  if (rawValue === null || rawValue === undefined) return null;
  const raw = String(rawValue).trim();
  if (!raw || /^(—|-|–|n\/?d|n\/?a|desconocido|null|undefined)$/i.test(raw)) return null;
  const key = canonicalAttrKey(name);
  if (!key) return null;

  if (typeof rawValue === 'boolean') return { key, type: 'boolean', value: rawValue, raw, source };
  const folded = fold(raw);
  if (TRUE_WORDS.has(folded)) return { key, type: 'boolean', value: true, raw, source };
  if (FALSE_WORDS.has(folded)) return { key, type: 'boolean', value: false, raw, source };

  // Número + unidad: «1 TB», «1,5 kg», «6.7"», «5000 mAh». El 0 es un valor real.
  const match = folded.match(/^(\d+(?:[.,]\d+)?)\s*("|[a-z]+)?/);
  if (match) {
    const num = Number(match[1].replace(',', '.'));
    const unitKey = (match[2] ?? '').toLowerCase();
    if (Number.isFinite(num)) {
      const unit = UNITS[unitKey];
      if (unit) return { key, type: 'number', value: Math.round(num * unit.factor * 1000) / 1000, unit: unit.base, raw, source };
      if (!unitKey) return { key, type: 'number', value: num, raw, source };
    }
  }
  return { key, type: 'text', value: folded, raw, source };
}

/** Atributos estructurados de un producto (specs + estado + marca/modelo). */
export function productAttributes(product: FacetProduct): AttrValue[] {
  const specSource = String((product.extra?.fieldSources as AnyRecord | undefined)?.specs ?? '');
  const source: AttrSource = specSource.includes('provider') ? 'provider' : specSource === 'ai' ? 'ai' : 'unknown';
  const out: AttrValue[] = [];
  const seen = new Set<string>();
  const push = (value: AttrValue | null) => {
    if (!value || seen.has(value.key)) return;
    seen.add(value.key);
    out.push(value);
  };
  for (const [name, value] of Object.entries((product.specs ?? {}) as AnyRecord)) push(normalizeAttribute(name, value, source));
  // Campos anidados de la red conservados en `extra` (MPN, GTIN, etc. no filtran).
  const extra = (product.extra ?? {}) as AnyRecord;
  push(normalizeAttribute('estado', product.condition ?? extra['Estado'], 'provider'));
  return out;
}

/* ───────────────────────────── OFERTAS ───────────────────────────── */

export interface FacetOffer {
  key: string;
  network: string;
  price: number | null;
  currency: string;
  /** null = desconocido (no es «sin stock»). */
  inStock: boolean | null;
  /** null = desconocido; 0 = gratis. */
  shippingCost: number | null;
  deliveryMaxDays: number | null;
  /** false si la lectura superó la antigüedad máxima. */
  current: boolean;
}

/** Ofertas de un producto: la principal (con su última observación) y las de otras redes. */
export function offersOf(product: FacetProduct, now: Date = new Date(), maxAgeHours = DEFAULT_MAX_AGE_HOURS): FacetOffer[] {
  const extra = (product.extra ?? {}) as AnyRecord;
  const observations: OfferObservation[] = Array.isArray(extra.observations) ? extra.observations : [];
  const last = observations[observations.length - 1];
  const verifiedAt: string | undefined = extra.refresh?.lastVerifiedAt;
  const current = verifiedAt ? freshnessOf(verifiedAt, maxAgeHours, now) !== 'stale' : true;
  const network = String(product.network ?? '').toLowerCase() || 'desconocida';

  const primary: FacetOffer = {
    key: `${network}:${product.sourceId ?? product.asin ?? product.id}`,
    network,
    price: Number.isFinite(Number(product.price)) && Number(product.price) > 0 ? Number(product.price) : null,
    currency: String(last?.context?.currency ?? product.currency ?? 'EUR').toUpperCase(),
    inStock: typeof product.inStock === 'boolean' ? product.inStock : last?.inStock ?? null,
    shippingCost: last?.shippingCost ?? (product.freeShipping === true ? 0 : null),
    deliveryMaxDays: last?.deliveryMaxDays ?? (Number.isFinite(Number(product.shippingDays)) ? Number(product.shippingDays) : null),
    current,
  };
  const offers = [primary];

  const cross = extra.crossMerchant as AnyRecord | undefined;
  if (cross?.prices && typeof cross.prices === 'object') {
    for (const [net, price] of Object.entries(cross.prices as AnyRecord)) {
      if (String(net).toLowerCase() === network) continue;
      const p = Number(price);
      offers.push({
        key: `${String(net).toLowerCase()}:${product.id}`,
        network: String(net).toLowerCase(),
        price: Number.isFinite(p) && p > 0 ? p : null,
        currency: String((cross.currencies as AnyRecord | undefined)?.[net] ?? 'EUR').toUpperCase(),
        inStock: null,
        shippingCost: null,
        deliveryMaxDays: null,
        current: true,
      });
    }
  }
  return offers;
}

/* ───────────────────────────── FILTROS ───────────────────────────── */

export interface Selections {
  brand?: string[];
  /** Valores de atributos técnicos: { almacenamiento: [1000, 512], color: ['negro'] }. */
  attrs?: Record<string, Array<string | number | boolean>>;
  /** Condiciones comerciales: deben cumplirse JUNTAS en una misma oferta. */
  minPrice?: number;
  maxPrice?: number;
  maxShippingCost?: number;
  maxDeliveryDays?: number;
  onlyInStock?: boolean;
  currency?: string;
}

export interface FacetContext {
  now?: Date;
  maxAgeHours?: number;
}

const hasCommercial = (s: Selections): boolean =>
  s.minPrice != null || s.maxPrice != null || s.maxShippingCost != null || s.maxDeliveryDays != null || s.onlyInStock === true;

/** ¿La oferta cumple TODAS las condiciones comerciales activas? Desconocido no cuenta como 0. */
export function offerMatches(offer: FacetOffer, s: Selections): boolean {
  if (!offer.current) return false; // lectura caducada: no es oferta vigente
  if (offer.price == null) return !hasCommercial(s); // sin precio no cumple ninguna condición comercial
  if (s.currency && offer.currency !== s.currency.toUpperCase()) return false;
  if (s.minPrice != null && offer.price < s.minPrice) return false;
  if (s.maxPrice != null && offer.price > s.maxPrice) return false;
  if (s.maxShippingCost != null && (offer.shippingCost == null || offer.shippingCost > s.maxShippingCost)) return false;
  if (s.maxDeliveryDays != null && (offer.deliveryMaxDays == null || offer.deliveryMaxDays > s.maxDeliveryDays)) return false;
  if (s.onlyInStock === true && offer.inStock !== true) return false;
  return true;
}

type Facet = 'brand' | `attr:${string}` | 'commercial';

function matchesFacet(product: FacetProduct, s: Selections, facet: Facet, ctx: FacetContext, attrs: AttrValue[]): boolean {
  if (facet === 'brand') {
    if (!s.brand?.length) return true;
    const key = normalizeBrand(product.brand).key;
    return key !== '' && s.brand.map((b) => normalizeBrand(b).key).includes(key);
  }
  if (facet === 'commercial') {
    if (!hasCommercial(s) && !s.currency) return true;
    return offersOf(product, ctx.now, ctx.maxAgeHours).some((offer) => offerMatches(offer, s));
  }
  const key = facet.slice(5);
  const wanted = s.attrs?.[key];
  if (!wanted?.length) return true;
  const own = attrs.find((a) => a.key === key);
  if (!own) return false; // ausente nunca coincide con un valor concreto
  return wanted.some((w) => String(w).toLowerCase() === String(own.value).toLowerCase());
}

function facetsOf(s: Selections): Facet[] {
  return ['brand', 'commercial', ...Object.keys(s.attrs ?? {}).map((k) => `attr:${k}` as Facet)];
}

function passes(product: FacetProduct, s: Selections, ctx: FacetContext, skip?: Facet): boolean {
  const attrs = productAttributes(product);
  return facetsOf(s).every((facet) => facet === skip || matchesFacet(product, s, facet, ctx, attrs));
}

/** Aplica todas las selecciones: O dentro de un filtro, Y entre filtros. */
export function applyFilters<T extends FacetProduct>(products: T[], s: Selections, ctx: FacetContext = {}): T[] {
  return products.filter((p) => passes(p, s, ctx));
}

/* ───────────────────────────── FACETAS ───────────────────────────── */

export interface FacetOption {
  value: string | number | boolean;
  label: string;
  count: number;
  selected: boolean;
}

export interface FacetGroup {
  key: string;
  label: string;
  type: AttrType | 'brand';
  unit?: string;
  options: FacetOption[];
}

/** Atributos pertinentes por categoría (clave de categoría normalizada). */
export const FACET_CONFIG: Record<string, string[]> = {
  auriculares: ['conectividad', 'autonomia', 'cancelacion-ruido', 'impermeable', 'color'],
  portatiles: ['ram', 'almacenamiento', 'pantalla', 'peso'],
  informatica: ['ram', 'almacenamiento', 'pantalla'],
  moviles: ['ram', 'almacenamiento', 'pantalla', 'bateria'],
  tecnologia: ['almacenamiento', 'ram', 'pantalla', 'bateria', 'conectividad'],
  almacenamiento: ['almacenamiento', 'conectividad'],
};

const ATTR_LABELS: Record<string, string> = {
  almacenamiento: 'Almacenamiento', ram: 'RAM', peso: 'Peso', bateria: 'Batería', pantalla: 'Pantalla', potencia: 'Potencia', autonomia: 'Autonomía',
  color: 'Color', conectividad: 'Conectividad', resolucion: 'Resolución', material: 'Material', 'cancelacion-ruido': 'Cancelación de ruido', impermeable: 'Impermeable', estado: 'Estado',
};

/** Regla automática cuando la categoría no tiene configuración: atributos presentes en ≥ 30 % con ≥ 2 valores. */
const AUTO_MIN_COVERAGE = 0.3;

export function relevantAttributes(products: FacetProduct[], categoryKey: string | undefined): string[] {
  const hasEstado = products.some((p) => productAttributes(p).some((a) => a.key === 'estado'));
  const withEstado = (list: string[]) => (hasEstado ? [...list, 'estado'] : list);
  const configured = categoryKey ? FACET_CONFIG[fold(categoryKey).replace(/[^a-z]/g, '')] : undefined;
  if (configured) return withEstado(configured);
  const coverage = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const product of products) {
    for (const attr of productAttributes(product)) {
      if (attr.key === 'estado') continue;
      counts.set(attr.key, (counts.get(attr.key) ?? 0) + 1);
      (coverage.get(attr.key) ?? coverage.set(attr.key, new Set()).get(attr.key)!).add(String(attr.value));
    }
  }
  return withEstado(
    [...counts.entries()]
      .filter(([key, n]) => n / Math.max(1, products.length) >= AUTO_MIN_COVERAGE && (coverage.get(key)?.size ?? 0) >= 2)
      .map(([key]) => key),
  );
}

/**
 * Opciones y recuentos de cada faceta a partir de los productos publicados.
 * Cada grupo se cuenta con el resto de filtros aplicados (no el suyo) y las
 * selecciones activas se conservan aunque su recuento sea 0.
 */
export function buildFacets(
  products: FacetProduct[],
  s: Selections = {},
  opts: FacetContext & { categoryKey?: string } = {},
): { total: number; groups: FacetGroup[] } {
  const ctx: FacetContext = { now: opts.now, maxAgeHours: opts.maxAgeHours };
  const attrKeys = relevantAttributes(products, opts.categoryKey);
  const effective: Selections = { ...s, attrs: { ...(s.attrs ?? {}) } };
  for (const key of attrKeys) effective.attrs![key] ??= [];
  // Las claves vacías no filtran pero permiten calcular su faceta.
  const selectedAttrs = (key: string) => (s.attrs?.[key] ?? []).map((v) => String(v).toLowerCase());

  const groups: FacetGroup[] = [];

  // MARCA (fabricante). Variantes de escritura → una sola opción; marcas distintas, opciones distintas.
  {
    const counts = new Map<string, { label: string; count: number }>();
    for (const product of products) {
      if (!passes(product, effective, ctx, 'brand')) continue;
      const brand = normalizeBrand(product.brand);
      if (!brand.key) continue;
      const entry = counts.get(brand.key) ?? { label: brand.display, count: 0 };
      entry.count++;
      counts.set(brand.key, entry);
    }
    const selected = new Set((s.brand ?? []).map((b) => normalizeBrand(b).key));
    for (const key of selected) if (key && !counts.has(key)) counts.set(key, { label: key, count: 0 });
    groups.push({
      key: 'brand',
      label: 'Marca',
      type: 'brand',
      options: [...counts.entries()]
        .map(([key, v]) => ({ value: key, label: v.label, count: v.count, selected: selected.has(key) }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'es')),
    });
  }

  // ATRIBUTOS pertinentes de la categoría.
  for (const key of attrKeys) {
    const counts = new Map<string, { value: string | number | boolean; label: string; count: number; unit?: string; type: AttrType }>();
    for (const product of products) {
      if (!passes(product, effective, ctx, `attr:${key}`)) continue;
      const attr = productAttributes(product).find((a) => a.key === key);
      if (!attr) continue; // ausente no genera opción
      const id = String(attr.value).toLowerCase();
      const entry = counts.get(id) ?? { value: attr.value, label: attr.type === 'number' ? `${attr.value}${attr.unit ? ' ' + attr.unit : ''}` : attr.raw, count: 0, unit: attr.unit, type: attr.type };
      entry.count++;
      counts.set(id, entry);
    }
    if (!counts.size) continue;
    const selected = new Set(selectedAttrs(key));
    for (const id of selected) if (!counts.has(id)) counts.set(id, { value: id, label: id, count: 0, type: 'text' });
    const first = [...counts.values()][0];
    groups.push({
      key,
      label: ATTR_LABELS[key] ?? key,
      type: first.type,
      unit: first.unit,
      options: [...counts.entries()]
        .map(([id, v]) => ({ value: v.value, label: v.label, count: v.count, selected: selected.has(id) }))
        .sort((a, b) => (typeof a.value === 'number' && typeof b.value === 'number' ? a.value - b.value : b.count - a.count)),
    });
  }

  return { total: applyFilters(products, effective, ctx).length, groups };
}
