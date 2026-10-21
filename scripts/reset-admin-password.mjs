#!/usr/bin/env node
/**
 * ==============================================================================
 * TRADYLOR - RESET DE LA CONTRASEÑA DEL ADMINISTRADOR (cuenta master)
 * ==============================================================================
 *
 * Útil cuando el panel (/upayp1b4) deja de aceptar la contraseña: la cuenta
 * master guarda un hash scrypt en <DATA_DIR>/users.json y, si se cambió desde
 * el panel, las variables de entorno (ADMIN_USERNAME / ADMIN_PASSWORD) dejan de
 * coincidir con el hash guardado.
 *
 * Este script NO lee ni imprime contraseñas: sólo reescribe el hash del usuario
 * master con el valor indicado (por defecto, $ADMIN_PASSWORD).
 *
 * Uso:
 *   node scripts/reset-admin-password.mjs                 # usa $ADMIN_PASSWORD
 *   node scripts/reset-admin-password.mjs --password 'mi-clave'
 *   node scripts/reset-admin-password.mjs --username lexahabla --password 'x'
 *   node scripts/reset-admin-password.mjs --list          # sólo lista usuarios
 *
 * En producción (Easy Panel → Terminal del contenedor):
 *   cd /app && node scripts/reset-admin-password.mjs
 *
 * El archivo de usuarios se escribe de forma atómica (tmp + rename) y queda
 * una copia previa en <DATA_DIR>/backups/users-<timestamp>.json.
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = (process.env.TRADYLOR_DATA_DIR || path.join(REPO_ROOT, 'src', 'data')).trim();
const USERS_FILE = path.join(DATA_DIR, 'users.json');

/** Carga .env (UTF-8) sólo para las claves que falten en el entorno. */
function loadDotEnv() {
  const envFile = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(`[reset-admin-password] users.json ilegible: ${error.message}`);
    process.exit(1);
  }
}

function writeUsers(users) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const backupDir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `users-${stamp}.json`);
  if (fs.existsSync(USERS_FILE)) fs.copyFileSync(USERS_FILE, backupFile);
  const tmp = `${USERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf-8');
  fs.renameSync(tmp, USERS_FILE);
  return backupFile;
}

const listOnly = process.argv.includes('--list');

const users = readUsers();

if (listOnly) {
  console.log(`[reset-admin-password] DATA_DIR=${DATA_DIR}`);
  if (users.length === 0) {
    console.log('No hay usuarios en users.json.');
  } else {
    for (const user of users) {
      console.log(`- ${user.username} | rol=${user.role} | master=${Boolean(user.master)} | id=${user.id}`);
    }
  }
  process.exit(0);
}

const username = (argValue('username') || process.env.ADMIN_USERNAME || 'lexahabla').trim();
const password = argValue('password') || process.env.ADMIN_PASSWORD;

if (!password) {
  console.error('[reset-admin-password] Falta la contraseña: usa --password o define ADMIN_PASSWORD.');
  process.exit(1);
}
if (password.length < 8) {
  console.error('[reset-admin-password] La contraseña debe tener al menos 8 caracteres.');
  process.exit(1);
}

// 1. Usuario objetivo: el master; si no hay master, el del username pedido.
let target = users.find((user) => user.master);
if (!target) target = users.find((user) => user.username.toLowerCase() === username.toLowerCase());

const now = new Date().toISOString();

if (!target) {
  // Sin usuarios: se crea la cuenta master con las credenciales indicadas.
  const salt = randomBytes(16).toString('hex');
  target = {
    id: randomUUID(),
    username,
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt),
    role: 'admin',
    master: true,
    name: username,
    email: '',
    phone: '',
    avatar: null,
    createdAt: now,
    updatedAt: now,
  };
  users.push(target);
} else {
  const salt = randomBytes(16).toString('hex');
  target.passwordSalt = salt;
  target.passwordHash = hashPassword(password, salt);
  target.role = 'admin';
  target.updatedAt = now;
}

const backupFile = writeUsers(users);

console.log(`[reset-admin-password] Usuario master actualizado: ${target.username}`);
console.log(`[reset-admin-password] Copia de seguridad: ${backupFile}`);
console.log('[reset-admin-password] Las sesiones abiertas quedan invalidadas (el token deriva del hash).');
