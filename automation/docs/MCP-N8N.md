# Conexión MCP de Claude con el n8n de pruebas (verificada con n8n 2.46.6)

> **Solo el n8n LOCAL de pruebas.** No se conecta, ni debe conectarse, a un n8n de producción sin una decisión expresa y un diseño de permisos propio.

## Mecanismo (comprobado)
n8n 2.46.6 trae un **servidor MCP integrado** (módulo `mcp`, "n8n MCP Server 1.2.0"), endpoint `http://127.0.0.1:5678/mcp-server/http` (Streamable HTTP). No hace falta instalar nada ni usar el nodo "MCP Server Trigger".
- Activarlo (propietario con sesión): `PATCH /rest/mcp/settings {"mcpAccessEnabled":true,"autoExposeNewWorkflows":false}` (equivale a *Settings → Instance-level MCP*). **Dejar `autoExposeNewWorkflows` en `false`.**
- Exponer un workflow: `PATCH /rest/mcp/workflows/toggle-access {"availableInMCP":true,"workflowIds":[…]}`. Solo los expuestos se pueden buscar/ejecutar. **Reimportar un workflow con `importar-local.mjs` puede quitar la marca: volver a exponerlo.**
- Clave: `GET /rest/mcp/api-key` (se ve **completa una sola vez**; después sale enmascarada; `POST /rest/mcp/api-key/rotate` genera otra). Se guarda fuera del repositorio (`D:\treidilor-pruebas\n8n-mcp-clave.txt`).
- Registro en Claude Code (ámbito local, no entra en el repositorio):
  `claude mcp add --transport http --scope local n8n-pruebas http://127.0.0.1:5678/mcp-server/http --header "Authorization: Bearer $(cat <fichero de la clave>)"`.
  Las herramientas aparecen en una sesión NUEVA de Claude Code. Estado: `claude mcp list` → `n8n-pruebas … ✔ Connected`.

## Qué permite realmente (herramientas devueltas por `tools/list`: 55)
- **Lectura**: buscar workflows, detalles, historial y versiones, ejecuciones, credenciales (solo metadatos: id, nombre, tipo; **no** los valores), etiquetas, proyectos, nodos y sus tipos.
- **Ejecución**: `execute_workflow` (obligatorio `executionMode`): `manual` funciona con nuestros workflows (trigger manual) y se ve en el historial; `production` falla si el workflow no está publicado. `test_workflow` con datos fijados.
- **Escritura**: `create_workflow_from_code`, `update_workflow`, `restore_workflow_version`, `archive_workflow`, **`publish_workflow`/`unpublish_workflow`** (activar/desactivar), carpetas, tablas de datos (crear, renombrar, añadir/borrar columnas, insertar filas), agentes (crear, mutar, publicar, borrar).

## Limitaciones y riesgos (importantes)
1. **La clave MCP no tiene alcances (`scopes: []`)**: actúa con los permisos completos del usuario propietario de la instancia. Solo la exposición por workflow (`availableInMCP`) limita lo que se puede *buscar/ejecutar*; **crear, editar, archivar y publicar workflows no queda limitado por esa marca**.
2. Por tanto, MCP **no** es un canal "de solo lectura". Es aceptable aquí porque el n8n de pruebas está aislado por red (ver abajo) y sus datos son desechables. En producción exigiría un propietario/proyecto dedicado y una revisión propia.
3. El **bloqueo de red aplica igual por MCP**: probado ejecutando por MCP el workflow de diagnóstico (`automation/dev/diagnostico-aislamiento.json`): la pasarela responde (200) y example.com / IP externa / localhost fallan (`EAI_AGAIN`, `ENETUNREACH`, `ECONNREFUSED`).
4. Los workflows de la plantilla de producción (`*.produccion.*`) **no están** en el n8n de pruebas y `importar-local.mjs` los rechaza. Si alguien los crea por MCP, el bloqueo de red impide que lleguen a `treidilor.com`.
5. La clave caduca al rotarla o si se borra el volumen. Si se filtra: `POST /rest/mcp/api-key/rotate` y `claude mcp remove n8n-pruebas`.
6. Una ejecución por MCP no devuelve el informe en la respuesta inmediata: se consulta con `get_workflow_execution` (`includeData:true`).

## Reglas de uso
- Solo workflows `(local)`. Nunca `publish_workflow`/programaciones sin autorización expresa. Nunca `list_credentials` para extraer valores (no los da) ni crear credenciales con claves reales.
- El procedimiento habitual sigue siendo `scripts/automation/importar-local.mjs` + `ejecutar-local.mjs` (reproducibles y con comprobación de aislamiento y de integridad de datos); MCP sirve para iterar e inspeccionar.
