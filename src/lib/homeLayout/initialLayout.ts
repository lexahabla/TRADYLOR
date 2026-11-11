/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · PORTADA INICIAL Y REDISEÑO (funciones PURAS)
 * ==============================================================================
 * `planInitialLoad` encadena las decisiones EXISTENTES (`planPublish` y `planActivate`): guarda los bloques como borrador, publica la v1 y la FIJA/activa
 * internamente. Sólo sobre una portada VIRGEN (sin borrador, versión publicada, historial ni activación): nunca sobrescribe. La web pública no cambia
 * hasta que el servidor tenga `HOME_LAYOUT_ENABLED=true`.
 *
 * `planDesignLoad` (rediseño de las maquetas v4) sustituye SÓLO el borrador por el nuevo diseño cuando el borrador es exactamente la primera portada
 * inicial sin modificar (o está vacío y ya hay una versión publicada): no publica ni activa nada y no pisa cambios del administrador.
 *
 * Los bloques salen de `buildInitialBlocks`: reglas AUTOMÁTICAS sobre el catálogo real y categorías/imágenes de productos reales (`deriveInitialContext`);
 * nada de productos, precios, descuentos ni valoraciones fijos. Si algún bloque no se puede mostrar con los datos reales se rechaza sin escribir nada.
 * ==============================================================================
 */

import type { Block, LayoutDocument } from './types';
import { activationRevision, nextStamp, planActivate, type ActivationCheck, type ActivationDocument } from './activation';
import { planPublish, type BlockingIssue } from './publish';
import { revisionOf } from './draft';
import { validateBlocks } from './validate';
import { runAutomatic } from './automatic';
import type { ReferenceSources } from './sources';
import { isPublicSafeImage } from './publicSafety';
import { emptyBackupsDocument, protectDraft, type BackupsDocument } from './draftBackups';

/** Primera portada inicial (v1, ya publicada en producción). Se conserva para reconocer un borrador SIN modificar y ofrecer el rediseño sin pisar cambios. */
export const LEGACY_V1_BLOCKS: Block[] = [
  { id: 'bienvenida', modality: 'editorial', format: 'banner', width: 12, title: 'Bienvenida', card: 'promocion', visible: true, refs: [], config: { headline: 'Compara antes de comprar', text: 'Reunimos los datos que publican las tiendas —precio, envío y especificaciones— con su fecha de captura, para que decidas con la información delante.', buttonLabel: 'Ver todo el catálogo', link: { type: 'path', target: '/#catalogo' } } },
  { id: 'categorias', modality: 'manual', format: 'carrusel', width: 12, title: 'Explora por categoría', card: 'categoria', visible: true, config: {}, refs: [{ kind: 'category', id: 'portabilidad' }, { kind: 'category', id: 'informatica' }, { kind: 'category', id: 'sonido' }, { kind: 'category', id: 'hogar' }] },
  { id: 'mas-economicos', modality: 'automatica', format: 'cuadricula2x2', width: 6, title: 'Los más económicos', card: 'producto', visible: true, refs: [], config: { rules: { order: 'precio_asc', limit: 4, onlyWithPrice: true } } },
  { id: 'en-amazon', modality: 'automatica', format: 'cuadricula2x2', width: 6, title: 'Más económicos en Amazon', card: 'producto', visible: true, refs: [], config: { rules: { merchant: 'amazon', order: 'precio_asc', limit: 4, onlyWithPrice: true } } },
  { id: 'portabilidad', modality: 'automatica', format: 'carrusel', width: 12, title: 'Portabilidad, de menor a mayor precio', card: 'producto', visible: true, refs: [], config: { rules: { categoryId: 'portabilidad', order: 'precio_asc', limit: 12, onlyWithPrice: true } } },
  { id: 'informatica', modality: 'automatica', format: 'carrusel', width: 12, title: 'Informática, de menor a mayor precio', card: 'producto', visible: true, refs: [], config: { rules: { categoryId: 'informatica', order: 'precio_asc', limit: 12, onlyWithPrice: true } } },
  { id: 'sonido', modality: 'automatica', format: 'carrusel', width: 12, title: 'Sonido, de menor a mayor precio', card: 'producto', visible: true, refs: [], config: { rules: { categoryId: 'sonido', order: 'precio_asc', limit: 12, onlyWithPrice: true } } },
];

