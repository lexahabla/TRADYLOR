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
 * ==============================================================================
 */

import fs from 'node:fs';
import { DATA_DIR, dataFile } from './paths';

export interface Category {
  id: string;
  name: string;
  slug: string;
  icon: string;
  keywords: string[];
}

const CATEGORIES_PATH = dataFile('categories.json');

/** Categorías base: se escriben si el archivo no existe o está vacío/corrupto. */
export const DEFAULT_CATEGORIES: Category[] = [
  {
    id: 'audio-sonido',
    name: 'Audio y Sonido',
    slug: 'audio-sonido',
    icon: '🎧',
    keywords: ['auriculares', 'auricular', 'altavoz', 'altavoces', 'sonido', 'audio', 'soundbar', 'barra de sonido', 'microfono', 'micrófono', 'noise cancelling', 'cancelacion de ruido', ' earbuds', 'earbuds', ' cascos', 'cascos'],
  },
  {
    id: 'informatica',
    name: 'Informática',
    slug: 'informatica',
    icon: '💻',
    keywords: ['portatil', 'portátil', 'laptop', 'macbook', 'tablet', 'e-reader', 'ereader', 'ebook', 'kindle', 'ordenador', 'pc ', 'sobremesa', 'monitor', 'teclado', 'raton', 'ratón', 'ssd', 'disco duro', 'memoria ram', 'procesador', 'chromebook'],
  },
  {
    id: 'hogar-inteligente',
    name: 'Hogar Inteligente',
    slug: 'hogar-inteligente',
    icon: '🏠',
    keywords: ['robot aspirador', 'aspirador', 'aspiradora', 'smart home', 'domotica', 'domótica', 'bombilla', 'enchufe inteligente', 'alexa', 'google home', 'termostato', 'camara vigilancia', 'cámara vigilancia', 'timbre', 'fregasuelos', 'roborock', 'roomba'],
  },
  {
    id: 'herramientas',
    name: 'Herramientas',
    slug: 'herramientas',
    icon: '🛠️',
    keywords: ['taladro', 'atornillador', 'sierra', 'herramienta', 'destornillador', 'llave', 'martillo', 'lijadora', 'amoladora', 'broca', 'bosch', 'dewalt', 'makita', 'nivel laser', 'multimetro', 'multímetro'],
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
      if (Array.isArray(parsed) && parsed.length > 0) {
        if (parsed[0]?.slug) return parsed as Category[];
        // Esquema legado: array plano de nombres → migración perezosa en memoria.
        return migrateLegacyNames(parsed.filter((item: unknown) => typeof item === 'string'));
      }
    }
  } catch (error) {
    console.error('[Categories] Error al leer categories.json:', error);
  }
  return [...DEFAULT_CATEGORIES];
}

function writeCategories(categories: Category[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CATEGORIES_PATH, JSON.stringify(categories, null, 2), 'utf-8');
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

export interface CategoryInput {
  name: string;
  icon?: string;
  keywords?: string[];
}

export interface CategoryResult {
  ok: boolean;
  message: string;
  categories: Category[];
  category?: Category;
}

export function createCategory(input: CategoryInput): CategoryResult {
  const name = String(input.name ?? '').trim();
  if (!name) return { ok: false, message: 'El nombre de la categoría es obligatorio.', categories: getCategories() };

  const categories = getCategories();
  const slug = slugifyCategory(name);
  if (categories.some((c) => c.slug === slug || c.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, message: `Ya existe una categoría con el nombre "${name}".`, categories };
  }

  const category: Category = {
    id: slug,
    name,
    slug,
    icon: String(input.icon ?? '').trim() || '📦',
    keywords: (input.keywords ?? []).map((k) => String(k).trim().toLowerCase()).filter(Boolean),
  };
  categories.push(category);
  writeCategories(categories);
  return { ok: true, message: `Categoría "${name}" creada correctamente.`, categories, category };
}

export function updateCategory(slug: string, input: CategoryInput): CategoryResult {
  const categories = getCategories();
  const index = categories.findIndex((c) => c.slug === slug);
  if (index === -1) return { ok: false, message: `No existe la categoría "${slug}".`, categories };

  const name = String(input.name ?? '').trim();
  if (!name) return { ok: false, message: 'El nombre de la categoría es obligatorio.', categories };

  const newSlug = slugifyCategory(name);
  const duplicate = categories.some((c) => c.slug !== slug && (c.slug === newSlug || c.name.toLowerCase() === name.toLowerCase()));
  if (duplicate) return { ok: false, message: `Ya existe otra categoría con el nombre "${name}".`, categories };

  categories[index] = {
    id: newSlug,
    name,
    slug: newSlug,
    icon: String(input.icon ?? '').trim() || categories[index].icon,
    keywords: (input.keywords ?? categories[index].keywords).map((k) => String(k).trim().toLowerCase()).filter(Boolean),
  };
  writeCategories(categories);
  return { ok: true, message: `Categoría actualizada a "${name}".`, categories, category: categories[index] };
}

export function removeCategory(slug: string): CategoryResult {
  const categories = getCategories();
  const target = categories.find((c) => c.slug === slug);
  if (!target) return { ok: false, message: `No existe la categoría "${slug}".`, categories };

  const remaining = categories.filter((c) => c.slug !== slug);
  writeCategories(remaining);
  return { ok: true, message: `Categoría "${target.name}" eliminada.`, categories: remaining };
}

/**
 * Autasociación: dado un texto (título + descripción), sugiere la categoría
 * cuyas keywords tengan más coincidencias. Devuelve null si no hay aciertos.
 */
export function suggestCategory(text: string): { category: Category; matches: number } | null {
  const haystack = ` ${text.toLowerCase()} `;
  let best: { category: Category; matches: number } | null = null;

  for (const category of getCategories()) {
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
