# Prueba local aislada de Data Tables (n8n 2.38.6 + PostgreSQL 17) — previa a la entrega 2c

Estado (12/11/2026): **PREPARADA, NO EJECUTADA.** Nada de esto se ha arrancado: no se ha descargado ninguna imagen, no se ha iniciado ningún contenedor y no se ha ejecutado ningún workflow. Cada paso marcado 🔒 necesita autorización expresa.

Objetivo: comprobar, en un n8n 2.38.6 **de pruebas**, lo que necesita el almacenamiento del estado del Auditor con instantáneas inmutables (Get + Insert): inserción, lectura ordenada, tamaño de celda, duplicados, ejecuciones manuales, reconstrucción determinista, y qué `typeVersion` y qué referencia a la tabla se guardan en el JSON.

## 1. Qué hay ya en el PC (comprobado en solo lectura)
| Recurso | Estado |
|---|---|
| Daemon de Docker Desktop (29.9.2) | **En marcha** (no se ha arrancado nada) |
| Imagen `n8nio/n8n:2.38.6` | **NO existe** localmente: hay que descargarla 🔒 (≈ 1,2 GB) |
| Imagen `postgres:17` | **NO existe** localmente: hay que descargarla 🔒 (≈ 0,45 GB) |
| Imagen `node:22-bookworm-slim` | Existe (se reutiliza para la pasarela de entrada) |
| Imágenes `n8nio/n8n:2.46.6` / `:latest` | Existen (las usa el n8n de pruebas de los agentes) |
| Imagen `n8nio/runners` | No existe ni hace falta (ver §8) |
| **Stack `treidilor-ai-pruebas`** (n8n 2.46.6 + 2 pasarelas) | **Está arrancado ahora mismo** (Up ≈ 6 h) con el volumen `treidilor_n8n_pruebas_datos`. **La prueba no lo toca.** Hay además un contenedor `n8n` parado (hace 6 días) y un volumen `n8n_data`, ajenos a la prueba |
| Espacio Docker | 1,4 GB de imágenes, 41 MB de volúmenes, 858 MB de caché de build recuperable |

## 2. Lo que dice el código fuente de n8n 2.38.6 (leído de GitHub, **no ejecutado**)
Etiqueta `n8n@2.38.6`. Son hechos del código; la prueba debe confirmarlos en la instalación.
- Nodo `n8n-nodes-base.dataTable`, `typeVersion` `[1, 1.1]` (1.1 convierte las fechas a ISO). Operaciones de fila: `insert`, `get`, `update`, `upsert`, `deleteRows`, `rowExists`, `rowNotExists`; de tabla: `create`, `delete`, `update`, `list`, `clear`. Referencia a la tabla: `dataTableId` = `{"__rl":true,"mode":"list"|"name"|"id","value":…}`.
- **Get**: todos sus parámetros van en el nivel superior (`returnAll`, `limit`, `orderBy`, `orderByColumn`, `orderByDirection`, `matchType`, `filters.conditions[]`). Con `returnAll` y `orderBy` el orden se respeta; sin `orderBy` el orden es `id` ascendente. Sin coincidencias no hay salida.
- **Insert**: `columns.mappingMode`/`columns.value`; `options.optimizeBulk`. Una fila por sentencia, dentro de una transacción; devuelve las filas completas (con `id`, `createdAt`, `updatedAt`).
- **Tipos**: `string` = `TEXT` en PostgreSQL **y** SQLite (sin `VARCHAR(n)`); **no se encontró validación de longitud de celda**; el único límite es el almacenamiento total de la instancia (`N8N_DATA_TABLES_MAX_SIZE_BYTES`, 200 MiB por defecto), comprobado **antes** de cada insert/update y cacheado 5 s.
- **Update**: en PostgreSQL es **una sola sentencia** `UPDATE … WHERE … RETURNING` (devuelve las filas actualizadas; 0 coincidencias = 0 elementos). **Upsert** = update y, si no actualiza nada, insert dentro de una transacción, **sin bloqueo**: dos upserts simultáneos podrían duplicar. **No hay restricción única** sobre columnas de usuario (solo `id` y el nombre de la tabla por proyecto).
- Búsqueda por **nombre**: coincidencia por subcadena (`LIKE %nombre%`) sin comprobación exacta: usar un nombre único o el modo `id`.
- Un nodo Code **no** puede acceder a las Data Tables. El código del nodo no tiene ramas distintas para ejecución manual o de producción (hipótesis: escribe igual).
Consecuencia: la actualización condicionada por `revision` parece viable y atómica en PostgreSQL (una sentencia que devuelve las filas), pero **no se ha probado**. La propuesta principal sigue siendo la de instantáneas inmutables (no depende de ello).

