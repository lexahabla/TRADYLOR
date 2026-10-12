import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataFile } from './paths';
import {
  DEFAULT_PROJECT,
  type PendingExit,
  type ProjectFolder,
  type RadarData,
  type SavedProduct,
} from '../types/radar';

/**
 * ==============================================================================
 * TRADYLOR — STORE DE DATOS "MI RADAR" (nube)
 * ==============================================================================
 * radar-data.json en el directorio de datos (volumen en producción). Un objeto
 * por usuario (clave = id de radarAuth). El cliente mantiene siempre su copia
 * en LocalStorage (Offline-First); al autenticarse hace sync y aquí se hace el
 * merge conservando lo más reciente de cada producto.
 * ==============================================================================
 */

const DATA_FILE = dataFile('radar-data.json');

type RadarDataFile = Record<string, RadarData>;

function uuid(): string {
  return randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function emptyRadar(): RadarData {
  return {
    projects: [{ ...DEFAULT_PROJECT, products: [] }],
    pendingExits: [],
  };
}

function readAll(): RadarDataFile {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as RadarDataFile) : {};
  } catch (error) {
    console.error('[RadarStore] Error leyendo radar-data.json:', error);
    return {};
  }
}

function writeAll(data: RadarDataFile): void {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, DATA_FILE);
}

/** Radar del usuario (vacío con "General" si no existe aún). */
export function getRadar(userId: string): RadarData {
  const all = readAll();
  const stored = all[userId];
  if (!stored || !Array.isArray(stored.projects) || stored.projects.length === 0) {
    return emptyRadar();
  }
  return {
    projects: stored.projects.map((p) => ({ ...p, products: Array.isArray(p.products) ? p.products : [] })),
    pendingExits: Array.isArray(stored.pendingExits) ? stored.pendingExits : [],
  };
}

/* ------------------------------------------------------------------ merge */

function mergeProducts(incoming: SavedProduct[], existing: SavedProduct[]): SavedProduct[] {
  const byId = new Map<string, SavedProduct>();
  for (const product of existing) byId.set(product.id, product);
  for (const product of incoming) {
    const current = byId.get(product.id);
    if (!current) {
      byId.set(product.id, product);
      continue;
    }
    // Conserva lo más reciente; la nota del cliente gana si el cloud no tiene.
    const incomingNewer = String(product.dateAdded) >= String(current.dateAdded);
    byId.set(product.id, {
      ...current,
      ...product,
      dateAdded: incomingNewer ? product.dateAdded : current.dateAdded,
      userNote: product.userNote ?? current.userNote,
    });
  }
  return [...byId.values()].sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)));
}

/**
 * Sync LocalStorage → nube (upsert de proyectos y salidas pendientes).
 * Merge por id de producto conservando la fecha más reciente.
 */
export function syncRadar(userId: string, incoming: Partial<RadarData>): RadarData {
  const all = readAll();
  const current = all[userId] ?? emptyRadar();

  const projects: ProjectFolder[] = [];
  const seen = new Set<string>();
  const incomingProjects = Array.isArray(incoming.projects) ? incoming.projects : [];
  for (const project of incomingProjects) {
    if (!project || typeof project.id !== 'string' || !project.id) continue;
    seen.add(project.id);
    const existing = current.projects.find((p) => p.id === project.id);
    projects.push({
      id: project.id,
      name: String(project.name ?? existing?.name ?? 'Lista').slice(0, 60),
      description: String(project.description ?? existing?.description ?? '').slice(0, 200) || undefined,
      products: mergeProducts(Array.isArray(project.products) ? project.products : [], existing?.products ?? []),
    });
  }
  // Carpetas que sólo existían en la nube se conservan.
  for (const project of current.projects) {
    if (!seen.has(project.id)) projects.push(project);
  }
  if (!projects.some((p) => p.id === DEFAULT_PROJECT.id)) {
    projects.unshift({ ...DEFAULT_PROJECT, products: [] });
  }

  const exitsById = new Map<string, PendingExit>();
  for (const exit of current.pendingExits) exitsById.set(exit.productId, exit);
  const incomingExits = Array.isArray(incoming.pendingExits) ? incoming.pendingExits : [];
  for (const exit of incomingExits) {
    if (!exit || typeof exit.productId !== 'string' || !exit.productId) continue;
    const existing = exitsById.get(exit.productId);
    const status = existing && existing.status !== 'pending' && exit.status === 'pending'
      ? existing.status // no regresar a pending una salida ya resuelta
      : (exit.status ?? 'pending');
    exitsById.set(exit.productId, {
      productId: exit.productId,
      title: String(exit.title ?? existing?.title ?? '').slice(0, 200),
      timestamp: Math.max(Number(exit.timestamp) || 0, existing?.timestamp ?? 0) || Date.now(),
      status,
    });
  }

  const merged: RadarData = {
    projects,
    pendingExits: [...exitsById.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50),
  };
  all[userId] = merged;
  writeAll(all);
  return merged;
}

