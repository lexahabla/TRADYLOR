/**
 * ==============================================================================
 * TREIDILOR — ADAPTADOR DEL ACTOR APIFY «junglee/Amazon-crawler» AL MODELO DE IMPORTACIÓN JSON
 * ==============================================================================
 * Convierte cada elemento del dataset del actor (campos reales de su esquema de salida: `asin`, `title`, `url`,
 * `price{value,currency}`, `listPrice`, `seller{name}`, `highResolutionImages`, `productOverview[]`, `attributes[]`,
 * `variantAttributes[]`, `variantDetails[]`, `inStock`, `stars`, `reviewsCount`, `breadCrumbs`…) en el registro anidado
 * (`product` / `variant` / `offer`) que ya entiende el motor de importación JSON. Funciones puras: sin red, sin ficheros
 * y sin IA. NO inventa datos: lo que el actor no aporta queda desconocido.
 *
 * Reglas (todas con prueba):
 *  - La oferta principal sale de `price` + `seller` aunque `offers` esté vacío.
 *  - Moneda: símbolo del actor (€ £ $) → ISO; si falta, se deduce del dominio de la URL (aviso); nunca se asume.
 *  - Envío desconocido ≠ gratis: `shippingPrice` nulo deja coste y «gratis» en desconocido.
 *  - Las variantes de `variantDetails` NO reciben el precio principal (no traen precio): no se importan; se avisa.
 *  - Sólo las imágenes del propio producto (`highResolutionImages`; si faltan, `thumbnailImage`). Nunca las de
 *    `aPlusContent`, `brandStory` ni las de otras variantes.
 *  - Contradicciones entre título, atributos y variante (RAM, almacenamiento, pantalla, procesador) → el registro va a
 *    REVISIÓN con el motivo; no se elige ni se corrige ningún valor.
 *  - Categoría: sólo si UNA categoría raíz del catálogo encaja claramente; si no, queda vacía (revisión `sin_categoria`).
 *  - Los elementos con error del actor (`errorDescription`/`error`) se rechazan con ese motivo.
 * ==============================================================================
 */

type Any = Record<string, unknown>;

export interface AdaptContext {
  /** Cuándo obtuvo el actor los datos (fin de la ejecución). Sin ella, la captura se infiere (aviso). */
  capturedAt?: string;
  /** Categoría del catálogo para un texto (título + migas). `ambiguous` = varias categorías igual de probables. */
  resolveCategory?: (text: string) => { name?: string; ambiguous?: boolean };
  /** Identificación de la ejecución de Apify (trazabilidad; no se guarda en el catálogo). */
  runId?: string;
}

export interface ImportMeta {
  warnings: string[];
  review: string[];
  errors: string[];
}

const asObject = (v: unknown): Any => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Any) : {});
const text = (v: unknown, max = 300): string => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** ¿Es un elemento del dataset del actor de Amazon de Apify? (ASIN + algún campo propio de su esquema). */
export function isApifyAmazonItem(raw: unknown): boolean {
  const o = asObject(raw);
  if (typeof o.asin !== 'string' && typeof o.originalAsin !== 'string') return false;
  return ['highResolutionImages', 'variantDetails', 'bestsellerRanks', 'unNormalizedProductUrl', 'productOverview', 'aPlusContent', 'galleryThumbnails', 'monthlyPurchaseVolume'].some((k) => k in o);
}

/* ───────────────────────── Precio y moneda ───────────────────────── */

const SYMBOL_TO_ISO: Record<string, string> = { '€': 'EUR', '£': 'GBP', '$': 'USD' };
const DOMAIN_CURRENCY: Array<[RegExp, string]> = [
  [/(^|\.)amazon\.(es|de|fr|it|nl|ie|be)$/, 'EUR'],
  [/(^|\.)amazon\.co\.uk$/, 'GBP'],
  [/(^|\.)amazon\.com$/, 'USD'],
];

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function readMoney(v: unknown): { value: number; symbol: string } | null {
  const o = asObject(v);
  const value = typeof o.value === 'number' ? o.value : Number(o.value);
  if (!Number.isFinite(value)) return null;
  return { value, symbol: text(o.currency, 8) };
}

/* ───────────────────────── Atributos estructurados ───────────────────────── */

function kvList(...lists: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const e = asObject(entry);
      const key = text(e.key, 80).toLowerCase();
      const val = text(e.value, 300);
      if (key && val && !map.has(key)) map.set(key, val);
    }
  }
  return map;
}

