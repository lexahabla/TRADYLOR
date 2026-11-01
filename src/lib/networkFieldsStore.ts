/**
 * ============================================================================
 * TRADYLOR — CAMPOS CAPTURABLES DE REDES DE AFILIACIÓN
 * ============================================================================
 * Permite al admin elegir qué campos `extra` de cada red de afiliación
 * (AliExpress, eBay, Amazon…) se capturan al sincronizar el catálogo.
 *
 *   - Cada red define una lista de campos disponibles (clave → etiqueta).
 *   - El admin puede marcar "Capturar todos los campos de esta red" o
 *     elegir campos individuales mediante select + botón "Añadir".
 *   - La selección se guarda y se respeta en el pipeline de sincronización
 *     para no almacenar campos que no se van a usar.
 *
 * Persistencia: `network-fields.json` en DATA_DIR (NO va a git).
 *
 * FUENTES DE LOS CAMPOS (claves tal como aparecen en `product.extra`):
 *   - AliExpress: lib/networks/connectors/aliexpress.ts  → mapProduct() extra
 *   - eBay:       lib/networks/connectors/adapters/ebayProductAdapter.ts
 *                  → adaptSingle() extra (líneas ~366) y adaptSingleCanonical()
 *                  → extra (líneas ~241)
 *   - Amazon:     lib/lib/amazonImport.ts → importAmazonProduct() extra
 *                  (líneas ~620) y amazonProductAdapter.ts (PA-API).
 *                  Los campos de Amazon se preparan para cuando se conecte
 *                  la API oficial desde hosting convencional (PA-API o
 *                  ScraperAPI estructurado). Algunos son estimados/placeholder
 *                  hasta que haya conexión real.
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths';

export interface NetworkFieldDef {
  /** Clave del campo dentro de `product.extra` de esa red. */
  key: string;
  /** Etiqueta legible para el admin. */
  label: string;
}

export interface NetworkFieldsConfig {
  id: string;           // id de la red (ej: 'aliexpress', 'ebay', 'amazon')
  name: string;         // nombre legible
  /** Campos disponibles de esta red (no seleccionados aún). */
  available: NetworkFieldDef[];
  /** Claves de campos que el admin ha elegido capturar. */
  selected: string[];
  /** Si es true, se capturan TODOS los campos disponibles (selected se ignora). */
  captureAll: boolean;
}

interface StoreFile {
  networks: NetworkFieldsConfig[];
}

const FILE_NAME = 'network-fields.json';

/**
 * Campos disponibles por red. Claves coinciden con los `extra` que cada
 * conector escribe en `product.extra`.
 */
