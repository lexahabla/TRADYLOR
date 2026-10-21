/**
 * ==============================================================================
 * TRADYLOR - MIGRACIÓN DE CATEGORÍAS Y PRODUCTOS
 * ==============================================================================
 * POST /api/admin/migrate-categories
 *
 * Proceso de migración único para unificar categorías:
 * 1. Reasigna TODOS los productos existentes a las 8 categorías raíz fijas
 *    usando la lógica estricta de matching por palabras clave (suggestCategoryStrict).
 * 2. Elimina categorías raíz huérfanas/duplicadas que no son de las 8 fijas.
 * 3. Elimina subcategorías huérfanas (sin padre válido).
 * 4. Actualiza contadores de productos por categoría.
 * 5. Devuelve reporte detallado de cambios.
 *
 * SOLO para uso administrativo (requiere auth de admin).
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { getCategories, suggestCategoryStrict, writeCategories, getCategoryById } from '../../../lib/categories';
import { readProductsFromFile, writeProductsToFile, slugify } from '../../../lib/productStore';
import type { Product } from '../../../lib/productStore';
import { getSessionUser } from '../../../lib/adminAuth';

export const prerender = false;

const VALID_ROOT_CATEGORY_IDS = [
  'informatica-oficina',
  'audio-sonido',
  'smartwatches',
  'hogar-inteligencia',
  'movil-accesorios',
  'fotografia-video',
  'gaming',
  'herramientas-bricolaje',
];

interface MigrateReport {
  success: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  productsReassigned: number;
  productsUnchanged: number;
  rootCategoriesRemoved: string[];
  subcategoriesRemoved: string[];
  categoryCounts: Record<string, number>;
  errors: string[];
}

function getValidRootCategories() {
  return getCategories().filter((c) => !c.parentId && VALID_ROOT_CATEGORY_IDS.includes(c.id));
}

export const POST: APIRoute = async ({ request }) => {
  const auth = getSessionUser(request);
  if (!auth || auth.role !== 'admin') {
    return new Response(JSON.stringify({ success: false, message: 'No autorizado: se requiere rol admin' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const report: MigrateReport = {
    success: false,
    startedAt,
    finishedAt: '',
    durationMs: 0,
    productsReassigned: 0,
    productsUnchanged: 0,
    rootCategoriesRemoved: [],
    subcategoriesRemoved: [],
    categoryCounts: {},
    errors: [],
  };

  try {
    // 1. Cargar productos y categorías actuales
    const products = readProductsFromFile();
    const allCategories = getCategories();

    // 2. Identificar categorías raíz válidas (las 8 fijas)
    const validRoots = getValidRootCategories();
    const validRootIds = new Set(validRoots.map((c) => c.id));

    // 3. Identificar categorías a eliminar:
    // - Raíces que NO son de las 8 fijas
    // - Subcategorías cuyo padre no existe o no es una raíz válida
    const orphanRoots = allCategories.filter(
      (c) => !c.parentId && !validRootIds.has(c.id)
    );
    const orphanSubs = allCategories.filter(
      (c) => c.parentId && (!getCategoryById(c.parentId) || !validRootIds.has(getCategoryById(c.parentId)?.id ?? ''))
    );

    // 4. Reasignar cada producto a una categoría raíz válida
    for (const product of products) {
      const text = `${product.title} ${product.description ?? ''} ${product.category ?? ''}`;
      const matched = suggestCategoryStrict(text);

      let newCategoryId: string;
      let newCategoryName: string;
      let newSubcategoryId: string | undefined;

      if (matched) {
        newCategoryId = matched.id;
        newCategoryName = matched.name;
      } else {
        // Fallback a Informática y Oficina
        const fallback = validRoots.find((c) => c.id === 'informatica-oficina');
        newCategoryId = fallback?.id ?? 'informatica-oficina';
        newCategoryName = fallback?.name ?? 'Informática y Oficina';
      }

      // Verificar si la subcategoría actual del producto es válida
      if (product.subcategory_id) {
        const subCat = getCategoryById(product.subcategory_id);
        if (subCat && subCat.parentId === newCategoryId) {
          newSubcategoryId = subCat.id;
        }
      }

      const oldCategory = product.category;
      const oldCategoryId = product.category_id;
      const oldSubcategoryId = product.subcategory_id;

      if (oldCategoryId !== newCategoryId || oldSubcategoryId !== newSubcategoryId) {
        product.category = newCategoryName;
        product.category_id = newCategoryId;
        product.subcategory_id = newSubcategoryId;
        report.productsReassigned++;
      } else {
        report.productsUnchanged++;
      }
    }

    // 5. Guardar productos actualizados
    writeProductsToFile(products);

    // 6. Eliminar categorías huérfanas
    const categoriesToKeep = allCategories.filter(
      (c) => !orphanRoots.some((o) => o.id === c.id) && !orphanSubs.some((o) => o.id === c.id)
    );

    for (const orphan of orphanRoots) {
      report.rootCategoriesRemoved.push(orphan.name);
    }
    for (const orphan of orphanSubs) {
      report.subcategoriesRemoved.push(orphan.name);
    }

    writeCategories(categoriesToKeep);

    // 7. Calcular contadores por categoría
    const counts: Record<string, number> = {};
    for (const product of products) {
      if (product.category_id) {
        counts[product.category_id] = (counts[product.category_id] || 0) + 1;
      }
    }
    report.categoryCounts = counts;

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
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};