/**
 * ==============================================================================
 * TREIDILOR — IP DEL CLIENTE (punto único)
 * ==============================================================================
 * `X-Forwarded-For` es una lista que cada proxy AÑADE por la derecha; el cliente puede enviar por delante los valores que quiera. Por eso
 * NUNCA se confía en el primer valor «a ciegas». La IP del cliente sólo es fiable de dos maneras:
 *
 *  1. Dirección del PAR TCP (`peer`): la que Node ve en la conexión. Astro la pone en la petición (`Symbol.for('astro.clientAddress')`) y sólo
 *     coincide con el primer valor de `X-Forwarded-For` si el proyecto declara `security.allowedDomains` (hoy NO se declara; hay una prueba que lo vigila).
 *     Tras un proxy, el par es el propio proxy: no distingue clientes.
 *  2. Con proxies de CONFIANZA declarados: `TRUSTED_PROXY_HOPS=N` = nº de proxies propios entre Internet y la aplicación (0-5). Entonces la IP del
 *     cliente es la entrada N contando desde la DERECHA de `X-Forwarded-For` (la añadió el primer proxy de confianza; lo que haya a su izquierda lo
 *     controla el cliente y se ignora). Sólo es correcto si la aplicación NO es accesible directamente (sin pasar por esos proxies).
 *
 * BLOQUEO PENDIENTE (depende de la infraestructura): cuántos proxies hay delante en producción (Easy Panel/Traefik, ¿CDN?) y si el puerto 4321 se
 * publica hacia fuera NO consta en el repositorio. Mientras `TRUSTED_PROXY_HOPS` no esté definida:
 *   · modo `strict` (API de automatización, nueva): ignora la cabecera y usa el par (todos los clientes tras el proxy comparten dirección).
 *   · modo `legacy` (endpoints anteriores de la web): conserva EXACTAMENTE su comportamiento previo (primer valor de la cabecera) para no romper
 *     los límites de login/registro/avisos; sigue siendo falsificable hasta que se configure `TRUSTED_PROXY_HOPS`.
 * ==============================================================================
 */
import { isIP } from 'node:net';

/** Dirección del par TCP que Astro adjunta a cada petición. */
export const ASTRO_CLIENT_ADDRESS = Symbol.for('astro.clientAddress');
export const MAX_TRUSTED_HOPS = 5;

export type ClientIpMode = 'strict' | 'legacy';
export type ClientIpSource = 'proxy_header' | 'peer' | 'legacy_header' | 'unknown';
export interface ClientIp {
  /** IP o `unknown`. */
  ip: string;
  source: ClientIpSource;
  /** ¿Hay `TRUSTED_PROXY_HOPS` definida y válida? */
  trustedProxyConfigured: boolean;
}

/** Nº de proxies de confianza (0-5) o `null` si no está definida o no es válida (entonces NO se confía en nada). */
export function trustedProxyHops(raw: string | undefined = process.env.TRUSTED_PROXY_HOPS): number | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return /^[0-5]$/.test(t) ? Number(t) : null;
}

/** Normaliza una IP (quita puerto y corchetes, desenvuelve IPv4 mapeada). `null` si no es una IP válida. */
export function normalizeIpValue(value: unknown): string | null {
  let ip = typeof value === 'string' ? value.trim() : '';
  if (!ip) return null;
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracket) ip = bracket[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  if (ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip.toLowerCase() : null;
}

function peerOf(request: Request): string | null {
  return normalizeIpValue(Reflect.get(request, ASTRO_CLIENT_ADDRESS));
}

/**
 * Resuelve la IP del cliente. `hops` sólo se pasa en pruebas; en producción sale de `TRUSTED_PROXY_HOPS`.
 * Nunca lanza.
 */
export function resolveClientIp(request: Request, mode: ClientIpMode = 'strict', hops: number | null = trustedProxyHops()): ClientIp {
  const configured = hops !== null;
  const peer = peerOf(request);
  const header = request.headers.get('x-forwarded-for');

  if (configured) {
    if (hops >= 1 && header) {
      const parts = header.split(',').map((s) => s.trim());
      // Menos entradas que proxies declarados = cabecera incoherente (acceso directo o configuración equivocada): no se usa.
      if (parts.length >= hops) {
        const ip = normalizeIpValue(parts[parts.length - hops]);
        if (ip) return { ip, source: 'proxy_header', trustedProxyConfigured: true };
      }
    }
    return peer ? { ip: peer, source: 'peer', trustedProxyConfigured: true } : { ip: 'unknown', source: 'unknown', trustedProxyConfigured: true };
  }

  if (mode === 'legacy') {
    const first = header?.split(',')[0]?.trim();
    return first ? { ip: first, source: 'legacy_header', trustedProxyConfigured: false } : { ip: 'unknown', source: 'unknown', trustedProxyConfigured: false };
  }
  return peer ? { ip: peer, source: 'peer', trustedProxyConfigured: false } : { ip: 'unknown', source: 'unknown', trustedProxyConfigured: false };
}
