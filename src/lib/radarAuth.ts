import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataFile, RADAR_AVATARS_DIR } from './paths';

/**
 * ==============================================================================
 * TRADYLOR — AUTH DE USUARIOS FINALES (Mi Radar)
 * ==============================================================================
 * Cuentas públicas de la zona "Mi Radar" (email+contraseña o Google), separadas
 * del users.json del backend admin: aquí no hay roles ni jerarquía, sólo el
 * perfil del comprador. Persistencia en radar-users.json (volumen en prod).
 *
 * Sesión: cookie `tradylor_radar_session` = id.token (mismo patrón que
 * adminAuth). token = sha256(id + passwordHash + fijo): para usuarios Google,
 * passwordHash es un secreto aleatorio generado al crear la cuenta.
 *
 * Recuperación de contraseña: token de un solo uso con caducidad de 1h. Sin
 * SMTP configurado se entrega vía N8N_RESET_WEBHOOK_URL (n8n envía el email);
 * en local (no production) el link se incluye también en la respuesta para
 * poder probar el flujo.
 * ==============================================================================
 */

const USERS_FILE = dataFile('radar-users.json');
const SESSION_COOKIE_NAME = 'tradylor_radar_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 días
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hora
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RadarUser {
  id: string;
  email: string;
  name: string;
  provider: 'email' | 'google';
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  /** Token de reset pendiente (borrado al usarse o caducar). */
  resetToken?: string;
  resetTokenExpires?: number;
  /** Nombre del fichero de avatar dentro de RADAR_AVATARS_DIR (opcional). */
  avatar?: string | null;
}

export type PublicRadarUser = Omit<RadarUser, 'passwordSalt' | 'passwordHash' | 'resetToken' | 'resetTokenExpires'>;

export class RadarAuthError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------ utilidades */

function uuid(): string {
  return randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function hashSecret(secret: string, salt: string): string {
  return scryptSync(secret, salt, 64).toString('hex');
}

function createSecret(): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('hex');
  return { salt, hash: hashSecret(secret, salt) };
}

/** Hash de una contraseña con salt aleatoria (registro email). */
function createPasswordHash(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: hashSecret(password, salt) };
}

function verifySecret(user: RadarUser, candidate: string): boolean {
  const computed = hashSecret(candidate, user.passwordSalt);
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertPasswordStrength(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new RadarAuthError('La contraseña debe tener al menos 8 caracteres.');
  }
}

function sessionToken(user: RadarUser): string {
  return createHash('sha256').update(`${user.id}:${user.passwordHash}:tradylor-radar-session`).digest('hex');
}

function getCookies(request: Request): Record<string, string> {
  return Object.fromEntries(
    (request.headers.get('cookie') ?? '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([name, value]) => name && value)
      .map(([name, ...value]) => [name, decodeURIComponent(value.join('='))]),
  );
}

/* ------------------------------------------------------------ persistencia */

function readUsers(): RadarUser[] {
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as RadarUser[]) : [];
  } catch (error) {
    console.error('[RadarAuth] Error leyendo radar-users.json:', error);
    return [];
  }
}

