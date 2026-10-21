/**
 * ==============================================================================
 * TRADYLOR - MIGRACIÓN DE CATEGORÍAS Y PRODUCTOS (segura e idempotente)
 * ==============================================================================
 * POST /api/admin/migrate-categories
 *
 * Objetivo: dejar el catálogo con la taxonomía fija de 8 categorías raíz.
 * 1. Garantiza que las 8 raíces fijas existan (las crea si faltan) ANTES de
 *    clasificar, para que el matching estricto siempre resuelva.
 * 2. Reasigna TODOS los productos a una de esas 8 raíces por matching estricto
 *    de palabras clave (título + descripción + marca + ficha + tags).
 * 3. Elimina las categorías raíz que no son las 8 fijas y las subcategorías
 *    huérfanas (o todas, salvo que se pida conservarlas).
 * 4. Guarda una copia de categories.json y products.json antes de escribir.
 * 5. Devuelve un reporte detallado de los cambios.
 *
 * Body (JSON opcional):
 *   { "dryRun": true }              → simula y devuelve el plan sin escribir.
 *   { "keepSubcategories": true }   → conserva las subcategorías cuelgues de
 *                                      las 8 raíces fijas (no las huérfanas).
 *   { "manual": { "<id>": "<raiz>" } } → asigna esos productos a la raíz indicada
 *                                      (tiene prioridad sobre el matching).
 *
 * SOLO para uso administrativo (requiere rol admin).
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CATEGORIES,
  getCategories,
  suggestCategoryStrictIn,
  writeCategories,
  type Category,
} from '../../../lib/categories';
import { readProductsFromFile, writeProductsToFile } from '../../../lib/productStore';
import type { Product } from '../../../lib/productStore';
import { DATA_DIR, dataFile } from '../../../lib/paths';
import { requireAdminAuth } from '../../../lib/adminAuth';

export const prerender = false;

/** Raíz usada cuando ningún producto encaja en las 8 categorías fijas. */
const FALLBACK_ROOT_ID = 'informatica-oficina';

