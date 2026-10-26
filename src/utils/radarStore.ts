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
  type AiChatEntry,
  type BuyerProfile,
  type ComparatorHistoryEntry,
  type PendingExit,
  type ProjectFolder,
  type RadarData,
  type Reminder,
  type SavedProduct,
  buyerProfileColor,
  buyerProfileDisplayName,
  hslString,
} from '../types/radar';

export { RADAR_STORAGE_KEY };

type Listener = (data: RadarData) => void;

const listeners = new Set<Listener>();

/** Las bajas se recuerdan 180 días (hasta 500): el servidor aplica el mismo límite. */
const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const TOMBSTONE_MAX = 500;
const BUYER_PROFILE_MAX = 8;
const COMPARATOR_HISTORY_MAX = 30;
const AI_CHATS_MAX = 30;

function emptyRadar(): RadarData {
  return {
    projects: [{ ...DEFAULT_PROJECT, products: [] }],
    pendingExits: [],
    reminders: [],
    buyerProfiles: [],
    comparatorHistory: [],
    aiChats: [],
  };
}

/* ------------------------------------------------- marcas de tiempo y bajas */

function stampOf(value: unknown): number {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : 0;
}

/** Último cambio de un producto (alta o movimiento): con él decide el servidor los conflictos. */
function touchedAt(product: SavedProduct): number {
  return Math.max(stampOf(product.dateAdded), stampOf(product.movedAt));
}

/** Marca de tiempo siempre posterior a `after`, aunque el reloj del dispositivo vaya por detrás. */
function nextStamp(after = 0): number {
  return Math.max(Date.now(), after + 1);
}

function cleanTombstones(input: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const now = Date.now();
  const entries = Object.entries(input as Record<string, unknown>)
    .map(([id, at]) => [String(id).slice(0, 200), Number(at)] as const)
    .filter(([id, at]) => id && Number.isFinite(at) && at > 0 && now - at <= TOMBSTONE_TTL_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOMBSTONE_MAX);
  for (const [id, at] of entries) out[id] = Math.max(out[id] ?? 0, Math.floor(at));
  return out;
}

function withTombstone(map: Record<string, number> | undefined, id: string, at: number): Record<string, number> {
  return cleanTombstones({ ...(map ?? {}), [id]: Math.max(at, map?.[id] ?? 0) });
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
    reminders: Array.isArray(stored.reminders)
      ? stored.reminders.filter((r) => r && typeof r.id === 'string' && r.id)
      : [],
    removedProducts: cleanTombstones(stored.removedProducts),
    removedProjects: cleanTombstones(stored.removedProjects),
    removedToolRecords: cleanTombstones(stored.removedToolRecords),
    buyerProfiles: Array.isArray(stored.buyerProfiles) ? stored.buyerProfiles : [],
    activeBuyerProfileId: stored.activeBuyerProfileId || undefined,
    comparatorHistory: Array.isArray(stored.comparatorHistory) ? stored.comparatorHistory : [],
    aiChats: Array.isArray(stored.aiChats) ? stored.aiChats : [],
  };
}

/** Cuenta los cambios locales: una respuesta de sincronización antigua no debe pisar uno posterior. */
let localRev = 0;

function persist(data: RadarData): RadarData {
  localRev += 1;
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
    dropProduct(data, product.id);
    persist(data);
    void pushToCloud(data);
    return false;
  }
  const entry: SavedProduct = { ...product, dateAdded: product.dateAdded || new Date().toISOString() };
  // Volver a guardar algo quitado antes: el alta debe ser posterior a la baja o la sync lo descartaría.
  const removedAt = data.removedProducts?.[entry.id];
  if (removedAt !== undefined && removedAt >= stampOf(entry.dateAdded)) {
    entry.dateAdded = new Date(nextStamp(removedAt)).toISOString();
  }
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

/** Quita el producto de todas las listas y anota la baja (fecha posterior a su último cambio). */
function dropProduct(data: RadarData, productId: string): void {
  const touched = Math.max(
    0,
    ...data.projects.flatMap((project) => project.products.filter((p) => p.id === productId).map(touchedAt)),
  );
  for (const project of data.projects) {
    project.products = project.products.filter((p) => p.id !== productId);
  }
  data.removedProducts = withTombstone(data.removedProducts, productId.slice(0, 200), nextStamp(touched));
}

