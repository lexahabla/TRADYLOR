# Auditor General v0.2 — seguimiento de incidencias (entregas 2a: motor, 2b: integración y 2c: memoria persistente)

Estado (12/11/2026): entrega 2a (motor) y 2b (integración en el informe, ver §8) hechas y probadas en local. Los workflows se han regenerado, pero **no se ha importado ni desplegado nada** y la web y el VPS no se han tocado. La memoria persistente (2c) está implementada en local, ver §9; NO desplegada.

## 1. Qué hace
Distingue, entre dos auditorías, las incidencias **nuevas**, **persistentes**, **resueltas**, **no verificadas** y **reaparecidas**.
Código: `automation/lib/seguimiento.mjs` (puro: sin red, sin disco, sin reloj —el «ahora» es siempre `generadoEn`—, sin `URL`/`structuredClone`/`Buffer`; incrustable más adelante en un nodo Code de n8n). Pruebas: `scripts/tests/automation-seguimiento.test.mjs` (26). Esquemas: `automation/schemas/estado-auditor.schema.json`, `seguimiento-auditor.schema.json` y, opcionales, `alcance` y `seguimiento` en `informe-auditor.schema.json` (los informes anteriores siguen siendo válidos).

## 2. Capas (el motor está separado de la persistencia)
| Función | Entrada → salida |
|---|---|
| `resumirInstantanea(informe)` | informe del Auditor → instantánea compacta (claves estables, calidad de la ejecución, alcance) |
| `compararConEstado(estado, instantánea)` / `compararInstantaneas(anterior, actual)` | → sección `seguimiento` (sin efectos) |
| `siguienteEstado(estado, instantánea, comparación)` | → `{guardar, motivo, estado, revisionBase}` |
| `validarEscritura(almacenado, resultado)` | comprobación compare-and-set que hará la persistencia (concurrencia) |
| `ejecutarSeguimiento(estado, informe)` | todo lo anterior encadenado, determinista |

## 3. Identificador estable
`claveSeguimiento` = `area:codigo:destino`. El destino se normaliza: sin protocolo, host ni fragmento; sin barras repetidas ni final; parámetros ordenados y sin `utm_*`, `fbclid`, `gclid`…; el id de un producto se respeta. No entran gravedad, título, estado HTTP ni recuentos. Si el id llegó recortado a 200 caracteres se parte de `evidencia.url`; los destinos de más de 120 caracteres llevan inicio + hash de 64 bits (nunca se recorta a ciegas), de modo que dos URL largas con el mismo prefijo no colisionan y el mismo destino da la misma clave con cualquier host. **No se infieren renombrados**: una URL realmente cambiada aparece como una resuelta y una nueva.

## 4. Reglas
- **Resuelta** solo si el `alcance` de la auditoría actual demuestra que su objetivo se revisó **con respuesta** (rutas, enlaces, fichas), que la salud se leyó (incidencias de salud) o que el catálogo se leyó **completo**. Si no: **no verificada** (con motivo: `sin_alcance`, `objetivo_no_revisado`, `salud_no_leida`, `catalogo_no_leido_completo`, `pagina_con_error`, `area_desconocida`). El contenido (título, h1, longitud) de una página que ahora da error HTTP no se da por arreglado. Una no verificada se conserva y **caduca** tras 7 ejecuciones sin revisarse.
- **Primera ejecución** (o cualquier reinicio de la referencia: entorno o host distinto, esquema incompatible, estado inválido, referencia de más de 14 días): **línea base**, sin «nuevas»; se guarda como referencia si la ejecución es completa.
- **Reaparecida**: vuelve dentro de 14 días tras resolverse (el estado recuerda las resueltas recientes, máx. 30).
- **Ejecución fallida** (sin respuestas): no se compara ni se guarda. **Parcial** (salud sin datos, catálogo no leído por completo, > 20 % de peticiones sin respuesta): se compara, pero **no sustituye** la última referencia válida. Un tope voluntario de enlaces no hace parcial una ejecución: solo deja sus objetivos como no verificados.
- Fecha de la auditoría ≤ la de la referencia: `sin_comparar` (`orden_invalido`).
- Los avisos del entorno local no son incidencias y no se siguen.

