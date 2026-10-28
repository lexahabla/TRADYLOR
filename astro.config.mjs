import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  site: 'https://tradylor.com',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  server: {
    host: true,
    port: 4321,
  },
});

