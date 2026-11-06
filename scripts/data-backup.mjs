#!/usr/bin/env node
// Respaldo, verificación y restauración COHERENTE de los DATOS INCLUIDOS del volumen (DATA_DIR). Sin dependencias: sólo Node.
//
// ALCANCE: es un respaldo de los datos incluidos, NO una copia completa del servicio. Quedan fuera (y la restauración NO
// los toca): `images/` (imágenes de producto), `backups/`, `opencode-config/`, `opencode-data/` y los temporales; tampoco
// se respalda la imagen Docker, las variables de entorno ni la configuración de Easy Panel. Las imágenes necesitan su
// propia copia si importan (p. ej. copia del volumen completo por el proveedor).
//
// Se ejecuta con el SERVICIO DETENIDO y sin otros escritores (ver INFORMES/…_05_procedimiento-publicacion-etapa-a.md).
// El script no puede comprobar que el servicio esté parado: lo exige con --confirm-stopped y detecta indicios de
// escritura (ficheros temporales, cambios durante la copia) para abortar.
//
//   node data-backup.mjs backup  --data <DATA_DIR> --out <carpeta_destino> [--confirm-stopped]
//   node data-backup.mjs verify  --from <carpeta_copia>
//   node data-backup.mjs restore --from <carpeta_copia> --data <DATA_DIR> --safety <carpeta_seguridad> --confirm-stopped
//
// Conjunto copiado = TODO lo que hay en DATA_DIR excepto EXCLUDED_DIRS y los temporales (así un fichero nuevo de una
// versión futura entra solo, sin tocar este script). Las comprobaciones (sha256, tamaño, JSON válido) se calculan sobre
// la COPIA ya escrita, no sobre el origen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** Carpetas que NO forman parte del conjunto (voluminosas, regenerables o de otro ámbito). */
export const EXCLUDED_DIRS = ['images', 'backups', 'opencode-config', 'opencode-data'];
/** Ficheros temporales de escritura atómica (`x.json.tmp`, `x.tmp-123`…): nunca se copian ni se restauran. */
export const isTemp = (name) => /\.tmp($|[-.])/.test(name) || name.endsWith('~');
const MANIFEST = 'MANIFEST.json';
const SUMS = 'SHA256SUMS';
const DATA_SUBDIR = 'data';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const posix = (p) => p.split(path.sep).join('/');
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Recorre `root` y devuelve { files: [rutaRelativa], temps: [rutaRelativa] } respetando las exclusiones. */
export function listDataSet(root) {
  const files = [];
  const temps = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (!rel && EXCLUDED_DIRS.includes(entry.name)) continue;
        walk(path.join(dir, entry.name), r);
      } else if (entry.isFile()) {
        (isTemp(entry.name) ? temps : files).push(r);
      }
    }
  };
  walk(root, '');
  return { files: files.sort(), temps: temps.sort() };
}

function jsonProblem(file) {
  try { JSON.parse(fs.readFileSync(file, 'utf8')); return null; } catch (e) { return e.message; }
}

/** Resumen funcional del catálogo para comparar antes/después (sin datos sensibles). */
function summarize(root) {
  const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); } catch { return null; } };
  const products = read('products.json');
  const ids = Array.isArray(products) ? products.map((p) => String(p?.id)).sort() : [];
  const len = (name) => { const v = read(name); return Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : null; };
  return {
    productos: ids.length,
    idsSha256: crypto.createHash('sha256').update(ids.join('\n')).digest('hex'),
    ofertasAdicionales: Array.isArray(products) ? products.reduce((n, p) => n + (Array.isArray(p?.extra?.offers) ? p.extra.offers.length : 0), 0) : 0,
    eliminadosPorId: len('deleted-product-ids.json'),
    eliminadosPorIdentidad: len('deleted-identities.json'),
    ofertasEliminadas: len('deleted-offers.json'),
    colaRevision: len('import-review.json'),
    informesImportacion: len('import-reports.json'),
  };
}

