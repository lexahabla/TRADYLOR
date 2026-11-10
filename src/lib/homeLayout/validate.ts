/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · VALIDACIÓN (etapa 1, funciones puras)
 * ==============================================================================
 * Valida y NORMALIZA bloques y documentos. No lee ni escribe nada. Las modalidades y los formatos son registros: para añadir uno nuevo basta
 * con registrarlo aquí (no hay que rediseñar el editor).
 *
 * Contenido automático: solo criterios con datos fiables (categoría, subcategoría, comercio, recientes, precio). Los criterios de descuento,
 * bajada de precio, popularidad o ventas se rechazan expresamente: no hay datos que los respalden.
 * ==============================================================================
 */

import {
  AUTO_ORDERS,
  CARD_KINDS,
  FORMATS,
  MODALITIES,
  SCHEMA_VERSION,
  WIDTHS,
  type AutomaticConfig,
  type Block,
  type BlockSet,
  type CardKind,
  type ContentRef,
  type EditorialConfig,
  type Format,
  type LayoutDocument,
  type Modality,
  type PublishedLayout,
  type RefKind,
  type ValidationResult,
  type Width,
} from './types';

export const MAX_BLOCKS = 60;
export const MAX_ITEMS = 24;
export const MAX_VERSIONS = 100;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const REF_ID_RE = /^[^\s<>"'`\\]{1,200}$/;

/** Criterios que NO se admiten en la modalidad automática (sin datos verificables que los justifiquen). */
export const FORBIDDEN_AUTO_CRITERIA = [
  'discount', 'descuento', 'priceDrop', 'price_drop', 'bajada', 'bajadaPrecio', 'popularity', 'popularidad', 'sales', 'ventas', 'bestseller',
  'masVendido', 'trending', 'rating', 'valoracion',
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max ? v.trim() : null);

type Issues = string[];

/* ───────────────────────── Registros ───────────────────────── */

interface ModalitySpec {
  label: string;
  /** Tarjeta que debe usar (o null = cualquiera de las permitidas). */
  cards: readonly CardKind[];
  /** Valida la configuración y las referencias; devuelve la configuración normalizada. */
  check(block: Record<string, unknown>, path: string, issues: Issues, format: Format): { config: Block['config']; refs: ContentRef[] };
}

interface FormatSpec {
  label: string;
  /** Máximo de elementos que muestra (la cuadrícula 2×2 muestra 4). */
  maxItems: number;
}

export const FORMAT_REGISTRY: Record<Format, FormatSpec> = {
  banner: { label: 'Banner', maxItems: MAX_ITEMS },
  cuadricula2x2: { label: 'Cuadrícula 2×2', maxItems: 4 },
  carrusel: { label: 'Carrusel', maxItems: MAX_ITEMS },
};

function parseRefs(raw: unknown, path: string, issues: Issues, allowed: readonly RefKind[], min: number, max: number): ContentRef[] {
  if (raw === undefined) raw = [];
  if (!Array.isArray(raw)) {
    issues.push(`${path}: las referencias deben ser una lista`);
    return [];
  }
  if (raw.length < min || raw.length > max) issues.push(`${path}: debe haber entre ${min} y ${max} referencias (hay ${raw.length})`);
  const out: ContentRef[] = [];
  const seen = new Set<string>();
  raw.forEach((r, i) => {
    if (!isObj(r)) return void issues.push(`${path}[${i}]: referencia no válida`);
    const kind = r.kind as RefKind;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!allowed.includes(kind)) return void issues.push(`${path}[${i}]: tipo de referencia no permitido (${String(r.kind)})`);
    if (!REF_ID_RE.test(id)) return void issues.push(`${path}[${i}]: identificador no válido`);
    const key = `${kind}:${id}`;
    if (seen.has(key)) return void issues.push(`${path}[${i}]: referencia repetida`);
    seen.add(key);
    out.push({ kind, id });
  });
  return out;
}

const REF_BY_CARD: Record<CardKind, RefKind> = { producto: 'product', categoria: 'category', promocion: 'promotion' };

