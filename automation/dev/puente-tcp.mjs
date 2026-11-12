// Pasarela TCP mínima para el aislamiento del n8n de pruebas (Treidilor AI). Sin dependencias.
//
// Reenvía las conexiones de UN puerto local a UN destino fijo (host:puerto) y no hace nada más: no interpreta HTTP, no sigue redirecciones,
// no resuelve nombres que no sean el destino configurado. Es la única "puerta" del n8n de pruebas, que vive en una red de Docker SIN salida a Internet.
//
//   PUENTE_ESCUCHA=4350 PUENTE_DESTINO_HOST=host.docker.internal PUENTE_DESTINO_PUERTO=4350 node puente-tcp.mjs
import net from 'node:net';

const escucha = Number(process.env.PUENTE_ESCUCHA);
const host = String(process.env.PUENTE_DESTINO_HOST ?? '');
const puerto = Number(process.env.PUENTE_DESTINO_PUERTO);
const nombre = String(process.env.PUENTE_NOMBRE ?? 'puente');
const maxConexiones = Number(process.env.PUENTE_MAX_CONEXIONES ?? 64);

if (!Number.isInteger(escucha) || !Number.isInteger(puerto) || !/^[A-Za-z0-9.-]+$/.test(host)) {
  console.error(`[${nombre}] configuración no válida`);
  process.exit(2);
}

let activas = 0;
const servidor = net.createServer((entrada) => {
  if (activas >= maxConexiones) {
    entrada.destroy();
    return;
  }
  activas++;
  const salida = net.connect({ host, port: puerto });
  const cerrar = () => {
    entrada.destroy();
    salida.destroy();
  };
  entrada.setTimeout(10 * 60 * 1000, cerrar);
  entrada.pipe(salida);
  salida.pipe(entrada);
  entrada.on('error', cerrar);
  salida.on('error', cerrar);
  entrada.on('close', () => { activas--; salida.destroy(); });
  salida.on('close', () => entrada.destroy());
});
servidor.listen(escucha, '0.0.0.0', () => console.log(`[${nombre}] :${escucha} -> ${host}:${puerto} (único destino permitido)`));
