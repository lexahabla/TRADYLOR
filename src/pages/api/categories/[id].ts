import type { APIRoute } from 'astro';
import {
  getCategoryById,
  getCategories,
  updateCategory,
  removeCategory,
} from '../../../lib/categories';
import { readProductsFromFile, writeProductsToFile } from '../../../lib/productStore';
import { requireAdminAuth } from '../../../lib/adminAuth';

export const prerender = false;

/**
 * Reasigna y actualiza automáticamente todos los productos asociados a una categoría
 * cuando ésta es editada o actualizada (nombre, id, jerarquía raíz/subcategoría).
 * Garantiza que adopten la nueva categoría y no conserven el nombre o id antiguo.
 */
function updateProductsOnCategoryChange(
  previousCategory: { id: string; name: string; slug?: string; parentId?: string | null },
  updatedCategory: { id: string; name: string; slug?: string; parentId?: string | null },
  remappedChildren: { from: string; to: string }[] = []
): number {
  try {
    const products = readProductsFromFile();
    let changed = 0;
    const allCategories = getCategories();
    const categoriesById = new Map(allCategories.map((c) => [c.id, c]));

    const oldIds = new Set<string>([previousCategory.id, previousCategory.slug].filter((x): x is string => Boolean(x)));
    const oldNameNormalized = previousCategory.name ? previousCategory.name.trim().toLowerCase() : '';

    const childMap = new Map<string, string>();
    for (const pair of remappedChildren) {
      if (pair.from && pair.to) childMap.set(pair.from, pair.to);
    }

    for (const product of products) {
      let touched = false;

      // 1. ¿Está asociado el producto por ID de categoría o subcategoría?
      const matchesCategoryById = Boolean(product.category_id && oldIds.has(product.category_id));
      const matchesSubcategoryById = Boolean(product.subcategory_id && oldIds.has(product.subcategory_id));

      // 2. ¿Está asociado el producto por el nombre antiguo de la categoría?
      const prodCatNormalized = String(product.category || '').trim().toLowerCase();
      const matchesByName = Boolean(oldNameNormalized && prodCatNormalized === oldNameNormalized);

      // 3. ¿Tiene una subcategoría hija que fue remapeada al cambiar el slug del padre?
      const matchesChildSub = Boolean(product.subcategory_id && childMap.has(product.subcategory_id));

      if (matchesCategoryById || matchesSubcategoryById || matchesByName || matchesChildSub) {
        if (updatedCategory.parentId) {
          // La categoría actualizada es ahora una SUBCATEGORÍA
          const parent = categoriesById.get(updatedCategory.parentId) || getCategoryById(updatedCategory.parentId);
          const rootName = parent ? parent.name : updatedCategory.name;

          if (product.category !== rootName) {
            product.category = rootName;
            touched = true;
          }
          if (product.category_id !== updatedCategory.parentId) {
            product.category_id = updatedCategory.parentId;
            touched = true;
          }
          if (product.subcategory_id !== updatedCategory.id) {
            product.subcategory_id = updatedCategory.id;
            touched = true;
          }
        } else {
          // La categoría actualizada es una CATEGORÍA RAÍZ
          if (product.category !== updatedCategory.name) {
            product.category = updatedCategory.name;
            touched = true;
          }
          if (product.category_id !== updatedCategory.id) {
            product.category_id = updatedCategory.id;
            touched = true;
          }

          // Si el producto tenía en `subcategory_id` el id antiguo de esta categoría que ahora es raíz:
          if (product.subcategory_id && oldIds.has(product.subcategory_id)) {
            delete product.subcategory_id;
            touched = true;
          }

          // Si tenía una subcategoría hija remapeada:
          if (product.subcategory_id && childMap.has(product.subcategory_id)) {
            const nextSub = childMap.get(product.subcategory_id)!;
            if (product.subcategory_id !== nextSub) {
              product.subcategory_id = nextSub;
              touched = true;
            }
          }
        }
      }

      if (touched) changed++;
    }

    if (changed > 0) {
      writeProductsToFile(products);
    }
    return changed;
  } catch (error) {
    console.error('[API Categories] Error actualizando productos tras cambio de categoría:', error);
    return 0;
  }
}

/** Limpia los ids de categoría que quedan huérfanos tras eliminar categorías. */
function clearCategoryInProducts(ids: string[]): number {
  if (!ids.length) return 0;
  try {
    const wanted = new Set(ids);
    const products = readProductsFromFile();
    let changed = 0;
    for (const product of products) {
      let touched = false;
      if (product.category_id && wanted.has(product.category_id)) {
        delete product.category_id;
        touched = true;
      }
      if (product.subcategory_id && wanted.has(product.subcategory_id)) {
        delete product.subcategory_id;
        touched = true;
      }
      if (touched) changed++;
    }
    if (changed) writeProductsToFile(products);
    return changed;
  } catch (error) {
    console.error('[API Categories] Error limpiando ids de productos:', error);
    return 0;
  }
}

