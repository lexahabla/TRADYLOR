# Cierre de pendientes antes de F3 (importar el Auditor en producción)

> **13/11/2026: F2B cerrada con reservas. El estado vigente está en la sección «CIERRE DE F2B» al final de este documento (restauración C omitida; F3 no autorizada).**

Estado a 12/11/2026. **Nada de esto lo ejecuta Claude**: no tiene acceso a producción. Lo hace el administrador; Claude revisa los resultados que se le pasen. Ninguna restauración se ejecuta todavía.
Regla común: **solo nombres y resultados, nunca valores secretos**; el volcado de la base de datos **es sensible** (contiene credenciales cifradas de n8n, hashes de contraseñas de usuarios y datos de workflows): no se pega, no se sube al repositorio, no se envía por chat.

## 0. Dónde estamos
| Fase | Estado |
|---|---|
| F2 diagnóstico en n8n 2.38.6 | **HECHA, OK** (34/34, `fallos: []`, `sinRed: true`, `versionAgente 0.2.0`, nodo HTTP 4.2 deshabilitado cargado sin errores, sin peticiones externas) |
| Copia de PostgreSQL | **Hecha, sin verificar**: diaria 02:00, 7 copias, *Local Disk*; primera manual 12/11/2026 14:38:15 UTC, `practice_project_n8n/n8n-db/2026-11-12T14:38:14.009Z.sql.gz`, 134 kB |
| Snapshots del VPS | Semanales, activos |
| 2FA n8n · `EXECUTIONS_DATA_PRUNE=true` · recursos (2 vCPU, 8 GiB, 12 % disco, runner ≈ 203 MB) | Verificados |
| Pendiente antes de F3 | A, B, C y D de abajo |

**Aviso sobre las copias:** *Local Disk* guarda las copias en el **mismo VPS**. Protege de un error o corrupción de la base, **no** de perder el VPS (para eso valen los snapshots semanales, que son del VPS completo). Decisión recomendada (punto B6): una copia **fuera del VPS** de forma periódica.

## A. Desde EasyPanel (interfaz, sin SSH)
| # | Acción | Cómo verificar (criterio ✔) |
|---|---|---|
| A1 | Versiones de imagen | `practice_project_n8n` → `n8n`, `n8n-runner`, `n8n-db` → *Source*. ✔ n8n y runner con **el mismo tag 2.38.6** (si el runner difiere, anótalo); anota la **versión mayor de PostgreSQL** (la necesitas en C) |
| A2 | Variables de retención (solo estas) | `n8n` → *Environment*: ✔ ves `EXECUTIONS_DATA_PRUNE=true` y anotas, **si existen**, `EXECUTIONS_DATA_MAX_AGE` y `EXECUTIONS_DATA_PRUNE_MAX_COUNT`. Si no existen, rigen los valores por defecto de n8n (14 días / 10 000); lo confirma B2 |
| A3 | Variables del runner (solo nombres) | `n8n` → *Environment*: ✔ existen nombres `N8N_RUNNERS_*` (modo externo). **No** copies `N8N_RUNNERS_AUTH_TOKEN` |
| A4 | Configuración de copias | `n8n-db` → pestaña de copias: ✔ diaria 02:00, 7 copias; destino *Local Disk*; lista con la copia de las 14:38 y su tamaño |
| A5 | Ventana del diagnóstico | n8n → *Executions*: anota la **hora exacta** (zona horaria) de la ejecución del diagnóstico (la necesitas en B3) |
| A6 | Logs del runner | `n8n-runner` → *Logs*: busca actividad en esa ventana (✔ líneas de la hora del diagnóstico). Es una **comprobación visual**; la confirmación fiable es B3 |
| A7 | Uso de disco en el tiempo | EasyPanel → *Dashboard*: anota disco usado hoy (12 %) para comparar tras las primeras ejecuciones |

