#!/usr/bin/env node
/**
 * Simulación de reparación del catálogo (NO escribe nada salvo con --out).
 *
 * Uso (siempre sobre una COPIA del products.json de producción):
 *   node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/repair-catalog.mjs <products.json>
 *       -> informe en pantalla (dry-run); no escribe ficheros.
 *   ... <products.json> --find fineblue
 *       -> muestra marca de cabecera, «Marca» de specs y procedencia de los productos que contengan el texto.
 *   ... <products.json> --out reparado.json --rollback reversion.json
 *       -> escribe una COPIA reparada y el parche inverso. Nunca sobrescribe la entrada.
 *   ... reparado.json --undo reversion.json --out restaurado.json
 *       -> restaura los valores anteriores.
 */
import fs from 'node:fs';
import path from 'node:path';
import { planRepairs, applyPlan, applyRollback } from '../src/lib/catalogRepair.ts';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--') && fs.existsSync(a));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!input) {
  console.error('Indica la ruta de un products.json (una copia, no el fichero vivo).');
  process.exit(1);
}
const products = JSON.parse(fs.readFileSync(input, 'utf8'));
const out = opt('out');
if (out && path.resolve(out) === path.resolve(input)) {
  console.error('--out no puede ser el fichero de entrada.');
  process.exit(1);
}

if (opt('undo')) {
  const rollback = JSON.parse(fs.readFileSync(opt('undo'), 'utf8'));
  const restored = applyRollback(products, rollback);
  if (!out) { console.error('Falta --out para escribir el resultado.'); process.exit(1); }
  fs.writeFileSync(out, JSON.stringify(restored, null, 2));
  console.log(`Restaurados ${rollback.length} registros -> ${out}`);
  process.exit(0);
}

const find = opt('find');
if (find) {
  const needle = find.toLowerCase();
  const hits = products.filter((p) => JSON.stringify(p).toLowerCase().includes(needle));
  console.log(`${hits.length} producto(s) con «${find}»`);
  for (const p of hits) {
    const specs = p.specs ?? {};
    const specBrand = Object.entries(specs).find(([k]) => /^(marca|brand|fabricante)$/i.test(k.trim()));
    console.log(JSON.stringify({
      id: p.id, title: p.title, network: p.network, merchant: p.merchant,
      cabecera_brand: p.brand ?? null, specs_marca: specBrand ? specBrand[1] : null,
      fieldSources: p.extra?.fieldSources ?? null, lockedFields: p.extra?.lockedFields ?? null,
      importSource: p.extra?.importSource ?? null, sourceId: p.sourceId ?? p.asin ?? null,
    }, null, 2));
  }
  process.exit(0);
}

const plan = planRepairs(products);
console.log('Resumen de la simulación:', plan.summary);
for (const item of plan.items.slice(0, 200)) console.log(`- [${item.kind}] ${item.id}: ${item.detail}${Object.keys(item.patch).length ? '' : '  (sólo informe)'}`);

if (out) {
  const { products: repaired, rollback } = applyPlan(products, plan);
  const rollbackPath = opt('rollback') ?? out.replace(/\.json$/, '') + '.rollback.json';
  fs.writeFileSync(out, JSON.stringify(repaired, null, 2));
  fs.writeFileSync(rollbackPath, JSON.stringify(rollback, null, 2));
  console.log(`Copia reparada: ${out} · reversión: ${rollbackPath} (${rollback.length} registros tocados)`);
} else {
  console.log('\nDry-run: no se ha escrito nada. Usa --out para generar una copia reparada y su reversión.');
}
