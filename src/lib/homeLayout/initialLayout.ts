/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · CARGA DE LA PORTADA INICIAL (v1) EN UNA SOLA ACCIÓN (funciones PURAS)
 * ==============================================================================
 * Los 7 bloques de la primera portada: bienvenida editorial, tarjetas de categoría y bloques AUTOMÁTICOS sobre el catálogo real (nada de
 * productos, precios, descuentos ni valoraciones fijos). `planInitialLoad` encadena las decisiones EXISTENTES (`planPublish` y `planActivate`):
 * guarda los bloques como borrador, publica la v1 y la FIJA/activa internamente. La web pública NO cambia hasta que el servidor tenga
 * `HOME_LAYOUT_ENABLED=true`.
 *
 * Sólo se ejecuta sobre una portada VIRGEN: sin borrador, sin versión publicada, sin historial y sin activación previa. Cualquier otra cosa se
 * rechaza sin escribir nada (nunca sobrescribe). Si algún bloque no se puede mostrar con los datos reales (categoría inexistente, etc.) se rechaza.
 * ==============================================================================
 */

import type { Block, LayoutDocument } from './types';
import { activationRevision, nextStamp, planActivate, type ActivationCheck, type ActivationDocument } from './activation';
import { planPublish, type BlockingIssue } from './publish';
import { revisionOf } from './draft';
import { validateBlocks } from './validate';

export const INITIAL_BLOCKS: Block[] = [
  { id: 'bienvenida', modality: 'editorial', format: 'banner', width: 12, title: 'Bienvenida', card: 'promocion', visible: true, refs: [], config: { headline: 'Compara antes de comprar', text: 'Reunimos los datos que publican las tiendas —precio, envío y especificaciones— con su fecha de captura, para que decidas con la información delante.', buttonLabel: 'Ver todo el catálogo', link: { type: 'path', target: '/#catalogo' } } },
  { id: 'categorias', modality: 'manual', format: 'carrusel', width: 12, title: 'Explora por categoría', card: 'categoria', visible: true, config: {}, refs: [{ kind: 'category', id: 'portabilidad' }, { kind: 'category', id: 'informatica' }, { kind: 'category', id: 'sonido' }, { kind: 'category', id: 'hogar' }] },
  { id: 'mas-economicos', modality: 'automatica', format: 'cuadricula2x2', width: 6, title: 'Los más económicos', card: 'producto', visible: true, refs: [], config: { rules: { order: 'precio_asc', limit: 4, onlyWithPrice: true } } },
  { id: 'en-amazon', modality: 'automatica', format: 'cuadricula2x2', width: 6, title: 'Más económicos en Amazon', card: 'producto', visible: true, refs: [], config: { rules: { merchant: 'amazon', order: 'precio_asc', limit: 4, onlyWithPrice: true } } },
  { id: 'portabilidad', modality: 'automatica', format: 'carrusel', width: 12, title: 'Portabilidad, de menor a mayor precio', card: 'producto', visible: true, refs: [], config: { rules: { categoryId: 'portabilidad', order: 'precio_asc', limit: 12, onlyWithPrice: true } } },
  { id: 'informatica', modality: 'automatica', format: 'carrusel', width: 12, title: 'Informática, de menor a mayor precio', card: 'producto', visible: true, refs: [], config: { rules: { categoryId: 'informatica', order: 'precio_asc', limit: 12, onlyWithPrice: true } } },
  { id: 'sonido', modality: 'automatica', format: 'carrusel', width: 12, title: 'Sonido, de menor a mayor precio', card: 'producto', visible: true, refs: [], config: { rules: { categoryId: 'sonido', order: 'precio_asc', limit: 12, onlyWithPrice: true } } },
];

export const MAX_INITIAL_BODY_BYTES = 2 * 1024;

export type InitialReason =
  | 'peticion_invalida' | 'confirmacion_requerida' | 'archivo_protegido' | 'activacion_protegida' | 'conflicto' | 'ya_existe_borrador'
  | 'ya_hay_versiones' | 'activacion_existente' | 'referencias_bloqueantes' | 'documento_invalido';
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

  const parsed = validateBlocks(INITIAL_BLOCKS, 'blocks');
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