interface MigrateReport {
  success: boolean;
  dryRun: boolean;
  keepSubcategories: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  backupDir: string | null;
  backupFiles: string[];
  rootsInstalled: string[];
  rootCategoriesRemoved: string[];
  subcategoriesRemoved: string[];
  productsReassigned: number;
  productsUnchanged: number;
  productsWithoutMatch: number;
  productsWithoutMatchSample: string[];
  manualApplied: string[];
  categoryCounts: Record<string, number>;
  errors: string[];
}

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
  let keepSubcategories = false;
  let manual: Record<string, string> = {};
  try {
    const raw = await request.text();
    if (raw.trim()) {
      const body = JSON.parse(raw);
      dryRun = body?.dryRun === true;
      keepSubcategories = body?.keepSubcategories === true;
      if (body?.manual && typeof body.manual === 'object') manual = body.manual;
    }
  } catch {
    // Cuerpo no JSON: se ignoran las opciones (comportamiento por defecto).
  }
  if (String(new URL(request.url).searchParams.get('dryRun')) === '1') dryRun = true;
  if (String(new URL(request.url).searchParams.get('keepSubcategories')) === '1') keepSubcategories = true;

  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const report: MigrateReport = {
    success: false,
    dryRun,
    keepSubcategories,
    startedAt,
    finishedAt: '',
    durationMs: 0,
    backupDir: null,
    backupFiles: [],
    rootsInstalled: [],
    rootCategoriesRemoved: [],
    subcategoriesRemoved: [],
    productsReassigned: 0,
    productsUnchanged: 0,
    productsWithoutMatch: 0,
    productsWithoutMatchSample: [],
    manualApplied: [],
    categoryCounts: {},
    errors: [],
  };

  try {
    const currentCategories = getCategories();
    const products = readProductsFromFile();

    // 1. Las 8 raíces fijas canónicas (id, nombre, icono y keywords oficiales).
    const fixedRoots: Category[] = DEFAULT_CATEGORIES.map((root) => ({
      id: root.id,
      name: root.name,
      slug: root.slug,
      icon: root.icon,
      keywords: [...root.keywords],
    }));
    const fixedRootIds = new Set(fixedRoots.map((root) => root.id));
    report.rootsInstalled = fixedRoots.map((root) => root.name);

    // 2. Qué se elimina: raíces que no son fijas y subcategorías huérfanas.
    const currentRoots = currentCategories.filter((c) => !c.parentId);
    const currentRootIds = new Set(currentRoots.map((c) => c.id));
    const orphanRoots = currentCategories.filter(
      (c) => !c.parentId && !fixedRootIds.has(c.id)
    );
    const orphanSubs = currentCategories.filter(
      (c) => c.parentId && !fixedRootIds.has(c.parentId)
    );

    report.rootCategoriesRemoved = orphanRoots.map((c) => c.name);
    report.subcategoriesRemoved = orphanSubs.map((c) => c.name);

    // 3. Taxonomía final: las 8 raíces fijas (+ subcategorías válidas si se piden).
    const keptSubs = keepSubcategories
      ? currentCategories.filter((c) => c.parentId && fixedRootIds.has(c.parentId))
      : [];
    const nextCategories: Category[] = [...fixedRoots, ...keptSubs];
    if (!keepSubcategories) {
      report.subcategoriesRemoved = currentCategories
        .filter((c) => c.parentId)
        .map((c) => c.name);
    }

    // 4. Reasignación de productos con matching estricto sobre las 8 raíces.
    const fallbackRoot = fixedRoots.find((r) => r.id === FALLBACK_ROOT_ID) ?? fixedRoots[0];
    const keptSubIds = new Set(keptSubs.map((c) => c.id));
    const counts: Record<string, number> = {};

    for (const product of products) {
      const matched = suggestCategoryStrictIn(productHaystack(product), fixedRoots);
      let target = matched ?? fallbackRoot;
      if (!matched) {
        report.productsWithoutMatch++;
        if (report.productsWithoutMatchSample.length < 25) {
          report.productsWithoutMatchSample.push(product.title || product.id);
        }
      }

      // Asignación manual (prioridad sobre el matching automático).
      const manualRootId = manual[product.id];
      if (manualRootId) {
        const manualRoot = fixedRoots.find((root) => root.id === manualRootId);
        if (manualRoot) {
          target = manualRoot;
          report.manualApplied.push(`${product.id} -> ${manualRoot.id}`);
        } else {
          report.errors.push(`Raíz manual desconocida para "${product.id}": ${manualRootId}`);
        }
      }

      const nextSubcategoryId =
        product.subcategory_id && keptSubIds.has(product.subcategory_id)
          ? product.subcategory_id
          : undefined;

      const changed =
        product.category !== target.name ||
        product.category_id !== target.id ||
        (product.subcategory_id ?? undefined) !== nextSubcategoryId;

      if (changed) {
        product.category = target.name;
        product.category_id = target.id;
        product.subcategory_id = nextSubcategoryId;
        report.productsReassigned++;
      } else {
        report.productsUnchanged++;
      }

      counts[target.id] = (counts[target.id] ?? 0) + 1;
    }
    report.categoryCounts = counts;

    // 5. Escritura (con backup previo). En dry-run no se toca nada.
    if (!dryRun) {
      const stamp = startedAt.replace(/[:.]/g, '-');
      const backup = createBackup(stamp);
      report.backupDir = backup.dir;
      report.backupFiles = backup.files;

      writeCategories(nextCategories);
      if (!writeProductsToFile(products)) {
        throw new Error('No se pudo escribir products.json');
      }
    }

    report.success = true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Error desconocido en migración';
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
  const missingFixedRoots = DEFAULT_CATEGORIES.filter(
    (root) => !roots.some((c) => c.id === root.id)
  ).map((root) => root.id);
  const unknownRoots = roots.filter((c) => !DEFAULT_CATEGORIES.some((root) => root.id === c.id)).map((c) => c.id);

  return new Response(
    JSON.stringify({
      success: true,
      total: categories.length,
      roots: roots.length,
      subcategories: subcategories.length,
      missingFixedRoots,
      unknownRoots,
      products: products.length,
      productsWithoutRoot: products.filter((p) => !p.category_id).length,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
};
