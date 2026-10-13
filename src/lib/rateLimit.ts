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
