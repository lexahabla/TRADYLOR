// La huella del código identifica lo que contiene la imagen: determinista, sensible a cualquier cambio, insensible a
// datos/artefactos excluidos, y coincide entre el directorio del build y la exportación `git archive` de un commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fingerprint, fingerprintOfCommit } from '../source-fingerprint.mjs';

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  const put = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('src/pages/index.astro', '<h1>hola</h1>\n');
  put('src/lib/a.ts', 'export const a = 1;\n');
  put('package.json', '{"name":"x"}\n');
  put('docker/entrypoint.sh', '#!/bin/sh\n');
  return { dir, put };
}

test('misma huella para el mismo contenido y distinta ante cualquier cambio', () => {
  const a = project(); const b = project();
  assert.equal(fingerprint(a.dir).sourceHash, fingerprint(b.dir).sourceHash);
  b.put('src/lib/a.ts', 'export const a = 2;\n');
  assert.notEqual(fingerprint(a.dir).sourceHash, fingerprint(b.dir).sourceHash);
  const c = project(); c.put('src/lib/nuevo.ts', '');
  assert.notEqual(fingerprint(a.dir).sourceHash, fingerprint(c.dir).sourceHash, 'un fichero añadido también cambia la huella');
});

test('datos y artefactos excluidos no alteran la huella', () => {
  const a = project(); const base = fingerprint(a.dir).sourceHash;
  a.put('public/images/products/x.jpg', 'img');
  a.put('src/data/credentials.json', '{"secreto":1}');
  a.put('node_modules/p/i.js', 'x'); a.put('dist/server/entry.mjs', 'x'); a.put('src/.astro/types.d.ts', 'x'); a.put('src/debug.log', 'x');
  assert.equal(fingerprint(a.dir).sourceHash, base);
});

test('la huella de un commit (git archive) coincide con la del directorio de build con el mismo contenido', (t) => {
  const { dir } = project();
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main'); git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
    const here = process.cwd(); process.chdir(dir);
    let r; try { r = fingerprintOfCommit('HEAD'); } finally { process.chdir(here); }
    assert.match(r.commit, /^[0-9a-f]{40}$/);
    assert.equal(r.sourceHash, fingerprint(dir).sourceHash);
  } catch (e) { if (/ENOENT/.test(String(e.message))) t.skip('git/tar no disponibles'); else throw e; }
});

test('/api/health muestra la huella estampada en el build y NO usa .git (aunque exista y apunte a otro commit)', async () => {
  const { dir } = project();
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ffffffffffffffffffffffffffffffffffffffff\n'); // «main de arranque» distinto
  const stamped = fingerprint(dir);
  fs.writeFileSync(path.join(dir, 'BUILD_INFO.json'), JSON.stringify({ commit: null, sourceHash: stamped.sourceHash, files: stamped.files, builtAt: '2026-11-06T00:00:00Z' }));
  const here = process.cwd();
  process.chdir(dir);
  try {
    process.env.TRADYLOR_DATA_DIR = dir;
    const { GET } = await import('../../src/pages/api/health.ts');
    const body = await GET({}).json();
    assert.equal(body.sourceHash, stamped.sourceHash);
    assert.equal(body.commit, null, 'sin ARG GIT_COMMIT no se inventa un commit');
    assert.equal(body.builtAt, '2026-11-06T00:00:00Z');
    assert.doesNotMatch(JSON.stringify(body), /ffffffff/, '.git no interviene');
  } finally { process.chdir(here); }
});