## B. Con acceso al servidor (SSH de Hostinger, solo lectura)
Sustituye `<…>`. Ningún comando modifica nada ni imprime secretos.
| # | Qué | Comandos / criterio ✔ |
|---|---|---|
| B1 | **Localizar el volcado** | `find /etc/easypanel -name '2026-11-12T14:38:14*' 2>/dev/null` (si no aparece, `find / -xdev -name '*.sql.gz' -path '*n8n-db*' 2>/dev/null`). ✔ una sola ruta; anótala como `F=<ruta>` |
| B1b | **Integridad del volcado** | `ls -l "$F"` · `gzip -t "$F" && echo gzip-OK` · `sha256sum "$F"` · `zcat "$F" \| grep -c 'PostgreSQL database dump complete'` · `zcat "$F" \| grep -c '^CREATE TABLE'` · `zcat "$F" \| grep -c '^COPY '`. ✔ `gzip-OK`; la línea «dump complete» sale **1** vez; hay decenas de `CREATE TABLE` y de `COPY` (n8n crea ~60 tablas). **No** imprimas el contenido (lleva datos sensibles). Anota el SHA-256 |
| B1c | Roles del volcado | `zcat "$F" \| grep -o 'OWNER TO [A-Za-z0-9_]*' \| sort -u`. ✔ anota el nombre del rol dueño (para C2) |
| B2 | **Valores efectivos de retención** (no son secretos) | `docker exec <contenedor-n8n> printenv EXECUTIONS_DATA_PRUNE EXECUTIONS_DATA_MAX_AGE EXECUTIONS_DATA_PRUNE_MAX_COUNT` (`printenv` **con nombres concretos**; si una variable no existe, no imprime nada). Nombres exactos de contenedores: `docker ps --format '{{.Names}}'`. ✔ anota valores; con valores por defecto: 336 h y 10 000 |
| B3 | **Comportamiento del runner durante el diagnóstico** | `docker logs --since '<hora inicio UTC>' --until '<hora fin UTC>' <contenedor-runner> 2>&1 \| wc -l` y luego sin `wc -l` **solo si no hay datos sensibles** (los logs de runner suelen mostrar ids de tarea, no contenido). ✔ hay actividad en la ventana de A5 ⇒ el Code corre en el runner externo. Si el recuento es 0, comprueba `docker exec <n8n> printenv N8N_RUNNERS_MODE N8N_RUNNERS_ENABLED` (no son secretos) |
| B4 | **Clave de cifrado de n8n: conservada y coincidente (sin mostrarla)** | En el servidor: `docker exec <n8n> sh -c 'printf %s "$N8N_ENCRYPTION_KEY" \| sha256sum \| cut -c1-12'` (imprime solo 12 caracteres de un hash). En tu PC con la clave del gestor de contraseñas: `read -rs K; printf %s "$K" \| sha256sum \| cut -c1-12; unset K` (la lectura es oculta). ✔ **los dos hashes cortos coinciden** ⇒ la copia del gestor es la clave real. Comprueba también que existe el fichero de configuración sin leerlo: `docker exec <n8n> sh -c 'test -f /home/node/.n8n/config && echo existe'` |
| B5 | Tamaño de la base y del disco | `docker exec <n8n-db> psql -U <usuario> -d <base> -c "select pg_size_pretty(pg_database_size(current_database()))"` · `df -h /` · `docker system df`. ✔ anota; la copia de 134 kB indica una base casi vacía hoy |
| B6 | **Copia fuera del VPS** (recomendado) | Desde tu PC: `scp <usuario>@<vps>:"$F" <carpeta cifrada>` (es una conexión tuya al VPS, con tu autorización habitual) y verifica el SHA-256 de B1b. Decisión: repetirlo semanal/mensual a mano, o configurar un destino S3 en EasyPanel (cambio de servicio: autorización aparte) |

## C. Restauración aislada (en tu PC, **no en el VPS**; 🔒 aún NO ejecutar)
Objetivo: demostrar que el volcado se restaura y contiene lo esperado, **sin tocar la base de producción** (la restauración trabaja con una copia en tu PC, en un contenedor sin red).
Requisitos que necesitan tu autorización cuando se ejecute: **descargar la imagen `postgres:<misma versión mayor que A1>`** (conexión a Docker Hub desde tu PC) y tener el volcado copiado (B6).
1. **C1. Preparar**: carpeta de trabajo **fuera del repositorio** y cifrada/protegida (p. ej. `D:\restauracion-prueba`); copiar el volcado y comprobar su SHA-256 = B1b.
2. **C2. Contenedor desechable y aislado**: `docker run -d --name pg-restauracion-prueba --network none -e POSTGRES_PASSWORD=<aleatoria de un solo uso> -v pg-restauracion-prueba:/var/lib/postgresql/data postgres:<versión>` (volumen propio, sin publicar puertos). `--network none` = sin red: ni Internet ni producción ni otros contenedores; se accede solo con `docker exec`.
3. **C3. Crear rol y base** con el nombre del rol de B1c y una base nueva `restauracion` (nunca el nombre ni la red de producción).
4. **C4. Restaurar**: `zcat <volcado> | docker exec -i pg-restauracion-prueba psql -U postgres -d restauracion -v ON_ERROR_STOP=1`. ✔ termina sin errores.
5. **C5. Verificar (solo recuentos, sin leer datos)**: `select count(*) from workflow_entity;` · `from credentials_entity;` · `from "user";` · `from execution_entity;` y `select name from migrations order by id desc limit 1;`. ✔ el nº de workflows y de usuarios coincide con lo que ves en la interfaz de n8n; la última migración corresponde a 2.38.x.
6. **C6. Destruir**: `docker rm -f pg-restauracion-prueba` + `docker volume rm` del volumen + borrar la copia del volcado de la carpeta de trabajo (o guardarla cifrada como copia fuera del VPS, B6).
7. **Opcional, etapa C+ (no propuesta todavía)**: arrancar n8n 2.38.6 sobre la base restaurada para comprobar que las credenciales se descifran con la clave. **No se recomienda sin un diseño previo**: un n8n arrancado sobre una copia reactivaría los workflows activos y sus disparadores. Si se quiere, lo diseñamos aparte (red sin salida, desactivación previa de workflows en la copia, clave introducida por ti con lectura oculta, sin que yo la vea).
Registro del tiempo total de C (cuánto cuesta restaurar) para el plan de recuperación.

