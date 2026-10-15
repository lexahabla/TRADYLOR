import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from './paths';

/**
 * Lista de IDs de productos eliminados desde el panel admin.
 * Se guarda en `deleted-product-ids.json` dentro del DATA_DIR (volumen en prod).
 * El catálogo público la usa para excluir tanto productos de products.json
 * como curados de src/data/products.ts que compartan el mismo id.
 */

const DELETED_FILE = dataFile('deleted-product-ids.json');

function ensureDir(): void {
  const dir = path.dirname(DELETED_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readDeletedIds(): string[] {
  try {
    if (!fs.existsSync(DELETED_FILE)) return [];
    const raw = fs.readFileSync(DELETED_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch (error) {
    console.error('[DeletedProducts] Error al leer deleted-product-ids.json:', error);
    return [];
  }
}

export function addDeletedId(id: string): void {
  const ids = readDeletedIds();
  if (ids.includes(id)) return;
  ids.push(id);
  try {
    ensureDir();
    fs.writeFileSync(DELETED_FILE, JSON.stringify(ids, null, 2), 'utf-8');
  } catch (error) {
    console.error('[DeletedProducts] Error al guardar deleted-product-ids.json:', error);
  }
}

export function removeDeletedId(id: string): void {
  const ids = readDeletedIds();
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return;
  try {
    ensureDir();
    fs.writeFileSync(DELETED_FILE, JSON.stringify(next, null, 2), 'utf-8');
  } catch (error) {
    console.error('[DeletedProducts] Error al guardar deleted-product-ids.json:', error);
  }
}
