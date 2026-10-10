/**
 * ==============================================================================
 * TRADYLOR - ALMACÉN DE REDES DE AFILIACIÓN PERSONALIZADAS
 * ==============================================================================
 * Persistencia en src/data/networks.json con esta forma:
 *   {
 *     "custom": [ { id, name, region, color, description, docUrl, fields: [...] } ],
 *     "removed": ["etsy", "rakuten"]
 *   }
 *
 *  - `custom`: afiliados creados desde el panel (se añaden al final de la lista).
 *  - `removed`: ids de redes predefinidas (registry.ts) eliminadas desde el panel;
 *    quedan ocultas pero pueden restaurarse.
 *
 * El fichero vive en DATA_DIR (en prod: volumen /app/data) y nunca se expone:
 * sólo se lee/escribe desde código de servidor.
 * ==============================================================================
 */

import fs from 'node:fs';
import type { NetworkDefinition } from './types';
import { DATA_DIR, dataFile } from '../paths';

const NETWORKS_PATH = dataFile('networks.json');

interface NetworksFile {
  custom: NetworkDefinition[];
  removed: string[];
}

function readFile(): NetworksFile {
  try {
    if (fs.existsSync(NETWORKS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(NETWORKS_PATH, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        return {
          custom: Array.isArray(parsed.custom) ? parsed.custom : [],
          removed: Array.isArray(parsed.removed) ? parsed.removed.map(String) : [],
        };
      }
    }
  } catch (error) {
    console.error('[Networks] Error al leer networks.json:', error);
  }
  return { custom: [], removed: [] };
}

function writeFile(data: NetworksFile): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(NETWORKS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/** Afiliados creados desde el panel. */
export function listCustomNetworks(): NetworkDefinition[] {
  return readFile().custom;
}

/** Ids de redes predefinidas eliminadas desde el panel. */
export function listRemovedIds(): string[] {
  return readFile().removed;
}

export function isNetworkRemoved(id: string): boolean {
  return readFile().removed.includes(id);
}

/** Añade un afiliado personalizado al final de la lista. */
export function addCustomNetwork(network: NetworkDefinition): void {
  const data = readFile();
  data.custom.push(network);
  writeFile(data);
}

/** Elimina un afiliado personalizado (no se puede restaurar). */
export function removeCustomNetwork(id: string): boolean {
  const data = readFile();
  const next = data.custom.filter((network) => network.id !== id);
  if (next.length === data.custom.length) return false;
  data.custom = next;
  writeFile(data);
  return true;
}

/** Oculta una red predefinida (restaurable desde el panel). */
export function markNetworkRemoved(id: string): boolean {
  const data = readFile();
  if (data.removed.includes(id)) return false;
  data.removed.push(id);
  writeFile(data);
  return true;
}

/** Restaura todas las redes predefinidas eliminadas. */
export function clearRemovedNetworks(): void {
  const data = readFile();
  if (!data.removed.length) return;
  data.removed = [];
  writeFile(data);
}