## 3. Entorno temporal (diseño)
Fichero: `automation/dev/prueba-data-tables/docker-compose.yml` (proyecto `tai-prueba-dt`). Sin nada de Treidilor:
| Aspecto | Diseño |
|---|---|
| Nombres | Proyecto `tai-prueba-dt`; contenedores `tai-dt-db`, `tai-dt-n8n`, `tai-dt-puente-entrada`; red `tai-dt-aislada`; volúmenes `tai_dt_pg`, `tai_dt_n8n`. Etiqueta `com.treidilor.prueba=data-tables` en todo |
| Red | `tai-dt-aislada` es `internal: true`: **sin Internet, sin anfitrión, sin otros contenedores**. No hay pasarela de salida. n8n tiene `httpRequest` excluido (`NODES_EXCLUDE`) |
| Entrada | Solo `127.0.0.1:5689` (editor, para la prueba manual) mediante la pasarela TCP ya existente. El n8n de los agentes sigue en 5678 |
| Datos | PostgreSQL **17 nuevo y vacío** (como producción). Ninguna conexión con la base de Treidilor, de producción ni de otros n8n |
| Secretos | Contraseña de BD y clave de cifrado **solo de pruebas**, aleatorias, en un fichero **fuera del repositorio** (`D:\treidilor-pruebas\prueba-dt\.env.prueba-dt`, ignorado por git). Nunca se imprimen. Sin credenciales reales ni datos de producción |
| Límites | n8n 1 GB / 1,5 CPU; PostgreSQL 512 MB; pasarela 128 MB. ≈ 1,7 GB de RAM adicionales |
| Cuota Data Tables | Se deja el valor por defecto (200 MiB), el mismo que rige en producción salvo que EasyPanel lo cambie |

## 4. Procedimiento exacto (PowerShell, desde la raíz del repositorio)
Todos los comandos llevan `-p tai-prueba-dt` y rutas propias: no afectan a los contenedores `treidilor-*`.

**P0 · Carpeta y secretos de pruebas (sin tocar Docker)**
```powershell
$dir = 'D:\treidilor-pruebas\prueba-dt'
New-Item -ItemType Directory -Force "$dir\workflows","$dir\salidas","$dir\exportados" | Out-Null
function Rnd { $b = New-Object byte[] 16; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') }) }
"PRUEBA_DT_N8N_VERSION=2.38.6`nPRUEBA_DT_PG_PASSWORD=$(Rnd)`nPRUEBA_DT_ENCRYPTION_KEY=$(Rnd)" | Set-Content -Encoding ascii "$dir\.env.prueba-dt"
```
✔ El fichero existe y **no se muestra**. Se generan además los workflows (sin Docker):
```powershell
node scripts/automation/prueba-data-tables.mjs generar --salida "$dir\workflows"   # 4 JSON: 1-escribir-y-leer, 2-leer, 3-origen, 4-limpiar
```

**P1 · 🔒 Descargar las dos imágenes (única conexión a Internet de todo el procedimiento)**
```powershell
docker pull n8nio/n8n:2.38.6
docker pull postgres:17
docker image ls --digests n8nio/n8n postgres        # anota las huellas (digest)
docker run --rm --network none n8nio/n8n:2.38.6 n8n --version      # ✔ 2.38.6
```

