/**
 * ==============================================================================
 * TRADYLOR — REGIÓN DEL VISITANTE → IDIOMAS COOFICIALES (compartir por email)
 * ==============================================================================
 * Sólo servidor. Decide qué idiomas regionales (catalán, euskera, gallego) se
 * ofrecen en el selector de /share/[id] y en el panel de compartir:
 *
 *  1. Cabecera Accept-Language: si trae ca / eu / gl (aunque no sea el primero).
 *  2. Geolocalización por IP (ipwho.is, con geojs.io de respaldo): un usuario de
 *     Catalunya con el navegador en castellano no manda "ca" en ningún sitio, así
 *     que sólo la IP delata la región.
 *
 * Privacidad: la IP únicamente se envía al servicio de geolocalización, se cachea
 * en memoria 24 h y no se guarda en disco. SHARE_GEO_LOOKUP=off desactiva el paso 2
 * (entonces sólo cuenta la cabecera del navegador).
 * ==============================================================================
 */

import { isIP } from 'node:net';
import type { ShareLangCode } from '../utils/share';

/** Comunidades autónomas (ISO 3166-2:ES, sin el prefijo "ES-") → idiomas cooficiales. */
const REGION_LANGS: Record<string, ShareLangCode[]> = {
  CT: ['ca'], // Catalunya
  IB: ['ca'], // Illes Balears
  VC: ['ca'], // Comunitat Valenciana
  PV: ['eu'], // Euskadi
  NC: ['eu'], // Navarra
  GA: ['gl'], // Galicia
};

/** Países con idioma propio con plantilla. */
const COUNTRY_LANGS: Record<string, ShareLangCode[]> = {
  AD: ['ca'], // Andorra
};

/** Algunos servicios no devuelven el código ISO sino sólo el nombre de la región. */
const REGION_NAME_HINTS: Array<[RegExp, string]> = [
  [/catalu|catalon/, 'CT'],
  [/balear/, 'IB'],
  [/valenc/, 'VC'],
  [/pais vasco|basque|euskadi|bizkaia|vizcaya|gipuzkoa|guipuzcoa|araba|alava/, 'PV'],
  [/navarr|nafarroa/, 'NC'],
  [/galicia|galiza/, 'GA'],
];

const REGIONAL: ShareLangCode[] = ['ca', 'eu', 'gl'];

const GEO_TIMEOUT_MS = 2000;
const CACHE_OK_MS = 24 * 60 * 60 * 1000;
const CACHE_FAIL_MS = 10 * 60 * 1000;
const CACHE_MAX = 5000;
/** Tope global de consultas externas por hora (protege la cuota gratuita del servicio). */
const HOURLY_BUDGET = 400;

export interface RegionDetection {
  /** Idiomas cooficiales a ofrecer (subconjunto de ca / eu / gl). */
  langs: ShareLangCode[];
  /** true si no hace falta reintentar (geolocalización resuelta, desactivada o IP local). */
  resolved: boolean;
  /** Código de región (CT, PV…) o nombre, sólo informativo. */
  region?: string;
}

interface GeoInfo {
  country: string;
  regionCode: string;
  regionName: string;
}

/** Idiomas cooficiales que declara la cabecera Accept-Language (q>0). */
export function langsFromAcceptLanguage(header: string | null | undefined): ShareLangCode[] {
  const out: ShareLangCode[] = [];
  for (const part of String(header ?? '').split(',')) {
    const [tag, ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q && !(Number(q.slice(2)) > 0)) continue;
    const code = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0] as ShareLangCode;
    if (REGIONAL.includes(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

function normalizeIp(raw: string | null | undefined): string | undefined {
  let ip = String(raw ?? '').trim();
  if (!ip) return undefined;
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    ip = end > 0 ? ip.slice(1, end) : ip;
  } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }
  if (ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : undefined;
}

/** IP del cliente tras el proxy (misma convención que el resto de la web). */
export function clientIp(request: Request): string | undefined {
  const headers = request.headers;
  return (
    normalizeIp(headers.get('x-forwarded-for')?.split(',')[0]) ??
    normalizeIp(headers.get('x-real-ip')) ??
    normalizeIp(headers.get('cf-connecting-ip'))
  );
}

function isPublicIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    return true;
  }
  if (version === 6) {
    const low = ip.toLowerCase();
    if (low === '::' || low === '::1') return false;
    if (/^f[cd]/.test(low) || low.startsWith('fe80')) return false;
    return true;
  }
  return false;
}

