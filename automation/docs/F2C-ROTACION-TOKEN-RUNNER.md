# Rotación segura de `N8N_RUNNERS_AUTH_TOKEN` (n8n 2.38.6 + n8nio/runners:2.38.6, EasyPanel) — procedimiento definitivo

Estado: **PREPARADO, NO EJECUTADO** (12/11/2026). Claude no tiene acceso a producción y no ha visto ni el token actual ni el nuevo. Lo ejecuta el administrador tras autorizarlo.
Regla: el token **nunca** se pega en chat, informes, commits ni capturas. Solo huellas cortas (12 caracteres de un SHA-256).

## 0. Datos ya confirmados (no se repiten)
- n8n y n8n-runner 2.38.6; PostgreSQL 17; un solo runner en el VPS; el token existe en ambos servicios y coincide.
- Puerto 5679 no publicado ni en EasyPanel ni en Docker, sin listener en el host.
- 3 workflows, ninguno publicado ni en ejecución.
- Copia previa (P4): `n8n-backup-inicial-2026-11-12`, `practice_project_n8n/n8n-db/2026-11-12T14:38:14.009Z.sql.gz`, 134 kB, 14:38:15 UTC, Local Disk, correcta (la restauración aislada sigue pendiente).
- Captura: solo mostraba `N8N_RUNNERS_AUTH_TOKEN` (valor) y `N8N_RUNNERS_TASK_BROKER_URI` (dirección interna, no secreta). **No** se expusieron la clave de cifrado, contraseñas de PostgreSQL ni claves de API → solo se rota este token. Se compartió en una conversación privada de ChatGPT: el token se considera **comprometido**.
- `N8N_RUNNERS_MODE`: **presencia sin confirmar** (ver P8: puede cambiar el sentido de la rotación).

## 1. Qué es y qué riesgo hay
- Con runners **externos**, n8n abre un *task broker* (puerto 5679, red interna) y `n8n-runner` se autentica con `N8N_RUNNERS_AUTH_TOKEN`. Debe ser el **mismo valor** en los dos.
- Con el token y alcance de red al 5679, un tercero podría registrarse como runner y recibir el código de los nodos Code. No da acceso a la interfaz, a credenciales guardadas ni a la base de datos.
- El 5679 no está expuesto: el riesgo queda limitado a quien ya esté dentro de la red interna de Docker. Aun así se rota.
- Como ningún workflow está publicado, un fallo de la rotación **no interrumpe nada productivo**; solo impide ejecutar nodos Code a mano. La recuperación no es urgente.

## 2. Servicios afectados
| Servicio | Cambio | Reinicio |
|---|---|---|
| `n8n-runner` | `N8N_RUNNERS_AUTH_TOKEN` = nuevo | Sí (ver §3) |
| `n8n` | `N8N_RUNNERS_AUTH_TOKEN` = el mismo nuevo | Sí. Corte breve de interfaz y webhooks |
| `n8n-db`, Treidilor | ninguno | No |

## 3. ¿«Guardar» en EasyPanel reinica el servicio? (no se da por supuesto)
No puedo confirmarlo desde aquí y depende de la versión de EasyPanel: en el flujo habitual *Save* guarda la configuración y el servicio solo se recrea con **Deploy** (hay un indicador de cambios pendientes), pero algunas versiones reaplican al guardar. **El procedimiento está diseñado para ser seguro en ambos casos** y mide el comportamiento real en el primer paso:
- Orden: **primero `n8n-runner`, después `n8n`.**
  - Si *Save* reinicia: el runner reinicia con el token nuevo, no autentica (n8n sigue con el viejo) y **reintenta** sin dañar nada; al guardar `n8n`, este reinicia con el nuevo y el runner conecta.
  - Si *Save* no reinicia: se despliega a mano en el orden indicado.
  - En ambos casos el estado intermedio (valores distintos) solo deja los nodos Code sin runner, sin impacto productivo.
