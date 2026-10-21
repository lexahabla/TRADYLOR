/**
 * ==============================================================================
 * TRADYLOR - RECLASIFICACIÓN DE PRODUCTOS POR CATEGORÍAS (segura e idempotente)
 * ==============================================================================
 * POST /api/admin/migrate-categories
 *
 * Objetivo: reasignar los productos a la taxonomía ACTUAL del catálogo.
 * 1. Usa las categorías raíz que hay ahora mismo en categories.json (el admin
 *    puede crear, editar y eliminar las que quiera: no hay ninguna fija).
 * 2. Reasigna los productos por matching estricto de palabras clave
 *    (título + descripción + marca + ficha + tags).
 * 3. NO elimina ninguna categoría ni subcategoría: sólo limpia los ids
 *    jerárquicos de los productos que quedan huérfanos.
 * 4. Guarda una copia de categories.json y products.json antes de escribir.
 * 5. Devuelve un reporte detallado de los cambios.
 *
 * Body (JSON opcional):
 *   { "dryRun": true }              → simula y devuelve el plan sin escribir.
 *   { "manual": { "<id>": "<raiz>" } } → asigna esos productos a la raíz indicada
 *                                      (tiene prioridad sobre el matching).
 *
 * El reporte incluye `roots` (las categorías raíz admitidas como destino
 * manual) y `productsWithoutMatchList` (id + título de los productos que el
 * matching automático no supo clasificar), para que el panel pueda ofrecer
 * la reasignación manual antes de ejecutar.
 *
 * Un cuerpo no parseable devuelve HTTP 400 sin tocar nada (nunca ejecuta la
 * reclasificación real por error).
 *
 * SOLO para uso administrativo (requiere rol admin).
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import {
  getCategories,
  suggestCategoryStrictIn,
  type Category,
} from '../../../lib/categories';
import { readProductsFromFile, writeProductsToFile } from '../../../lib/productStore';
import type { Product } from '../../../lib/productStore';
import { DATA_DIR, dataFile } from '../../../lib/paths';
import { requireAdminAuth } from '../../../lib/adminAuth';

export const prerender = false;

/** Raíz usada cuando ningún producto encaja y no tiene categoría válida. */
const FALLBACK_ROOT_ID = 'informatica-oficina';

interface MigrateReport {
  success: boolean;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  backupDir: string | null;
  backupFiles: string[];
  /** Categorías raíz usadas como destino de la reclasificación. */
  rootsInstalled: string[];
  /** Las categorías raíz actuales (id + nombre) admitidas como destino manual. */
  roots: { id: string; name: string; icon: string }[];
  /** Siempre vacío: la reclasificación no elimina ninguna categoría. */
  rootCategoriesRemoved: string[];
  /** Siempre vacío: la reclasificación no elimina ninguna subcategoría. */
  subcategoriesRemoved: string[];
  productsReassigned: number;
  productsUnchanged: number;
  productsWithoutMatch: number;
  productsWithoutMatchSample: string[];
  /** Detalle de los productos sin coincidencia (id + título) para poder asignarlos a mano. */
  productsWithoutMatchList: { id: string; title: string; currentCategory: string }[];
  manualApplied: string[];
  categoryCounts: Record<string, number>;
  errors: string[];
}

/** Tope de productos sin coincidencia que se devuelven en detalle (el contador es total). */
const MAX_WITHOUT_MATCH_LIST = 200;

