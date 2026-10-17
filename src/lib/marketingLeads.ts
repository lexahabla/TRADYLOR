import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataFile } from './paths';

/**
 * ==============================================================================
 * TRADYLOR — LEADS DE MARKETING (marketing_leads.json)
 * ==============================================================================
 * Equivalente a la tabla `marketing_leads`: cada registro es un contacto al
 * que se le puede hacer campañas (segmentación por perfil, categorías,
 * últimas búsquedas y tamaño del radar). Se alimenta en cada sync de perfil
 * (/api/user-profile/sync) y se puede enriquecer desde el panel admin.
 * Clave natural: email (lowercase). Persistencia en el volumen.
 * ==============================================================================
 */

const DATA_FILE = dataFile('marketing_leads.json');

export interface MarketingLead {
  /** uuid del registro (estable aunque cambie el email). */
  id: string;
  /** Cuenta de Mi Radar asociada, si existe. */
  userId?: string;
  email: string;
  name?: string;
  /** Perfil segmentable: buyerProfile, budgetRange, profileType, categorías… */
  profileData: Record<string, unknown>;
  /** Últimos términos buscados en la web (más reciente primero, máx. 50). */
  lastSearchTerms: string[];
  /** Cuántos productos tenía en el radar en el último sync. */
  radarProductCount?: number;
  /** Origen del lead: register | quiz | sync | admin. */
  source: string;
  createdAt: string;
  lastSyncedAt: string;
}

type LeadsFile = Record<string, MarketingLead>; // clave: email

const SEARCH_TERMS_MAX = 50;

function readAll(): LeadsFile {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as LeadsFile) : {};
  } catch (error) {
    console.error('[MarketingLeads] Error leyendo marketing_leads.json:', error);
    return {};
  }
}

function writeAll(data: LeadsFile): void {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, DATA_FILE);
}

function uuid(): string {
  return randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function cleanTerms(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(values.map((value) => String(value ?? '').trim().slice(0, 120)).filter(Boolean)),
  ).slice(0, SEARCH_TERMS_MAX);
}

export interface MarketingLeadUpsert {
  userId?: string;
  email: string;
  name?: string;
  profileData?: Record<string, unknown>;
  /** Términos nuevos (se unen a los ya guardados, sin duplicados). */
  lastSearchTerms?: string[];
  radarProductCount?: number;
  source?: string;
}

/**
 * Upsert por email: fusiona perfil, búsqueda y contador de radar. Los campos
 * ausentes se conservan (el sync puede llegar parcialo).
 */
export function upsertMarketingLead(input: MarketingLeadUpsert): MarketingLead {
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!email) throw new Error('El lead necesita email.');
  const all = readAll();
  const now = new Date().toISOString();
  const current = all[email];
  const mergedTerms = cleanTerms([
    ...(input.lastSearchTerms ?? []),
    ...(current?.lastSearchTerms ?? []),
  ]);
  const lead: MarketingLead = {
    id: current?.id ?? uuid(),
    userId: input.userId ?? current?.userId,
    email,
    name: input.name?.trim().slice(0, 80) || current?.name,
    profileData: { ...(current?.profileData ?? {}), ...(input.profileData ?? {}) },
    lastSearchTerms: mergedTerms,
    radarProductCount:
      typeof input.radarProductCount === 'number' ? input.radarProductCount : current?.radarProductCount,
    source: input.source ?? current?.source ?? 'sync',
    createdAt: current?.createdAt ?? now,
    lastSyncedAt: now,
  };
  all[email] = lead;
  writeAll(all);
  return lead;
}

export function findMarketingLeadByEmail(email: string): MarketingLead | null {
  return readAll()[String(email ?? '').trim().toLowerCase()] ?? null;
}

export function getMarketingLeads(): MarketingLead[] {
  return Object.values(readAll()).sort((a, b) => b.lastSyncedAt.localeCompare(a.lastSyncedAt));
}

export function deleteMarketingLead(email: string): void {
  const all = readAll();
  const key = String(email ?? '').trim().toLowerCase();
  if (!(key in all)) return;
  delete all[key];
  writeAll(all);
}
