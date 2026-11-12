#!/usr/bin/env node
// Ejecuta A MANO un workflow LOCAL en el n8n de pruebas, resume la ejecución, guarda el informe (JSON + Markdown) fuera del repositorio y
// comprueba que los datos de prueba NO cambiaron (huella SHA-256 de cada fichero antes/después).
//
//   node scripts/automation/ejecutar-local.mjs --nombre "Auditor General" --salida D:/treidilor-pruebas/salidas --datos D:/treidilor-pruebas/datos
//
// Sólo ejecuta workflows cuyo nombre contenga «(local)». Nunca los de producción.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const N8N = 'treidilor-n8n-pruebas';
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []));
if (!args.nombre || !args.salida) {
  console.error('Uso: ejecutar-local.mjs --nombre <parte del nombre> --salida <carpeta> [--datos <carpeta de datos de pruebas>]');
  process.exit(2);
}
const salida = path.resolve(args.salida);
if (salida.toLowerCase().startsWith(RAIZ.toLowerCase() + path.sep)) {
  console.error('✖ Las salidas no pueden escribirse dentro del repositorio.');
  process.exit(2);
}
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

const huellas = (carpeta) => {
  const out = {};
  for (const n of fs.readdirSync(carpeta).sort()) {
    const p = path.join(carpeta, n);
    if (fs.statSync(p).isFile()) out[n] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
  }
  return out;
};
// Los ficheros que el SERVIDOR escribe por su cuenta (no los agentes) no cuentan como cambio de datos.
const PROPIOS_DEL_SERVIDOR = new Set(['price-alert-center.json', 'automation-audit.jsonl', 'automation-clients.json.bak']);

// Aislamiento primero
try {
  execFileSync(process.execPath, [path.join(RAIZ, 'scripts/automation/comprobar-aislamiento.mjs')], { stdio: 'ignore' });
} catch {
  console.error('✖ El aislamiento no está garantizado (ejecuta comprobar-aislamiento.mjs). No se ejecuta nada.');
  process.exit(1);
}

const lista = docker('exec', N8N, 'n8n', 'list:workflow').split('\n').map((l) => l.split('|')).filter((p) => p.length === 2);
const candidatos = lista.filter(([, n]) => n.includes(args.nombre) && /\(local\)/.test(n));
if (candidatos.length !== 1) {
  console.error(`✖ Se esperaba exactamente un workflow local que contenga «${args.nombre}» y hay ${candidatos.length}.`);
  process.exit(1);
}
const [id, nombre] = candidatos[0];

const antes = args.datos ? huellas(path.resolve(args.datos)) : null;
const t0 = Date.now();
const bruto = docker('exec', '-e', 'N8N_RUNNERS_BROKER_PORT=5690', N8N, 'n8n', 'execute', `--id=${id}`);
const ms = Date.now() - t0;
const inicio = bruto.indexOf('{', bruto.indexOf('===='));
const ejecucion = JSON.parse(bruto.slice(inicio));
const rd = ejecucion.data.resultData;

console.log(`Workflow: ${nombre.trim()} (${ms} ms)`);
if (rd.error) console.log(`✖ Error global: ${JSON.stringify(rd.error).slice(0, 400)}`);
const resumen = [];
for (const [n, corridas] of Object.entries(rd.runData)) {
  corridas.forEach((r) => {
    const items = (r.data?.main ?? []).map((o) => (o ? o.length : 0)).join('/');
    const campos = r.data?.main?.[0]?.[0]?.json ? Object.keys(r.data.main[0][0].json).slice(0, 6).join(',') : '';
    resumen.push({ nodo: n, estado: r.executionStatus, items, error: r.error ? JSON.stringify(r.error).slice(0, 200) : null });
    console.log(`  ${r.executionStatus === 'success' ? '✔' : '✖'} ${n} · ${items} elementos${r.error ? ` · ERROR ${resumen.at(-1).error}` : ''}${/Pedir/.test(n) ? ` · campos: ${campos}` : ''}`);
  });
}
const informe = rd.runData.Informe?.[0]?.data?.main?.[0]?.[0]?.json;
fs.mkdirSync(salida, { recursive: true });
const base = path.join(salida, nombre.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase());
fs.writeFileSync(`${base}.resumen.json`, JSON.stringify({ workflow: nombre.trim(), ms, nodos: resumen }, null, 2));
if (informe) {
  fs.writeFileSync(`${base}.informe.json`, JSON.stringify(informe, null, 2));
  if (informe.markdown) fs.writeFileSync(`${base}.informe.md`, informe.markdown);
  console.log(`Informe: ${base}.informe.json / .md · estado ${informe.resumen?.estado ?? '—'}`);
} else console.log('✖ El workflow no produjo informe.');

let cambios = [];
if (antes) {
  const despues = huellas(path.resolve(args.datos));
  for (const n of new Set([...Object.keys(antes), ...Object.keys(despues)])) {
    if (antes[n] !== despues[n] && !PROPIOS_DEL_SERVIDOR.has(n)) cambios.push(n);
  }
  console.log(cambios.length ? `✖ DATOS MODIFICADOS: ${cambios.join(', ')}` : '✔ Datos de prueba idénticos antes y después (huella SHA-256 de cada fichero).');
}
process.exit(rd.error || !informe || cambios.length ? 1 : 0);
