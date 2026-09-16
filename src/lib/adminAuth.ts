import { createHash } from 'node:crypto';

const DEFAULT_ADMIN_USERNAME = 'lexahabla';
const DEFAULT_ADMIN_PASSWORD = 'Upayp1b4';
const SESSION_COOKIE_NAME = 'tradylor_admin_session';

function getAdminCredentials() {
  return {
    username: process.env.ADMIN_USERNAME ?? import.meta.env.ADMIN_USERNAME ?? DEFAULT_ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD ?? import.meta.env.ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD,
  };
}

function getSessionToken(username: string, password: string): string {
  return createHash('sha256').update(`${username}:${password}:tradylor-admin-session`).digest('hex');
}

function getCookies(request: Request): Record<string, string> {
  return Object.fromEntries((request.headers.get('cookie') ?? '').split(';').map((part) => part.trim().split('=')).filter(([name, value]) => name && value).map(([name, ...value]) => [name, decodeURIComponent(value.join('='))]));
}

export function areValidCredentials(username: string, password: string): boolean {
  const configured = getAdminCredentials();
  return username === configured.username && password === configured.password;
}

export function isAdminAuthenticated(request: Request): boolean {
  const configured = getAdminCredentials();
  return getCookies(request)[SESSION_COOKIE_NAME] === getSessionToken(configured.username, configured.password);
}

export function createAdminSession(): string {
  const configured = getAdminCredentials();
  return `${SESSION_COOKIE_NAME}=${getSessionToken(configured.username, configured.password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`;
}

export function clearAdminSession(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function requireAdminAuth(request: Request): Response | null {
  if (isAdminAuthenticated(request)) return null;

  return new Response('Autenticacion requerida', {
    status: 401,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
