import { createHash, timingSafeEqual } from 'node:crypto';
import { findUserById, findValidCredentials, toPublicUser, type AdminUser, type PublicUser } from './userStore';

const SESSION_COOKIE_NAME = 'tradylor_admin_session';
const SESSION_TTL_SECONDS = 28800; // 8 horas

/**
 * Sesión multiusuario del backend. La cookie vale `userId.token` y el token es
 * sha256(id + passwordHash + fijo): al cambiar la contraseña se invalidan todas
 * las sesiones de esa cuenta (la propia petición de cambio recibe cookie nueva).
 */
function getSessionToken(user: AdminUser): string {
  return createHash('sha256').update(`${user.id}:${user.passwordHash}:tradylor-admin-session`).digest('hex');
}

function getCookies(request: Request): Record<string, string> {
  return Object.fromEntries((request.headers.get('cookie') ?? '').split(';').map((part) => part.trim().split('=')).filter(([name, value]) => name && value).map(([name, ...value]) => [name, decodeURIComponent(value.join('='))]));
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Usuario autenticado de la petición, o null. */
export function getSessionUser(request: Request): PublicUser | null {
  const raw = getCookies(request)[SESSION_COOKIE_NAME];
  if (!raw) return null;
  const separator = raw.indexOf('.');
  if (separator <= 0) return null;
  const userId = raw.slice(0, separator);
  const token = raw.slice(separator + 1);
  const user = findUserById(userId);
  if (!user || !token) return null;
  return safeEqual(token, getSessionToken(user)) ? toPublicUser(user) : null;
}

export function isAdminAuthenticated(request: Request): boolean {
  return getSessionUser(request) !== null;
}

/** Autentica contra users.json; devuelve el usuario completo (sólo server-side). */
export function authenticateUser(username: string, password: string): AdminUser | null {
  return findValidCredentials(username, password);
}

/** @deprecated Usar authenticateUser (necesita el usuario para firmar la cookie). */
export function areValidCredentials(username: string, password: string): boolean {
  return authenticateUser(username, password) !== null;
}

export function createAdminSession(user: AdminUser): string {
  return `${SESSION_COOKIE_NAME}=${user.id}.${getSessionToken(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearAdminSession(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Sesión de cualquier usuario autenticado. */
export function requireUserSession(request: Request): Response | null {
  if (getSessionUser(request)) return null;
  return unauthorizedResponse();
}

/** Sesión + rol admin (master o admin). Bloquea el catálogo y su API a usuarios comunes. */
export function requireAdminAuth(request: Request): Response | null {
  const user = getSessionUser(request);
  if (user && user.role === 'admin') return null;
  return unauthorizedResponse();
}

function unauthorizedResponse(): Response {
  return new Response('Autenticacion requerida', {
    status: 401,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