const pickKv = (map: Map<string, string>, ...patterns: RegExp[]): string => {
  for (const [key, value] of map) if (patterns.some((p) => p.test(key))) return value;
  return '';
};

/** Claves de atributos que no son especificaciones del producto (ruido de la página). */
const NOISE_KEYS = /^(asin|best sellers rank|customer reviews?|date first available|guaranteed software updates until|batteries|package dimensions|item model number|country of origin|box contents|number of items|unit count)$/i;

function specsOf(map: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of map) {
    if (NOISE_KEYS.test(key) || /^(unknown|ninguno|n\/a|none)$/i.test(value)) continue;
    out[key.replace(/\b\w/g, (c) => c.toUpperCase())] = value;
    if (Object.keys(out).length >= 60) break;
  }
  return out;
}

/* ───────────────────────── Contradicciones ───────────────────────── */

interface Specs { ram?: number; storage?: number; screen?: number; cpu: Set<string> }

const toGb = (n: number, unit: string): number => (/tb/i.test(unit) ? n * 1000 : n);
const num = (s: string): number => Number(s.replace(',', '.'));

function cpuTokens(source: string): Set<string> {
  const out = new Set<string>();
  const patterns = [/\bi[3579][- ]?(\d{4,5}[a-z]{0,2})\b/gi, /core ultra\s*[3579]\s*(\d{3}[a-z]{0,2})\b/gi, /ryzen\s*[3579]\s*(?:pro\s*)?(\d{4}[a-z]{0,2})\b/gi, /\b([3579]\d{3}[uhx]{1,2})\b/gi, /\b(n\d{2,3})\b/gi, /\b(m[1-5])\b/gi, /kompanio\s*(\d{3,4})\b/gi];
  for (const re of patterns) for (const m of source.matchAll(re)) out.add(m[1].toLowerCase());
  return out;
}

export function specsFromTitle(title: string): Specs {
  const s: Specs = { cpu: cpuTokens(title) };
  const ram = title.match(/(\d{1,3})\s*GB\s*(?:of\s+)?(?:RAM|DDR\d?\w*|LPDDR\w*|unified memory|memoria)/i) ?? title.match(/(?:RAM|memoria)\s*(?:de\s*)?(\d{1,3})\s*GB/i);
  if (ram) s.ram = Number(ram[1]);
  const st = title.match(/(\d{1,4})\s*(GB|TB)\s*(?:SSD|UFS[\s\d.]*|eMMC|NVMe|HDD|PCIe|M\.2|storage|almacenamiento)/i) ?? title.match(/(?:SSD|UFS|eMMC|NVMe|HDD)\s*(?:de\s*)?(\d{1,4})\s*(GB|TB)/i);
  if (st) s.storage = toGb(Number(st[1]), st[2]);
  const sc = title.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:"|”|''|-?\s*inch(?:es)?|-?\s*pulgadas|\s*pulg\b)/i);
  if (sc) s.screen = num(sc[1]);
  return s;
}

function specsFromAttributes(map: Map<string, string>): Specs {
  const s: Specs = { cpu: new Set() };
  const parse = (v: string): { n: number; unit: string } | null => {
    const m = v.match(/(\d+(?:[.,]\d+)?)\s*(GB|TB)/i);
    return m ? { n: num(m[1]), unit: m[2] } : null;
  };
  const ram = parse(pickKv(map, /^ram memory installed$/, /^ram size$/, /^ram memory installed size$/));
  if (ram) s.ram = toGb(ram.n, ram.unit);
  const st = parse(pickKv(map, /^hard[- ]drive size$/, /^hard disk size$/, /^memory storage capacity$/));
  if (st) s.storage = toGb(st.n, st.unit);
  const sc = pickKv(map, /^screen size$/).match(/(\d{1,2}(?:[.,]\d{1,2})?)/);
  if (sc) s.screen = num(sc[1]);
  s.cpu = cpuTokens([pickKv(map, /^cpu model number$/), pickKv(map, /^cpu model$/), pickKv(map, /^processor series$/)].join(' '));
  return s;
}

