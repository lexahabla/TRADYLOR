/**
 * ==============================================================================
 * TRADYLOR - REGISTRO DE REDES DE AFILIACIÓN
 * ==============================================================================
 * Definición central de todas las redes soportadas. Para añadir una red nueva:
 *   1. Añade su definición aquí (id, campos de credenciales, documentación).
 *   2. Crea su conector en src/lib/networks/connectors/<id>.ts
 *   3. Regístralo en src/lib/networks/index.ts (CONNECTORS).
 *
 * Además, el panel de admin permite crear afiliados nuevos y eliminar los que
 * no interesen SIN tocar el código: ver createNetwork() y customNetworks.ts
 * (persistencia en src/data/networks.json).
 * ==============================================================================
 */

import {
  addCustomNetwork,
  listCustomNetworks,
  listRemovedIds,
} from './customNetworks';
import type { CredentialField, NetworkDefinition } from './types';

export const NETWORKS: NetworkDefinition[] = [
  {
    id: 'amazon',
    name: 'Amazon Associates',
    region: 'Global / UE',
    color: '#ff9900',
    description: 'Product Advertising API 5.0. Catálogo completo con precios, valoraciones y disponibilidad en tiempo real.',
    docUrl: 'https://webservices.amazon.com/paapi5/documentation/',
    fields: [
      { key: 'accessKey', label: 'Access Key (PA-API)', secret: false, required: true, placeholder: 'AKIA...' },
      { key: 'secretKey', label: 'Secret Key (PA-API)', secret: true, required: true },
      { key: 'trackingId', label: 'Tracking ID / Associate Tag', secret: false, required: true, placeholder: 'tradylor-21' },
      { key: 'region', label: 'Región', secret: false, required: false, placeholder: 'eu-west-1' },
    ],
  },
  {
    id: 'aliexpress',
    name: 'AliExpress Portals',
    region: 'Global',
    color: '#e62e04',
    description: 'API oficial de afiliados: catálogo, comisiones por categoría y generación de enlaces con tracking.',
    docUrl: 'https://developers.aliexpress.com/en/doc.htm',
    fields: [
      { key: 'appKey', label: 'App Key', secret: false, required: true },
      { key: 'appSecret', label: 'App Secret', secret: true, required: true },
      { key: 'trackingId', label: 'Tracking ID', secret: false, required: true },
    ],
  },
  {
    id: 'ebay',
    name: 'eBay Partner Network',
    region: 'Global / UE',
    color: '#86b817',
    description: 'Browse API + Feed API. Ofertas, subastas y productos con comisión por categoría (EPC).',
    docUrl: 'https://developer.ebay.com/api-docs/buy/static/api-browse.html',
    fields: [
      { key: 'clientId', label: 'Client ID (App ID)', secret: false, required: true },
      { key: 'clientSecret', label: 'Client Secret', secret: true, required: true },
      { key: 'campaignId', label: 'Campaign ID (EPN)', secret: false, required: true },
    ],
  },
  {
    id: 'awin',
    name: 'Awin',
    region: 'Europa / Global',
    color: '#e40046',
    description: 'Publisher API: feeds de producto, anunciantes europeos (MediaMarkt, Fnac...) y comisiones exactas.',
    docUrl: 'https://developer.awin.com/',
    fields: [
      { key: 'publisherId', label: 'Publisher ID', secret: false, required: true },
      { key: 'apiToken', label: 'API Token', secret: true, required: true },
    ],
  },
  {
    id: 'cj',
    name: 'CJ Affiliate',
    region: 'Global',
    color: '#00af66',
    description: 'Commission Junction: product search API, deep links y métricas de conversión por anunciante.',
    docUrl: 'https://developers.cj.com/',
    fields: [
      { key: 'websiteId', label: 'Website ID (PID)', secret: false, required: true },
      { key: 'apiToken', label: 'Personal Access Token', secret: true, required: true },
    ],
  },
  {
    id: 'admitad',
    name: 'Admitad',
    region: 'Europa / LatAm',
    color: '#ff5b24',
    description: 'Red fuerte en UE y LatAm: feeds de producto, cupones y deeplinks con comisiones por acción.',
    docUrl: 'https://developers.admitad.com/',
    fields: [
      { key: 'websiteId', label: 'Website ID', secret: false, required: true },
      { key: 'apiToken', label: 'API Token (Bearer)', secret: true, required: true },
    ],
  },
  {
    id: 'tradedoubler',
    name: 'Tradedoubler / Metapic',
    region: 'Europa (Nórdica/UE)',
    color: '#005f9e',
    description: 'Campañas europeas, feeds de producto y monetización de contenido mediante Metapic.',
    docUrl: 'https://dev.tradedoubler.com/',
    fields: [
      { key: 'partnerId', label: 'Partner / Site ID', secret: false, required: true },
      { key: 'apiToken', label: 'API Token', secret: true, required: true },
    ],
  },
  {
    id: 'kwanko',
    name: 'Kwanko (NetAffiliation)',
    region: 'Europa (Francia/UE)',
    color: '#6a2c91',
    description: 'Red francesa con gran cobertura retail europeo: campañas CPA/CPC y tracking avanzado.',
    docUrl: 'https://www.kwanko.com/',
    fields: [
      { key: 'publisherId', label: 'Publisher ID', secret: false, required: true },
      { key: 'apiToken', label: 'API Token', secret: true, required: true },
    ],
  },
  {
    id: 'etsy',
    name: 'Etsy Affiliate Program',
    region: 'Global',
    color: '#f1641e',
    description: 'API v3 de Etsy: artículos hechos a mano y vintage con atribución de afiliado vía Awin/Enlyft.',
    docUrl: 'https://developers.etsy.com/documentation/',
    fields: [
      { key: 'apiKey', label: 'API Key (Keystring)', secret: true, required: true },
      { key: 'affiliateId', label: 'Affiliate / Shop ID', secret: false, required: false },
    ],
  },
  {
    id: 'webgains',
    name: 'Webgains',
    region: 'Europa (UK/UE)',
    color: '#e94e1b',
    description: 'Red británica con fuerte presencia en UE: product feed API y comisiones por anunciante.',
    docUrl: 'https://www.webgains.com/public/en/developers/',
    fields: [
      { key: 'siteId', label: 'Site ID', secret: false, required: true },
      { key: 'apiKey', label: 'API Key', secret: true, required: true },
    ],
  },
  {
    id: 'partnerize',
    name: 'Partnerize',
    region: 'Global',
    color: '#1f4fff',
    description: 'Plataforma enterprise de partnerships: tracking, comisiones dinámicas y catálogos de marcas globales.',
    docUrl: 'https://docs.partnerize.com/',
    fields: [
      { key: 'publisherId', label: 'Publisher ID', secret: false, required: true },
      { key: 'apiKey', label: 'User API Key', secret: true, required: true },
      { key: 'apiSecret', label: 'User API Secret', secret: true, required: true },
    ],
  },
  {
    id: 'rakuten',
    name: 'Rakuten Advertising',
    region: 'Global / UE',
    color: '#bf0000',
    description: 'Red global (antes LinkShare): enlaces de producto, cupones y reporting de conversiones.',
    docUrl: 'https://developers.rakutenadvertising.com/',
    fields: [
      { key: 'siteId', label: 'Site ID (SID)', secret: false, required: true },
      { key: 'apiToken', label: 'Access Token', secret: true, required: true },
    ],
  },
];

