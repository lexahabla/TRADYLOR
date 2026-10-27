/** @type {import('tailwindcss').Config} */
export default {
  // El resto del sitio usa un sistema de diseño propio (CSS con variables + tema
  // oscuro) con algunas clases Tailwind "dormidas" en el markup público.
  // El escaneo se restringe al módulo Tráfico y ventas para generar SÓLO las
  // utilidades que usa y no activar por accidente esas clases en otras páginas.
  content: [
    // La ruta del módulo es /upayp1b4/trafico-ventas (el panel admin vive en
    // /upayp1b4, no en /admin: con la ruta vieja Tailwind no generaba NINGUNA
    // utilidad usada directamente en estas páginas — el Glosario, que es casi
    // 100% clases Tailwind, se veía sin estilo alguno).
    './src/pages/upayp1b4/trafico-ventas/**/*.astro',
    './src/components/admin/**/*.astro',
    // Mi Radar (panel del usuario final): se usa Tailwind para layout básico.
    './src/pages/mi-radar.astro',
  ],
  safelist: [
    'hidden',
    'md:inline',
    'md:flex',
    'rounded-full',
    'items-start',
    'justify-start',
  ],
  theme: {
    extend: {
      colors: {
        surface: '#F8F9FA',
      },
    },
  },
  // Se desactiva el reset global de Tailwind para no romper estilos existentes;
  // sólo se consumen las utilidades (layout, espaciado, tipografía, colores...).
  corePlugins: {
    preflight: false,
  },
  plugins: [],
};
