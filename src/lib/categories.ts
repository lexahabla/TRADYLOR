/**
 * ==============================================================================
 * TRADYLOR - GESTIÓN DINÁMICA DE CATEGORÍAS (Backend)
 * ==============================================================================
 * Fuente de verdad: src/data/categories.json con esquema rico:
 *   { id, name, slug, icon, keywords[] }
 *
 * Funciones:
 *  - CRUD completo (get/create/update/remove) con slug único automático.
 *  - suggestCategory(): autasocia un producto a una categoría según las
 *    keywords definidas (se usa en el formulario de alta y en el scraper).
 *  - Compatibilidad: getCategoryNames() devuelve los nombres para el datalist
 *    del formulario y el filtro legacy del panel.
 *  - Taxonomía LIBRE: el admin puede crear, editar y eliminar categorías raíz y
 *    subcategorías (un solo nivel de profundidad) desde el panel.
 * ==============================================================================
 */

import fs from 'node:fs';
import { dataFile } from './paths';
import { writeJsonArrayFile } from './jsonStore';

export interface Category {
  id: string;
  name: string;
  slug: string;
  icon: string;
  keywords: string[];
  /**
   * ID de la categoría padre (null/ausente = categoría raíz). Las entradas con
   * parentId actúan como SUBCATEGORÍAS y se guardan en el mismo categories.json,
   * por lo que quedan disponibles para toda la web sin recarga.
   */
  parentId?: string | null;
}

const CATEGORIES_PATH = dataFile('categories.json');

/**
 * CATEGORÍAS BASE DEL CATÁLOGO (semilla).
 * Se escriben sólo si el archivo no existe o está vacío/corrupto; a partir de
 * ahí manda categories.json y el admin puede crear, editar y eliminar
 * libremente categorías raíz y subcategorías.
 */
