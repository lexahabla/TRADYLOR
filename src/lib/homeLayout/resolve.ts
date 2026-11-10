/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · RESOLUCIÓN DE REFERENCIAS (etapa 2, funciones puras)
 * ==============================================================================
 * Comprueba, SIN escribir nada, que lo que referencia un bloque existe y se puede presentar. Las fuentes llegan inyectadas (`ReferenceSources`),
 * así que las funciones son puras y se prueban con datos sintéticos.
 *
 * Gravedad:
 *  · error   — la referencia no se puede resolver (producto inexistente o retirado, sección eliminada/no publicada/vacía, categoría inexistente…).
 *  · warning — se puede mostrar pero con datos degradados (sin precio, sin imagen, productos de una sección rotos, comercio sin productos…).
 *  · info    — dato a tener en cuenta que NO afecta a la visibilidad (sin stock, selección automática sin evaluar…).
 *
 * `visible` (¿se mostraría este bloque?) combina la validez de las referencias y el mínimo del formato visual:
 *  · true  — hay suficientes elementos presentables para el formato (banner 1, carrusel 1, cuadrícula 2×2 → 4) y el bloque no está oculto.
 *  · false — oculto por el administrador, sin contenido válido, por debajo del mínimo del formato o con un enlace editorial roto.
 *  · null  — modalidad automática con reglas válidas: depende de una selección que NO se ejecuta todavía.
 * La falta de stock NUNCA oculta un producto: el catálogo no tiene un dato de stock fiable para todas las plataformas.
 * «Presentable» = producto con título y precio utilizable (la falta de imagen sólo avisa).
 * Etapa 5: con `{ runAutomatic: true }` la modalidad automática EJECUTA su selección (`automatic.ts`, sólo lectura) y su visibilidad deja de
 * ser desconocida salvo que la selección no sea ejecutable («más recientes» sin fecha de alta fiable). Sin esa opción el comportamiento es el
 * de la etapa 2 (selección sin ejecutar, `visible = null`).
 * ==============================================================================
 */

import type { Block, ContentRef, Format } from './types';
import { findCategory, type ProductInfo, type ReferenceSources, type SectionInfo } from './sources';
import { runAutomatic, type AutoResult } from './automatic';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  ref?: ContentRef;
}

export interface ResolvedRef {
  kind: ContentRef['kind'];
  id: string;
  status: 'ok' | 'missing' | 'retired' | 'unpublished' | 'empty' | 'unavailable';
  /** Nombre legible (título, nombre de categoría…). Nunca datos internos. */
  label?: string;
  issues: Issue[];
}

export interface ResolvedBlock {
  id: string;
  modality: Block['modality'];
  format: Format;
  width: number;
  title: string;
  visible: boolean | null;
  /** Elementos referenciados y cuántos son presentables. */
  items: number;
  valid: number;
  refs: ResolvedRef[];
  issues: Issue[];
  /** Sólo con `runAutomatic`: resultado de la selección automática (ids ordenados y, si procede, la explicación). */
  selection?: AutoResult;
}

export interface ResolveOptions {
  runAutomatic?: boolean;
}

export interface ResolvedTotals {
  blocks: number;
  visible: number;
  hidden: number;
  unknown: number;
  errors: number;
  warnings: number;
  info: number;
}

/** Elementos presentables mínimos por formato para que el bloque se muestre. */
export const FORMAT_MIN_ITEMS: Record<Format, number> = { banner: 1, cuadricula2x2: 4, carrusel: 1 };

const MAX_ISSUES_PER_BLOCK = 50;

const issue = (severity: Severity, code: string, message: string, ref?: ContentRef): Issue => ({ severity, code, message, ...(ref ? { ref } : {}) });

/** Producto con título y precio utilizable. */
export const isPresentable = (p: ProductInfo | undefined): p is ProductInfo => Boolean(p && p.title && p.price !== null);