## D. Decisiones pendientes que bloquean F3
| # | Decisión | Mi recomendación |
|---|---|---|
| D1 | ¿Copia fuera del VPS? | Sí: al menos una descarga cifrada semanal hasta tener destino S3 |
| D2 | Retención de ejecuciones | Con ≈ 9 MB por ejecución del Auditor: valores por defecto (14 días) bastan para pruebas manuales; para la programación diaria, fijar `EXECUTIONS_DATA_MAX_AGE` explícito (p. ej. 168 h = 7 días ⇒ ≈ 63 MB) |
| D3 | Responsable de revisar el informe | Definir antes de programar (F7) |

## Criterio de cierre (todo ✔ para pedir F3)
A1–A5 anotados · B1b ✔ (gzip, 1× «dump complete», SHA-256 anotado) · B2 anotado · B3 ✔ actividad del runner · B4 ✔ hashes coinciden · C ejecutada con ✔ y destruida (o decisión expresa de aplazarla y por qué) · D1 y D2 decididos.

## Registro de resultados (plantilla)
| Punto | Resultado | Fecha |
|---|---|---|
| A1 tags (n8n / runner / PG mayor) | | |
| A2 retención visible | | |
| B1b gzip / dump complete / tablas / COPY / SHA-256 | | |
| B2 valores efectivos | | |
| B3 actividad del runner | | |
| B4 hashes coinciden | sí / no | |
| B5 tamaño BD / disco | | |
| B6 copia fuera del VPS | | |
| C (restauración aislada) | | |

## Actualización 12/11/2026 (tras la rotación F2C)
- **B3 (runner externo)**: `N8N_RUNNERS_MODE=external` confirmado en `n8n` y la ejecución de F2 tras la rotación coincide con actividad del runner (17:10:33; cierre por inactividad 15 s después, por diseño). Se considera **cubierto**; B3 puede anotarse como ✔ (ver `F2C-ROTACION-TOKEN-RUNNER.md`).
- **A1**: n8n y runner 2.38.6, PostgreSQL 17 (anotado).
- **Siguen pendientes y F3 sigue BLOQUEADA** hasta completarlos: B1b (integridad del volcado), B2 (valores efectivos de retención), B4 (huella de la clave de cifrado), B5 (tamaños), B6 / D1 (copia fuera del VPS), C (restauración aislada, con PostgreSQL 17) o decisión expresa de aplazarla, D2 (retención explícita), D3 (responsable).

## Actualización 12/11/2026 (B1b superado y consumo del Auditor)
- **B1b — SUPERADO**: integridad gzip correcta (`gzip-OK`), formato **PostgreSQL custom dump** y estructura reconocida por `pg_restore -l` (`BACKUP-ESTRUCTURA-OK`). Esto verifica que el archivo es íntegro y legible; **la restauración real sigue pendiente** (punto C). Nota: la comprobación descrita arriba (conteos con `zcat | grep`) presupone un volcado SQL de texto; al ser un volcado en formato custom, la validación válida es `pg_restore -l`, y el punto C debe usar `pg_restore` (no `psql`).
- **D2**: el peso por ejecución del Auditor ya está calculado y documentado en `AUDITOR-CONSUMO.md` (tope de 40 enlaces: ≈ 9,3 millones de bytes por ejecución; ≈ 62 MB con 7 días de retención a 1 ejecución diaria). F3 sigue bloqueada hasta completar el resto de pendientes.

## Actualización 12/11/2026 (validación integral local completada) — plan para cerrar F2B
Fuente: `AUDITOR-VALIDACION-INTEGRAL.md`. **Esta actualización es solo documental: no se ha accedido al VPS ni a producción, ni se ha ejecutado ninguna comprobación de F2B.** F3 sigue BLOQUEADA.

### 1. Qué cambia y qué no con la validación local
- **No sustituye ningún punto de F2B**: A, B y C se refieren al servidor de producción y a la restauración de su copia; la validación se hizo en un n8n 2.38.6 + PostgreSQL 17 aislado y con datos sintéticos.
- **Aporta evidencia** para D2 (consumo y retención: `AUDITOR-CONSUMO.md`) y un ensayo del procedimiento (Data Table, programación, desactivación, sin repetir ejecuciones).
- **Aporta un requisito nuevo** para F3: crear la Data Table `auditor_general_instantaneas` **vacía** en el n8n de producción (con autorización) y comprobar que existe antes de la primera ejecución.

