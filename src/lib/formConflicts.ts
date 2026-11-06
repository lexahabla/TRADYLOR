/**
 * ==============================================================================
 * TREIDILOR — EDICIÓN DE FORMULARIO: CAMPOS EDITADOS vs REENVIADOS (conflictos)
 * ==============================================================================
 * Un formulario abierto antes de que otro proceso cambie la ficha (p. ej. una
 * actualización de precio) reenvía TODOS sus campos al guardar: con la lógica
 * antigua los campos que el usuario no tocó pisaban los cambios concurrentes.
 *
 * El cliente indica qué campos EDITÓ (`editedFields`) y qué valor tenían al abrir
 * el formulario (`baseline`, sólo de los editados). Al guardar, sobre la ficha
 * ACTUAL del disco:
 *   · campo NO editado (sólo reenviado) → se conserva el valor ACTUAL;
 *   · campo editado y nadie más lo cambió (actual == baseline) o ya vale lo mismo
 *     (actual == enviado) → se aplica lo enviado;
 *   · campo editado y OTRO proceso también lo cambió a un valor distinto →
 *     CONFLICTO: se conserva el valor actual (no se sobrescribe en silencio) y se
 *     informa para que el usuario decida.
 * Sin `editedFields` (clientes antiguos, API) rige el comportamiento anterior.
 * ==============================================================================
 */

/** Campos del formulario de la ficha que se pueden comparar (mismos nombres que en `Product`). */
export const FORM_EDIT_FIELDS = [
  'title', 'description', 'price', 'originalPrice', 'category', 'merchant', 'affiliateUrl', 'buyNowUrl', 'image', 'badge',
  'verdict', 'techSheet', 'pros', 'cons', 'shippingInfo', 'shippingDays', 'brand', 'fulfillmentProvider', 'condition',
  'rating', 'reviewsCount',
] as const;

export interface FormConflict {
  field: string;
  /** Valor que el usuario quería guardar. */
  yours: unknown;
  /** Valor actual (cambiado por otro proceso) que se ha conservado. */
  current: unknown;
  /** Valor que tenía al abrir el formulario. */
  baseline: unknown;
}

const norm = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return JSON.stringify(value.map((v) => String(v).trim()));
  if (typeof value === 'number') return String(value);
  const text = String(value).trim();
  // «31», «31.0» y 31 son el mismo precio
  return /^-?\d+(\.\d+)?$/.test(text) ? String(Number(text)) : text;
};
export const sameFormValue = (a: unknown, b: unknown): boolean => norm(a) === norm(b);

export function resolveFormEdit<T extends object>(args: {
  editedFields: unknown;
  baseline: unknown;
  submitted: T;
  current: object | undefined;
}): { values: T; conflicts: FormConflict[] } {
  const { editedFields, submitted, current } = args;
  if (!Array.isArray(editedFields) || !current) return { values: submitted, conflicts: [] };
  const edited = new Set(editedFields.map(String));
  const baseline = (args.baseline && typeof args.baseline === 'object' ? args.baseline : {}) as Record<string, unknown>;
  const cur = current as Record<string, unknown>;
  const values = { ...(submitted as Record<string, unknown>) };
  const conflicts: FormConflict[] = [];

  for (const field of FORM_EDIT_FIELDS) {
    const currentValue = cur[field];
    if (!edited.has(field)) {
      // Sólo reenviado: manda lo que haya ahora en el catálogo.
      if (currentValue === undefined) delete values[field];
      else values[field] = currentValue;
      continue;
    }
    const hasBaseline = Object.prototype.hasOwnProperty.call(baseline, field);
    const changedByOthers = hasBaseline && !sameFormValue(currentValue, baseline[field]);
    if (changedByOthers && !sameFormValue(currentValue, values[field])) {
      conflicts.push({ field, yours: values[field], current: currentValue, baseline: baseline[field] });
      if (currentValue === undefined) delete values[field];
      else values[field] = currentValue;
    }
  }
  return { values: values as T, conflicts };
}

/** Texto de aviso para el usuario. */
export function conflictsMessage(conflicts: FormConflict[]): string {
  const list = conflicts.map((c) => `«${c.field}» (tú: ${String(c.yours ?? '—')}, actual: ${String(c.current ?? '—')})`).join('; ');
  return `Guardado, pero NO se sobrescribió ${conflicts.length === 1 ? 'un campo' : conflicts.length + ' campos'} que otro proceso había cambiado mientras tenías el formulario abierto: ${list}. Revisa el valor actual y vuelve a editarlo si quieres cambiarlo.`;
}
