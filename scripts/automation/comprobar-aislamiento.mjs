#!/usr/bin/env node
// Comprobación REAL del aislamiento del n8n de pruebas (no mira la configuración: prueba desde dentro del contenedor).
// Debe pasar SIEMPRE tras arrancar el entorno y antes de importar o ejecutar nada. Código de salida 1 si algo falla.
//
//   node scripts/automation/comprobar-aislamiento.mjs [--sin-servidor]     (--sin-servidor: no exige el Treidilor de pruebas en marcha)
import { execFileSync } from 'node:child_process';

const PROYECTO = 'treidilor-ai-pruebas';
const N8N = 'treidilor-n8n-pruebas';
const SALIDA = 'treidilor-puente-salida';
const ENTRADA = 'treidilor-puente-entrada';
const sinServidor = process.argv.includes('--sin-servidor');

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const intentar = (...args) => {
  try {
    return { ok: true, salida: docker(...args) };
  } catch (e) {
    return { ok: false, salida: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
};
// Petición desde DENTRO del contenedor de n8n (busybox wget). ok = hubo respuesta HTTP 2xx/3xx.
const pedir = (url, segundos = 6) => intentar('exec', N8N, 'wget', '-q', '-T', String(segundos), '-O', '/dev/null', url);

const resultados = [];
const comprobar = (nombre, ok, detalle = '') => {
  resultados.push({ nombre, ok });
  console.log(`${ok ? '✔' : '✖'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
};

// 1) Topología
const red = JSON.parse(docker('network', 'inspect', `${PROYECTO}_aislada`));
comprobar('la red «aislada» es internal (sin ruta a Internet ni al anfitrión)', red[0]?.Internal === true);
const n8n = JSON.parse(docker('inspect', N8N))[0];
const redesN8n = Object.keys(n8n.NetworkSettings.Networks);
comprobar('n8n está SOLO en la red aislada', redesN8n.length === 1 && redesN8n[0] === `${PROYECTO}_aislada`, redesN8n.join(', '));
comprobar('n8n no publica ningún puerto', Object.values(n8n.NetworkSettings.Ports ?? {}).every((v) => !v || v.length === 0));
const entrada = JSON.parse(docker('inspect', ENTRADA))[0];
const publicados = Object.entries(entrada.NetworkSettings.Ports ?? {}).flatMap(([, v]) => v ?? []);
comprobar('la pasarela de entrada solo publica 127.0.0.1:5678', publicados.length === 1 && publicados[0].HostIp === '127.0.0.1' && publicados[0].HostPort === '5678', JSON.stringify(publicados));
const salida = JSON.parse(docker('inspect', SALIDA))[0];
comprobar('la pasarela de salida no publica puertos', Object.values(salida.NetworkSettings.Ports ?? {}).every((v) => !v || v.length === 0));
comprobar('n8n no tiene variables de producción (claves, tokens)', !(n8n.Config.Env ?? []).some((e) => /^(TRADYLOR_|OPENAI|ANTHROPIC|GROQ|GEMINI|FLUX|SCRAPER|APIFY|GITHUB|ADMIN_)/i.test(e)));

const lista = intentar('exec', N8N, 'n8n', 'list:workflow');
comprobar('el n8n de pruebas NO contiene workflows de producción', lista.ok && !/producci[oó]n/i.test(lista.salida), lista.ok ? '' : 'no se pudo listar');

// 2) Pruebas reales desde dentro de n8n: NADA ajeno debe responder
for (const url of ['https://treidilor.com/api/health', 'https://www.treidilor.com/', 'http://treidilor.com/', 'https://1.1.1.1/', 'http://93.184.216.34/', 'https://example.com/']) {
  comprobar(`SIN salida a ${url}`, !pedir(url).ok);
}
comprobar('SIN salida al anfitrión por su IP de puerta de enlace (host.docker.internal no resuelve)', !pedir('http://host.docker.internal:4350/api/health', 4).ok);
comprobar('SIN salida a otros puertos de la pasarela', !pedir('http://puente-treidilor:80/', 4).ok && !pedir('http://puente-treidilor:5678/', 4).ok);
comprobar('SIN salida a la API de Docker ni a servicios locales', !pedir('http://172.17.0.1:2375/version', 4).ok);

// 3) La única puerta funciona (si el Treidilor de pruebas está arrancado)
if (!sinServidor) {
  const r = intentar('exec', N8N, 'wget', '-q', '-T', '8', '-O', '-', 'http://puente-treidilor:4350/api/health');
  comprobar('la única puerta (puente-treidilor:4350) llega al Treidilor de pruebas', r.ok && /"status":"ok"/.test(r.salida));
}

const fallos = resultados.filter((r) => !r.ok).length;
console.log(fallos ? `\n✖ AISLAMIENTO NO GARANTIZADO (${fallos} fallo/s). No importes ni ejecutes nada.` : '\n✔ Aislamiento comprobado: el n8n de pruebas no puede alcanzar nada salvo el Treidilor de pruebas.');
process.exit(fallos ? 1 : 0);