export const MAX_INITIAL_BODY_BYTES = 2 * 1024;

/* ───────────────────────── Diseño de las maquetas v4 (datos reales) ───────────────────────── */

export interface InitialContext {
  /** Hasta 2 imágenes de productos reales del catálogo para el hero. */
  heroImages: string[];
  /** Imagen de un producto real para el banner de guía. */
  guideImage: string | null;
  /** Categorías principales (con productos) para las teselas «Compra por categoría», de más a menos productos (máx. 6). */
  tiles: string[];
  /** Categorías principales con más productos para los carruseles (máx. 3). */
  featured: Array<{ id: string; name: string }>;
}

/** Deriva, sólo con lectura, qué categorías e imágenes reales hay. Nunca lanza con datos vacíos. */
export function deriveInitialContext(src: ReferenceSources): InitialContext {
  const roots = [...src.categories.values()].filter((c) => !c.parentId);
  const counted = roots
    .map((c) => ({ c, ids: runAutomatic({ categoryId: c.id, order: 'precio_desc', limit: 24, onlyWithPrice: true }, src).ids }))
    .filter((x) => x.ids.length > 0)
    .sort((a, b) => b.ids.length - a.ids.length || a.c.name.localeCompare(b.c.name));
  const imageOf = (id: string): string | null => {
    const img = src.products.get(id)?.image;
    return img && isPublicSafeImage(img) ? img : null;
  };
  const images: string[] = [];
  for (const id of counted[0]?.ids ?? []) {
    const i = imageOf(id);
    if (i && !images.includes(i)) images.push(i);
    if (images.length >= 3) break;
  }
  return {
    heroImages: images.slice(0, 2),
    guideImage: images[2] ?? null,
    tiles: counted.slice(0, 6).map((x) => x.c.id),
    featured: counted.slice(0, 3).map((x) => ({ id: x.c.id, name: x.c.name })),
  };
}

const editorial = (id: string, title: string, config: Record<string, unknown>, width: Block['width']): Block => ({
  id, modality: 'editorial', format: 'banner', width, title, card: 'promocion', visible: true, refs: [], config: config as Block['config'],
});

/**
 * Bloques de la portada rediseñada, en el orden de la maqueta: hero + campaña, bajadas de precio (sólo bajadas VERIFICADAS: sin datos el bloque no
 * se muestra), compra por categoría + lista numerada, banner de guía, carruseles por categoría y franja de confianza.
 */
