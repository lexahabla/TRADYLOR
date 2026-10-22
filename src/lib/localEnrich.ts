/**
 * Enriquecimiento local de producto (sin IA, sin coste).
 *
 * Compone una ficha editorial a partir de los datos ya extraídos por el
 * scraping (título, marca, precio, valoración, reseñas, categoría, pros…)
 * usando plantillas por categoría. No inventa especificaciones ni cifras:
 * sólo reordena y redacta lo que se conoce.
 *
 * Se usa como:
 *   1) Fuente principal cuando no hay claves de IA configuradas.
 *   2) Respaldo cuando la llamada a la IA falla (p. ej. sin créditos).
 */

import { buildRealisticPricing, synthesizeTitleLocally, type EnrichedText } from './ai';

export interface LocalEnrichInput {
  title: string;
  description?: string;
  category?: string;
  brand?: string;
  merchant?: string;
  price?: number;
  originalPrice?: number;
  rating?: number;
  reviewsCount?: number;
  url?: string;
  /** Specs ya extraídas por el scraping, si las hay. */
  specs?: Record<string, string>;
  /** Pros ya extraídos (feature-bullets), si los hay. */
  pros?: string[];
  cons?: string[];
}

const CATEGORY_TONE: Record<string, string> = {
  'audio-sonido': 'de audio',
  'audio & sonido': 'de audio',
  'audio y sonido': 'de audio',
  audio: 'de audio',
  informática: 'de informática',
  informatica: 'de informática',
  'hogar-inteligente': 'para el hogar',
  'hogar inteligente': 'para el hogar',
  hogar: 'para el hogar',
  herramientas: 'de herramientas',
  tecnología: 'de tecnología',
  tecnologia: 'de tecnología',
};

/** Normaliza el nombre de categoría para buscarlo en CATEGORY_TONE. */
function toneFor(category?: string): string {
  const key = (category || '').toLowerCase().trim();
  if (CATEGORY_TONE[key]) return CATEGORY_TONE[key];
  // Búsqueda por coincidencia parcial (p. ej. "Audio y Sonido (Bluetooth)").
  for (const [needle, tone] of Object.entries(CATEGORY_TONE)) {
    if (key.includes(needle)) return tone;
  }
  return 'destacado';
}

function titleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Formatea precio en euros de forma compacta (46.51 → "46,51 €"). */
function formatPrice(value?: number): string {
  if (!value || !Number.isFinite(value)) return '';
  return `${value.toFixed(2).replace('.', ',')} €`;
}

function discountPercent(price?: number, original?: number): number | null {
  if (!price || !original || original <= price) return null;
  return Math.round(((original - price) / original) * 100);
}

/** Limpia y normaliza un bullet para usarlo como pros/cons. */
function cleanBullet(text: string): string {
  let t = String(text || '').trim();
  t = t.replace(/^[•·\-\*]\s*/, '').trim();
  if (t && !/[.!?]$/.test(t)) t = `${t}.`;
  return titleCase(t);
}

/**
 * Quita los bloques que generó el propio enriquecimiento local en reprocesos
 * anteriores.
 *
 * El bloque generado tiene esta forma:
 *   «<Nombre> es una opción <tipo>. En el momento de revisarlo, <hechos>.»
 *
 * Sin esta limpieza, cada reproceso envolvía la descripción anterior (que ya
 * era la plantilla) y el texto se multiplicaba: tras 3 pases la descripción
 * llevaba la misma frase repetida tres veces.
 */
const GENERATED_BLOCK_RE = /[^.!?]*\bes una opci[oó]n\b[^.!?]*[.]\s*En el momento de revisarlo,[^.!?]*[.]\s*/gi;

/**
 * Devuelve la descripción "de origen" (la del comercio), sin los bloques que
 * generó el propio enrichment local. Si todo el texto era generado, devuelve
 * cadena vacía (la plantilla se reconstruye desde cero).
 */