function resolveProduct(id: string, src: ReferenceSources): ResolvedRef {
  const ref: ContentRef = { kind: 'product', id };
  const p = src.products.get(id);
  if (!p) {
    const retired = src.retiredIds.has(id);
    return {
      kind: 'product',
      id,
      status: retired ? 'retired' : 'missing',
      issues: [issue('error', retired ? 'product_retired' : 'product_not_found', retired ? 'El producto fue retirado del catálogo' : 'El producto no existe en el catálogo', ref)],
    };
  }
  const issues: Issue[] = [];
  if (!p.title) issues.push(issue('warning', 'product_without_title', 'El producto no tiene título', ref));
  if (p.price === null) issues.push(issue('warning', 'product_without_price', 'El producto no tiene precio utilizable: no cuenta como presentable', ref));
  if (!p.hasImage) issues.push(issue('warning', 'product_without_image', 'El producto no tiene imagen', ref));
  if (p.linkStatus === 'inactive' || p.linkStatus === 'broken') issues.push(issue('warning', 'product_link_inactive', 'El enlace de salida del producto figura como inactivo', ref));
  if (p.inStock === false) issues.push(issue('info', 'product_out_of_stock', 'El comercio indica que no hay stock (no se oculta)', ref));
  return { kind: 'product', id, status: 'ok', label: p.title || id, issues };
}

function resolveCategory(id: string, src: ReferenceSources): ResolvedRef {
  const ref: ContentRef = { kind: 'category', id };
  const c = findCategory(src, id);
  if (!c) return { kind: 'category', id, status: 'missing', issues: [issue('error', 'category_not_found', 'La categoría no existe', ref)] };
  return { kind: 'category', id, status: 'ok', label: c.name, issues: [] };
}

function sectionProducts(s: SectionInfo, src: ReferenceSources) {
  const existing = s.productIds.filter((pid) => src.products.has(pid));
  const presentable = existing.filter((pid) => isPresentable(src.products.get(pid)));
  return { existing, presentable };
}

function resolveSection(id: string, src: ReferenceSources): { ref: ResolvedRef; presentable: number } {
  const ref: ContentRef = { kind: 'section', id };
  const s = src.sections.get(id);
  if (!s) return { ref: { kind: 'section', id, status: 'missing', issues: [issue('error', 'section_not_found', 'La sección no existe (¿eliminada?)', ref)] }, presentable: 0 };
  const issues: Issue[] = [];
  if (!s.published) {
    return { ref: { kind: 'section', id, status: 'unpublished', label: s.title, issues: [issue('error', 'section_unpublished', 'La sección no está publicada', ref)] }, presentable: 0 };
  }
  const { existing, presentable } = sectionProducts(s, src);
  if (existing.length === 0) {
    return { ref: { kind: 'section', id, status: 'empty', label: s.title, issues: [issue('error', 'section_empty', 'La sección no tiene ningún producto existente', ref)] }, presentable: 0 };
  }
  const missing = s.productIds.length - existing.length;
  if (missing > 0) issues.push(issue('warning', 'section_products_missing', `${missing} de ${s.productIds.length} productos de la sección ya no existen`, ref));
  const unpresentable = existing.length - presentable.length;
  if (unpresentable > 0) issues.push(issue('warning', 'section_products_incomplete', `${unpresentable} productos de la sección no tienen precio utilizable`, ref));
  if (presentable.length === 0) issues.push(issue('error', 'section_without_presentable_products', 'Ningún producto de la sección es presentable', ref));
  return { ref: { kind: 'section', id, status: presentable.length ? 'ok' : 'empty', label: s.title, issues }, presentable: presentable.length };
}

