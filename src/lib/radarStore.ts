import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataFile } from './paths';
import {
  DEFAULT_PROJECT,
  type PendingExit,
  type ProjectFolder,
  type RadarData,
  type Reminder,
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
    reminders: [],
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
    reminders: Array.isArray(stored.reminders) ? stored.reminders : [],
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

const REMINDER_STATUSES = new Set(['scheduled', 'sending', 'sent', 'cancelled']);

/** Normaliza un aviso recibido del cliente (nunca confiar en el payload). */
function sanitizeReminder(input: Reminder): Reminder {
  const status = REMINDER_STATUSES.has(String(input.status)) ? input.status : 'scheduled';
  return {
    id: String(input.id ?? '').slice(0, 64),
    productId: String(input.productId ?? '').slice(0, 200),
    title: String(input.title ?? '').slice(0, 200),
    remindAt: Math.max(0, Number(input.remindAt) || 0),
    reason: String(input.reason ?? '').slice(0, 80),
    reasonNote: String(input.reasonNote ?? '').trim().slice(0, 300) || undefined,
    status,
    createdAt: Math.max(0, Number(input.createdAt) || Date.now()),
    sentAt: Number(input.sentAt) || undefined,
    attempts: Number(input.attempts) || 0,
    lastError: input.lastError ? String(input.lastError).slice(0, 300) : undefined,
  };
}

/**
 * Merge de avisos por id. Reglas:
 *  - un aviso ya enviado/cancelado/en curso NUNCA vuelve a 'scheduled'
 *    (evita reenvíos tras un push tardío del cliente);
 *  - mientras esté 'scheduled', la fecha que manda es la del cliente
 *    (así se puede reprogramar desde cualquier dispositivo).
 */
function mergeReminders(incoming: Reminder[], existing: Reminder[]): Reminder[] {
  const byId = new Map<string, Reminder>();
  for (const reminder of existing) byId.set(reminder.id, reminder);

  for (const raw of incoming) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
    const reminder = sanitizeReminder(raw);
    const current = byId.get(reminder.id);
    if (!current) {
      byId.set(reminder.id, reminder);
      continue;
    }
    const locked = current.status === 'sent' || current.status === 'cancelled' || current.status === 'sending';
    const status = locked && reminder.status === 'scheduled' ? current.status : reminder.status;
    byId.set(reminder.id, {
      ...current,
      ...reminder,
      status,
      remindAt: status === 'scheduled' ? reminder.remindAt || current.remindAt : current.remindAt,
      sentAt: current.sentAt ?? reminder.sentAt,
      attempts: Math.max(current.attempts ?? 0, reminder.attempts ?? 0),
      lastError: reminder.lastError ?? current.lastError,
    });
  }

  return [...byId.values()]
    .filter((r) => r.id && r.productId)
    .sort((a, b) => a.remindAt - b.remindAt)
    .slice(0, 50);
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

  // Avisos: si el cliente no manda ninguno (versión vieja / LocalStorage
  // normalizado), se conservan los de la nube; nunca se borran en bloque.
  const incomingReminders = Array.isArray(incoming.reminders) ? incoming.reminders : [];
  const reminders = incomingReminders.length > 0 || current.reminders?.length
    ? mergeReminders(incomingReminders, current.reminders ?? [])
    : [];

  const merged: RadarData = {
    projects,
    pendingExits: [...exitsById.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50),
    reminders,
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

/* --------------------------------------------------------- avisos/reminders */

export interface ReminderInput {
  productId: string;
  title: string;
  remindAt: number;
  reason: string;
  reasonNote?: string;
}

/**
 * Crea el aviso de un producto. Un solo aviso activo por producto: si ya
 * existe uno 'scheduled', se reprograma en el sitio (no se duplica).
 */
export function setReminder(userId: string, input: ReminderInput): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  const reminders = Array.isArray(radar.reminders) ? radar.reminders : [];

  const productId = String(input.productId ?? '').slice(0, 200);
  const clean: Reminder = {
    id: `rem-${randomBytes(10).toString('hex')}`,
    productId,
    title: String(input.title ?? '').slice(0, 200),
    remindAt: Math.max(0, Number(input.remindAt) || 0),
    reason: String(input.reason ?? '').slice(0, 80),
    reasonNote: String(input.reasonNote ?? '').trim().slice(0, 300) || undefined,
    status: 'scheduled',
    createdAt: Date.now(),
    attempts: 0,
  };

  const existingIdx = reminders.findIndex((r) => r.productId === productId && r.status === 'scheduled');
  if (existingIdx >= 0) {
    reminders[existingIdx] = { ...reminders[existingIdx], ...clean, id: reminders[existingIdx].id, createdAt: reminders[existingIdx].createdAt };
  } else {
    reminders.unshift(clean);
  }

  radar.reminders = reminders
    .filter((r) => r.id && r.productId)
    .sort((a, b) => a.remindAt - b.remindAt)
    .slice(0, 50);
  all[userId] = radar;
  writeAll(all);
  return radar;
}

/** Cancela un aviso (no se borra el registro: deja de intentar enviarlo). */
export function cancelReminder(userId: string, reminderId: string): RadarData {
  const all = readAll();
  const radar = all[userId] ?? emptyRadar();
  radar.reminders = (radar.reminders ?? []).map((r) =>
    r.id === reminderId ? { ...r, status: 'cancelled' } : r,
  );
  all[userId] = radar;
  writeAll(all);
  return radar;
}

/** Aviso activo ('scheduled') de un producto, si existe. */
export function getScheduledReminder(userId: string, productId: string): Reminder | null {
  const radar = getRadar(userId);
  return radar.reminders?.find((r) => r.productId === productId && r.status === 'scheduled') ?? null;
}

/**
 * Reclama (status → 'sending') todos los avisos vencidos de todos los usuarios
 * y los devuelve. El reclamo escribe en disco: si el proceso se reinicia a
 * medias, en el siguiente tick esos avisos vuelven a quedar como vencidos
 * únicamente si el envío no se completó (se marcan 'sent' al terminar).
 */
export function claimDueReminders(now = Date.now()): Array<{ userId: string; reminder: Reminder }> {
  const all = readAll();
  const claimed: Array<{ userId: string; reminder: Reminder }> = [];

  for (const [userId, radar] of Object.entries(all)) {
    const reminders = Array.isArray(radar.reminders) ? radar.reminders : [];
    let dirty = false;
    for (const reminder of reminders) {
      if (reminder.status === 'scheduled' && reminder.remindAt <= now) {
        reminder.status = 'sending';
        reminder.attempts = (reminder.attempts ?? 0) + 1;
        dirty = true;
        claimed.push({ userId, reminder: { ...reminder } });
      }
    }
    if (dirty) all[userId] = radar;
  }

  if (claimed.length > 0) writeAll(all);
  return claimed;
}

/** Marca el resultado de un envío (sent / failed con reintento). */
export function finishReminder(
  userId: string,
  reminderId: string,
  patch: Pick<Reminder, 'status'> & Partial<Pick<Reminder, 'sentAt' | 'lastError' | 'attempts'>>,
): void {
  const all = readAll();
  const radar = all[userId];
  if (!radar || !Array.isArray(radar.reminders)) return;
  radar.reminders = radar.reminders.map((r) => (r.id === reminderId ? { ...r, ...patch } : r));
  all[userId] = radar;
  writeAll(all);
}

/** Reprograma la fecha de un aviso (usado por el dispatcher al fallar el envío). */
export function deferReminder(userId: string, reminderId: string, remindAt: number): void {
  const all = readAll();
  const radar = all[userId];
  if (!radar || !Array.isArray(radar.reminders)) return;
  radar.reminders = radar.reminders.map((r) =>
    r.id === reminderId ? { ...r, remindAt: Math.max(0, Number(remindAt) || r.remindAt) } : r,
  );
  all[userId] = radar;
  writeAll(all);
}
