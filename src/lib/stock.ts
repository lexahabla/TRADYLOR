/**
 * ==============================================================================
 * TREIDILOR — DISPONIBILIDAD (STOCK) DE UN PRODUCTO (vista pura)
 * ==============================================================================
 * Dato imprescindible que se muestra de antemano en la tarjeta, la ficha, el checkout y el comparador de modelos. Sólo se afirma lo que declara la
 * fuente: `inStock === true` → «En stock»; `inStock === false` → «Agotado»; sin dato → «Stock no indicado» (nunca se supone que hay stock).
 * El dato es el de la última captura de la tienda y puede haber cambiado: se acompaña de su fecha cuando existe.
 *
 * Con «Agotado» se ofrece el aviso de vuelta a stock, que se guarda en Mi Radar (`notifyStock`) y lo vigila el worker existente.
 * ==============================================================================
 */

import { captureDateOf, formatDateEs } from './commercialClaims';

export type StockState = 'in_stock' | 'low_stock' | 'out_of_stock' | 'unknown';

export interface StockInfo {
  state: StockState;
  /** Texto visible. */
  label: string;
  /** Fecha (ISO) de la captura que respalda el dato, si consta. */
  asOf: string | null;
  /** Texto de ayuda (title/aria) con la fecha cuando existe. */
  hint: string;
  /** true si procede ofrecer el aviso de vuelta a stock (sólo si la fuente declara que está agotado). */
  canNotify: boolean;
}

export const STOCK_LABELS: Record<StockState, string> = {
  in_stock: 'En stock',
  low_stock: 'Pocas unidades',
  out_of_stock: 'Agotado',
  unknown: 'Stock no indicado',
};

export function stockOf(product: Record<string, any> | null | undefined): StockInfo {
  const p = product ?? {};
  const low = p.pricing?.stockStatus === 'Pocas unidades' && p.inStock !== false;
  const state: StockState = p.inStock === false ? 'out_of_stock' : low ? 'low_stock' : p.inStock === true ? 'in_stock' : 'unknown';
  const asOf = captureDateOf(p) ?? null;
  const when = asOf ? ` Dato de la tienda a fecha de captura (${formatDateEs(asOf)}); puede haber cambiado.` : ' Dato de la tienda; puede haber cambiado.';
  const hint = state === 'unknown' ? 'La tienda no ha indicado la disponibilidad de este producto.' : `${STOCK_LABELS[state]}.${when}`;
  return { state, label: STOCK_LABELS[state], asOf, hint, canNotify: state === 'out_of_stock' };
}