## 5. Estado y límites
`estado = {esquema, agente, entorno, host, revision, actualizadoEn, ultimaInstantanea{generadoEn, version, calidad, huella, idEjecucion?}, incidencias{clave → {area, codigo, gravedad, cantidad, primeraVez, ultimaVez, consecutivas, sinVerificar, reapariciones?}}, resueltasRecientes[], recortado?}`.
Solo claves públicas (rutas y códigos), gravedades y fechas: **nada de evidencias, textos, HTML ni secretos** (hay una prueba que lo comprueba). Máximo 200 incidencias y 64 KB (se descartan primero las de menor gravedad; `recortado` lo indica).

## 6. Concurrencia (diseñada, sin persistencia todavía)
Cada estado lleva `revision` y `siguienteEstado` devuelve `revisionBase` (sobre la que se calculó). La futura persistencia escribirá **solo si** `validarEscritura(almacenado, resultado)` da `ok` (la revisión almacenada coincide y la auditoría es más reciente). Si hay `conflicto_revision`, se relee el estado y se repite `ejecutarSeguimiento` con el mismo informe (es determinista); una auditoría más antigua que la almacenada da `orden_invalido`. Probado con dos ejecuciones concurrentes.

## 7. Riesgos pendientes
- (Resuelto en la 2b) El `alcance` ya lo emite el Auditor. Los informes anteriores a la 2b no lo traen: usados como referencia sirven, pero como informe actual todo lo que desaparece quedaría «no verificada». Es deliberado y conservador.
- Un parcial persistente (p. ej. un enlace que siempre agota el tiempo) no actualiza la referencia: aplicar el umbral del 20 % y revisar en la práctica.
- Si el estado se recorta (> 200 incidencias) las omitidas pueden reaparecer como «nuevas».
- Una URL renombrada se ve como resuelta + nueva.
- La persistencia (Data Table de n8n u otra) sigue **sin verificar** en n8n 2.38.6.

---

# Entrega 2b — integración en el Auditor (alcance + seguimiento en el informe)

Estado (12/11/2026): implementada y probada **solo en local**. Los workflows se han regenerado (ahora incrustan el motor), pero **no se ha importado ni ejecutado nada en n8n**, y siguen sin persistencia, sin programación y sin credenciales. Pruebas: `scripts/tests/automation-seguimiento-integracion.test.mjs` (16). Para poder incrustar el motor sin dependencia circular, `bytesUtf8` pasó a `common.mjs`.

## 8. Qué cambia en el informe
- **`alcance`** (nuevo, opcional en el esquema): `calcularAlcance` en `auditor.mjs` distingue por página tres niveles:
  1. **solicitada** (cuenta en `resumen.solicitadas`);
  2. **respondió** (llegó un estado HTTP, aunque sea 404/500): `rutas`, `enlaces`, `fichas`; si no hubo respuesta → `sinRespuesta` con motivo `tiempo_agotado`, `error_de_red` o `sin_datos`;
  3. **análisis completo** (rutas y fichas con HTML 200 con contenido): `contenido`; si respondió pero el contenido no se pudo analizar → `incompletas` con motivo `error_http`, `redireccion`, `respuesta_no_html`, `cuerpo_vacio` o `estado_inesperado`.
  Además: `salud`, `catalogo{leido, completo}` (completo = feed leído entero y sin errores), `resumen{solicitadas, respondieron, correctas (2xx), sinRespuesta, incompletas, noVisitados}`. **Pedir una URL nunca basta** para dar por resuelta una incidencia.
