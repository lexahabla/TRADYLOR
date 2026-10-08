import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
  site: 'https://tradylor.com',
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  integrations: [
    // Utilidades Tailwind disponibles en todos los componentes.
    // preflight desactivado en tailwind.config.mjs (no altera el CSS propio del sitio).
    tailwind({ applyBaseStyles: true }),
  ],
});

