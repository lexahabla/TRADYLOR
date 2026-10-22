/**
 * Comprueba que los bloques <script is:inline> de los .astro son JavaScript
 * VÁLIDO.
 *
 * Por qué: los scripts con `is:inline` NO los procesa Astro/Vite (no pasan por
 * esbuild). El navegador recibe el código tal cual, así que cualquier
 * anotación de TypeScript (`let x: string[] = []`, `function f(a: number)`,
 * `as any`, `interface`…) provoca un error de sintaxis que mata el script
 * ENTERO: la página se queda sin JS (filtros que no se pintan, paginación que
 * no responde, botones muertos) sin ningún aviso en el HTML.
 *
 * Uso:  npm run check:inline        (también se ejecuta dentro de `npm run build`)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.astro', '.kilo']);
const INLINE_SCRIPT_RE = /<script\s+is:inline[^>]*>([\s\S]*?)<\/script>/gi;

/** Lista recursivamente los .astro del proyecto. */
function findAstroFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findAstroFiles(full, out);
    else if (extname(entry.name) === '.astro') out.push(full);
  }
  return out;
}

const files = findAstroFiles(join(ROOT, 'src'));
let failures = 0;
let checked = 0;

for (const file of files) {
  const source = readFileSync(file, 'utf-8');
  let match;
  let index = 0;
  INLINE_SCRIPT_RE.lastIndex = 0;
  while ((match = INLINE_SCRIPT_RE.exec(source)) !== null) {
    index += 1;
    checked += 1;
    const code = match[1];
    if (!code.trim()) continue;
    try {
      // vm.Script compila sin ejecutar: valida la sintaxis como lo haría el
      // navegador con un script clásico.
      new vm.Script(code, { filename: `${file}#is:inline-${index}` });
    } catch (error) {
      failures += 1;
      const rel = file.slice(ROOT.length + 1);
      console.error(`✖ ${rel} · <script is:inline> #${index}: ${error.message}`);
      console.error('  → is:inline NO admite TypeScript: quita las anotaciones de tipo.');
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} script(s) is:inline con sintaxis inválida.`);
  process.exit(1);
}

console.log(`✔ ${checked} bloque(s) <script is:inline> comprobados en ${files.length} archivo(s) .astro: sintaxis correcta.`);