const FIELDS_BY_NETWORK: Record<string, NetworkFieldDef[]> = {
  aliexpress: [
    { key: 'ID producto', label: 'ID producto (AliExpress)' },
    { key: 'Marca', label: 'Marca / Fabricante' },
    { key: 'Distribuidor', label: 'Distribuidor / Tienda' },
    { key: 'Tienda', label: 'Nombre de tienda' },
    { key: 'ID tienda', label: 'ID de tienda' },
    { key: 'URL tienda', label: 'URL de tienda' },
    { key: 'Categoría nivel 1', label: 'Categoría nivel 1' },
    { key: 'Categoría nivel 2', label: 'Categoría nivel 2' },
    { key: 'ID categoría 1', label: 'ID categoría 1' },
    { key: 'ID categoría 2', label: 'ID categoría 2' },
    { key: 'Precio de venta', label: 'Precio de venta' },
    { key: 'Precio original', label: 'Precio original' },
    { key: 'Precio app', label: 'Precio app' },
    { key: 'Descuento', label: 'Descuento (%)' },
    { key: 'Comisión (%)', label: 'Comisión (%)' },
    { key: 'Comisión hot (%)', label: 'Comisión hot (%)' },
    { key: 'Comisión mercado (%)', label: 'Comisión mercado (%)' },
    { key: 'Comisión estimada', label: 'Comisión estimada' },
    { key: 'Ventas (30 días)', label: 'Ventas (30 días)' },
    { key: 'Valoración (%)', label: 'Valoración (%)' },
    { key: 'Días de envío', label: 'Días de envío' },
    { key: 'Plataforma', label: 'Plataforma / Tipo de producto' },
    { key: 'Imágenes', label: 'Imágenes (lista)' },
    { key: 'Enlace de afiliado', label: 'Enlace de afiliado' },
    { key: 'URL del producto', label: 'URL del producto' },
    { key: 'Vídeo', label: 'Vídeo' },
    { key: 'Imágenes extra', label: 'Nº de imágenes extra' },
  ],
  ebay: [
    // ── Campos del objeto `extra` de adaptSingle() (verificado en código) ──
    { key: 'eBay Item ID', label: 'eBay Item ID' },
    { key: 'Legacy Item ID', label: 'Legacy Item ID' },
    { key: 'Condition', label: 'Condición del artículo' },
    { key: 'Buying Options', label: 'Opciones de compra' },
    { key: 'Seller', label: 'Vendedor' },
    { key: 'Seller Feedback %', label: 'Valoración vendedor (%)' },
    { key: 'Seller Feedback Score', label: 'Puntuación vendedor' },
    { key: 'Item Location', label: 'Ubicación del artículo' },
    { key: 'Category IDs', label: 'ID de categorías' },
    { key: 'Marketing Discount %', label: 'Descuento marketing (%)' },
    { key: 'Adult Only', label: 'Solo adultos' },
    { key: 'Item Group Type', label: 'Tipo de grupo de artículo' },
    { key: 'Item Group ID', label: 'ID de grupo de artículo' },
    { key: 'Product ID', label: 'ID de producto eBay' },
    { key: 'Brand', label: 'Marca / Fabricante' },
    { key: 'MPN', label: 'MPN' },
    { key: 'EAN', label: 'EAN' },
    { key: 'UPC', label: 'UPC' },
    { key: 'GTIN', label: 'GTIN' },
    // ── Campos del objeto `extra` de adaptSingleCanonical() ──
    { key: 'Descuento', label: 'Descuento (%)' },
    { key: 'Ventas (30 días)', label: 'Ventas (30 días)' },
    { key: 'Envío', label: 'Tipo de envío' },
  ],
  amazon: [
    // ── Campos de `extra` en amazonImport.ts (importAmazonProduct) ──
    { key: 'scraperApiSource', label: 'Fuente ScraperAPI (raw)' },
    { key: 'importSource', label: 'Origen de importación' },
    // ── Campos típicos de Amazon PA-API / ScraperAPI estructurado ──
    // (se preparan para cuando se conecte la API oficial desde hosting)
    { key: 'asin', label: 'ASIN de Amazon' },
    { key: 'Brand', label: 'Marca / Fabricante' },
    { key: 'Merchant', label: 'Comerciante / Vendedor' },
    { key: 'Rating', label: 'Valoración (estrellas)' },
    { key: 'Reviews Count', label: 'Nº de opiniones' },
    { key: 'Availability', label: 'Disponibilidad' },
    { key: 'Currency', label: 'Moneda' },
    { key: 'In Stock', label: 'En stock' },
    { key: 'Fulfillment Provider', label: 'Proveedor de envío' },
    { key: 'Product Group', label: 'Grupo de producto' },
    { key: 'Product Type', label: 'Tipo de producto' },
    { key: 'Condition', label: 'Estado físico' },
    { key: 'Features', label: 'Características (bullet points)' },
    { key: 'Buy Now URL', label: 'URL de compra directa' },
    { key: 'Affiliate URL', label: 'Enlace de afiliado Amazon' },
    { key: 'URL del producto', label: 'URL del producto Amazon' },
  ],
};

function filePath(): string {
  return path.join(DATA_DIR, FILE_NAME);
}

