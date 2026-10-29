import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ url }) => {
    // Tomamos el ASIN de la URL o usamos el de prueba por defecto
    const asin = url.searchParams.get('asin') || 'B01EXDG2MO';
    const apiKey = import.meta.env.SCRAPER_API_KEY || process.env.SCRAPER_API_KEY;
    const countryCode = process.env.SCRAPER_API_COUNTRY_CODE?.trim() || 'es';

    if (!apiKey) {
        return new Response(
            JSON.stringify({ error: 'La variable SCRAPER_API_KEY no está configurada' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const targetUrl = `https://api.scraperapi.com/structured/amazon/product/v1?api_key=${apiKey}&asin=${asin}&country_code=${encodeURIComponent(countryCode)}`;

    try {
        const response = await fetch(targetUrl);
        const data = await response.json();

        return new Response(JSON.stringify(data, null, 2), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error: any) {
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};