/** Valida las reglas de la modalidad automática (existencia de categoría, subcategoría y comercio). NO selecciona productos. */
function checkAutomaticRules(block: Block, src: ReferenceSources): Issue[] {
  const rules = (block.config as { rules?: { categoryId?: string; subcategoryId?: string; merchant?: string } }).rules ?? {};
  const out: Issue[] = [];
  let parentId: string | undefined;
  if (rules.categoryId) {
    const c = findCategory(src, rules.categoryId);
    if (!c) out.push(issue('error', 'category_not_found', 'La categoría de la regla no existe', { kind: 'category', id: rules.categoryId }));
    else parentId = c.id;
  }
  if (rules.subcategoryId) {
    const sub = findCategory(src, rules.subcategoryId);
    if (!sub) out.push(issue('error', 'subcategory_not_found', 'La subcategoría de la regla no existe', { kind: 'category', id: rules.subcategoryId }));
    else if (!sub.parentId) out.push(issue('error', 'subcategory_not_a_subcategory', 'La «subcategoría» indicada es una categoría principal', { kind: 'category', id: rules.subcategoryId }));
    else if (parentId && sub.parentId !== parentId) out.push(issue('error', 'subcategory_parent_mismatch', 'La subcategoría no pertenece a la categoría indicada', { kind: 'category', id: rules.subcategoryId }));
  }
  if (rules.merchant && (src.networks.get(rules.merchant.toLowerCase()) ?? 0) === 0) {
    out.push(issue('warning', 'merchant_without_products', `El comercio «${rules.merchant}» no tiene productos en el catálogo`));
  }
  return out;
}

function checkEditorialLink(block: Block, src: ReferenceSources): Issue[] {
  const link = (block.config as { link?: { type: string; target: string } }).link;
  if (!link) return [];
  if (link.type === 'product' && !src.products.has(link.target)) return [issue('error', 'editorial_link_target_missing', 'El enlace apunta a un producto que no existe', { kind: 'product', id: link.target })];
  if (link.type === 'category' && !findCategory(src, link.target)) return [issue('error', 'editorial_link_target_missing', 'El enlace apunta a una categoría que no existe', { kind: 'category', id: link.target })];
  if (link.type === 'section') {
    const s = src.sections.get(link.target);
    if (!s) return [issue('error', 'editorial_link_target_missing', 'El enlace apunta a una sección que no existe', { kind: 'section', id: link.target })];
    if (!s.published) return [issue('error', 'editorial_link_target_unpublished', 'El enlace apunta a una sección no publicada', { kind: 'section', id: link.target })];
  }
  return [];
}

