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
  categories?: Array<{ id: string; name: string; href: string }>;
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
  | { mode: 'layout'; version: number; publishedAt: string; top: PublicBlock[]; bottom: PublicBlock[]; stories: PublicStory[] };

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

const productHref = (id: string) => `/producto/${encodeURIComponent(id)}`;
const categoryHref = (slug: string) => `/?category=${encodeURIComponent(slug)}#destacados`;

function editorialOf(b: Block, src: ReferenceSources): PublicEditorial {
  const cfg = b.config as { headline: string; text?: string; imageUrl?: string; buttonLabel?: string; link?: { type: string; target: string } };
  const out: PublicEditorial = { headline: cfg.headline };
  if (cfg.text) out.text = cfg.text;
  if (cfg.imageUrl && isPublicSafeImage(cfg.imageUrl)) out.imageUrl = cfg.imageUrl;
  const l = cfg.link;
  let href: string | undefined;
  let external = false;
  if (l && cfg.buttonLabel) {
    if (l.type === 'path' && isPublicSafePath(l.target)) href = l.target;
    else if (l.type === 'url' && isPublicSafeExternalUrl(l.target)) {
      href = l.target;
      external = true;
    } else if (l.type === 'product' && src.products.has(l.target)) href = productHref(l.target);
    else if (l.type === 'category') {
      const c = findCategory(src, l.target);
      if (c) href = categoryHref(c.slug);
    } else if (l.type === 'section' && src.sections.get(l.target)?.published) href = `#section-${l.target}`;
  }
  if (href) {
    out.href = href;
    out.buttonLabel = cfg.buttonLabel;
    if (external) out.external = true;
  }
  return out;
}

function blockOf(b: Block, rb: ResolvedBlock, src: ReferenceSources, descriptions: Map<string, string>): PublicBlock | null {
  const base = { id: b.id, modality: b.modality, format: b.format, width: b.width, title: b.title, card: b.card };
  const presentable = (ids: string[]) => ids.filter((id) => {
    const p = src.products.get(id);
    return Boolean(p && p.title && p.price !== null);
  });
  const limitFor = (ids: string[]) => (b.format === 'banner' ? ids.slice(0, 1) : b.format === 'cuadricula2x2' ? ids.slice(0, 4) : ids);

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
      .map((c) => ({ id: c.id, name: c.name, href: categoryHref(c.slug) }));
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

    const src = (deps.sources ?? loadSources)();
    if (src.status.products.status === 'error') return legacy('catalogo_no_disponible');
    const descriptions = (deps.sectionDescriptions ?? (() => new Map(readSections().filter((s) => s.description).map((s) => [s.id, String(s.description)]))))();
    const resolved = resolveBlocks(version.blocks, src, { runAutomatic: true }).blocks;
    const rbById = new Map(resolved.map((r) => [r.id, r]));

    const top: PublicBlock[] = [];
    const bottom: PublicBlock[] = [];
    const seenSections = new Set<string>();
    const referenced = new Set<string>();
    for (const b of version.blocks) {
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
    return { mode: 'layout', version: version.version, publishedAt: version.publishedAt, top, bottom, stories };
  } catch {
    return legacy('error_interno');
  }
}