### 2. Requisitos pendientes, evidencia disponible y acción necesaria
| Punto | Estado | Evidencia disponible | Acción necesaria | ¿Modifica producción? |
|---|---|---|---|---|
| A1 versiones | ✔ anotado (n8n y runner 2.38.6, PG 17) | Actualización F2C | Ninguna | No |
| A2 retención visible | Pendiente | `EXECUTIONS_DATA_PRUNE=true` verificado; `MAX_AGE`/`MAX_COUNT` sin anotar | Anotar desde EasyPanel | No (lectura) |
| A3 variables del runner | Pendiente de anotar | `N8N_RUNNERS_MODE=external` confirmado (F2C) | Anotar solo los nombres `N8N_RUNNERS_*` | No (lectura) |
| A4 configuración de copias | Pendiente de anotar | Diaria 02:00, 7 copias, Local Disk, copia 14:38 (134 kB) | Captura/lista desde EasyPanel | No (lectura) |
| A5 ventana del diagnóstico | Pendiente de anotar | Diagnóstico F2 tras rotación: 17:10:33 | Anotar hora exacta y zona | No (lectura) |
| A6 logs del runner | Cubierto en la práctica | F2C: actividad 17:10:33 y cierre por inactividad | Anotar como ✔ (B3 es la confirmación fiable) | No (lectura) |
| A7 disco | Pendiente de anotar | 12 % usado | Anotar el valor de hoy | No (lectura) |
| B1 localizar volcado | Hecho en la práctica | Ruta localizada al verificar B1b | Anotar la ruta (sin contenido) | No (lectura SSH) |
| **B1b integridad** | **✔ SUPERADO** | gzip-OK, formato custom, `pg_restore -l` correcto | Anotar SHA-256 | No |
| B1c rol dueño | Pendiente | — | Inspeccionar el rol sin leer datos (`pg_restore -l`) | No (lectura SSH) |
| **B2 retención efectiva** | Pendiente | — | `printenv` con nombres concretos | No (lectura SSH) |
| **B3 runner** | **✔ Cubierto** (F2C) | `N8N_RUNNERS_MODE=external` + actividad 17:10:33 | Anotar como ✔ | No |
| **B4 clave de cifrado** | Pendiente | — | Comparar huellas de 12 caracteres (gestor vs. contenedor), sin mostrar la clave | No (lectura SSH) |
| B5 tamaños | Pendiente | Copia de 134 kB ⇒ base casi vacía | `pg_database_size`, `df -h`, `docker system df` | No (lectura SSH) |
| **B6 / D1 copia fuera del VPS** | Pendiente | — | `scp` del volcado a tu PC (cifrado) y decidir periodicidad / S3 | `scp`: no; destino S3 en EasyPanel: **sí** |
| **C restauración aislada** | Pendiente (🔒) | Procedimiento escrito; PG 17; el ciclo Compose + PG 17 ya se ejercitó en local | C1–C6 en el PC con `pg_restore`, `--network none`, **o** aplazar con motivo expreso | No (el PC); requiere autorización para descargar la imagen y manejar el volcado |
| **D1** copia fuera del VPS | Decidir | Recomendación: descarga cifrada semanal | Decidir | — |
| **D2** retención explícita | Decidir | `AUDITOR-CONSUMO.md`: ≈ 9,3 MB/ejec. a 40 enlaces; ≈ 62 MB a 7 días y 1 ejec./día | Decidir si fijar `EXECUTIONS_DATA_MAX_AGE` (p. ej. 168 h) | Sí, si se fija en EasyPanel |
| **D3** responsable del informe | Pendiente | — | Nombrarlo antes de programar (F7) | No |

### 3. Qué se puede hacer sin modificar producción y qué exige autorización expresa
**Sin modificar producción** (lo ejecuta el administrador; Claude no tiene acceso):
- Lecturas de EasyPanel (A2–A5, A7) y lecturas SSH de solo lectura (B1, B1b, B1c, B2, B4, B5).
- B6: copiar el volcado a tu PC con `scp` (el archivo es sensible: ni al repositorio ni al chat).
- C en el PC: restauración aislada y destruida (autorización para descargar `postgres:17` y manejar el volcado).
- Decisiones D1, D2 y D3 (documentales).

**Exigen autorización expresa:**
- Fijar `EXECUTIONS_DATA_MAX_AGE` o cualquier variable de n8n (D2) y configurar un destino S3 (D1 como servicio).
- F3: importar `auditor-general.produccion.json` **desactivado** y crear la Data Table vacía en el n8n de producción.
- Cualquier ejecución del Auditor contra `treidilor.com`, activar programación (F7), canal de avisos, API 2.2 / Investigador.
- «C+» (n8n sobre una copia restaurada): requiere diseño aparte.

