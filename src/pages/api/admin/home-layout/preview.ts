/**
 * ==============================================================================
 * TREIDILOR — API ADMIN: DATOS REALES PARA LAS PREVISUALIZACIONES (etapa 5, SOLO LECTURA)
 * ==============================================================================
 * GET /api/admin/home-layout/preview
 *
 * Devuelve, por bloque, los elementos REALES que se verían (producto con título, precio e imagen; categoría con su nombre), resolviendo
 * referencias manuales, secciones publicadas y la selección de la modalidad Automática (`automatic.ts`). No escribe nada, no modifica el
 * catálogo y sólo expone campos públicos: nunca enlaces de afiliado, comisiones, credenciales ni rutas del servidor.
 * Permisos: sólo administradores (401). Cualquier otro método → 405 (Allow: GET). Un único modo por petición; parámetros desconocidos o
 * repetidos → 400.
 *   ?source=draft (por defecto) | published   Bloques guardados del borrador o de la versión publicada.
 *   ?version=N                                Bloques de la versión N (publicada o archivada).
 *   ?auto=<JSON>                              Prueba una regla SIN guardar: {"format":"carrusel","rules":{…}} (≤ 2 KB, validada con las reglas
 *                                             del modelo). Respuesta: { auto: {status, reason?, message?, stats, items[]} }.
 *   ?catalog=<texto>[&limit=1-24]             Búsqueda de productos por título (sólo los que tienen imagen segura) para elegir imágenes.
 * Respuesta 200 { success, source, blocks: { [blockId]: { items[], auto?, note? } } } con ≤ 12 elementos por bloque.
 *
 * POST /api/admin/home-layout/preview   (SOLO LECTURA: no guarda nada; es POST sólo por el tamaño del cuerpo)
 *   Cuerpo { blocks } con los bloques del editor SIN GUARDAR (≤ 60, ≤ 256 KiB). Cada bloque se valida por separado: los incompletos o no
 *   válidos se devuelven en `invalid` (por id) y los demás se resuelven con los datos actuales y se previsualizan.
 *   Respuesta 200 { success, blocks: { [id]: { items[], auto?, note? } }, resolved: { blocks[], totals }, invalid: { [id]: string[] } }.
 *   Misma protección que el resto de escrituras: administrador, Origin propio, cabecera X-Home-Layout-Editor: 1 y application/json
 *   (413 por tamaño, 415 por tipo, 400 JSON/estructura no válidos).
 * PreviewItem: { kind:'product'|'category', id, title, price|null, image|null, network, inStock|null, missing? }.
 * ==============================================================================
 */

import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../../../lib/adminAuth';
import { readHomeLayout } from '../../../../lib/homeLayout/store';
import { sameOrigin } from '../../../../lib/alertsHttp';
import { normalizeKey } from '../../../../lib/categories';
import { MAX_BODY_BYTES } from '../../../../lib/homeLayout/draft';
import { resolveBlocks } from '../../../../lib/homeLayout/resolve';
import { findCategory, loadSources, type ReferenceSources } from '../../../../lib/homeLayout/sources';
import { runAutomatic, type AutoResult } from '../../../../lib/homeLayout/automatic';
import { findVersion } from '../../../../lib/homeLayout/publish';
import { MAX_BLOCKS, isSafeImageUrl, validateBlock } from '../../../../lib/homeLayout/validate';
import type { Block } from '../../../../lib/homeLayout/types';

export const prerender = false;

const ALLOWED = new Set(['source', 'version', 'auto', 'catalog', 'limit']);
const MAX_ITEMS = 12;
const MAX_AUTO_QUERY = 2048;
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const fail = (status: number, code: string, message: string, more: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: false, code, message }), { status, headers: { ...headers, ...more } });

interface PreviewItem {
  kind: 'product' | 'category';
  id: string;
  title: string;
  price: number | null;
  image: string | null;
  network: string;
  inStock: boolean | null;
  missing?: boolean;
}

