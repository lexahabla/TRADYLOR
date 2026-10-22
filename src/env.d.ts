/// <reference path="../.astro/types.d.ts" />

/**
 * Tipos globales del navegador.
 *
 * `window.__smartMatcherProducts` lo rellena el `<script is:inline>` de
 * src/components/SmartMatcherWizard.astro. Ese script NO lo procesa Vite
 * (por eso no puede contener `declare global`: rompería la sintaxis en el
 * navegador), así que la declaración de tipos vive aquí.
 */
declare global {
  interface Window {
    __smartMatcherProducts: unknown[];
  }
}

export {};
