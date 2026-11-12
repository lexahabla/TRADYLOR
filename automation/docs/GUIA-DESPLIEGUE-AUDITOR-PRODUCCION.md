# Guía operativa — primer despliegue controlado del Auditor General (n8n de producción)

**Estado: SOLO PREPARACIÓN. Nada de esto se ha ejecutado en el VPS ni en producción.** Cada paso marcado 🔒 requiere tu autorización expresa en el momento. Regla de oro de toda la guía: **mira nombres, no valores; no pegues secretos en ningún sitio**.

Datos ya verificados por ti: n8n de producción **2.38.6** · proyecto EasyPanel `practice_project_n8n` con `n8n`, `n8n-db` (PostgreSQL) y `n8n-runner` · Treidilor en el proyecto `tradylor` · n8n local de pruebas **2.46.6**. Copias y recursos: pendientes de que los verifiques.

## 1. Qué se despliega y por qué es el candidato más seguro
Un solo workflow: `automation/workflows/auditor-general.produccion.json`. Solo lee `/api/health` y páginas públicas por `https://treidilor.com`. No necesita credenciales, red interna compartida, MCP, API de Treidilor ni cambios en Treidilor. **No hace falta que los proyectos `tradylor` y `practice_project_n8n` compartan red**: el Auditor sale a Internet y entra por el dominio público.

## 2. Compatibilidad 2.38.6 ↔ 2.46.6 (revisada)
| Elemento | Qué usa el Auditor | Evidencia |
|---|---|---|
| Disparador manual | `manualTrigger` v1 | v1 en 2.46.6 (única versión) |
| Nodo Code | `code` **v2** | 2.46.6 soporta v1 y v2; v2 existe desde la serie 1.x (a confirmar con el diagnóstico) |
| Nodo HTTP | `httpRequest` **4.2** | 2.46.6 usa 4.5 por defecto pero conserva 4.2; el Auditor usa deliberadamente una versión **más antigua**, no más nueva |
| Nota | `stickyNote` v1 | v1 |
| Opciones HTTP | `batching`, `redirect`, `response.fullResponse` | mismas claves desde 4.1 |
| JSON | sin `id`, `versionId`, `tags: []`, `active: false`, sin credenciales, sin `availableInMCP` | formato mínimo de importación |
| Código (task runner) | sin `URL`, `URLSearchParams`, `structuredClone`, `require`, `process`; solo `Intl`, `Date`, `String`… | probado en 2.46.6 (runner interno) |
**Lo que NO se ha podido verificar** (no hay 2.38.6 localmente y no se ha descargado nada): que 2.38.6 acepte HTTP 4.2 con esas opciones y que **tu `n8n-runner` (modo externo)** tenga las mismas globales. Por eso el primer paso real es el **diagnóstico (§4)**, que lo comprueba sin tocar la red: si el nodo HTTP deshabilitado del diagnóstico se importa con «?», o el diagnóstico falla, **no se continúa** y se me pasa el resultado. No se prepara ninguna actualización de n8n.

