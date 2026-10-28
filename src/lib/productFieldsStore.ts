/**
 * ==============================================================================
 * TRADYLOR — CAMPOS VISIBLES EN LA FICHA DE PRODUCTO
 * ==============================================================================
 * Fuente única de verdad de qué campos del producto se pintan en la ficha
 * pública (`/producto/[slug]`) y permite al admin:
 *
 *   1. Ocultar/mostrar los campos "de serie" (veredicto, ficha técnica,
 *      specs, marca, estado físico, badge, valoración, envío) SIN tocar
 *      datos: por defecto TODOS quedan visibles (= comportamiento actual,
 *      cero cambios si el admin no toca nada).
 *   2. Añadir CAMPOS PERSONALIZADOS nuevos (p. ej. "Garantía", "Certificación").
 *      Viven dentro de `product.extra[key]` (ver lib/productStore.ts) y se
 *      editan desde «1. Extracción & Alta de Producto» como un input más;
 *      cada uno decide si se muestra en la ficha pública o no.
 *
 * Persistencia: `product-fields.json` en DATA_DIR (NO va a git, igual que
 * products.json/categories.json). Lectura tolerante + escritura atómica
 * (mismo patrón que aiSkillsStore.ts/jsonStore.ts).
 * ==============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths';

export interface BaseFieldDef {
  /** Clave del campo en `Product` (lib/productStore.ts). */
  key: string;
  label: string;
  hint: string;
}

export interface CustomFieldDef {
  /** Clave dentro de `product.extra`. */
  key: string;
  label: string;
  hint?: string;
  visible: boolean;
  createdAt: string;
}

export interface BaseFieldState extends BaseFieldDef {
  visible: boolean;
}

interface StoreFile {
  /** Claves de BASE_TOGGLEABLE_FIELDS desactivadas (ocultas). Vacío = todo visible. */
  hiddenBaseFields: string[];
  customFields: CustomFieldDef[];
}

const FILE_NAME = 'product-fields.json';
const MAX_CUSTOM_FIELDS = 30;

/**
 * Campos "de serie" que se pueden ocultar de la ficha pública sin perder el
 * dato (sigue editable en el panel y en `products.json`). Los campos
 * estructurales —título, precio, imagen, enlaces de compra y comerciante—
 * nunca se incluyen aquí: son imprescindibles para el checkout y la
 * monetización, así que no se ofrecen como «ocultables».
 */
export const BASE_TOGGLEABLE_FIELDS: BaseFieldDef[] = [
  { key: 'verdict', label: 'Veredicto editorial', hint: 'Bloque "Veredicto Tradylor"' },
  { key: 'techSheet', label: 'Ficha técnica (texto libre)', hint: 'Párrafo largo en la sección "Ficha técnica"' },
  { key: 'specs', label: 'Especificaciones (tabla clave/valor)', hint: 'Tabla de datos objetivos de la sección "Ficha técnica"' },
  { key: 'brand', label: 'Marca', hint: 'Fila "Marca" bajo el comerciante' },
  { key: 'condition', label: 'Estado físico (Nuevo / Usado / RxV)', hint: 'Fila "Estado" bajo el comerciante' },
  { key: 'badge', label: 'Etiqueta destacada (Badge)', hint: 'Sello sobre la imagen principal' },
  { key: 'rating', label: 'Valoración y nº de opiniones', hint: 'Estrellas junto a la categoría' },
  { key: 'shippingInfo', label: 'Detalle de envío', hint: 'Texto bajo "Envío en X días" (los días/gratis siguen viéndose)' },
];

const BASE_FIELD_KEYS = new Set(BASE_TOGGLEABLE_FIELDS.map((f) => f.key));

function filePath(): string {
  return path.join(DATA_DIR, FILE_NAME);
}

function emptyStore(): StoreFile {
  return { hiddenBaseFields: [], customFields: [] };
}