/** Convierte un texto en un id slug tipo `amazon-associates`. */
function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const FALLBACK_COLORS = ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185'];

/** Lista ACTIVA de redes: predefinidas no eliminadas + afiliados personalizados. */
export function getAllNetworks(): NetworkDefinition[] {
  const removed = new Set(listRemovedIds());
  return [...NETWORKS.filter((network) => !removed.has(network.id)), ...listCustomNetworks()];
}

/** Redes predefinidas eliminadas desde el panel (restaurables). */
export function getRemovedNetworks(): NetworkDefinition[] {
  const removed = new Set(listRemovedIds());
  return NETWORKS.filter((network) => removed.has(network.id));
}

export function getNetworkDefinition(id: string): NetworkDefinition | undefined {
  return getAllNetworks().find((network) => network.id === id);
}

export interface NewNetworkInput {
  name?: unknown;
  region?: unknown;
  description?: unknown;
  docUrl?: unknown;
  color?: unknown;
  fields?: unknown;
}

export type CreateNetworkResult = { ok: true; network: NetworkDefinition } | { ok: false; message: string };

/** Crea un afiliado nuevo desde el panel y lo persiste en networks.json. */
export function createNetwork(input: NewNetworkInput): CreateNetworkResult {
  const name = String(input.name ?? '').trim().slice(0, 80);
  if (name.length < 2) {
    return { ok: false, message: 'El nombre del afiliado debe tener al menos 2 caracteres.' };
  }

  const rawFields = Array.isArray(input.fields) ? input.fields : [];
  const fields: CredentialField[] = [];
  const takenKeys = new Set<string>();
  for (const raw of rawFields) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const label = String(item.label ?? '').trim().slice(0, 60);
    if (!label) continue;
    const base = slugify(label) || `campo-${fields.length + 1}`;
    let key = base;
    let suffix = 2;
    while (takenKeys.has(key)) key = `${base}-${suffix++}`;
    takenKeys.add(key);
    const placeholder = String(item.placeholder ?? '').trim().slice(0, 60);
    fields.push({
      key,
      label,
      secret: Boolean(item.secret),
      required: Boolean(item.required),
      ...(placeholder ? { placeholder } : {}),
    });
  }
  if (fields.length === 0) {
    return { ok: false, message: 'Añade al menos un campo de credencial con etiqueta.' };
  }

  const takenIds = new Set<string>([
    ...NETWORKS.map((network) => network.id),
    ...listCustomNetworks().map((network) => network.id),
    ...listRemovedIds(),
  ]);
  let id = slugify(name) || 'red';
  if (takenIds.has(id)) {
    let suffix = 2;
    while (takenIds.has(`${id}-${suffix}`)) suffix++;
    id = `${id}-${suffix}`;
  }

  let docUrl = String(input.docUrl ?? '').trim().slice(0, 300);
  if (docUrl && !/^https?:\/\//i.test(docUrl)) docUrl = `https://${docUrl}`;

  const colorInput = String(input.color ?? '').trim();
  const color = /^#[0-9a-f]{6}$/i.test(colorInput)
    ? colorInput
    : FALLBACK_COLORS[slugify(name).length % FALLBACK_COLORS.length];

  const network: NetworkDefinition = {
    id,
    name,
    region: String(input.region ?? '').trim().slice(0, 60) || 'Personalizada',
    color,
    description: String(input.description ?? '').trim().slice(0, 300) || 'Red de afiliación creada desde el panel.',
    docUrl,
    fields,
  };

  addCustomNetwork(network);
  return { ok: true, network };
}
