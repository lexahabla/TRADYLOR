/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · PLAN PÚBLICO (etapa 6, SOLO SERVIDOR, solo lectura)
 * ==============================================================================
 * `buildPublicHome()` decide qué se pinta en la portada pública y devuelve datos ya validados y serializables (ids de productos, textos,
 * enlaces internos). NUNCA lanza: ante cualquier fallo devuelve `{ mode: 'legacy', reason }` y `index.astro` pinta la portada anterior.
 *
 *  · Candados: código + `HOME_LAYOUT_ENABLED` + `activation.enabled` + `home-layout-activation.json` (versión FIJADA). Sin ellos → legacy
 *    sin tocar el disco (los dos primeros se comprueban antes de leer nada).
 *  · Bloques: se resuelven con los MISMOS `loadSources()` / `resolveBlocks(..., {runAutomatic:true})` que la previsualización del editor; sólo
 *    se pintan los visibles. La modalidad Automática usa `runAutomatic` (nunca se inventan fechas de alta).
 *  · Secciones: un bloque «Sección» referencia por id; título, productos y velocidad salen de `sections.json` (sin copiarlos ni modificarlos).
 *    Las secciones publicadas que NINGÚN bloque referencia se conservan en su posición actual (sin duplicar) para que no desaparezcan.
 *    Se respeta la posición «arriba/abajo» de cada sección; el resto de bloques va arriba.
 *  · Historias: sólo las `publicada` y sin errores contra el catálogo actual; pantallas con imagen admisible y existente; botón sólo con un
 *    destino válido y público (nada de /api, /upayp1b4…).
 *  · No se exponen enlaces de afiliado ni datos internos: sólo ids (la tarjeta de producto ya existente pinta el resto).
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { CLIENT_IMAGES_DIR, IMAGES_DIR } from '../paths';
import { readSections } from '../sections';
import type { Block, HomeMode, PublishedLayout } from './types';
import { evaluateHomeMode, envEnabled, HOME_LAYOUT_STAGE_ENABLED, readHomeLayout, type ReadResult } from './store';
import { readActivation, type ActivationRead } from './activationStore';
import { readStories, type StoriesRead } from './storiesStore';
import { selectActiveVersion } from './activation';
import { findCategory, loadSources, type ReferenceSources } from './sources';
import { resolveBlocks, type ResolvedBlock } from './resolve';
import { checkStories, type Story } from './stories';
import { isPublicSafeExternalUrl, isPublicSafeImage, isPublicSafePath } from './publicSafety';

export interface PublicEditorial {
  variant?: 'hero' | 'campaign' | 'guide' | 'trust';
  eyebrow?: string;
  kicker?: string;
  imageUrl2?: string;
  items?: Array<{ title: string; text?: string }>;
  headline: string;
  text?: string;
  imageUrl?: string;
  buttonLabel?: string;
  /** Enlace ya comprobado (interno o https); sin él no se pinta el botón. */
  href?: string;
  external?: boolean;
}
export interface PublicBlock {
  id: string;
  modality: Block['modality'];
  format: Block['format'];
  width: number;
  title: string;
  card: Block['card'];
  /** Ids de productos a pintar con la tarjeta existente (banner = 1, cuadrícula = 4, carrusel = todos). */
  productIds: string[];
  featured?: boolean;
  section?: { id: string; description?: string; speed: string; position: 'above' | 'below' };
  editorial?: PublicEditorial;
  categories?: Array<{ id: string; name: string; href: string; icon?: string; subs: number }>;
  /** Rediseño: subtítulo y enlace «Ver todo ›» del título del bloque (sólo si el destino es válido). */
  subtitle?: string;
  seeAll?: string;
}
export interface PublicStoryScreen {
  image: string;
  title: string;
  text?: string;
  buttonLabel?: string;
  href?: string;
  duration: number;
}
export interface PublicStory {
  id: string;
  name: string;
  cover: string;
  screens: PublicStoryScreen[];
}
export type PublicHome =
  | { mode: 'legacy'; reason: string }
  | { mode: 'layout'; version: number; publishedAt: string; top: PublicBlock[]; bottom: PublicBlock[]; stories: PublicStory[]; independent: boolean };

export interface PublicDeps {
  env?: Record<string, string | undefined>;
  stageEnabled?: boolean;
  layout?: () => ReadResult;
  activation?: () => ActivationRead;
  stories?: () => StoriesRead;
  sources?: () => ReferenceSources;
  sectionDescriptions?: () => Map<string, string>;
  imageExists?: (localPath: string) => boolean;
}