function specsFromVariant(variantAttributes: unknown): Specs {
  const s: Specs = { cpu: new Set() };
  for (const entry of Array.isArray(variantAttributes) ? variantAttributes : []) {
    const e = asObject(entry);
    const key = text(e.key, 60).toLowerCase();
    const value = text(e.value, 120);
    const ram = value.match(/(\d{1,3}(?:[.,]\d)?)\s*GB\s*RAM/i) ?? (/ram/.test(key) ? value.match(/(\d{1,3}(?:[.,]\d)?)\s*GB/i) : null);
    if (ram) s.ram = num(ram[1]);
    else if (/size|capacity|storage/.test(key)) {
      const st = value.match(/^(\d{1,4})\s*(GB|TB)$/i);
      if (st && toGb(Number(st[1]), st[2]) >= 64) s.storage = toGb(Number(st[1]), st[2]);
    }
  }
  return s;
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(a, b) * 0.1;

/** Contradicciones entre pares de fuentes (título, atributos estructurados, variante). Sólo compara lo que ambas dan. */
export function findContradictions(title: Specs, attrs: Specs, variant: Specs): string[] {
  const out: string[] = [];
  const sources: Array<[string, Specs]> = [['título', title], ['atributos', attrs], ['variante', variant]];
  const label = (v: number, kind: 'gb' | 'in') => (kind === 'in' ? `${v}"` : v >= 1000 && v % 1000 === 0 ? `${v / 1000} TB` : `${v} GB`);
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const [na, a] = sources[i];
      const [nb, b] = sources[j];
      if (a.ram && b.ram && !close(a.ram, b.ram)) out.push(`ram: ${na} ${label(a.ram, 'gb')} ≠ ${nb} ${label(b.ram, 'gb')}`);
      if (a.storage && b.storage && !close(a.storage, b.storage)) out.push(`almacenamiento: ${na} ${label(a.storage, 'gb')} ≠ ${nb} ${label(b.storage, 'gb')}`);
      if (a.screen && b.screen && Math.abs(a.screen - b.screen) > 0.35) out.push(`pantalla: ${na} ${label(a.screen, 'in')} ≠ ${nb} ${label(b.screen, 'in')}`);
      if (a.cpu.size && b.cpu.size && ![...a.cpu].some((t) => b.cpu.has(t))) out.push(`procesador: ${na} ${[...a.cpu].join('/')} ≠ ${nb} ${[...b.cpu].join('/')}`);
    }
  }
  return [...new Set(out)];
}

/* ───────────────────────── Imágenes ───────────────────────── */

function productImages(item: Any): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (v: unknown) => {
    const url = typeof v === 'string' ? v.trim() : '';
    if (!url.startsWith('https://') || /aplus-media|brand-?story/i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };
  const hi = Array.isArray(item.highResolutionImages) ? item.highResolutionImages : [];
  hi.forEach(add);
  if (!out.length) add(item.thumbnailImage);
  return out.slice(0, 12);
}

/* ───────────────────────── Adaptador ───────────────────────── */