const productItem = (src: ReferenceSources, id: string): PreviewItem => {
  const p = src.products.get(id);
  if (!p) return { kind: 'product', id, title: '(producto no disponible)', price: null, image: null, network: '', inStock: null, missing: true };
  return { kind: 'product', id, title: p.title, price: p.price, image: p.image && isSafeImageUrl(p.image) ? p.image : null, network: p.network, inStock: p.inStock };
};

const autoPayload = (res: AutoResult, src: ReferenceSources) => ({
  status: res.status,
  ...(res.reason ? { reason: res.reason } : {}),
  ...(res.message ? { message: res.message } : {}),
  stats: res.stats,
  items: res.ids.slice(0, MAX_ITEMS).map((id) => productItem(src, id)),
});

function previewBlock(b: Block, src: ReferenceSources): { items: PreviewItem[]; auto?: ReturnType<typeof autoPayload>; note?: string } {
  if (b.modality === 'editorial') return { items: [] };
  if (b.modality === 'automatica') {
    const res = runAutomatic((b.config as { rules: Parameters<typeof runAutomatic>[0] }).rules, src);
    const auto = autoPayload(res, src);
    return { items: auto.items, auto };
  }
  if (b.modality === 'seccion') {
    const s = src.sections.get(b.refs[0]?.id ?? '');
    if (!s) return { items: [], note: 'La sección ya no existe' };
    if (!s.published) return { items: [], note: 'La sección no está publicada: el bloque no se mostraría' };
    return { items: s.productIds.filter((id) => src.products.has(id)).slice(0, MAX_ITEMS).map((id) => productItem(src, id)) };
  }
  const items: PreviewItem[] = [];
  for (const r of b.refs.slice(0, MAX_ITEMS)) {
    if (r.kind === 'product') items.push(productItem(src, r.id));
    else if (r.kind === 'category') {
      const c = findCategory(src, r.id);
      items.push({ kind: 'category', id: r.id, title: c?.name ?? '(categoría no disponible)', price: null, image: null, network: '', inStock: null, ...(c ? {} : { missing: true }) });
    }
  }
  return { items };
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
    const q = url.searchParams;
    if (['source', 'version', 'auto', 'catalog'].filter((k) => q.has(k)).length > 1 || (q.has('limit') && !q.has('catalog'))) return fail(400, 'combinacion_no_valida', 'Usa un único modo: source, version, auto o catalog');
    const src = loadSources();

    if (q.has('catalog')) {
      const text = (q.get('catalog') ?? '').trim();
      if (text.length > 80) return fail(400, 'catalog_no_valido', 'La búsqueda admite hasta 80 caracteres');
      const rawLimit = q.get('limit');
      const limit = rawLimit === null ? 12 : /^\d{1,2}$/.test(rawLimit) ? Number(rawLimit) : 0;
      if (limit < 1 || limit > 24) return fail(400, 'limit_no_valido', 'limit debe estar entre 1 y 24');
      const key = normalizeKey(text);
      const found: PreviewItem[] = [];
      for (const p of src.products.values()) {
        if (!p.title || src.retiredIds.has(p.id) || !p.image || !isSafeImageUrl(p.image)) continue;
        if (key && !normalizeKey(p.title).includes(key)) continue;
        found.push(productItem(src, p.id));
      }
      found.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : 1));
      return new Response(JSON.stringify({ success: true, items: found.slice(0, limit), total: found.length }), { status: 200, headers });
    }

    if (q.has('auto')) {
      const raw = q.get('auto') ?? '';
      if (raw.length > MAX_AUTO_QUERY) return fail(400, 'auto_demasiado_grande', 'La regla es demasiado grande');
      let parsed: { format?: unknown; rules?: unknown };
      try {
        parsed = JSON.parse(raw);
      } catch {
        return fail(400, 'auto_no_valido', 'auto debe ser JSON válido');
      }
      const probe = validateBlock({ id: 'prueba', modality: 'automatica', format: parsed.format ?? 'carrusel', width: 12, title: 'Prueba', card: 'producto', config: { rules: parsed.rules }, refs: [], visible: true });
      if (!probe.ok) return fail(400, 'auto_no_valido', `Regla no válida: ${probe.errors.slice(0, 2).join(' · ')}`);
      const res = runAutomatic((probe.value.config as { rules: Parameters<typeof runAutomatic>[0] }).rules, src);
      return new Response(JSON.stringify({ success: true, auto: autoPayload(res, src) }), { status: 200, headers });
    }

    const read = readHomeLayout();
    let blocks: Block[];
    let source: string;
    if (q.has('version')) {
      const raw = q.get('version') ?? '';
      if (!/^\d{1,6}$/.test(raw) || Number(raw) < 1) return fail(400, 'version_no_valida', 'version debe ser un entero ≥ 1');
      const v = findVersion(read.doc, Number(raw));
      if (!v) return fail(404, 'version_no_encontrada', 'La versión indicada no existe');
      blocks = v.blocks;
      source = `version:${v.version}`;
    } else {
      const s = q.get('source') ?? 'draft';
      if (s !== 'draft' && s !== 'published') return fail(400, 'source_no_valido', 'source debe ser draft o published');
      blocks = s === 'published' ? (read.doc.published?.blocks ?? []) : read.doc.draft.blocks;
      source = s;
    }
    const out: Record<string, ReturnType<typeof previewBlock>> = {};
    for (const b of blocks) out[b.id] = previewBlock(b, src);
    return new Response(JSON.stringify({ success: true, source, blocks: out }), { status: 200, headers });
  } catch {
    return fail(500, 'error_interno', 'No se pudo preparar la previsualización');
  }
};

