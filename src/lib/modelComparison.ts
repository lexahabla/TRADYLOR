/**
 * ==============================================================================
 * TREIDILOR — COMPARADOR DE MODELOS (#comparativa) · modelo de vista PURO
 * ==============================================================================
 * Compara MODELOS distintos del mismo tipo (no ofertas del mismo producto: eso es #ofertas). Sólo lectura; no fusiona ni modifica fichas.
 *
 * Selección (sólo en presentación):
 *  - mismo tipo de producto (`areSameProductType`: subcategoría/categoría) y nunca accesorios frente a un producto principal;
 *  - se excluyen las fichas que son el MISMO anuncio comercial que la de referencia (fichas gemelas) y, entre los rivales, se
 *    conserva un único representante por anuncio (precio menor, luego id);
 *  - jamás se une por parecido de título: Book4 y Book4 Pro son modelos distintos y se mantienen separados.
 * ==============================================================================
 */

import { areSameProductType } from './curation';
import { getComparableOffers } from './comparableOffers';
import { productAttributes } from './catalogFacets';
import { ratingSupport, shownDiscount, NOT_INDICATED } from './commercialClaims';
import { satisfactionPercent } from './satisfaction';
import { productKey } from './catalog';
import { publicText } from './publicClaims';

type Any = Record<string, any>;

export const NO_DATA = 'Sin dato';
export const MAX_RIVALS = 3;
export const MAX_ATTR_ROWS = 6;
export const MAX_SPEC_ITEMS = 8;

/** Características que no se listan como especificación (color, estado, marca, nombre del modelo). */
const SPEC_EXCLUDED = /^(color|colour|estado|marca|modelo|nombre-del-modelo|nombre)$|^color-|-color$/;

/** Conceptos de especificación, en orden de relevancia. Cada uno agrupa las claves equivalentes del catálogo (sin duplicar el concepto). */
const SPEC_GROUPS: Array<{ id: string; label: string; re: RegExp; text?: boolean }> = [
  { id: 'storage', label: 'Almacenamiento', re: /^(almacenamiento|capacidad-de-almacenamiento|memoria-interna|storage|ssd|tamano-del-disco-duro|disco-duro|capacidad-del-disco-duro)$|disco-duro|^almacenamiento/ },
  { id: 'ram', label: 'RAM', re: /^ram$|memoria-ram|ram-instalada|tamano-de-memoria-ram/ },
  { id: 'cpu', label: 'Procesador', re: /cpu|procesador/, text: true },
  { id: 'gpu', label: 'GPU', re: /gpu|grafic/, text: true },
  { id: 'screen', label: 'Pantalla', re: /^pantalla$|tamano-de-pantalla|tamano-de-la-pantalla|screen/ },
  { id: 'resolution', label: 'Resolución', re: /resoluc/, text: true },
  { id: 'battery', label: 'Batería', re: /bater/ },
  { id: 'autonomy', label: 'Autonomía', re: /autonom/ },
  { id: 'connectivity', label: 'Conectividad', re: /conectiv|bluetooth/, text: true },
  { id: 'power', label: 'Potencia', re: /potencia|^power$/ },
  { id: 'weight', label: 'Peso', re: /^peso$|^weight$/ },
];

const ACCESSORY = /\b(funda|estuche|organizador|soporte|adaptador|cable|cargador|protector|almohadillas?|repuesto|correa|case|bolsa|carcasa|pegatinas?|limpiador)\b/i;

export const isAccessory = (p: Any): boolean => ACCESSORY.test(String(p?.title ?? ''));

/**
 * Función principal del producto, deducida del TÍTULO (orden = prioridad: «gafas con auriculares» es una gafa, no un auricular).
 * Es más estricta que `areSameProductType`: dos productos sólo se comparan si comparten familia, o si ambos tienen la MISMA subcategoría
 * asignada. Sin familia identificable no se acredita la equivalencia y el candidato se excluye (con motivo).
 */