export function buildInitialBlocks(ctx: InitialContext): Block[] {
  const blocks: Block[] = [];
  blocks.push(editorial('hero', 'Portada · presentación', {
    variant: 'hero', eyebrow: 'Compara con datos', headline: 'Compra con datos, no con prisas',
    text: 'Precios con fecha de captura, historial real y alertas cuando baja lo que te interesa.',
    buttonLabel: 'Ver el catálogo', link: { type: 'path', target: '/#catalogo' },
    ...(ctx.heroImages[0] ? { imageUrl: ctx.heroImages[0] } : {}), ...(ctx.heroImages[1] ? { imageUrl2: ctx.heroImages[1] } : {}),
  }, 8));
  blocks.push(editorial('campana', 'Portada · campaña', {
    variant: 'campaign', eyebrow: 'Próxima campaña', kicker: '27·11', headline: 'Black Friday con historial',
    buttonLabel: 'Ver bajadas verificadas', link: { type: 'path', target: '/?deal=1#catalogo' },
  }, 4));
  blocks.push({
    id: 'bajadas', modality: 'automatica', format: 'carrusel', width: 12, title: 'Bajadas de precio', subtitle: 'Sólo bajadas verificadas, con su fecha de captura', card: 'producto', visible: true, refs: [],
    config: { rules: { order: 'descuento_desc', onlyVerifiedDiscount: true, onlyWithPrice: true, limit: 10 } }, link: { type: 'path', target: '/?deal=1#catalogo' },
  });
  if (ctx.tiles.length) {
    blocks.push({
      id: 'categorias', modality: 'manual', format: 'carrusel', width: 6, title: 'Compra por categoría', card: 'categoria', visible: true, config: {},
      refs: ctx.tiles.map((id) => ({ kind: 'category' as const, id })), link: { type: 'path', target: '/categorias' },
    });
  }
  blocks.push({
    id: 'ranking', modality: 'automatica', format: 'lista', width: 6, title: 'Los 5 más económicos', card: 'producto', visible: true, refs: [],
    config: { rules: { order: 'precio_asc', onlyWithPrice: true, limit: 5 } }, link: { type: 'path', target: '/?sort=precio_asc#catalogo' },
  });
  if (ctx.featured[0] && ctx.guideImage) {
    blocks.push(editorial('guia', 'Portada · categoría destacada', {
      variant: 'guide', eyebrow: 'Categoría', headline: ctx.featured[0].name, text: 'Compara los modelos con sus datos reales.',
      buttonLabel: `Ver ${ctx.featured[0].name}`, link: { type: 'category', target: ctx.featured[0].id }, imageUrl: ctx.guideImage,
    }, 12));
  }
  for (const c of ctx.featured) {
    blocks.push({
      id: `cat-${c.id}`.slice(0, 60), modality: 'automatica', format: 'carrusel', width: 12, title: c.name, card: 'producto', visible: true, refs: [],
      config: { rules: { categoryId: c.id, order: 'precio_asc', onlyWithPrice: true, limit: 10 } }, link: { type: 'category', target: c.id },
    });
  }
  blocks.push(editorial('confianza', 'Portada · confianza', {
    variant: 'trust', headline: 'Por qué Treidilor',
    items: [
      { title: 'Fecha en cada precio', text: 'Mostramos cuándo se capturó cada dato.' },
      { title: 'Historial real', text: 'Sin puntos inventados: 1, 3, 6 y 12 meses.' },
      { title: 'Alertas de precio', text: 'Te avisamos cuando alcanza tu objetivo.' },
      { title: '0 € de cargo propio', text: 'Puede haber comisión de afiliación.' },
    ],
  }, 12));
  return blocks;
}

/* ───────────────────────── Carga sobre portada virgen ───────────────────────── */

export type InitialReason =
  | 'peticion_invalida' | 'confirmacion_requerida' | 'archivo_protegido' | 'activacion_protegida' | 'conflicto' | 'ya_existe_borrador'
  | 'ya_hay_versiones' | 'activacion_existente' | 'referencias_bloqueantes' | 'documento_invalido' | 'sin_cambios' | 'limite_copias';
export type InitialRefusal = { ok: false; reason: InitialReason; errors: string[]; blocking?: BlockingIssue[] };
export type InitialPlan = { ok: true; layout: LayoutDocument; activation: ActivationDocument; version: number; warnings: BlockingIssue[] } | InitialRefusal;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const protectedStatus = (s: string) => s === 'corrupt' || s === 'invalid' || s === 'newer';

/** ¿Se puede cargar la portada inicial? (portada virgen). Devuelve el motivo si no. No escribe. */
export function initialAvailability(layout: { status: string; doc: LayoutDocument }, act: { status: string; doc: ActivationDocument }): { available: true } | { available: false; reason: InitialReason; message: string } {
  if (protectedStatus(layout.status)) return { available: false, reason: 'archivo_protegido', message: `El almacenamiento de la portada está en estado «${layout.status}»: se conserva sin tocar` };
  if (protectedStatus(act.status)) return { available: false, reason: 'activacion_protegida', message: `El archivo de activación está en estado «${act.status}»: se conserva sin tocar` };
  if (layout.doc.draft.updatedAt !== null || layout.doc.draft.blocks.length) return { available: false, reason: 'ya_existe_borrador', message: 'Ya existe un borrador guardado: no se sobrescribe nada' };
  if (layout.doc.published || layout.doc.versions.length) return { available: false, reason: 'ya_hay_versiones', message: 'Ya existen versiones publicadas: no se sobrescribe nada' };
  if (act.doc.active || act.doc.pinnedVersion !== null || act.doc.updatedAt !== null || layout.doc.activation.enabled) return { available: false, reason: 'activacion_existente', message: 'Ya existe una activación: no se sobrescribe nada' };
  return { available: true };
}

