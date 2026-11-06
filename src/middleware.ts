/**
 * TREIDILOR — Middleware global de Astro.
 *
 * Intercepta las fichas de producto (/producto/<id> y /productos/<id>) y
 * registra la visita en la analítica REAL de segundo plano. El registro es
 * O(1) en memoria (sin E/S en el request): la persistencia la hace
 * src/lib/analytics.ts con debounce, por lo que el renderizado y la
 * respuesta del servidor no se bloquean.
 */
import type { MiddlewareHandler } from 'astro';
import { clientIpFrom, getAnalyticsEvents, trackProductVisit } from './lib/analytics';
import { getSessionUser } from './lib/adminAuth';
import { findCatalogProduct, getCatalogProducts } from './lib/catalog';
import { recordPricePoint } from './lib/priceHistory';
import { startReminderScheduler } from './lib/reminders';
import { getAllRadarUsers, getRadarSessionUser, recordRadarUserVisit, SESSION_COOKIE_NAME } from './lib/radarAuth';
import { startMarketingScheduler } from './lib/marketingEmail';
import { startPriceAlertScheduler } from './lib/priceAlerts';
import { startOfferRefreshScheduler } from './lib/offerRefresh';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

// Los avisos diferidos de Mi Radar se envían desde el propio proceso SSR
// (setInterval + unref): no hay cron externo. Se arranca una sola vez aquí.
startReminderScheduler();
// Scheduler de Marketing: avisos de carrito abandonado (cada 24 h) y
// felicitaciones de cumpleaños (una vez al año por usuario).
startMarketingScheduler();
// Alertas de bajada de precio de Mi Radar (comparación cada 6 h contra el
// catálogo interno y la caché de AliExpress; email + badge en el panel).
startPriceAlertScheduler();
// Actualización programada de ofertas (precio, stock, envío): APAGADA por
// defecto. Sólo actúa con OFFER_REFRESH_ENABLED=true; su activación en
// producción requiere autorización aparte (consume créditos de ScraperAPI).
startOfferRefreshScheduler();

/**
 * Precalienta en el arranque las cachés en memoria más caras (catálogo,
 * eventos de analítica, usuarios de Mi Radar): sin esto, cada redeploy las
 * deja frías y la PRIMERA petición que las necesita (muy a menudo el panel
 * de Tráfico y Ventas, que llama a getCatalogProducts() una vez por mes del
 * histórico) paga de golpe el coste de releer y validar con Zod todo
 * products.json — bloqueando el event loop varios segundos y dando la
 * sensación de que esa página "tarda mucho" o "no carga el contenido".
 * Nunca debe poder tumbar el arranque del servidor: todo va en try/catch.
 */
try {
  getCatalogProducts();
  getAnalyticsEvents();
  getAllRadarUsers();
} catch (error) {
  console.warn('[Middleware] No se pudieron precalentar las cachés de arranque:', error);
}

const gzipAsync = promisify(gzip);

/**
 * Comprime el HTML y el JSON con gzip cuando el cliente lo admite. El servidor Node no
 * comprime y el proxy de producción tampoco lo hace con las respuestas
 * dinámicas (sin cabecera content-encoding): el panel enviaba ~1,06 MB y baja
 * a ~160 KB. Seguro por construcción: sólo GET 200 text/html sin codificar, y
 * se omite si la petición tiene cookies pendientes de adjuntar (se conservarían
 * sólo al devolver la respuesta original).
 */
async function maybeCompress(context: Parameters<MiddlewareHandler>[0], response: Response): Promise<Response> {
  try {
    if (context.request.method !== 'GET' || response.status !== 200 || !response.body) return response;
    if (response.headers.get('content-encoding')) return response;
    const type = String(response.headers.get('content-type') ?? '').toLowerCase();
    if (!type.startsWith('text/html') && !type.startsWith('application/json')) return response;
    if (!/gzip/i.test(context.request.headers.get('accept-encoding') ?? '')) return response;
    // Cookies pendientes de adjuntar: no tocar la respuesta.
    if ([...context.cookies.headers()].length > 0) return response;

    const raw = Buffer.from(await response.arrayBuffer());
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.append('vary', 'Accept-Encoding');
    if (raw.length < 1024) return new Response(raw, { status: response.status, statusText: response.statusText, headers });
    const body = await gzipAsync(raw, { level: 5 });
    headers.set('content-encoding', 'gzip');
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    console.warn('[Middleware] Compresión descartada:', error);
    return response;
  }
}

/** /producto/<slug> o /productos/<slug>, con o sin barra final. */
const PRODUCT_PATH = /^\/(productos?)\/([^/]+?)\/?$/i;

export const onRequest: MiddlewareHandler = async (context, next) => {
  // Rutas /upayp1b4/<...>: sesión de backend obligatoria. La raíz /upayp1b4
  // queda fuera para que el formulario de acceso siga funcionando (el login
  // POST y el GET con el formulario se resuelven en la propia página).
  if (context.url.pathname.startsWith('/upayp1b4/') && !getSessionUser(context.request)) {
    return context.redirect('/upayp1b4');
  }

  const startedAt = performance.now();
  const response = await next();
  try {
    // Visible en DevTools > Red > Tiempos: separa el coste del servidor del de la red.
    response.headers.set('Server-Timing', `app;dur=${(performance.now() - startedAt).toFixed(1)}`);
  } catch {
    /* cabeceras inmutables: se omite */
  }

  try {
    if (context.request.method === 'GET' && response.status === 200) {
      const match = PRODUCT_PATH.exec(context.url.pathname);
      if (match) {
        const slug = decodeURIComponent(match[2]);
        // Sólo fichas reales del catálogo; nunca lanza ni bloquea.
        const product = findCatalogProduct(slug);
        if (product) {
          // La IP sólo se usa para descartar el ordenador de desarrollo.
          trackProductVisit(slug, context.url.pathname, clientIpFrom(context.request));
          // 1 punto de histórico de precio por día (cola con debounce).
          recordPricePoint(product.id, product.price);
          // Comportamiento por usuario de Mi Radar (última categoría, vistos).
          // Sólo si hay cookie de sesión de radar; el throttle por usuario vive
          // dentro de recordRadarUserVisit para no saturar radar-users.json.
          if (context.request.headers.get('cookie')?.includes(SESSION_COOKIE_NAME)) {
            const radarUser = getRadarSessionUser(context.request);
            if (radarUser) {
              recordRadarUserVisit(radarUser.id, {
                id: product.id,
                title: product.title,
                category: product.category,
              });
            }
          }
        }
      }
    }
  } catch (error) {
    console.warn('[Middleware] Analítica de visita descartada:', error);
  }

  return maybeCompress(context, response);
};