/** Verifica una copia: manifiesto, hashes y tamaños recalculados sobre la copia, JSON válido, sin temporales ni sobrantes. */
export function verifyBackup(from) {
  const problems = [];
  const manifestPath = path.join(from, MANIFEST);
  if (!fs.existsSync(manifestPath)) return { ok: false, problems: ['falta ' + MANIFEST], manifest: null };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const dataRoot = path.join(from, DATA_SUBDIR);
  const present = listDataSet(dataRoot);
  const expected = new Set(manifest.files.map((f) => f.path));
  if (present.temps.length) problems.push('temporales en la copia: ' + present.temps.join(', '));
  for (const f of present.files) if (!expected.has(f)) problems.push('fichero no declarado en el manifiesto: ' + f);
  for (const f of manifest.files) {
    const abs = path.join(dataRoot, f.path);
    if (!fs.existsSync(abs)) { problems.push('falta: ' + f.path); continue; }
    if (fs.statSync(abs).size !== f.size) problems.push('tamaño distinto: ' + f.path);
    if (sha256(abs) !== f.sha256) problems.push('sha256 distinto: ' + f.path);
    if (f.path.endsWith('.json')) { const bad = jsonProblem(abs); if (bad) problems.push('JSON inválido: ' + f.path + ' (' + bad + ')'); }
  }
  // SHA256SUMS (formato `sha256sum -c`) debe coincidir con el manifiesto
  const sumsPath = path.join(from, SUMS);
  if (!fs.existsSync(sumsPath)) problems.push('falta ' + SUMS);
  else {
    const lines = new Set(fs.readFileSync(sumsPath, 'utf8').split('\n').filter(Boolean));
    for (const f of manifest.files) if (!lines.has(`${f.sha256}  ${DATA_SUBDIR}/${f.path}`)) problems.push(SUMS + ' no coincide: ' + f.path);
  }
  return { ok: problems.length === 0, problems, manifest };
}

export function backup({ data, out, confirmStopped }) {
  if (!confirmStopped) throw new Error('Falta --confirm-stopped: la copia sólo es coherente con el servicio detenido y sin otros escritores.');
  if (!fs.existsSync(data)) throw new Error('No existe el directorio de datos: ' + data);
  const dataAbs = path.resolve(data);
  const outAbs = path.resolve(out);
  if (outAbs === dataAbs || outAbs.startsWith(dataAbs + path.sep)) throw new Error('El destino no puede estar dentro del volumen de datos: la copia debe guardarse FUERA.');
  const before = listDataSet(dataAbs);
  if (before.temps.length) {
    throw new Error('Hay ficheros temporales en el volumen (escritura interrumpida o servicio aún activo): ' + before.temps.join(', ') +
      '. Comprueba que el servicio está detenido; si son restos de un corte, revísalos y retíralos antes de copiar.');
  }
  const snapshot = (list) => list.map((f) => { const s = fs.statSync(path.join(dataAbs, f)); return f + ':' + s.size + ':' + s.mtimeMs; }).join('|');
  const sig0 = snapshot(before.files);

  const dest = path.join(outAbs, 'treidilor-data-' + stamp());
  if (fs.existsSync(dest)) throw new Error('El destino ya existe: ' + dest);
  const destData = path.join(dest, DATA_SUBDIR);
  fs.mkdirSync(destData, { recursive: true });
  for (const f of before.files) {
    const to = path.join(destData, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(dataAbs, f), to);
  }
  // ¿Cambió algo en el origen mientras se copiaba? Entonces había un escritor activo: la copia no es fiable.
  const after = listDataSet(dataAbs);
  if (snapshot(after.files) !== sig0 || after.temps.length) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error('El volumen cambió durante la copia (hay un escritor activo). Copia descartada; detén el servicio y repite.');
  }
  // Comprobaciones calculadas SOBRE LA COPIA obtenida
  const copied = listDataSet(destData);
  const files = copied.files.map((f) => {
    const abs = path.join(destData, f);
    return { path: f, size: fs.statSync(abs).size, sha256: sha256(abs) };
  });
  const manifest = {
    formato: 1,
    creada: new Date().toISOString(),
    origen: dataAbs,
    alcance: 'Respaldo de los datos incluidos; NO es una copia completa del servicio (imágenes y demás carpetas excluidas, imagen Docker y variables de entorno quedan fuera).',
    excluidas: EXCLUDED_DIRS,
    resumen: summarize(destData),
    files,
  };
  fs.writeFileSync(path.join(dest, MANIFEST), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dest, SUMS), files.map((f) => `${f.sha256}  ${DATA_SUBDIR}/${f.path}`).join('\n') + '\n');
  const check = verifyBackup(dest);
  if (!check.ok) throw new Error('La copia no supera la verificación: ' + check.problems.join('; '));
  return { dest, manifest };
}