- **Medición (solo lectura)**: antes y después de pulsar *Save* en el runner, anota `docker inspect --format '{{.State.StartedAt}}' <n8n-runner>` (nombre: `docker ps --format '{{.Names}}'`). Si `StartedAt` cambia ⇒ *Save* reinicia; si no ⇒ hace falta *Deploy*. Alternativa sin SSH: *Logs* del runner (un arranque nuevo muestra el inicio del launcher) y el indicador de «cambios sin desplegar» en EasyPanel.
- Si no se puede medir con ninguna de las dos vías: asume que **puede** reiniciar y sigue el mismo orden; no hay ningún paso que dependa de saberlo.

## 4. Antes (sin cambios en producción)
| # | Acción | ✔ |
|---|---|---|
| P1 | **Generar** el token nuevo en tu PC, sin pantalla compartida: `openssl rand -base64 36 \| tr -d '\n=+/'` (o el generador del gestor, ≥ 32 caracteres, solo alfanuméricos para evitar problemas de comillas). Guárdalo en el gestor como «n8n runners auth token (12/11/2026)». No lo copies a otro sitio ni lo pegues aquí | guardado |
| P8 | **Modo efectivo de runners** (no es secreto): `docker exec <n8n> printenv N8N_RUNNERS_MODE N8N_RUNNERS_ENABLED N8N_RUNNERS_BROKER_LISTEN_ADDRESS` (sin salida = variable no definida). Además, en *Logs* de `n8n` del último arranque, busca «runner»/«broker». ✔ `N8N_RUNNERS_MODE=external` ⇒ el runner externo se usa de verdad y la rotación es necesaria. **Si está vacía o `internal`**: n8n ejecuta el Code por su cuenta y el runner externo no se usa (cierra además el pendiente B3 de F2B: la prueba F2 **no** habría pasado por él). En ese caso **no rotes todavía**: el token no autentica nada en n8n; avísame y decidimos (activar `external` o retirar el runner y la variable) | modo anotado |
| P6 | Eliminar la conversación/captura en ChatGPT (y la captura local, correo o nube). Aunque se borre, el token ya se rota | hecho / pendiente |
| P7 | Estado sano: n8n → *Executions* sin fallos recientes; logs del runner con conexión estable | ✔ |
| P4 | Copia fresca (opcional, ya existe la inicial de 14:38; la rotación no toca la base): *Backup now* de `n8n-db` | opcional |

## 5. Rotación (ventana corta, sin workflows publicados)
Desde EasyPanel, un servicio detrás de otro. Pega el valor desde el gestor, sin espacios ni saltos de línea.
1. **R0.** Anota hora de inicio y, si puedes, `StartedAt` de ambos contenedores.
2. **R1. `n8n-runner`**: *Environment* → `N8N_RUNNERS_AUTH_TOKEN` = nuevo → **Save**. Mide si reinició (§3). Si no reinició, pulsa **Deploy**. Espera a que el contenedor esté *Running*. (Es normal que registre errores de autenticación hasta que `n8n` se actualice.)
3. **R2. `n8n`**: *Environment* → `N8N_RUNNERS_AUTH_TOKEN` = el mismo → **Save**, y **Deploy** si hace falta. Espera a que la interfaz responda (≈ 30–60 s).
4. **R3.** Espera ≈ 30 s a que el runner reintente y se registre; no lo reinicies a mano salvo que V1 falle tras 2 minutos.
5. **R4.** Anota hora de fin.