- **`seguimiento`** (nuevo, opcional): el resultado del motor + `origenReferencia` (`estado`, `instantanea` o `ninguna`) + la lista `indeterminadas`. El Markdown tiene un apartado «Seguimiento» (con claves estables, no textos) y la cobertura recoge «X de Y páginas respondieron…» y los enlaces no visitados.
- **Referencia anterior opcional** en `construirInformeAuditor(entrada)`: `estadoAnterior` (estado guardado) o `instantaneaAnterior` (instantánea **o informe** anterior, para pruebas y simulaciones). Sin ninguna → línea base; nada se clasifica como nuevo. El motor no se duplica: `auditor.mjs` solo llama a `ejecutarSeguimiento`.
- **Estado recortado**: si el estado anterior se guardó con `recortado.omitidas > 0`, lo que no está en él **no** se clasifica como nuevo sino como **indeterminada** (`estado_recortado`): pudo haberse omitido. Se registra en el nuevo estado y es seguible desde ese momento.
- **Contenido**: el motor usa `alcance.contenido` (si existe) para resolver `sin_titulo`, `h1`, `contenido_minimo` y `error_interno_200`: una página que redirige, no es HTML o da error HTTP deja esas incidencias como **no verificadas** (`analisis_incompleto` / `pagina_con_error`).
- **Tamaño de los nodos Code**: para mantenerlos bajo el límite del linter (80 kB), el constructor ya no incrusta los comentarios que ocupan líneas enteras (mismo código ejecutado). Tamaño máximo actual por nodo ≈ 68 kB; workflow de producción ≈ 208 kB.
- **Sin cambios** en el límite de **40 enlaces**, en la política de URLs ni en el aislamiento. El alcance y el seguimiento no añaden peticiones.
- Huella nueva del diagnóstico (`automation/dev/diagnostico-auditor-produccion.json`, SHA-256 LF `946f70483e70b8e7eb89ba015b8e93feb1b66315c0709c34f04fdee536237587` (huella tras las correcciones de 2c; la de la 2b era `06d7dc90…`); comprobable con `node scripts/automation/verificar-fichero-diagnostico.mjs`). El ejecutado en producción el 12/11/2026 fue el de la huella original `e1e5e34a…` (commit `bf20454`).

## 9. Entrega 2c — memoria persistente con instantáneas inmutables (Data Table de n8n)

Estado (12/11/2026): **implementada y probada en local con el simulador; NO desplegada, NO importada en ningún n8n de producción, sin programación.** La validación con las Data Tables reales se hace en el entorno aislado `tai-prueba-dt` (§9.7), con autorización. Arquitectura acordada tras la prueba T1–T7 (`PRUEBA-DATA-TABLES-LOCAL.md`, resultados en `INFORMES/2026-11-12/…_09_…`).

### 9.1 Arquitectura
```
Manual → Objetivos → Pedir rutas → Enlaces a revisar → Pedir enlaces → [catálogo y fichas, sólo local]
       → Uno tabla (Code mínimo) → Comprobar tabla (Data table › List, filtro por nombre) → Uno historial (Code mínimo)
       → Leer historial (Data table › Get: entorno = X, ORDEN generadoEn DESC, LÍMITE maxHistorial)
       → Informe (Code: informe + fila a guardar) → Solo la fila (Code mínimo) → Guardar instantánea (Data table › Insert, 2 salidas)
       → Confirmar escritura (Code: recibe las DOS salidas del Insert y completa el informe con el resultado real)
```
- **Memoria = tabla de SOLO INSERCIONES.** Cada auditoría completa añade una fila inmutable; nada se actualiza ni se borra. El estado se **reconstruye** en cada ejecución leyendo las últimas filas: se deduplica por `(entorno, idEjecucion)` conservando la de menor `id`, se ordena por `(generadoEn, idEjecucion)` y se pliega con el motor de 2a/2b (`reconstruirEstado`, sin duplicar lógica). El resultado depende del *conjunto* de filas y no del orden de inserción: dos ejecuciones simultáneas o fuera de orden **convergen** sin necesidad de atomicidad.
- **Motor** (`seguimiento.mjs`, puro): `reconstruirEstado`, `ejecutarSeguimientoConHistorial`, `filaDeInstantanea`, `deduplicarFilas`, `ordenarFilas`, `estadoDeTabla`, `origenDeModo`. **Integración** (`auditor.mjs`): `construirInformeYFila(entrada)` (la antigua `construirInformeAuditor` es un envoltorio compatible). **Nodos**: `scripts/automation/build-workflows.mjs` (los tres nodos Data table + dos Code mínimos). La persistencia (leer/insertar) la hacen **solo los nodos Data table**; los Code no acceden a la tabla.
- **Columnas** (todas texto): `entorno`, `host`, `generadoEn`, `idEjecucion`, `origen`, `calidad`, `huella`, `payload` (la instantánea compacta en JSON: claves estables, gravedades, fechas y el alcance; **sin evidencias, títulos, HTML ni secretos**; ≤ 60 KiB).
- **Qué se guarda y qué no.** Se guarda solo una auditoría **completa** y comparable (o línea base). **No** se guarda: ejecución fallida o parcial; fecha no posterior a la última válida (ejecución antigua o tardía: `orden_invalido`); origen no permitido (`origen_no_valido`); sin identificador de ejecución; instantánea demasiado grande; ejecución ya guardada (reintento: `ya_guardada`). Filas con fecha > 30 días en el futuro se descartan al leer (no bloquean).
- **Origen** con `$execution.mode`: `test` → `manual`, `production` → `programada` (otro valor se conserva y, por defecto, **no** actualiza el historial; `seguimiento.origenesValidos` en la configuración). `idEjecucion` = `ex-<$execution.id>`.
- **Sin reintentos** en el Insert (`retryOnFail: false`). Un fallo de la lectura o de la escritura **no detiene** el informe, y el informe lo refleja en `persistencia` (ver «Resultado de la escritura»).
- **Informe**: nuevo campo `persistencia` (`tabla.estado`: `ok | no_encontrada | ambigua | error_lectura | sin_configurar`; `lectura`; `escritura`) y apartado Markdown «Historial». El `seguimiento` mantiene nuevas, persistentes, resueltas, reaparecidas, no verificadas e indeterminadas (`origenReferencia: 'historial'`).
- **Tamaño de los nodos**: el constructor ya **poda** las bibliotecas: cada nodo Code incrusta solo lo que alcanza (además de quitar comentarios y sangrías). Nodo Informe ≈ 69 kB (límite del linter 80 kB); el resto < 9 kB; Investigador ≈ 14 kB.

