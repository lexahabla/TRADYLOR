/**
 * ==============================================================================
 * TRADYLOR — HISTÓRICO DE PRECIO (captura progresiva)
 * ==============================================================================
 * Cada visita a una ficha de producto deja 1 punto por día en
 * `priceHistory` de products.json: { date: 'YYYY-MM-DD', price }.
 *
 * - La escritura NO es síncrona en el request: la cola se persiste con un
 *   debounce de 3 s y de forma atómica (tmp + rename), igual que analytics.ts.
 * - Sólo se tocan productos que ya existen en products.json (los curados
 *   estáticos no tienen entrada en el fichero y no se crean aquí).
 * ==============================================================================
 */

import fsp from 'node:fs/promises';
import { readProductsFromFile, DATA_FILE_PATH, type Product } from './productStore';

export interface PricePoint {
  date: string;
  price: number;
}

/** Máximo de puntos conservados por producto (más de medio año a 1/día). */
const MAX_POINTS = 200;
const FLUSH_DELAY_MS = 3_000;

let queue = new Map<string, PricePoint>();
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** Punto del día para el producto (si hoy no hay, se añade al final). */
function mergePoint(history: PricePoint[] | undefined, point: PricePoint): PricePoint[] {
  const clean = Array.isArray(history)
    ? history.filter((p) => p && typeof p.date === 'string' && Number.isFinite(p.price))
    : [];
  const last = clean[clean.length - 1];
  if (last && last.date === point.date) {
    clean[clean.length - 1] = point;
    return clean.slice(-MAX_POINTS);
  }
  clean.push(point);
  return clean.slice(-MAX_POINTS);
}

function scheduleFlush(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushPriceHistory();
  }, FLUSH_DELAY_MS);
  timer.unref?.();
}

/**
 * Registra el precio actual del producto en el histórico del día.
 * Devuelve false si el producto no existe en products.json.
 */
export function recordPricePoint(productId: string, price: number): boolean {
  if (!productId || !Number.isFinite(price) || price <= 0) return false;
  const exists = readProductsFromFile().some((p) => p.id === productId);
  if (!exists) return false;

  queue.set(productId, { date: todayIso(), price: Math.round(price * 100) / 100 });
  scheduleFlush();
  return true;
}

/** Persiste la cola en products.json (exportado para tests / shutdown). */
export async function flushPriceHistory(): Promise<void> {
  if (queue.size === 0 || flushing) return;
  flushing = true;
  const pending = queue;
  queue = new Map();
  try {
    const products = readProductsFromFile();
    let changed = false;

    for (const [productId, point] of pending) {
      const index = products.findIndex((p) => p.id === productId);
      if (index < 0) continue;
      const product: Product = products[index];
      const next = mergePoint(product.priceHistory, point);
      if (JSON.stringify(next) !== JSON.stringify(product.priceHistory ?? [])) {
        products[index] = { ...product, priceHistory: next };
        changed = true;
      }
    }

    if (!changed) return;

    // Escritura atómica: tmp + rename (nunca un products.json a medias).
    const snapshot = JSON.stringify(products, null, 2);
    const tmpPath = `${DATA_FILE_PATH}.tmp`;
    await fsp.writeFile(tmpPath, snapshot, 'utf-8');
    await fsp.rename(tmpPath, DATA_FILE_PATH);
  } catch (error) {
    console.warn('[PriceHistory] No se pudo persistir el histórico:', error);
    // Devuelve los puntos a la cola para reintentar en el próximo flush.
    for (const [id, point] of pending) {
      if (!queue.has(id)) queue.set(id, point);
    }
  } finally {
    flushing = false;
    if (queue.size > 0) scheduleFlush();
  }
}
