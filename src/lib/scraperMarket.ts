/**
 * Tienda de Amazon que consulta ScraperAPI (endpoint estructurado de producto).
 *
 * CAUSA RAÍZ del 404 «ScraperAPI respondió con el estado 404» (verificado con llamadas reales controladas):
 * el endpoint estructurado decide el dominio de Amazon a partir de `country_code` salvo que se indique `tld`.
 * Con un `country_code` que no sea `es` (p. ej. `us`, lo que ocurre si `SCRAPER_API_COUNTRY_CODE` está definida
 * con otro valor) consulta amazon.com y devuelve el 404 «Page Not Found» de Amazon para un ASIN que sí existe en
 * amazon.es. Por eso el dominio (`tld`) se envía SIEMPRE de forma explícita y `country_code` se alinea con él.
 *
 * Reglas:
 *  - `tld`: `SCRAPER_API_TLD` o, por defecto, `es` (Treidilor trabaja con Amazon España).
 *  - `country_code`: se alinea con el `tld` (geolocalización coherente con la tienda: el precio varía según el país
 *    del proxy). Si `SCRAPER_API_COUNTRY_CODE` no coincide con el país del `tld`, se ignora y se avisa una vez.
 *  - Un `countryCode` explícito por llamada (opción de `scrapeAmazonProduct`) manda: el `tld` se deduce de él salvo
 *    que `SCRAPER_API_TLD` esté definido.
 */
export interface AmazonMarket {
  /** Dominio de Amazon (`es`, `com`, `co.uk`…). */
  tld: string;
  /** País del proxy de ScraperAPI. */
  countryCode: string;
}

const COUNTRY_BY_TLD: Record<string, string> = {
  es: 'es', com: 'us', 'co.uk': 'uk', de: 'de', fr: 'fr', it: 'it', nl: 'nl', ca: 'ca', 'com.mx': 'mx', 'com.br': 'br', in: 'in', 'co.jp': 'jp', 'com.au': 'au',
};
const TLD_BY_COUNTRY: Record<string, string> = Object.fromEntries(Object.entries(COUNTRY_BY_TLD).map(([tld, country]) => [country, tld]));
TLD_BY_COUNTRY.gb = 'co.uk';

let warned = false;

export function resolveAmazonMarket(countryOverride?: string): AmazonMarket {
  const envTld = (process.env.SCRAPER_API_TLD ?? '').trim().toLowerCase().replace(/^\./, '');
  const envCountry = (process.env.SCRAPER_API_COUNTRY_CODE ?? '').trim().toLowerCase();
  const override = (countryOverride ?? '').trim().toLowerCase();

  const tld = envTld || (override ? TLD_BY_COUNTRY[override] ?? 'es' : 'es');
  const countryOfTld = COUNTRY_BY_TLD[tld];

  let countryCode: string;
  if (override) countryCode = override;
  else if (!countryOfTld) countryCode = envCountry || 'es'; // dominio poco común: se respeta el país configurado
  else {
    countryCode = countryOfTld;
    if (envCountry && envCountry !== countryOfTld && !warned) {
      warned = true;
      console.warn(`[Scraper] SCRAPER_API_COUNTRY_CODE="${envCountry}" no corresponde a amazon.${tld}: se usa "${countryOfTld}". Corrige la variable o define SCRAPER_API_TLD.`);
    }
  }
  return { tld, countryCode };
}

/** Parámetros de dominio/país para la query de ScraperAPI. */
export function marketQuery(market: AmazonMarket): string {
  return `country_code=${encodeURIComponent(market.countryCode)}&tld=${encodeURIComponent(market.tld)}`;
}
