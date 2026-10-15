/**
 * ==============================================================================
 * TRADYLOR - ALMACÉN SEGURO DE CREDENCIALES POR RED
 * ==============================================================================
 * Persistencia en src/data/credentials.json con esta forma:
 *   {
 *     "networks": {
 *       "amazon": {
 *         "values": { "accessKey": "...", "secretKey": "...", "trackingId": "..." },
 *         "status": "connected",
 *         "validatedAt": "2026-09-16T10:00:00.000Z"
 *       }
 *     }
 *   }
 *
 * Seguridad:
 *  - El archivo NUNCA se expone: solo se lee/escribe desde código de servidor.
 *  - Las vistas públicas (NetworkView) enmascaran los valores (hasValue: true/false).
 *  - Recomendado añadir src/data/credentials.json a .gitignore.
 * ==============================================================================
 */

import fs from 'node:fs';
import { getAllNetworks, getNetworkDefinition } from './registry';
import type { NetworkStatus, NetworkView } from './types';
import { DATA_DIR, dataFile } from '../paths';

const CREDENTIALS_PATH = dataFile('credentials.json');

interface StoredNetworkCredentials {
  values: Record<string, string>;
  status: NetworkStatus;
  statusDetail?: string;
  validatedAt?: string;
}

interface CredentialsFile {
  networks: Record<string, StoredNetworkCredentials>;
}

function readFile(): CredentialsFile {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
      if (parsed && typeof parsed === 'object' && parsed.networks) return parsed as CredentialsFile;
    }
  } catch (error) {
    console.error('[Credentials] Error al leer credentials.json:', error);
  }
  return { networks: {} };
}

function writeFile(data: CredentialsFile): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/** Guarda las credenciales de una red. Marca la conexión como pendiente de validar. */
export function saveCredentials(networkId: string, values: Record<string, string>): NetworkView | null {
  const definition = getNetworkDefinition(networkId);
  if (!definition) return null;

  const data = readFile();
  const envMap = ENV_CREDENTIALS[networkId] ?? {};
  const cleanValues: Record<string, string> = {};
  for (const field of definition.fields) {
    const value = String(values[field.key] ?? '').trim();
    const previous = data.networks[networkId]?.values?.[field.key];
    if (value) cleanValues[field.key] = value;
    else if (previous) cleanValues[field.key] = previous;
    else if (field.required && !envCredential(envMap[field.key] ?? '')) {
      // Requerido y ni guardado ni disponible por variable de entorno.
      return null;
    }
    // Opcional vacío: se omite (se podrá completar luego; el conector usa env de fallback).
  }

  data.networks[networkId] = {
    values: cleanValues,
    status: 'pending',
    validatedAt: new Date().toISOString(),
  };
  writeFile(data);
  return getNetworkView(networkId);
}

/** Elimina las credenciales de una red (desconectar). */
export function deleteCredentials(networkId: string): boolean {
  const data = readFile();
  if (!data.networks[networkId]) return false;
  delete data.networks[networkId];
  writeFile(data);
  return true;
}

/** Devuelve los valores crudos de una red (SOLO uso interno en servidor). */
export function getCredentialValues(networkId: string): Record<string, string> | null {
  return readFile().networks[networkId]?.values ?? null;
}

const ENV_CREDENTIALS: Record<string, Record<string, string>> = {
  aliexpress: {
    appKey: 'ALIEXPRESS_APP_KEY',
    appSecret: 'ALIEXPRESS_APP_SECRET',
    trackingId: 'ALIEXPRESS_TRACKING_ID',
  },
};

function envCredential(name: string): string {
  return String(process.env[name] ?? '').trim();
}

/**
 * Valores disponibles para una red: los guardados en el panel + los que sólo
 * existen como variables de entorno de EasyPanel (fallback).
 */
export function getMergedCredentialValues(networkId: string): Record<string, string> {
  const stored = getCredentialValues(networkId) ?? {};
  const fromEnv = ENV_CREDENTIALS[networkId] ?? {};
  const merged: Record<string, string> = { ...stored };
  for (const [key, envName] of Object.entries(fromEnv)) {
    if (!merged[key] && envCredential(envName)) merged[key] = envCredential(envName);
  }
  return merged;
}

/** Actualiza el estado de conexión tras una validación. */
export function setNetworkStatus(networkId: string, status: NetworkStatus, detail?: string): void {
  const data = readFile();
  if (!data.networks[networkId]) return;
  data.networks[networkId].status = status;
  data.networks[networkId].statusDetail = detail;
  data.networks[networkId].validatedAt = new Date().toISOString();
  writeFile(data);
}

/** Vista pública de una red: campos enmascarados, sin secretos. */
export function getNetworkView(networkId: string): NetworkView | null {
  const definition = getNetworkDefinition(networkId);
  if (!definition) return null;
  const stored = readFile().networks[networkId];
  const available = getMergedCredentialValues(networkId);

  return {
    id: definition.id,
    name: definition.name,
    region: definition.region,
    color: definition.color,
    description: definition.description,
    docUrl: definition.docUrl,
    fields: definition.fields.map((field) => ({
      ...field,
      hasValue: Boolean(stored?.values?.[field.key] || available[field.key]),
    })),
    status: stored?.status ?? 'pending',
    statusDetail: stored?.statusDetail,
    validatedAt: stored?.validatedAt,
  };
}

/** Vista pública de todas las redes registradas. */
export function getAllNetworkViews(): NetworkView[] {
  return getAllNetworks().map((network) => getNetworkView(network.id)).filter(Boolean) as NetworkView[];
}

/** IDs de redes con credenciales completas (archivo o variables de entorno). */
export function getConnectedNetworkIds(): string[] {
  return getAllNetworks()
    .filter((network) => network.fields.filter((f) => f.required).every((f) => Boolean(getMergedCredentialValues(network.id)[f.key])))
    .map((network) => network.id);
}
