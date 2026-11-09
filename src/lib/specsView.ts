/**
 * ==============================================================================
 * TREIDILOR — FICHA TÉCNICA DESPLEGABLE (vista pura)
 * ==============================================================================
 * Muestra de inicio, como máximo, SEIS características principales elegidas según la categoría del producto; el resto queda tras el control
 * «Ver todas las características». No elimina ni modifica ningún dato: sólo ordena la presentación de `product.specs`.
 *
 * Familia de producto (por el título, mismo criterio que el comparador de modelos): ordenador, auriculares, móvil, televisor, etc. Cada familia
 * tiene una lista ORDENADA de conceptos relevantes; se toman los que el producto declara (por la etiqueta de la especificación) hasta completar
 * seis; si faltan, se rellenan con las siguientes en su orden original.
 * ==============================================================================
 */

import { functionFamilyOf } from './modelComparison';

export const FEATURED_MAX = 6;
/** El desplegable sólo existe con 12 o más características (se ven 6 = la mitad de 12); con menos se muestran todas, sin control. */
export const COLLAPSE_MIN = 12;

export interface SpecEntry { label: string; value: string }
export interface SpecsView { featured: SpecEntry[]; rest: SpecEntry[]; family: string | null }

const fold = (t: unknown) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Conceptos por familia, en orden de relevancia. Cada regex se prueba contra la ETIQUETA de la especificación (sin tildes). */
const COMPUTER = [/procesador|cpu/, /^ram$|memoria ram|ram instalada|memoria$/, /almacenamiento|disco|ssd/, /pantalla|screen/, /gpu|grafic/, /resoluc/, /bater/, /sistema operativo|^so$/];
const PRIORITY: Record<string, RegExp[]> = {
  portatil: COMPUTER,
  tablet: [/pantalla|screen/, /procesador|cpu/, /^ram$|memoria ram|memoria$/, /almacenamiento|storage/, /bater/, /camara/, /sistema operativo/, /conectiv/],
  movil: [/pantalla|screen/, /procesador|cpu/, /^ram$|memoria ram|memoria$/, /almacenamiento|storage/, /camara/, /bater/, /sistema operativo/, /conectiv/],
  auriculares: [/autonom|duracion|horas/, /conectiv|bluetooth/, /bater/, /microfono|mic/, /^tipo$|tipo de|formato|diseno/, /cancelacion|anc|ruido/, /resistencia|impermeab|ipx/, /peso/],
  altavoz: [/potencia|power|^w$/, /autonom|duracion|horas/, /conectiv|bluetooth/, /bater/, /resistencia|impermeab|ipx/, /^tipo$|formato/, /peso/],
  reloj: [/pantalla/, /autonom|bater/, /conectiv|bluetooth/, /resistencia|impermeab|agua/, /sensor|salud|gps/, /compatib/, /peso/],
  monitor: [/pantalla|tamano|pulgadas/, /resoluc/, /frecuencia|hz|refresco/, /panel|tipo/, /tiempo de respuesta/, /conectiv|puertos|hdmi/],
  televisor: [/pantalla|tamano|pulgadas/, /resoluc/, /frecuencia|hz|refresco/, /panel|tipo/, /smart|sistema operativo/, /conectiv|puertos|hdmi/],
  almacenamiento: [/capacidad|almacenamiento/, /interfaz|conexion|usb/, /velocidad|lectura|escritura/, /tipo|formato/, /peso/],
  camara: [/resoluc|megapixel|mp/, /video|grabacion/, /bater|autonom/, /pantalla/, /conectiv|wifi/, /resistencia|agua/],
  raton: [/sensor|dpi/, /conectiv|inalambric/, /bater|autonom/, /botones/, /peso/],
  teclado: [/conectiv|inalambric/, /tipo|switch|mecanic/, /distribucion|idioma|layout/, /bater|autonom/, /retroiluminacion/],
};

/** Ordena la ficha técnica: seis principales por categoría + el resto. Las entradas sin valor se omiten; ninguna se elimina del catálogo. */
export function buildSpecsView(product: { title?: string; specs?: Record<string, unknown> | null }, max = FEATURED_MAX): SpecsView {
  const entries: SpecEntry[] = Object.entries(product.specs ?? {})
    .map(([label, value]) => ({ label: String(label), value: String(value ?? '').trim() }))
    .filter((e) => e.label.trim() && e.value);
  const family = functionFamilyOf({ title: product.title });
  const wanted = (family && PRIORITY[family]) || [];
  const featured: SpecEntry[] = [];
  const used = new Set<number>();
  for (const re of wanted) {
    if (featured.length >= max) break;
    const i = entries.findIndex((e, idx) => !used.has(idx) && re.test(fold(e.label)));
    if (i >= 0) { used.add(i); featured.push(entries[i]); }
  }
  // Relleno hasta seis: primero lo que más informa; color, marca y garantía quedan para el desplegable.
  const LOW = /^(color|colour|marca|brand|garantia|modelo|nombre)/;
  for (const pass of [false, true]) {
    for (let i = 0; i < entries.length && featured.length < max; i++) {
      if (!used.has(i) && LOW.test(fold(entries[i].label)) === pass) { used.add(i); featured.push(entries[i]); }
    }
  }
  const rest = entries.filter((_, i) => !used.has(i));
  // Pocas características: todas visibles y sin desplegable.
  if (entries.length < COLLAPSE_MIN) return { featured: [...featured, ...rest], rest: [], family };
  return { featured, rest, family };
}