### 4. Secuencia mínima propuesta para cerrar F2B
Ya superado y **no se repite**: F2 (34/34), B1b, A1, B3 / rotación F2C, 2FA, prune, recursos y la validación integral local del Auditor.
1. **Lote 1 – EasyPanel (solo lectura):** A2, A3, A4, A5, A7. Solo nombres, horas y cifras.
2. **Lote 2 – SSH (solo lectura):** B1c, B2, B4, B5 y anotar el SHA-256 de B1b.
3. **Decisiones D1, D2, D3**, con la tabla de consumo a la vista (autorización aparte solo si se elige fijar retención o un destino S3).
4. **B6:** volcado a tu PC, verificar SHA-256 y guardarlo cifrado.
5. **C:** restauración con `pg_restore` en contenedor sin red; registrar el tiempo; destruir (o aplazarla de forma expresa y justificada).
6. **Cierre documental:** rellenar el «Registro de resultados» y pedir F3 solo con todo ✔ según el criterio de cierre.

Después de F2B (fuera de este cierre): F3 = crear Data Table vacía + importar el Auditor **desactivado** + una ejecución manual, con autorizaciones separadas. `AUDITOR-VALIDACION-INTEGRAL.md` §6 lista lo que se verificaría por primera vez en producción.

### 5. Reglas heredadas de la validación para F3
- No se aplica `alwaysOutputData` al Insert (decisión del 12/11/2026, hallazgo P9).
- `pendiente` = escritura **no confirmada**: tras la primera ejecución en producción hay que comprobar en la tabla que la fila existe antes de dar por buena la línea base.

## CIERRE DE F2B (13/11/2026) — estado final y preparación de F3
Esta sección **sustituye** al estado de las tablas anteriores (se conservan como historial). Es solo documental: no se ha modificado producción, variables, credenciales, workflows, PostgreSQL ni contenedores, y no se ha ejecutado ningún despliegue.
Procedencia de la evidencia: lo marcado «(usuario)» lo comprobó el administrador en EasyPanel/SSH/su PC y lo comunicó por escrito; Claude **no tiene acceso a producción** y no lo ha reverificado. No se registran contraseñas, claves ni huellas.

Leyenda: **VERIFICADO** · **PENDIENTE** · **OMITIDO** (por decisión del usuario) · **N/A** (no aplicable).

### 1. Estado por punto
| Punto | Estado | Evidencia | Observaciones |
|---|---|---|---|
| A1 versiones | VERIFICADO | n8n y runner 2.38.6; PostgreSQL 17 | Documentado en F2C |
| A2 retención visible | VERIFICADO | `EXECUTIONS_DATA_PRUNE=true`; `EXECUTIONS_DATA_MAX_AGE` y `EXECUTIONS_DATA_PRUNE_MAX_COUNT` **no definidas** en EasyPanel (usuario) | Rigen los valores por defecto (ver §2) |
| A3 variables del runner | VERIFICADO | Existen `N8N_RUNNERS_MODE`, `N8N_RUNNERS_AUTH_TOKEN`, `N8N_RUNNERS_BROKER_LISTEN_ADDRESS` (solo nombres) (usuario) | Valores no consultados |
| A4 copias | VERIFICADO | Copias habilitadas, cron `0 2 * * *`, retención 7, Local Disk, una copia registrada correctamente (usuario) | Local Disk = mismo VPS (ver riesgos) |
| A5 ventana del diagnóstico | VERIFICADO (hora); **zona horaria efectiva PENDIENTE de confirmar** | Diagnóstico ID 11, Success; 12/11/2026 18:10:29 según la interfaz de n8n; **verificado por SQL (administrador): `startedAt` UTC = 2026-11-12 17:10:29** | La diferencia de 1 h es coherente con Europe/Madrid (UTC+1 en noviembre), pero la configuración efectiva (`GENERIC_TIMEZONE`/`TZ` del contenedor) no se ha confirmado. Impacto bajo; confirmarla antes de programar (R5) |
| A6 logs del runner | VERIFICADO (cubierto por F2C/B3) | Actividad del runner en la ejecución F2 posterior a la rotación | — |
| A7 disco | VERIFICADO | 12,1 % (11,6 GB de 95,8 GB); memoria 20,4 % en la revisión (usuario) | Línea base para comparar tras las primeras ejecuciones |
| B1 volcado localizado | VERIFICADO | `2026-11-12T14:38:14.009Z.sql.gz` (usuario) | — |
| B1b integridad | VERIFICADO | gzip correcto, legible con `pg_restore -l`; SHA-256 calculado (usuario) | No equivale a una restauración (ver C) |
| B1c estructura / rol dueño del volcado | VERIFICADO parcialmente | El administrador examinó el contenido **estructural** del backup con `pg_restore -l` | **No equivale a una prueba de restauración.** El rol dueño no se ha registrado; solo sería necesario para C y no bloquea F3 |
| B2 retención efectiva | VERIFICADO por documentación, **no** por consulta en el contenedor | A2 + valores por defecto acreditados (ver §2) | La consulta `printenv` en el contenedor no consta; se considera suficiente mientras no se fije un valor explícito |
| B3 runner externo | VERIFICADO | `N8N_RUNNERS_MODE=external` y actividad en la ejecución F2 | — |
| B4 clave de cifrado | VERIFICADO | `N8N_ENCRYPTION_KEY` definida en el contenedor; huellas SHA-256 del servidor y de la copia externa comparadas localmente: coinciden; clave sin cambiar ni rotar (usuario) | Ver riesgo R6 (la copia externa depende de la contraseña de WinRAR) |
| B5 tamaños | VERIFICADO (administrador) | Disco 12,1 % y memoria 20,4 %; tamaño de PostgreSQL ≈ **16 MB**; ejecutado `docker system df` (solo lectura) | Las cifras de `docker system df` no se han incorporado a este documento. La base es pequeña (≈ 16 MB); el volcado comprimido de 134 kB corresponde a esa base |
| B6 copia fuera del VPS | VERIFICADO | Copia descargada al disco externo (Windows 11); SHA-256 de origen y destino coinciden; archivo protegido con WinRAR y comprobado que se abre (usuario) | Es una copia puntual (12/11); no hay rutina de copia externa periódica (ver D1) |
| **C restauración aislada** | **OMITIDO** | — | **No se ha restaurado ningún backup.** La integridad del archivo y su lectura estructural no equivalen a una restauración satisfactoria; la restauración completa **NO está validada** |
| D1 copia externa periódica | PENDIENTE de decisión | Hay una copia externa puntual | Sin periodicidad ni destino definidos |
| D2 retención definitiva | **OMITIDO / PENDIENTE de decisión** | Rigen los valores por defecto | Sin cambios de configuración por decisión del usuario |
| D3 responsable de revisar informes | PENDIENTE de decisión | — | Obligatorio antes de programar |
| Frecuencia de revisión, notificaciones, respuesta ante incidencias | PENDIENTE de decisión | — | No se inventa ninguna decisión; obligatorias antes de programar |

