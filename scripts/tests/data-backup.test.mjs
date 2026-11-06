// ENSAYO de copia y restauración (datos aislados, CLI real, sin red ni claves): el conjunto completo de ficheros
// relacionados con el catálogo se copia y se restaura JUNTO; las comprobaciones se calculan sobre la copia; se rechaza
// copiar con escritores activos y restaurar desde una copia dañada; los temporales nunca viajan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupIsolatedData, readCatalog, jsonRecord, GTIN, importRecords } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-bk-data-');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treidilor-bk-out-'));
const safetyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treidilor-bk-safe-'));
const CLI = fileURLToPath(new URL('../data-backup.mjs', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const treeHash = (root) => {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = sha(path.join(d, e.name));
    }
  };
  walk(root, '');
  return out;
};
const only = (obj, pred) => Object.fromEntries(Object.entries(obj).filter(([k]) => pred(k)));
const included = (k) => !/^(images|backups|opencode-config|opencode-data)\//.test(k) && !/\.tmp($|[-.])/.test(k);

const identity = await import('../../src/lib/deletedIdentity.ts');
const deleted = await import('../../src/lib/deletedProducts.ts');
const { updateCatalog } = await import('../../src/lib/productStore.ts');
const { invalidateCatalogCache } = await import('../../src/lib/catalog.ts');

const amazon = (n, extra = {}) => jsonRecord(n, { platform: 'amazon', externalId: 'B0BKP0000' + n, url: 'https://www.amazon.es/dp/B0BKP0000' + n, ...extra });

/** Estado realista: fichas con ofertas adicionales, un eliminado (id + identidad), una oferta eliminada, cola de revisión e informes. */
async function populate() {
  await importRecords([
    amazon(1, { gtin: GTIN }),
    jsonRecord(1, { gtin: GTIN, platform: 'tienda', externalId: 'T1', url: 'https://tienda.invalid/t/1', price: 28 }),
    amazon(2),
    amazon(3),
    jsonRecord(4, { category: undefined, externalId: 'Z4' }), // sin categoría → cola de revisión
  ], {});
  const victim = readCatalog(dir).find((p) => p.sourceId === 'B0BKP00003');
  identity.recordProductDeletion(victim);
  updateCatalog((all) => {
    all.splice(all.findIndex((p) => p.id === victim.id), 1);
    return { changed: true, result: undefined };
  });
  const withOffers = readCatalog(dir).find((p) => (p.extra?.offers ?? []).length);
  assert.ok(withOffers, 'el ensayo necesita una ficha con ofertas adicionales');
  identity.deleteOffer(withOffers.id, withOffers.extra.offers[0].offerKey);
  fs.mkdirSync(path.join(dir, 'images/products'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'images/products/x.jpg'), 'imagen-no-incluida');
  fs.mkdirSync(path.join(dir, 'avatars'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'avatars/u1.png'), 'avatar');
  fs.writeFileSync(path.join(dir, 'users.json'), '[{"id":"u1"}]');
}

const firstCopy = () => path.join(outDir, fs.readdirSync(outDir).find((n) => n.startsWith('treidilor-data-')));

test('la copia incluye el conjunto completo (catálogo + eliminados + cola + informes + resto) y excluye imágenes y temporales', async () => {
  await populate();
  for (const f of ['products.json', 'deleted-product-ids.json', 'deleted-identities.json', 'deleted-offers.json', 'import-review.json', 'import-reports.json']) {
    assert.ok(fs.existsSync(path.join(dir, f)), 'el ensayo necesita ' + f);
  }
  const r = cli('backup', '--data', dir, '--out', outDir, '--confirm-stopped');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const copy = firstCopy();
  const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'MANIFEST.json'), 'utf8'));
  const paths = manifest.files.map((f) => f.path);
  for (const f of ['products.json', 'deleted-product-ids.json', 'deleted-identities.json', 'deleted-offers.json', 'import-review.json', 'import-reports.json', 'users.json', 'avatars/u1.png']) {
    assert.ok(paths.includes(f), 'falta ' + f);
  }
  assert.ok(!paths.some((p) => p.startsWith('images/')), 'las imágenes no van en la copia');
  const s = manifest.resumen;
  assert.ok(s.productos >= 2 && s.colaRevision >= 1 && s.eliminadosPorId >= 1 && s.eliminadosPorIdentidad >= 1 && s.ofertasEliminadas >= 1 && s.informesImportacion >= 1);
  for (const f of manifest.files) assert.equal(f.sha256, sha(path.join(copy, 'data', f.path)), 'suma calculada sobre la COPIA');
  assert.equal(cli('verify', '--from', copy).status, 0);
});

test('negativas: sin --confirm-stopped, destino dentro del volumen y temporales (escritura en curso o corte)', () => {
  assert.notEqual(cli('backup', '--data', dir, '--out', outDir).status, 0, 'exige --confirm-stopped');
  assert.notEqual(cli('backup', '--data', dir, '--out', path.join(dir, 'x'), '--confirm-stopped').status, 0, 'el destino no puede estar dentro del volumen');
  fs.writeFileSync(path.join(dir, 'products.json.tmp'), '{');
  const withTmp = cli('backup', '--data', dir, '--out', outDir, '--confirm-stopped');
  assert.notEqual(withTmp.status, 0, 'un .tmp indica escritura en curso o corte');
  assert.match(withTmp.stderr, /temporales/);
  fs.rmSync(path.join(dir, 'products.json.tmp'));
});

