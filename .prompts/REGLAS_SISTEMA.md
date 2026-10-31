# Reglas de Desarrollo y Arquitectura - Tradylor

## Stack Tecnológico
- **Framework:** Astro (componentes `.astro`)
- **Estilos:** Tailwind CSS
- **Lenguaje:** TypeScript (modo estricto)

## Reglas de Código
1. **Componentes:** Mantén los componentes pequeños, modulares y reutilizables.
2. **Lógica de datos:** Toda la extracción e importación de datos se realiza en el frontmatter (`---`) del componente Astro.
3. **Estilos:** Usa exclusivamente clases de Tailwind CSS. No crees estilos CSS globales ni bloques `<style>` locales a menos que sea estrictamente necesario.
4. **TypeScript:** Define interfaces explícitas para las `Props` de cada componente.
5. **Rendimiento:** Evita cargar librerías cliente JS si el componente puede renderizarse 100% en el servidor (SSG/SSR).