export function adaptApifyAmazonItem(rawInput: unknown, ctx: AdaptContext = {}): Any {
  const item = asObject(rawInput);
  const meta: ImportMeta = { warnings: ['origen_apify_amazon_crawler'], review: [], errors: [] };
  const asin = text(item.asin ?? item.originalAsin, 10).toUpperCase();
  const title = text(item.title, 300);

  // Error del actor para este elemento (404, bloqueo…).
  const actorError = text(item.errorDescription ?? item.error ?? item.errorMessage, 200);
  if (actorError) meta.errors.push(`apify_error: ${actorError}`);
  if (!/^[A-Z0-9]{10}$/.test(asin)) meta.errors.push('asin_invalido');

  const url = text(item.url, 600) || (asin ? `https://www.amazon.es/dp/${asin}` : '');
  const host = hostOf(url);

  // Oferta principal: price + seller (aunque `offers` venga vacío).
  const money = readMoney(item.price);
  let currency = money ? SYMBOL_TO_ISO[money.symbol] ?? (/^[A-Za-z]{3}$/.test(money.symbol) ? money.symbol.toUpperCase() : '') : '';
  const domainCurrency = DOMAIN_CURRENCY.find(([re]) => re.test(host))?.[1] ?? '';
  if (money && !currency && domainCurrency) {
    currency = domainCurrency;
    meta.warnings.push('moneda_deducida_del_dominio');
  } else if (currency && domainCurrency && currency !== domainCurrency) {
    meta.warnings.push(`moneda_distinta_del_dominio:${currency}/${domainCurrency}`);
  }
  const list = readMoney(item.listPrice);
  const originalPrice = money && list && list.value > money.value ? list.value : undefined;

  // Envío: sólo si el actor da un importe; «sin dato» es desconocido, nunca gratis.
  const shippingRaw = item.shippingPrice;
  const shippingMoney = readMoney(shippingRaw);
  const shipping: Any = {};
  if (shippingMoney) shipping.cost = shippingMoney.value;
  else if (typeof shippingRaw === 'string' && /free|gratis/i.test(shippingRaw)) shipping.free = true;

  const seller = asObject(item.seller);
  const sellerName = text(seller.name, 120) || undefined;
  const sellerIdRaw = text(seller.id, 80);

  const availability = typeof item.inStock === 'boolean' ? item.inStock : undefined;

  // Atributos estructurados y variante.
  const kv = kvList(item.productOverview, item.attributes, item.manufacturerAttributes);
  const variantAttrs = kvList(item.variantAttributes);
  const color = pickKv(variantAttrs, /colou?r/) || pickKv(kv, /^colou?r$/) || undefined;
  const capacityRaw = pickKv(variantAttrs, /size|capacity|storage/);
  const mpn = pickKv(kv, /^manufacturer part number$/, /^model number$/, /^item model number$/) || undefined;
  const gtin = pickKv(kv, /^upc$/, /^ean$/, /^gtin$/) || undefined;

  // Variantes del actor: sin precio propio → NO se importan y NO heredan el precio principal.
  const variants = Array.isArray(item.variantDetails) ? item.variantDetails.map(asObject) : [];
  const otherVariants = variants.filter((v) => text(v.asin, 10).toUpperCase() !== asin);
  if (otherVariants.length) {
    const priced = otherVariants.filter((v) => readMoney(v.price)).length;
    meta.warnings.push(`variantes_no_importadas:${otherVariants.length}${priced ? `_con_precio:${priced}` : '_sin_precio'}`);
  }

  // Contradicciones título / atributos / variante → revisión (sin elegir ningún valor).
  const contradictions = findContradictions(specsFromTitle(title), specsFromAttributes(kv), specsFromVariant(item.variantAttributes));
  for (const c of contradictions) meta.review.push(`contradiccion_${c}`);

  // Categoría del catálogo (sólo si encaja una).
  const crumbs = text(item.breadCrumbs, 300);
  let category: string | undefined;
  if (ctx.resolveCategory) {
    const found = ctx.resolveCategory(`${crumbs} ${title}`);
    if (found.name) category = found.name;
    else meta.warnings.push(found.ambiguous ? 'categoria_ambigua' : 'categoria_no_determinada');
  }

  const features = Array.isArray(item.features) ? item.features.map((f) => text(f, 400)).filter(Boolean) : [];
  const description = text(item.description, 5000) || features.join(' · ').slice(0, 5000) || undefined;
  const stars = typeof item.stars === 'number' ? item.stars : Number(item.stars);
  const reviews = typeof item.reviewsCount === 'number' ? item.reviewsCount : Number(item.reviewsCount);

  const offer: Any = {
    platform: 'amazon',
    externalId: asin || undefined,
    url,
    price: money?.value,
    currency: currency || undefined,
    originalPrice,
    sellerName,
    sellerId: sellerIdRaw || undefined,
    availability,
    shipping: Object.keys(shipping).length ? shipping : undefined,
    capturedAt: ctx.capturedAt,
  };
  for (const k of Object.keys(offer)) if (offer[k] === undefined) delete offer[k];

  const variant: Any = { color, capacity: capacityRaw || undefined, condition: text(item.condition, 40) || undefined };
  for (const k of Object.keys(variant)) if (variant[k] === undefined) delete variant[k];

  const product: Any = {
    title,
    brand: text(item.brand, 120) || undefined,
    mpn,
    gtin,
    category,
    description,
    images: productImages(item),
    specs: specsOf(kv),
    rating: Number.isFinite(stars) && stars > 0 ? stars : undefined,
    reviewsCount: Number.isFinite(reviews) && reviews >= 0 ? reviews : undefined,
  };
  for (const k of Object.keys(product)) if (product[k] === undefined) delete product[k];

  return { product, variant, offer, __import: meta };
}

/** Lee el bloque `__import` que dejó el adaptador (o uno externo equivalente), saneado. */
export function readImportMeta(raw: unknown): ImportMeta {
  const m = asObject(asObject(raw).__import);
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => text(x, 240)).filter(Boolean).slice(0, 30) : []);
  return { warnings: list(m.warnings), review: list(m.review), errors: list(m.errors) };
}
