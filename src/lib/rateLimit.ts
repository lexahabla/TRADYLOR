/**
 * Limitador de intentos en memoria (ventana fija) para endpoints sensibles de las
 * cuentas de Mi Radar (cambio de contraseña, cambio de email). Se reinicia con el
 * proceso; basta para frenar la fuerza bruta de la contraseña actual y el envío
 * masivo de correos de confirmación a terceros.
 */
export interface RateLimiter {
  /** Cuenta un intento para la clave; false si ya superó el máximo de la ventana. */
  hit(key: string): boolean;
  /** Olvida la clave (p. ej. tras un cambio correcto). */
  reset(key: string): void;
}

/** Intentos con la contraseña actual (cambio de contraseña o de email): 10 por hora y cuenta. */
export const radarPasswordAttempts: RateLimiter = createRateLimiter(10, 60 * 60 * 1000);

/** Correos de confirmación de cambio de email: 5 por hora y cuenta. */
export const radarEmailChanges: RateLimiter = createRateLimiter(5, 60 * 60 * 1000);

/** Enlaces mágicos pedidos por IP: 8 por hora (evita bombardeo de bandejas ajenas). */
export const magicLinkRequestsPerIp: RateLimiter = createRateLimiter(8, 60 * 60 * 1000);

/** Sync de perfil de marketing por usuario: 30 por hora (el cliente throttle a 1/día). */
export const profileSyncPerUser: RateLimiter = createRateLimiter(30, 60 * 60 * 1000);

/** Tarjetas "A mi correo" enviadas por usuario: 12 por hora (sólo van a su propia cuenta). */
export const shareEmailsPerUser: RateLimiter = createRateLimiter(12, 60 * 60 * 1000);

/** ...y por IP (varias cuentas detrás de una misma conexión): 40 por hora. */
export const shareEmailsPerIp: RateLimiter = createRateLimiter(40, 60 * 60 * 1000);

/**
 * Tarjetas enviadas a una dirección EXTERNA (distinta de la de la cuenta): el
 * endpoint puede usarse para escribir a terceros, así que el tope es más bajo.
 */
export const shareEmailsExternalPerUser: RateLimiter = createRateLimiter(6, 60 * 60 * 1000);

/** ...y por IP: 15 por hora. */
export const shareEmailsExternalPerIp: RateLimiter = createRateLimiter(15, 60 * 60 * 1000);

/** Traducciones del mensaje de la tarjeta (proxy de Google Translate) por IP: 120 por hora. */
export const shareTranslatesPerIp: RateLimiter = createRateLimiter(120, 60 * 60 * 1000);

/** Mensajes al Dependiente IA (Centro de Herramientas) por usuario logeado: 60 por hora. */
export const aiAssistantPerUser: RateLimiter = createRateLimiter(60, 60 * 60 * 1000);

/** ...y por IP (cubre también a los anónimos, que sólo ven una respuesta en preview): 30 por hora. */
export const aiAssistantPerIp: RateLimiter = createRateLimiter(30, 60 * 60 * 1000);

export function createRateLimiter(max: number, windowMs: number): RateLimiter {
  const entries = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key: string): boolean {
      const now = Date.now();
      const entry = entries.get(key);
      if (!entry || entry.resetAt <= now) {
        if (entries.size > 5000) entries.clear();
        entries.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= max;
    },
    reset(key: string): void {
      entries.delete(key);
    },
  };
}
