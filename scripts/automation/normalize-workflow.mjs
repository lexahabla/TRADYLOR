#!/usr/bin/env node
// Normaliza un workflow exportado de n8n para guardarlo en Git: sin campos volátiles, claves ordenadas, identificadores de nodo deterministas
// y credenciales referenciadas POR NOMBRE (nunca por el id interno de la instancia). Sólo usa módulos de Node.
//
//   node scripts/automation/normalize-workflow.mjs <fichero.json> [--write | --check]
import crypto from 'node:crypto';
import fs from 'node:fs';

const CAMPOS_VOLATILES = ['id', 'versionId', 'createdAt', 'updatedAt', 'pinData', 'staticData', 'triggerCount', 'shared', 'homeProject', 'isArchived', 'activeVersion', 'activeVersionId', 'versionCounter', 'description'];
export const ID_CREDENCIAL = 'REEMPLAZAR_AL_IMPORTAR';

function ordenarClaves(valor) {
  if (Array.isArray(valor)) return valor.map(ordenarClaves);
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(Object.keys(valor).sort().map((k) => [k, ordenarClaves(valor[k])]));
  }
  return valor;
}

/** Identificador estable (formato UUID) derivado del nombre del workflow y del nodo. */
export function idNodo(nombreWorkflow, nombreNodo) {
  const h = crypto.createHash('sha1').update(`${nombreWorkflow}\u0000${nombreNodo}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function normalizarWorkflow(entrada) {
  const w = JSON.parse(JSON.stringify(entrada));
  for (const c of CAMPOS_VOLATILES) delete w[c];
  if (w.meta && typeof w.meta === 'object') {
    delete w.meta.instanceId;
    if (!Object.keys(w.meta).length) delete w.meta;
  }
  w.active = false;
  w.tags = [...new Set((w.tags ?? []).map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean))].sort();
  w.nodes = (w.nodes ?? []).map((n) => {
    const nodo = { ...n };
    delete nodo.webhookId;
    nodo.id = idNodo(String(w.name ?? ''), String(n.name ?? ''));
    if (nodo.credentials && typeof nodo.credentials === 'object') {
      nodo.credentials = Object.fromEntries(Object.entries(nodo.credentials).map(([tipo, c]) => [tipo, { id: ID_CREDENCIAL, name: String(c?.name ?? '') }]));
    }
    return nodo;
  });
  return ordenarClaves(w);
}

export const serializar = (wf) => `${JSON.stringify(wf, null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('normalize-workflow.mjs')) {
  const [fichero, modo] = process.argv.slice(2);
  if (!fichero) {
    console.error('Uso: normalize-workflow.mjs <fichero.json> [--write|--check]');
    process.exit(2);
  }
  const actual = fs.readFileSync(fichero, 'utf8').replace(/\r\n/g, '\n');
  const nuevo = serializar(normalizarWorkflow(JSON.parse(actual)));
  if (modo === '--write') {
    fs.writeFileSync(fichero, nuevo);
    console.log(`Normalizado: ${fichero}`);
  } else if (modo === '--check') {
    if (nuevo !== actual) {
      console.error(`NO normalizado: ${fichero}`);
      process.exit(1);
    }
    console.log(`Normalizado: ${fichero}`);
  } else process.stdout.write(nuevo);
}
