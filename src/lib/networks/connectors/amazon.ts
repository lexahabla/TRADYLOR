/**
 * ==============================================================================
 * TRADYLOR - CONECTOR AMAZON ASSOCIATES (PA-API 5.0)
 * ==============================================================================
 * Documentación oficial: https://webservices.amazon.com/paapi5/documentation/
 *
 * SearchItems firmado con AWS SigV4 (region eu-west-1, marketplace
 * www.amazon.es). El Associate Tag se inyecta como PartnerTag del cuerpo y
 * como querystring AssociateTag. La respuesta se normaliza con
 * AmazonProductAdapter a CanonicalAffiliateProduct (imágenes variantes y
 * CustomerReviews). Si faltan credenciales o la llamada falla, search()
 * sigue devolviendo la muestra estimada de siempre (UI intacta).
 * ==============================================================================
 */

import { createHash, createHmac } from 'node:crypto';
import { ConnectorError, canonicalToUnified, fetchWithTimeout, sampleProducts, type NetworkConnector } from './base';
import { getCredentialValues, setNetworkStatus } from '../credentials';
import type { CanonicalAffiliateProduct, UnifiedProduct, UnifiedSearchParams } from '../types';
import {
  AMAZON_RESOURCES,
  AmazonProductAdapter,
  type AmazonItem,
  type AmazonSearchItemsRequest,
  type AmazonSearchItemsResponse,
} from './adapters/amazonProductAdapter';

const PAAPI_HOST = 'webservices.amazon.es';
const PAAPI_URL = `https://${PAAPI_HOST}/paapi5/searchitems`;
const PAAPI_REGION = 'eu-west-1';
const PAAPI_SERVICE = 'ProductAdvertisingAPIv1';
const PAAPI_TARGET = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems';

interface AmazonCreds {
  accessKey: string;
  secretKey: string;
  trackingId: string;
}

function resolveCreds(): AmazonCreds | null {
  const stored = getCredentialValues('amazon');
  const creds: AmazonCreds = {
    accessKey: String(stored?.accessKey ?? '').trim(),
    secretKey: String(stored?.secretKey ?? '').trim(),
    trackingId: String(stored?.trackingId ?? '').trim(),
  };
  return creds.accessKey && creds.secretKey && creds.trackingId ? creds : null;
}

