import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://tradylor.com',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [tailwindcss()],
  server: {
    host: true,
    port: 4321,
  },
});