### 2. Valores por defecto de retención
Acreditados localmente leyendo el paquete de **n8n 2.38.6** (el mismo que producción), `@n8n/config/dist/configs/executions.config.js`: `pruneData = true`, **`pruneDataMaxAge = 336` h (14 días)**, **`pruneDataMaxCount = 10 000`**, `pruneDataHardDeleteBuffer = 1`. Como en producción no están definidas, rigen estos valores. No se ha confirmado el valor efectivo dentro del contenedor de producción (no es necesario salvo que se fije uno explícito).
Con el Auditor a 40 enlaces (≈ 9,3 MB/ejecución, `AUDITOR-CONSUMO.md`): 14 días a 1 ejecución diaria ≈ 130 MB; 7 días ≈ 65 MB. Asumible sobre 84 GB libres.

### 3. Comprobaciones omitidas y qué implican
- **C — restauración aislada de PostgreSQL: omitida por decisión del usuario.** Consecuencia: no hay prueba de que la copia se restaure y arranque; lo verificado es integridad del archivo (gzip), legibilidad estructural (`pg_restore -l`), copia externa íntegra y clave de cifrado conservada. Tampoco se ha medido el tiempo de restauración (no hay plan de recuperación con tiempos).
- **D — retención y supervisión**: sin cambios ni pruebas adicionales; decisiones pendientes (abajo).
- **B1c**: solo se examinó la estructura del backup con `pg_restore -l` (no es una restauración); el rol dueño no se registró y solo sirve a C.

