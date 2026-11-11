/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · HISTORIAS INICIALES (funciones PURAS)
 * ==============================================================================
 * Genera las seis primeras historias (Informática, Portabilidad, Sonido, Hogar, Bajadas de precio y Descubre) con productos y categorías REALES del
 * catálogo del momento, usando el modelo EXISTENTE de historias (`stories.ts`): imagen real, título, texto, destino (producto, categoría o ruta propia)
 * y botón. No añade campos ni inventa nada:
 *  · precios y comercio salen de la ficha (con la fecha del día en que se crea la historia: es texto, no se actualiza solo);
 *  · «Bajadas de precio» usa SÓLO descuentos verificados (`shownDiscount`: misma prueba que la insignia «-N %»); sin ellos la historia se omite;
 *  · una categoría sin productos presentables se omite y se explica en el informe;
 *  · ningún producto ni imagen se repite entre historias (los círculos de portada son distintos).
 * Todas se crean como BORRADOR: no se ven en la web hasta que el administrador las marque como «publicada».
 * ==============================================================================
 */

import { MAX_SCREENS, validateStories, type Story, type StoryScreen } from './stories';
import { isPublicSafeImage } from './publicSafety';
import { shownDiscount } from '../commercialClaims';
import { NETWORK_LABELS } from '../productNetwork';

export interface InitialStoriesInput {
  /** Productos del catálogo (fichas tal y como las devuelve `getCatalogProducts`). */
  products: ReadonlyArray<Record<string, any>>;
  categories: ReadonlyArray<{ id: string; name: string; slug: string; parentId: string | null }>;
  retiredIds: ReadonlySet<string>;
  /** ¿Existe la imagen propia (ruta local)? Las URL https externas se aceptan si son seguras. */
  imageOk: (image: string) => boolean;
  now: Date;
}
export interface StoryReportRow {
  id: string;
  name: string;
  status: 'creada' | 'omitida';
  screens: number;
  products: string[];
  reason?: string;
}
export interface InitialStoriesResult {
  stories: Story[];
  report: StoryReportRow[];
}

/** Historias y categorías (id del catálogo). `descubre` y `bajadas` no son categorías. */
const CATEGORY_STORIES = ['informatica', 'portabilidad', 'sonido', 'hogar'] as const;

