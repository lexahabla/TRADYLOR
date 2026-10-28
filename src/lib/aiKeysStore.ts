import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from './paths';

/**
 * ==============================================================================
 * TRADYLOR - ALMACÉN DE API KEYS DE IA (PANEL DE ADMINISTRACIÓN)
 * ==============================================================================
 * Persiste las claves introducidas desde el panel (Transparencia › Conectividad
 * de IA) en `DATA_DIR/ai-keys.json` (volumen en producción; NUNCA se sube a
 * git). Estas claves son el fallback de `env()` en `lib/ai.ts`, así que todo
 * el botones de IA del panel (Enriquecer, Construir Catálogo, Pipeline…)
 * quedan conectados con las mismas credenciales.
 *
 * Proveedores soportados:
 *   openai      → OPENAI_API_KEY       (API oficial; sin modelos gratuitos)
 *   anthropic   → ANTHROPIC_API_KEY    (API oficial)
 *   groq        → GROQ_API_KEY         (plan gratuito con límite diario)
 *   nvidia      → NVIDIA_API_KEY       (NIM: API gratuita para sus modelos)
 *   openrouter  → OPENROUTER_API_KEY   (router con modelos `:free`)
 *   gemini      → GEMINI_API_KEY       (Google AI Studio; API oficial)
 *
 * Seguridad: las claves se devuelven SÓLO enmascaradas al navegador; la
 * escritura exige sesión de administrador (requireAdminAuth en el endpoint).
 * ==============================================================================
 */

export type AiProviderId = 'openai' | 'anthropic' | 'groq' | 'nvidia' | 'openrouter' | 'gemini';

export interface AiKeysFile {
  openai?: string;
  anthropic?: string;
  groq?: string;
  nvidia?: string;
  openrouter?: string;
  gemini?: string;
  updatedAt?: string;
}

/** Mapa env → proveedor: permite que `env()` en ai.ts haga fallback aquí. */
const ENV_TO_PROVIDER: Record<string, AiProviderId> = {
  OPENAI_API_KEY: 'openai',
  ANTHROPIC_API_KEY: 'anthropic',
  GROQ_API_KEY: 'groq',
  NVIDIA_API_KEY: 'nvidia',
  OPENROUTER_API_KEY: 'openrouter',
  GEMINI_API_KEY: 'gemini',
};

const KEYS_FILE = () => dataFile('ai-keys.json');

export const AI_PROVIDER_IDS: AiProviderId[] = ['openai', 'anthropic', 'groq', 'nvidia', 'openrouter', 'gemini'];

/** Lee el almacén; archivo ausente o corrupto ⇒ objeto vacío (nunca lanza). */
export function readAiKeys(): AiKeysFile {
  try {
    const raw = fs.readFileSync(KEYS_FILE(), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as AiKeysFile) : {};
  } catch {
    return {};
  }
}

/** Guarda (o sobrescribe) la clave de un proveedor. Escritura tmp+rename. */
export function saveAiKey(provider: AiProviderId, key: string): void {
  const keys = readAiKeys();
  keys[provider] = key.trim();
  keys.updatedAt = new Date().toISOString();
  writeKeysFile(keys);
}

/** Elimina la clave de un proveedor (desconectar). */
export function deleteAiKey(provider: AiProviderId): void {
  const keys = readAiKeys();
  delete keys[provider];
  keys.updatedAt = new Date().toISOString();
  writeKeysFile(keys);
}

function writeKeysFile(keys: AiKeysFile): void {
  const file = KEYS_FILE();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * Fallback para `env(name)` en `ai.ts`: si la variable de entorno no está
 * definida, mira la clave guardada desde el panel para ese nombre.
 * Devuelve '' si no hay nada guardado (comportamiento histórico intacto).
 */
export function storedKeyForEnv(envName: string): string {
  const provider = ENV_TO_PROVIDER[envName];
  if (!provider) return '';
  const keys = readAiKeys();
  return typeof keys[provider] === 'string' ? keys[provider]! : '';
}

/** Clave efectiva (env con prioridad, si no la guardada en el panel). */
export function effectiveKey(provider: AiProviderId): string {
  const envName = (Object.entries(ENV_TO_PROVIDER).find(([, p]) => p === provider) || [''])[0];
  const fromEnv = envName ? (process.env[envName] || '') : '';
  if (fromEnv) return fromEnv;
  const keys = readAiKeys();
  return typeof keys[provider] === 'string' ? keys[provider]! : '';
}

/** `sk-abc…xyz` → `sk-abc…xyz` (visible) para mostrar en el panel. */
export function maskKey(key: string): string {
  const value = String(key || '').trim();
  if (value.length <= 10) return value ? '••••••' : '';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** ¿Tiene clave (por env o por almacén)? Sólo devuelve boolean, nunca la clave. */
export function hasKeyFor(provider: AiProviderId): boolean {
  return Boolean(effectiveKey(provider));
}