/* ---------------- AWS SigV4 ---------------- */

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** Firma SigV4 de la petición PA-API (headers Authorization + X-Amz-Date). */
function signRequest(body: string, creds: AmazonCreds, amzDate: string, associateTag: string): Record<string, string> {
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    host: PAAPI_HOST,
    'x-amz-date': amzDate,
    'x-amz-target': PAAPI_TARGET,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key].trim()}\n`)
    .join('');

  // PA-API 5.0 exige AssociateTag como querystring firmado (además de PartnerTag en el body)
  const canonicalQuery = `AssociateTag=${encodeURIComponent(associateTag)}`;

  const canonicalRequest = [
    'POST',
    '/paapi5/searchitems',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${PAAPI_REGION}/${PAAPI_SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${creds.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, PAAPI_REGION);
  const kService = hmac(kRegion, PAAPI_SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  return {
    Authorization: authorization,
    'Content-Type': 'application/json; charset=utf-8',
    Host: PAAPI_HOST,
    'X-Amz-Date': amzDate,
    'X-Amz-Target': PAAPI_TARGET,
  };
}

/* ---------------- Blindaje anti-503 / anti-bot ---------------- */

/**
 * Cabeceras de navegador reales: la PA-API deteja peticiones sin User-Agent
 * de cliente y responde 503/429 desde su capa anti-bot. Van firmadas FUERA de
 * `SignedHeaders`, así la firma SigV4 sigue siendo válida.
 */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Origin: 'https://www.amazon.es',
  Referer: 'https://www.amazon.es/',
};

/** Estados transitorios (sobrecarga / rate limit) que se reintentan. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/** Total de intentos (1 original + 2 reintentos con backoff). */
const PAAPI_MAX_ATTEMPTS = 3;
const PAAPI_TIMEOUT_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff exponencial con jitter: 400 ms → 800 ms → 1600 ms… */
function backoffMs(attempt: number): number {
  return 400 * 2 ** (attempt - 1) + Math.round(Math.random() * 200);
}

/** Respeta `Retry-After` (segundos) si la API lo envía; si no, backoff. */
function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 5) * 1000;
  return backoffMs(attempt);
}

/** ¿Conviene reintentar? Estado HTTP transitorio o error de throttling en el cuerpo. */
function shouldRetry(response: Response, parsed: AmazonSearchItemsResponse | null): boolean {
  if (RETRYABLE_STATUS.has(response.status)) return true;
  const code = parsed?.Errors?.[0]?.Code ?? '';
  return /TooMany|Throttl|SlowDown|ServiceUnavailable|InternalFailure/i.test(code);
}

/* ---------------- Petición SearchItems ---------------- */

function buildRequestBody(params: UnifiedSearchParams, partnerTag: string): AmazonSearchItemsRequest {
  const count = Math.min(Math.max(params.limit ?? 10, 1), 10);
  const body: AmazonSearchItemsRequest = {
    PartnerTag: partnerTag,
    PartnerType: 'Associates',
    Marketplace: 'www.amazon.es',
    ItemCount: count,
    Resources: AMAZON_RESOURCES,
  };
  if (params.query) body.Keywords = params.query;
  else if (params.category) body.Keywords = params.category;
  else body.Keywords = 'mejores valorados';

  // Filtro de precio (PA-API acepta filter price:min-max)
  if (params.minPrice != null || params.maxPrice != null) {
    const min = params.minPrice ?? 0;
    const max = params.maxPrice ?? 999999;
    body.Filter = `price:${min.toFixed(2)}-${max.toFixed(2)}`;
  }
  return body;
}

/**
 * Llama a SearchItems con firma SigV4 y devuelve los items crudos.
 *
 * Blindado: reintenta con backoff exponencial ante 429/5xx (503 típico de la
 * capa anti-bot de PA-API), re-firma cada intento (X-Amz-Date nuevo) y, si la
 * API sigue fallando tras los reintentos, lanza `ConnectorError` con mensaje
 * legible: los llamantes ya lo gestionan (search() → muestra estimada;
 * catálogo → error parcial sin cortar la sincronización).
 */
async function searchItemsRaw(params: UnifiedSearchParams, creds: AmazonCreds): Promise<AmazonItem[]> {
  const bodyJson = JSON.stringify(buildRequestBody(params, creds.trackingId));
  const url = `${PAAPI_URL}?AssociateTag=${encodeURIComponent(creds.trackingId)}`;
  let lastDetail = 'sin respuesta';

  for (let attempt = 1; attempt <= PAAPI_MAX_ATTEMPTS; attempt += 1) {
    // Firma nueva en cada intento para que X-Amz-Date no caduque tras el backoff
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const headers = {
      ...signRequest(bodyJson, creds, amzDate, creds.trackingId),
      ...BROWSER_HEADERS,
    };

    let response: Response;
    let raw: string;
    try {
      response = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: bodyJson,
      }, PAAPI_TIMEOUT_MS);
      raw = await response.text();
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : 'fallo de red';
      if (attempt < PAAPI_MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      break;
    }

    let parsed: AmazonSearchItemsResponse | null = null;
    try {
      parsed = JSON.parse(raw) as AmazonSearchItemsResponse;
    } catch {
      parsed = null;
    }

    if (attempt < PAAPI_MAX_ATTEMPTS && shouldRetry(response, parsed)) {
      lastDetail = `HTTP ${response.status}`;
      await sleep(retryAfterMs(response, attempt));
      continue;
    }

    if (!response.ok || !parsed) {
      const apiError = parsed?.Errors?.[0];
      const detail = apiError
        ? `${apiError.Code ?? 'error'}: ${apiError.Message ?? 'sin detalle'}`
        : `HTTP ${response.status}: ${raw.slice(0, 160)}`;
      throw new ConnectorError('amazon', `Amazon PA-API: ${detail}`);
    }
    if (parsed.Errors?.length) {
      const first = parsed.Errors[0];
      throw new ConnectorError('amazon', `Amazon PA-API: ${first.Code ?? 'error'}: ${first.Message ?? 'petición rechazada'}.`);
    }

    return parsed.SearchResult?.Items ?? [];
  }

  throw new ConnectorError(
    'amazon',
    `Amazon PA-API no disponible tras ${PAAPI_MAX_ATTEMPTS} intentos: ${lastDetail}.`,
  );
}

export class AmazonConnector implements NetworkConnector {
  readonly networkId = 'amazon';

  async validate(): Promise<{ ok: boolean; message: string }> {
    const creds = resolveCreds();
    if (!creds) {
      const message = 'Faltan credenciales obligatorias (Access Key, Secret Key o Tracking ID).';
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }

    try {
      // Búsqueda mínima firmada: confirma credenciales + Associate Tag de verdad
      await searchItemsRaw({ query: 'usb cable', limit: 1 }, creds);
      const message = 'PA-API 5.0 verificado: SearchItems firmado con éxito (Associate Tag activo).';
      setNetworkStatus(this.networkId, 'connected', message);
      return { ok: true, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo validar Amazon PA-API.';
      setNetworkStatus(this.networkId, 'error', message);
      return { ok: false, message };
    }
  }

  /** Búsqueda/sincronización al contrato canónico (pipeline). */
  async searchCanonical(params: UnifiedSearchParams): Promise<CanonicalAffiliateProduct[]> {
    const creds = resolveCreds();
    if (!creds) {
      throw new ConnectorError(this.networkId, 'Amazon no está conectado. Añade sus credenciales primero.');
    }
    const items = await searchItemsRaw(params, creds);
    const adapter = new AmazonProductAdapter(creds.trackingId);
    return adapter.adapt(items);
  }

  async search(params: UnifiedSearchParams): Promise<UnifiedProduct[]> {
    const creds = resolveCreds();
    // Sin credenciales: muestra estimada (comportamiento histórico de la UI)
    if (!creds) return sampleProducts(this.networkId, params, 11);

    try {
      const canonical = await this.searchCanonical(params);
      if (!canonical.length) return sampleProducts(this.networkId, params, 11);
      return canonical.map(canonicalToUnified);
    } catch (error) {
      if (error instanceof ConnectorError) {
        // PA-API rechazado (sin suscripción válida, etc.): no romper la UI
        console.warn('[AmazonConnector] PA-API no disponible, usando muestra estimada:', error.message);
        return sampleProducts(this.networkId, params, 11);
      }
      throw error;
    }
  }
}
