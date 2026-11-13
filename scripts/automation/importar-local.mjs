#!/usr/bin/env node
// Importa al n8n de PRUEBAS los workflows LOCALES (nunca los de producción) y la credencial de la API de automatización.
//  1) Ejecuta antes la comprobación real de aislamiento: si falla, no importa nada.
//  2) Sólo admite ficheros «*.local.json»; rechaza «*.produccion.*» aunque se pida expresamente.
//  3) Conserva los ids que ya existen en la instancia (sobrescribe, no duplica).
//  4) La credencial se lee de un fichero FUERA del repositorio y se importa cifrada; el token no se imprime.
//
//   node scripts/automation/importar-local.mjs --token D:/treidilor-pruebas/token-automatizacion.txt [--workflows auditor-general.local.json,investigador-comercial.local.json]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const N8N = 'treidilor-n8n-pruebas';
const NOMBRE_CREDENCIAL = 'Treidilor automatización (solo lectura)';
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []));
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
const limpiar = (t) => t.split('\n').filter((l) => l.trim() && !/license SDK/i.test(l));

// 1) Aislamiento
try {
  execFileSync(process.execPath, [path.join(RAIZ, 'scripts/automation/comprobar-aislamiento.mjs'), '--sin-servidor'], { stdio: 'inherit' });
} catch {
  console.error('✖ El aislamiento no está garantizado: no se importa nada.');
  process.exit(1);
}

// 2) Ficheros permitidos
const pedidos = String(args.workflows ?? 'auditor-general.local.json,investigador-comercial.local.json').split(',').map((s) => s.trim()).filter(Boolean);
for (const f of pedidos) {
  if (!/\.local\.json$/.test(f) || /produccion/i.test(f) || f.includes('/') || f.includes('\\')) {
    console.error(`✖ «${f}» no es un workflow local: el n8n de pruebas no admite workflows de producción.`);
    process.exit(1);
  }
}

// 3) Ids existentes
const existentes = new Map(limpiar(docker('exec', N8N, 'n8n', 'list:workflow')).map((l) => l.split('|')).filter((p) => p.length === 2).map(([id, nombre]) => [nombre.trim(), id.trim()]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-import-'));
for (const f of pedidos) {
  const wf = JSON.parse(fs.readFileSync(path.join(RAIZ, 'automation/workflows', f), 'utf8'));
  if (/producci[oó]n/i.test(wf.name)) {
    console.error(`✖ «${wf.name}» es de producción.`);
    process.exit(1);
  }
  if (existentes.has(wf.name)) wf.id = existentes.get(wf.name);
  fs.writeFileSync(path.join(tmp, f), JSON.stringify(wf));
}
const destino = `/tmp/imp-${Date.now()}`;
docker('cp', tmp, `${N8N}:${destino}`);
console.log(limpiar(docker('exec', N8N, 'n8n', 'import:workflow', '--separate', `--input=${destino}`)).join('\n'));
fs.rmSync(tmp, { recursive: true, force: true });

// 4) Credencial
if (args.token) {
  const ruta = path.resolve(args.token);
  if (ruta.toLowerCase().startsWith(RAIZ.toLowerCase() + path.sep)) {
    console.error('✖ El token no puede estar dentro del repositorio.');
    process.exit(1);
  }
  const token = fs.readFileSync(ruta, 'utf8').trim();
  if (!/^tai_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/.test(token)) {
    console.error('✖ El fichero no contiene un token de la API de automatización (tai_…). No se importa la credencial.');
    process.exit(1);
  }
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-cred-'));
  const fichero = path.join(carpeta, 'cred.json');
  fs.writeFileSync(fichero, JSON.stringify([{ id: 'REEMPLAZAR_AL_IMPORTAR', name: NOMBRE_CREDENCIAL, type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${token}` } }]), { mode: 0o600 });
  const enContenedor = `/tmp/cred-${Date.now()}.json`;
  docker('cp', fichero, `${N8N}:${enContenedor}`);
  fs.rmSync(carpeta, { recursive: true, force: true });
  console.log(limpiar(docker('exec', N8N, 'n8n', 'import:credentials', `--input=${enContenedor}`)).join('\n'));
  docker('exec', '-u', 'root', N8N, 'rm', '-f', enContenedor);
}
console.log(limpiar(docker('exec', N8N, 'n8n', 'list:workflow')).join('\n'));
