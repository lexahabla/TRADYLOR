#!/usr/bin/env node
// GENERADOR DE DATOS DE PRUEBA SANEADOS para la instancia local de Treidilor que usan los agentes en el entorno de pruebas.
// Copia ÚNICAMENTE una lista blanca de ficheros del catálogo (productos, categorías, secciones y retirados) desde una carpeta de datos y
// escribe en otra carpeta NUEVA. Nunca copia usuarios, Mi Radar, credenciales, claves de IA, analítica, portada, historias ni copias.
// Además genera un token DESECHABLE (sólo para esa instancia de pruebas; no es el de producción) en `<salida>/.token-pruebas`.
//
//   node scripts/automation/make-test-data.mjs --from <carpeta_datos> --out <carpeta_nueva>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LISTA_BLANCA = ['products.json', 'categories.json', 'sections.json', 'deleted-product-ids.json'];
/** Nombres (o fragmentos) que NUNCA deben aparecer en la salida. */
export const PROHIBIDOS = [/users/i, /radar/i, /credential/i, /ai-keys/i, /analytics/i, /price-alert/i, /home-/i, /nav-top/i, /backup/i, /\.bak$/i, /\.env/i, /secret/i, /token/i, /avatars/i, /images/i, /opencode/i];

export function generarDatosPrueba({ desde, salida }) {
  const o = path.resolve(salida);
  const d = path.resolve(desde);
  if (o === d || o.startsWith(`${d}${path.sep}`) || d.startsWith(`${o}${path.sep}`)) throw new Error('La salida no puede estar dentro de la carpeta de origen (ni al revés)');
  if (fs.existsSync(o) && fs.readdirSync(o).length) throw new Error('La carpeta de salida debe estar vacía o no existir (nunca se sobrescribe)');
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error('La carpeta de origen no existe');
  fs.mkdirSync(o, { recursive: true });
  const copiados = [];
  for (const nombre of LISTA_BLANCA) {
    if (PROHIBIDOS.some((re) => re.test(nombre))) throw new Error(`Lista blanca inválida: ${nombre}`);
    const origen = path.join(d, nombre);
    if (!fs.existsSync(origen)) continue;
    const texto = fs.readFileSync(origen, 'utf8');
    JSON.parse(texto); // debe ser JSON válido
    fs.writeFileSync(path.join(o, nombre), texto);
    copiados.push(nombre);
  }
  if (!copiados.includes('products.json')) {
    fs.rmSync(o, { recursive: true, force: true });
    throw new Error('El origen no tiene products.json');
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(path.join(o, '.token-pruebas'), `${token}\n`, { mode: 0o600 });
  // Comprobación final: nada prohibido en la salida (salvo el propio token desechable)
  const presentes = fs.readdirSync(o).filter((f) => f !== '.token-pruebas');
  const malos = presentes.filter((f) => PROHIBIDOS.some((re) => re.test(f)) || !LISTA_BLANCA.includes(f));
  if (malos.length) {
    fs.rmSync(o, { recursive: true, force: true });
    throw new Error(`Ficheros no permitidos en la salida: ${malos.join(', ')}`);
  }
  return { copiados, token: '(guardado en .token-pruebas)', salida: o };
}

if (process.argv[1]?.endsWith('make-test-data.mjs')) {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const desde = get('--from');
  const salida = get('--out');
  if (!desde || !salida) {
    console.error('Uso: make-test-data.mjs --from <carpeta_datos> --out <carpeta_nueva>');
    process.exit(2);
  }
  try {
    const r = generarDatosPrueba({ desde, salida });
    console.log(`Datos de prueba creados en ${r.salida}: ${r.copiados.join(', ')}`);
    console.log('Token desechable de la instancia de pruebas: .token-pruebas (no se muestra).');
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(1);
  }
}