export const MODALITY_REGISTRY: Record<Modality, ModalitySpec> = {
  manual: {
    label: 'Manual',
    cards: CARD_KINDS,
    check(block, path, issues, format) {
      const cfg = block.config;
      if (cfg !== undefined && !(isObj(cfg) && Object.keys(cfg).length === 0)) issues.push(`${path}.config: la modalidad manual no admite configuración`);
      const card = block.card as CardKind;
      const kind = REF_BY_CARD[card] ?? 'product';
      const refs = parseRefs(block.refs, `${path}.refs`, issues, [kind], 1, FORMAT_REGISTRY[format].maxItems);
      return { config: {}, refs };
    },
  },
  automatica: {
    label: 'Automática',
    cards: ['producto'],
    check(block, path, issues, format) {
      const cfg = block.config;
      const out: AutomaticConfig = { rules: { order: 'recientes', limit: 1 } };
      if (!isObj(cfg) || !isObj(cfg.rules)) {
        issues.push(`${path}.config.rules: faltan las reglas`);
      } else {
        const rules = cfg.rules;
        const allowed = new Set(['categoryId', 'subcategoryId', 'merchant', 'order', 'limit', 'onlyWithPrice']);
        for (const key of Object.keys(rules)) {
          if (FORBIDDEN_AUTO_CRITERIA.includes(key)) issues.push(`${path}.config.rules.${key}: criterio no permitido (no hay datos verificables que lo respalden)`);
          else if (!allowed.has(key)) issues.push(`${path}.config.rules.${key}: criterio desconocido`);
        }
        const order = rules.order;
        if (!AUTO_ORDERS.includes(order as never)) issues.push(`${path}.config.rules.order: orden no válido`);
        const limit = Number(rules.limit);
        const maxItems = FORMAT_REGISTRY[format].maxItems;
        if (!Number.isInteger(limit) || limit < 1 || limit > maxItems) issues.push(`${path}.config.rules.limit: debe ser un entero entre 1 y ${maxItems}`);
        for (const k of ['categoryId', 'subcategoryId', 'merchant'] as const) {
          if (rules[k] !== undefined && !(typeof rules[k] === 'string' && REF_ID_RE.test(rules[k] as string))) issues.push(`${path}.config.rules.${k}: valor no válido`);
        }
        if (rules.subcategoryId !== undefined && rules.categoryId === undefined) issues.push(`${path}.config.rules.subcategoryId: requiere una categoría`);
        if (rules.onlyWithPrice !== undefined && typeof rules.onlyWithPrice !== 'boolean') issues.push(`${path}.config.rules.onlyWithPrice: debe ser verdadero o falso`);
        out.rules = {
          order: (AUTO_ORDERS.includes(order as never) ? order : 'recientes') as AutomaticConfig['rules']['order'],
          limit: Number.isInteger(limit) ? limit : 1,
          ...(typeof rules.categoryId === 'string' ? { categoryId: rules.categoryId } : {}),
          ...(typeof rules.subcategoryId === 'string' ? { subcategoryId: rules.subcategoryId } : {}),
          ...(typeof rules.merchant === 'string' ? { merchant: rules.merchant.toLowerCase() } : {}),
          ...(typeof rules.onlyWithPrice === 'boolean' ? { onlyWithPrice: rules.onlyWithPrice } : {}),
        };
      }
      const refs = parseRefs(block.refs, `${path}.refs`, issues, [], 0, 0);
      return { config: out, refs };
    },
  },
  seccion: {
    label: 'Sección',
    cards: ['producto'],
    check(block, path, issues) {
      const cfg = block.config;
      if (cfg !== undefined && !(isObj(cfg) && Object.keys(cfg).length === 0)) issues.push(`${path}.config: la modalidad sección no admite configuración`);
      const refs = parseRefs(block.refs, `${path}.refs`, issues, ['section'], 1, 1);
      return { config: {}, refs };
    },
  },
  editorial: {
    label: 'Editorial',
    cards: ['promocion'],
    check(block, path, issues) {
      const cfg = block.config;
      const out: EditorialConfig = { headline: '' };
      if (!isObj(cfg)) {
        issues.push(`${path}.config: faltan los datos editoriales`);
      } else {
        const headline = str(cfg.headline, 120);
        if (!headline) issues.push(`${path}.config.headline: el titular es obligatorio (máx. 120 caracteres)`);
        out.headline = headline ?? '';
        if (cfg.text !== undefined) {
          const t = str(cfg.text, 400);
          if (!t) issues.push(`${path}.config.text: texto no válido (máx. 400 caracteres)`);
          else out.text = t;
        }
        if (cfg.buttonLabel !== undefined) {
          const b = str(cfg.buttonLabel, 40);
          if (!b) issues.push(`${path}.config.buttonLabel: texto de botón no válido (máx. 40 caracteres)`);
          else out.buttonLabel = b;
        }
        if (cfg.imageUrl !== undefined) {
          const u = typeof cfg.imageUrl === 'string' ? cfg.imageUrl.trim() : '';
          if (!isSafeImageUrl(u)) issues.push(`${path}.config.imageUrl: debe ser una ruta propia (/…) o una URL https`);
          else out.imageUrl = u;
        }
        if (cfg.link !== undefined) {
          const link = parseLink(cfg.link, `${path}.config.link`, issues);
          if (link) out.link = link;
        }
        const known = new Set(['headline', 'text', 'buttonLabel', 'imageUrl', 'link']);
        for (const k of Object.keys(cfg)) if (!known.has(k)) issues.push(`${path}.config.${k}: campo desconocido`);
        if (out.link && !out.buttonLabel) issues.push(`${path}.config.buttonLabel: un enlace necesita texto de botón`);
      }
      const refs = parseRefs(block.refs, `${path}.refs`, issues, [], 0, 0);
      return { config: out, refs };
    },
  },
};