const fold = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const eur = (n: number) => `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const dmy = (d: Date) => d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid' });
export function cut(text: string, max: number): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max - 1);
  const sp = head.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? head.slice(0, sp) : head).replace(/[\s,.;:–—-]+$/, '')}…`;
}
const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`);

/** Genera las historias iniciales. No lanza ni escribe. */
export function buildInitialStories(input: InitialStoriesInput): InitialStoriesResult {
  const { retiredIds, now } = input;
  const date = dmy(now);
  const catById = new Map(input.categories.map((c) => [c.id, c]));
  const catByName = new Map(input.categories.map((c) => [fold(c.name), c]));
  const catOf = (p: Record<string, any>) => {
    const id = typeof p.category_id === 'string' && catById.has(p.category_id) ? p.category_id : catByName.get(fold(p.category))?.id;
    return id ? catById.get(id) ?? null : null;
  };
  // La subcategoría del producto es `subcategory_id` tal cual o con el formato «<categoría>--<subcategoría>».
  const subOf = (p: Record<string, any>) => {
    const raw = typeof p.subcategory_id === 'string' ? p.subcategory_id : '';
    if (!raw) return null;
    const direct = catById.get(raw);
    if (direct) return direct;
    const [parent, rest] = raw.includes('--') ? raw.split('--') : [catOf(p)?.id ?? '', raw];
    return input.categories.find((c) => c.parentId === parent && (c.id === rest || c.slug === rest)) ?? null;
  };

  const usable = (p: Record<string, any>) =>
    Boolean(
      p && typeof p.id === 'string' && !retiredIds.has(p.id) && typeof p.title === 'string' && p.title.trim() && Number.isFinite(Number(p.price)) && Number(p.price) > 0
      && (!p.currency || String(p.currency).toUpperCase() === 'EUR') && p.inStock !== false && isPublicSafeImage(p.image) && (!String(p.image).startsWith('/') || input.imageOk(String(p.image))),
    );
  const pool = input.products.filter(usable).sort((a, b) => Number(a.price) - Number(b.price) || String(a.id).localeCompare(String(b.id)));
  const storeOf = (p: Record<string, any>) => (NETWORK_LABELS as Record<string, string>)[String(p.network ?? '').toLowerCase()] ?? String(p.merchant ?? '').trim();
  const used = new Set<string>();
  const usedImages = new Set<string>();
  const take = (p: Record<string, any>) => { used.add(p.id); usedImages.add(String(p.image)); return p; };
  const free = (p: Record<string, any>) => !used.has(p.id) && !usedImages.has(String(p.image));

  const screen = (storyId: string, n: number, p: Record<string, any>, fields: { title: string; text: string; buttonLabel: string; link: StoryScreen['link'] }): StoryScreen => ({
    id: `${storyId}-${n}`,
    image: String(p.image),
    title: cut(fields.title, 80),
    text: cut(fields.text, 200),
    buttonLabel: cut(fields.buttonLabel, 40),
    ...(fields.link ? { link: fields.link } : {}),
    duration: 7,
  });
  const where = (p: Record<string, any>) => (storeOf(p) ? ` en ${storeOf(p)}` : '');
  const productScreen = (storyId: string, n: number, p: Record<string, any>): StoryScreen =>
    screen(storyId, n, p, {
      title: cut(p.title, 72),
      text: `${eur(Number(p.price))}${where(p)}${subOf(p) ? ` · ${subOf(p)!.name}` : ''} · precio del ${date}`,
      buttonLabel: 'Ver producto',
      link: { type: 'product', target: p.id },
    });

  const built = new Map<string, { story: Story; products: string[] }>();
  const report = new Map<string, StoryReportRow>();
  const skip = (id: string, name: string, reason: string) => report.set(id, { id, name, status: 'omitida', screens: 0, products: [], reason });
  const done = (story: Story, products: string[]) => {
    built.set(story.id, { story, products });
    report.set(story.id, { id: story.id, name: story.name, status: 'creada', screens: story.screens.length, products });
  };

  /* ── Bajadas de precio: SÓLO descuentos verificados (se construye primero para reservar esos productos) ── */
  {
    const deals = pool
      .map((p) => ({ p, d: shownDiscount(p) }))
      .filter((x): x is { p: Record<string, any>; d: NonNullable<ReturnType<typeof shownDiscount>> } => x.d !== null)
      .sort((a, b) => b.d.pct - a.d.pct || String(a.p.id).localeCompare(String(b.p.id)));
    const picked: typeof deals = [];
    for (const x of deals) if (picked.length < 4 && free(x.p)) { take(x.p); picked.push(x); }
    if (!picked.length) skip('bajadas', 'Bajadas de precio', 'Ningún producto tiene ahora una bajada de precio verificada: no se inventa contenido.');
    else {
      const screens = picked.map(({ p, d }, i) => {
        const when = d.asOf && !Number.isNaN(Date.parse(d.asOf)) ? ` · verificado el ${dmy(new Date(d.asOf))}` : '';
        return screen('bajadas', i + 1, p, {
          title: cut(p.title, 72),
          text: `−${d.pct} % verificado: ${eur(Number(p.price))} (antes ${eur(d.previousPrice)})${where(p)}${when}`,
          buttonLabel: 'Ver producto',
          link: { type: 'product', target: p.id },
        });
      });
      done({ id: 'bajadas', name: 'Bajadas de precio', status: 'borrador', screens }, picked.map((x) => x.p.id));
    }
  }

  /* ── Historias de categoría ── */
  for (const cid of CATEGORY_STORIES) {
    const cat = catById.get(cid);
    if (!cat) { skip(cid, cid, 'La categoría no existe en el catálogo.'); continue; }
    const mine = pool.filter((p) => catOf(p)?.id === cid && free(p));
    if (!mine.length) { skip(cid, cat.name, `«${cat.name}» no tiene productos presentables (precio, stock, imagen válida) sin repetir otra historia.`); continue; }
    // subcategorías con productos, de más a menos pobladas; de cada una, su producto más económico
    const groups = new Map<string, Array<Record<string, any>>>();
    for (const p of mine) { const k = subOf(p)?.id ?? '_'; groups.set(k, [...(groups.get(k) ?? []), p]); }
    // Primero las subcategorías reales (de más a menos pobladas); los productos sin subcategoría sólo completan.
    const ordered = [...groups.entries()].sort((a, b) => Number(a[0] === '_') - Number(b[0] === '_') || b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const picks: Array<Record<string, any>> = [];
    for (const [, g] of ordered) { if (picks.length < 4) picks.push(g[0]); }
    for (const p of mine) { if (picks.length < 4 && !picks.includes(p)) picks.push(p); }
    const chosen = picks.slice(0, 4).map(take);
    const subs = ordered.filter(([k]) => k !== '_').map(([k, g]) => `${catById.get(k)!.name} (${g.length})`);
    const total = mine.length;
    const first = chosen[0];
    // Una sola pantalla de categoría (con el único producto presentable) si no hay más; si no, portada de categoría + productos distintos.
    const screens: StoryScreen[] = [
      screen(cid, 1, first, {
        title: cat.name,
        text: chosen.length === 1
          ? `${cut(first.title, 90)} · ${eur(Number(first.price))}${where(first)} · precio del ${date}`
          : `${total} producto${total === 1 ? '' : 's'} con precio real y fecha de captura${subs.length ? `: ${list(subs)}` : ''}.`,
        buttonLabel: 'Explorar categoría',
        link: { type: 'category', target: cat.id },
      }),
      ...chosen.slice(1, MAX_SCREENS).map((p, i) => productScreen(cid, i + 2, p)),
    ];
    done({ id: cid, name: cat.name, status: 'borrador', screens }, chosen.map((p) => p.id));
  }

  /* ── Descubre ── */
  {
    const rest = pool.filter(free);
    const allCats = [...new Set(pool.map((p) => catOf(p)?.name).filter((x): x is string => Boolean(x)))];
    if (rest.length < 2) skip('descubre', 'Descubre', 'No quedan productos presentables distintos de los de las demás historias.');
    else {
      const screens: StoryScreen[] = [];
      const hero = [...rest].sort((a, b) => Number(b.price) - Number(a.price))[0];
      take(hero);
      screens.push(screen('descubre', 1, hero, {
        title: 'Descubre Treidilor',
        text: `${pool.length} productos de ${allCats.length} categorías, con el precio y la fecha en que se capturó cada dato.`,
        buttonLabel: 'Ver catálogo',
        link: { type: 'campaign', target: '/catalogo' },
      }));
      const cheapest = rest.find(free);
      if (cheapest) {
        take(cheapest);
        screens.push(screen('descubre', 2, cheapest, {
          title: cut(cheapest.title, 72),
          text: `El más económico del catálogo a ${date}: ${eur(Number(cheapest.price))}${where(cheapest)}.`,
          buttonLabel: 'Ver producto',
          link: { type: 'product', target: cheapest.id },
        }));
      }
      const third = rest.find(free);
      if (third && allCats.length) {
        take(third);
        screens.push(screen('descubre', screens.length + 1, third, {
          title: 'Explora por categorías',
          text: `${list(allCats)}: elige una y compara sus productos.`,
          buttonLabel: 'Ver categorías',
          link: { type: 'campaign', target: '/categorias' },
        }));
      }
      const deal = pool.map((p) => ({ p, d: shownDiscount(p) })).filter((x) => x.d !== null && free(x.p)).sort((a, b) => b.d!.pct - a.d!.pct)[0];
      if (deal && screens.length < 4) {
        take(deal.p);
        screens.push(screen('descubre', screens.length + 1, deal.p, {
          title: cut(deal.p.title, 72),
          text: `−${deal.d!.pct} % verificado: ${eur(Number(deal.p.price))} (antes ${eur(deal.d!.previousPrice)})${where(deal.p)}`,
          buttonLabel: 'Ver producto',
          link: { type: 'product', target: deal.p.id },
        }));
      }
      done({ id: 'descubre', name: 'Descubre', status: 'borrador', screens }, screens.map((s) => s.link?.type === 'product' ? s.link.target : '').filter(Boolean));
    }
  }

  // Orden pedido: Informática, Portabilidad, Sonido, Hogar, Bajadas de precio, Descubre.
  const order = [...CATEGORY_STORIES, 'bajadas', 'descubre'];
  const stories = order.map((id) => built.get(id)?.story).filter((s): s is Story => Boolean(s));
  const v = validateStories(stories);
  return { stories: v.ok ? v.value : [], report: order.map((id) => report.get(id)).filter((r): r is StoryReportRow => Boolean(r)).map((r) => (v.ok ? r : { ...r, status: 'omitida' as const, reason: `No válida: ${(v as { errors: string[] }).errors[0]}` })) };
}
