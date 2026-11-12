# Procedimientos de Treidilor AI

> Todo lo marcado **(requiere autorización)** NO se ha ejecutado. Este documento es el procedimiento a seguir cuando se autorice.

## 1. Desarrollo y versionado de workflows (sin n8n)
1. Rama de trabajo (`feature/…`). Nunca trabajar sobre `main`.
2. Editar la lógica en `automation/lib/*.mjs` y su prueba en `scripts/tests/automation-*.test.mjs`.
3. `node scripts/automation/build-workflows.mjs --write` (regenera `automation/workflows/*.json`).
4. `node scripts/automation/lint-workflows.mjs` (comprobador de seguridad) y `--check` (sincronía) y `npm test`.
5. Revisar el *diff* de los JSON (legible: claves ordenadas, ids estables, credenciales por nombre).
6. Commit local. Etiquetar las versiones desplegadas a n8n: `workflows-vN`.

**Workflows creados o modificados en n8n** (con Claude conectado a la instancia de pruebas): exportarlos con `n8n export:workflow` (o por MCP/API), pasarlos por `normalize-workflow.mjs --write` y por el comprobador antes de guardarlos. Si algo del JSON no se puede generar desde `lib`, se documenta aquí.

## 2. Entorno de pruebas local (requiere autorización: C1, C2, C3)
### 2.1 Treidilor de pruebas con datos saneados
```bash
node scripts/automation/make-test-data.mjs --from <carpeta de datos local> --out <carpeta nueva, p. ej. D:/treidilor-pruebas/datos>
npm run build
# arrancar (variables sólo para este proceso; el token desechable está en <carpeta>/.token-pruebas):
TRADYLOR_DATA_DIR=<carpeta nueva> TRADYLOR_API_TOKEN="$(cat <carpeta nueva>/.token-pruebas)" PORT=4350 HOST=127.0.0.1 node dist/server/entry.mjs
```
- La carpeta de datos de pruebas sólo contiene productos, categorías, secciones y retirados. **Nunca** usuarios, Mi Radar, credenciales, claves, analítica ni portada.
- `HOST=127.0.0.1`: en Docker Desktop, `host.docker.internal` suele alcanzar servicios del anfitrión ligados a loopback (**por comprobar**). Si no, usar `HOST=0.0.0.0` **sólo** con el cortafuegos de Windows bloqueando entradas externas al puerto 4350.
- Parar: cerrar el proceso. Borrar: eliminar la carpeta de pruebas.

### 2.2 n8n de pruebas
```bash
cp automation/dev/.env.n8n.example automation/dev/.env.n8n     # rellenar N8N_VERSION (exacta) y N8N_ENCRYPTION_KEY (sólo de pruebas)
docker compose --env-file automation/dev/.env.n8n -f automation/dev/docker-compose.n8n.yml up -d
# abrir http://127.0.0.1:5678 → crear el propietario local
```
- Sólo escucha en `127.0.0.1`, sin telemetría, sin nodos de comunidad, sin `Execute Command`, límites de CPU/RAM.
- Crear la credencial **«Treidilor pruebas (solo lectura)»** (tipo *Header Auth*; nombre de cabecera `Authorization`; valor `Bearer <contenido de .token-pruebas>`). El nombre debe terminar en «(solo lectura)»: lo exige el comprobador.
- Importar los workflows locales (`auditor-general.local.json`, `investigador-comercial.local.json`): *Workflows → Import from file*. Quedan **desactivados**. Asignar la credencial en el nodo «Pedir catálogo».
- Ejecutar a mano («Execute workflow»). Verificar el informe en la salida del nodo «Informe».
- Parar: `docker compose -f automation/dev/docker-compose.n8n.yml down`. Borrar TODO lo de pruebas: `… down -v`.

