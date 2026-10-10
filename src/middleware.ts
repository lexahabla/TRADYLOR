/**
 * TRADYLOR — Middleware global de Astro.
 *
 * Intercepta las fichas de producto (/producto/<id> y /productos/<id>) y
 * registra la visita en la analítica REAL de segundo plano. El registro es
 * O(1) en memoria (sin E/S en el request): la persistencia la hace
 * src/lib/analytics.ts con debounce, por lo que el renderizado y la
 * respuesta del servidor no se bloquean.
 */
import type { MiddlewareHandler } from 'astro';
import { trackProductVisit } from './lib/analytics';
import { findCatalogProduct } from './lib/catalog';

/** /producto/<slug> o /productos/<slug>, con o sin barra final. */
const PRODUCT_PATH = /^\/(productos?)\/([^/]+?)\/?$/i;

export const onRequest: MiddlewareHandler = async (context, next) => {
  const response = await next();

  try {
    if (context.request.method === 'GET' && response.status === 200) {
      const match = PRODUCT_PATH.exec(context.url.pathname);
      if (match) {
        const slug = decodeURIComponent(match[2]);
        // Sólo fichas reales del catálogo; nunca lanza ni bloquea.
        if (findCatalogProduct(slug)) {
          trackProductVisit(slug, context.url.pathname);
        }
      }
    }
  } catch (error) {
    console.warn('[Middleware] Analítica de visita descartada:', error);
  }

  return response;
};