## 3. Checklist de verificación de infraestructura (🔒 las consultas en el VPS; todas de solo lectura)
Anota solo lo que pone en la columna «Anotar». «No copiar» = no lo pegues ni lo captures.
| # | Qué | Dónde (EasyPanel / n8n) | Anotar | No copiar |
|---|---|---|---|---|
| 1 | Versión y edición | n8n → avatar → *About n8n* (versión) y *Settings → Usage and plan* (Community/Enterprise) | versión, edición | claves de licencia |
| 2 | Imagen del servicio | EasyPanel → `practice_project_n8n` → `n8n` → *Source* | tag de la imagen (¿fijo o `latest`?) | — |
| 3 | Runner | EasyPanel → `n8n-runner` → *Source* y *Environment* | tag (¿igual a 2.38.6?), modo externo sí/no | valores de variables (token del runner) |
| 4 | Base de datos | `n8n-db` → *Source* (versión de PostgreSQL), *Mounts* (volumen), *Metrics* (disco/RAM) | versión PG, tamaño del volumen, uso actual | usuario/contraseña, cadena de conexión |
| 5 | Variables (solo NOMBRES) | `n8n` → *Environment*: comprueba que existen o no `EXECUTIONS_DATA_PRUNE`, `EXECUTIONS_DATA_MAX_AGE`, `EXECUTIONS_DATA_PRUNE_MAX_COUNT`, `N8N_RUNNERS_*`, `N8N_PUBLIC_API_DISABLED`, `N8N_BLOCK_ENV_ACCESS_IN_NODE`, `NODES_EXCLUDE`, `GENERIC_TIMEZONE`, `WEBHOOK_URL` | qué nombres hay y **los valores de retención** (días/nº) | cualquier valor que sea clave, token o contraseña (`N8N_ENCRYPTION_KEY`, `DB_*`) |
| 6 | Redes | EasyPanel suele conectar los servicios a una red común (`easypanel`): **verifícalo, no lo supongas** (ver comandos abajo) | si `n8n` y `tradylor_*` comparten red o no | — |
| 7 | Salida a Internet / dominio | EasyPanel → `n8n` → *Domains*: HTTPS activo | dominio público de n8n, HTTPS sí/no | — |
| 8 | Autenticación | n8n → *Settings → Personal* (2FA activada), *Settings → Users* (cuántos usuarios), *Settings → n8n API* (¿hay claves?), *Settings → Instance-level MCP* (**debe estar desactivado**) | 2FA sí/no, nº usuarios, API/MCP sí/no | claves de API, enlaces de invitación |
| 9 | Workflows existentes | n8n → *Workflows* | nº total, cuántos activos, si hay nombres que empiecen por «Treidilor AI» | contenido de los workflows |
| 10 | Recursos del VPS | Hostinger hPanel → VPS → *Overview/Monitoring*; EasyPanel → *Dashboard* | RAM total/usada, CPU, disco total/usado | — |
| 11 | Copias | Hostinger hPanel → VPS → *Snapshots/Backups*; EasyPanel → `n8n-db` → pestaña de copias; volumen de n8n | fecha de la última copia, frecuencia, **si se ha probado una restauración** (fecha) | credenciales de S3 u otros destinos |
| 12 | Clave de cifrado | Comprueba que **existe una copia de `N8N_ENCRYPTION_KEY` fuera del VPS** (gestor de contraseñas) | sí/no | **el valor** |

Comandos de solo lectura en el terminal del VPS (SSH de Hostinger), que muestran **nombres, no valores**:
```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'                       # servicios e imágenes (versiones)
docker network ls                                                                    # redes
docker network inspect easypanel --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'   # ¿comparten red n8n y tradylor? (ajusta el nombre de red)
docker inspect <contenedor-n8n> --format '{{range .Config.Env}}{{println .}}{{end}}' | cut -d= -f1   # SOLO nombres de variables
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'      # CPU/RAM por servicio
df -h / ; free -m ; docker system df                                                  # disco y memoria
docker exec <contenedor-n8n-db> psql -U <usuario> -d <base> -c "select pg_size_pretty(pg_database_size(current_database()))"   # tamaño de la BD (el usuario no es un secreto; no hay contraseña en el comando)
```
**Nunca** ejecutes `docker inspect` sin el `cut -d= -f1` ni `printenv`/`env` sin filtrar.

## 4. Diagnóstico del entorno (🔒 ejecutarlo en producción solo con autorización)
Dos workflows **sin red ni credenciales** (no hacen ninguna petición):
1. `automation/dev/diagnostico-auditor-produccion.json` — ejecuta el código real del Auditor con respuestas sintéticas (34 comprobaciones: entorno JS, política de URLs, recorrido completo, informe). Incluye un nodo HTTP 4.2 **deshabilitado y sin conexiones** que no se ejecuta: sirve para ver si esa versión de n8n lo reconoce.
2. `automation/dev/diagnostico-entorno-code.json` — lista qué globales existen (URL, Intl, Date…) en el entorno Code (el del `n8n-runner`).
Cómo: n8n → *Workflows → ⋯ → Import from file* → **no activar** → *Execute workflow* (manual). Resultado esperado del 1: `resultado: "OK"`, `fallos: []`, `sinRed: true`. Si el nodo deshabilitado aparece con «?» o `resultado` es `FALLO`: **parar**, copiar solo el campo `fallos`. Después, borrar ambos (Workflows → ⋯ → Delete). Ya se ejecutaron con éxito en el n8n local 2.46.6.