### 2.3 Conectar a Claude al n8n de pruebas (C3)
Opción preferida (si la versión es ≥ 2.13): en n8n *Settings → Instance-level MCP → Enable MCP access* y marcar «Available in MCP» sólo los workflows de prueba; luego, en Claude Code:
```bash
claude mcp add --transport http n8n-pruebas http://127.0.0.1:5678/mcp-server/http     # ámbito local; autorizar por OAuth
```
Alternativa: API key de la instancia **de pruebas** guardada fuera del repositorio. En una instalación Community la clave tiene control total de esa instancia (no hay alcances): por eso sólo se usa contra el n8n de pruebas y nunca contra producción. Verificar que la extensión de Claude en Antigravity ve el servidor MCP (si no, usar la CLI `claude` desde su terminal).

## 3. Despliegue controlado al n8n de producción del VPS (requiere autorización: C6, C9)
**Puerta 0 — antes de nada:** n8n y Treidilor verificados (`FALTA-PARA-EJECUTAR.md`), copia reciente y **restauración probada**.
1. Elegir el workflow a desplegar y comprobar que `auditor-general.produccion.json` (o el que toque) está sincronizado y limpio de errores: `lint-workflows.mjs` y `build-workflows.mjs --check`.
2. **Exportar** el estado actual de producción como punto de retorno (`n8n export:workflow --backup --output=…`).
3. Si la URL base cambia (p. ej. servicio interno de Easy Panel en vez de `https://treidilor.com`), editar `automation/config/produccion.json` (`baseUrl` y `hostsPermitidos`), regenerar y volver a pasar el comprobador. La política sigue exigiendo https fuera de local.
4. **Importar** (`n8n import:workflow --input=… `): queda **desactivado**.
5. Crear a mano las credenciales (el piloto de producción no lleva ninguna).
6. **Ejecutar manualmente** una vez; revisar el informe y que sólo se hicieron peticiones GET a páginas públicas (n8n → *Executions*).
7. **Activación/programación** (p. ej. una vez al día fuera de horas punta): sólo con autorización expresa; primera semana con revisión diaria.
8. **Retorno:** desactivar el workflow y, si procede, volver a importar la versión anterior.

**Producción sin depender del PC:** los workflows son autosuficientes (el código va incrustado) y el n8n del VPS los ejecuta con su propio programador. El PC sólo se necesita para desarrollar. Lo único que NO puede funcionar sin cambios en el VPS es el **Investigador** (necesita el feed del catálogo con un token de lectura propio: Etapa 2.2).

## 4. Copias de seguridad y restauración (diseño; requiere autorización y datos del VPS)
| Qué | Cómo | Frecuencia |
|---|---|---|
| VPS completo | *Snapshots* de Hostinger (verificar plan) | diaria |
| Datos de Treidilor (`/app/data`) | copia del volumen con comprobación de sumas; hoy `scripts/data-backup.mjs` exige el servicio parado y excluye imágenes → decidir copia con parada breve nocturna o snapshot | diaria |
| n8n | carpeta `.n8n` (incluye la **clave de cifrado**) o volcado de PostgreSQL; con SQLite, con n8n parado | diaria |
| Workflows | `n8n export:workflow --backup` + Git | tras cada cambio |
**Restauración aislada (obligatoria antes de permitir escrituras):** restaurar la última copia en el Docker local (Treidilor de pruebas + n8n de pruebas), ejecutar las pruebas de humo y registrar el tiempo y los pasos.

## 5. Parada y recuperación
- **Parada inmediata de un agente:** desactivar el workflow en n8n (o su credencial).
- **Parada global (Etapa 2.2):** `AUTOMATION_ENABLED=false` en Treidilor + desactivación de tokens.
- **Recuperación:** restaurar copia; re-importar la versión anterior de los workflows (`workflows-vN`); en Treidilor, etiqueta `pre-…` del despliegue anterior.
- **Se prohíbe** que un workflow se active por sí mismo o se importe con `active: true` (el comprobador lo rechaza).

## 6. Auditoría y observabilidad
- **Ahora (v0):** historial de ejecuciones de n8n; cada petición lleva `User-Agent: TreidilorAI-<agente>/0.1 (solo lectura)` y `X-Treidilor-Agente`.
- **Etapa 2.2:** registro de auditoría de Treidilor (quién, qué, resultado, id de ejecución de n8n).