export const DEFAULT_CATEGORIES: Category[] = [
  {
    id: 'informatica-oficina',
    name: 'Informática y Oficina',
    slug: 'informatica-oficina',
    icon: '💻',
    keywords: [
      'teclado', 'raton', 'ratón', 'mouse', 'monitor', 'portatil', 'portátil', 'laptop', 'macbook',
      'ssd', 'disco duro', 'memoria ram', 'procesador', 'grafica', 'gráfica', 'gpu', 'rtx', 'gtx',
      'placa base', 'motherboard', 'fuente poder', 'gabinete', 'torre', 'ordenador', 'pc ', 'sobremesa',
      'chromebook', 'tablet', 'impresora', 'escanner', 'webcam', 'microfono', 'micrófono',
      'auriculares gaming', 'cascos gaming', 'teclado mecanico', 'teclado mecánico', 'switch', 'hub usb',
      'docking station', 'adaptador', 'cable hdmi', 'cable displayport', 'kvm'
    ],
  },
  {
    id: 'audio-sonido',
    name: 'Audio y Sonido',
    slug: 'audio-sonido',
    icon: '🎧',
    keywords: [
      'auriculares', 'auricular', 'altavoz', 'altavoces', 'sonido', 'audio', 'soundbar', 'barra de sonido',
      'microfono', 'micrófono', 'noise cancelling', 'cancelacion de ruido', 'cancelación de ruido',
      'earbuds', 'cascos', 'auriculares bluetooth', 'auriculares inalambricos', 'auriculares inalámbricos',
      'auriculares deportivos', 'true wireless', 'tw', 'headphones', 'headset', 'speakers',
      'bafle', 'subwoofer', 'amplificador', 'receptor', 'dac', 'interface audio', 'mezclador'
    ],
  },
  {
    id: 'smartwatches',
    name: 'Smartwatches y Wearables',
    slug: 'smartwatches',
    icon: '⌚',
    keywords: [
      'smartwatch', 'reloj inteligente', 'reloj smart', 'wearable', 'pulsera actividad', 'pulsera inteligente',
      'fitness tracker', 'activity tracker', 'garmin', 'apple watch', 'galaxy watch', 'pixel watch',
      'amazfit', 'huawei watch', 'xiaomi watch', 'oneplus watch', 'reloj gps', 'reloj deporte',
      'monitor frecuencia cardiaca', 'spo2', 'oxigeno sangre', 'ecg', 'pulsometro', 'pulsómetro'
    ],
  },
  {
    id: 'hogar-inteligencia',
    name: 'Hogar e Inteligencia',
    slug: 'hogar-inteligencia',
    icon: '🏠',
    keywords: [
      'robot aspirador', 'aspirador robot', 'aspiradora robot', 'fregasuelos', 'roborock', 'roomba',
      'smart home', 'domotica', 'domótica', 'bombilla inteligente', 'bombilla wifi', 'enchufe inteligente',
      'enchufe wifi', 'alexa', 'google home', 'home assistant', 'matter', 'thread', 'zigbee', 'zwave',
      'termostato inteligente', 'camara vigilancia', 'cámara vigilancia', 'timbre inteligente', 'video portero',
      'sensor movimiento', 'sensor puerta', 'sensor temperatura', 'sensor humedad', 'riego inteligente',
      'cafetera inteligente', 'freidora aire', 'freidora sin aceite', 'horno inteligente', 'nevera inteligente',
      'lavadora inteligente', 'secadora inteligente', 'purificador aire', 'humidificador inteligente'
    ],
  },
  {
    id: 'movil-accesorios',
    name: 'Móvil y Accesorios',
    slug: 'movil-accesorios',
    icon: '📱',
    keywords: [
      'smartphone', 'movil', 'móvil', 'celular', 'telefono', 'teléfono', 'iphone', 'samsung galaxy',
      'xiaomi', 'oneplus', 'google pixel', 'nothing phone', 'motorola', 'oppo', 'vivo', 'realme',
      'funda movil', 'funda móvil', 'cristal templado', 'protector pantalla', 'cargador', 'cargador rapido',
      'cargador rápido', 'cargador usb c', 'cargador inalambrico', 'cargador inalámbrico', 'powerbank',
      'bateria externa', 'batería externa', 'power bank', 'soporte coche', 'soporte escritorio',
      'anillo magsafe', 'popsocket', 'cable usb c', 'cable lightning', 'adaptador otg', 'hub movil'
    ],
  },
  {
    id: 'fotografia-video',
    name: 'Fotografía y Vídeo',
    slug: 'fotografia-video',
    icon: '📷',
    keywords: [
      'camara', 'cámara', 'camara reflex', 'cámara reflex', 'camara mirrorless', 'cámara mirrorless',
      'camara compacta', 'cámara compacta', 'camara accion', 'cámara acción', 'gopro', 'dji osmo',
      'objetivo', 'lente', 'objetivo zoom', 'objetivo gran angular', 'objetivo macro', 'objetivo retrato',
      'tripode', 'trípode', 'monopie', 'gimbal', 'estabilizador', 'ronin', 'dji ronin', 'zhiyun',
      'drone', 'dron', 'dji mavic', 'dji mini', 'dji air', 'autel', 'parrot',
      'microfono video', 'micrófono video', 'rode', 'dji mic', 'hollywood', 'luz video', 'panel led',
      'softbox', 'ring light', 'luz anillo', 'fondo fotografia', 'fondo video', 'teleprompter'
    ],
  },
  {
    id: 'gaming',
    name: 'Gaming',
    slug: 'gaming',
    icon: '🎮',
    keywords: [
      'gaming', 'videojuego', 'consola', 'playstation', 'ps5', 'ps4', 'xbox', 'series x', 'series s',
      'nintendo switch', 'switch oled', 'steam deck', 'rog ally', 'lenovo legion go',
      'mando', 'controlador', 'dualsense', 'dualshock', 'xbox controller', 'pro controller',
      'raton gaming', 'ratón gaming', 'mouse gaming', 'teclado gaming', 'teclado mecanico gaming',
      'teclado mecánico gaming', 'auriculares gaming', 'cascos gaming', 'headset gaming',
      'silla gaming', 'mesa gaming', 'monitor gaming', 'monitor 144hz', 'monitor 240hz', 'curvo gaming',
      'tarjeta grafica', 'tarjeta gráfica', 'rtx 40', 'rtx 30', 'rx 7000', 'rx 6000'
    ],
  },
  {
    id: 'herramientas-bricolaje',
    name: 'Herramientas y Bricolaje',
    slug: 'herramientas-bricolaje',
    icon: '🛠️',
    keywords: [
      'taladro', 'atornillador', 'taladro atornillador', 'martillo percutor', 'rotomartillo', 'demoledor',
      'sierra', 'sierra circular', 'sierra caladora', 'sierra sable', 'amoladora', 'radial', 'lijadora',
      'lijadora orbital', 'lijadora banda', 'multimetro', 'multímetro', 'pinza amperimetrica', 'pinza amperimétrica',
      'destornillador', 'llave', 'llave inglesa', 'llave fija', 'llave tubo', 'juego llaves', 'trinquete',
      'nivel laser', 'nivel láser', 'metro laser', 'metro láser', 'detector pared', 'detector cables',
      'bosch', 'dewalt', 'makita', 'milwaukee', 'einhell', 'black decker', 'ryobi', 'park side',
      'compresor', 'pistola pintura', 'pistola calor', 'soldador', 'inversora soldar', 'cortadora plasma'
    ],
  },
];

