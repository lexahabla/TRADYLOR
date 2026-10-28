/**
 * ==============================================================================
 * TRADYLOR — PERFILADOR STORE (cliente, CRUD de Perfiles de Comprador)
 * ==============================================================================
 * Dominio propio del Perfilador (`SmartMatcherWizard`): no es Mi Radar. Este
 * fichero solo reutiliza el motor de almacenamiento/sincronización de
 * `./radarStore.ts` (LocalStorage `tradylor-radar-v1` + POST /api/radar) como
 * infraestructura genérica compartida con el resto de "registros de
 * herramienta" (comparativas del Comparador, chats del Dependiente IA).
 *
 * Este archivo corre en el navegador (scripts bundled de Astro); no importar
 * nada de Node aquí.
 * ==============================================================================
 */

import {
  BUYER_PROFILE_MAX,
  buyerProfileColor,
  buyerProfileDisplayName,
  hslString,
  type BuyerProfile,
} from '../types/buyerProfile';
import {
  loadRadar,
  persist,
  pushToCloud,
  shortId,
  withTombstone,
} from './radarStore';

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
 * Guarda el resultado del Perfilador como un nuevo perfil nombrado y lo marca
 * como activo. Máximo 6 perfiles: uno por cada uso del paso 1 del Perfilador.
 * Si ya había un perfil guardado para ese mismo uso, se SUSTITUYE (conserva
 * su id y fecha de creación) en vez de amontonar varios perfiles con el mismo
 * uso. Igual que el resto de mutaciones, sólo se refleja en la nube si hay
 * sesión (si no, el push a /api/radar se ignora con 401).
 */
export function saveBuyerProfile(input: { name?: string; usage: string; budget: string; priority: string }): BuyerProfile {
  const data = loadRadar();
  const now = new Date().toISOString();
  // El nombre se genera automáticamente a partir de la combinación (uso +
  // presupuesto + prioridad): el usuario ya no lo escribe a mano.
  const name = buyerProfileDisplayName(input);
  const color = hslString(buyerProfileColor(input));
  const existing = (data.buyerProfiles ?? []).find((p) => p.usage === input.usage);
  const profile: BuyerProfile = {
    id: existing?.id ?? shortId('bp'),
    name,
    color,
    usage: input.usage,
    budget: input.budget,
    priority: input.priority,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const otherUsages = (data.buyerProfiles ?? []).filter((p) => p.usage !== input.usage);
  data.buyerProfiles = [profile, ...otherUsages].slice(0, BUYER_PROFILE_MAX);
  data.activeBuyerProfileId = profile.id;
  persist(data);
  void pushToCloud(data);
  return profile;
}

/**
 * Marca (o quita, con `null`) el perfil activo del selector del mainNav.
 *
 * Al desactivar se guarda `''` (string vacío), NUNCA `undefined`: el servidor
 * (`syncRadar`) distingue "el cliente no informa del campo" (clave ausente,
 * conserva lo que haya en la nube) de "el cliente pide explícitamente que no
 * haya ninguno activo" (clave presente con `''`). Como `JSON.stringify`
 * elimina las claves con valor `undefined`, enviar `undefined` hacía que la
 * desactivación nunca llegara al servidor: el siguiente push/pull la
 * revertía trayendo de vuelta el perfil activo antiguo de la nube.
 */
export function setActiveBuyerProfile(id: string | null): void {
  const data = loadRadar();
  data.activeBuyerProfileId = id ?? '';
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
