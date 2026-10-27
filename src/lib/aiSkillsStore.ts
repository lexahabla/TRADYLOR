/**
 * ==============================================================================
 * TRADYLOR — SKILLS DE ENTRENAMIENTO IA («Desarrollo IA»)
 * ==============================================================================
 * Persiste en `ai-skills.json` (DATA_DIR) las instrucciones que el admin
 * enseña a cada una de las dos personalidades de IA:
 *
 *   · dependiente — alimenta al widget flotante y a la página Dependiente IA
 *   · admin       — alimenta a la Consola IA del backend
 *
 * Se inyectan al final del system prompt de cada personalidad (ver
 * aiPersonas.ts `withSkills`). Los ficheros de datos NO van en git.
 * ==============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths';

export type AiPersonaId = 'dependiente' | 'admin';

export interface AiSkill {
  id: string;
  persona: AiPersonaId;
  /** Instrucción corta que se añade al prompt (1-4 frases). */
  text: string;
  createdAt: string;
}

interface StoreFile {
  skills: AiSkill[];
}

const FILE_NAME = 'ai-skills.json';
const MAX_SKILLS_PER_PERSONA = 40;

function filePath(): string {
  return path.join(DATA_DIR, FILE_NAME);
}

function emptyStore(): StoreFile {
  return { skills: [] };
}

function readStore(): StoreFile {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed || !Array.isArray(parsed.skills)) return emptyStore();
    return parsed;
  } catch {
    return emptyStore();
  }
}

function writeStore(store: StoreFile): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(filePath(), `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error('[aiSkillsStore] Error al guardar:', error);
  }
}

/** Devuelve los textos de skills de una persona, listos para `withSkills`. */
export function getSkillsForPersona(persona: AiPersonaId): string[] {
  return readStore()
    .skills.filter((s) => s.persona === persona)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((s) => s.text);
}

export function listSkills(persona?: AiPersonaId): AiSkill[] {
  const skills = readStore().skills;
  return persona ? skills.filter((s) => s.persona === persona) : skills;
}

/** Añade una skill. Devuelve `null` si la persona es inválida o está repetida. */
export function addSkill(persona: AiPersonaId, text: string): AiSkill | null {
  if (persona !== 'dependiente' && persona !== 'admin') return null;
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;

  const store = readStore();
  const personaSkills = store.skills.filter((s) => s.persona === persona);
  if (personaSkills.length >= MAX_SKILLS_PER_PERSONA) return null;
  if (personaSkills.some((s) => s.text.toLowerCase() === trimmed.toLowerCase())) return null;

  const skill: AiSkill = {
    id: `skill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    persona,
    text: trimmed.slice(0, 600),
    createdAt: new Date().toISOString(),
  };
  store.skills.push(skill);
  writeStore(store);
  return skill;
}

/** Elimina una skill por id. Devuelve `true` si existía. */
export function removeSkill(id: string): boolean {
  const store = readStore();
  const before = store.skills.length;
  store.skills = store.skills.filter((s) => s.id !== id);
  if (store.skills.length === before) return false;
  writeStore(store);
  return true;
}