/** Ruta propia o URL https. Nunca `javascript:`, `data:` ni rutas protocolo-relativas. */
export function isSafeImageUrl(u: string): boolean {
  if (!u || u.length > 600) return false;
  if (u.startsWith('/') && !u.startsWith('//') && !/[\s<>"'`\\]/.test(u)) return true;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' && !/[\s<>"'`\\]/.test(u);
  } catch {
    return false;
  }
}

function parseLink(raw: unknown, path: string, issues: Issues) {
  if (!isObj(raw)) return void issues.push(`${path}: enlace no válido`);
  const type = raw.type;
  const target = typeof raw.target === 'string' ? raw.target.trim() : '';
  if (type === 'path') {
    if (!(target.startsWith('/') && !target.startsWith('//') && target.length <= 300 && !/[\s<>"'`\\]/.test(target))) return void issues.push(`${path}.target: ruta no válida (debe empezar por «/»)`);
  } else if (type === 'url') {
    let ok = false;
    try {
      ok = new URL(target).protocol === 'https:' && !/[\s<>"'`\\]/.test(target) && target.length <= 600;
    } catch {
      ok = false;
    }
    if (!ok) return void issues.push(`${path}.target: la URL externa debe ser https`);
  } else if (type === 'product' || type === 'category' || type === 'section') {
    if (!REF_ID_RE.test(target)) return void issues.push(`${path}.target: identificador no válido`);
  } else {
    return void issues.push(`${path}.type: tipo de enlace no válido`);
  }
  return { type, target } as EditorialConfig['link'];
}

/* ───────────────────────── Bloques ───────────────────────── */

export function validateBlock(raw: unknown, path = 'block'): ValidationResult<Block> {
  const issues: Issues = [];
  if (!isObj(raw)) return { ok: false, errors: [`${path}: el bloque debe ser un objeto`] };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_RE.test(id)) issues.push(`${path}.id: identificador no válido (letras, números, «-» y «_»)`);
  const modality = raw.modality as Modality;
  if (!MODALITIES.includes(modality) || !MODALITY_REGISTRY[modality]) issues.push(`${path}.modality: modalidad no válida (${String(raw.modality)})`);
  const format = raw.format as Format;
  if (!FORMATS.includes(format) || !FORMAT_REGISTRY[format]) issues.push(`${path}.format: formato no válido (${String(raw.format)})`);
  const width = raw.width as Width;
  if (!WIDTHS.includes(width)) issues.push(`${path}.width: ancho no válido (${String(raw.width)})`);
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (title.length > 120) issues.push(`${path}.title: demasiado largo (máx. 120)`);
  const card = raw.card as CardKind;
  if (!CARD_KINDS.includes(card)) issues.push(`${path}.card: tarjeta no válida (${String(raw.card)})`);
  if (raw.visible !== undefined && typeof raw.visible !== 'boolean') issues.push(`${path}.visible: debe ser verdadero o falso`);
  const known = new Set(['id', 'modality', 'format', 'width', 'title', 'card', 'config', 'refs', 'visible']);
  for (const k of Object.keys(raw)) if (!known.has(k)) issues.push(`${path}.${k}: campo desconocido`);

  let config: Block['config'] = {};
  let refs: ContentRef[] = [];
  const spec = MODALITY_REGISTRY[modality];
  if (spec && FORMATS.includes(format)) {
    if (CARD_KINDS.includes(card) && !spec.cards.includes(card)) issues.push(`${path}.card: la modalidad ${spec.label} no admite la tarjeta «${card}»`);
    const r = spec.check(raw, path, issues, format);
    config = r.config;
    refs = r.refs;
  }
  if (issues.length) return { ok: false, errors: issues };
  return { ok: true, value: { id, modality, format, width, title, card, config, refs, visible: raw.visible !== false } };
}

export function validateBlocks(raw: unknown, path = 'blocks'): ValidationResult<Block[]> {
  if (!Array.isArray(raw)) return { ok: false, errors: [`${path}: debe ser una lista`] };
  if (raw.length > MAX_BLOCKS) return { ok: false, errors: [`${path}: demasiados bloques (máx. ${MAX_BLOCKS})`] };
  const errors: string[] = [];
  const out: Block[] = [];
  const ids = new Set<string>();
  raw.forEach((b, i) => {
    const r = validateBlock(b, `${path}[${i}]`);
    if (!r.ok) return void errors.push(...r.errors);
    if (ids.has(r.value.id)) return void errors.push(`${path}[${i}].id: identificador repetido (${r.value.id})`);
    ids.add(r.value.id);
    out.push(r.value);
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

/* ───────────────────────── Documento ───────────────────────── */

export function emptyDocument(): LayoutDocument {
  return { schemaVersion: SCHEMA_VERSION, activation: { enabled: false }, draft: { blocks: [], updatedAt: null }, published: null, versions: [] };
}

function validatePublished(raw: unknown, path: string, errors: string[]): PublishedLayout | null {
  if (!isObj(raw)) {
    errors.push(`${path}: debe ser un objeto`);
    return null;
  }
  const local: string[] = [];
  const version = Number(raw.version);
  if (!Number.isInteger(version) || version < 1) local.push(`${path}.version: no válida`);
  const at = typeof raw.publishedAt === 'string' && !Number.isNaN(Date.parse(raw.publishedAt)) ? raw.publishedAt : null;
  if (!at) local.push(`${path}.publishedAt: fecha no válida`);
  const blocks = validateBlocks(raw.blocks, `${path}.blocks`);
  if (!blocks.ok) local.push(...blocks.errors);
  if (local.length || !blocks.ok) {
    errors.push(...local);
    return null;
  }
  return { version, publishedAt: at as string, blocks: blocks.value };
}

export function validateDocument(raw: unknown): ValidationResult<LayoutDocument> {
  if (!isObj(raw)) return { ok: false, errors: ['El documento debe ser un objeto'] };
  const errors: string[] = [];
  if (raw.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion: se esperaba ${SCHEMA_VERSION} (hay ${String(raw.schemaVersion)})`);
  const enabled = isObj(raw.activation) && typeof raw.activation.enabled === 'boolean' ? raw.activation.enabled : null;
  if (enabled === null) errors.push('activation.enabled: debe ser verdadero o falso');

  let draft: BlockSet = { blocks: [], updatedAt: null };
  if (!isObj(raw.draft)) errors.push('draft: debe ser un objeto');
  else {
    const b = validateBlocks(raw.draft.blocks, 'draft.blocks');
    if (!b.ok) errors.push(...b.errors);
    const updatedAt = raw.draft.updatedAt;
    if (updatedAt !== null && !(typeof updatedAt === 'string' && !Number.isNaN(Date.parse(updatedAt)))) errors.push('draft.updatedAt: fecha no válida');
    if (b.ok) draft = { blocks: b.value, updatedAt: (updatedAt as string | null) ?? null };
  }

  let published: PublishedLayout | null = null;
  if (raw.published !== null && raw.published !== undefined) published = validatePublished(raw.published, 'published', errors);

  const versions: PublishedLayout[] = [];
  if (!Array.isArray(raw.versions)) errors.push('versions: debe ser una lista');
  else {
    if (raw.versions.length > MAX_VERSIONS) errors.push(`versions: demasiadas versiones (máx. ${MAX_VERSIONS})`);
    raw.versions.forEach((v, i) => {
      const e: string[] = [];
      const p = validatePublished(v, `versions[${i}]`, e);
      if (e.length) errors.push(...e);
      else if (p) versions.push(p);
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { schemaVersion: SCHEMA_VERSION, activation: { enabled: enabled as boolean }, draft, published, versions } };
}
