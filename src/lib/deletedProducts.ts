import fs from 'node:fs';
import { dataFile } from './paths';
import { readJsonArrayFile, writeJsonArrayFile } from './jsonStore';

/**
 * Lista de IDs de productos eliminados desde el panel admin.
 * Se guarda en `deleted-product-ids.json` dentro del DATA_DIR (volumen en prod).
 * El catálogo público la usa para excluir tanto productos de products.json
 * como curados de src/data/products.ts que compartan el mismo id.
 */

const DELETED_FILE = dataFile('deleted-product-ids.json');
/** Ruta exportada para que `catalog.ts` pueda invalidar su caché por mtime. */
export const DELETED_FILE_PATH = DELETED_FILE;

// IDs de productos eliminados previamente (curados del catálogo inicial).
const BUILTIN_DELETED = [
  'sony-wh-1000xm5',
  'apple-macbook-air-m3',
  'kindle-paperwhite-signature',
  'roborock-q-revo',
];

export function readDeletedIds(): string[] {
  try {
    if (!fs.existsSync(DELETED_FILE)) {
      return BUILTIN_DELETED.slice();
    }
    const raw = fs.readFileSync(DELETED_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    return Array.from(new Set([...BUILTIN_DELETED, ...list]));
  } catch (error) {
    console.error('[DeletedProducts] Error al leer deleted-product-ids.json:', error);
    return BUILTIN_DELETED.slice();
  }
}

export function addDeletedId(id: string): void {
  const ids = readDeletedIds();
  if (ids.includes(id)) return;
  ids.push(id);
  writeJsonArrayFile(DELETED_FILE, ids);
}

export function removeDeletedId(id: string): void {
  // Recuperar una ficha por una acción explícita también olvida su identidad.
  forgetDeletedIdentity(id);
  const ids = readDeletedIds();
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return;
  writeJsonArrayFile(DELETED_FILE, next);
}

/**
 * Limpia los tombstones (ids de productos que ya no deben reaparecer).
 * Se usa para "deshacer" un vaciado de catálogo: sin esto, los productos
 * borrados quedan bloqueados para siempre y el build del catálogo vuelve a
 * publicarlos. Los ids integrados (`BUILTIN_DELETED`) se conservan siempre.
 * Devuelve cuántos tombstones se han quitado.
 */
export function clearDeletedIds(): number {
  // «Deshacer» el vaciado también limpia la memoria de identidades y ofertas.
  writeJsonArrayFile(DELETED_IDENTITIES_FILE(), []);
  writeJsonArrayFile(DELETED_OFFERS_FILE(), []);
  const ids = readDeletedIds();
  const removable = ids.filter((id) => !BUILTIN_DELETED.includes(id));
  if (!removable.length) return 0;
  writeJsonArrayFile(DELETED_FILE, BUILTIN_DELETED.slice());
  return removable.length;
}

/* ───────────────────── Memoria de eliminados por identidad ─────────────────────
 * El tombstone por id no basta: el mismo producto vuelve con OTRO id (API, JSON,
 * otro canal). Aquí se guarda, al eliminar una FICHA COMPLETA, su identidad
 * (claves de oferta, ids externos, URLs canónicas, GTIN y variante) y, aparte,
 * las OFERTAS eliminadas por separado. Sólo almacenamiento: la lógica de
 * coincidencia está en deletedIdentity.ts.
 * ─────────────────────────────────────────────────────────────────────────── */

export interface DeletedIdentity {
  offerKeys: string[];
  sourceIds: string[];
  urls: string[];
  gtins: string[];
  platforms: string[];
  variant: { condition?: string; color?: string; size?: string; capacity?: string; pack?: string };
}

export interface DeletedIdentityRecord {
  id: string;
  deletedAt: string;
  identity: DeletedIdentity;
  /** De dónde sale la identidad: la ficha al borrar o una copia de seguridad antigua. */
  source: 'deletion' | 'backup';
}

export interface DeletedOfferRecord {
  offerKey: string;
  productId?: string;
  url?: string;
  deletedAt: string;
}

export const DELETED_IDENTITIES_FILE = () => dataFile('deleted-identities.json');
export const DELETED_OFFERS_FILE = () => dataFile('deleted-offers.json');

export function readDeletedIdentities(): DeletedIdentityRecord[] {
  return readJsonArrayFile<DeletedIdentityRecord>(DELETED_IDENTITIES_FILE());
}

export function addDeletedIdentity(record: DeletedIdentityRecord): void {
  const list = readDeletedIdentities().filter((r) => r.id !== record.id);
  list.push(record);
  writeJsonArrayFile(DELETED_IDENTITIES_FILE(), list);
}

export function forgetDeletedIdentity(id: string): void {
  const list = readDeletedIdentities();
  const next = list.filter((r) => r.id !== id);
  if (next.length !== list.length) writeJsonArrayFile(DELETED_IDENTITIES_FILE(), next);
}

export function readDeletedOffers(): DeletedOfferRecord[] {
  return readJsonArrayFile<DeletedOfferRecord>(DELETED_OFFERS_FILE());
}

export function addDeletedOffer(record: DeletedOfferRecord): void {
  const list = readDeletedOffers().filter((r) => r.offerKey !== record.offerKey);
  list.push(record);
  writeJsonArrayFile(DELETED_OFFERS_FILE(), list);
}

export function forgetDeletedOffer(offerKey: string): void {
  const list = readDeletedOffers();
  const next = list.filter((r) => r.offerKey !== offerKey);
  if (next.length !== list.length) writeJsonArrayFile(DELETED_OFFERS_FILE(), next);
}