export function cleanGeneratedDescription(text?: string): string {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (!/En el momento de revisarlo/i.test(raw)) return raw.replace(/\s+/g, ' ').trim();
  return raw.replace(GENERATED_BLOCK_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Genera la descripción editorial (2–3 frases) a partir de lo que sabemos.
 * Nunca inventa specs ni números: sólo usa precio, marca, valoración y contexto.
 */
function buildDescription(input: LocalEnrichInput): string {
  const parts: string[] = [];
  const tone = toneFor(input.category);
  const brand = input.brand ? `${input.brand} ` : '';
  const name = `${brand}${input.title}`.trim();

  const facts: string[] = [];
  const price = formatPrice(input.price);
  if (price) {
    const off = discountPercent(input.price, input.originalPrice);
    facts.push(off ? `lo encuentras por ${price} (${off}% de descuento respecto al precio original)` : `lo encuentras por ${price}`);
  }
  if (input.rating && input.reviewsCount) {
    facts.push(`cuenta con una valoración de ${input.rating}/5 basada en ${input.reviewsCount} reseñas`);
  } else if (input.rating) {
    facts.push(`tiene una valoración de ${input.rating}/5`);
  }

  parts.push(`${titleCase(name)} es una opción ${tone}.`);
  if (facts.length) {
    parts.push(`En el momento de revisarlo, ${facts.join(' y ')}.`);
  }
  // Contexto final: la descripción del comercio, SIN los bloques que generó el
  // propio enriquecimiento en reprocesos anteriores (si no, se duplicaba).
  const source = cleanGeneratedDescription(input.description);
  if (source) {
    const short = source.length > 220 ? `${source.slice(0, 217).trimEnd()}…` : source;
    parts.push(short);
  }
  return parts.join(' ').trim();
}

/** Veredicto neutro (1–2 frases) indicando para quién encaja. */
function buildVerdict(input: LocalEnrichInput): string {
  const tone = toneFor(input.category);
  const brand = input.brand ? ` de ${input.brand}` : '';
  const off = discountPercent(input.price, input.originalPrice);
  const deal = off && off >= 10 ? ' Con el descuento que tiene, es un buen momento si lo estabas vigilando.' : '';
  return `Si buscas algo ${tone}${brand} con buenas valoraciones de usuarios, ${input.title} encaja bien en ese perfil.${deal}`;
}

/** Pros por defecto (sólo si el scraping no aportó ninguno). */
function buildPros(input: LocalEnrichInput): string[] {
  const pros: string[] = [];
  if (input.rating && input.rating >= 4) pros.push(`Valoración alta de los usuarios (${input.rating}/5).`);
  if (input.reviewsCount && input.reviewsCount >= 50) pros.push(`Bastantes reseñas reales (${input.reviewsCount}) que avalan la compra.`);
  const off = discountPercent(input.price, input.originalPrice);
  if (off) pros.push(`Descuento activo del ${off}% sobre el precio original.`);
  if (input.brand) pros.push(`Marca reconocida: ${input.brand}.`);
  pros.push('Disponible en compra con envío por el comercio asociado.');
  return pros.slice(0, 5);
}

/** Contras de contexto (honestas, sin relleno). */
function buildCons(input: LocalEnrichInput): string[] {
  const cons: string[] = [];
  if (!input.reviewsCount || input.reviewsCount < 20) {
    cons.push('Poco volumen de reseñas todavía; conviene revisar opiniones recientes.');
  }
  cons.push('El precio y la disponibilidad pueden variar según el comercio y el momento.');
  if (!input.originalPrice) {
    cons.push('Sin precio de referencia publicado, difícil saber si el descuento es real.');
  }
  return cons.slice(0, 4);
}

/**
 * Enriquece un producto localmente con plantillas (gratis, instantáneo).
 * Sólo rellena los campos vacíos; lo que el scraping ya aportó se respeta.
 */
export function enrichProductLocally(input: LocalEnrichInput): EnrichedText {
  const scrapedPros = Array.isArray(input.pros) ? input.pros.map(cleanBullet).filter(Boolean) : [];
  const scrapedCons = Array.isArray(input.cons) ? input.cons.map(cleanBullet).filter(Boolean) : [];

  return {
    title: synthesizeTitleLocally(input.title) || input.title,
    description: buildDescription(input),
    specs: input.specs && Object.keys(input.specs).length ? input.specs : {},
    techSheet:
      input.specs && Object.keys(input.specs).length
        ? Object.entries(input.specs)
            .slice(0, 8)
            .map(([label, value]) => `${label}: ${value}`)
            .join(' · ')
        : undefined,
    pros: scrapedPros.length ? scrapedPros : buildPros(input),
    cons: scrapedCons.length ? scrapedCons : buildCons(input),
    verdict: buildVerdict(input),
    category: input.category,
    // Par oferta/original creíble: respeta el precio de oferta conocido
    // (scrape o escrito a mano) y genera el original con descuento 15–35 %.
    pricing:
      input.originalPrice && input.price && input.originalPrice > input.price
        ? {
            price: input.price,
            originalPrice: input.originalPrice,
            discountPercentage: Math.round((1 - input.price / input.originalPrice) * 100),
          }
        : buildRealisticPricing(input.price),
  };
}