### 9.2 Cómo se configura la tabla (sin identificadores de la instalación)
1. El **nombre** de la tabla vive en `automation/config/{produccion,local}.json` → `seguimiento.tabla` (por defecto `auditor_general_instantaneas`) junto a `maxHistorial` (60) y `origenesValidos`. Cambiarlo exige regenerar: `node scripts/automation/build-workflows.mjs --write`.
2. Los workflows **referencian la tabla por nombre** (`dataTableId = {"__rl": true, "mode": "name", "value": "<nombre>"}`), nunca por id ni por lista: no llevan ningún identificador de ninguna instalación y se pueden importar tal cual en cualquier n8n. El linter lo exige.
3. En cada n8n, **una sola vez**: importar y ejecutar a mano `auditor-instantaneas-crear-tabla.json` (workflow «Auditor · crear tabla de instantáneas», único donde se permite crear tablas, idempotente: `createIfNotExists`). Alternativa manual: crear en la pestaña *Data tables* del proyecto una tabla con ese nombre y estas 8 columnas de tipo texto.
4. **El nombre debe ser único.** n8n resuelve el nombre por *subcadena*: si existiera otra tabla cuyo nombre **contiene** ese texto, la referencia es ambigua. El nodo «Comprobar tabla» lo detecta (`tabla.estado = ambigua`), el informe lo avisa y **no se lee ni se escribe**.
5. Las Data Tables son del **proyecto**: el workflow debe vivir en el mismo proyecto (p. ej. Personal) que la tabla.

### 9.3 Concurrencia y consistencia (honestidad)
No hay actualizaciones: no hay carreras de escritura que proteger. Lo que se garantiza (y se prueba en el simulador) es la **convergencia**: el mismo conjunto de filas da el mismo estado con cualquier orden de inserción y con duplicados. Lo que **no** se afirma: transaccionalidad entre la lectura y la escritura de una misma ejecución (dos ejecuciones simultáneas ven el mismo historial y ambas insertan; el estado reconstruido después las incluye a las dos en orden cronológico).