test('ENSAYO completo: tras alterar el volumen, restaurar devuelve EXACTAMENTE el conjunto copiado y retira lo posterior', async () => {
  const copy = firstCopy();
  const reference = only(treeHash(dir), included);
  const referenceIds = readCatalog(dir).map((p) => p.id).sort();
  // deriva posterior: producto nuevo, se pierden eliminados, aparece un fichero nuevo, un temporal huérfano y corrupción
  await importRecords([amazon(9)]);
  fs.rmSync(path.join(dir, 'deleted-identities.json'));
  fs.writeFileSync(path.join(dir, 'import-review.json'), 'esto no es json');
  fs.writeFileSync(path.join(dir, 'extra-posterior.json'), '{}');
  fs.writeFileSync(path.join(dir, 'pipeline-job.json.tmp'), '{');
  fs.writeFileSync(path.join(dir, 'images/products/y.jpg'), 'se queda');
  // carpetas excluidas: contenido propio que la restauración NO debe tocar (ni borrar ni sobrescribir)
  for (const d of ['backups', 'opencode-config', 'opencode-data']) { fs.mkdirSync(path.join(dir, d), { recursive: true }); fs.writeFileSync(path.join(dir, d, 'propio.txt'), d + '-contenido'); }
  const excludedBefore = treeHash(dir);
  const r = cli('restore', '--from', copy, '--data', dir, '--safety', safetyDir, '--confirm-stopped');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(only(treeHash(dir), included), reference, 'conjunto idéntico al copiado, byte a byte');
  assert.ok(!fs.existsSync(path.join(dir, 'pipeline-job.json.tmp')) && !fs.existsSync(path.join(dir, 'extra-posterior.json')));
  assert.ok(fs.existsSync(path.join(dir, 'images/products/y.jpg')), 'las imágenes (fuera del conjunto) no se tocan');
  const excludedAfter = treeHash(dir);
  const isExcluded = (k) => /^(images|backups|opencode-config|opencode-data)\//.test(k);
  assert.deepEqual(only(excludedAfter, isExcluded), only(excludedBefore, isExcluded), 'images/, backups/, opencode-* idénticas tras restaurar (incluida x.jpg e y.jpg)');
  assert.ok(Object.keys(only(excludedAfter, isExcluded)).length >= 5);
  assert.match(fs.readFileSync(path.join(copy, 'MANIFEST.json'), 'utf8'), /NO es una copia completa del servicio/);
  const safe = path.join(safetyDir, fs.readdirSync(safetyDir)[0], 'data');
  assert.ok(fs.existsSync(path.join(safe, 'pipeline-job.json.tmp')) && fs.existsSync(path.join(safe, 'extra-posterior.json')), 'la restauración es reversible');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  // funcionamiento tras restaurar, con el código real
  invalidateCatalogCache();
  assert.deepEqual(readCatalog(dir).map((p) => p.id).sort(), referenceIds);
  const before = readCatalog(dir).length;
  const again = await importRecords([jsonRecord(1, { gtin: GTIN, platform: 'tienda', externalId: 'T1', url: 'https://tienda.invalid/t/1', price: 28 })]);
  assert.notEqual(again.results[0].outcome, 'created', 'la oferta sigue identificándose');
  assert.equal(readCatalog(dir).length, before, 'reimportar tras restaurar no duplica fichas');
  const blocked = await importRecords([amazon(3)]);
  assert.notEqual(blocked.results[0].outcome, 'created', 'lo eliminado sigue bloqueado tras restaurar');
  assert.equal(readCatalog(dir).length, before);
  assert.ok(deleted.readDeletedIds().length >= 1);
});

test('una copia dañada o incompleta se rechaza y la restauración no toca nada', () => {
  const copy = firstCopy();
  const bad = path.join(outDir, 'danada');
  fs.cpSync(copy, bad, { recursive: true });
  const target = path.join(bad, 'data/products.json');
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8') + ' ');
  assert.notEqual(cli('verify', '--from', bad).status, 0);
  const snap = JSON.stringify(only(treeHash(dir), included));
  const r = cli('restore', '--from', bad, '--data', dir, '--safety', safetyDir, '--confirm-stopped');
  assert.notEqual(r.status, 0);
  assert.equal(JSON.stringify(only(treeHash(dir), included)), snap, 'el volumen no cambió');
  const missing = path.join(outDir, 'falta');
  fs.cpSync(copy, missing, { recursive: true });
  fs.rmSync(path.join(missing, 'data/deleted-identities.json'));
  assert.match(cli('verify', '--from', missing).stderr, /falta: deleted-identities\.json/);
  const extra = path.join(outDir, 'sobra');
  fs.cpSync(copy, extra, { recursive: true });
  fs.writeFileSync(path.join(extra, 'data/otro.json'), '{}');
  assert.match(cli('verify', '--from', extra).stderr, /no declarado/);
  assert.notEqual(cli('restore', '--from', copy, '--data', dir, '--confirm-stopped').status, 0, 'sin --safety no restaura');
});
