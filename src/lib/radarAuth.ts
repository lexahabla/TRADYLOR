import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataFile, RADAR_AVATARS_DIR } from './paths';
import { sendGenericMailSmtp, sendVerificationEmailSmtp } from './mailer';
import { radarEmailChanges } from './rateLimit';

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
export const SESSION_COOKIE_NAME = 'tradylor_radar_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 días (sólo con "Recordarme")
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hora
const ACTIVATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas para confirmar un email nuevo
const NAME_MAX = 80;
const EMAIL_MAX = 120;
const PROFILE_TEXT_MAX = 80;
const HOBBIES_OTHER_MAX = 120;
const HOBBIES_MAX = 3;

/** Opciones válidas de "¿A qué dedicas tu tiempo libre?" (se pueden elegir hasta 3). */
export const RADAR_HOBBIES = [
  'fotografia-video',
  'rutas-aventura',
  'musica-audio',
  'bricolaje-diy',
  'decoracion',
  'otros',
] as const;
export type RadarHobby = (typeof RADAR_HOBBIES)[number];

/** Tipo de visitante: "¿Nos visitas como profesional o particular?" */
export const RADAR_PROFILE_TYPES = ['particular', 'profesional', 'empresa'] as const;
export type RadarProfileType = (typeof RADAR_PROFILE_TYPES)[number];

export interface RadarUser {
  id: string;
  email: string;
  name: string;
  provider: 'email' | 'google';
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  /** true si la cuenta está activada (email verificado o cuenta Google). */
  verified: boolean;
  /** Token de activación pendiente (borrado al activar o caducar). */
  activationToken?: string;
  activationTokenExpires?: number;
  /** Token de reset pendiente (borrado al usarse o caducar). */
  resetToken?: string;
  resetTokenExpires?: number;
  /** Nombre del fichero de avatar dentro de RADAR_AVATARS_DIR (opcional). */
  avatar?: string | null;
  /** true si el usuario editó su nombre (el login con Google ya no lo pisa). */
  nameCustomized?: boolean;
  /** Preferencias para las recomendaciones: categorías (slugs) que más le interesan. */
  preferences?: { categories: string[] };
  /** Email nuevo pendiente de confirmar por enlace (el actual sigue siendo el de acceso). */
  pendingEmail?: string;
  pendingEmailToken?: string;
  pendingEmailExpires?: number;
  /** Datos personales adicionales del perfil (todos opcionales). */
  lastName?: string;
  /** Fecha de nacimiento en formato ISO (YYYY-MM-DD). */
  birthDate?: string;
  city?: string;
  country?: string;
  /** Opciones de "¿A qué dedicas tu tiempo libre?" (máx. 3, ver RADAR_HOBBIES). */
  hobbies?: string[];
  /** Texto libre de la opción "Otros" del tiempo libre. */
  hobbiesOther?: string;
  /** Tipo de visitante: particular, profesional/autónomo o empresa. */
  profileType?: RadarProfileType;
}

/** Usuario que sale hacia el cliente: sin hash, sal ni ningún token (reset, activación, cambio de email). */
export type PublicRadarUser = Omit<
  RadarUser,
  | 'passwordSalt'
  | 'passwordHash'
  | 'resetToken'
  | 'resetTokenExpires'
  | 'activationToken'
  | 'activationTokenExpires'
  | 'pendingEmailToken'
  | 'pendingEmailExpires'
>;