/**
 * GET /api/categories/[id]
 * Devuelve el detalle de una categor�a por su ID o Slug.
 */
export const GET: APIRoute = async ({ params }) => {
  const id = String(params.id || '').trim();
  if (!id) {
    return new Response(
      JSON.stringify({ success: false, message: 'Identificador no proporcionado.' }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  const category = getCategoryById(id);
  if (!category) {
    return new Response(
      JSON.stringify({ success: false, message: `Categor�a "${id}" no encontrada.` }),
      { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, category }),
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
};

/**
 * PUT /api/categories/[id]
 * Actualiza los campos de una categor�a existente (nombre, slug, icono, descripci�n, keywords/rules).
 * Protegido mediante sesi�n administrativa.
 */
export const PUT: APIRoute = async ({ params, request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const id = String(params.id || '').trim();
  if (!id) {
    return new Response(
      JSON.stringify({ success: false, message: 'Identificador no proporcionado.' }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  try {
    const contentType = request.headers.get('content-type') || '';
    let body: any = {};

    if (contentType.includes('application/json')) {
      body = await request.json();
    } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      body = {
        name: formData.get('name'),
        slug: formData.get('slug'),
        icon: formData.get('icon'),
        description: formData.get('description'),
        keywords: formData.get('keywords'),
        // ?? undefined: si el campo no viene, se conserva el parentId actual.
        parentId: formData.get('parentId') ?? undefined,
      };
    } else {
      body = await request.json().catch(() => ({}));
    }

    let keywords: string[] | undefined = undefined;
    const rawKeywords = body.keywords ?? body.rules;
    if (rawKeywords !== undefined) {
      if (Array.isArray(rawKeywords)) {
        keywords = rawKeywords.map((k) => String(k).trim()).filter(Boolean);
      } else if (typeof rawKeywords === 'string') {
        keywords = rawKeywords
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean);
      }
    }

    const current = getCategoryById(id);
    const targetSlug = current?.slug ?? id;
    const result = updateCategory(targetSlug, {
      name: body.name !== undefined ? String(body.name) : current?.name ?? '',
      icon: body.icon !== undefined ? String(body.icon) : undefined,
      keywords,
      // Re-parentado opcional: vacío/null = convertir en raíz; ausente = conservar.
      parentId: body.parentId === undefined
        ? undefined
        : body.parentId === null || String(body.parentId).trim() === ''
          ? null
          : String(body.parentId).trim(),
    });

    if (!result.ok) {
      return new Response(
        JSON.stringify({ success: false, message: result.message, categories: result.categories }),
        { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }

    // Reasigna automáticamente todos los productos asociados para que adopten
    // la nueva categoría (nombre, IDs jerárquicos) sin conservar la antigua.
    let repointed = 0;
    if (current && result.category) {
      repointed = updateProductsOnCategoryChange(
        current,
        result.category,
        result.remapped ?? []
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: result.message,
        category: result.category,
        categories: result.categories,
        repointedProducts: repointed,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        success: false,
        message: 'Error al actualizar categor�a: ' + (error?.message || 'Error desconocido'),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }
};

/**
 * DELETE /api/categories/[id]
 * Elimina una categor�a del archivo JSON persistente.
 * Protegido mediante sesi�n administrativa.
 */
export const DELETE: APIRoute = async ({ params, request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const id = String(params.id || '').trim();
  if (!id) {
    return new Response(
      JSON.stringify({ success: false, message: 'Identificador no proporcionado.' }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  const target = getCategoryById(id);
  // IDs que dejan de existir: la categoría y sus subcategorías (borrado en cascada).
  const removedIds = target
    ? [
        target.id,
        ...getCategories()
          .filter((category) => category.parentId === target.id)
          .map((category) => category.id),
      ]
    : [];
  const result = removeCategory(target?.slug ?? id);
  if (!result.ok) {
    return new Response(
      JSON.stringify({ success: false, message: result.message, categories: result.categories }),
      { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  // Los productos conservan su texto de categoría, pero se les quitan los ids
  // que apuntan a categorías ya inexistentes.
  const cleaned = clearCategoryInProducts(removedIds);

  return new Response(
    JSON.stringify({
      success: true,
      message: result.message,
      categories: result.categories,
      cleanedProducts: cleaned,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
};