## 6. Comprobaciones posteriores (todas ✔)
| # | Comprobación | ✔ |
|---|---|---|
| V1 | **Runner autenticado (logs de `n8n-runner`)**: `docker logs --since 10m <n8n-runner> 2>&1 \| grep -iE 'auth\|token\|unauthor\|forbidden\|denied\|connect\|regist\|broker\|error'` (o *Logs* en EasyPanel). ✔ aparecen líneas de conexión/registro/espera de tareas tras el último arranque y **ya no** se repiten «unauthorized»/«invalid token»/«connection refused». Los mensajes de error previos al reinicio de `n8n` son esperados. Los textos exactos varían según versión: es **orientativo**, el árbitro es V4. Los logs no deberían mostrar el token; si lo mostraran, no los copies | ✔ |
| V2 | **Broker (logs de `n8n`)**: `docker logs --since 10m <n8n> 2>&1 \| grep -iE 'runner\|broker'`. ✔ registro del runner sin errores de autenticación | ✔ |
| V3 | **Mismo valor, sin verlo**: `docker exec <n8n> sh -c 'printf %s "$N8N_RUNNERS_AUTH_TOKEN" \| sha256sum \| cut -c1-12'` y lo mismo con `<n8n-runner>`. En tu PC: `read -rs K; printf %s "$K" \| sha256sum \| cut -c1-12; unset K` con el valor del gestor. ✔ las 3 huellas coinciden (garantiza además que no es el valor viejo del que ya no tienes copia) | 3 iguales |
| V4 | **Prueba funcional (árbitro)**: ejecuta una vez el diagnóstico F2 (importa de nuevo `diagnostico-auditor-produccion.json` si lo borraste; huella en `F2-DIAGNOSTICO-PRODUCCION.md`): `resultado: OK`, `total: 34`, `fallos: []`. Debe pasar con el modo de P8 `external` | OK |
| V4b | **Prueba de que usa el runner** (opcional, tu decisión; cambio mínimo): con n8n en modo `external`, detén el servicio `n8n-runner` unos segundos y lanza el diagnóstico: debe **fallar** («runner no disponible/tiempo agotado»); vuelve a arrancar el runner y repite: OK. Demuestra que el Code pasa por el runner con el token nuevo. Cierra también B3 de F2B | opcional |
| V5 | *Executions*: la ejecución de V4 en Success; sin fallos inesperados. Workflows: siguen sin publicar | ✔ |

## 7. Recuperación
Principio: **se avanza, no se retrocede**. El token viejo está comprometido; el valor bueno es el nuevo del gestor.
| Síntoma | Causa probable | Acción |
|---|---|---|
| Runner con «unauthorized»/«invalid token» tras actualizar ambos | Valores distintos (copia con espacio/salto, servicio sin redeploy) | Compara V3. Vuelve a pegar el valor del gestor en el servicio cuya huella no coincida; Deploy; V1 |
| Runner conecta pero el Code falla | `n8n` con valor viejo o sin redeploy | Deploy de `n8n`; V2 |
| `n8n` no arranca | Nombre de variable alterado o valor con comillas/saltos | Corrige el nombre exacto y el valor; Deploy. La interfaz caída no afecta a Treidilor ni a datos |
| Runner entra en bucle de reinicio | Mismatch o `N8N_RUNNERS_TASK_BROKER_URI` alterado | Verifica que esa URI sigue igual que antes (no la modificaste); corrige el token; Deploy |
| Nada funciona tras 15 min | — | (1) Detén `n8n-runner` para que no reintente en bucle. (2) Con el token nuevo en ambos y huellas iguales, redeploy de `n8n` y luego del runner. (3) Último recurso temporal: `N8N_RUNNERS_MODE=internal` en `n8n` y runner parado (los Code funcionan sin aislamiento); decisión tuya. (4) Volver al token viejo **no se recomienda** (comprometido) y de todos modos no lo conservas: se evita guardarlo |
No hay datos que restaurar: la rotación no toca la base ni los workflows; la copia de las 14:38 es solo precaución.