/** Resuelve un bloque YA validado por `validate.ts`. Puro: no escribe ni lee nada fuera de `src`. */
export function resolveBlock(block: Block, src: ReferenceSources, opts: ResolveOptions = {}): ResolvedBlock {
  const refs: ResolvedRef[] = [];
  const issues: Issue[] = [];
  let valid = 0;
  let items = block.refs.length;
  let visible: boolean | null;
  let selection: AutoResult | undefined;

  switch (block.modality) {
    case 'manual': {
      for (const r of block.refs) {
        if (r.kind === 'product') {
          const x = resolveProduct(r.id, src);
          refs.push(x);
          if (x.status === 'ok' && isPresentable(src.products.get(r.id))) valid++;
        } else if (r.kind === 'category') {
          const x = resolveCategory(r.id, src);
          refs.push(x);
          if (x.status === 'ok') valid++;
        } else {
          // Las promociones aún no tienen fuente de datos (las campañas se hacen con la modalidad editorial).
          refs.push({ kind: r.kind, id: r.id, status: 'unavailable', issues: [issue('error', 'promotion_source_unavailable', 'Todavía no existe una fuente de promociones para resolver esta referencia', r)] });
        }
      }
      break;
    }
    case 'seccion': {
      const r = block.refs[0];
      const res = resolveSection(r.id, src);
      refs.push(res.ref);
      valid = res.presentable;
      items = src.sections.get(r.id)?.productIds.length ?? 0;
      break;
    }
    case 'editorial': {
      items = 1;
      valid = 1;
      issues.push(...checkEditorialLink(block, src));
      break;
    }
    case 'automatica': {
      items = 0;
      issues.push(...checkAutomaticRules(block, src));
      if (!opts.runAutomatic) {
        issues.push(issue('info', 'auto_selection_not_evaluated', 'La selección automática todavía no se ejecuta: la visibilidad se desconoce'));
        break;
      }
      const rules = (block.config as { rules: Parameters<typeof runAutomatic>[0] }).rules;
      selection = runAutomatic(rules, src);
      items = selection.ids.length;
      valid = selection.ids.filter((id) => isPresentable(src.products.get(id))).length;
      if (selection.status === 'ok') {
        issues.push(issue('info', 'auto_selection_ok', `La selección devuelve ${items} producto(s)${valid < items ? ` (${items - valid} sin precio utilizable)` : ''}`));
      } else if (selection.status === 'vacio') {
        issues.push(issue('warning', 'auto_selection_empty', selection.message ?? 'La selección no devuelve productos'));
      } else if (selection.status === 'no_ejecutable') {
        issues.push(issue('warning', 'auto_selection_not_executable', selection.message ?? 'La selección no se puede ejecutar'));
      }
      // `reglas_invalidas`: ya informado como error por `checkAutomaticRules` (no se duplica).
      break;
    }
  }

  const refIssues = refs.flatMap((r) => r.issues);
  const blockingBlockIssue = issues.some((i) => i.severity === 'error');
  const min = FORMAT_MIN_ITEMS[block.format];

  if (!block.visible) {
    issues.push(issue('info', 'block_hidden_by_admin', 'El bloque está oculto por el administrador'));
    visible = false;
  } else if (block.modality === 'automatica' && !opts.runAutomatic) {
    visible = blockingBlockIssue ? false : null;
  } else if (block.modality === 'automatica') {
    if (blockingBlockIssue || selection?.status === 'vacio') visible = false;
    else if (selection?.status === 'no_ejecutable') visible = null;
    else if (valid === 0) {
      issues.push(issue('warning', 'block_without_valid_content', 'Ningún producto de la selección es presentable: el bloque no se mostraría'));
      visible = false;
    } else if (valid < min) {
      issues.push(issue('warning', 'below_format_minimum', `El formato necesita al menos ${min} elementos presentables (hay ${valid}): el bloque no se mostraría`));
      visible = false;
    } else visible = true;
  } else if (block.modality === 'editorial') {
    visible = !blockingBlockIssue;
  } else if (valid === 0) {
    issues.push(issue('error', 'block_without_valid_content', 'El bloque no tiene ningún elemento presentable'));
    visible = false;
  } else if (valid < min) {
    issues.push(issue('warning', 'below_format_minimum', `El formato necesita al menos ${min} elementos presentables (hay ${valid}): el bloque no se mostraría`));
    visible = false;
  } else {
    visible = true;
  }

  const all = [...issues, ...refIssues];
  return {
    id: block.id,
    modality: block.modality,
    format: block.format,
    width: block.width,
    title: block.title,
    visible,
    items,
    valid,
    refs,
    issues: all.slice(0, MAX_ISSUES_PER_BLOCK),
    ...(selection ? { selection } : {}),
  };
}

export function resolveBlocks(blocks: Block[], src: ReferenceSources, opts: ResolveOptions = {}): { blocks: ResolvedBlock[]; totals: ResolvedTotals } {
  const resolved = blocks.map((b) => resolveBlock(b, src, opts));
  const totals: ResolvedTotals = { blocks: resolved.length, visible: 0, hidden: 0, unknown: 0, errors: 0, warnings: 0, info: 0 };
  for (const b of resolved) {
    if (b.visible === true) totals.visible++;
    else if (b.visible === false) totals.hidden++;
    else totals.unknown++;
    for (const i of b.issues) {
      if (i.severity === 'error') totals.errors++;
      else if (i.severity === 'warning') totals.warnings++;
      else totals.info++;
    }
  }
  return { blocks: resolved, totals };
}
