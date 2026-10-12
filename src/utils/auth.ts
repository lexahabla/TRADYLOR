/**
 * ==============================================================================
 * TRADYLOR — AUTH DE CLIENTE (Mi Radar)
 * ==============================================================================
 * Wrappers fetch de /api/radar/auth/* + estado de sesión cacheado en módulo.
 * Tras login/registro exitosos ejecuta syncLocalToCloud() (migración
 * LocalStorage → nube) y emite el evento global `radar:auth-changed`.
 * ==============================================================================
 */

import type { SessionResponse, UserProfile } from '../types/radar';
import { pullFromCloud, syncLocalToCloud } from './radarStore';

let cachedSession: SessionResponse | null = null;
let sessionPromise: Promise<SessionResponse> | null = null;

type AuthListener = (user: UserProfile | null) => void;
const authListeners = new Set<AuthListener>();

export function onAuthChange(listener: AuthListener): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function emitAuth(user: UserProfile | null): void {
  for (const listener of authListeners) listener(user);
  window.dispatchEvent(new CustomEvent('radar:auth-changed', { detail: { user } }));
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Consulta (o reutiliza) el estado de sesión. Fuerza refresco con force. */
export async function getSession(force = false): Promise<SessionResponse> {
  if (!force && cachedSession) return cachedSession;
  if (!force && sessionPromise) return sessionPromise;
  sessionPromise = fetch('/api/radar/auth/session', { headers: { Accept: 'application/json' } })
    .then(async (res) => {
      const data = (await parseJson(res)) as unknown as SessionResponse;
      cachedSession = {
        authenticated: Boolean(data.authenticated && data.user),
        user: data.user ?? null,
        googleEnabled: Boolean(data.googleEnabled),
      };
      return cachedSession;
    })
    .catch(() => ({ authenticated: false, user: null, googleEnabled: false } satisfies SessionResponse))
    .finally(() => {
      sessionPromise = null;
    });
  return sessionPromise;
}

export function getCachedSession(): SessionResponse | null {
  return cachedSession;
}

export interface AuthResult {
  success: boolean;
  message?: string;
  user?: UserProfile;
  /** Link de reset en dev (sólo local, flujo de recuperación). */
  devResetUrl?: string;
  /** true si el registro quedó pendiente de activación por email. */
  verificationPending?: boolean;
  /** Link de activación en dev (sólo local, flujo de verificación). */
  devVerifyUrl?: string;
  /** Código de error del servidor (p. ej. 'verify_required'). */
  code?: string;
}

async function afterAuthSuccess(): Promise<void> {
  cachedSession = null;
  const session = await getSession(true);
  if (session.authenticated) {
    await syncLocalToCloud();
    emitAuth(session.user);
  }
}

export async function register(email: string, password: string, name?: string): Promise<AuthResult> {
  const res = await fetch('/api/radar/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  const data = await parseJson(res);
  if (res.ok && data.success) {
    // Cuenta pendiente de activar: no hay sesión todavía, el usuario debe
    // pulsar el botón de activación del email de bienvenida.
    if (data.verificationPending) {
      return {
        success: true,
        verificationPending: true,
        devVerifyUrl: data.devVerifyUrl ? String(data.devVerifyUrl) : undefined,
      };
    }
    await afterAuthSuccess();
    return { success: true, user: data.user as UserProfile };
  }
  return {
    success: false,
    message: String(data.message ?? 'No se pudo crear la cuenta.'),
    code: data.code ? String(data.code) : undefined,
  };
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const res = await fetch('/api/radar/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await parseJson(res);
  if (res.ok && data.success) {
    await afterAuthSuccess();
    return { success: true, user: data.user as UserProfile };
  }
  return {
    success: false,
    message: String(data.message ?? 'No se pudo iniciar sesión.'),
    code: data.code ? String(data.code) : undefined,
  };
}

export async function logout(): Promise<void> {
  await fetch('/api/radar/auth/logout', { method: 'POST' }).catch(() => {});
  cachedSession = null;
  emitAuth(null);
}

export async function requestPasswordReset(email: string): Promise<AuthResult> {
  const res = await fetch('/api/radar/auth/forgot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await parseJson(res);
  return {
    success: res.ok && Boolean(data.success),
    message: String(data.message ?? ''),
    devResetUrl: data.devResetUrl ? String(data.devResetUrl) : undefined,
  };
}

export async function resetPassword(token: string, password: string): Promise<AuthResult> {
  const res = await fetch('/api/radar/auth/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
  const data = await parseJson(res);
  return {
    success: res.ok && Boolean(data.success),
    message: String(data.message ?? ''),
    user: data.user as UserProfile | undefined,
  };
}

/** Activa la cuenta desde el enlace del email de bienvenida. */
export async function verifyAccount(token: string): Promise<AuthResult> {
  const res = await fetch(`/api/radar/auth/verify?verify=${encodeURIComponent(token)}`, {
    headers: { Accept: 'application/json' },
  });
  const data = await parseJson(res);
  return {
    success: res.ok && Boolean(data.success),
    message: String(data.message ?? ''),
  };
}

/** Reenvía el email de activación (cuentas pendientes de verificar). */
export async function resendVerification(email: string): Promise<AuthResult> {
  const res = await fetch('/api/radar/auth/resend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await parseJson(res);
  return {
    success: res.ok && Boolean(data.success),
    message: String(data.message ?? ''),
    devVerifyUrl: data.devVerifyUrl ? String(data.devVerifyUrl) : undefined,
  };
}

/** Navega al arranque del OAuth de Google (o muestra error si no está activo). */
export async function loginWithGoogle(): Promise<void> {
  // Comprobación previa: si no hay config, el endpoint devuelve 501 JSON.
  const probe = await fetch('/api/radar/auth/google', { redirect: 'manual', headers: { Accept: 'application/json' } });
  if (probe.status === 501) {
    const data = await parseJson(probe);
    throw new Error(String(data.message ?? 'Google OAuth no disponible.'));
  }
  // 302 a Google: navegación directa (fetch follow fallaría por CORS).
  window.location.href = '/api/radar/auth/google';
}

/**
 * Bootstrap tras carga de página: resuelve la sesión y, si hay cuenta,
 * trae el radar de la nube (otro dispositivo) y emite el estado.
 */
export async function initAuth(): Promise<SessionResponse> {
  const session = await getSession(true);
  if (session.authenticated) {
    await pullFromCloud();
    emitAuth(session.user);
  }
  return session;
}
