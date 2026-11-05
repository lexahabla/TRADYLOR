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
