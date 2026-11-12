#!/usr/bin/env node
// Verificación PREVIA a importar el diagnóstico en cualquier n8n: el fichero no trae credenciales, secretos, peticiones HTTP activas ni escrituras.
// Imprime también la huella SHA-256 (con saltos de línea LF) para que quien importe confirme que es EXACTAMENTE este fichero.
//   node scripts/automation/verificar-fichero-diagnostico.mjs [fichero]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fichero = path.resolve(process.argv[2] ?? path.join(RAIZ, 'automation/dev/diagnostico-auditor-produccion.json'));
const texto = fs.readFileSync(fichero, 'utf8').replace(/\r\n/g, '\n');
const wf = JSON.parse(texto);
const codigo = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code').map((n) => String(n.parameters?.jsCode ?? '')).join('\n');
const http = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
const conectados = new Set(Object.entries(wf.connections ?? {}).flatMap(([de, c]) => [de, ...Object.values(c).flat(2).map((x) => x?.node)]));

const reglas = [
  ['no está activo', wf.active === false],
  ['sin pinData ni datos fijados', !('pinData' in wf) && !('staticData' in wf)],
  ['ningún nodo referencia credenciales', wf.nodes.every((n) => !n.credentials)],
  ['solo tipos esperados (disparador manual, Code, nota, HTTP deshabilitado)', wf.nodes.every((n) => ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.code', 'n8n-nodes-base.stickyNote', 'n8n-nodes-base.httpRequest'].includes(n.type))],
  ['sin disparadores de programación, webhooks ni MCP', !wf.nodes.some((n) => /schedule|cron|webhook|mcp|trigger/i.test(n.type) && n.type !== 'n8n-nodes-base.manualTrigger')],
  ['ningún nodo HTTP está habilitado', http.every((n) => n.disabled === true)],
  ['los nodos HTTP no tienen conexiones (no se ejecutan)', http.every((n) => !conectados.has(n.name))],
  ['sin Execute Command, SSH, bases de datos ni nodos de escritura', !wf.nodes.some((n) => /executeCommand|ssh|postgres|mysql|mongo|redis|readWriteFile|writeBinary|emailSend|httpRequest.*post/i.test(n.type))],
  ['código sin red (fetch, XMLHttpRequest, WebSocket, helpers HTTP, new URL)', !/\bfetch\s*\(|XMLHttpRequest|WebSocket|helpers\.httpRequest|\$helpers|\bnew\s+URL\b/.test(codigo)],
  ['código sin require/import/process/eval/Function', !/\brequire\s*\(|\bimport\s*\(|\bprocess\s*\.|\beval\s*\(|\bnew\s+Function\b|\bglobalThis\b/.test(codigo)],
  ['código sin escritura (staticData, $execution, $workflow, writeFile)', !/writeFile|appendFile|\$execution\.|\$getWorkflowStaticData|\$workflow\./.test(codigo)],
  ['código sin secretos (Bearer, sk-, tai_, JWT, TRADYLOR_API_TOKEN)', !/Bearer\s+[A-Za-z0-9._~+/=-]{16,}|\bsk-[A-Za-z0-9_-]{20,}|tai_[0-9a-f]{16}|TRADYLOR_API_TOKEN|\beyJ[A-Za-z0-9_-]{10,}\./.test(texto)],
  ['no hay cabeceras Authorization ni cookies', !/authorization|set-cookie|cookie/i.test(JSON.stringify(http.map((n) => n.parameters?.headerParameters ?? {})))],
];

console.log(`Fichero: ${path.relative(RAIZ, fichero)}`);
console.log(`SHA-256 (LF): ${crypto.createHash('sha256').update(texto).digest('hex')}`);
console.log(`Nombre del workflow: ${wf.name}`);
console.log(`Nodos: ${wf.nodes.map((n) => `${n.name} [${n.type.replace('n8n-nodes-base.', '')} v${n.typeVersion}${n.disabled ? ', DESHABILITADO' : ''}]`).join(' · ')}`);
console.log(`Hosts que aparecen en el fichero: ${[...new Set(texto.match(/https?:\/\/[A-Za-z0-9.:-]+/g) ?? [])].join(', ') || 'ninguno'} (solo texto de configuración; no se contacta con ninguno)`);
let fallos = 0;
for (const [nombre, ok] of reglas) {
  console.log(`${ok ? '✔' : '✖'} ${nombre}`);
  if (!ok) fallos++;
}
process.exit(fallos ? 1 : 0);
