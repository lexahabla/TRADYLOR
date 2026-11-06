/**
 * Reconstruye la IDENTIDAD de productos eliminados ANTES de que existiera la memoria por identidad
 * (sólo se guardó su id). Busca la ficha en las copias de seguridad que aún existan
 * (`<datos>/backups/**` y `<datos>/import-backups/**`).
 *
 *   node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/backfill-deleted-identities.mjs          # simulación
 *   node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/backfill-deleted-identities.mjs --apply  # escribe
 *
 * Usa el directorio de datos configurado (`TRADYLOR_DATA_DIR`, por defecto `src/data`). Las eliminaciones cuya
 * ficha ya no está en ninguna copia NO se pueden reconstruir: siguen protegidas sólo por id.
 */
import { backfillDeletedIdentities } from '../src/lib/deletedIdentity.ts';

const apply = process.argv.includes('--apply');
const report = backfillDeletedIdentities({ apply });
console.log(apply ? 'MODO ESCRITURA' : 'SIMULACIÓN (usa --apply para escribir)');
console.log('Copias revisadas:', report.scanned.length);
console.log('Con identidad (ya registradas):', report.alreadyIdentified.length);
console.log('Reconstruibles desde copias:', report.recovered.length, report.recovered);
console.log('No reconstruibles (sólo protegidas por id):', report.unrecoverable.length, report.unrecoverable);