export class RadarAuthError extends Error {
  status: number;
  /** Código de error para el cliente (p. ej. 'verify_required'). */
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
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

/** Gmail se considera verificado por Google; el resto requiere activación por email. */
export function isGmailEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith('@gmail.com');
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
  const {
    passwordSalt: _s,
    passwordHash: _h,
    resetToken: _r,
    resetTokenExpires: _re,
    activationToken: _a,
    activationTokenExpires: _ae,
    pendingEmailToken: _p,
    pendingEmailExpires: _pe,
    ...rest
  } = user;
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

export function registerRadarUser(input: { email: string; password: string; name?: string; verified?: boolean }): PublicRadarUser {
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new RadarAuthError('El email no es válido.');
  assertPasswordStrength(String(input.password ?? ''));

  const users = readUsers();
  if (users.some((u) => u.email === email)) {
    throw new RadarAuthError('Ya existe una cuenta con ese email. Inicia sesión.', 409);
  }

  const { salt, hash } = createPasswordHash(String(input.password));
  const now = new Date().toISOString();
  const skipVerification = Boolean(input.verified) || isGmailEmail(email);
  const created: RadarUser = {
    id: uuid(),
    email,
    name: String(input.name ?? '').trim() || email.split('@')[0],
    provider: 'email',
    passwordSalt: salt,
    passwordHash: hash,
    createdAt: now,
    updatedAt: now,
    verified: skipVerification,
    activationToken: skipVerification ? undefined : randomBytes(24).toString('hex'),
    activationTokenExpires: skipVerification ? undefined : Date.now() + ACTIVATION_TTL_MS,
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
  if (!user.verified) {
    throw new RadarAuthError(
      'Tu cuenta aún no está activada. Revisa el correo de bienvenida (también la carpeta de correo no deseado) y pulsa el botón de activación.',
      403,
      'verify_required',
    );
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
    user.verified = true;
    // El nombre de Google sólo se aplica si el usuario no ha editado el suyo en su perfil.
    if (input.name && !user.nameCustomized) {
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
    verified: true,
  };
  users.push(user);
  writeUsers(users);
  return user;
}

/* ------------------------------------------------------------------ sesión */

/** Valor de la cookie de sesión: id de usuario + token derivado del hash. */
export function radarSessionValue(user: RadarUser): string {
  return `${user.id}.${sessionToken(user)}`;
}

/**
 * Opciones OWASP de la cookie de sesión para Astro (`cookies.set`):
 * httpOnly + sameSite=lax + secure en producción. `maxAge` (30 días) SÓLO se
 * añade con `rememberMe: true`; sin él no se envía maxAge ni expires y el
 * navegador la trata como Session Cookie (se borra al cerrar la ventana).
 */
export interface RadarSessionCookieOptions {
  path: string;
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
  maxAge?: number;
}

export function radarSessionCookieOptions(rememberMe: boolean): RadarSessionCookieOptions {
  const options: RadarSessionCookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // Secure sólo en producción (el contenedor fija NODE_ENV=production):
    // en local http://localhost la cookie sigue funcionando sin él.
    secure: (process.env.NODE_ENV ?? '') === 'production',
  };
  if (rememberMe) options.maxAge = SESSION_TTL_SECONDS;
  return options;
}

/**
 * Cookie `Set-Cookie` en crudo (flujos sin Astro cookies API: registro,
 * Google OAuth y renovación tras cambio de contraseña). `rememberMe` por
 * defecto true para conservar el comportamiento histórico de esos flujos.
 */
export function createRadarSession(user: RadarUser, rememberMe = true): string {
  const options = radarSessionCookieOptions(rememberMe);
  const parts = [
    `${SESSION_COOKIE_NAME}=${radarSessionValue(user)}`,
    `Path=${options.path}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  if (typeof options.maxAge === 'number') parts.push(`Max-Age=${options.maxAge}`);
  return parts.join('; ');
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

/* ---------------------------------------------------- activación por email */

export interface VerificationEmailResult {
  /** true si se notificó al webhook de email (producción). */
  notified: boolean;
  /** Link de activación (sólo se devuelve fuera de producción, para pruebas). */
  devVerifyUrl?: string;
}

/**
 * Activa la cuenta con el token del email de bienvenida. Un solo uso y
 * caducidad de 24h.
 */
export function verifyRadarUser(token: string): PublicRadarUser {
  const users = readUsers();
  const user = users.find((u) => u.activationToken && u.activationToken === token.trim());
  if (!user || !user.activationTokenExpires || user.activationTokenExpires < Date.now()) {
    throw new RadarAuthError('El enlace de activación no es válido o ha caducado.', 400);
  }
  user.verified = true;
  delete user.activationToken;
  delete user.activationTokenExpires;
  user.updatedAt = new Date().toISOString();
  writeUsers(users);
  return toPublicRadarUser(user);
}

/**
 * Envía el email de bienvenida con el botón de activación y la explicación
 * de Mi Radar. Sin SMTP se entrega vía N8N_VERIFY_WEBHOOK_URL (n8n envía el
 * email); en local se devuelve el link en claro para poder probar el flujo.
 */
export async function sendVerificationEmail(user: RadarUser, origin: string): Promise<VerificationEmailResult> {
  const verifyUrl = `${origin.replace(/\/$/, '')}/?verify=${user.activationToken}`;
  const isProd = (process.env.NODE_ENV ?? '') === 'production';

  // 1) SMTP directo (si está configurado): envío real sin depender de n8n.
  const smtpSent = await sendVerificationEmailSmtp({ to: user.email, name: user.name, verifyUrl });
  if (smtpSent) return { notified: true, devVerifyUrl: isProd ? undefined : verifyUrl };

  // 2) Fallback: webhook de n8n (mismo patrón que el reset de contraseña).
  const webhook = (process.env.N8N_VERIFY_WEBHOOK_URL ?? import.meta.env.N8N_VERIFY_WEBHOOK_URL ?? '').trim();
  if (webhook) {
    fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: user.email, name: user.name, verifyUrl, product: 'tradylor-mi-radar' }),
    }).catch((error) => console.error('[RadarAuth] Webhook de activación falló:', error));
    return { notified: true, devVerifyUrl: isProd ? undefined : verifyUrl };
  }

  // 3) Sin SMTP ni webhook: en local se devuelve el link para probar; en prod no se envía.
  return { notified: false, devVerifyUrl: isProd ? undefined : verifyUrl };
}

/** Regenera el token y reenvía el email de activación (mismo patrón que forgot). */
export async function resendVerificationEmail(email: string, origin: string): Promise<VerificationEmailResult> {
  const users = readUsers();
  const user = users.find((u) => u.email === email.trim().toLowerCase());
  if (!user || user.verified || user.provider !== 'email') return { notified: false };
  user.activationToken = randomBytes(24).toString('hex');
  user.activationTokenExpires = Date.now() + ACTIVATION_TTL_MS;
  user.updatedAt = new Date().toISOString();
  writeUsers(users);
  return sendVerificationEmail(user, origin);
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

/* ------------------------------------------------------- perfil de la cuenta */

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function findUserOrThrow(users: RadarUser[], userId: string): RadarUser {
  const user = users.find((u) => u.id === userId);
  if (!user) throw new RadarAuthError('La cuenta no existe.', 404);
  return user;
}

/** Normaliza y valida un nombre visible (1-80 caracteres). */
export function normalizeRadarName(rawName: string): string {
  const name = String(rawName ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new RadarAuthError('El nombre no puede estar vacío.');
  if (name.length > NAME_MAX) throw new RadarAuthError(`El nombre no puede superar los ${NAME_MAX} caracteres.`);
  return name;
}

/** Cambia el nombre visible de la cuenta. */
export function updateRadarName(userId: string, rawName: string): PublicRadarUser {
  const name = normalizeRadarName(rawName);
  const users = readUsers();
  const user = findUserOrThrow(users, userId);
  if (user.name !== name) {
    user.name = name;
    user.nameCustomized = true;
    user.updatedAt = new Date().toISOString();
    writeUsers(users);
  }
  return toPublicRadarUser(user);
}

/* ------------------------------------- datos personales del perfil (extras) */

/** Texto opcional: colapsa espacios, vacío → '' y valida el máximo de longitud. */
function normalizeProfileText(value: unknown, max: number, label: string): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length > max) throw new RadarAuthError(`El campo "${label}" no puede superar los ${max} caracteres.`);
  return text;
}

/** Fecha de nacimiento en YYYY-MM-DD (vacío → null; no puede ser futura). */
function normalizeBirthDate(value: unknown): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new RadarAuthError('La fecha de nacimiento no es válida.');
  const date = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 1900) {
    throw new RadarAuthError('La fecha de nacimiento no es válida.');
  }
  if (date.getTime() > Date.now()) throw new RadarAuthError('La fecha de nacimiento no puede ser futura.');
  return raw;
}

/** Campos extras del perfil: presente = sobrescribir (vacío = borrar), ausente = no tocar. */
export interface RadarProfilePatch {
  lastName?: string;
  birthDate?: string;
  city?: string;
  country?: string;
  hobbies?: string[];
  hobbiesOther?: string;
  profileType?: RadarProfileType;
}

/**
 * Valida los datos personales adicionales del body del PATCH sin guardar nada:
 * apellido, fecha de nacimiento, ciudad, país, tiempo libre (máx. 3 opciones,
 * con texto libre para "Otros") y tipo de visitante.
 */
export function normalizeRadarProfileDetails(raw: Record<string, unknown>): RadarProfilePatch {
  const patch: RadarProfilePatch = {};

  if ('lastName' in raw) patch.lastName = normalizeProfileText(raw.lastName, PROFILE_TEXT_MAX, 'apellido') || undefined;
  if ('birthDate' in raw) patch.birthDate = normalizeBirthDate(raw.birthDate);
  if ('city' in raw) patch.city = normalizeProfileText(raw.city, PROFILE_TEXT_MAX, 'ciudad') || undefined;
  if ('country' in raw) patch.country = normalizeProfileText(raw.country, PROFILE_TEXT_MAX, 'país') || undefined;

  if ('profileType' in raw) {
    const value = String(raw.profileType ?? '').trim().toLowerCase();
    if (value && !(RADAR_PROFILE_TYPES as readonly string[]).includes(value)) {
      throw new RadarAuthError('El tipo de visitante no es válido.');
    }
    patch.profileType = (value || undefined) as RadarProfileType | undefined;
  }

  if ('hobbies' in raw) {
    const list = Array.isArray(raw.hobbies) ? raw.hobbies.map((hobby) => String(hobby).trim().toLowerCase()) : [];
    const hobbies = Array.from(new Set(list));
    if (hobbies.some((hobby) => !(RADAR_HOBBIES as readonly string[]).includes(hobby))) {
      throw new RadarAuthError('Hay una opción de tiempo libre no válida.');
    }
    if (hobbies.length > HOBBIES_MAX) {
      throw new RadarAuthError(`Puedes elegir hasta ${HOBBIES_MAX} opciones de tiempo libre.`);
    }
    const other = normalizeProfileText(raw.hobbiesOther, HOBBIES_OTHER_MAX, 'Otros');
    if (hobbies.includes('otros') && !other) {
      throw new RadarAuthError('Si eliges "Otros", escribe tu propia opción.');
    }
    patch.hobbies = hobbies.length ? hobbies : undefined;
    patch.hobbiesOther = hobbies.includes('otros') ? other : undefined;
  } else if ('hobbiesOther' in raw) {
    patch.hobbiesOther = normalizeProfileText(raw.hobbiesOther, HOBBIES_OTHER_MAX, 'Otros') || undefined;
  }

  return patch;
}

/** Aplica los datos personales adicionales ya validados (escritura atómica). */
export function applyRadarProfileDetails(userId: string, patch: RadarProfilePatch): PublicRadarUser {
  const users = readUsers();
  const user = findUserOrThrow(users, userId);
  let changed = false;
  for (const [key, value] of Object.entries(patch) as [keyof RadarProfilePatch, unknown][]) {
    if (JSON.stringify(user[key] ?? null) !== JSON.stringify(value ?? null)) {
      (user as unknown as Record<string, unknown>)[key] = value;
      changed = true;
    }
  }
  if (changed) {
    user.updatedAt = new Date().toISOString();
    writeUsers(users);
  }
  return toPublicRadarUser(user);
}

/**
 * Cambia la contraseña de una cuenta con email (exige la actual). Devuelve el
 * usuario completo para renovar la cookie: el token de sesión depende del hash,
 * así que el cambio cierra todas las demás sesiones de la cuenta.
 */
export function changeRadarPassword(userId: string, currentPassword: string, newPassword: string): RadarUser {
  const users = readUsers();
  const user = findUserOrThrow(users, userId);
  if (user.provider !== 'email') {
    throw new RadarAuthError('Tu cuenta usa Google: la contraseña se gestiona en tu cuenta de Google.', 400);
  }
  if (!currentPassword || !verifySecret(user, currentPassword)) {
    throw new RadarAuthError('La contraseña actual no es correcta.', 403);
  }
  assertPasswordStrength(newPassword);
  if (verifySecret(user, newPassword)) {
    throw new RadarAuthError('La nueva contraseña debe ser distinta de la actual.');
  }
  const { salt, hash } = createPasswordHash(newPassword);
  user.passwordSalt = salt;
  user.passwordHash = hash;
  delete user.resetToken;
  delete user.resetTokenExpires;
  user.updatedAt = new Date().toISOString();
  writeUsers(users);
  return user;
}

/** Guarda las categorías de interés del usuario (slugs ya validados por el endpoint). */
export function setRadarCategories(userId: string, categories: string[]): PublicRadarUser {
  const users = readUsers();
  const user = findUserOrThrow(users, userId);
  user.preferences = { categories: Array.from(new Set(categories.map((slug) => String(slug)))) };
  user.updatedAt = new Date().toISOString();
  writeUsers(users);
  return toPublicRadarUser(user);
}

export interface EmailChangeResult {
  /** Email nuevo, pendiente de confirmar. */
  pendingEmail: string;
  /** true si el correo de confirmación salió por SMTP. */
  sent: boolean;
  /** Enlace de confirmación (sólo fuera de producción, para poder probar el flujo). */
  devConfirmUrl?: string;
}

/**
 * Pide cambiar el email de acceso. El email es el identificador de la cuenta y a
 * él llegan los avisos de Mi Radar, así que el cambio exige la contraseña actual
 * y sólo se aplica cuando se confirma desde la bandeja del email NUEVO.
 */
export async function requestRadarEmailChange(
  userId: string,
  rawEmail: string,
  currentPassword: string,
  origin: string,
): Promise<EmailChangeResult> {
  const email = String(rawEmail ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > EMAIL_MAX) throw new RadarAuthError('El email no es válido.');

  const users = readUsers();
  const user = findUserOrThrow(users, userId);
  if (user.provider !== 'email') {
    throw new RadarAuthError('Tu email lo gestiona Google y no se puede cambiar desde aquí.', 400);
  }
  if (!currentPassword || !verifySecret(user, currentPassword)) {
    throw new RadarAuthError('La contraseña actual no es correcta.', 403);
  }
  if (email === user.email) throw new RadarAuthError('Ese ya es tu email actual.');
  if (users.some((u) => u.id !== user.id && u.email === email)) {
    throw new RadarAuthError('Ya existe una cuenta con ese email.', 409);
  }
  // Tope de correos de confirmación por hora y cuenta: sólo cuentan los que de verdad
  // se van a enviar (no los intentos con email mal escrito, ocupado o contraseña errónea).
  if (!radarEmailChanges.hit(userId)) {
    throw new RadarAuthError('Has pedido demasiados cambios de email. Inténtalo de nuevo en una hora.', 429);
  }

  const token = randomBytes(24).toString('hex');
  user.pendingEmail = email;
  user.pendingEmailToken = token;
  user.pendingEmailExpires = Date.now() + EMAIL_CHANGE_TTL_MS;
  user.updatedAt = new Date().toISOString();
  writeUsers(users);

  const confirmUrl = `${origin.replace(/\/$/, '')}/perfil?confirm-email=${token}`;
  const name = escapeHtml(user.name || email.split('@')[0]);
  const html = `
    <div style="max-width:560px;margin:0 auto;font-family:Inter,Arial,sans-serif;background:#0d1422;color:#f3f4f6;padding:2rem;border-radius:16px">
      <h1 style="font-size:1.4rem;margin:0 0 .5rem">Confirma tu nuevo email, ${name}</h1>
      <p style="color:#9ca3af;font-size:.9rem;line-height:1.6;margin:0 0 1.25rem">
        Has pedido usar <strong>${escapeHtml(email)}</strong> como email de tu cuenta de <strong>Mi Radar</strong>.
        El cambio solo se aplica cuando lo confirmas con el botón siguiente (el enlace caduca en 24 horas):
      </p>
      <a href="${confirmUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;font-weight:700;padding:.85rem 1.5rem;border-radius:11px;font-size:.9rem">
        Confirmar mi nuevo email
      </a>
      <p style="color:#6b7280;font-size:.75rem;margin-top:1.5rem">
        Si no lo has pedido tú, ignora este email: tu cuenta seguirá con su email actual.
      </p>
    </div>
  `;
  const text = `Confirma tu nuevo email en Tradylor: ${confirmUrl}\n\nSi no lo has pedido tú, ignora este mensaje.`;
  const sent = await sendGenericMailSmtp({ to: email, subject: 'Confirma tu nuevo email en Tradylor', html, text });

  const isProd = (process.env.NODE_ENV ?? '') === 'production';
  if (!sent && isProd) {
    // Sin correo no hay forma de confirmar: se deshace la petición para no dejarla colgada.
    const fresh = readUsers();
    const again = fresh.find((u) => u.id === userId);
    if (again && again.pendingEmailToken === token) {
      delete again.pendingEmail;
      delete again.pendingEmailToken;
      delete again.pendingEmailExpires;
      writeUsers(fresh);
    }
    throw new RadarAuthError('No pudimos enviar el email de confirmación. Inténtalo de nuevo en unos minutos.', 502);
  }
  return { pendingEmail: email, sent, devConfirmUrl: isProd ? undefined : confirmUrl };
}

/** Aplica el cambio de email con el token del enlace (un solo uso, caduca a las 24 h). */
export function confirmRadarEmailChange(token: string): PublicRadarUser {
  const needle = String(token ?? '').trim();
  const users = readUsers();
  const user = needle ? users.find((u) => u.pendingEmailToken && u.pendingEmailToken === needle) : undefined;
  if (!user || !user.pendingEmail || !user.pendingEmailExpires || user.pendingEmailExpires < Date.now()) {
    throw new RadarAuthError('El enlace de confirmación no es válido o ha caducado.', 400);
  }
  const target = user.pendingEmail;
  const clearPending = () => {
    delete user.pendingEmail;
    delete user.pendingEmailToken;
    delete user.pendingEmailExpires;
  };
  if (users.some((u) => u.id !== user.id && u.email === target)) {
    clearPending();
    writeUsers(users);
    throw new RadarAuthError('Ese email ya pertenece a otra cuenta.', 409);
  }
  user.email = target;
  user.verified = true; // ha demostrado que controla esa bandeja
  clearPending();
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
