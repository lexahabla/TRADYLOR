# F2 — Diagnóstico de compatibilidad en el n8n de producción (2.38.6) — instrucciones para hacerlo desde la interfaz

> ## ESTADO: HECHA (12/11/2026) — resultado **OK**
> Ejecutado por el administrador desde la interfaz, una sola vez: `resultado: OK`, `total: 34`, `fallos: []`, `sinRed: true`, `versionAgente: 0.2.0`; el nodo HTTP 4.2 deshabilitado se cargó sin errores visibles; sin peticiones externas. Conclusión: el entorno Code, los tipos/versiones de nodo y el flujo del Auditor son compatibles con n8n 2.38.6. **Sin verificar aún**: que la ejecución usara el runner externo (se confirma en `F2B-CIERRE-PENDIENTES-ANTES-DE-F3.md`, B3) y los valores efectivos de retención. Siguiente: cerrar los pendientes de `F2B-…` antes de pedir F3.

Alcance autorizado: **solo** importar (desactivado) y ejecutar **una vez, a mano** `automation/dev/diagnostico-auditor-produccion.json`. No activar, no programar, no ejecutar `auditor-general.produccion`, no tocar Treidilor, PostgreSQL, EasyPanel, el VPS ni n8n (ni actualizar). Claude no tiene acceso al n8n de producción y no lo ha buscado.

## 0. Verificación previa del fichero (hecha, en local)
`node scripts/automation/verificar-fichero-diagnostico.mjs` → **13/13 correcto**: no activo; sin credenciales, `pinData` ni datos fijados; solo 4 nodos (disparador manual, Code, nota, un nodo HTTP **deshabilitado y sin conexiones**); sin programación/webhooks/MCP; sin Execute Command, SSH, bases de datos ni escritura; el código no tiene red (`fetch`, `new URL`, helpers HTTP), ni `require/process/eval`, ni secretos, ni cabeceras `Authorization`.
**SHA-256 (con saltos de línea LF): `e1e5e34a89a2d66020f72573af07b5f82a359afedf45a57fa434e066c53328fe`**
Fichero: `D:\AXEL\WEBS\TRADYLOR\tradylor_web\automation\dev\diagnostico-auditor-produccion.json` (49 KB). Si quieres comprobarlo en tu PC: `node scripts/automation/verificar-fichero-diagnostico.mjs` debe imprimir esa misma huella.

## 1. Antes de empezar (2 minutos, solo mirar)
- Abre en EasyPanel `practice_project_n8n` → `n8n-runner` → **Logs** y déjalo visible (o anota la hora). Servirá para confirmar que el código Code se ejecuta en el runner.
- Anota la versión visible en n8n (*avatar → About n8n*): debe ser 2.38.6.

## 2. Importar (desactivado)
1. n8n → *Workflows* → botón **⋯ / Import from file** (o en un workflow nuevo: *⋯ → Import from File*) → elige el fichero.
2. Se crea «**Treidilor AI · Diagnóstico del entorno (Auditor, sin red)**». Comprueba, **sin ejecutar todavía**:
   - Interruptor **Inactive** (no lo actives).
   - 4 nodos: *Ejecutar a mano*, nota «Aviso», *Diagnóstico* y *Prueba de versión (deshabilitado)* (gris, sin conexiones).
   - **Ningún nodo con «?» o aviso de «nodo/versión no instalado»**. Abre *Prueba de versión (deshabilitado)* → en *Settings* debe verse «Version 4.2». ← **comprobación de compatibilidad del nodo HTTP.**
   - Ningún nodo pide credenciales.
   Si algo de esto falla: **no ejecutes nada**, anota el mensaje y para.

## 3. Ejecutar UNA vez
*Execute workflow* (manual, botón grande). No hace ninguna petición de red. Debería tardar segundos.

## 4. Qué mirar (nodo «Diagnóstico», pestaña *JSON*)
- `resultado`: **"OK"** y `fallos`: `[]` · `total`: 34 · `sinRed`: `true` · `versionAgente`: `0.2.0`.
- En `comprobaciones`, grupo `entorno`: todas `ok: true`; la fila «URL global (informativo)» dice si existe `URL` (en 2.46.6 no existe; da igual, el Auditor no la usa).
- Si hay `fallos`: copia **solo** ese campo.
- En los Logs de `n8n-runner`: ¿aparece actividad (tarea recibida/ejecutada) durante la ejecución? → confirma modo externo.
- *Executions*: una ejecución manual «Success», solo 2 nodos ejecutados (*Ejecutar a mano*, *Diagnóstico*).

## 5. Cerrar
1. Copia el JSON del nodo «Diagnóstico» (no contiene secretos) y pégalo en la plantilla de abajo.
2. Reversión: *Workflows → ⋯ → Delete* del diagnóstico (y su ejecución en *Executions*) **o** déjalo inactivo hasta que lo revisemos. No hay nada más que deshacer.
3. **Detente**: cualquier paso siguiente (importar el Auditor, ejecutarlo) es otra autorización.

## Plantilla de resultados (rellénala y pásamela)
| Punto | Resultado |
|---|---|
| Versión n8n visible | |
| Importación sin «?» ni credenciales pedidas | sí / no |
| Nodo HTTP deshabilitado: versión mostrada | 4.2 / otra / «?» |
| `resultado` / `total` / `fallos` | |
| Fila «URL global» | existe / no existe |
| Logs de `n8n-runner` con actividad durante la ejecución | sí / no / no sé |
| Duración de la ejecución | |
| Errores o avisos de n8n | |
| ¿Se activó o programó algo? | no |
| Diagnóstico borrado / dejado inactivo | |

## Cómo interpreto el resultado
- **OK + nodo 4.2 sin «?»** → el entorno Code, los nodos y el runner son compatibles con el Auditor; se puede pedir autorización para la F3 (importar el Auditor desactivado).
- **FALLO en `entorno`** → el runner no soporta alguna función que usa el Auditor: se corrige en `automation/lib` y se regenera (sin tocar tu n8n).
- **«?» en el nodo HTTP** → 2.38.6 no reconoce HTTP 4.2: habría que bajar la versión del nodo, no actualizar n8n.
- Pendiente aparte (no bloquea F2, sí F3-F6): restauración aislada de la copia, y copia independiente de PostgreSQL (hoy solo hay snapshots semanales del VPS; el Auditor no escribe en la base más que el historial de ejecuciones de n8n).