## 5. Revisión de `auditor-general.produccion` (hecha; fijada por pruebas automáticas)
- **Rutas**: salud + `/`, `/catalogo`, `/categorias`, `/metodologia` + hasta 40 enlaces internos descubiertos en esas páginas. Máximo **45 GET**; en la prueba accidental local-contra-producción fueron 38.
- **Rechazadas por la política (probado)**: `/producto/*`, todo `/api/*` salvo `/api/health`, `/out`, `/p`, `/checkout`, `/upayp1b4`, `/admin`, `/mi-radar`, `/perfil`, `/share`, rutas con `..` o `%2e`, otros hosts, `http://`, credenciales en la URL, `localhost`/hosts locales.
- **Peticiones**: solo `GET`, sin cuerpo, sin parámetros añadidos, 2 cabeceras (`User-Agent: TreidilorAI-auditor-general/0.2 (solo lectura)` y `X-Treidilor-Agente`), sin cookies ni `Authorization`, sin seguir redirecciones, 1 petición cada 700 ms, timeout 15 s.
- **Dependencias**: ninguna credencial; ni MCP, ni `availableInMCP`, ni red local, ni tokens, ni programador, ni webhook. La única mención «local» es una lista de **denegación** embebida en la política.
- **Pruebas**: `automation-agents.test.mjs` (revisión estática y simulación de todas las peticiones).

