/**
 * ==============================================================================
 * TRADYLOR — IDENTIDAD DE OFERTA, PRODUCTO Y MARCA (funciones puras)
 * ==============================================================================
 * Reglas únicas para reconocer «la misma oferta» llegue por API, URL o JSON:
 *
 *  - `normalizeSourceId`: id externo comparable (ASIN, Item ID de AliExpress sin
 *    prefijo `AE-`, itemId de eBay sin el envoltorio `v1|<id>|<variación>`).
 *  - `offerKey`: red + id externo (+ vendedor cuando la red lo distingue).
 *  - `normalizeBrand`: marca comparable SIN fusionar marcas distintas.
 *
 * Sin dependencias del resto del proyecto: se puede probar en aislamiento.
 * ==============================================================================
 */

/** Separa el itemId de eBay (`v1|123456789012|0`) de su id de variación. */
export function parseEbayItemId(raw: string | null | undefined): { itemId: string; variationId?: string } {
  const value = String(raw ?? '').trim();
  if (!value) return { itemId: '' };
  const parts = value.split('|').map((part) => part.trim());
  if (parts.length >= 2 && /^v\d+$/i.test(parts[0])) {
    const variation = parts[2] && parts[2] !== '0' ? parts[2] : undefined;
    return { itemId: parts[1], variationId: variation };
  }
  return { itemId: value };
}

/**
 * Id externo comparable entre vías de importación. Devuelve '' si no hay id.
 * Es independiente de la red: una API (`100500123`) y una URL (`AE-100500123`)
 * dan el MISMO resultado.
 */
export function normalizeSourceId(raw: string | null | undefined): string {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.includes('|')) value = parseEbayItemId(value).itemId;
  value = value.replace(/^AE-/i, '');
  // ASIN: 10 caracteres alfanuméricos → mayúsculas; el resto se compara tal cual.
  if (/^[a-z0-9]{10}$/i.test(value)) return value.toUpperCase();
  return value;
}

/** ¿Dos ids externos identifican el mismo anuncio? (vacíos nunca coinciden). */
export function sameSourceId(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeSourceId(a);
  const right = normalizeSourceId(b);
  return left !== '' && left === right;
}

export interface OfferIdentityInput {
  network?: string | null;
  externalId?: string | null;
  /** Vendedor/tienda cuando la plataforma aloja varios (eBay, AliExpress). */
  merchantId?: string | null;
  /** Variación del anuncio (eBay variationId, SKU...). */
  variantId?: string | null;
}

/**
 * Clave estable de una oferta: `red:idExterno[:vendedor][#variante]`.
 * Vendedores distintos de una misma plataforma producen claves distintas.
 */
export function offerKey(input: OfferIdentityInput): string {
  const network = String(input.network ?? '').trim().toLowerCase() || 'desconocida';
  const id = normalizeSourceId(input.externalId);
  if (!id) return '';
  const merchant = String(input.merchantId ?? '').trim().toLowerCase();
  const variant = String(input.variantId ?? '').trim().toLowerCase();
  return `${network}:${id}${merchant ? `:${merchant}` : ''}${variant ? `#${variant}` : ''}`;
}

/* ───────────────────────────── MARCAS ───────────────────────────── */

/** Sinónimos CONOCIDOS y seguros (clave normalizada → nombre a mostrar). */
export const BRAND_ALIASES: Record<string, string> = {
  'hewlett packard': 'HP',
  'hp inc': 'HP',
  'hp inc.': 'HP',
};

const BRAND_NOISE: RegExp[] = [
  /^visit the\s+/i,
  /^visita la tienda de\s+/i,
  /^visita la página de\s+/i,
  /^marca\s*:\s*/i,
  /^brand\s*:\s*/i,
  /\s+store$/i,
  /\s+tienda oficial$/i,
  /\s+official store$/i,
  /\s+oficial$/i,
];

function foldKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface NormalizedBrand {
  /** Clave de comparación (minúsculas, sin acentos ni signos). '' si no hay marca. */
  key: string;
  /** Nombre limpio para mostrar. */
  display: string;
}

/**
 * Normaliza una marca: quita ruido del comercio («Visit the X Store»,
 * «Marca: X»), unifica mayúsculas/acentos y aplica sólo sinónimos de
 * `BRAND_ALIASES`. NO fusiona marcas distintas ni infiere marcas.
 */
export function normalizeBrand(raw: string | null | undefined, aliases: Record<string, string> = BRAND_ALIASES): NormalizedBrand {
  let value = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!value || /^[-—–?]+$/.test(value)) return { key: '', display: '' };
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of BRAND_NOISE) {
      const next = value.replace(pattern, '').trim();
      if (next !== value && next) {
        value = next;
        changed = true;
      }
    }
  }
  const key = foldKey(value);
  if (!key) return { key: '', display: '' };
  const alias = aliases[key];
  if (alias) return { key: foldKey(alias), display: alias };
  return { key, display: value };
}

/** ¿La «marca» es en realidad el nombre de la tienda/red? (no es fabricante). */
export function brandIsMerchant(brand: string | null | undefined, merchant: string | null | undefined): boolean {
  const left = normalizeBrand(brand).key;
  const right = normalizeBrand(merchant).key;
  return left !== '' && left === right;
}