## 8. Después
- Informe con hora, ventana, V1–V5 (sin valores) y el modo de P8.
- Verificación de `StartedAt` anotado en R0 para constancia de qué servicios reiniciaron.
- No hacer capturas de *Environment* con valores visibles; tapar o usar vista oculta.
- Un token por servicio no existe: si en el futuro se añaden runners, usar el mismo y rotar juntos.
- La rotación no afecta al Auditor ni a Treidilor; F3 sigue pendiente de `F2B-CIERRE-PENDIENTES-ANTES-DE-F3.md`.

## Registro de resultados (plantilla)
| Punto | Resultado | Hora |
|---|---|---|
| P8 modo efectivo (`external`/`internal`/sin definir) | | |
| *Save* ¿reinicia? (`StartedAt` cambió) | sí / no / no medible | |
| Ventana (inicio–fin) | | |
| V1/V2 logs sin errores de autenticación | | |
| V3 huellas (3) | coinciden / no | |
| V4 diagnóstico 34/34 | | |
| V4b prueba con runner detenido | no realizada / falla y recupera | |
| P6 conversación y captura borradas | | |

## Resultado de la ejecución (12/11/2026, por el administrador; sin valores)
| Punto | Resultado |
|---|---|
| Rotación en `n8n` y `n8n-runner`, desplegada | hecha; ambos servicios en verde |
| V3 coincidencia entre servicios (configuración de Docker Swarm, sin mostrar valores) | coincide |
| V1/V2 errores de autenticación (sin nuevos HTTP 403 en los registros revisados) | sin errores |
| V4 diagnóstico F2 tras la rotación | 34/34, `resultado: OK`, `fallos: []`, `sinRed: true` |
| Registro del runner a las 17:10:33, durante F2 | `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided` |
| Registro del runner a las 17:10:48 | `Runner process exited on idle timeout` |

### Análisis de los dos mensajes (inocuos; no requieren corrección)
- **`ExperimentalWarning: localStorage …`**: aviso de Node.js (las versiones recientes incluyen Web Storage y avisan al acceder a `localStorage` sin `--localstorage-file`). Aparece cuando el proceso del runner prepara el contexto de ejecución de una tarea Code y recorre las globales; no es un fallo ni afecta al resultado (F2 dio OK). Es de aviso, no de error: no se corrige ni se silencia. Su presencia **a la hora de F2** es, de hecho, evidencia de que el Code se ejecutó en el runner externo.
- **`Runner process exited on idle timeout`**: comportamiento **por diseño** del lanzador del runner: el proceso del runner se cierra tras un periodo sin tareas (por defecto 15 s) y el lanzador lo vuelve a arrancar cuando llega la siguiente. Entre 17:10:33 y 17:10:48 pasan exactamente 15 s, que coincide con ese valor por defecto. No indica caída ni pérdida de conexión con el broker.
- Habría que investigar solo si: (a) el cierre ocurre **durante** una tarea en curso, (b) tras él no se vuelve a ver actividad con la siguiente tarea, o (c) aparecen errores de autenticación, de conexión al broker o de memoria asociados. Ninguna de las tres cosas consta.

### Cierre de F2C
Técnicamente **cerrable**: servicios sanos, token coincidente, sin errores de autenticación, prueba funcional OK y evidencia positiva del runner.
Housekeeping pendiente (no bloquea el cierre técnico):
1. **Huella contra el valor guardado**: que el valor desplegado es el del gestor/archivo local (tercera huella de V3, calculada en el PC con lectura oculta o sobre el archivo sin mostrarlo). Así, si hiciera falta reaplicarlo, el valor guardado es el bueno.
2. **P6**: borrar la conversación de ChatGPT y la captura del token anterior.
3. Mover el token a tu gestor y decidir si se conserva `INFORMES/N8N TOKEN/n8n-runners-auth-token.txt` (excluido de Git y de la imagen).
4. Dejar anotado qué se hizo con el workflow de diagnóstico (borrado o inactivo) y que los 3 workflows siguen sin publicar.
V4b (parar el runner) **no se realiza** por decisión del administrador; la evidencia anterior la hace innecesaria.