export const POST: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  if (!sameOrigin(request)) return fail(403, 'origen_no_permitido', 'No se pudo verificar el origen de la petición');
  if (request.headers.get('x-home-layout-editor') !== '1') return fail(403, 'cabecera_requerida', 'Falta la cabecera de seguridad del editor');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return fail(415, 'tipo_no_admitido', 'El cuerpo debe ser application/json');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Demasiados datos');
  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return fail(413, 'cuerpo_demasiado_grande', 'Demasiados datos');
    body = JSON.parse(text);
  } catch {
    return fail(400, 'json_invalido', 'El cuerpo no es JSON válido');
  }
  try {
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).some((k) => k !== 'blocks')) return fail(400, 'peticion_invalida', 'El cuerpo debe ser { blocks }');
    const raw = (body as { blocks: unknown }).blocks;
    if (!Array.isArray(raw) || raw.length > MAX_BLOCKS) return fail(400, 'peticion_invalida', `blocks debe ser una lista de hasta ${MAX_BLOCKS} bloques`);
    const valid: Block[] = [];
    const invalid: Record<string, string[]> = {};
    raw.forEach((x, i) => {
      const v = validateBlock(x, `blocks[${i}]`);
      if (v.ok) valid.push(v.value);
      else {
        const id = typeof (x as { id?: unknown })?.id === 'string' ? (x as { id: string }).id : `#${i}`;
        invalid[id] = v.errors.slice(0, 5);
      }
    });
    const src = loadSources();
    const out: Record<string, ReturnType<typeof previewBlock>> = {};
    for (const b of valid) out[b.id] = previewBlock(b, src);
    return new Response(JSON.stringify({ success: true, blocks: out, resolved: resolveBlocks(valid, src, { runAutomatic: true }), invalid }), { status: 200, headers });
  } catch {
    return fail(500, 'error_interno', 'No se pudo preparar la previsualización');
  }
};

/** Cualquier otro método: 405 (tras comprobar permisos). */
export const ALL: APIRoute = async ({ request }) => {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  return fail(405, 'metodo_no_permitido', 'Sólo se admite GET y POST', { Allow: 'GET, POST' });
};