### 9.4 Límites, validación y privacidad
Historial leído: últimas `maxHistorial` (60) filas por entorno (con una al día, ≈ 2 meses; el seguimiento de una incidencia solo ve esa ventana). Filas inválidas (JSON ilegible, esquema o entorno incoherente, calidad no completa, fecha incoherente o futura, > 60 KiB) se descartan **con motivo** y se cuentan en `persistencia.lectura.descartadas`. Una instantánea > 60 KiB no se guarda. La tabla no se poda: ≈ 1–16 KB por auditoría (≈ 6 MB al año); la cuota global de Data Tables (200 MiB por defecto) es muy superior. Los textos del informe (títulos, detalles, evidencias) **no** se guardan.

### 9.5 Riesgos pendientes
- Verificar con las Data Tables reales el nodo **List** con `filterName` (no probado todavía), `alwaysOutputData` y la salida de error de Get/Insert; el generador escribe los parámetros según el código fuente y la descripción real del nodo, no desde un nodo creado en el editor.
- Modo de un **disparador programado** (`$execution.mode = production`) no probado: solo `manual` (editor) lo está.
- La CLI `n8n execute` **no** puede usar Data Tables («module is disabled»): las ejecuciones deben pasar por el servidor (manual o programada). `importar-local.mjs`/`ejecutar-local.mjs` (CLI) no sirven para este workflow.
- Un fallo silencioso del Insert deja sin guardar esa auditoría: el siguiente informe compara con la última guardada.
- La tabla crece sin poda automática (workflow de poda no implementado).
- Una incidencia solo se sigue dentro de la ventana de `maxHistorial` filas.

### 9.6 Qué NO cambia
Ni el límite de 40 enlaces, ni la política de URLs, ni los nodos HTTP, ni el aislamiento, ni las peticiones; no hay programación ni activación; el Auditor sigue siendo de solo lectura respecto a Treidilor (la única escritura es en la Data Table de n8n).

### 9.7 Procedimiento previsto para validar 2c en el entorno aislado `tai-prueba-dt` (a autorizar; NO ejecutado)
El n8n de la prueba excluye `httpRequest` y no tiene salida: para ejecutar el Auditor hacen falta un **sitio de pruebas local** y levantar esa exclusión (cambios solo en `tai-prueba-dt`, sin tocar `treidilor-*`).
1. **Preparar (sin Docker)**: `automation/dev/prueba-data-tables/sitio-prueba.mjs` (servidor Node mínimo con páginas, `/api/health` y el feed del catálogo, con un endpoint local para cambiar el escenario) y `docker-compose.validacion.yml` (servicio `sitio` con la imagen `node:22-bookworm-slim` ya descargada, alias `puente-treidilor` y puerto 4350 en la red `tai-dt-aislada`; `NODES_EXCLUDE` sin `httpRequest`). Credencial **ficticia** «Treidilor automatización (solo lectura)» (Header Auth con un valor inventado) para el nodo de catálogo.
2. 🔒 Aplicar la variante (recrea `tai-dt-n8n`; los datos se conservan en `tai_dt_pg`) y comprobar el aislamiento otra vez (sin salida a Internet; el sitio solo es alcanzable dentro de la red).
3. 🔒 Importar `auditor-instantaneas-crear-tabla.json` y `auditor-general.local.json`; ejecutar a mano el primero. ✔ La tabla existe con 8 columnas `text`.
4. **V1 primera auditoría**: ✔ línea base, una fila (`origen = manual`), `persistencia.tabla.estado = ok`; verificar en PostgreSQL columnas y `payload` (tamaño, JSON válido, sin textos ni evidencias).
5. **V2 auditorías sucesivas** cambiando el escenario del sitio: ✔ nuevas, persistentes, resueltas, reaparecidas y no verificadas coinciden con lo esperado, y cada ejecución completa añade una fila.
6. **V3 parcial/fallida**: sitio con tiempos de espera y sitio caído: ✔ no se guarda nada; la última referencia queda intacta.
7. **V4 antigua/tardía y reintento**: (lectura directa del historial) ✔ orden inválido y `ya_guardada`.
8. **V5 concurrencia**: dos ejecuciones manuales simultáneas: ✔ dos filas con ids distintos; la siguiente auditoría compara con ambas.
9. **V6 tabla ambigua**: crear una segunda tabla cuyo nombre contenga el de la primera: ✔ `ambigua`, no se lee ni se escribe; borrarla después.
10. **V7 origen programado**: copia temporal del workflow con un disparador de programación cada minuto, activada 2 minutos y desactivada: ✔ `origen = programada` y el modo `production` leído.
11. **V8 fallos de la tabla**: renombrar/borrar la tabla y comprobar `no_encontrada`; (opcional) llenar la cuota. El informe sale siempre.
12. Registrar resultados en `INFORMES/` y **conservar** el entorno hasta nueva autorización; la limpieza sigue el procedimiento exclusivo de `PRUEBA-DATA-TABLES-LOCAL.md` §6.
Criterio de aceptación: todos los puntos ✔ sin cambiar la arquitectura; si algo exige cambiarla, se consulta antes.