function writeUsers(users: RadarUser[]): void {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  const tmp = `${USERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf-8');
  fs.renameSync(tmp, USERS_FILE);
}

export function toPublicRadarUser(user: RadarUser): PublicRadarUser {
  const { passwordSalt: _s, passwordHash: _h, resetToken: _r, resetTokenExpires: _e, ...rest } = user;
  return { ...rest };
}

/* --------------------------------------------------------------- avatares */

/** Ruta absoluta de un fichero de avatar de usuario final. */
export function radarAvatarPath(filename: string): string {
  return path.join(RADAR_AVATARS_DIR, path.basename(filename));
}

function removeRadarAvatarFile(filename: string): void {
  try {
    const target = radarAvatarPath(filename);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (error) {
    console.error('[RadarAuth] Error eliminando avatar:', error);
  }
}

/** Guarda el nombre de avatar en el usuario (borra el anterior si cambia). */
export function setRadarAvatar(userId: string, filename: string): PublicRadarUser | null {
  const users = readUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return null;
  if (user.avatar && user.avatar !== filename) removeRadarAvatarFile(user.avatar);
  user.avatar = filename;
  user.updatedAt = new Date().toISOString();
  writeUsers(users);
  return toPublicRadarUser(user);
}

/** Elimina el avatar del usuario y su fichero. */
export function clearRadarAvatar(userId: string): PublicRadarUser | null {
  const users = readUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return null;
  if (user.avatar) removeRadarAvatarFile(user.avatar);
  user.avatar = null;
  user.updatedAt = new Date().toISOString();
  writeUsers(users);
  return toPublicRadarUser(user);
}

/* ------------------------------------------------------------- operaciones */

export function findRadarUserByEmail(email: string): RadarUser | null {
  const needle = email.trim().toLowerCase();
  return readUsers().find((u) => u.email === needle) ?? null;
}

export function findRadarUserById(id: string): RadarUser | null {
  return readUsers().find((u) => u.id === id) ?? null;
}

export function registerRadarUser(input: { email: string; password: string; name?: string }): PublicRadarUser {
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new RadarAuthError('El email no es válido.');
  assertPasswordStrength(String(input.password ?? ''));

  const users = readUsers();
  if (users.some((u) => u.email === email)) {
    throw new RadarAuthError('Ya existe una cuenta con ese email. Inicia sesión.', 409);
  }

  const { salt, hash } = createPasswordHash(String(input.password));
  const now = new Date().toISOString();
  const created: RadarUser = {
    id: uuid(),
    email,
    name: String(input.name ?? '').trim() || email.split('@')[0],
    provider: 'email',
    passwordSalt: salt,
    passwordHash: hash,
    createdAt: now,
    updatedAt: now,
  };
  users.push(created);
  writeUsers(users);
  return toPublicRadarUser(created);
}

export function loginRadarUser(email: string, password: string): RadarUser {
  const user = findRadarUserByEmail(email);
  if (!user || user.provider !== 'email' || !password || !verifySecret(user, password)) {
    throw new RadarAuthError('El email o la contraseña no son correctos.', 401);
  }
  return user;
}

/** Login/registro vía Google: upsert por email (secreto aleatorio como hash). */
export function upsertGoogleUser(input: { email: string; name?: string }): RadarUser {
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new RadarAuthError('Google no devolvió un email válido.', 400);

  const users = readUsers();
  let user = users.find((u) => u.email === email);
  if (user) {
    if (user.provider !== 'google') {
      throw new RadarAuthError('Ese email ya tiene una cuenta con contraseña. Inicia sesión con email.', 409);
    }
    if (input.name) {
      user.name = input.name;
      user.updatedAt = new Date().toISOString();
      writeUsers(users);
    }
    return user;
  }

  const { salt, hash } = createSecret();
  const now = new Date().toISOString();
  user = {
    id: uuid(),
    email,
    name: String(input.name ?? '').trim() || email.split('@')[0],
    provider: 'google',
    passwordSalt: salt,
    passwordHash: hash,
    createdAt: now,
    updatedAt: now,
  };
  users.push(user);
  writeUsers(users);
  return user;
}

/* ------------------------------------------------------------------ sesión */

export function createRadarSession(user: RadarUser): string {
  return `${SESSION_COOKIE_NAME}=${user.id}.${sessionToken(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearRadarSession(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Usuario de la petición si hay sesión válida, o null. */
export function getRadarSessionUser(request: Request): PublicRadarUser | null {
  const raw = getCookies(request)[SESSION_COOKIE_NAME];
  if (!raw) return null;
  const separator = raw.indexOf('.');
  if (separator <= 0) return null;
  const userId = raw.slice(0, separator);
  const token = raw.slice(separator + 1);
  const user = findRadarUserById(userId);
  if (!user || !token) return null;
  const expected = sessionToken(user);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? toPublicRadarUser(user) : null;
}

/* ------------------------------------------------ recuperación de contraseña */

export interface ResetRequestResult {
  /** Link de reset (sólo se devuelve fuera de producción, para pruebas). */
  devResetUrl?: string;
  /** true si se notificó al webhook de n8n (producción). */
  notified: boolean;
}

/**
 * Genera token de reset y lo entrega por N8N_RESET_WEBHOOK_URL si hay webhook
 * (n8n se encarga del email). Devuelve el link en claro sólo en local.
 */
export function requestPasswordReset(email: string, origin: string): ResetRequestResult {
  const users = readUsers();
  const user = users.find((u) => u.email === email.trim().toLowerCase());
  // Respuesta idéntica exista o no la cuenta (no se filtra registrados).
  if (!user) return { notified: false };

  const token = randomBytes(24).toString('hex');
  user.resetToken = token;
  user.resetTokenExpires = Date.now() + RESET_TTL_MS;
  user.updatedAt = new Date().toISOString();
  writeUsers(users);

  const resetUrl = `${origin.replace(/\/$/, '')}/mi-radar?reset=${token}`;
  const webhook = (process.env.N8N_RESET_WEBHOOK_URL ?? import.meta.env.N8N_RESET_WEBHOOK_URL ?? '').trim();
  let notified = false;
  if (webhook) {
    fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: user.email, name: user.name, resetUrl, product: 'tradylor-mi-radar' }),
    }).then(() => { notified = true; }).catch((error) => console.error('[RadarAuth] Webhook de reset falló:', error));
    notified = true;
  }

  // El link en claro sólo sale en runtime no-production (el contenedor de prod
  // fija NODE_ENV=production en el Dockerfile; en local facilita las pruebas).
  const isProd = (process.env.NODE_ENV ?? '') === 'production';
  return { notified, devResetUrl: isProd ? undefined : resetUrl };
}