function geoLookupEnabled(): boolean {
  const raw = String(process.env.SHARE_GEO_LOOKUP ?? import.meta.env.SHARE_GEO_LOOKUP ?? 'on')
    .trim()
    .toLowerCase();
  return !['off', '0', 'false', 'no', 'disabled'].includes(raw);
}

function regionCodeFromName(name: string): string {
  const plain = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  for (const [pattern, code] of REGION_NAME_HINTS) {
    if (pattern.test(plain)) return code;
  }
  return '';
}

/** Región (país + comunidad) → idiomas cooficiales. */
export function langsFromGeo(geo: GeoInfo): ShareLangCode[] {
  const byCountry = COUNTRY_LANGS[geo.country];
  if (byCountry) return [...byCountry];
  if (geo.country !== 'ES') return [];
  const code = geo.regionCode in REGION_LANGS ? geo.regionCode : regionCodeFromName(geo.regionName);
  return code in REGION_LANGS ? [...REGION_LANGS[code]] : [];
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'tradylor-web/1.0 (+https://tradylor.com)' },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function viaIpwho(ip: string): Promise<GeoInfo | null> {
  const data = await fetchJson(`https://ipwho.is/${ip}?fields=success,country_code,region,region_code`);
  if (!data || data.success !== true) return null;
  return {
    country: String(data.country_code ?? '').toUpperCase(),
    regionCode: String(data.region_code ?? '').toUpperCase(),
    regionName: String(data.region ?? ''),
  };
}

async function viaGeojs(ip: string): Promise<GeoInfo | null> {
  const data = await fetchJson(`https://get.geojs.io/v1/ip/geo/${ip}.json`);
  if (!data || !data.country_code) return null;
  return {
    country: String(data.country_code).toUpperCase(),
    regionCode: '',
    regionName: String(data.region ?? ''),
  };
}

// --- caché en memoria + control de cuota ------------------------------------
const cache = new Map<string, { geo: GeoInfo | null; expires: number }>();
const inflight = new Map<string, Promise<GeoInfo | null>>();
let budgetStart = Date.now();
let budgetUsed = 0;

function takeBudget(): boolean {
  const now = Date.now();
  if (now - budgetStart > 60 * 60 * 1000) {
    budgetStart = now;
    budgetUsed = 0;
  }
  if (budgetUsed >= HOURLY_BUDGET) return false;
  budgetUsed += 1;
  return true;
}

async function geoFor(ip: string): Promise<GeoInfo | null> {
  const hit = cache.get(ip);
  if (hit && hit.expires > Date.now()) return hit.geo;

  const pending = inflight.get(ip);
  if (pending) return pending;
  if (!takeBudget()) return null;

  const job = (async () => {
    const geo = (await viaIpwho(ip)) ?? (await viaGeojs(ip));
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(ip, { geo, expires: Date.now() + (geo ? CACHE_OK_MS : CACHE_FAIL_MS) });
    return geo;
  })().finally(() => inflight.delete(ip));

  inflight.set(ip, job);
  return job;
}

/** Idiomas regionales a ofrecer a quien hace esta petición. */
export async function detectRegionLangs(request: Request): Promise<RegionDetection> {
  const langs = langsFromAcceptLanguage(request.headers.get('accept-language'));
  const detection: RegionDetection = { langs, resolved: false };

  const ip = clientIp(request);
  if (!geoLookupEnabled() || !ip || !isPublicIp(ip)) {
    // Sin geolocalización posible (desactivada / red local): no tiene sentido reintentar.
    detection.resolved = true;
    return detection;
  }

  const geo = await geoFor(ip);
  if (geo) {
    detection.resolved = true;
    detection.region = geo.regionCode || geo.regionName || undefined;
    for (const code of langsFromGeo(geo)) {
      if (!langs.includes(code)) langs.push(code);
    }
  }
  return detection;
}