### 9.8 Correcciones tras la integración real (12/11/2026) — resultado de la escritura
La prueba real en `tai-prueba-dt` (informe `INFORMES/2026-11-12/…_10_…`) descubrió dos fallos que el simulador no reproducía. Corregidos y revalidados con las Data Tables reales (49/49):
1. **List se ejecuta una vez por cada elemento de entrada** (la entrada eran las respuestas de todos los enlaces): devolvía la tabla repetida N veces y se interpretaba como «ambigua», así que la memoria **nunca** se usaba. Corrección: Code mínimo **«Uno tabla»** antes de «Comprobar tabla» y `estadoDeTabla` distingue las tablas por `id` (la misma tabla repetida ya no es ambigua; dos tablas realmente distintas —mismo nombre con otro id, o un nombre que contiene el buscado— sí lo son).
2. **Un Insert que falla puede no dar ningún error.** Medido en n8n 2.38.6: con `continueErrorOutput` los errores de n8n (p. ej. tabla inexistente) salen por la **segunda salida** con su mensaje, pero una **validación fallida (columna desconocida) NO da error**: el nodo termina «success», no guarda nada y devuelve el elemento de entrada envuelto (`{json:{json:…,pairedItem},pairedItem}`) por la salida correcta. Cambiar `onError` por sí solo no basta.

**Resultado de la escritura (`persistencia.escritura.resultado`).** El informe se genera ANTES del Insert, así que solo puede decir:
- `no_procede`: no se decidió guardar (parcial, fallida, antigua, origen no permitido, tabla no disponible…). No hay Insert ni confirmación.
- `pendiente`: se decidió guardar; el resultado real lo confirma el nodo posterior.
Después, el nodo **«Confirmar escritura»** (Code) recibe las **dos salidas** del Insert y devuelve **el mismo informe** con `resultado`:
- `guardada` (con `filaId`) **solo si el Insert devolvió la fila guardada**: un `id` numérico y **nuestro** `idEjecucion`. Que no haya error no prueba que se guardó.
- `fallida`: `motivoFallo = error_insert` (llegó un error por la segunda salida; se guarda su mensaje, ≤ 200 caracteres) o `sin_confirmacion` (el Insert no devolvió la fila: p. ej. validación silenciosa).
El Markdown se regenera («Escritura **guardada** (fila N…)» o «⚠ **Escritura FALLIDA: la instantánea NO se guardó** (…)»). El informe se conserva **entero**; solo cambian la escritura y su línea de Markdown.

**Dónde está el informe definitivo.** Si hubo intento de guardar, en la salida de «Confirmar escritura»; si no (`no_procede`), en la de «Informe» (que ya es definitivo). La salida de «Informe» nunca promete que se guardará.

**Límites conocidos.** Con la validación silenciosa n8n no devuelve el motivo: el informe dice `sin_confirmacion`. Si el Insert no produjera ninguna salida, «Confirmar escritura» no se ejecuta y el informe queda en `pendiente` (no se presenta como guardado). La tabla no se poda automáticamente.

**Pruebas.** Simulador: List y Get por elemento de entrada, dos salidas del Insert, validación silenciosa y error de tabla (comportamiento real medido). Regresión: 1, 3, 33 y 40 enlaces, `estadoDeTabla`, `confirmarEscritura` y fallos del Insert (`automation-persistencia.test.mjs`). Real: List con 3 y 33 enlaces, tablas ambiguas, escritura confirmada con el id real de la fila, error forzado de validación y de tabla, y conservación del informe (`INFORMES/…_11_…`).
