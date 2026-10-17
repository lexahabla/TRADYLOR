import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from './paths';

/**
 * ==============================================================================
 * TRADYLOR — PERFILES DE COMPRADOR (user_profiles.json)
 * ==============================================================================
 * Capa de datos equivalente a la tabla `user_profiles`: una ficha por usuario
 * de Mi Radar con sus preferencias comerciales (categorías, presupuesto,
 * perfil del quiz). El foco es marketing/segmentación: no guarda secretos ni
 * sustituye a radar-users.json (que sigue siendo la cuenta con su contraseña).
 * Persistencia en el volumen (/app/data en prod), escritura atómica.
 * ==============================================================================
 */

const DATA_FILE = dataFile('user_profiles.json');

export interface UserProfileRecord {
  userId: string;
  email: string;
  name?: string;
  /** Tipo de visitante (particular / profesional / empresa), si lo declaró. */
  profileType?: string;
  /** Slugs de categorías raíz preferidas. */
  preferredCategories: string[];
  /** Slugs de subcategorías preferidas. */
  preferredSubcategories: string[];
  /** Franja de presupuesto del quiz: ajustado (<200€) / moderado / premium. */
  budgetRange?: string;
  /** Arquetipo del comprador derivado del quiz (p. ej. 'cazador-techie'). */
  buyerProfile?: string;
  /** Respuestas crudas del quiz de perfilador ({paso → valor}). */
  quizAnswers?: Record<string, string>;
  updatedAt: string;
}

type ProfilesFile = Record<string, UserProfileRecord>;

const MAX_LIST = 50;

function readAll(): ProfilesFile {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ProfilesFile) : {};
  } catch (error) {
    console.error('[UserProfiles] Error leyendo user_profiles.json:', error);
    return {};
  }
}

function writeAll(data: ProfilesFile): void {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, DATA_FILE);
}

function cleanList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(values.map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean)),
  ).slice(0, MAX_LIST);
}

export interface UserProfilePatch {
  email?: string;
  name?: string;
  profileType?: string;
  preferredCategories?: string[];
  preferredSubcategories?: string[];
  budgetRange?: string;
  buyerProfile?: string;
  quizAnswers?: Record<string, string>;
}

/** Perfil del usuario (o null si nunca sincronizó). */
export function getUserProfile(userId: string): UserProfileRecord | null {
  return readAll()[userId] ?? null;
}

/**
 * Upsert idempotente del perfil (merge superficial: los campos presentes
 * sobrescriben; los ausentes se conservan).
 */
export function upsertUserProfile(userId: string, patch: UserProfilePatch): UserProfileRecord {
  const all = readAll();
  const current = all[userId] ?? {
    userId,
    email: '',
    preferredCategories: [],
    preferredSubcategories: [],
    updatedAt: new Date().toISOString(),
  };
  const next: UserProfileRecord = {
    ...current,
    email: patch.email ? String(patch.email).trim().toLowerCase() : current.email,
    name: patch.name !== undefined ? String(patch.name).trim().slice(0, 80) : current.name,
    profileType: patch.profileType !== undefined ? String(patch.profileType).trim().slice(0, 40) : current.profileType,
    preferredCategories: patch.preferredCategories
      ? cleanList(patch.preferredCategories)
      : current.preferredCategories ?? [],
    preferredSubcategories: patch.preferredSubcategories
      ? cleanList(patch.preferredSubcategories)
      : current.preferredSubcategories ?? [],
    budgetRange: patch.budgetRange !== undefined ? String(patch.budgetRange).trim().slice(0, 40) : current.budgetRange,
    buyerProfile: patch.buyerProfile !== undefined ? String(patch.buyerProfile).trim().slice(0, 60) : current.buyerProfile,
    quizAnswers: patch.quizAnswers
      ? Object.fromEntries(
          Object.entries(patch.quizAnswers)
            .map(([key, value]) => [String(key).slice(0, 40), String(value ?? '').slice(0, 80)] as const)
            .filter(([key, value]) => key && value),
        )
      : current.quizAnswers,
    updatedAt: new Date().toISOString(),
  };
  all[userId] = next;
  writeAll(all);
  return next;
}

export function deleteUserProfile(userId: string): void {
  const all = readAll();
  if (!(userId in all)) return;
  delete all[userId];
  writeAll(all);
}

export function getAllUserProfiles(): UserProfileRecord[] {
  return Object.values(readAll());
}