const FAMILIES: Array<[string, RegExp]> = [
  ['gafas', /\b(gafas?|smart ?glasses|lentes inteligentes)\b/],
  ['auriculares', /\b(auriculares?|cascos?|earbuds?|headphones?|headset|tws)\b/],
  ['altavoz', /\b(altavoz|altavoces|speaker|soundbar|barra de sonido)\b/],
  ['powerbank', /\b(power ?bank|bateria portatil)\b/],
  ['reloj', /\b(smartwatch|reloj|smart band|pulsera)\b/],
  ['portatil', /\b(portatil|laptop|notebook|ultrabook|macbook)\b/],
  ['tablet', /\b(tablet|tableta|ipad)\b/],
  ['raton', /\b(raton|mouse)\b/],
  ['teclado', /\b(teclado|keyboard)\b/],
  ['monitor', /\b(monitor)\b/],
  ['televisor', /\b(televisor|smart tv)\b/],
  ['almacenamiento', /\b(ssd|nvme|disco duro|hdd|pendrive|microsd|tarjeta sd)\b/],
  ['camara', /\b(camara|action cam|gopro|dashcam)\b/],
  ['proyector', /\b(proyector|projector)\b/],
  ['aspirador', /\b(aspirador|aspiradora|robot aspirador)\b/],
  ['freidora', /\b(freidora|air ?fryer)\b/],
  ['cafetera', /\b(cafetera|espresso)\b/],
  ['impresora', /\b(impresora|printer)\b/],
  ['consola', /\b(consola|playstation|xbox|nintendo switch)\b/],
  ['movil', /\b(smartphone|movil|telefono|iphone)\b/],
];
const fold = (t: string) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export function functionFamilyOf(p: Any): string | null {
  const t = fold(p?.title);
  for (const [name, re] of FAMILIES) if (re.test(t)) return name;
  return null;
}

export interface ExcludedCandidate { id: string; title: string; reason: string }

