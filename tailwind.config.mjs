/** @type {import('tailwindcss').Config} */
export default {
  // El resto del sitio usa un sistema de diseño propio (CSS con variables + tema
  // oscuro) con algunas clases Tailwind "dormidas" en el markup público.
  // El escaneo se restringe al módulo Tráfico y ventas para generar SÓLO las
  // utilidades que usa y no activar por accidente esas clases en otras páginas.
  content: [
    './src/pages/admin/trafico-ventas/**/*.astro',
    './src/components/admin/**/*.astro',
    // Mi Radar (panel del usuario final): se usa Tailwind para layout básico.
    './src/pages/mi-radar.astro',
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