### 4. Riesgos residuales
| # | Riesgo | Efecto | Mitigación / estado |
|---|---|---|---|
| R1 | **Restauración no probada** | Si la base de n8n se corrompiera o se perdiera el VPS, no hay garantía de recuperar workflows, credenciales y la Data Table; no hay tiempo de recuperación medido | Abierto. Atenuado: la base actual es pequeña (≈ 16 MB; volcado comprimido de 134 kB), la clave de cifrado está verificada y conservada fuera del VPS, la copia externa es íntegra y los snapshots semanales del VPS cubren la pérdida del servidor completo. Aceptación expresa necesaria para F3 (§6) |
| R2 | Copias automáticas en Local Disk (mismo VPS) | No protegen frente a la pérdida del VPS | Parcialmente mitigado por snapshots semanales y la copia externa puntual; sin rutina periódica (D1) |
| R3 | Retención por defecto (14 días / 10 000), sin decisión explícita | Crecimiento controlado, pero no es una política decidida | Pendiente D2; asumible por cifras |
| R4 | Sin responsable, frecuencia ni canal de revisión del informe | Un informe «crítico» puede pasar inadvertido | Pendiente D3; bloquea la **programación**, no la importación ni la primera ejecución manual |
| R5 | Configuración efectiva de la zona horaria del servidor/n8n sin confirmar (la ejecución 11 es coherente con Europe/Madrid, verificada por SQL: 17:10:29 UTC) | Horarios de la programación podrían desfasar 1 h | Pendiente; confirmar `GENERIC_TIMEZONE`/`TZ` antes de programar (la programación se fija a mano en n8n) |
| R6 | La copia de la clave y del volcado externo dependen de una contraseña de WinRAR y de un único disco externo | Pérdida del disco o de la contraseña ⇒ sin copia utilizable | Recomendado: segunda copia independiente de la clave (gestor de contraseñas ya verificada por huella); no se pide ahora |
| R7 | **Nuevo, detectado al preparar F3: el Auditor de producción ya no es «sin cambios en n8n».** `auditor-general.produccion.json` incluye 3 nodos `dataTable` (memoria 2c) y por tanto **necesita la Data Table `auditor_general_instantaneas`**, que hay que crear en el n8n de producción (con el workflow `auditor-instantaneas-crear-tabla.json`) | Es una escritura en la base de n8n de producción; si la tabla no existe, el Auditor informa `no_encontrada` y no guarda (sin daño) | **La creación de `auditor_general_instantaneas` requiere autorización expresa.** Una vez creada y con filas, **no se elimina sin revisar antes sus datos** y sin autorización expresa (las instantáneas son el historial del seguimiento). Ver plan F3. La `GUIA-DESPLIEGUE-AUDITOR-PRODUCCION.md` (§1, §10) lo describe como solo lectura: actualizada con un aviso |
| R8 | Se desconoce si `NODES_EXCLUDE` del n8n de producción excluye `httpRequest` o `dataTable` | El workflow cargaría con «?» y no podría ejecutarse | Comprobar el nombre/valor de `NODES_EXCLUDE` (no es secreto) antes de importar; el diagnóstico F2 cargó el nodo HTTP 4.2 deshabilitado sin errores, lo que sugiere que no está excluido, pero no es prueba de ejecución |
| R9 | Rutas reales de `treidilor.com` (latencia, WAF, redirecciones, tamaño de páginas) nunca auditadas por este Auditor | Falsos positivos o bloqueos | Se resuelve en la primera ejecución manual supervisada |
| R10 | Concurrencia en la tabla (dos ejecuciones simultáneas) diseñada pero no probada | Doble escritura de una instantánea | Una sola ejecución manual cada vez; sin programación solapada |

### 5. Decisiones pendientes del usuario
1. **Aceptar o no el riesgo R1** (restauración no probada) para F3, con la condición propuesta en §6, o realizar C antes.
2. D1: periodicidad y destino de la copia externa.
3. D2: retención definitiva (mantener los valores por defecto o fijar p. ej. 168 h).
4. D3: responsable de revisar informes; frecuencia de revisión; canal de avisos; procedimiento ante incidencias (qué se hace con un informe `critico`).
5. Autorizar la creación de la Data Table en el n8n de producción (R7) y su método (workflow de preparación o creación manual desde la interfaz).
6. Confirmar la zona horaria (R5).

### 6. Condiciones para iniciar F3
**Obligatorias:**
- Autorización expresa y por escrito del administrador para F3, **incluyendo** la aceptación explícita de R1 (restauración no validada) o la decisión de ejecutar C antes.
- Una **copia manual nueva de PostgreSQL justo antes** de F3 (EasyPanel), con comprobación de que aparece en la lista; opcionalmente su SHA-256. No es necesario descargarla.
- Comprobar `NODES_EXCLUDE` (R8) y que el espacio en disco sigue holgado (A7).
- Autorización específica para crear la Data Table (R7).
- Reglas heredadas de la validación local: no se aplica `alwaysOutputData` al Insert, y **`pendiente` = escritura no confirmada** (comprobar en la tabla que la fila existe antes de dar por buena la línea base).

**No obligatorias para F3 pero SÍ antes de programar (F7):** D3 y las decisiones de supervisión (§5.4), zona horaria confirmada, ≥ 3 ejecuciones manuales en días distintos y retención aceptada, según `GUIA-DESPLIEGUE-AUDITOR-PRODUCCION.md` §8. **La programación no debe activarse mientras C siga sin hacerse, salvo aceptación expresa y reiterada del riesgo.**

