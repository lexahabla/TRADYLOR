#!/usr/bin/env node
// Huella determinista del CÓDIGO que entra en la imagen. Sirve para demostrar qué código contiene un despliegue sin
// depender de `.git` ni del `main` remoto (Easy Panel construye sin historial git).
//
//   node scripts/source-fingerprint.mjs <directorio> [--write <BUILD_INFO.json>] [--commit <hash>]   (Dockerfile)
//   node scripts/source-fingerprint.mjs --git <rev>                                                    (local, para comparar)
//
// `--git <rev>` exporta ese commit con `git archive` (exactamente los ficheros versionados, que es lo que Easy Panel
// clona) y calcula la misma huella: si coincide con `sourceHash` de /api/health, la imagen contiene ese commit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Raíces que forman el código de la aplicación (lo que determina el comportamiento del build). */
export const ROOTS = ['src', 'public', 'docker', 'scripts', 'package.json', 'package-lock.json', 'astro.config.mjs', 'tailwind.config.mjs', 'postcss.config.mjs', 'tsconfig.json'];
/** Excluido aunque esté dentro de una raíz: datos/artefactos que NO son código (y que .dockerignore ya deja fuera). */
const EXCLUDED = [/\.(log|zip)$/,/^public\/images\/products\//, /^src\/data\/credentials\.json$/, /(^|\/)node_modules\//, /(^|\/)\.astro\//, /(^|\/)dist\//];

export function fingerprint(dir) {
  const files = [];
  const walk = (abs, rel) => {
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(path.join(abs, name), rel + '/' + name);
    } else if (st.isFile() && !EXCLUDED.some((re) => re.test(rel))) files.push(rel);
  };
  for (const root of ROOTS) walk(path.join(dir, root), root);
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel + '\0' + crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex') + '\n');
  }
  return { sourceHash: hash.digest('hex'), files: files.length };
}

export function fingerprintOfCommit(rev) {
  const commit = execFileSync('git', ['rev-parse', '--verify', rev + '^{commit}'], { encoding: 'utf8' }).trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'treidilor-fp-'));
  try {
    const tarFile = path.join(tmp, '..', path.basename(tmp) + '.tar');
    execFileSync('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', '-o', tarFile, commit]);
    // core.autocrlf=false: en Windows el archive convertiría a CRLF; Easy Panel (Linux) clona con LF.
    // Rutas relativas (cwd = tmp): el tar de GNU interpreta «C:\…» como «host:ruta» y falla en Windows.
    try { execFileSync('tar', ['-xf', '../' + path.basename(tarFile)], { cwd: tmp }); } finally { fs.rmSync(tarFile, { force: true }); }
    return { commit, ...fingerprint(tmp) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    if (opt('--git')) {
      const r = fingerprintOfCommit(opt('--git'));
      console.log(JSON.stringify(r, null, 2));
    } else {
      const dir = argv.find((a) => !a.startsWith('--') && a !== opt('--write') && a !== opt('--commit')) ?? '.';
      const r = fingerprint(path.resolve(dir));
      // `commit` sólo se anota si la plataforma de build lo proporciona (ARG GIT_COMMIT); nunca se deduce de la red.
      const commit = (opt('--commit') ?? '').trim();
      const info = { commit: /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 40).toLowerCase() : null, sourceHash: r.sourceHash, files: r.files, builtAt: new Date().toISOString() };
      if (opt('--write')) fs.writeFileSync(opt('--write'), JSON.stringify(info, null, 2));
      console.log(JSON.stringify(info, null, 2));
    }
  } catch (e) { console.error('ERROR:', e.message); process.exit(1); }
}