export function removeProduct(productId: string): void {
  const data = loadRadar();
  dropProduct(data, productId);
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

/**
 * Mueve un producto a otra lista (id del proyecto destino) y anota la fecha del cambio,
 * que es lo que decide en la sincronización en qué lista queda. Devuelve true si se movió;
 * false si el producto no existe, la lista no existe o ya estaba en esa lista (no hace nada).
 */
export function moveProduct(productId: string, targetProjectId: string): boolean {
  const data = loadRadar();
  const source = data.projects.find((project) => project.products.some((p) => p.id === productId));
  const target = data.projects.find((project) => project.id === targetProjectId);
  if (!source || !target || source.id === target.id) return false;
  const found = source.products.find((p) => p.id === productId) as SavedProduct;
  const moved: SavedProduct = { ...found, movedAt: new Date(nextStamp(touchedAt(found))).toISOString() };
  for (const project of data.projects) {
    project.products = project.products.filter((p) => p.id !== productId);
  }
  target.products = [moved, ...target.products];
  persist(data);
  void pushToCloud(data);
  return true;
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
    // Los productos vuelven a General con la fecha del cambio (así la sync respeta el movimiento).
    const moved = removed.products.map((p) => ({ ...p, movedAt: new Date(nextStamp(touchedAt(p))).toISOString() }));
    const ids = new Set(moved.map((p) => p.id));
    general.products = [...moved, ...general.products.filter((g) => !ids.has(g.id))];
  }
  data.removedProjects = withTombstone(data.removedProjects, projectId.slice(0, 200), Date.now());
  persist(data);
  void pushToCloud(data);
}

/* ----------------------------------------------------------- return flow */