/** Texto con el que se clasifica un producto (nunca el campo `category` viejo). */
function productHaystack(product: Product): string {
  const specs = product.specs ? Object.values(product.specs).join(' ') : '';
  const tags = Array.isArray(product.normalized_tags) ? product.normalized_tags.join(' ') : '';
  return [
    product.title,
    product.description,
    product.brand,
    product.techSheet,
    specs,
    tags,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Copia categories.json y products.json a DATA_DIR/backups antes de escribir. */
function createBackup(stamp: string): { dir: string; files: string[] } {
  const dir = path.join(DATA_DIR, 'backups', `categories-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const name of ['categories.json', 'products.json']) {
    const src = dataFile(name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(dir, name);
    fs.copyFileSync(src, dest);
    files.push(dest);
  }
  return { dir, files };
}

export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  // Opciones opcionales del cuerpo (JSON) o de la query string.
  let dryRun = false;
  let manual: Record<string, string> = {};
  const raw = await request.text();
  if (raw.trim()) {
    // Un cuerpo no parseable NO debe ejecutar la reclasificación real: se rechaza.
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: 'Cuerpo JSON inválido: se esperaba { dryRun, manual }.' }),
        { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
    }
    dryRun = body?.dryRun === true;
    if (body?.manual && typeof body.manual === 'object') manual = body.manual as Record<string, string>;
  }
  if (String(new URL(request.url).searchParams.get('dryRun')) === '1') dryRun = true;

  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const report: MigrateReport = {
    success: false,
    dryRun,
    startedAt,
    finishedAt: '',
    durationMs: 0,
    backupDir: null,
    backupFiles: [],
    rootsInstalled: [],
    roots: [],
    rootCategoriesRemoved: [],
    subcategoriesRemoved: [],
    productsReassigned: 0,
    productsUnchanged: 0,
    productsWithoutMatch: 0,
    productsWithoutMatchSample: [],
    productsWithoutMatchList: [],
    manualApplied: [],
    categoryCounts: {},
    errors: [],
  };

  try {
    const currentCategories = getCategories();
    const products = readProductsFromFile();

    // 1. Destino de la reclasificación: las raíces que existen ahora mismo.
    const roots: Category[] = currentCategories.filter((category) => !category.parentId);
    if (!roots.length) {
      throw new Error('No hay categorías raíz en categories.json: crea al menos una antes de reclasificar.');
    }
    report.rootsInstalled = roots.map((root) => root.name);
    report.roots = roots.map((root) => ({
      id: root.id,
      name: root.name,
      icon: root.icon || '',
    }));

    // 2. Taxonomía intacta: la reclasificación NO borra categorías ni subcategorías.
    report.rootCategoriesRemoved = [];
    report.subcategoriesRemoved = [];

    // 3. Reasignación de productos con matching estricto sobre las raíces actuales.
    const fallbackRoot = roots.find((root) => root.id === FALLBACK_ROOT_ID) ?? roots[0];
    const validRootIds = new Set(roots.map((root) => root.id));
    const validSubIds = new Set(
      currentCategories.filter((category) => category.parentId).map((category) => category.id)
    );
    const counts: Record<string, number> = {};

    for (const product of products) {
      const matched = suggestCategoryStrictIn(productHaystack(product), roots);
      let target = matched ?? null;

      // El producto ya estaba en una categoría válida: no se toca (salvo que
      // el matching lo clasifique en otra raíz).
      const keepsCurrent =
        !target &&
        Boolean(product.category_id) &&
        validRootIds.has(String(product.category_id));
      if (!target && !keepsCurrent) {
        report.productsWithoutMatch++;
        if (report.productsWithoutMatchSample.length < 25) {
          report.productsWithoutMatchSample.push(product.title || product.id);
        }
        if (report.productsWithoutMatchList.length < MAX_WITHOUT_MATCH_LIST) {
          report.productsWithoutMatchList.push({
            id: product.id,
            title: product.title || product.id,
            currentCategory: product.category || '',
          });
        }
        target = fallbackRoot;
      }

      // Asignación manual (prioridad sobre el matching automático).
      const manualRootId = manual[product.id];
      if (manualRootId) {
        const manualRoot = roots.find((root) => root.id === manualRootId);
        if (manualRoot) {
          target = manualRoot;
          report.manualApplied.push(`${product.id} -> ${manualRoot.id}`);
        } else {
          report.errors.push(`Raíz manual desconocida para "${product.id}": ${manualRootId}`);
        }
      }

      const resolvedTarget = target ?? fallbackRoot;

      // La subcategoría sólo se conserva si sigue existiendo y cuelga de la
      // raíz destino.
      const currentSubId = product.subcategory_id;
      const nextSubcategoryId =
        currentSubId && validSubIds.has(currentSubId) ? currentSubId : undefined;

      const changed =
        product.category !== resolvedTarget.name ||
        product.category_id !== resolvedTarget.id ||
        (product.subcategory_id ?? undefined) !== nextSubcategoryId;

      if (changed) {
        product.category = resolvedTarget.name;
        product.category_id = resolvedTarget.id;
        if (nextSubcategoryId) {
          product.subcategory_id = nextSubcategoryId;
        } else {
          delete product.subcategory_id;
        }
        report.productsReassigned++;
      } else {
        report.productsUnchanged++;
      }

      counts[resolvedTarget.id] = (counts[resolvedTarget.id] ?? 0) + 1;
    }
    report.categoryCounts = counts;

    // 4. Escritura (con backup previo). En dry-run no se toca nada.
    if (!dryRun) {
      const stamp = startedAt.replace(/[:.]/g, '-');
      const backup = createBackup(stamp);
      report.backupDir = backup.dir;
      report.backupFiles = backup.files;

      if (!writeProductsToFile(products)) {
        throw new Error('No se pudo escribir products.json');
      }
    }

    report.success = true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Error desconocido en la reclasificación';
    report.errors.push(msg);
    console.error('[MigrateCategories] Error:', error);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startTime;
  }

  return new Response(JSON.stringify(report), {
    status: report.success ? 200 : 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
};

/** GET: estado actual de la taxonomía (sin escribir nada). */
export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const categories = getCategories();
  const roots = categories.filter((c) => !c.parentId);
  const subcategories = categories.filter((c) => Boolean(c.parentId));
  const products = readProductsFromFile();
  const validIds = new Set(categories.map((c) => c.id));

  return new Response(
    JSON.stringify({
      success: true,
      total: categories.length,
      roots: roots.length,
      subcategories: subcategories.length,
      products: products.length,
      productsWithoutRoot: products.filter((p) => !p.category_id).length,
      productsWithUnknownRoot: products.filter(
        (p) => p.category_id && !validIds.has(String(p.category_id))
      ).length,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
};
