import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { AVATARS_DIR, dataFile } from './paths';

/**
 * ==============================================================================
 * TRADYLOR - STORE DE USUARIOS DEL BACKEND
 * ==============================================================================
 * users.json en el directorio de datos (volumen en producción). Contraseñas con
 * scrypt + salt (node:crypto). Tres niveles:
 *
 *   master (master: true)  -> lexahabla. No se borra, rol siempre admin, es el
 *                             único que puede crear/editar/borrar otros admins.
 *   admin                  -> ve catálogo y gestiona usuarios con rol "user".
 *   user                   -> solo su perfil (/upayp1b4/perfil).
 *
 * Las reglas de jerarquía se aplican aquí (no sólo en la UI) para que ningún
 * endpoint pueda saltárselas.
 * ==============================================================================
 */

export type UserRole = 'admin' | 'user';

export interface AdminUser {
  id: string;
  username: string;
  passwordSalt: string;
  passwordHash: string;
  role: UserRole;
  master: boolean;
  name: string;
  email: string;
  phone: string;
  avatar: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PublicUser = Omit<AdminUser, 'passwordSalt' | 'passwordHash'>;

export interface CreateUserInput {
  username: string;
  password: string;
  name: string;
  email?: string;
  phone?: string;
  role?: UserRole;
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  phone?: string;
  role?: UserRole;
  password?: string;
}

export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const USERS_FILE = dataFile('users.json');
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,29}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------------------------------------------------------------- contraseñas */

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export function createPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

