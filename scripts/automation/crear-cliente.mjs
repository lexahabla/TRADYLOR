#!/usr/bin/env node
// Crea un cliente de la API de automatización DIRECTAMENTE sobre una carpeta de datos (uso local / pruebas). En producción se usa el endpoint
// de administración (`/api/admin/automation-clients`), con sesión de administrador.
//
//   node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/automation/crear-cliente.mjs \
//        --datos D:/treidilor-pruebas/datos --nombre n8n-investigador --dias 7 --salida D:/treidilor-pruebas/token-automatizacion.txt
//
// El token NO se imprime: se escribe en --salida (fuera del repositorio). Se muestra una sola vez, al crearlo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []));
if (!args.datos || !args.salida) {
  console.error('Uso: crear-cliente.mjs --datos <carpeta> --salida <fichero> [--nombre n] [--dias 7] [--rate 30] [--cuota 2000]');
  process.exit(2);
}
const salida = path.resolve(args.salida);
const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
if (salida.toLowerCase().startsWith(repo.toLowerCase() + path.sep)) {
  console.error('Por seguridad, el token no puede escribirse dentro del repositorio.');
  process.exit(2);
}
process.env.TRADYLOR_DATA_DIR = path.resolve(args.datos);
const { createClient } = await import('../../src/lib/automationApi.ts');
const r = createClient({ name: args.nombre ?? 'n8n-investigador', scopes: ['catalog:read'], ttlDays: Number(args.dias ?? 7), ratePerMinute: Number(args.rate ?? 30), dailyQuota: Number(args.cuota ?? 2000) });
if (!r.ok) {
  console.error(`No se creó el cliente: ${r.code} — ${r.message}`);
  process.exit(1);
}
fs.writeFileSync(salida, r.token, { mode: 0o600 });
console.log(`Cliente creado: ${r.client.id} («${r.client.name}», alcances ${r.client.scopes.join(', ')}, caduca ${r.client.expiresAt}). Token escrito en ${salida}`);
