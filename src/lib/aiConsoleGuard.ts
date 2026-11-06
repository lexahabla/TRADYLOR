/**
 * ==============================================================================
 * TREIDILOR — CONTROL DEL SERVIDOR PARA `opencode run` DESDE LA CONSOLA DE IA
 * ==============================================================================
 * `POST /api/admin/ai-console` con `mode:'opencode'` lanza el CLI `opencode` como un
 * proceso del sistema con herramientas de archivo y shell y el MISMO usuario que el
 * servidor: podría editar `/app/data/*.json` saltándose toda protección del catálogo.
 *
 * Por eso queda DESACTIVADO EN PRODUCCIÓN por un control del servidor (no sólo oculto en
 * la interfaz): la ruta responde 403 y `runOpencode` se niega a lanzar nada.
 *   - producción (`NODE_ENV=production`): desactivado salvo `OPENCODE_CONSOLE_ENABLED=true`;
 *   - desarrollo/local: activado salvo `OPENCODE_CONSOLE_ENABLED=false`.
 * El chat de la consola con los proveedores de IA por API (sin ejecutar nada en el
 * servidor), el Asistente OpenCode del catálogo (`/api/v1/admin/opencode-command`, que
 * llama a la API del proveedor) y las herramientas de enriquecimiento NO se ven afectados.
 * ==============================================================================
 */

export const OPENCODE_CONSOLE_DISABLED_MESSAGE =
  'La ejecución de opencode desde la consola está desactivada en este servidor (producción). Para habilitarla de forma consciente define OPENCODE_CONSOLE_ENABLED=true en el entorno del servidor; usa la Terminal de Easy Panel para trabajar con opencode.';

export function isOpencodeConsoleEnabled(): boolean {
  const flag = String(process.env.OPENCODE_CONSOLE_ENABLED ?? '').trim().toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}
