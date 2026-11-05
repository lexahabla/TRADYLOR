import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Datos aislados: el módulo lee TRADYLOR_DATA_DIR al importarse.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradylor-cats-'));
process.env.TRADYLOR_DATA_DIR = dir;
const file = path.join(dir, 'categories.json');
const rich = (names) => names.map((n) => ({ id: n, name: n, slug: n, icon: '📦', keywords: [n] }));
fs.writeFileSync(file, JSON.stringify(rich(['audio', 'hogar'])));

const cats = await import('../../src/lib/categories.ts');

test('la segunda lectura sale de caché y devuelve lo mismo', () => {
  const a = cats.getCategories();
  const b = cats.getCategories();
  assert.deepEqual(a.map((c) => c.id), ['audio', 'hogar']);
  assert.deepEqual(a, b);
});

test('mutar el resultado no contamina la caché', () => {
  const a = cats.getCategories();
  a.push({ id: 'x', name: 'x', slug: 'x', icon: '', keywords: [] });
  a[0].keywords.push('contaminado');
  a[0].name = 'cambiado';
  const b = cats.getCategories();
  assert.equal(b.length, 2);
  assert.deepEqual(b[0].keywords, ['audio']);
  assert.equal(b[0].name, 'audio');
});

test('una escritura externa al módulo se detecta por la fecha del fichero', async () => {
  cats.getCategories();
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(file, JSON.stringify(rich(['audio', 'hogar', 'jardin'])));
  assert.deepEqual(cats.getCategories().map((c) => c.id), ['audio', 'hogar', 'jardin']);
});

test('writeCategories y createCategory invalidan la caché al instante', () => {
  cats.getCategories();
  cats.writeCategories(rich(['solo']));
  assert.deepEqual(cats.getCategories().map((c) => c.id), ['solo']);
  const result = cats.createCategory({ name: 'Nueva categoria' });
  assert.equal(result.ok, true);
  assert.ok(cats.getCategories().some((c) => c.name === 'Nueva categoria'));
});

test('fichero ausente: se crean las categorías por defecto y quedan cacheadas', () => {
  fs.rmSync(file, { force: true });
  const first = cats.getCategories();
  assert.ok(first.length > 0);
  assert.ok(fs.existsSync(file), 'la migración perezosa recrea el fichero');
  assert.deepEqual(cats.getCategories().map((c) => c.id), first.map((c) => c.id));
});