/* ------------------------------------------------- operaciones puntuales */

/** Añade/actualiza un producto en una carpeta (por defecto General). */
export function addProduct(userId: string, product: SavedProduct, projectId = DEFAULT_PROJECT.id): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  let project = radar.projects.find((p) => p.id === projectId);
  if (!project) {
    project = { id: projectId, name: 'General', products: [] };
    radar.projects.push(project);
  }
  project.products = mergeProducts([product], project.products);
  // Evita duplicados en otras carpetas.
  for (const other of radar.projects) {
    if (other.id === project.id) continue;
    other.products = other.products.filter((p) => p.id !== product.id);
  }
  all[userId] = radar;
  writeAll(all);
  return radar;
}

export function removeProduct(userId: string, productId: string): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  for (const project of radar.projects) {
    project.products = project.products.filter((p) => p.id !== productId);
  }
  all[userId] = radar;
  writeAll(all);
  return radar;
}

/** Crea una carpeta nueva; id = slug corto aleatorio. */
export function createProject(userId: string, name: string, description?: string): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  const cleanName = String(name ?? '').trim().slice(0, 60);
  if (!cleanName) return radar;
  const id = `${cleanName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 30) || 'lista'}-${randomBytes(3).toString('hex')}`;
  radar.projects.push({
    id,
    name: cleanName,
    description: String(description ?? '').trim().slice(0, 200) || undefined,
    products: [],
  });
  all[userId] = radar;
  writeAll(all);
  return radar;
}

export function deleteProject(userId: string, projectId: string): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  if (projectId === DEFAULT_PROJECT.id) return radar; // General no se borra
  const removed = radar.projects.find((p) => p.id === projectId);
  radar.projects = radar.projects.filter((p) => p.id !== projectId);
  // Los productos huérfanos vuelven a General.
  const general = radar.projects.find((p) => p.id === DEFAULT_PROJECT.id);
  if (removed && general) {
    general.products = mergeProducts(removed.products, general.products);
  }
  all[userId] = radar;
  writeAll(all);
  return radar;
}

/** Registra una salida directa (.exit-cta) para el Return Flow. */
export function trackExit(userId: string, productId: string, title: string): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  radar.pendingExits = [
    { productId, title: String(title ?? '').slice(0, 200), timestamp: Date.now(), status: 'pending' },
    ...radar.pendingExits.filter((e) => e.productId !== productId),
  ].slice(0, 50);
  all[userId] = radar;
  writeAll(all);
  return radar;
}

/** Resuelve una salida del Return Flow (comprada / descartada). */
export function resolveExit(userId: string, productId: string, status: 'purchased' | 'dismissed'): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  radar.pendingExits = radar.pendingExits.map((e) =>
    e.productId === productId ? { ...e, status } : e,
  );
  all[userId] = radar;
  writeAll(all);
  return radar;
}
