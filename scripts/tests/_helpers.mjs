// Utilidades compartidas por las pruebas de regresión del catálogo (no es una prueba).
// Cada fichero de prueba corre en su propio proceso: el entorno se fija ANTES de importar `src/`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET_ENV = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'NVIDIA_API_KEY', 'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY', 'AGENTROUTER_API_KEY', 'FLUX_API_KEY', 'SCRAPER_API_KEY', 'TEXT_AI_PROVIDER', 'IMAGE_AI_PROVIDER',
];

/** Datos AISLADOS: directorio temporal, sin claves de IA/ScraperAPI y credenciales de prueba. */
export function setupIsolatedData(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.TRADYLOR_DATA_DIR = dir;
  process.env.TRADYLOR_IMAGES_DIR = path.join(dir, 'images');
  process.env.ADMIN_USERNAME = 'tester';
  process.env.ADMIN_PASSWORD = 'Test-pass-123';
  process.env.TRADYLOR_API_TOKEN = 'test-token-123';
  for (const key of SECRET_ENV) delete process.env[key];
  fs.writeFileSync(path.join(dir, 'products.json'), '[]');
  return dir;
}

/** Cookie de sesión de administrador (misma firma que el login real). */
export async function adminCookie() {
  const { authenticateUser, createAdminSession } = await import('../../src/lib/adminAuth.ts');
  const user = authenticateUser('tester', 'Test-pass-123');
  if (!user) throw new Error('no se pudo crear el usuario administrador de prueba');
  return createAdminSession(user).split(';')[0];
}

export function apiRequest(url, { method = 'POST', body, cookie, token, rawBody } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = 'Bearer test-token-123';
  return new Request('http://localhost' + url, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  });
}

export const jsonOf = async (response) => response.json();

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Sustituye `fetch` (red simulada: ninguna prueba sale a Internet). Devuelve cómo restaurarlo. */
export function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = (...args) => handler(...args);
  return () => { globalThis.fetch = original; };
}

export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

export const GTIN = '4006381333931';

export const readCatalog = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'products.json'), 'utf8'));
export const writeCatalog = (dir, products) => fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify(products, null, 2));

/** Registro de importación JSON listo para usar. */
export const jsonRecord = (n, over = {}) => ({
  title: `Altavoz Zeta ${n} portátil serie ${n * 13}`,
  brand: 'Zeta',
  gtin: undefined,
  image: `https://img.invalid/z${n}.jpg`,
  platform: 'tienda',
  externalId: `Z${n}`,
  url: `https://tienda.invalid/z/${n}`,
  price: 30 + n,
  currency: 'EUR',
  category: 'Audio',
  capturedAt: '2026-10-06T10:00:00Z',
  ...over,
});

/** Importa registros por el servicio real (el mismo que usa el panel). */
export async function importRecords(records, defaults = { category: 'Audio' }) {
  const service = await import('../../src/lib/jsonImport/service.ts');
  return service.processChunk({
    batchId: 'test-' + Math.random().toString(36).slice(2, 10),
    records,
    defaults,
    dryRun: false,
    indexOffset: 0,
  });
}