/** Normaliza cualquier entrada legible (nombre, slug o acentos) para comparar. */
function normalizeKey(text: string): string {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Migra un array plano de nombres (esquema legado) al esquema rico. */
function migrateLegacyNames(names: string[]): Category[] {
  return names
    .map((rawName) => String(rawName ?? '').trim())
    .filter(Boolean)
    .map((name) => {
      const slug = slugifyCategory(name);
      const suggestion = DEFAULT_CATEGORIES.find((c) => normalizeKey(c.name) === normalizeKey(name));
      return {
        id: slug,
        name,
        slug,
        icon: suggestion?.icon ?? '📦',
        keywords: suggestion?.keywords ?? [normalizeKey(name)].filter(Boolean),
      };
    });
}

function readCategories(): Category[] {
  try {
    if (fs.existsSync(CATEGORIES_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf-8'));
      const list = Array.isArray(parsed) ? parsed : parsed?.categories;
      if (Array.isArray(list) && list.length > 0) {
        if (list[0]?.slug) return list as Category[];
        // Esquema legado: array plano de nombres → migración perezosa en memoria.
        return migrateLegacyNames(list.filter((item: unknown) => typeof item === 'string'));
      }
    }
  } catch (error) {
    console.error('[Categories] Error al leer categories.json:', error);
  }
  return [...DEFAULT_CATEGORIES];
}

export function writeCategories(categories: Category[]): void {
  // Escritura atómica (temporal + rename): el pipeline crea subcategorías
  // durante el reproceso y un fallo a mitad no debe dejar la taxonomía rota.
  writeJsonArrayFile(CATEGORIES_PATH, categories);
}

/** Garantiza que el archivo existe con el esquema rico (migración perezosa). */
export function ensureCategoriesFile(): Category[] {
  const exists = fs.existsSync(CATEGORIES_PATH);
  const categories = readCategories();
  // Reescribe cuando falta el archivo o cuando aún guarda el esquema legado
  // (array de strings) para que todos los consumidores compartan un solo formato.
  let isLegacy = false;
  if (exists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf-8'));
      isLegacy = Array.isArray(parsed) && parsed.length > 0 && !parsed[0]?.slug;
    } catch {
      isLegacy = true;
    }
  }
  if (!exists || isLegacy) writeCategories(categories);
  return categories;
}

export function slugifyCategory(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

export function getCategories(): Category[] {
  return ensureCategoriesFile();
}

export function getCategoryBySlug(slug: string): Category | undefined {
  return getCategories().find((category) => category.slug === slug);
}

/** Busca por id, slug o nombre normalizado (la API [id] acepta cualquiera de los tres). */
export function getCategoryById(id: string): Category | undefined {
  const key = normalizeKey(id);
  if (!key) return undefined;
  return (
    getCategories().find((category) => category.id === id || category.slug === id) ??
    getCategories().find((category) => normalizeKey(category.name) === key || normalizeKey(category.slug) === key)
  );
}

export function getCategoryNames(): string[] {
  return getCategories().map((category) => category.name);
}

/**
 * Resuelve los ids jerárquicos (category_id / subcategory_id) a partir del
 * nombre de la categoría y de la subcategoría. Si el nombre no existe en
 * categories.json no se devuelve id (el producto guarda sólo el texto).
 */
export function resolveCategoryIds(
  categoryName: string,
  subcategoryName = ''
): { category_id?: string; subcategory_id?: string } {
  const categories = getCategories();
  const target = normalizeKey(categoryName);
  if (!target) return {};
  const root = categories.find(
    (category) =>
      !category.parentId &&
      (normalizeKey(category.name) === target || normalizeKey(category.slug) === target)
  );
  if (!root) return {};
  const wanted = normalizeKey(subcategoryName);
  const sub = wanted
    ? categories.find(
        (category) =>
          category.parentId === root.id &&
          (normalizeKey(category.name) === wanted || normalizeKey(category.slug) === wanted)
      )
    : undefined;
  return { category_id: root.id, ...(sub ? { subcategory_id: sub.id } : {}) };
}

/** Devuelve las subcategorías hijas de una categoría raíz (por id o slug). */
export function getSubcategories(parentId: string): Category[] {
  const parent = getCategoryById(parentId);
  const parentIdValue = parent?.id ?? parentId;
  if (!parentIdValue) return [];
  return getCategories().filter((category) => category.parentId === parentIdValue);
}

/** Separa raíces y subcategorías para los selectores en cascada del panel. */
export function splitCategoriesByLevel(categories?: Category[]): { roots: Category[]; subcategories: Category[] } {
  const list = categories ?? getCategories();
  return {
    roots: list.filter((c) => !c.parentId),
    subcategories: list.filter((c) => Boolean(c.parentId)),
  };
}

export interface CategoryInput {
  name: string;
  icon?: string;
  keywords?: string[];
  /** ID de la categoría padre; si se envía, la categoría se crea como subcategoría. */
  parentId?: string | null;
}

export interface CategoryResult {
  ok: boolean;
  message: string;
  categories: Category[];
  category?: Category;
  /**
   * Ids que han cambiado (de <from> a <to>). Sirve para reapuntar en el
   * catálogo los productos que estaban asignados a esas categorías.
   */
  remapped?: { from: string; to: string }[];
}

export function createCategory(input: CategoryInput): CategoryResult {
  const name = String(input.name ?? '').trim();
  if (!name) return { ok: false, message: 'El nombre de la categoría es obligatorio.', categories: getCategories() };

  const categories = getCategories();

  // Categoría raíz (sin padre) o subcategoría (con padre). Sólo se permite un
  // nivel de profundidad: el padre debe ser siempre una categoría raíz.
  const rawParentId = String(input.parentId ?? '').trim();
  let parentId: string | null = null;
  let parentName = '';
  if (rawParentId) {
    const parent = getCategoryById(rawParentId);
    if (!parent) {
      return { ok: false, message: `No existe la categoría padre "${rawParentId}".`, categories };
    }
    if (parent.parentId) {
      return { ok: false, message: `"${parent.name}" ya es una subcategoría: sólo se permite un nivel.`, categories };
    }
    parentId = parent.id;
    parentName = parent.name;
  }

  const slugBase = slugifyCategory(name);
  const slug = parentId ? `${parentId}--${slugBase}` : slugBase;
  if (
    categories.some(
      (c) =>
        c.slug === slug ||
        (c.name.toLowerCase() === name.toLowerCase() && (c.parentId ?? null) === parentId)
    )
  ) {
    return {
      ok: false,
      message: `Ya existe una categoría con el nombre "${name}"${parentId ? ' en esa rama' : ''}.`,
      categories,
    };
  }

  const category: Category = {
    id: slug,
    name,
    slug,
    icon: String(input.icon ?? '').trim() || (parentId ? '📂' : '📦'),
    keywords: (input.keywords ?? []).map((k) => String(k).trim().toLowerCase()).filter(Boolean),
    parentId,
  };
  categories.push(category);
  writeCategories(categories);
  return {
    ok: true,
    message: parentId
      ? `Subcategoría "${name}" creada y vinculada a "${parentName}".`
      : `Categoría "${name}" creada correctamente.`,
    categories,
    category,
  };
}

export function updateCategory(slug: string, input: CategoryInput): CategoryResult {
  const categories = getCategories();
  const index = categories.findIndex((c) => c.slug === slug);
  if (index === -1) return { ok: false, message: `No existe la categoría "${slug}".`, categories };

  const name = String(input.name ?? '').trim();
  if (!name) return { ok: false, message: 'El nombre de la categoría es obligatorio.', categories };

  const previous = categories[index];

  // Re-parentado opcional: una raíz puede pasar a ser subcategoría de otra
  // raíz y una subcategoría puede volver a la raíz. Sólo un nivel de
  // profundidad: el padre elegido debe ser siempre una categoría raíz.
  let parentId = previous.parentId ?? null;
  if (input.parentId !== undefined) {
    const rawParentId = String(input.parentId ?? '').trim();
    if (rawParentId) {
      const parent = getCategoryById(rawParentId);
      if (!parent) return { ok: false, message: `No existe la categoría padre "${rawParentId}".`, categories };
      if (parent.parentId) return { ok: false, message: `"${parent.name}" ya es una subcategoría.`, categories };
      if (parent.id === previous.id) {
        return { ok: false, message: 'Una categoría no puede ser padre de sí misma.', categories };
      }
      const childCount = categories.filter((c) => c.parentId === previous.id).length;
      if (childCount > 0) {
        return {
          ok: false,
          message: `"${previous.name}" tiene ${childCount} subcategoría(s): muévelas antes de convertirla en subcategoría.`,
          categories,
        };
      }
      parentId = parent.id;
    } else {
      parentId = null;
    }
  }
  const newSlugBase = slugifyCategory(name);
  const newSlug = parentId ? `${parentId}--${newSlugBase}` : newSlugBase;
  const duplicate = categories.some((c) => c.slug !== slug && (c.slug === newSlug || (c.name.toLowerCase() === name.toLowerCase() && (c.parentId ?? null) === parentId)));
  if (duplicate) return { ok: false, message: `Ya existe otra categoría con el nombre "${name}".`, categories };

  categories[index] = {
    ...previous,
    id: newSlug,
    name,
    slug: newSlug,
    icon: String(input.icon ?? '').trim() || previous.icon,
    keywords: (input.keywords ?? previous.keywords).map((k) => String(k).trim().toLowerCase()).filter(Boolean),
    parentId,
  };

  // Si cambió el id (slug) de una categoría raíz, sus subcategorías se
  // re-apuntan y se re-sluguean (el id de una subcategoría lleva el prefijo
  // del padre). Se devuelve el mapa de ids para reapuntar los productos.
  const remapped: { from: string; to: string }[] = [];
  if (parentId === null && previous.id !== newSlug) {
    for (const category of categories) {
      if (category.parentId !== previous.id) continue;
      const suffix = category.id.startsWith(`${previous.id}--`)
        ? category.id.slice(previous.id.length + 2)
        : slugifyCategory(category.name);
      const nextChildId = `${newSlug}--${suffix}`;
      remapped.push({ from: category.id, to: nextChildId });
      category.id = nextChildId;
      category.slug = nextChildId;
      category.parentId = newSlug;
    }
  }
  writeCategories(categories);
  return {
    ok: true,
    message: `Categoría actualizada a "${name}".`,
    categories,
    category: categories[index],
    ...(remapped.length ? { remapped } : {}),
  };
}

export function removeCategory(slug: string): CategoryResult {
  const categories = getCategories();
  const target = categories.find((c) => c.slug === slug);
  if (!target) return { ok: false, message: `No existe la categoría "${slug}".`, categories };

  // Borrado en cascada: al eliminar una raíz se eliminan también sus subcategorías
  // para no dejar registros huérfanos en categories.json.
  const childIds = new Set(categories.filter((c) => c.parentId === target.id).map((c) => c.id));
  const remaining = categories.filter((c) => c.slug !== slug && !(c.parentId && c.parentId === target.id));
  writeCategories(remaining);
  return {
    ok: true,
    message: childIds.size
      ? `Categoría "${target.name}" eliminada (junto con ${childIds.size} subcategoría(s)).`
      : `Categoría "${target.name}" eliminada.`,
    categories: remaining,
  };
}

/**
 * Autasociación: dado un título + descripción, sugiere la categoría RAÍZ
 * cuyas keywords tengan más coincidencias. Sólo busca en las categorías raíz
 * actuales (ignora subcategorías). Devuelve null si no hay aciertos.
 */
export function suggestCategory(text: string): { category: Category; matches: number } | null {
  const haystack = ` ${text.toLowerCase()} `;
  let best: { category: Category; matches: number } | null = null;

  // Sólo categorías raíz (las subcategorías se eligen a mano en el panel).
  const rootCategories = getCategories().filter((c) => !c.parentId);

  for (const category of rootCategories) {
    const matches = category.keywords.reduce(
      (count, keyword) => (keyword && haystack.includes(keyword) ? count + 1 : count),
      0,
    );
    if (matches > 0 && (!best || matches > best.matches)) {
      best = { category, matches };
    }
  }
  return best;
}

/**
 * Autasociación estricta para build-catalog: asigna OBLIGATORIAMENTE a una
 * de las categorías raíz del catálogo según reglas de matching por palabras
 * clave. Las reglas prioritarias cubren las 8 categorías base; si alguna ya no
 * existe (se renombró o eliminó) se resuelve por puntuación de keywords, de
 * modo que las categorías creadas por el admin también reciben productos.
 * - Teclado/ratón/monitor/portátil/SSD -> Informática y Oficina
 * - Auriculares/altavoz/soundbar -> Audio y Sonido
 * - Smartwatch/reloj inteligente/pulsera -> Smartwatches y Wearables
 * - Robot aspirador/domotica/enchufe inteligente -> Hogar e Inteligencia
 * - Smartphone/funda/cargador/powerbank -> Móvil y Accesorios
 * - Cámara/objetivo/drone/gimbal -> Fotografía y Vídeo
 * - Consola/mando/gaming -> Gaming
 * - Taladro/atornillador/sierra/amoladora -> Herramientas y Bricolaje
 */
export function suggestCategoryStrict(text: string): Category | null {
  return suggestCategoryStrictIn(text, getCategories().filter((c) => !c.parentId));
}

/**
 * Autasociación estricta contra un conjunto concreto de categorías raíz.
 * Misma semántica que suggestCategoryStrict pero SIN leer categories.json:
 * permite simular la migración (dry-run) antes de escribir nada en disco.
 */
export function suggestCategoryStrictIn(text: string, rootCategories: Category[]): Category | null {
  const haystack = ` ${text.toLowerCase()} `;

  // Reglas de asignación obligatoria por palabras clave prioritarias
  const mandatoryRules: Array<{ categoryId: string; keywords: string[] }> = [
    { categoryId: 'informatica-oficina', keywords: ['teclado', 'raton', 'ratón', 'mouse', 'monitor', 'portatil', 'portátil', 'laptop', 'macbook', 'ssd', 'disco duro', 'memoria ram', 'procesador', 'grafica', 'gráfica', 'gpu', 'placa base', 'motherboard', 'fuente poder', 'gabinete', 'torre', 'ordenador', 'chromebook', 'impresora', 'webcam', 'teclado mecanico', 'teclado mecánico', 'switch', 'hub usb', 'docking'] },
    { categoryId: 'audio-sonido', keywords: ['auriculares', 'auricular', 'altavoz', 'altavoces', 'soundbar', 'barra de sonido', 'earbuds', 'cascos', 'true wireless', 'tw', 'headphones', 'headset', 'speakers', 'bafle', 'subwoofer', 'amplificador', 'interface audio', 'mezclador'] },
    { categoryId: 'smartwatches', keywords: ['smartwatch', 'reloj inteligente', 'reloj smart', 'wearable', 'pulsera actividad', 'pulsera inteligente', 'fitness tracker', 'activity tracker', 'apple watch', 'galaxy watch', 'pixel watch', 'amazfit', 'huawei watch', 'xiaomi watch', 'reloj gps', 'reloj deporte', 'pulsometro', 'pulsómetro', 'spo2', 'ecg'] },
    { categoryId: 'hogar-inteligencia', keywords: ['robot aspirador', 'aspirador robot', 'aspiradora robot', 'fregasuelos', 'roborock', 'roomba', 'domotica', 'domótica', 'bombilla inteligente', 'bombilla wifi', 'enchufe inteligente', 'enchufe wifi', 'termostato inteligente', 'camara vigilancia', 'cámara vigilancia', 'timbre inteligente', 'video portero', 'sensor movimiento', 'sensor puerta', 'purificador aire', 'humidificador inteligente', 'cafetera inteligente', 'freidora aire', 'freidora sin aceite'] },
    { categoryId: 'movil-accesorios', keywords: ['smartphone', 'iphone', 'samsung galaxy', 'xiaomi', 'oneplus', 'google pixel', 'funda movil', 'funda móvil', 'cristal templado', 'protector pantalla', 'cargador rapido', 'cargador rápido', 'cargador usb c', 'cargador inalambrico', 'cargador inalámbrico', 'powerbank', 'bateria externa', 'batería externa', 'power bank', 'soporte coche', 'anillo magsafe', 'popsocket'] },
    { categoryId: 'fotografia-video', keywords: ['camara', 'cámara', 'camara reflex', 'cámara reflex', 'camara mirrorless', 'cámara mirrorless', 'camara accion', 'cámara acción', 'gopro', 'dji osmo', 'objetivo', 'lente', 'tripode', 'trípode', 'gimbal', 'estabilizador', 'drone', 'dron', 'dji mavic', 'dji mini', 'dji air', 'microfono video', 'micrófono video', 'luz video', 'panel led', 'softbox', 'ring light'] },
    { categoryId: 'gaming', keywords: ['gaming', 'videojuego', 'consola', 'playstation', 'ps5', 'ps4', 'xbox', 'series x', 'series s', 'nintendo switch', 'steam deck', 'mando', 'controlador', 'dualsense', 'dualshock', 'raton gaming', 'ratón gaming', 'mouse gaming', 'teclado gaming', 'teclado mecanico gaming', 'teclado mecánico gaming', 'auriculares gaming', 'cascos gaming', 'headset gaming', 'silla gaming', 'monitor gaming', 'tarjeta grafica', 'tarjeta gráfica', 'rtx 40', 'rtx 30', 'rx 7000', 'rx 6000'] },
    { categoryId: 'herramientas-bricolaje', keywords: ['taladro', 'atornillador', 'martillo percutor', 'rotomartillo', 'sierra circular', 'sierra caladora', 'amoladora', 'radial', 'lijadora', 'multimetro', 'multímetro', 'destornillador', 'llave inglesa', 'llave fija', 'llave tubo', 'trinquete', 'nivel laser', 'nivel láser', 'bosch', 'dewalt', 'makita', 'milwaukee', 'einhell', 'compresor', 'soldador', 'cortadora plasma'] },
  ];

  // Primero: reglas obligatorias (coincidencia exacta de palabra clave prioritaria)
  for (const rule of mandatoryRules) {
    for (const keyword of rule.keywords) {
      if (haystack.includes(` ${keyword} `) || haystack.startsWith(`${keyword} `) || haystack.endsWith(` ${keyword}`)) {
        const cat = rootCategories.find((c) => c.id === rule.categoryId);
        if (cat) return cat;
      }
    }
  }

  // Segundo: matching por puntuación de keywords (fallback)
  let best: { category: Category; matches: number } | null = null;
  for (const category of rootCategories) {
    const matches = category.keywords.reduce(
      (count, keyword) => (keyword && haystack.includes(keyword) ? count + 1 : count),
      0,
    );
    if (matches > 0 && (!best || matches > best.matches)) {
      best = { category, matches };
    }
  }
  return best?.category ?? null;
}
