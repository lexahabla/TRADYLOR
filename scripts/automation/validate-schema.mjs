// Validador MÍNIMO de JSON Schema (subconjunto: type, enum, required, properties, additionalProperties:false, items, minItems, minimum,
// maximum, minLength, pattern; `type` admite una lista). Sin dependencias. Devuelve una lista de errores (vacía = válido).
export function validarEsquema(valor, esquema, ruta = '$') {
  const err = [];
  const tipo = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (esquema.enum && !esquema.enum.some((e) => e === valor)) err.push(`${ruta}: valor no permitido (${JSON.stringify(valor)})`);
  if (esquema.type) {
    const t = tipo(valor);
    const admitidos = Array.isArray(esquema.type) ? esquema.type : [esquema.type];
    const ok = admitidos.some((a) => a === t || (a === 'number' && (t === 'integer' || t === 'number')));
    if (!ok) { err.push(`${ruta}: se esperaba ${admitidos.join(' o ')} y hay ${t}`); return err; }
  }
  if (typeof valor === 'number') {
    if (esquema.minimum !== undefined && valor < esquema.minimum) err.push(`${ruta}: menor que ${esquema.minimum}`);
    if (esquema.maximum !== undefined && valor > esquema.maximum) err.push(`${ruta}: mayor que ${esquema.maximum}`);
  }
  if (typeof valor === 'string') {
    if (esquema.minLength !== undefined && valor.length < esquema.minLength) err.push(`${ruta}: demasiado corto`);
    if (esquema.pattern && !new RegExp(esquema.pattern).test(valor)) err.push(`${ruta}: no cumple el patrón`);
  }
  if (Array.isArray(valor)) {
    if (esquema.minItems !== undefined && valor.length < esquema.minItems) err.push(`${ruta}: necesita al menos ${esquema.minItems} elementos`);
    if (esquema.items) valor.forEach((v, i) => err.push(...validarEsquema(v, esquema.items, `${ruta}[${i}]`)));
  }
  if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
    for (const r of esquema.required ?? []) if (!(r in valor)) err.push(`${ruta}.${r}: obligatorio`);
    const props = esquema.properties ?? {};
    if (esquema.additionalProperties === false) for (const k of Object.keys(valor)) if (!(k in props)) err.push(`${ruta}.${k}: campo no admitido`);
    for (const [k, s] of Object.entries(props)) if (k in valor) err.push(...validarEsquema(valor[k], s, `${ruta}.${k}`));
  }
  return err;
}