export function resetPassword(token: string, newPassword: string): PublicRadarUser {
  assertPasswordStrength(newPassword);
  const users = readUsers();
  const user = users.find((u) => u.resetToken && u.resetToken === token.trim());
  if (!user || !user.resetTokenExpires || user.resetTokenExpires < Date.now()) {
    throw new RadarAuthError('El enlace de recuperación no es válido o ha caducado.', 400);
  }
  const { salt, hash } = createPasswordHash(newPassword);
  user.passwordSalt = salt;
  user.passwordHash = hash;
  delete user.resetToken;
  delete user.resetTokenExpires;
  user.updatedAt = new Date().toISOString();
  writeUsers(users);
  return toPublicRadarUser(user);
}

/* --------------------------------------------------------------- Google */

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/** Config de Google OAuth si las envs están presentes; si no, null (botón oculto). */
export function getGoogleOAuthConfig(): GoogleOAuthConfig | null {
  const clientId = (process.env.GOOGLE_CLIENT_ID ?? import.meta.env.GOOGLE_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? import.meta.env.GOOGLE_CLIENT_SECRET ?? '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** URL de autorización Google (state aleatorio contra CSRF). */
export function buildGoogleAuthUrl(config: GoogleOAuthConfig, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Intercambia el code por el perfil (email, name). Lanza RadarAuthError. */
export async function exchangeGoogleCode(config: GoogleOAuthConfig, code: string, redirectUri: string): Promise<{ email: string; name?: string }> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) throw new RadarAuthError('No se pudo validar el código de Google.', 401);
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) throw new RadarAuthError('Google no devolvió un token de acceso.', 401);

  const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) throw new RadarAuthError('No se pudo leer el perfil de Google.', 401);
  const info = (await infoRes.json()) as { email?: string; name?: string };
  if (!info.email) throw new RadarAuthError('La cuenta de Google no expone un email.', 401);
  return { email: info.email, name: info.name };
}

/** Cookie de estado OAuth (CSRF) de corta vida para el handoff con Google. */
export const OAUTH_STATE_COOKIE = 'tradylor_google_oauth';

export function createOAuthStateCookie(state: string): string {
  return `${OAUTH_STATE_COOKIE}=${state}; Path=/api/radar/auth; HttpOnly; SameSite=Lax; Max-Age=600`;
}

export function readOAuthStateCookie(request: Request): string | null {
  return getCookies(request)[OAUTH_STATE_COOKIE] ?? null;
}

export function clearOAuthStateCookie(): string {
  return `${OAUTH_STATE_COOKIE}=; Path=/api/radar/auth; HttpOnly; SameSite=Lax; Max-Age=0`;
}
