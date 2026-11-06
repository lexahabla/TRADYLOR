import type { APIRoute } from 'astro';
import { requireAdminAuth } from '../../lib/adminAuth';
import { isValidApiToken, unauthorizedApiResponse } from '../../lib/apiAuth';
import { sanitizeAsin, isValidAsin } from '../../utils/amazon';

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
 */
export const GET: APIRoute = async ({ request, url }) => {
    if (requireAdminAuth(request) && !isValidApiToken(request)) return unauthorizedApiResponse();

    const asin = sanitizeAsin(url.searchParams.get('asin') || '');
    if (!isValidAsin(asin)) {
        return json({ error: 'ASIN no válido: debe tener 10 letras o números (ej. B01EXDG2MO).' }, 400);
    }

    const apiKey = import.meta.env.SCRAPER_API_KEY || process.env.SCRAPER_API_KEY;
    const countryCode = process.env.SCRAPER_API_COUNTRY_CODE?.trim() || 'es';

    if (!apiKey) {
        return json({ error: 'La variable SCRAPER_API_KEY no está configurada' }, 500);
    }

    const targetUrl = `https://api.scraperapi.com/structured/amazon/product/v1?api_key=${encodeURIComponent(apiKey)}&asin=${encodeURIComponent(asin)}&country_code=${encodeURIComponent(countryCode)}`;

    try {
        const response = await fetch(targetUrl);
        const data = await response.json().catch(() => ({ error: `ScraperAPI respondió con el estado ${response.status}` }));
        return json(data, response.ok ? 200 : response.status);
    } catch (error: any) {
        return json({ error: error.message }, 500);
    }
};
