// Regresión: la configuración de despliegue que usa el contenedor para recrear /app/.git (y que alimenta el commit de
// /api/health) debe apuntar al repositorio de GitHub que EXISTE. Un renombrado masivo de marca cambió «TRADYLOR.git» por
// «TREIDILOR.git» (repositorio inexistente): /api/health pasó a devolver commit:null.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');
const repoNames = (text) => [...text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+?)\.git/g)].map((m) => m[1] + '/' + m[2]);

test('entrypoint y guía de despliegue apuntan al MISMO repositorio de GitHub', () => {
  const entry = new Set(repoNames(read('docker/entrypoint.sh')));
  const docs = new Set(repoNames(read('docs/deploy-easypanel.md')));
  assert.equal(entry.size, 1, 'una única URL de repositorio en el entrypoint: ' + [...entry]);
  assert.deepEqual([...entry], [...docs]);
});

test('el repositorio del entrypoint coincide con el remoto «origin» del proyecto (si hay .git local)', (t) => {
  let config = '';
  try { config = read('.git/config'); } catch { t.skip('sin .git local (p. ej. imagen de producción)'); return; }
  const origin = repoNames(config);
  if (!origin.length) { t.skip('sin remoto origin en .git/config'); return; }
  const [entry] = repoNames(read('docker/entrypoint.sh'));
  assert.equal(entry.toLowerCase(), origin[0].toLowerCase(), 'si el repositorio se renombró en GitHub, actualizar entrypoint.sh y la guía');
});

test('/api/health identifica el BUILD (BUILD_INFO.json), no el main recuperado al arrancar', () => {
  const health = read('src/pages/api/health.ts');
  assert.match(health, /BUILD_INFO\.json/);
  assert.match(health, /sourceHash/);
  assert.doesNotMatch(health, /readFileSync\([^)]*\.git/,'no debe leer /app/.git (lo recrea el entrypoint con el main de ARRANQUE)');
  assert.doesNotMatch(health, /packed-refs/);
});

test('el Dockerfile estampa la huella del código tras COPY y antes del build, sin red ni git', () => {
  const docker = read('Dockerfile');
  const copy = docker.indexOf('COPY . .');
  const stampAt = docker.indexOf('scripts/source-fingerprint.mjs');
  assert.ok(copy > 0 && stampAt > copy, 'el estampado va DESPUÉS de copiar el código');
  assert.ok(docker.indexOf('npm run build') > stampAt, 'y antes del build');
  assert.match(docker, /ARG GIT_COMMIT/);
  const line = docker.slice(stampAt - 20, docker.indexOf('npm run build'));
  assert.doesNotMatch(line, /git (fetch|clone|ls-remote)|curl|wget/, 'el commit sólo puede venir del ARG, nunca de la red');
});
