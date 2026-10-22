import fs from 'node:fs';
import { dataFile } from './paths';
import { writeJsonArrayFile } from './jsonStore';

/**
 * Lista de IDs de productos eliminados desde el panel admin.
 * Se guarda en `deleted-product-ids.json` dentro del DATA_DIR (volumen en prod).
 * El catálogo público la usa para excluir tanto productos de products.json
 * como curados de src/data/products.ts que compartan el mismo id.
 */

const DELETED_FILE = dataFile('deleted-product-ids.json');

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
  const ids = readDeletedIds();
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return;
  writeJsonArrayFile(DELETED_FILE, next);
}
