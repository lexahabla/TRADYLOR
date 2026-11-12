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

**Regla de oro: el n8n de pruebas está aislado por RED (no por advertencias).** Vive en una red de Docker `internal`, sin ruta a Internet. Su única salida es una pasarela TCP que solo reenvía a `host.docker.internal:4350` (el Treidilor de pruebas) y su única entrada es `127.0.0.1:5678`. Por eso ningún workflow, expresión, redirección, CLI, MCP o API puede llegar a `treidilor.com`. Tras arrancar, **siempre** `node scripts/automation/comprobar-aislamiento.mjs` (pruebas reales desde dentro del contenedor). Los scripts de importación y ejecución lo repiten antes de actuar y se niegan a seguir si falla.

### 2.1 Treidilor de pruebas con datos saneados
```bash
node scripts/automation/make-test-data.mjs --from src/data --out D:/treidilor-pruebas/datos     # genera también un token general desechable (no se usa)
npm run build
# arrancar con el entorno VACÍO (sin claves de IA, SMTP ni tokens de producción) y la API de automatización activada SOLO aquí:
#   TRADYLOR_DATA_DIR=D:/treidilor-pruebas/datos PORT=4350 HOST=127.0.0.1 AUTOMATION_API_ENABLED=true node dist/server/entry.mjs
node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/automation/crear-cliente.mjs \
     --datos D:/treidilor-pruebas/datos --nombre n8n-pilotos --dias 7 --salida D:/treidilor-pruebas/token-automatizacion.txt
```
- La carpeta de pruebas solo contiene productos, categorías, secciones y retirados. **Nunca** usuarios, Mi Radar, credenciales, claves, analítica ni portada.
- `HOST=127.0.0.1` basta: la pasarela llega al anfitrión por `host.docker.internal` aunque el servicio escuche solo en loopback.
- El token de automatización se escribe **fuera del repositorio** (el script lo exige) y no se imprime.

### 2.2 n8n de pruebas
```bash
cp automation/dev/.env.n8n.example automation/dev/.env.n8n     # N8N_VERSION exacta (2.46.6 en el piloto) y N8N_ENCRYPTION_KEY aleatoria SOLO de pruebas
docker compose --env-file automation/dev/.env.n8n -f automation/dev/docker-compose.n8n.yml up -d
node scripts/automation/comprobar-aislamiento.mjs
node scripts/automation/importar-local.mjs --token D:/treidilor-pruebas/token-automatizacion.txt     # workflows *.local.* + credencial «Treidilor automatización (solo lectura)»
node scripts/automation/ejecutar-local.mjs --nombre "Auditor General" --salida D:/treidilor-pruebas/salidas --datos D:/treidilor-pruebas/datos
node scripts/automation/ejecutar-local.mjs --nombre "Investigador comercial" --salida D:/treidilor-pruebas/salidas --datos D:/treidilor-pruebas/datos
```
- Parar: `docker compose -f automation/dev/docker-compose.n8n.yml down`. Borrar TODO lo de pruebas: `… down -v` (+ borrar `D:\treidilor-pruebas`).
- `importar-local.mjs` solo admite `*.local.json`, conserva los ids (sobrescribe, no duplica) y nunca importa `*.produccion.*`. `ejecutar-local.mjs` solo ejecuta workflows cuyo nombre lleve «(local)», guarda el informe fuera del repositorio y falla si cambia cualquier fichero de datos de pruebas (huella SHA-256 antes/después).
- **Nunca** importar ni ejecutar `auditor-general.produccion.json` en pruebas: apunta a `https://treidilor.com`. (La red lo impide; además el comprobador de aislamiento falla si el n8n de pruebas contiene un workflow de producción.)

### 2.2 bis Hallazgos del n8n real (n8n 2.46.6)
- Entorno Code: **no existen `URL`, `URLSearchParams` ni `structuredClone`**; sí `Intl`, `Date`. El comprobador de seguridad rechaza esos globales. Diagnóstico: importar y ejecutar `automation/dev/diagnostico-entorno-code.json`.
- Nodo HTTP (v4.2, respuesta completa + texto): entrega `{ data, headers, statusCode, statusMessage }` (no `body`).
- Los workflows se generan con `tags: []` (el CLI falla con etiquetas en forma de texto).
- `n8n execute` necesita `N8N_RUNNERS_BROKER_PORT` distinto del de la instancia (lo hace `ejecutar-local.mjs`).
- Git Bash de Windows: anteponer `MSYS_NO_PATHCONV=1` a `docker cp/exec` con rutas `/tmp/…` (los scripts ya lo hacen).
- Las fichas de producto NO se visitan por defecto (`maxFichas: 0`): cada visita escribe `priceHistory` y un `page_view`.
- El feed se pide por páginas SOLO si existen (`totalPages` de la primera respuesta); los nodos «Pedir … (resto)» reciben un marcador `/api/health` cuando no hay más páginas.
- `diagnostico-aislamiento.json` (en `automation/dev/`): comprueba desde el nodo HTTP (con redirecciones activadas) que la pasarela responde y que `example.com`, una IP externa y `localhost` fallan.

### 2.3 Propietario y MCP del n8n de pruebas (C3)
- El propietario se creó por la API de configuración con un correo ficticio (`pruebas@example.com`) y una contraseña aleatoria guardada en `D:\treidilor-pruebas\n8n-propietario.txt` (fuera del repositorio). Se puede cambiar en *Settings → Personal* al entrar en `http://127.0.0.1:5678`.
- MCP: ver `MCP-N8N.md` (mecanismo, herramientas, **limitaciones**: la clave MCP no tiene alcances). Solo contra el n8n local.

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