export function restore({ from, data, safety, confirmStopped }) {
  if (!confirmStopped) throw new Error('Falta --confirm-stopped: restaurar con el servicio activo puede mezclar versiones.');
  if (!safety) throw new Error('Falta --safety <carpeta>: se guarda el estado actual antes de sobrescribirlo (fuera del volumen).');
  const check = verifyBackup(from);
  if (!check.ok) throw new Error('La copia no es válida; no se toca nada:\n - ' + check.problems.join('\n - '));
  const dataAbs = path.resolve(data);
  const safetyAbs = path.resolve(safety);
  if (safetyAbs === dataAbs || safetyAbs.startsWith(dataAbs + path.sep)) throw new Error('La carpeta de seguridad debe estar FUERA del volumen.');
  fs.mkdirSync(dataAbs, { recursive: true });

  // 1) Estado actual (incluidos temporales) → carpeta de seguridad, para poder deshacer la restauración.
  const current = listDataSet(dataAbs);
  const safe = path.join(safetyAbs, 'pre-restore-' + stamp());
  for (const f of [...current.files, ...current.temps]) {
    const to = path.join(safe, DATA_SUBDIR, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(dataAbs, f), to);
  }
  // 2) El conjunto pasa a ser EXACTAMENTE el de la copia: se retiran los ficheros del conjunto que la copia no tiene
  //    (p. ej. deleted-identities.json creado después) y los temporales huérfanos.
  const wanted = new Set(check.manifest.files.map((f) => f.path));
  const removed = [];
  for (const f of [...current.files, ...current.temps]) {
    if (!wanted.has(f)) { fs.rmSync(path.join(dataAbs, f), { force: true }); removed.push(f); }
  }
  // 3) Copia atómica de cada fichero (temporal + renombrado).
  for (const f of check.manifest.files) {
    const to = path.join(dataAbs, f.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const part = to + '.restore.tmp';
    fs.copyFileSync(path.join(from, DATA_SUBDIR, f.path), part);
    fs.renameSync(part, to);
  }
  // 4) Comprobación final sobre el volumen restaurado
  const problems = [];
  const after = listDataSet(dataAbs);
  if (after.temps.length) problems.push('temporales tras restaurar: ' + after.temps.join(', '));
  for (const f of check.manifest.files) {
    const abs = path.join(dataAbs, f.path);
    if (!fs.existsSync(abs) || sha256(abs) !== f.sha256) problems.push('no coincide tras restaurar: ' + f.path);
    else if (f.path.endsWith('.json') && jsonProblem(abs)) problems.push('JSON inválido tras restaurar: ' + f.path);
  }
  for (const f of after.files) if (!wanted.has(f)) problems.push('sobrante tras restaurar: ' + f);
  if (problems.length) throw new Error('La restauración no supera la comprobación (estado previo en ' + safe + '): ' + problems.join('; '));
  return { restored: check.manifest.files.length, removed, safety: safe, resumen: summarize(dataAbs), esperado: check.manifest.resumen };
}

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm-stopped') o.confirmStopped = true;
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const o = args(process.argv.slice(2));
  try {
    if (o._[0] === 'backup') {
      const r = backup({ data: o.data, out: o.out, confirmStopped: o.confirmStopped });
      console.log('RESPALDO CORRECTO (datos incluidos; excluidas: ' + EXCLUDED_DIRS.join(', ') + '):', r.dest);
      console.log(JSON.stringify(r.manifest.resumen, null, 2));
      console.log(r.manifest.files.length + ' ficheros; manifiesto y SHA256SUMS calculados sobre la copia.');
    } else if (o._[0] === 'verify') {
      const r = verifyBackup(o.from);
      if (!r.ok) { console.error('COPIA NO VÁLIDA:\n - ' + r.problems.join('\n - ')); process.exit(1); }
      console.log('COPIA VÁLIDA:', r.manifest.files.length, 'ficheros');
      console.log(JSON.stringify(r.manifest.resumen, null, 2));
    } else if (o._[0] === 'restore') {
      const r = restore({ from: o.from, data: o.data, safety: o.safety, confirmStopped: o.confirmStopped });
      console.log('RESTAURACIÓN CORRECTA (sólo datos incluidos; las carpetas excluidas no se tocan):', r.restored, 'ficheros; retirados:', r.removed.length ? r.removed.join(', ') : 'ninguno');
      console.log('Estado previo guardado en', r.safety);
      console.log(JSON.stringify(r.resumen, null, 2));
    } else {
      console.error('Uso: backup --data D --out O --confirm-stopped | verify --from C | restore --from C --data D --safety S --confirm-stopped');
      process.exit(2);
    }
  } catch (e) { console.error('ERROR:', e.message); process.exit(1); }
}
