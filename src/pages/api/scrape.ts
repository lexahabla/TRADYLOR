import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../lib/adminAuth';
import { isValidApiToken, unauthorizedApiResponse } from '../../lib/apiAuth';
import { sanitizeAsin, isValidAsin } from '../../utils/amazon';
import { resolveAmazonMarket, marketQuery } from '../../lib/scraperMarket';

export const prerender = false;

const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body, null, 2), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

/**
 * GET /api/scrape?asin=B01EXDG2MO
 * Descarga el JSON estructurado de ScraperAPI para un ASIN (consume créditos).
 * Sólo sesión de admin o Bearer TRADYLOR_API_TOKEN, y el ASIN se valida antes
 * de llamar a ScraperAPI (antes era público y concatenaba el valor sin validar).
 *
 * El dominio de Amazon (`tld`) se envía siempre explícito (ver lib/scraperMarket.ts): sin él ScraperAPI lo deduce de
 * `country_code` y, con un país distinto de `es`, consulta amazon.com y devuelve el 404 «Page Not Found» de Amazon.
 * Los errores del proveedor se traducen a un mensaje claro (nunca se reenvía HTML ni la URL con la clave).
 */
export const GET: APIRoute = async ({ request, url }) => {
    if (requireAdminAuth(request) && !isValidApiToken(request)) return unauthorizedApiResponse();

    const asin = sanitizeAsin(url.searchParams.get('asin') || '');
    if (!isValidAsin(asin)) {
        return json({ error: 'ASIN no válido: debe tener 10 letras o números (ej. B01EXDG2MO).' }, 400);
    }

    const apiKey = import.meta.env.SCRAPER_API_KEY || process.env.SCRAPER_API_KEY;
    if (!apiKey) {
        return json({ error: 'La variable SCRAPER_API_KEY no está configurada' }, 500);
    }

    const market = resolveAmazonMarket();
    const targetUrl = `https://api.scraperapi.com/structured/amazon/product/v1?api_key=${encodeURIComponent(apiKey)}&asin=${encodeURIComponent(asin)}&${marketQuery(market)}&retry_404=true`;

    try {
        const response = await fetch(targetUrl);
        const text = await response.text();
        let data: unknown = null;
        try { data = JSON.parse(text); } catch { /* el proveedor devolvió HTML u otro texto */ }

        if (response.ok && data && typeof data === 'object') return json(data, 200);

        const meta = { providerStatus: response.status, domain: `amazon.${market.tld}`, countryCode: market.countryCode };
        if (response.status === 404) {
            return json({ error: `Amazon no encontró el ASIN ${asin} en amazon.${market.tld} (ScraperAPI devolvió 404). Comprueba que el producto exista en esa tienda.`, ...meta }, 404);
        }
        if (response.status === 401 || response.status === 403) {
            return json({ error: 'ScraperAPI rechazó la clave (revisa SCRAPER_API_KEY y el plan de la cuenta).', ...meta }, 502);
        }
        if (response.status === 429) {
            return json({ error: 'ScraperAPI: límite de peticiones o créditos agotado.', ...meta }, 429);
        }
        if (response.ok) {
            return json({ error: 'ScraperAPI devolvió una respuesta que no es JSON (posible página de bloqueo de Amazon).', ...meta }, 502);
        }
        return json({ error: `ScraperAPI respondió con el estado ${response.status}.`, ...meta }, response.status >= 500 ? 502 : response.status);
    } catch (error: any) {
        return json({ error: 'No se pudo contactar con ScraperAPI: ' + String(error?.message || error).replace(/api_key=[^&s"]+/g, 'api_key=***') }, 502);
    }
};