export function verifyPassword(user: AdminUser, password: string): boolean {
  const computed = hashPassword(password, user.passwordSalt);
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = Buffer.from(computed, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function assertPasswordStrength(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new UserError('La contraseña debe tener al menos 8 caracteres.');
  }
}

/* ---------------------------------------------------------------- persistencia */

function ensureSeed(users: AdminUser[]): { users: AdminUser[]; changed: boolean } {
  const seedUsername = ((process.env.ADMIN_USERNAME ?? (typeof import.meta !== 'undefined' ? import.meta.env?.ADMIN_USERNAME : undefined)) || 'lexahabla').trim();
  const master = users.find((u) => u.master);

  if (master) return { users, changed: false };

  // Sin usuario master: promover al del username semilla o crearlo.
  const existing = users.find((u) => u.username.toLowerCase() === seedUsername.toLowerCase());
  if (existing) {
    existing.master = true;
    existing.role = 'admin';
    return { users, changed: true };
  }

  const seedPassword = (process.env.ADMIN_PASSWORD ?? (typeof import.meta !== 'undefined' ? import.meta.env?.ADMIN_PASSWORD : undefined)) || 'Upayp1b4';
  const { salt, hash } = createPassword(seedPassword);
  const now = new Date().toISOString();
  users.push({
    id: randomUUID(),
    username: seedUsername,
    passwordSalt: salt,
    passwordHash: hash,
    role: 'admin',
    master: true,
    name: seedUsername,
    email: '',
    phone: '',
    avatar: null,
    createdAt: now,
    updatedAt: now,
  });
  return { users, changed: true };
}

let cachedUsersMemory: { mtimeMs: number; users: AdminUser[] } | null = null;

export function invalidateUsersCache(): void {
  cachedUsersMemory = null;
}

function readUsers(): AdminUser[] {
  if (!fs.existsSync(USERS_FILE)) {
    // Primer arranque: crear el archivo con el usuario master para que el id
    // sea estable entre peticiones (si no, la sesión nunca coincidiría).
    const seeded = ensureSeed([]);
    writeUsers(seeded.users);
    return seeded.users;
  }
  try {
    const stat = fs.statSync(USERS_FILE);
    if (cachedUsersMemory && cachedUsersMemory.mtimeMs === stat.mtimeMs) {
      return cachedUsersMemory.users;
    }

    const raw = fs.readFileSync(USERS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('users.json inválido');
    const result = ensureSeed(parsed as AdminUser[]);
    if (result.changed) {
      writeUsers(result.users);
      return result.users;
    }
    cachedUsersMemory = { mtimeMs: stat.mtimeMs, users: result.users };
    return result.users;
  } catch (error) {
    if (cachedUsersMemory) return cachedUsersMemory.users;
    console.error('Error cargando users.json:', error);
    throw new UserError('No se pudo leer el archivo de usuarios.', 500);
  }
}

function writeUsers(users: AdminUser[]): void {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  const tmp = `${USERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf-8');
  fs.renameSync(tmp, USERS_FILE);
  try {
    const stat = fs.statSync(USERS_FILE);
    cachedUsersMemory = { mtimeMs: stat.mtimeMs, users };
  } catch {
    cachedUsersMemory = null;
  }
}

/* ----------------------------------------------------------------- lecturas */

export function toPublicUser(user: AdminUser): PublicUser {
  const { passwordSalt: _salt, passwordHash: _hash, ...rest } = user;
  return { ...rest };
}

export function listUsers(): PublicUser[] {
  return readUsers()
    .slice()
    .sort((a, b) => Number(b.master) - Number(a.master) || a.username.localeCompare(b.username))
    .map(toPublicUser);
}

export function findUserById(id: string): AdminUser | null {
  return readUsers().find((u) => u.id === id) ?? null;
}

export function findUserByUsername(username: string): AdminUser | null {
  const needle = username.trim().toLowerCase();
  return readUsers().find((u) => u.username.toLowerCase() === needle) ?? null;
}

export function findValidCredentials(username: string, password: string): AdminUser | null {
  const user = findUserByUsername(username);
  if (!user || !password) return null;
  return verifyPassword(user, password) ? user : null;
}

export function countAdmins(excludeId?: string): number {
  return readUsers().filter((u) => u.role === 'admin' && u.id !== excludeId).length;
}

/* ---------------------------------------------------------------- permisos */

function assertCanManage(actor: PublicUser, target: AdminUser): void {
  if (target.id === actor.id) return; // la cuenta propia siempre se puede editar
  if (actor.role !== 'admin') {
    throw new UserError('No tienes permisos para gestionar usuarios.', 403);
  }
  if (target.master && !actor.master) {
    throw new UserError('Solo el usuario master puede modificar la cuenta master.', 403);
  }
  if (target.role === 'admin' && !actor.master) {
    throw new UserError('Solo el usuario master puede modificar administradores.', 403);
  }
}

/* ---------------------------------------------------------------------- CRUD */

export function createUser(input: CreateUserInput, actor: PublicUser): PublicUser {
  if (actor.role !== 'admin') {
    throw new UserError('No tienes permisos para crear usuarios.', 403);
  }

  const username = String(input.username ?? '').trim();
  if (!USERNAME_RE.test(username)) {
    throw new UserError('El usuario debe tener entre 3 y 30 caracteres (letras, números, punto, guion o guion bajo).');
  }

  const role: UserRole = input.role === 'admin' ? 'admin' : 'user';
  if (role === 'admin' && !actor.master) {
    throw new UserError('Solo el usuario master puede crear administradores.', 403);
  }

  assertPasswordStrength(input.password);

  const name = String(input.name ?? '').trim();
  if (!name) throw new UserError('El nombre es obligatorio.');

  const email = String(input.email ?? '').trim();
  if (email && !EMAIL_RE.test(email)) throw new UserError('El email no es válido.');

  const users = readUsers();
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw new UserError('Ya existe un usuario con ese nombre.', 409);
  }

  const { salt, hash } = createPassword(input.password);
  const now = new Date().toISOString();
  const created: AdminUser = {
    id: randomUUID(),
    username,
    passwordSalt: salt,
    passwordHash: hash,
    role,
    master: false,
    name,
    email,
    phone: String(input.phone ?? '').trim(),
    avatar: null,
    createdAt: now,
    updatedAt: now,
  };
  users.push(created);
  writeUsers(users);
  return toPublicUser(created);
}

export function updateUser(id: string, input: UpdateUserInput, actor: PublicUser): PublicUser {
  const users = readUsers();
  const target = users.find((u) => u.id === id);
  if (!target) throw new UserError('Usuario no encontrado.', 404);
  assertCanManage(actor, target);

  if (target.id !== actor.id) {
    // Username fijo siempre; rol sólo lo mueve el master.
    if (input.role !== undefined && input.role !== target.role) {
      if (!actor.master) throw new UserError('Solo el usuario master puede cambiar roles.', 403);
      if (target.master) throw new UserError('El rol del usuario master no se puede cambiar.');
      if (target.role === 'admin' && input.role === 'user' && countAdmins(target.id) < 1) {
        throw new UserError('El sistema debe mantener al menos un administrador.');
      }
      target.role = input.role === 'admin' ? 'admin' : 'user';
    }
    if (input.password !== undefined && input.password !== '') {
      assertPasswordStrength(input.password);
      const { salt, hash } = createPassword(input.password);
      target.passwordSalt = salt;
      target.passwordHash = hash;
    }
  } else {
    // La cuenta propia nunca puede cambiar su propio rol (evita auto-promoción).
    if (input.role !== undefined && input.role !== target.role) {
      throw new UserError('No puedes cambiar tu propio rol.');
    }
    // Cambio de contraseña propio: exige una contraseña nueva válida.
    if (input.password !== undefined && input.password !== '') {
      assertPasswordStrength(input.password);
      const { salt, hash } = createPassword(input.password);
      target.passwordSalt = salt;
      target.passwordHash = hash;
    }
  }

  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new UserError('El nombre no puede estar vacío.');
    target.name = name;
  }
  if (input.email !== undefined) {
    const email = String(input.email).trim();
    if (email && !EMAIL_RE.test(email)) throw new UserError('El email no es válido.');
    target.email = email;
  }
  if (input.phone !== undefined) {
    target.phone = String(input.phone).trim();
  }

  target.updatedAt = new Date().toISOString();
  writeUsers(users);
  return toPublicUser(target);
}

export function deleteUser(id: string, actor: PublicUser): void {
  const users = readUsers();
  const target = users.find((u) => u.id === id);
  if (!target) throw new UserError('Usuario no encontrado.', 404);

  if (target.id === actor.id) throw new UserError('No puedes eliminar tu propia cuenta.');
  if (target.master) throw new UserError('La cuenta master no se puede eliminar.', 403);
  if (actor.role !== 'admin') {
    throw new UserError('No tienes permisos para eliminar usuarios.', 403);
  }
  if (target.role === 'admin') {
    if (!actor.master) throw new UserError('Solo el usuario master puede eliminar administradores.', 403);
    if (countAdmins(target.id) < 1) throw new UserError('El sistema debe mantener al menos un administrador.');
  }

  if (target.avatar) removeAvatarFile(target.avatar);
  writeUsers(users.filter((u) => u.id !== id));
}

/* ------------------------------------------------------------------ avatares */

export function avatarPath(filename: string): string {
  return path.join(AVATARS_DIR, filename);
}

export function removeAvatarFile(filename: string): void {
  try {
    const target = avatarPath(filename);
    if (fs.existsSync(target)) fs.rmSync(target);
  } catch (error) {
    console.error('Error eliminando avatar:', error);
  }
}

export function setAvatar(id: string, filename: string): PublicUser {
  const users = readUsers();
  const target = users.find((u) => u.id === id);
  if (!target) throw new UserError('Usuario no encontrado.', 404);
  if (target.avatar && target.avatar !== filename) removeAvatarFile(target.avatar);
  target.avatar = filename;
  target.updatedAt = new Date().toISOString();
  writeUsers(users);
  return toPublicUser(target);
}