function emptyStore(): StoreFile {
  return { networks: [] };
}

function readStore(): StoreFile {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    const networks = Array.isArray(parsed.networks) ? parsed.networks : [];
    return {
      networks: networks.map((n) => ({
        id: String(n.id || ''),
        name: String(n.name || n.id || ''),
        available: Array.isArray(n.available)
          ? n.available.filter((f: unknown) => f && typeof (f as Record<string, unknown>).key === 'string')
          : FIELDS_BY_NETWORK[String(n.id)] || [],
        selected: Array.isArray(n.selected)
          ? n.selected.filter((s: unknown) => typeof s === 'string')
          : [],
        captureAll: Boolean(n.captureAll),
      })),
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store: StoreFile): boolean {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmpFile = `${filePath()}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmpFile, filePath());
    return true;
  } catch (error) {
    console.error('[networkFieldsStore] Error al guardar:', error);
    return false;
  }
}

/** Redes conocidas con sus campos disponibles (para poblar selects). */
export function getKnownNetworks(): NetworkFieldsConfig[] {
  return Object.entries(FIELDS_BY_NETWORK).map(([id, available]) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    available,
    selected: [],
    captureAll: false,
  }));
}

/** Configuración actual guardada por red (mezcla con conocidos si falta alguna). */
export function getNetworkFieldsConfig(): NetworkFieldsConfig[] {
  const store = readStore();
  const known = getKnownNetworks();
  const byId = new Map(store.networks.map((n) => [n.id, n]));
  return known.map((nk) => {
    const saved = byId.get(nk.id);
    if (!saved) return nk;
    return {
      ...nk,
      selected: saved.selected,
      captureAll: saved.captureAll,
    };
  });
}

/** Guarda la configuración completa de redes. */
export function setNetworkFieldsConfig(configs: NetworkFieldsConfig[]): boolean {
  const store: StoreFile = { networks: configs };
  return writeStore(store);
}

/** Devuelve la definición conocida de una red (para inicializarla si falta en el store). */
function knownNetwork(networkId: string): NetworkFieldsConfig | undefined {
  return getKnownNetworks().find((n) => n.id === networkId);
}

/** Activa/desactiva "capturar todos los campos" de una red. */
export function setNetworkCaptureAll(networkId: string, captureAll: boolean): boolean {
  const store = readStore();
  let net = store.networks.find((n) => n.id === networkId);
  if (!net) {
    const kn = knownNetwork(networkId);
    if (!kn) return false;
    net = { ...kn, selected: [], captureAll: false };
    store.networks.push(net);
  }
  net.captureAll = captureAll;
  return writeStore(store);
}

/** Añade un campo individual a la selección de una red. */
export function addNetworkField(networkId: string, fieldKey: string): boolean {
  const store = readStore();
  let net = store.networks.find((n) => n.id === networkId);
  if (!net) {
    const kn = knownNetwork(networkId);
    if (!kn) return false;
    net = { ...kn, selected: [], captureAll: false };
    store.networks.push(net);
  }
  if (net.selected.includes(fieldKey)) return false;
  net.selected.push(fieldKey);
  return writeStore(store);
}

/** Elimina un campo individual de la selección de una red. */
export function removeNetworkField(networkId: string, fieldKey: string): boolean {
  const store = readStore();
  const net = store.networks.find((n) => n.id === networkId);
  if (!net) return false;
  const before = net.selected.length;
  net.selected = net.selected.filter((k) => k !== fieldKey);
  return net.selected.length !== before && writeStore(store);
}

/** Claves de campos efectivos a capturar para una red (respetando captureAll). */
export function getEffectiveSelectedKeys(networkId: string): string[] {
  const configs = getNetworkFieldsConfig();
  const net = configs.find((n) => n.id === networkId);
  if (!net) return [];
  if (net.captureAll) return net.available.map((f) => f.key);
  return [...net.selected];
}