### 7. Evaluación: ¿la falta de restauración impide recomendar F3?
**No la impide, pero justifica un despliegue condicionado y limitado.** Razones:
- F3 solo añade a n8n un workflow **inactivo** y una Data Table y permite **una** ejecución manual de solo lectura sobre páginas públicas. No cambia Treidilor, variables, servicios ni credenciales de otros workflows.
- El impacto de perder la base de n8n hoy es bajo: la base es pequeña (≈ 16 MB; volcado comprimido de 134 kB), la clave de cifrado está verificada y conservada fuera del VPS y hay snapshots semanales del VPS y una copia externa íntegra.
- La reversión es sencilla para el workflow (borrarlo); la tabla, mientras esté vacía, también. **Si ya contiene filas, no se elimina sin revisar antes sus datos y sin autorización expresa.**
- En cambio, **no se recomienda programar** (F7) sin restauración probada: allí la base empieza a acumular el historial que justifica la memoria del Auditor y el riesgo R1 deja de ser «de bajo impacto».
Esta valoración es una recomendación; la decisión es del administrador.

### 8. Plan de entrada a F3 (despliegue gradual; cada paso 🔒 requiere autorización expresa; nada autorizado todavía)
| Paso | Qué | Verificación | Parada / reversión |
|---|---|---|---|
| F3.0 Revisión previa de dependencias (solo lectura) | Releer `auditor-general.produccion.json` y `GUIA-…` §2/§5; comprobar `NODES_EXCLUDE` y que el n8n de producción es 2.38.6; confirmar que `maxEnlaces` es 40 y que no hay credenciales en el JSON (hoy: 7 Code, 3 dataTable, 2 httpRequest, manualTrigger, sin credenciales) | Linter/pruebas del repositorio en verde; huella del archivo anotada | Si el JSON no coincide con lo validado, parar |
| F3.1 Respaldo | Copia manual de PostgreSQL desde EasyPanel; anotar hora y que aparece en la lista. Exportar los workflows existentes de n8n (si hay) | Copia visible; exportación guardada fuera del repositorio | Si la copia falla, no continuar |
| F3.2 Crear la Data Table | Importar `auditor-instantaneas-crear-tabla.json` **inactivo**, ejecutarlo **una vez** a mano, comprobar que aparece `auditor_general_instantaneas` **vacía**, y borrar el workflow de preparación | Una sola tabla con ese nombre; 0 filas; columnas correctas | Borrar el workflow de preparación; la tabla solo si está vacía y con autorización expresa |
| F3.3 Importar el Auditor | Importar `auditor-general.produccion.json` **desactivado** | Interruptor Inactive; ningún nodo con «?»; sin credenciales pendientes; nombre «… (produccion)» | Borrar el workflow |
| F3.4 Primera ejecución manual supervisada | Una ejecución en horas de poco tráfico, monitorizando RAM y disco | Peticiones solo GET a `https://treidilor.com`, ≤ 45; estado, cobertura, tamaño de la ejecución (MB); registros de acceso de Treidilor sin 5xx ni escrituras | Parada inmediata ante 5xx en Treidilor, memoria del VPS > 85 %, peticiones fuera de la lista o valores sensibles visibles |
| F3.5 Persistencia | Comprobar `persistencia.escritura.resultado = guardada` con `filaId` real; la tabla tiene exactamente 1 fila (línea base); `pendiente`/`fallida` ⇒ no se da por buena | Fila existe en la tabla; sin duplicados | Si no se guardó, no repetir a ciegas: diagnosticar |
| F3.6 Segunda ejecución manual (otro día) | Debe compararse con la fila anterior (`modo comparacion`), origen `manual`, sin duplicados | Seguimiento coherente | Borrar filas de prueba solo con autorización |
| F3.7 Revisión y decisión | Informe final de F3 con tamaño por ejecución, crecimiento de la base y disco | Criterios de §8 de la guía | Reversión: desactivar (ya lo está), borrar el workflow y sus ejecuciones; la tabla **solo tras revisar sus datos y con autorización expresa** |
| F7 Programación (fase aparte) | Solo tras ≥ 3 ejecuciones manuales en días distintos, D3 decidido, zona horaria confirmada y decisión sobre R1/C; crear el Schedule **a mano** en n8n | Primera semana con revisión diaria | Desactivar el workflow |

### 9. Primera acción propuesta para F3
**F3.0 (solo lectura, sin tocar producción):** releer en el repositorio local el workflow de producción y la guía, verificar con el linter y las pruebas que coincide con lo validado en `tai-prueba-dt`, y pedirte que compruebes en EasyPanel el nombre y el valor de `NODES_EXCLUDE` (no es secreto). Después, y solo con tu autorización expresa, F3.1 (copia manual nueva).

### Estado final de F2B
**F2B CERRADA CON RESERVAS.** Verificados: A1–A4, A6, A7, B1, B1b, B3, B4, B5, B6 (y B2 por documentación). Parciales: A5 (hora verificada por SQL; zona horaria efectiva sin confirmar) y B1c (estructura examinada con `pg_restore -l`, que no es una restauración). B5 verificado por el administrador (≈ 16 MB). **Omitida: C (restauración no validada).** Pendientes de decisión: D1, D2, D3 y supervisión. F3 **no está autorizada**; se recomienda solo como despliegue condicionado y sin programación (§7).