## 6. Riesgos e impacto en la analítica
| Riesgo | Valoración | Mitigación |
|---|---|---|
| Analítica de Treidilor | **Sin impacto en la propia**: solo cuentan visitas a `/producto/*` (middleware), `/api/analytics/event` (lo envía el JS del navegador; n8n no ejecuta JS) y `/api/redirect`; el Auditor no pide ninguna. Las páginas públicas que pide no escriben datos en el servidor (verificado en el código) | La primera ejecución manual se contrasta con los registros de acceso de Treidilor |
| Analítica externa (CDN/Traefik/hosting) | Aparecerán ≤ 45 peticiones identificadas con su User-Agent | Filtrar por `TreidilorAI-` si se quiere |
| Carga en Treidilor | ≈ 45 GET en ≈ 30-60 s a 1,4 peticiones/s | Fuera de horas punta al programar |
| **Datos guardados por n8n** | **Riesgo principal.** Cada ejecución guarda los HTML descargados: ≈ 9 MB por ejecución (medido en la ejecución accidental: 9,3 MB con 38 páginas) → ≈ 270 MB/mes diarios en PostgreSQL antes de la limpieza | Comprobar `EXECUTIONS_DATA_MAX_AGE`/`PRUNE` (§3 #5) y el disco libre (#4, #10) **antes** de programar |
| Memoria del runner | El nodo «Informe» recibe ≈ 9 MB de respuestas | Verificar RAM disponible (#10); el diagnóstico no lo cubre: se verá en la ejecución manual |
| Redirecciones/WAF/Cloudflare | Un 301/403 aparece como incidencia (no se siguen redirecciones) | Se interpreta en la primera ejecución manual |
| Salida del VPS a su propio dominio (hairpin) | Posible bloqueo de red | La salud (`/api/health`) es la primera petición: si falla, el informe lo dice sin más efecto |
| Secretos | No hay | El workflow no puede contenerlos (linter + pruebas) |

## 7. Procedimiento (🔒 cada fase con tu autorización)
**F0 — Preparación (tú, solo lectura):** completar §3; confirmar copia reciente y fecha de restauración probada.
**F1 — Punto de retorno:** exportar los workflows actuales de n8n (si hay) y anotar versión de n8n/runner. No hay nada más que guardar: este despliegue no cambia servicios ni variables.
**F2 — Diagnóstico (§4)** → resultado `OK`. Borrar los workflows de diagnóstico.
**F3 — Importar `auditor-general.produccion.json` desactivado:** *Import from file*. Comprobar: interruptor **Inactive**; ningún nodo con «?» ni credencial pendiente; nombre «Treidilor AI · Auditor General v0 (produccion)». No tocar nada más.
**F4 — Ejecución manual única** (*Execute workflow*), idealmente en horas de poco tráfico. En paralelo, ojo a la RAM del VPS.
**F5 — Revisión de resultados:**
 1. *Executions*: el nodo «Pedir rutas» muestra 5 elementos y «Pedir enlaces» ≤ 40; en ambos solo URLs `https://treidilor.com/...` sin `/producto`, `/api` (salvo health), `/out`, `/checkout`.
 2. Todos los códigos esperados (200); ningún error de red; duración y tamaño de la ejecución (anotar MB).
 3. Nodo «Informe»: `estado`, incidencias reales vs. falsos positivos, `cobertura.noRevisado`.
 4. Registros de acceso de Treidilor (EasyPanel → `tradylor` → *Logs*): ~45 GET con `TreidilorAI-auditor-general/0.2`, ninguna escritura ni error 5xx provocado.
 5. Estado del VPS durante la ejecución (CPU/RAM) y espacio en disco antes/después.
**F6 — Reversión (si algo no cuadra o por decisión):** desactivar (ya lo está) → *Delete* del workflow → borrar sus ejecuciones (*Executions → Delete*) si ocupan espacio. No hay nada más que deshacer (sin credenciales, sin variables, sin cambios en Treidilor). Reimportar la exportación de F1 si procede.
Criterio de parada inmediato: error 5xx en Treidilor, memoria del VPS > 85 %, peticiones fuera de la lista de §5, o cualquier valor sensible visible en una ejecución.

## 8. Criterios previos a autorizar la programación diaria (🔒)
Todos deben cumplirse y quedar anotados:
1. ≥ 3 ejecuciones manuales en días distintos, sin peticiones fuera de §5 ni errores de red, y con informes coherentes (sin falsos positivos relevantes).
2. Tamaño por ejecución medido y **retención configurada** (días/nº) con disco suficiente para ≥ 90 días; crecimiento de PostgreSQL aceptable.
3. Diagnóstico `OK` en 2.38.6 y runner; versión de n8n y runner **iguales** y documentadas.
4. **Copia reciente y restauración probada** (fecha) de PostgreSQL y del volumen de n8n; copia de `N8N_ENCRYPTION_KEY` fuera del VPS.
5. 2FA activo, Instance-level MCP desactivado, sin claves de API innecesarias, n8n solo por HTTPS.
6. Franja horaria fuera de punta (p. ej. 04:30), una vez al día, sin solaparse con copias.
7. Canal y responsable de revisión del informe (o decisión consciente de «sin aviso», solo consulta manual); qué se hace ante `critico`.
8. Primera semana programada con revisión diaria, y decisión explícita de continuar o desactivar.
9. Interruptor de parada conocido: desactivar el workflow en n8n.
La programación se crea **a mano en n8n** (el repositorio no activa nada) y solo tras tu «sí» explícito.

## 9. Requisitos para el Investigador Comercial en producción (fase posterior, 🔒 aparte)
El Investigador necesita datos que la web pública no da (catálogo, descuentos verificados, stock), vía la **API de automatización**, hoy solo local:
1. **Desplegar el código de la API en Treidilor** (push a `main`) con `AUTOMATION_API_ENABLED` sin definir: la API existe pero responde 404 (desactivada). Verificar `sourceHash`.
2. **Activarla** definiendo `AUTOMATION_API_ENABLED=true` en EasyPanel (proyecto `tradylor`) y reiniciar el servicio. Interruptor de parada: quitar la variable.
3. **Crear un cliente** `catalog:read` con caducidad corta (7-30 días) con `POST /api/admin/automation-clients` desde una sesión de administrador (hoy no hay pantalla en el panel: es una tarea pendiente o se usa la consola del navegador). El token se ve **una vez**.
4. **Credencial en el n8n de producción**: *Header Auth* llamada «Treidilor automatización (solo lectura)» con `Authorization: Bearer tai_…`; creada por ti en el n8n, nunca en el repositorio ni en un chat.
5. **Acceso de red**: el n8n llega a `https://treidilor.com/api/automation/v1/catalog` por el dominio público (no requiere red compartida). Si se quisiera una URL interna (`http://…`), habría que cambiar la política (hoy producción exige https) y comprobar la red real (§3 #6).
6. **Nuevo workflow** `investigador-comercial.produccion` y ajuste de la política: hoy el modo `publico` prohíbe el feed y las fichas; hay que añadir un modo «lectura por API» que permita solo `/api/automation/v1/catalog` con credencial, manteniendo fichas y el resto prohibidos. Con sus pruebas, linter y revisión como el Auditor.
7. **Límites**: 30 peticiones/min y 2 000/día por cliente (suficiente: 1-2 páginas por ejecución); revisar la auditoría (`GET /api/admin/automation-clients?audit=50`).
8. **Rotación/revocación**: calendario de renovación y procedimiento de revocación inmediata (`action:'revoke'`).
9. Revisión de protección de datos: el feed no contiene datos personales ni enlaces de afiliado.
10. Mismas condiciones de copia, retención y revisión manual que el Auditor.

## 10. Lo que NO se hará
Actualizar n8n; tocar `n8n`, `n8n-db`, `n8n-runner` o `tradylor`; cambiar variables; crear credenciales; activar o programar; conectar el MCP al n8n de producción; ejecutar nada en producción sin tu autorización por fase.
