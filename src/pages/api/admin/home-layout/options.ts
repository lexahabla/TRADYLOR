/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: PORTADA EDITABLE · OPCIONES PARA LOS SELECTORES (etapa 2, SOLO LECTURA)
 * ==============================================================================
 * GET /api/admin/home-layout/options
 *
 * Permisos : sólo administradores (comprobado en el servidor). Sin sesión o sin rol admin → 401.
 * Parámetros (cualquier otro → 400 `parametro_desconocido`; repetido → 400 `parametro_duplicado`):
 *   kind   OBLIGATORIO  product | category | section | merchant        (ausente o distinto → 400 `kind_no_valido`)
 *   q      opcional     texto de búsqueda, 1–80 caracteres, sin distinguir mayúsculas ni tildes (id, título o nombre). Más de 80 → 400 `q_no_valido`
 *   limit  opcional     entero 1–50, por defecto 20 (fuera de rango o no entero → 400 `limit_no_valido`)
 *   offset opcional     entero 0–10000, por defecto 0 (fuera de rango o no entero → 400 `offset_no_valido`)
 * Respuestas:
 *   200 { success, kind, total, offset, limit, items[] }
 *       product  : { id, title, category, network, price, hasImage, inStock }      (orden alfabético por título)
 *       category : { id, name, slug, parentId, level }                             (level = category | subcategory; árbol: raíz y sus hijas)
 *       section  : { id, title, published, position, productCount, validProductCount }  (orden de «Crear sección»)
 *       merchant : { id, productCount }                                            (más productos primero)
 *   400 { success:false, code, message } · 401 (texto) · 405 { code:'metodo_no_permitido' } · 500 { code:'error_interno' }
 * No devuelve enlaces de afiliado ni de salida, comisiones, credenciales, descripciones internas ni rutas del servidor.
 * No escribe nada.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { loadSources, type ReferenceSources } from '../../../../lib/homeLayout/sources';
import { isPresentable } from '../../../../lib/homeLayout/resolve';
import { normalizeKey } from '../../../../lib/categories';

export const prerender = false;

const KINDS = ['product', 'category', 'section', 'merchant'] as const;
type Kind = (typeof KINDS)[number];
const ALLOWED = new Set(['kind', 'q', 'limit', 'offset']);
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const MAX_OFFSET = 10_000;
const MAX_Q = 80;
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

const fail = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, code, message }), { status, headers: { ...headers, ...extra } });

const intParam = (raw: string | null, min: number, max: number, def: number): number | null => {
  if (raw === null) return def;
  if (!/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
};

function buildItems(kind: Kind, q: string, src: ReferenceSources): unknown[] {
  const match = (...texts: Array<string | undefined>) => !q || texts.some((t) => t && normalizeKey(t).includes(q));
  if (kind === 'product') {
    return [...src.products.values()]
      .filter((p) => match(p.id, p.title))
      .sort((a, b) => a.title.localeCompare(b.title, 'es') || a.id.localeCompare(b.id))
      .map((p) => ({ id: p.id, title: p.title, category: p.category, network: p.network, price: p.price, hasImage: p.hasImage, inStock: p.inStock }));
  }
  if (kind === 'category') {
    const all = [...src.categories.values()];
    const roots = all.filter((c) => !c.parentId);
    const ordered = roots.flatMap((r) => [r, ...all.filter((c) => c.parentId === r.id)]);
    const orphans = all.filter((c) => c.parentId && !roots.some((r) => r.id === c.parentId));
    return [...ordered, ...orphans]
      .filter((c) => match(c.id, c.name, c.slug))
      .map((c) => ({ id: c.id, name: c.name, slug: c.slug, parentId: c.parentId, level: c.parentId ? 'subcategory' : 'category' }));
  }
  if (kind === 'section') {
    return [...src.sectionList]
      .sort((a, b) => a.order - b.order)
      .filter((s) => match(s.id, s.title))
      .map((s) => {
        const existing = s.productIds.filter((pid) => src.products.has(pid));
        return {
          id: s.id,
          title: s.title,
          published: s.published,
          position: s.position,
          productCount: s.productIds.length,
          validProductCount: existing.filter((pid) => isPresentable(src.products.get(pid))).length,
        };
      });
  }
  return [...src.networks.entries()]
    .filter(([id]) => match(id))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, productCount]) => ({ id, productCount }));
}

export const GET: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  try {
    const url = new URL(request.url);
    const seen = new Set<string>();
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED.has(key)) return fail(400, 'parametro_desconocido', `Parámetro no admitido: ${key.slice(0, 40)}`);
      if (seen.has(key)) return fail(400, 'parametro_duplicado', `El parámetro «${key}» está repetido`);
      seen.add(key);
    }
    const kind = url.searchParams.get('kind');
    if (!kind || !KINDS.includes(kind as Kind)) return fail(400, 'kind_no_valido', 'kind debe ser product, category, section o merchant');
    const rawQ = url.searchParams.get('q');
    if (rawQ !== null && (rawQ.trim().length > MAX_Q || rawQ.length > 400)) return fail(400, 'q_no_valido', `q admite como máximo ${MAX_Q} caracteres`);
    const q = rawQ ? normalizeKey(rawQ.trim()) : '';
    const limit = intParam(url.searchParams.get('limit'), 1, MAX_LIMIT, DEFAULT_LIMIT);
    if (limit === null) return fail(400, 'limit_no_valido', `limit debe ser un entero entre 1 y ${MAX_LIMIT}`);
    const offset = intParam(url.searchParams.get('offset'), 0, MAX_OFFSET, 0);
    if (offset === null) return fail(400, 'offset_no_valido', `offset debe ser un entero entre 0 y ${MAX_OFFSET}`);

    const all = buildItems(kind as Kind, q, loadSources());
    return new Response(JSON.stringify({ success: true, kind, total: all.length, offset, limit, items: all.slice(offset, offset + limit) }), { status: 200, headers });
  } catch {
    return fail(500, 'error_interno', 'No se pudieron obtener las opciones');
  }
};

/** Cualquier otro método: 405 (tras comprobar permisos). */
export const ALL: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  return fail(405, 'metodo_no_permitido', 'Sólo se admite GET', { Allow: 'GET' });
};