/**
 * Cuerpo esperado: { action:'load_initial', baseRevision (revisión del borrador que viste), baseActivation (revisión de la activación), confirm:true }.
 * `check` = comprobación con datos actuales (ver `checkForActivation`). No escribe.
 */
export function planInitialLoad(
  layout: { status: string; doc: LayoutDocument },
  act: { status: string; doc: ActivationDocument },
  input: unknown,
  check: (blocks: readonly Block[]) => ActivationCheck,
  now: Date,
  by: string,
  initialBlocks: readonly Block[],
): InitialPlan {
  const bad = (errors: string[], reason: InitialReason = 'peticion_invalida'): InitialRefusal => ({ ok: false, reason, errors });
  if (!isObj(input)) return bad(['El cuerpo debe ser un objeto']);
  const extra = Object.keys(input).filter((k) => !['action', 'baseRevision', 'baseActivation', 'confirm'].includes(k));
  if (extra.length) return bad([`Campos no admitidos: ${extra.slice(0, 5).join(', ')}`]);
  if (input.action !== 'load_initial') return bad(['action debe ser load_initial']);
  if (typeof input.baseRevision !== 'string' || !input.baseRevision || input.baseRevision.length > 64) return bad(['baseRevision es obligatoria']);
  if (typeof input.baseActivation !== 'string' || !input.baseActivation || input.baseActivation.length > 64) return bad(['baseActivation es obligatoria']);
  if (input.confirm !== true) return bad(['La carga exige confirmación explícita (confirm: true)'], 'confirmacion_requerida');
  const av = initialAvailability(layout, act);
  if (!av.available) return bad([av.message], av.reason);
  if (input.baseRevision !== revisionOf(layout.doc.draft.updatedAt) || input.baseActivation !== activationRevision(act.doc)) return bad(['El estado cambió desde que lo viste'], 'conflicto');

  const parsed = validateBlocks(initialBlocks, 'blocks');
  if (!parsed.ok) return bad(parsed.errors.slice(0, 10), 'documento_invalido');
  const blocks = parsed.value;
  const chk = check(blocks);
  if (chk.blocking.length) return { ok: false, reason: 'referencias_bloqueantes', errors: ['La portada inicial no se puede mostrar con los datos actuales'], blocking: chk.blocking };

  // 1) borrador  2) publicar (decisión existente)  3) activar (decisión existente)
  const stamp = nextStamp(layout.doc.draft.updatedAt, now);
  const withDraft: LayoutDocument = { ...layout.doc, draft: { blocks, updatedAt: stamp } };
  const pub = planPublish({ status: 'ok', doc: withDraft }, { action: 'publish', baseRevision: stamp, basePublished: null, confirm: true }, chk.blocking, now);
  if (!pub.ok) return { ok: false, reason: pub.reason === 'referencias_bloqueantes' ? 'referencias_bloqueantes' : 'documento_invalido', errors: pub.errors, ...(pub.blocking ? { blocking: pub.blocking } : {}) };
  const a = planActivate({ status: 'ok', doc: pub.doc }, act, { action: 'activate', version: pub.version, baseRevision: activationRevision(act.doc), confirm: true }, () => chk, now, by);
  if (!a.ok) return { ok: false, reason: a.reason === 'referencias_bloqueantes' ? 'referencias_bloqueantes' : 'documento_invalido', errors: a.errors, ...(a.blocking ? { blocking: a.blocking } : {}) };
  return { ok: true, layout: a.layout, activation: a.doc, version: a.version, warnings: a.warnings };
}

/* ───────────────────────── Rediseño sobre una portada ya publicada ───────────────────────── */

const sameBlocks = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * ¿Se puede cargar el rediseño COMO BORRADOR? Sí, salvo almacenamiento protegido o portada inexistente. Si el borrador tiene contenido propio (distinto
 * de la primera portada inicial sin modificar) `needsBackup` es true: antes de sustituirlo se guarda una copia recuperable (ver `draftBackups.ts`).
 */
