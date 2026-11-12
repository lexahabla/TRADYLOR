# Rotación segura de `N8N_RUNNERS_AUTH_TOKEN` (n8n 2.38.6 + n8nio/runners:2.38.6, EasyPanel)

Estado: **PROCEDIMIENTO PREPARADO, NO EJECUTADO** (12/11/2026). Claude no tiene acceso a producción y no ha visto ni el token actual ni el nuevo. Lo ejecuta el administrador tras autorizarlo.
Regla: el token **nunca** se pega en chat, informes, commits ni capturas. Solo se comparan huellas cortas (12 caracteres de un SHA-256).

## 1. Qué es y qué riesgo hay
- n8n en modo de runners **externos** abre un *task broker* (puerto 5679, solo red interna del proyecto). El contenedor `n8n-runner` se conecta a él y se autentica con `N8N_RUNNERS_AUTH_TOKEN`. El **mismo valor** debe estar en `n8n` y en `n8n-runner`.
- Quien tenga el token **y alcance el puerto 5679** podría registrarse como runner y recibir el código de los nodos Code (que puede contener datos de ejecución). No da acceso a la interfaz, a credenciales guardadas ni a la base de datos.
- Riesgo real = (token visible) × (¿puerto 5679 alcanzable desde fuera de la red interna?). Se comprueba en el paso P3. Aun así se rota: es barato.
- **Alcance de la captura**: si en ella se veían otras variables (`N8N_ENCRYPTION_KEY`, contraseña de PostgreSQL, claves de API), esas **también** están expuestas y su rotación es distinta y más delicada (la clave de cifrado NO se cambia sin migrar las credenciales). Decídelo antes de seguir: dime solo los **nombres** de las variables visibles.

## 2. Servicios afectados
| Servicio | Cambio | Reinicio |
|---|---|---|
| `n8n` (principal) | `N8N_RUNNERS_AUTH_TOKEN` = nuevo | **Sí** (lee el entorno al arrancar). Interrumpe ejecuciones en curso, la interfaz y los webhooks unos segundos |
| `n8n-runner` | `N8N_RUNNERS_AUTH_TOKEN` = el mismo nuevo | **Sí**. Reintenta la conexión solo hasta que el broker esté disponible |
| `n8n-db` (PostgreSQL) | ninguno | No |
| Treidilor (proyecto `tradylor`) | ninguno | No |
Si existiera un segundo runner o un worker, también llevaría el token: compruébalo en P2.

## 3. Evitar interrupciones
- Con n8n 2.38.6 monolítico es **imposible rotar sin un corte breve** (el principal tiene que reiniciar). Se minimiza: ventana corta (< 2 min), sin ejecuciones en curso, sin workflows con programación activa cerca de esa hora.
- Hoy el Auditor **no** está importado ni programado: cualquier otro workflow activo de ese n8n (si lo hay) es lo que se interrumpe. Lista los activos en P2 y elige una hora sin disparos.
- Mientras `n8n` y `n8n-runner` no coinciden, los nodos Code fallan («runner no disponible»); el resto de nodos funciona. Por eso se preparan **ambos** valores antes de desplegar ninguno.

## 4. Antes (sin cambios en producción)
| # | Acción | ✔ |
|---|---|---|
| P1 | **Generar** el token nuevo en tu PC, sin pantalla compartida: `openssl rand -base64 36 \| tr -d '\n=+/'` (o el generador del gestor de contraseñas, ≥ 32 caracteres). Guárdalo en el gestor con nombre «n8n runners auth token (12/11/2026)». No lo copies a ningún otro sitio | guardado; no lo pegas aquí |
| P2 | EasyPanel → `practice_project_n8n` → `n8n`, `n8n-runner` (y cualquier otro servicio): ¿quién tiene `N8N_RUNNERS_AUTH_TOKEN`? Anota **solo nombres de servicio**. En n8n → *Workflows*: anota cuáles están **Active** | lista de servicios y de workflows activos |
| P3 | **¿Puerto 5679 expuesto?** EasyPanel → `n8n` → *Domains / Ports*: ✔ no hay dominio ni puerto publicado hacia 5679. En el VPS (solo lectura): `docker ps --format '{{.Names}}  {{.Ports}}' \| grep 5679` → ✔ ninguna línea con `0.0.0.0:5679` o `:::5679`. Si 5679 estuviera publicado: **urgente**, retíralo antes que nada (es el verdadero riesgo) | no publicado / publicado |
| P4 | Copia de seguridad fresca: *Backups* de `n8n-db` → *Backup now* (la rotación no toca la base, pero es la regla). Anota nombre y hora | copia creada |
| P5 | Anotar el **estado anterior** sin valores: captura de *Environment* de `n8n` y `n8n-runner` con el valor del token **tapado** (o sin captura: basta saber que la variable existe y sus otras `N8N_RUNNERS_*`) | nombres de variables anotados |
| P6 | Eliminar la captura expuesta y cualquier copia (chat, correo, nube, papelera). Si se compartió con terceros, considera el token comprometido (lo es ya) | borrada |
| P7 | Estado sano previo: n8n → *Executions* sin fallos recientes; logs de `n8n-runner` con conexión estable | ✔ |

