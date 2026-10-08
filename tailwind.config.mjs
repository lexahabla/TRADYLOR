/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx,md,mdx}'],
  theme: {
    extend: {
      colors: {
        surface: '#F8F9FA',
      },
    },
  },
  // El sitio usa un sistema de diseño propio (CSS con variables + tema oscuro).
  // Se desactiva el reset global de Tailwind para no romper estilos existentes;
  // sólo se consumen las utilidades (layout, object-fit, espaciado, etc.).
  corePlugins: {
    preflight: false,
  },
  plugins: [],
};