**P2 · 🔒 Arrancar el entorno**
```powershell
docker compose -p tai-prueba-dt --env-file "$dir\.env.prueba-dt" -f automation/dev/prueba-data-tables/docker-compose.yml up -d
docker inspect -f '{{.State.Health.Status}}' tai-dt-n8n     # repetir hasta «healthy»
```

**P3 · Comprobar el aislamiento ANTES de nada más** (todo debe cumplirse; si algo falla: `down -v` y parar)
```powershell
docker network inspect tai-dt-aislada -f '{{.Internal}}'                  # ✔ true
docker exec tai-dt-n8n wget -T 3 -qO- http://1.1.1.1                       # ✔ falla (sin ruta)
docker exec tai-dt-n8n wget -T 3 -qO- http://host.docker.internal          # ✔ falla
docker ps --format '{{.Names}}  {{.Ports}}'                                # ✔ sólo 127.0.0.1:5689->5678 es nuevo; los treidilor-* siguen igual
```

**P4 · Propietario de la instancia de pruebas** (editor en http://127.0.0.1:5689 → formulario de primera visita; correo y contraseña **inventados y solo de pruebas**, p. ej. `prueba@prueba.invalid`).

**P5 · Importar los workflows de prueba**
```powershell
docker cp "$dir\workflows" tai-dt-n8n:/tmp/dt
docker exec tai-dt-n8n n8n import:workflow --separate --input=/tmp/dt
docker exec tai-dt-n8n n8n list:workflow            # anota los 4 ids (1, 2, 3, 4)
```
✔ Importan sin errores. Si algún nodo `Data table` aparece con «?» en el editor, el `typeVersion` o los parámetros no son válidos: ese es un hallazgo (T7) y se corrige.

**P6 · Ejecutar** (🔒; no hay cuenta atrás ni programación; son ejecuciones manuales)
```powershell
$ej = { param($id,$f) docker exec -e N8N_RUNNERS_BROKER_PORT=5690 tai-dt-n8n n8n execute --id=$id | Out-File -Encoding utf8 "$dir\salidas\$f" }
& $ej <ID1> 1.txt          # crea la tabla, inserta y LEE de vuelta (tamaños, orden, duplicados, reconstrucción)
& $ej <ID3> 3.txt          # fila «origen» por la CLI
```
Después, **en el editor** (http://127.0.0.1:5689): abre «PRUEBA DT 3 · origen de la ejecución» y pulsa *Execute workflow* (ejecución manual real). Luego:
```powershell
& $ej <ID2> 2.txt          # lee toda la tabla desde otra ejecución (persistencia y las dos filas «origen»)
# concurrencia de solo inserción: dos ejecuciones SIMULTÁNEAS del workflow 3
$p1 = Start-Process docker -ArgumentList "exec -e N8N_RUNNERS_BROKER_PORT=5691 tai-dt-n8n n8n execute --id=<ID3>" -RedirectStandardOutput "$dir\salidas\3c1.txt" -PassThru -WindowStyle Hidden
$p2 = Start-Process docker -ArgumentList "exec -e N8N_RUNNERS_BROKER_PORT=5692 tai-dt-n8n n8n execute --id=<ID3>" -RedirectStandardOutput "$dir\salidas\3c2.txt" -PassThru -WindowStyle Hidden
$p1, $p2 | Wait-Process
& $ej <ID2> 2b.txt         # ✔ deben aparecer las dos filas nuevas con ids distintos y ninguna perdida
```
**JSON real del nodo**: en el editor de la instancia de pruebas añade un nodo *Data table* a un lienzo nuevo, cópialo (Ctrl+C) y pégalo en `$dir\exportados\nodo-ui.json` (sin guardar el workflow). Exporta además lo importado:
```powershell
docker exec tai-dt-n8n n8n export:workflow --all --separate --output=/tmp/exp/
docker cp tai-dt-n8n:/tmp/exp/. "$dir\exportados"
```

**P7 · Analizar (sin Docker, sobre los datos RECUPERADOS)**
```powershell
node scripts/automation/prueba-data-tables.mjs analizar --escribir "$dir\salidas\1.txt" --origen "$dir\salidas\3.txt" --leer "$dir\salidas\2.txt" --exportados "$dir\exportados" --salida "$dir\informe-prueba-dt.json"
```

## 5. Qué se comprueba y con qué criterio
**Regla de oro (condición 4):** el análisis compara siempre lo **recuperado por los nodos Get** con lo esperado, recalculado en el analizador: contenido completo, longitud en caracteres y en bytes UTF-8 y huella SHA-256. Que lo generado fuera correcto no cuenta. Hay pruebas automáticas (con un simulador, sin n8n) que comprueban que el análisis detecta truncados, rechazos, contenido alterado de igual longitud y órdenes ignorados.

| Id | Prueba | Criterio |
|---|---|---|
| T0 | Se completó y la lectura devolvió filas | Sin error global; filas > 0 |
| T1 | **Tamaño de celda**: 1, 8, 32, 64 y 128 KB, un 32 KB UTF-8 (ñ, á, €, 😀) y uno exploratorio de 512 KB | Las obligatorias salen **idénticas** (contenido, bytes y huella). Se anota el máximo exacto y el error si algo se rechaza |
| T2 | **Lectura ordenada**: `generadoEn` DESC con límite 3, ASC, `epoch` (número) DESC con límite 3, y el orden por defecto | Secuencias exactas; el orden por defecto = orden de inserción (id asc) |
| T3 | **Inserciones**: lo que devuelve Insert (campos `id`, `createdAt`…) frente a lo que hay en la tabla | Todos los ids devueltos están en la tabla; ids únicos y crecientes |
| T4 | **Duplicados**: dos inserciones con la misma clave | Se anota si la tabla los admite (esperado: sí) y que `deduplicarPorIdEjecucion` deja uno (el de menor id) |
| T5 | **Ejecuciones manuales**: valor de `$execution.mode` por la CLI y por el editor; persistencia entre ejecuciones; inserciones simultáneas | Filas «origen» recuperadas con su modo; las filas persisten; las dos simultáneas están, con ids distintos |
| T6 | **Reconstrucción determinista**: tres auditorías reales del motor insertadas en orden B, A, C | El estado reconstruido por `(generadoEn, idEjecucion)` y deduplicado es **idéntico** al de plegar en orden A, B, C, para cualquier permutación y con duplicados; plegar en orden de inserción da otro estado |
| T7 | **typeVersion y referencia**: JSON exportado y nodo copiado del editor; lectura por nombre y por id | Se anotan `typeVersion` y modo de referencia reales; ambas lecturas devuelven lo mismo |

**Decisión posterior:** (a) T1 ≥ 32 KB exactos → una fila por instantánea; si el máximo es menor, se parte la instantánea en trozos. (b) Si T2 falla con texto, se ordena por `epoch`. (c) Si T4 muestra que los duplicados se admiten, se mantiene la deduplicación por `idEjecucion` y los reintentos del nodo de escritura desactivados. (d) Si `$execution.mode` distingue las vías, se usa para la columna `origen`. (e) Con los datos reales del nodo se generará el JSON de producción (`dataTableId` por nombre único o por id).

## 6. Limpieza **exclusiva** de lo creado por la prueba
Nunca usar `docker system prune`, `docker volume prune` ni borrados globales (`docker rm $(docker ps -aq)`).
```powershell
# (opcional) borrar antes la tabla desde n8n: ejecutar el workflow «PRUEBA DT 4 · limpiar» (borra sólo tai_prueba_dt)
# 1. Borrar contenedores, red y volúmenes DEL PROYECTO de la prueba (nada más)
docker compose -p tai-prueba-dt -f automation/dev/prueba-data-tables/docker-compose.yml down -v
# 2. Comprobar que no queda nada de la prueba (las tres listas deben salir vacías)
docker ps -a --filter "label=com.treidilor.prueba=data-tables"
docker volume ls --filter "label=com.treidilor.prueba=data-tables"
docker network ls --filter "label=com.treidilor.prueba=data-tables"
# 3. Comprobar que lo demás sigue igual: deben seguir treidilor-n8n-pruebas, treidilor-puente-entrada, treidilor-puente-salida y los volúmenes treidilor_n8n_pruebas_datos y n8n_data
docker ps -a --format '{{.Names}}  {{.Status}}' ; docker volume ls
# 4. Borrar los ficheros de la prueba (claves de pruebas, workflows, salidas); conservar el informe si se quiere
Remove-Item -Recurse -Force "$dir\.env.prueba-dt","$dir\workflows","$dir\salidas","$dir\exportados"
# 5. (opcional, para recuperar ≈ 1,7 GB) quitar SOLO las dos imágenes descargadas para la prueba
docker image rm n8nio/n8n:2.38.6 postgres:17
```
**No se toca** `node:22-bookworm-slim`, `n8nio/n8n:2.46.6` ni nada `treidilor-*`. La prueba no escribe nada en el repositorio salvo estos ficheros preparados.

## 7. Riesgos
| Riesgo | Mitigación |
|---|---|
| **Los JSON de prueba están escritos a partir del código fuente, no de un nodo creado en el editor**: parámetros mal colocados podrían ignorarse sin error | T0/T7 lo detectan (el análisis fallaría o el editor mostraría «?»). Si ocurre, se crea el nodo en el editor, se exporta y se ajusta el generador |
| Diferencias con producción: PostgreSQL en contenedor (no el de EasyPanel), una sola instancia, runner interno (la CLI no usa el runner externo), 2.38.6 exacto pero no la misma instalación | Se documentan; los nodos Data table no dependen del runner. La verificación definitiva en producción sería una tabla temporal aparte (otra autorización) |
| `$execution.mode` por CLI puede no coincidir con el del editor o el de un disparador | Se prueban la CLI y el editor; un disparador (modo producción real) queda **sin probar** a propósito (no se activan programaciones) |
| Descarga de dos imágenes grandes | Etiquetas fijadas (no `latest`), imágenes oficiales, digests anotados |
| Recursos: ≈ 1,7 GB de RAM y ≈ 1,7 GB de disco más, con el n8n de los agentes aún arrancado | Si falta memoria, parar antes (con permiso) el stack de los agentes o reducir los límites |
| Referencia por nombre = coincidencia por subcadena | En el entorno aislado solo hay una tabla; en producción se usará un nombre único o el modo `id` |
| El tamaño exploratorio de 512 KB podría fallar por otros límites (cuerpo, memoria) | Es informativo; no bloquea |
| Concurrencia real solo de inserción | La prueba comprueba que dos ejecuciones simultáneas no se pierden filas; la atomicidad de Update y Upsert **no** se prueba aquí (no la necesita el diseño) |

## 8. Fuera de alcance
No se prueba el runner externo, ni programaciones, ni el Auditor, ni ningún acceso a Treidilor, VPS o producción; no se modifica el Auditor ni sus workflows. El nodo Code de la prueba no usa las bibliotecas del Auditor (los nodos de prueba son pequeños). La implementación de 2c sigue sin autorizar.

## 9. Ficheros preparados (nuevos; nada existente modificado)
`automation/dev/prueba-data-tables/{docker-compose.yml,.env.example}`, `scripts/automation/prueba-data-tables.mjs` (generar y analizar), `scripts/tests/automation-prueba-dt.test.mjs` (15 pruebas sin Docker), este documento, y dos líneas de `.gitignore` para el fichero de entorno de la prueba.