## 5. Rotación (ventana corta)
Hazla con la interfaz de EasyPanel, **un servicio detrás de otro, sin pasar por el chat**. Ten el token en el portapapeles del gestor con borrado automático.
1. **R1. Preparar `n8n-runner`**: *Environment* → cambia el valor de `N8N_RUNNERS_AUTH_TOKEN` → **Save** (en EasyPanel, guardar no reinicia). **No Deploy todavía.**
2. **R2. Preparar `n8n`**: igual en `n8n` → **Save**, sin Deploy.
3. **R3. Verificar que ambos valores coinciden sin mostrarlos** (opcional antes de desplegar; es el contenedor actual, así que aún muestra el valor viejo): se hace tras el despliegue, en V3.
4. **R4. Desplegar `n8n`** (Deploy/Restart). Espera a que la interfaz responda (≈ 30–60 s).
5. **R5. Desplegar `n8n-runner`** (Deploy/Restart). Se conecta solo (≈ 10–20 s). *(Alternativa equivalente: runner primero; el orden no es crítico porque el runner reintenta.)*
6. Anota hora de inicio y fin de la ventana.

## 6. Comprobaciones posteriores (todas ✔ antes de dar por buena la rotación)
| # | Comprobación | ✔ |
|---|---|---|
| V1 | Logs de `n8n-runner`: línea de conexión/registro correcta con el broker y **ningún** «auth»/«unauthorized»/«invalid token»/«connection refused» repetido tras los primeros reintentos | ✔ |
| V2 | Logs de `n8n`: el broker registra el runner; sin errores de autenticación | ✔ |
| V3 | **Mismo valor en ambos, sin verlo**: `docker exec <n8n> sh -c 'printf %s "$N8N_RUNNERS_AUTH_TOKEN" \| sha256sum \| cut -c1-12'` y lo mismo con `<n8n-runner>` (los nombres: `docker ps --format '{{.Names}}'`). ✔ las dos huellas **coinciden**. En tu PC: `read -rs K; printf %s "$K" \| sha256sum \| cut -c1-12; unset K` con el valor del gestor: ✔ coincide también (no es el viejo) | 3 huellas iguales |
| V4 | **Prueba funcional**: en n8n, abre el workflow de diagnóstico (F2) y **Execute workflow** una vez: `resultado: OK`, `total: 34`, `fallos: []`. Confirma que un nodo Code se ejecuta **en el runner** con el token nuevo. (Es el fichero sin red ya verificado; si lo borraste, importa de nuevo el mismo fichero con la huella de `F2-DIAGNOSTICO-PRODUCCION.md`) | OK |
| V5 | Los workflows que estaban activos en P2 siguen **Active** y sin errores tras la primera ejecución posterior | ✔ |
| V6 | *Executions*: la ejecución de V4 consta como Success; ninguna ejecución con error por la caída | ✔ |
| V7 | El token viejo ya no es válido: queda implícito (el broker solo conoce el nuevo). No se prueba con el viejo | — |
| V8 | Si hubo un tercero con el token: logs de `n8n` de los días previos sin registros de runners desconocidos (solo si hay registros de conexión; no es fiable al 100 %) | informativo |

## 7. Plan de recuperación
| Síntoma | Causa probable | Acción |
|---|---|---|
| Runner con «unauthorized»/«invalid token» | Los valores difieren (error de copia, espacio, salto de línea) | Repite R1–R2 pegando el valor desde el gestor (sin espacios ni saltos finales); redeploy de ambos; comprueba V3 |
| Nodos Code «task runner unavailable» pero el runner conecta | `n8n` aún con el valor viejo (no redeployado) | Deploy de `n8n`; V1–V2 |
| `n8n` no arranca tras el cambio | Variable mal escrita, nombre alterado | Corrige el nombre exacto `N8N_RUNNERS_AUTH_TOKEN` y redeploy; si urge, restaura el estado de P5 y reintenta después |
| El runner sigue sin conectar a pesar de coincidir | Red o broker (5679, `N8N_RUNNERS_BROKER_*`) | Revisa que `N8N_RUNNERS_TASK_BROKER_URI` del runner apunta al servicio `n8n` correcto; no cambies nada más |
| Urgencia: el servicio debe funcionar ya y no se resuelve en 15 min | — | **Última opción (no recomendada)**: volver el valor anterior en ambos (restaura el servicio, pero es el token expuesto: rotar de nuevo cuanto antes). El modo de runners **interno** (`N8N_RUNNERS_MODE=internal` en `n8n`, sin `n8n-runner`) también restablece los Code, con menos aislamiento; es otra decisión que te pediría confirmar |
La rotación no toca datos: no hay nada que restaurar de la base (la copia de P4 es solo precaución).

## 8. Después
- Registra en el informe: fecha/hora, ventana, resultado de V1–V6 (sin valores), quién y desde dónde.
- Borra el token viejo de cualquier sitio donde exista (gestor, notas).
- Buenas prácticas: no hacer capturas de *Environment* con valores; usa la vista oculta o tapa los valores. Si EasyPanel ofrece variables como secretos, considera usarlas (cambio de servicio: autorización aparte).
- Reglas de la guía: la rotación no cambia nada del Auditor ni de Treidilor; F3 sigue pendiente de `F2B-CIERRE-PENDIENTES-ANTES-DE-F3.md` (y de esta rotación si decides que es previa).

## Registro de resultados (plantilla)
| Punto | Resultado | Hora |
|---|---|---|
| Nombres de variables visibles en la captura | | |
| P3 puerto 5679 publicado | no / sí | |
| P4 copia creada | | |
| Ventana de rotación (inicio–fin) | | |
| V1/V2 logs sin errores de autenticación | | |
| V3 huellas coinciden (3) | sí / no | |
| V4 diagnóstico OK (34/34) | | |
| V5/V6 workflows activos y ejecuciones | | |
