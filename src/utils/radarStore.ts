/**
 * ==============================================================================
 * TRADYLOR — RADAR STORE (cliente, Offline-First)
 * ==============================================================================
 * Fuente de verdad local: LocalStorage (`tradylor-radar-v1`). Si el usuario
 * tiene sesión, cada mutación se refleja también en la nube vía POST /api/radar
 * (merge en el server). syncLocalToCloud() migra todo al autenticarse.
 *
 * Este archivo corre en el navegador (scripts bundled de Astro); no importar
 * nada de Node aquí.
 * ==============================================================================
 */

import {
  DEFAULT_PROJECT,
  RADAR_STORAGE_KEY,
  type PendingExit,
  type ProjectFolder,
  type RadarData,
  type SavedProduct,
} from '../types/radar';

type Listener = (data: RadarData) => void;

const listeners = new Set<Listener>();

function emptyRadar(): RadarData {
  return {
    projects: [{ ...DEFAULT_PROJECT, products: [] }],
    pendingExits: [],
  };
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Lee el radar completo de LocalStorage (normaliza estructura). */
export function loadRadar(): RadarData {
  const stored = safeParse<RadarData>(localStorage.getItem(RADAR_STORAGE_KEY), emptyRadar());
  const projects: ProjectFolder[] = Array.isArray(stored.projects) && stored.projects.length > 0
    ? stored.projects.map((p) => ({
        id: String(p.id || 'general'),
        name: String(p.name || 'General'),
        description: p.description ? String(p.description) : undefined,
        products: Array.isArray(p.products) ? p.products : [],
      }))
    : [{ ...DEFAULT_PROJECT, products: [] }];
  if (!projects.some((p) => p.id === DEFAULT_PROJECT.id)) {
    projects.unshift({ ...DEFAULT_PROJECT, products: [] });
  }
  return {
    projects,
    pendingExits: Array.isArray(stored.pendingExits) ? stored.pendingExits : [],
  };
}

function persist(data: RadarData): RadarData {
  try {
    localStorage.setItem(RADAR_STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* modo privado / cuota */
  }
  for (const listener of listeners) listener(data);
  return data;
}

/** Suscripción a cambios del radar (para re-render de UI). */
export function onRadarChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ---------------------------------------------------------------- productos */

export function getRadarProducts(): SavedProduct[] {
  return loadRadar().projects.flatMap((p) => p.products);
}

export function isSaved(productId: string): boolean {
  return getRadarProducts().some((p) => p.id === productId);
}

/** Añade o elimina (toggle) un producto. Devuelve true si quedó guardado. */
export function saveToRadar(product: SavedProduct, projectId = DEFAULT_PROJECT.id): boolean {
  const data = loadRadar();
  let project = data.projects.find((p) => p.id === projectId) ?? data.projects[0];
  const exists = project.products.some((p) => p.id === product.id);
  if (exists) {
    for (const p of data.projects) p.products = p.products.filter((item) => item.id !== product.id);
    persist(data);
    void pushToCloud(data);
    return false;
  }
  const entry: SavedProduct = { ...product, dateAdded: product.dateAdded || new Date().toISOString() };
  project.products = [entry, ...project.products.filter((p) => p.id !== entry.id)];
  // Sin duplicados en otras carpetas.
  for (const p of data.projects) {
    if (p.id === project.id) continue;
    p.products = p.products.filter((item) => item.id !== entry.id);
  }
  persist(data);
  void pushToCloud(data);
  return true;
}

export function removeProduct(productId: string): void {
  const data = loadRadar();
  for (const project of data.projects) {
    project.products = project.products.filter((p) => p.id !== productId);
  }
  persist(data);
  void pushToCloud(data);
}

export function setProductNote(productId: string, note: string): void {
  const data = loadRadar();
  for (const project of data.projects) {
    for (const product of project.products) {
      if (product.id === productId) product.userNote = note.trim() || undefined;
    }
  }
  persist(data);
  void pushToCloud(data);
}

/** Mueve un producto de carpeta (por id de proyecto destino). */
export function moveProduct(productId: string, targetProjectId: string): void {
  const data = loadRadar();
  let moved: SavedProduct | null = null;
  for (const project of data.projects) {
    const found = project.products.find((p) => p.id === productId);
    if (found) moved = found;
    project.products = project.products.filter((p) => p.id !== productId);
  }
  if (moved) {
    const target = data.projects.find((p) => p.id === targetProjectId) ?? data.projects[0];
    target.products = [moved, ...target.products];
  }
  persist(data);
  void pushToCloud(data);
}

/* ----------------------------------------------------------------- carpetas */

export function getProjects(): ProjectFolder[] {
  return loadRadar().projects;
}

export function createProject(name: string, description?: string): ProjectFolder {
  const data = loadRadar();
  const clean = name.trim().slice(0, 60) || 'Lista';
  const id = `${clean.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 30) || 'lista'}-${Math.random().toString(36).slice(2, 8)}`;
  const project: ProjectFolder = { id, name: clean, description: description?.trim() || undefined, products: [] };
  data.projects.push(project);
  persist(data);
  void pushToCloud(data);
  return project;
}

export function deleteProject(projectId: string): void {
  if (projectId === DEFAULT_PROJECT.id) return;
  const data = loadRadar();
  const removed = data.projects.find((p) => p.id === projectId);
  data.projects = data.projects.filter((p) => p.id !== projectId);
  const general = data.projects.find((p) => p.id === DEFAULT_PROJECT.id);
  if (removed && general) {
    const ids = new Set(removed.products.map((p) => p.id));
    general.products = [
      ...removed.products.filter((p) => !general.products.some((g) => g.id === p.id)),
      ...general.products.filter((g) => !ids.has(g.id)),
    ];
  }
  persist(data);
  void pushToCloud(data);
}

/* ----------------------------------------------------------- return flow */

export function trackExitClick(productId: string, title: string): void {
  const data = loadRadar();
  data.pendingExits = [
    { productId, title: String(title ?? '').slice(0, 200), timestamp: Date.now(), status: 'pending' },
    ...data.pendingExits.filter((e) => e.productId !== productId),
  ].slice(0, 50);
  persist(data);
  void pushToCloud(data);
}

export function resolveExit(productId: string, status: 'purchased' | 'dismissed'): void {
  const data = loadRadar();
  data.pendingExits = data.pendingExits.map((e) => (e.productId === productId ? { ...e, status } : e));
  persist(data);
  void pushToCloud(data);
}

export function getPendingExits(): PendingExit[] {
  return loadRadar().pendingExits.filter((e) => e.status === 'pending');
}

/* -------------------------------------------------------------------- sync */

async function pushToCloud(data: RadarData): Promise<void> {
  // Sólo empuja si hay sesión (cookie HttpOnly; si no, 401 y se ignora).
  try {
    const res = await fetch('/api/radar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      const payload = (await res.json()) as { radar?: RadarData };
      if (payload.radar) {
        // Refleja el merge del server (conserva altas hechas en otro dispositivo).
        localStorage.setItem(RADAR_STORAGE_KEY, JSON.stringify(payload.radar));
        for (const listener of listeners) listener(payload.radar);
      }
    }
  } catch {
    /* offline: el próximo push llevará los cambios */
  }
}

/**
 * Migra LocalStorage → nube tras login/registro. Devuelve el radar fusionado.
 */
export async function syncLocalToCloud(): Promise<RadarData | null> {
  try {
    const res = await fetch('/api/radar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loadRadar()),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { radar?: RadarData };
    if (payload.radar) {
      localStorage.setItem(RADAR_STORAGE_KEY, JSON.stringify(payload.radar));
      for (const listener of listeners) listener(payload.radar);
      return payload.radar;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Descarga el radar de la nube (tras detectar sesión en otro dispositivo).
 * Combina con lo local por id de producto (más reciente gana).
 */
export async function pullFromCloud(): Promise<RadarData | null> {
  try {
    const res = await fetch('/api/radar', { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const payload = (await res.json()) as { radar?: RadarData };
    if (payload.radar) {
      localStorage.setItem(RADAR_STORAGE_KEY, JSON.stringify(payload.radar));
      for (const listener of listeners) listener(payload.radar);
      return payload.radar;
    }
    return null;
  } catch {
    return null;
  }
}