const ATTR_LABELS: Record<string, string> = {
  almacenamiento: 'Almacenamiento', ram: 'RAM', peso: 'Peso', bateria: 'Batería', pantalla: 'Pantalla', potencia: 'Potencia',
  autonomia: 'Autonomía', color: 'Color', conectividad: 'Conectividad', resolucion: 'Resolución',
  diseno: 'Diseño', microfono: 'Micrófono', tipo: 'Tipo', modelo: 'Modelo', material: 'Material', marca: 'Marca',
};
const labelOfKey = (k: string) => {
  if (ATTR_LABELS[k]) return ATTR_LABELS[k];
  if (/cpu|procesador/.test(k)) return 'Procesador';
  if (/gpu|grafic/.test(k)) return 'GPU';
  if (/disco|ssd|almacen/.test(k)) return 'Almacenamiento';
  const text = k.replace(/[-_]+/g, ' ').replace(/\btamano\b/g, 'tamaño').replace(/\bmicrofono\b/g, 'micrófono').replace(/\bbateria\b/g, 'batería');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Clave del anuncio comercial principal de una ficha (plataforma + id de anuncio); null si no se puede determinar. */
export function listingKeyOf(p: Any): string | null {
  try {
    const o = getComparableOffers(p as never).offers.find((x) => x.origin === 'implicit');
    return o?.listingId ?? null;
  } catch {
    return null;
  }
}

export interface ModelColumn {
  id: string;
  key: string;
  title: string;
  brand: string;
  href: string;
  image: string;
  isReference: boolean;
  /** Datos de la tarjeta de cabecera (todos del catálogo; nada inventado). */
  priceText: string | null;
  /** Sólo descuento VERIFICADO (lib/commercialClaims.ts › shownDiscount); null si no está acreditado. */
  discountPct: number | null;
  previousPriceText: string | null;
  /** Valoración con procedencia y recuento (sólo si es fiable); null si no. */
  ratingText: string | null;
  ratingOrigin: 'vendedor' | 'producto' | null;
  /** Mismo indicador orientativo que la barra de ProductCard (lib/satisfaction.ts). */
  satisfaction: number;
  /** Descripción breve (1-2 frases, ya depurada de afirmaciones sin respaldo); '' si no hay. */
  description: string;
}
export interface SpecItem { label: string; value: string; missing: boolean }
export interface ModelRow {
  label: string;
  /** Sólo en «Especificaciones técnicas»: una lista por columna, con las MISMAS características en el mismo orden. */
  items?: SpecItem[][];
  /** Una celda por columna; «Sin dato» si falta. */
  cells: string[];
  /** true si hay al menos dos valores distintos conocidos. */
  differs: boolean;
}
export interface ModelComparison {
  columns: ModelColumn[];
  rows: ModelRow[];
  explanation: string;
  hasRivals: boolean;
  hiddenTwins: number;
  /** Candidatos del mismo tipo descartados, con el motivo (documentación; no se pinta). */
  excluded: ExcludedCandidate[];
}

const eur = (n: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);

export function selectRivals(reference: Any, catalog: Any[]): { rivals: Any[]; hiddenTwins: number; excluded: ExcludedCandidate[] } {
  const excluded: ExcludedCandidate[] = [];
  const refFamily = functionFamilyOf(reference);
  const refListing = listingKeyOf(reference);
  const refIsAccessory = isAccessory(reference);
  let hiddenTwins = 0;
  const bestByListing = new Map<string, Any>();
  const loose: Any[] = [];
  for (const p of catalog) {
    if (!p || p.id === reference.id) continue;
    if (!areSameProductType(reference as never, p as never)) {
      if (String(p.category || '') === String(reference.category || '')) excluded.push({ id: p.id, title: p.title, reason: 'sin datos para acreditar la función principal (tipo no compatible)' });
      continue;
    }
    if (isAccessory(p) !== refIsAccessory) { excluded.push({ id: p.id, title: p.title, reason: 'accesorio frente a producto principal' }); continue; }
    const sameSub = Boolean(reference.subcategory_id && p.subcategory_id && reference.subcategory_id === p.subcategory_id);
    if (!sameSub) {
      const fam = functionFamilyOf(p);
      if (!refFamily || !fam) { excluded.push({ id: p.id, title: p.title, reason: 'sin datos para acreditar la función principal' }); continue; }
      if (fam !== refFamily) { excluded.push({ id: p.id, title: p.title, reason: `función distinta (${fam} ≠ ${refFamily})` }); continue; }
    }
    const lk = listingKeyOf(p);
    if (lk && refListing && lk === refListing) { hiddenTwins++; continue; }
    if (!lk) { loose.push(p); continue; }
    const cur = bestByListing.get(lk);
    if (!cur) { bestByListing.set(lk, p); continue; }
    hiddenTwins++;
    const better = p.price < cur.price || (p.price === cur.price && String(p.id) < String(cur.id));
    if (better) bestByListing.set(lk, p);
  }
  const pool = [...bestByListing.values(), ...loose].filter((p) => Number(p.price) > 0);
  const refPrice = Number(reference.price) || 0;
  pool.sort((a, b) => Math.abs(a.price - refPrice) - Math.abs(b.price - refPrice) || String(a.id).localeCompare(String(b.id)));
  return { rivals: pool.slice(0, MAX_RIVALS), hiddenTwins, excluded };
}

/** Descripción breve para la tarjeta: la del catálogo, depurada (publicClaims), sin sufijo de tienda y recortada. */
function briefDescription(p: Any): string {
  const text = publicText(p).description.replace(/\s*[-|:]\s*(Amazon(?:\.es)?|AliExpress|eBay|Temu|PcComponentes|El Corte Inglés|MediaMarkt|Fnac|Carrefour).*$/i, '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 110 ? `${text.slice(0, 110).trimEnd()}…` : text;
}

/** «★ 4,7 · 17 valoraciones» (+ «del vendedor» si lo es); null si no hay valoración sustentada. */
function cardRating(p: Any): string | null {
  const s = ratingSupport(p);
  if (s.rating === null) return null;
  const count = s.count ? ` · ${s.count.toLocaleString('es-ES')} valoraciones` : '';
  return `★ ${s.rating.toLocaleString('es-ES')}${count}${s.origin === 'vendedor' ? ' (del vendedor)' : ''}`;
}

export function buildModelComparison(reference: Any, catalog: Any[]): ModelComparison {
  const { rivals, hiddenTwins, excluded } = selectRivals(reference, catalog);
  const products = [reference, ...rivals];
  const columns: ModelColumn[] = products.map((p, i) => ({
    id: p.id, key: productKey(p as never), title: p.title, brand: p.brand ?? '', href: `/producto/${encodeURIComponent(productKey(p as never))}`,
    image: p.image ?? '', isReference: i === 0,
    priceText: Number(p.price) > 0 ? eur(Number(p.price)) : null,
    discountPct: shownDiscount(p)?.pct ?? null,
    previousPriceText: shownDiscount(p) ? eur(shownDiscount(p)!.previousPrice) : null,
    ratingText: cardRating(p),
    ratingOrigin: ratingSupport(p).rating !== null ? ratingSupport(p).origin : null,
    satisfaction: satisfactionPercent(p),
    description: briefDescription(p),
  }));

  const rows: ModelRow[] = [];
  const addRow = (label: string, cells: string[]) => {
    const known = cells.filter((c) => c !== NO_DATA);
    rows.push({ label, cells, differs: new Set(known).size > 1 });
  };

  addRow('Precio publicado', products.map((p) => (Number(p.price) > 0 ? eur(p.price) : NO_DATA)));
  addRow('Valoración', products.map((p) => {
    const s = ratingSupport(p);
    if (s.rating === null) return NO_DATA;
    const who = s.origin === 'vendedor' ? ' (del vendedor)' : '';
    return `★ ${s.rating.toLocaleString('es-ES')}${s.count ? ` · ${s.count.toLocaleString('es-ES')} opiniones` : ''}${who}`;
  }));
  addRow('Indicador de satisfacción (orientativo)', products.map((p) => `${satisfactionPercent(p)} %`));

  // UNA fila «Especificaciones técnicas». Las características se agrupan en conceptos (almacenamiento, RAM, procesador, GPU, pantalla…): por
  // modelo se muestra UN valor por concepto (el numérico si lo hay, para que sea comparable) y nunca aparece el mismo concepto repetido. Los
  // conceptos salen solos según la categoría (unos auriculares no tienen GPU ni RAM). Excluidos: color, estado, marca y nombre del modelo.
  // Sólo se listan los conceptos presentes en ≥2 modelos. No se modifica ningún dato del catálogo.
  const perProduct = products.map((p) => {
    const out = new Map<string, { label: string; value: string }>();
    const list = productAttributes(p).filter((x) => !SPEC_EXCLUDED.test(x.key));
    const fmt = (x: (typeof list)[number]) => (x.type === 'number' ? `${(x.value as number).toLocaleString('es-ES')}${x.unit ? ' ' + x.unit : ''}` : x.type === 'boolean' ? (x.value ? 'Sí' : 'No') : x.raw || String(x.value));
    const used = new Set<string>();
    for (const g of SPEC_GROUPS) {
      const hits = list.filter((x) => g.re.test(x.key));
      if (!hits.length) continue;
      hits.forEach((h) => used.add(h.key));
      // Procesador, GPU, resolución y conectividad se muestran tal como los declara la ficha (un número suelto no los describe).
      const pick = g.text ? hits[0] : hits.find((h) => h.type === 'number') ?? hits[0];
      out.set(g.id, { label: g.label, value: g.text ? pick.raw || String(pick.value) : fmt(pick) });
    }
    for (const x of list) if (!used.has(x.key)) out.set(`k:${x.key}`, { label: labelOfKey(x.key), value: fmt(x) });
    return out;
  });
  const counts = new Map<string, number>();
  perProduct.forEach((m) => m.forEach((_, k) => counts.set(k, (counts.get(k) ?? 0) + 1)));
  const rank = (k: string) => { const i = SPEC_GROUPS.findIndex((g) => g.id === k); return i < 0 ? SPEC_GROUPS.length : i; };
  const keys = [...counts.entries()].filter(([, n]) => n >= 2).map(([k]) => k).sort((x, y) => rank(x) - rank(y) || x.localeCompare(y)).slice(0, MAX_SPEC_ITEMS);
  if (keys.length) {
    const items: SpecItem[][] = perProduct.map((m) =>
      keys.map((k) => {
        const hit = m.get(k);
        const label = hit?.label ?? perProduct.map((x) => x.get(k)?.label).find(Boolean) ?? k;
        return hit ? { label, value: hit.value, missing: false } : { label, value: NO_DATA, missing: true };
      }),
    );
    const cells = items.map((list) => list.map((i) => `${i.label}: ${i.value}`).join(' · '));
    rows.push({ label: 'Especificaciones técnicas', cells, items, differs: new Set(cells).size > 1 });
  }

  addRow('Ventajas destacadas', products.map((p) => ((pros) => (pros.length ? pros.slice(0, 3).join(' · ') : NO_DATA))(publicText(p).pros)));

  const hasRivals = rivals.length > 0;
  return {
    columns,
    rows,
    hasRivals,
    hiddenTwins,
    excluded,
    explanation: hasRivals
      ? 'Modelos distintos del mismo tipo de producto. Los datos son los de cada ficha; «Sin dato» indica que no consta.'
      : 'No hay otros modelos comparables registrados para este producto.',
  };
}

export { NOT_INDICATED };
