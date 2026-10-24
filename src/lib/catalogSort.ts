import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths';

const SORT_FILE = path.join(DATA_DIR, 'catalog-sort.json');

export function getGlobalCatalogSort(): string {
  try {
    if (fs.existsSync(SORT_FILE)) {
      const content = fs.readFileSync(SORT_FILE, 'utf-8');
      const data = JSON.parse(content);
      if (data && typeof data.sort === 'string' && data.sort.trim()) {
        return data.sort.trim();
      }
    }
  } catch {
    // Fallback silencioso en caso de error de lectura o JSON inválido
  }
  return 'score';
}

export function setGlobalCatalogSort(sort: string): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(
      SORT_FILE,
      JSON.stringify({ sort: sort.trim(), updatedAt: new Date().toISOString() }, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.error('[catalogSort] Error al guardar ordenación global del catálogo:', err);
  }
}