export function trackExitClick(productId: string, title: string): void {
  const data = loadRadar();
  data.pendingExits = [
    { productId, title: String(title ?? '').slice(0, 200), timestamp: Date.now(), status: 'pending' as const },
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

/* ------------------------------------------------------------------ avisos */

/** Aviso 'scheduled' activo de un producto (si lo hay). */
export function getScheduledReminder(productId: string): Reminder | null {
  return loadRadar().reminders?.find((r) => r.productId === productId && r.status === 'scheduled') ?? null;
}

export type ReminderActionResult = { ok: boolean; message?: string; radar?: RadarData };

/**
 * Crea (o reprograma) el aviso de compra de un producto. Requiere sesión: el
 * servidor valida límites y fecha, y devuelve el radar mergeado.
 */
export async function createReminder(input: {
  productId: string;
  title: string;
  remindAt: number;
  reason: string;
  reasonNote?: string;
}): Promise<ReminderActionResult> {
  try {
    const res = await fetch('/api/radar/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; radar?: RadarData };
    if (res.ok && payload.success && payload.radar) {
      localStorage.setItem(RADAR_STORAGE_KEY, JSON.stringify(payload.radar));
      for (const listener of listeners) listener(payload.radar);
      return { ok: true, radar: payload.radar };
    }
    return { ok: false, message: payload.message ?? 'No se pudo crear el aviso.' };
  } catch {
    return { ok: false, message: 'Sin conexión. Inténtalo de nuevo.' };
  }
}

/** Cancela un aviso por id. */
export async function cancelReminder(reminderId: string): Promise<ReminderActionResult> {
  try {
    const res = await fetch(`/api/radar/reminders?id=${encodeURIComponent(reminderId)}`, { method: 'DELETE' });
    const payload = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; radar?: RadarData };
    if (res.ok && payload.success && payload.radar) {
      localStorage.setItem(RADAR_STORAGE_KEY, JSON.stringify(payload.radar));
      for (const listener of listeners) listener(payload.radar);
      return { ok: true, radar: payload.radar };
    }
    return { ok: false, message: payload.message ?? 'No se pudo cancelar el aviso.' };
  } catch {
    return { ok: false, message: 'Sin conexión. Inténtalo de nuevo.' };
  }
}

/* ------------------------------------------------------- alertas de precio */

export type AlertActionResult = { ok: boolean; message?: string; radar?: RadarData };

/**
 * Fija (o quita) el precio objetivo de un producto del radar. Requiere sesión:
 * la alerta vive en el servidor y el worker la vigila cada 6 h.
 */
export async function setProductAlert(input: {
  productId: string;
  targetPrice?: number;
  notifyPriceDrop?: boolean;
  notifyStock?: boolean;
  clear?: boolean;
}): Promise<AlertActionResult> {
  try {
    const res = await fetch('/api/radar/alert', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; radar?: RadarData };
    if (res.ok && payload.success && payload.radar) {
      localStorage.setItem(RADAR_STORAGE_KEY, JSON.stringify(payload.radar));
      for (const listener of listeners) listener(payload.radar);
      return { ok: true, radar: payload.radar };
    }
    return { ok: false, message: payload.message ?? 'No se pudo guardar la alerta.' };
  } catch {
    return { ok: false, message: 'Sin conexión. Inténtalo de nuevo.' };
  }
}

/* ---------------------------------------------------- perfiles de comprador */

function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Todos los perfiles de comprador guardados (requiere haberlos creado con sesión). */
export function getBuyerProfiles(): BuyerProfile[] {
  return loadRadar().buyerProfiles ?? [];
}

/** Perfil marcado como activo (el que usa el badge "Encaja con tu perfil"), o null. */
export function getActiveBuyerProfile(): BuyerProfile | null {
  const data = loadRadar();
  return data.buyerProfiles?.find((p) => p.id === data.activeBuyerProfileId) ?? null;
}

/**
 * Guarda el resultado del Perfilador de Compra como un nuevo perfil nombrado
 * y lo marca como activo. Igual que el resto de mutaciones, sólo se refleja
 * en la nube si hay sesión (si no, el push a /api/radar se ignora con 401).
 */
export function saveBuyerProfile(input: { name?: string; usage: string; budget: string; priority: string }): BuyerProfile {
  const data = loadRadar();
  const now = new Date().toISOString();
  // El nombre se genera automáticamente a partir de la combinación (uso +
  // presupuesto + prioridad): el usuario ya no lo escribe a mano.
  const name = buyerProfileDisplayName(input);
  const color = hslString(buyerProfileColor(input));
  const profile: BuyerProfile = {
    id: shortId('bp'),
    name,
    color,
    usage: input.usage,
    budget: input.budget,
    priority: input.priority,
    createdAt: now,
    updatedAt: now,
  };
  data.buyerProfiles = [profile, ...(data.buyerProfiles ?? [])].slice(0, BUYER_PROFILE_MAX);
  data.activeBuyerProfileId = profile.id;
  persist(data);
  void pushToCloud(data);
  return profile;
}

/** Marca (o quita, con `null`) el perfil activo del selector del mainNav. */
export function setActiveBuyerProfile(id: string | null): void {
  const data = loadRadar();
  data.activeBuyerProfileId = id ?? undefined;
  persist(data);
  void pushToCloud(data);
}

export function deleteBuyerProfile(id: string): void {
  const data = loadRadar();
  data.buyerProfiles = (data.buyerProfiles ?? []).filter((p) => p.id !== id);
  if (data.activeBuyerProfileId === id) data.activeBuyerProfileId = undefined;
  // Baja en la nube: sin la marca, la fusión por unión del servidor lo resucitaría.
  data.removedToolRecords = withTombstone(data.removedToolRecords, id, Date.now());
  persist(data);
  void pushToCloud(data);
}

/* ------------------------------------------------------ comparativas guardadas */

export function getComparatorHistory(): ComparatorHistoryEntry[] {
  return loadRadar().comparatorHistory ?? [];
}

export function addComparatorHistoryEntry(input: {
  categorySlug?: string;
  categoryName?: string;
  smartMatchProfile?: string;
  productIds: string[];
}): ComparatorHistoryEntry {
  const data = loadRadar();
  const entry: ComparatorHistoryEntry = {
    id: shortId('cmp'),
    createdAt: new Date().toISOString(),
    categorySlug: input.categorySlug,
    categoryName: input.categoryName,
    smartMatchProfile: input.smartMatchProfile,
    productIds: input.productIds.slice(0, 12),
  };
  data.comparatorHistory = [entry, ...(data.comparatorHistory ?? [])].slice(0, COMPARATOR_HISTORY_MAX);
  persist(data);
  void pushToCloud(data);
  return entry;
}

export function deleteComparatorHistoryEntry(id: string): void {
  const data = loadRadar();
  data.comparatorHistory = (data.comparatorHistory ?? []).filter((c) => c.id !== id);
  data.removedToolRecords = withTombstone(data.removedToolRecords, id, Date.now());
  persist(data);
  void pushToCloud(data);
}

/* ------------------------------------------------------- chats con el Dependiente IA */

export function getAiChats(): AiChatEntry[] {
  return loadRadar().aiChats ?? [];
}

/** Crea o actualiza (si manda `id` existente) una conversación guardada. */
export function saveAiChat(input: {
  id?: string;
  title: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string; at: string }>;
}): AiChatEntry {
  const data = loadRadar();
  const now = new Date().toISOString();
  const list = data.aiChats ?? [];
  const existingIdx = input.id ? list.findIndex((c) => c.id === input.id) : -1;
  const entry: AiChatEntry = {
    id: existingIdx >= 0 ? list[existingIdx].id : shortId('chat'),
    createdAt: existingIdx >= 0 ? list[existingIdx].createdAt : now,
    updatedAt: now,
    title: input.title.trim().slice(0, 100) || 'Conversación',
    messages: input.messages.slice(-40),
  };
  if (existingIdx >= 0) list[existingIdx] = entry;
  else list.unshift(entry);
  data.aiChats = list.slice(0, AI_CHATS_MAX);
  persist(data);
  void pushToCloud(data);
  return entry;
}

export function deleteAiChat(id: string): void {
  const data = loadRadar();
  data.aiChats = (data.aiChats ?? []).filter((c) => c.id !== id);
  data.removedToolRecords = withTombstone(data.removedToolRecords, id, Date.now());
  persist(data);
  void pushToCloud(data);
}

/* -------------------------------------------------------------------- sync */

/** Los envíos van uno tras otro: así el servidor los procesa en el orden de los cambios. */
let pushChain: Promise<void> = Promise.resolve();

/**
 * Combina el radar de la nube con el local SIN pisar nada: los registros de
 * herramientas (perfiles de comprador, comparativas y chats IA) se unen por id
 * y gana el más reciente de cada lado. Así un pull/respuesta de sync no borra
 * un perfil creado mientras tanto (o sin conexión), y una baja local sí se
 * respeta aunque la nube aún no la haya recibido.
 */
function mergeCloudRadar(local: RadarData, remote: RadarData): RadarData {
  const stampOf = (value: unknown): number => {
    const ms = Date.parse(String(value ?? ''));
    return Number.isFinite(ms) ? ms : 0;
  };
  const unionById = <T extends { id: string; createdAt: string; updatedAt?: string }>(
    remoteList: T[] | undefined,
    localList: T[] | undefined,
    max: number,
  ): T[] => {
    const byId = new Map<string, T>();
    for (const item of remoteList ?? []) {
      if (item && typeof item.id === 'string' && item.id) byId.set(item.id, item);
    }
    for (const item of localList ?? []) {
      if (!item || typeof item.id !== 'string' || !item.id) continue;
      const existing = byId.get(item.id);
      if (!existing || stampOf(item.updatedAt || item.createdAt) >= stampOf(existing.updatedAt || existing.createdAt)) {
        byId.set(item.id, item);
      }
    }
    return [...byId.values()]
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
      .slice(0, max);
  };

  const tombstones = { ...(remote.removedToolRecords ?? {}), ...(local.removedToolRecords ?? {}) };
  const withoutDeleted = <T extends { id: string }>(list: T[]): T[] =>
    list.filter((item) => !(item && item.id in tombstones));

  const buyerProfiles = withoutDeleted(unionById(remote.buyerProfiles, local.buyerProfiles, 8));
  const comparatorHistory = withoutDeleted(unionById(remote.comparatorHistory, local.comparatorHistory, 30));
  const aiChats = withoutDeleted(unionById(remote.aiChats, local.aiChats, 30));

  const activeId = local.activeBuyerProfileId && buyerProfiles.some((p) => p.id === local.activeBuyerProfileId)
    ? local.activeBuyerProfileId
    : remote.activeBuyerProfileId;

  return {
    ...remote,
    buyerProfiles,
    comparatorHistory,
    aiChats,
    activeBuyerProfileId: activeId,
    removedToolRecords: tombstones,
  };
}

/** Guarda en LocalStorage el radar devuelto por la nube, fusionado con lo local. */
function storeCloudRadar(remote: RadarData): RadarData {
  const merged = mergeCloudRadar(loadRadar(), remote);
  localRev += 1;
  try {
    localStorage.setItem(RADAR_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* modo privado / cuota */
  }
  for (const listener of listeners) listener(merged);
  return merged;
}

function pushToCloud(data: RadarData): Promise<void> {
  const body = JSON.stringify(data);
  const rev = localRev;
  pushChain = pushChain.then(() => pushSnapshot(body, rev));
  return pushChain;
}

async function pushSnapshot(body: string, rev: number): Promise<void> {
  // Sólo empuja si hay sesión (cookie HttpOnly; si no, 401 y se ignora).
  try {
    const res = await fetch('/api/radar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // Si el usuario cambia de página justo después de soltar, el envío no se cancela
      // (el navegador limita las peticiones "keepalive" a 64 KB: por encima se envía normal).
      keepalive: body.length < 60_000,
    });
    if (!res.ok) return;
    const payload = (await res.json()) as { radar?: RadarData };
    // Si mientras tanto hubo otro cambio local (p. ej. varios arrastres seguidos), esta respuesta
    // ya es antigua: aplicarla borraría ese cambio. El envío posterior lo trae todo.
    if (payload.radar && rev === localRev) {
      // Refleja el merge del server (conserva altas hechas en otro dispositivo).
      storeCloudRadar(payload.radar);
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
    if (payload.radar) return storeCloudRadar(payload.radar);
    return null;
  } catch {
    return null;
  }
}

/**
 * Descarga el radar de la nube (tras detectar sesión en otro dispositivo).
 * Combina con lo local: productos/listas por el merge del servidor y los
 * registros de herramientas por unión de ids (ver mergeCloudRadar).
 */
export async function pullFromCloud(): Promise<RadarData | null> {
  try {
    const res = await fetch('/api/radar', { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const payload = (await res.json()) as { radar?: RadarData };
    if (payload.radar) return storeCloudRadar(payload.radar);
    return null;
  } catch {
    return null;
  }
}