const legacy = (reason: string): PublicHome => ({ mode: 'legacy', reason });
const MAX_PUBLIC_STORIES = 20;

/** ¿Existe en disco la imagen propia (volumen de imágenes, public/ o dist/client)? */
export function localImageExists(p: string): boolean {
  try {
    const rel = p.split(/[?#]/)[0].replace(/^\/+/, '');
    const roots = [path.join(process.cwd(), 'public'), path.join(process.cwd(), 'dist', 'client')];
    for (const r of roots) if (fs.existsSync(path.join(r, rel))) return true;
    const m = /^images\/products\/([^/]+)$/.exec(rel);
    if (m) return [IMAGES_DIR, CLIENT_IMAGES_DIR].some((d) => fs.existsSync(path.join(d, m[1])));
    return false;
  } catch {
    return false;
  }
}

/**
 * ¿La portada es INDEPENDIENTE del catálogo? Lo es la portada del REDISEÑO: la que usa alguna presentación editorial del rediseño (hero, campaña,
 * guía o confianza) o una lista numerada. Esa portada no pinta el listado general debajo: el catálogo completo vive en `/catalogo` y los enlaces
 * `/?…#catalogo` (y `/#catalogo`) se reescriben a `/catalogo?…`. La portada de la v1 (sin esos elementos) conserva el catálogo debajo y su ancla
 * `#catalogo`, exactamente como hasta ahora.
 */
export function isIndependentFromCatalog(blocks: readonly Block[]): boolean {
  return blocks.some((b) => {
    if (b.format === 'lista') return true;
    if (b.modality !== 'editorial') return false;
    const v = (b.config as { variant?: string }).variant;
    return v === 'hero' || v === 'campaign' || v === 'guide' || v === 'trust';
  });
}

/** `/?category=x#catalogo` → `/catalogo?category=x` (sólo rutas propias del listado; el resto no cambia). */
export function toCatalogHref(href: string): string {
  const m = /^\/\?([^#]*)(#.*)?$/.exec(href);
  if (m) return `/catalogo${m[1] ? `?${m[1]}` : ''}`;
  if (/^\/#catalogo$/.test(href)) return '/catalogo';
  return href;
}

function mapHrefs(b: PublicBlock): PublicBlock {
  return {
    ...b,
    ...(b.seeAll ? { seeAll: toCatalogHref(b.seeAll) } : {}),
    ...(b.editorial?.href && !b.editorial.external ? { editorial: { ...b.editorial, href: toCatalogHref(b.editorial.href) } } : {}),
    ...(b.categories ? { categories: b.categories.map((c) => ({ ...c, href: toCatalogHref(c.href) })) } : {}),
  };
}

const productHref = (id: string) => `/producto/${encodeURIComponent(id)}`;
const categoryHref = (slug: string) => `/?category=${encodeURIComponent(slug)}#destacados`;

/** Destino público válido de un enlace del editor (o undefined). Mismo criterio para botones editoriales y «Ver todo ›». */
function hrefOf(l: { type: string; target: string } | undefined, src: ReferenceSources): { href: string; external: boolean } | undefined {
  if (!l) return undefined;
  if (l.type === 'path' && isPublicSafePath(l.target)) return { href: l.target, external: false };
  if (l.type === 'url' && isPublicSafeExternalUrl(l.target)) return { href: l.target, external: true };
  if (l.type === 'product' && src.products.has(l.target)) return { href: productHref(l.target), external: false };
  if (l.type === 'category') {
    const c = findCategory(src, l.target);
    if (c) return { href: categoryHref(c.slug), external: false };
  }
  if (l.type === 'section' && src.sections.get(l.target)?.published) return { href: `#section-${l.target}`, external: false };
  return undefined;
}

function editorialOf(b: Block, src: ReferenceSources): PublicEditorial {
  const cfg = b.config as { headline: string; text?: string; imageUrl?: string; imageUrl2?: string; buttonLabel?: string; link?: { type: string; target: string }; variant?: string; eyebrow?: string; kicker?: string; items?: Array<{ title: string; text?: string }> };
  const out: PublicEditorial = { headline: cfg.headline };
  if (cfg.variant && cfg.variant !== 'plain') out.variant = cfg.variant as PublicEditorial['variant'];
  if (cfg.eyebrow) out.eyebrow = cfg.eyebrow;
  if (cfg.kicker) out.kicker = cfg.kicker;
  if (cfg.items?.length) out.items = cfg.items.slice(0, 4);
  if (cfg.text) out.text = cfg.text;
  if (cfg.imageUrl && isPublicSafeImage(cfg.imageUrl)) out.imageUrl = cfg.imageUrl;
  if (cfg.imageUrl2 && isPublicSafeImage(cfg.imageUrl2)) out.imageUrl2 = cfg.imageUrl2;
  const target = cfg.buttonLabel ? hrefOf(cfg.link, src) : undefined;
  const href = target?.href;
  const external = target?.external ?? false;
  if (href) {
    out.href = href;
    out.buttonLabel = cfg.buttonLabel;
    if (external) out.external = true;
  }
  return out;
}

function blockOf(b: Block, rb: ResolvedBlock, src: ReferenceSources, descriptions: Map<string, string>): PublicBlock | null {
  const core = blockCore(b, rb, src, descriptions);
  if (!core) return null;
  // Rediseño: subtítulo y «Ver todo ›» (sólo con destino público válido).
  const see = b.modality === 'editorial' ? undefined : hrefOf(b.link, src);
  return { ...core, ...(b.subtitle && b.modality !== 'editorial' ? { subtitle: b.subtitle } : {}), ...(see ? { seeAll: see.href } : {}) };
}

function blockCore(b: Block, rb: ResolvedBlock, src: ReferenceSources, descriptions: Map<string, string>): PublicBlock | null {
  const base = { id: b.id, modality: b.modality, format: b.format, width: b.width, title: b.title, card: b.card };
  const presentable = (ids: string[]) => ids.filter((id) => {
    const p = src.products.get(id);
    return Boolean(p && p.title && p.price !== null);
  });
  const limitFor = (ids: string[]) => (b.format === 'banner' ? ids.slice(0, 1) : b.format === 'cuadricula2x2' ? ids.slice(0, 4) : b.format === 'lista' ? ids.slice(0, 10) : ids);

  if (b.modality === 'editorial') return { ...base, productIds: [], editorial: editorialOf(b, src) };
  if (b.modality === 'seccion') {
    const s = src.sections.get(b.refs[0]?.id ?? '');
    if (!s || !s.published) return null;
    const ids = s.productIds.filter((id) => src.products.has(id));
    if (!ids.length) return null;
    return { ...base, productIds: ids, section: { id: s.id, ...(descriptions.get(s.id) ? { description: descriptions.get(s.id) } : {}), speed: s.speed, position: s.position } };
  }
  if (b.modality === 'automatica') {
    const ids = limitFor(presentable(rb.selection?.status === 'ok' ? rb.selection.ids : []));
    return ids.length ? { ...base, productIds: ids, ...(b.format === 'banner' ? { featured: true } : {}) } : null;
  }
  // manual
  if (b.card === 'categoria') {
    const cats = b.refs
      .filter((r) => r.kind === 'category')
      .map((r) => findCategory(src, r.id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .map((c) => ({ id: c.id, name: c.name, href: categoryHref(c.slug), ...(c.icon ? { icon: c.icon } : {}), subs: [...src.categories.values()].filter((x) => x.parentId === c.id).length }));
    return cats.length ? { ...base, productIds: [], categories: cats } : null;
  }
  if (b.card !== 'producto') return null;
  const ids = limitFor(presentable(b.refs.filter((r) => r.kind === 'product').map((r) => r.id)));
  return ids.length ? { ...base, productIds: ids, ...(b.format === 'banner' ? { featured: true } : {}) } : null;
}

/** Historias para la web: publicadas, sin errores contra el catálogo actual, con pantallas e imágenes verificadas y destinos seguros. */
export function publicStories(stories: readonly Story[], src: ReferenceSources, imageExists: (p: string) => boolean = localImageExists): PublicStory[] {
  const issues = checkStories(stories, src);
  const broken = new Set(issues.filter((i) => i.severity === 'error').map((i) => i.storyId));
  const out: PublicStory[] = [];
  for (const s of stories) {
    if (s.status !== 'publicada' || broken.has(s.id)) continue;
    const screens: PublicStoryScreen[] = [];
    for (const sc of s.screens) {
      if (!isPublicSafeImage(sc.image)) continue;
      if (sc.image.startsWith('/') && !imageExists(sc.image)) continue;
      let href: string | undefined;
      const l = sc.link;
      if (l) {
        if (l.type === 'product' && src.products.has(l.target)) href = productHref(l.target);
        else if (l.type === 'category') {
          const c = findCategory(src, l.target);
          if (c) href = categoryHref(c.slug);
        } else if (l.type === 'campaign' && isPublicSafePath(l.target)) href = l.target;
      }
      if (!sc.title && !sc.text && !href) continue;
      screens.push({ image: sc.image, title: sc.title, ...(sc.text ? { text: sc.text } : {}), ...(href && sc.buttonLabel ? { buttonLabel: sc.buttonLabel, href } : {}), duration: sc.duration });
    }
    if (screens.length) out.push({ id: s.id, name: s.name, cover: screens[0].image, screens });
    if (out.length >= MAX_PUBLIC_STORIES) break;
  }
  return out;
}

/** Plan de la portada pública. No lanza ni escribe. */
export function buildPublicHome(deps: PublicDeps = {}): PublicHome {
  try {
    const env = deps.env ?? process.env;
    const stage = deps.stageEnabled ?? HOME_LAYOUT_STAGE_ENABLED;
    if (!stage || !envEnabled(env)) return legacy('candado_cerrado');
    const read = (deps.layout ?? readHomeLayout)();
    const act = (deps.activation ?? readActivation)();
    const mode: HomeMode = evaluateHomeMode(read, env, stage, act);
    if (mode !== 'layout') return legacy('no_activada');
    const version: PublishedLayout | null = selectActiveVersion(read.doc, act.doc);
    if (!version) return legacy('version_fijada_no_disponible');

    return composeHome(version.blocks, { version: version.version, publishedAt: version.publishedAt }, deps);
  } catch {
    return legacy('error_interno');
  }
}

/**
 * Compone el plan público de UNOS bloques concretos con la MISMA lógica que la web (visibilidad, selección automática, secciones, historias y
 * enlaces). Lo usa `buildPublicHome` (versión fijada) y la vista previa del editor (bloques del borrador, guardados o no). No lanza ni escribe.
 */
export function composeHome(blocks: readonly Block[], meta: { version: number; publishedAt: string }, deps: PublicDeps = {}): PublicHome {
  try {
    const src = (deps.sources ?? loadSources)();
    if (src.status.products.status === 'error') return legacy('catalogo_no_disponible');
    const descriptions = (deps.sectionDescriptions ?? (() => new Map(readSections().filter((s) => s.description).map((s) => [s.id, String(s.description)]))))();
    const resolved = resolveBlocks([...blocks], src, { runAutomatic: true }).blocks;
    const rbById = new Map(resolved.map((r) => [r.id, r]));

    const top: PublicBlock[] = [];
    const bottom: PublicBlock[] = [];
    const seenSections = new Set<string>();
    const referenced = new Set<string>();
    for (const b of blocks) {
      if (b.modality === 'seccion' && b.refs[0]) referenced.add(b.refs[0].id);
      const rb = rbById.get(b.id);
      if (!b.visible || !rb || rb.visible !== true) continue;
      const pb = blockOf(b, rb, src, descriptions);
      if (!pb) continue;
      if (pb.section) {
        if (seenSections.has(pb.section.id)) continue; // una sección sólo se pinta una vez (los id del DOM no se duplican)
        seenSections.add(pb.section.id);
        (pb.section.position === 'above' ? top : bottom).push(pb);
      } else top.push(pb);
    }
    // Secciones publicadas que ningún bloque referencia: se conservan donde estaban (sin duplicar).
    for (const s of [...src.sectionList].sort((a, b) => a.order - b.order)) {
      if (!s.published || referenced.has(s.id) || seenSections.has(s.id)) continue;
      const ids = s.productIds.filter((id) => src.products.has(id));
      if (!ids.length) continue;
      const pb: PublicBlock = {
        id: `seccion-${s.id}`, modality: 'seccion', format: 'carrusel', width: 12, title: s.title, card: 'producto', productIds: ids,
        section: { id: s.id, ...(descriptions.get(s.id) ? { description: descriptions.get(s.id) } : {}), speed: s.speed, position: s.position },
      };
      (s.position === 'above' ? top : bottom).push(pb);
    }
    if (!top.length && !bottom.length) return legacy('sin_contenido_visible');

    let stories: PublicStory[] = [];
    try {
      const sr = (deps.stories ?? readStories)();
      if (sr.status === 'ok') stories = publicStories(sr.doc.draft.stories, src, deps.imageExists);
    } catch {
      stories = [];
    }
    const independent = isIndependentFromCatalog(blocks);
    if (independent) stories = stories.map((st) => ({ ...st, screens: st.screens.map((sc) => (sc.href ? { ...sc, href: toCatalogHref(sc.href) } : sc)) }));
    const fin = (list: PublicBlock[]) => (independent ? list.map(mapHrefs) : list);
    return { mode: 'layout', version: meta.version, publishedAt: meta.publishedAt, top: fin(top), bottom: fin(bottom), stories, independent };
  } catch {
    return legacy('error_interno');
  }
}
