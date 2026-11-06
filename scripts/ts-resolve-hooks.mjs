/**
 * Hooks de resolución para las pruebas: permite importar módulos `.ts` del
 * proyecto con especificadores sin extensión (como hace Vite/Astro) usando el
 * "type stripping" nativo de Node. No añade dependencias.
 */
export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (relative) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return await nextResolve(specifier + suffix, context);
        } catch {
          /* probar la siguiente */
        }
      }
      throw error;
    }
  }
  return nextResolve(specifier, context);
}

/**
 * `import.meta.env` no existe fuera de Vite/Astro: sin esto, cualquier módulo de
 * `src/` que lo lea (p. ej. `lib/ai.ts`, `lib/apiAuth.ts`) falla al importarse o
 * ejecutarse en las pruebas. Se sustituye por un objeto vacío (las pruebas fijan
 * las variables que necesiten en `process.env`, como en producción).
 */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.includes('/src/') && url.endsWith('.ts') && result.source) {
    const text = result.source.toString();
    if (text.includes('import.meta.env')) {
      return { ...result, source: text.replace(/import\.meta\.env/g, '(globalThis.__IMPORT_META_ENV__ ??= {})') };
    }
  }
  return result;
}