export function designAvailability(layout: { status: string; doc: LayoutDocument }): { available: true; needsBackup: boolean } | { available: false; reason: InitialReason; message: string } {
  if (protectedStatus(layout.status)) return { available: false, reason: 'archivo_protegido', message: `El almacenamiento de la portada está en estado «${layout.status}»: se conserva sin tocar` };
  const d = layout.doc.draft;
  if (d.updatedAt === null && !d.blocks.length) {
    return layout.doc.published ? { available: true, needsBackup: false } : { available: false, reason: 'peticion_invalida', message: 'Todavía no hay ninguna portada: usa la carga de la portada inicial' };
  }
  const v1 = validateBlocks(LEGACY_V1_BLOCKS, 'blocks');
  if (v1.ok && sameBlocks(d.blocks, v1.value)) return { available: true, needsBackup: false };
  return { available: true, needsBackup: d.blocks.length > 0 };
}

export type DesignPlan = { ok: true; layout: LayoutDocument; revision: string; warnings: BlockingIssue[]; backups: BackupsDocument | null; backupId: string | null } | InitialRefusal;

/**
 * Cuerpo: { action:'load_design', baseRevision, confirm:true, acknowledgeBackup?:true }. Sustituye SÓLO el borrador (no publica ni activa nada).
 * Si el borrador tiene contenido propio exige `acknowledgeBackup:true` y devuelve en `backups` el documento de copias a escribir ANTES que el borrador.
 */
export function planDesignLoad(
  layout: { status: string; doc: LayoutDocument },
  input: unknown,
  check: (blocks: readonly Block[]) => ActivationCheck,
  now: Date,
  designBlocks: readonly Block[],
  backups: BackupsDocument = emptyBackupsDocument(),
  by = 'admin',
): DesignPlan {
  const bad = (errors: string[], reason: InitialReason = 'peticion_invalida'): InitialRefusal => ({ ok: false, reason, errors });
  if (!isObj(input)) return bad(['El cuerpo debe ser un objeto']);
  const extra = Object.keys(input).filter((k) => !['action', 'baseRevision', 'confirm', 'acknowledgeBackup'].includes(k));
  if (extra.length) return bad([`Campos no admitidos: ${extra.slice(0, 5).join(', ')}`]);
  if (input.action !== 'load_design') return bad(['action debe ser load_design']);
  if (typeof input.baseRevision !== 'string' || !input.baseRevision || input.baseRevision.length > 64) return bad(['baseRevision es obligatoria']);
  if (input.acknowledgeBackup !== undefined && typeof input.acknowledgeBackup !== 'boolean') return bad(['acknowledgeBackup debe ser booleano']);
  if (input.confirm !== true) return bad(['La carga exige confirmación explícita (confirm: true)'], 'confirmacion_requerida');
  const av = designAvailability(layout);
  if (!av.available) return bad([av.message], av.reason);
  if (input.baseRevision !== revisionOf(layout.doc.draft.updatedAt)) return bad(['El borrador cambió desde que lo viste'], 'conflicto');
  if (av.needsBackup && input.acknowledgeBackup !== true) return bad(['El borrador tiene cambios propios: confirma que se guardará una copia antes de sustituirlo (acknowledgeBackup: true)'], 'confirmacion_requerida');
  const parsed = validateBlocks(designBlocks, 'blocks');
  if (!parsed.ok) return bad(parsed.errors.slice(0, 10), 'documento_invalido');
  if (sameBlocks(layout.doc.draft.blocks, parsed.value)) return bad(['El borrador ya es idéntico al nuevo diseño'], 'sin_cambios');
  const chk = check(parsed.value);
  if (chk.blocking.length) return { ok: false, reason: 'referencias_bloqueantes', errors: ['El rediseño no se puede mostrar con los datos actuales'], blocking: chk.blocking };
  let backupDoc: BackupsDocument | null = null;
  let backupId: string | null = null;
  if (av.needsBackup) {
    const prot = protectDraft(backups, layout.doc.draft, 'antes_de_cargar_diseno', now, by);
    if (!prot.ok) return bad(prot.errors, 'limite_copias');
    backupId = prot.id;
    if (prot.created) backupDoc = prot.doc;
  }
  const stamp = nextStamp(layout.doc.draft.updatedAt, now);
  return { ok: true, layout: { ...layout.doc, draft: { blocks: parsed.value, updatedAt: stamp } }, revision: stamp, warnings: chk.warnings, backups: backupDoc, backupId };
}