function readStore(): StoreFile {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    return {
      hiddenBaseFields: Array.isArray(parsed.hiddenBaseFields)
        ? parsed.hiddenBaseFields.filter((k): k is string => typeof k === 'string' && BASE_FIELD_KEYS.has(k))
        : [],
      customFields: Array.isArray(parsed.customFields) ? parsed.customFields.filter((f) => f && typeof f.key === 'string') : [],
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store: StoreFile): boolean {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmpFile = `${filePath()}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmpFile, filePath());
    return true;
  } catch (error) {
    console.error('[productFieldsStore] Error al guardar:', error);
    return false;
  }
}

/** Slug corto y estable para usar como clave de `extra`/`customFields`. */
function slugifyFieldKey(label: string): string {
  const base = String(label || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/(^_|_$)+/g, '')
    .slice(0, 40);
  return base || `campo_${Date.now().toString(36)}`;
}

/** Estado completo de los campos "de serie" (con su visibilidad actual). */
export function getBaseFieldStates(): BaseFieldState[] {
  const { hiddenBaseFields } = readStore();
  const hidden = new Set(hiddenBaseFields);
  return BASE_TOGGLEABLE_FIELDS.map((f) => ({ ...f, visible: !hidden.has(f.key) }));
}

/** Campos personalizados registrados (visibles u ocultos). */
export function getCustomFields(): CustomFieldDef[] {
  return readStore().customFields;
}

/** Sólo las claves de `product.extra` marcadas como visibles (para la ficha pública). */
export function getVisibleCustomFieldKeys(): Set<string> {
  return new Set(getCustomFields().filter((f) => f.visible).map((f) => f.key));
}

/** Activa/desactiva la visibilidad pública de un campo "de serie". */
export function setBaseFieldVisibility(key: string, visible: boolean): boolean {
  if (!BASE_FIELD_KEYS.has(key)) return false;
  const store = readStore();
  const set = new Set(store.hiddenBaseFields);
  if (visible) set.delete(key);
  else set.add(key);
  store.hiddenBaseFields = [...set];
  return writeStore(store);
}

/** Añade un campo personalizado nuevo. Devuelve `null` si no es válido o ya existe. */
export function addCustomField(label: string, visible = true, explicitKey?: string): CustomFieldDef | null {
  const trimmedLabel = String(label || '').trim().slice(0, 60);
  if (!trimmedLabel) return null;

  const store = readStore();
  if (store.customFields.length >= MAX_CUSTOM_FIELDS) return null;

  let key = String(explicitKey || '').trim() || slugifyFieldKey(trimmedLabel);
  if (BASE_FIELD_KEYS.has(key) || ['title', 'description', 'price', 'originalPrice', 'image', 'gallery', 'category', 'merchant', 'affiliateUrl', 'buyNowUrl', 'pros', 'cons', 'crossMerchant'].includes(key)) {
    key = `campo_${key}`;
  }
  if (store.customFields.some((f) => f.key === key)) return null;

  const field: CustomFieldDef = {
    key,
    label: trimmedLabel,
    visible: Boolean(visible),
    createdAt: new Date().toISOString(),
  };
  store.customFields.push(field);
  if (!writeStore(store)) return null;
  return field;
}

/** Cambia la visibilidad pública de un campo personalizado. */
export function setCustomFieldVisibility(key: string, visible: boolean): boolean {
  const store = readStore();
  const field = store.customFields.find((f) => f.key === key);
  if (!field) return false;
  field.visible = visible;
  return writeStore(store);
}

/** Elimina un campo personalizado del registro (los valores ya guardados en `extra` se conservan). */
export function removeCustomField(key: string): boolean {
  const store = readStore();
  const before = store.customFields.length;
  store.customFields = store.customFields.filter((f) => f.key !== key);
  if (store.customFields.length === before) return false;
  return writeStore(store);
}

/**
 * Oculta en un producto (clon superficial; NUNCA muta el original) los campos
 * "de serie" desactivados y los campos personalizados no visibles. Se usa en
 * `/producto/[slug].astro` justo antes de derivar el resto de la página, así
 * que toda la UI condicional existente (ya construida sobre comprobaciones de
 * veracidad: `{product.verdict && (...)}`, `{specs && (...)}`...) reacciona
 * sola sin tocar esa plantilla.
 */
export function applyProductFieldVisibility<T extends object>(product: T): T {
  const { hiddenBaseFields, customFields } = readStore();
  const hiddenCustomKeys = customFields.filter((f) => !f.visible).map((f) => f.key);
  if (!hiddenBaseFields.length && !hiddenCustomKeys.length) return product;

  const clone: Record<string, unknown> = { ...(product as Record<string, unknown>) };
  for (const key of hiddenBaseFields) {
    clone[key] = undefined;
  }
  const extra = clone.extra;
  if (hiddenCustomKeys.length && extra && typeof extra === 'object' && !Array.isArray(extra)) {
    const extraClone: Record<string, unknown> = { ...(extra as Record<string, unknown>) };
    for (const key of hiddenCustomKeys) delete extraClone[key];
    clone.extra = extraClone;
  }
  return clone as T;
}

/** Entradas de `product.extra` visibles y con valor, listas para pintar en la ficha. */
export function getVisibleCustomFieldEntries(
  product: { extra?: Record<string, unknown> | null } | null | undefined,
): Array<{ key: string; label: string; value: string }> {
  const extra = product?.extra;
  if (!extra || typeof extra !== 'object') return [];
  const defs = getCustomFields();
  const entries: Array<{ key: string; label: string; value: string }> = [];
  for (const def of defs) {
    if (!def.visible) continue;
    const raw = (extra as Record<string, unknown>)[def.key];
    if (raw == null || raw === '') continue;
    if (typeof raw === 'object') continue; // nunca pintar objetos anidados crudos (crossMerchant, etc.)
    entries.push({ key: def.key, label: def.label, value: String(raw) });
  }
  return entries;
}
