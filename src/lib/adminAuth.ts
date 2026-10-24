import { createHash, timingSafeEqual } from 'node:crypto';
import { findUserById, findValidCredentials, toPublicUser, type AdminUser, type PublicUser } from './userStore';

const SESSION_COOKIE_NAME = 'tradylor_admin_session';

/**
 * Duración máxima de una sesión del panel desde que se inicia, pase lo que
 * pase (tareas largas incluidas: Construir Catálogo, Pipeline, Enriquecer en
 * lote...). Antes la sesión sólo caducaba cuando el navegador cerraba la
 * pestaña (beacon de `pagehide`), pero ese evento también salta si la pestaña
 * se queda en segundo plano, el móvil cambia de app o el SO la descarta por
 * memoria — cortando la sesión A MITAD de una operación larga y dejando el
 * panel con 401 en todo en cuanto se vuelve a mirar. Ahora caduca sólo por
 * tiempo; cerrar sesión manualmente sigue funcionando igual.
 */
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 horas

/**
 * Sesión multiusuario del backend. La cookie vale `userId.issuedAt.token` y el
 * token es sha256(id + passwordHash + issuedAt + fijo): al cambiar la
 * contraseña se invalidan todas las sesiones de esa cuenta (la propia
 * petición de cambio recibe cookie nueva). `issuedAt` viaja también en el
 * hash para que no se pueda alargar una sesión cambiando sólo ese campo.
 */
function getSessionToken(user: AdminUser, issuedAt: number): string {
  return createHash('sha256')
    .update(`${user.id}:${user.passwordHash}:${issuedAt}:tradylor-admin-session`)
    .digest('hex');
}

function getCookies(request: Request): Record<string, string> {
  return Object.fromEntries((request.headers.get('cookie') ?? '').split(';').map((part) => part.trim().split('=')).filter(([name, value]) => name && value).map(([name, ...value]) => [name, decodeURIComponent(value.join('='))]));
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Usuario autenticado de la petición, o null (también si la sesión caducó). */
export function getSessionUser(request: Request): PublicUser | null {
  const raw = getCookies(request)[SESSION_COOKIE_NAME];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [userId, issuedAtRaw, token] = parts;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > SESSION_TTL_SECONDS * 1000) return null;
  const user = findUserById(userId);
  if (!user || !token) return null;
  return safeEqual(token, getSessionToken(user, issuedAt)) ? toPublicUser(user) : null;
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
  const issuedAt = Date.now();
  const token = getSessionToken(user, issuedAt);
  // Max-Age en vez de cookie de sesión del navegador: ver SESSION_TTL_SECONDS.
  return `${SESSION_COOKIE_NAME}=${user.id}.${issuedAt}.${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
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
