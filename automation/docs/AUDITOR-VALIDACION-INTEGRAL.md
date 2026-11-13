# Validación integral del Auditor General v0.2 en `tai-prueba-dt` — informe consolidado

Fecha: 12/11/2026. Estado: **COMPLETADA EN LOCAL y aceptada por el responsable.** No hay nada desplegado, ni importado en producción, ni activado fuera del entorno de pruebas.
Alcance: auditoría base, seguimiento histórico, fallos de persistencia y ejecución programada, con el Auditor local **sin modificar** (`automation/workflows/auditor-general.local.json`, idéntico byte a byte a la copia importada) y la memoria persistente 2c tal como está en el repositorio.

## 0. Entorno de la validación (todo local y aislado)
| Elemento | Valor |
|---|---|
| Proyecto Compose | `tai-prueba-dt` (n8n **2.38.6** + PostgreSQL **17**) + `tai-dt-sitio` (sitio sintético, alias `puente-treidilor`, `:4350`) |
| Red | `tai-dt-aislada`, `internal: true` (sin Internet; `1.1.1.1`, `treidilor.com` y `host.docker.internal` bloqueados, comprobado antes y después de cada fase) |
| Puertos publicados | solo `127.0.0.1:5689` (n8n de pruebas) |
| Sitio auditado | **sintético**, 7 escenarios, token y credencial FICTICIOS (`sitio-prueba.mjs`); nunca `treidilor.com` |
| Tabla | Data Table `auditor_general_instantaneas` (tabla física `data_table_user_E4yM0pdxG3ah5v3g`) |
| Configuración | `local.json` (`maxEnlaces` **60**, `baseUrl http://puente-treidilor:4350`); `produccion.json` usa 40 y **no se ejercitó** aquí |
| No tocado | `treidilor-ai-pruebas`, redes y volúmenes ajenos, VPS, EasyPanel, producción, código del Auditor y de 2c |

Herramientas y resultados brutos (fuera del repo): `D:\treidilor-pruebas\prueba-dt\` (`scripts-2c\paso3…paso6`, `salidas\paso3-* … paso6-*`).

## 1. Primera auditoría (paso 3) — línea base
Ejecución **129** (manual, escenario base): `success`, 19 nodos. Informe y Markdown válidos con el esquema; sin secretos; solo GET al sitio sintético y dentro de los límites (enlaces, catálogo paginado, sin rutas prohibidas). Primera ejecución del entorno `local` ⇒ **línea base** (sin comparar). Persistencia `guardada`, **fila 87** (`local`, `ex-129`, `manual`, `completa`). Las filas 82–86 (entorno `produccion`, de las pruebas T1–T7 previas) quedaron intactas. El nodo HTTP no estuvo bloqueado por la protección SSRF en la red aislada (solo se retiró `httpRequest` de `NODES_EXCLUDE` en el override de la validación).

## 2. Seguimiento histórico (paso 4) — ejecuciones 130–137
Cada ejecución se contrastó contra lo que el sitio sintético sirvió realmente (registro de peticiones) y contra la tabla en PostgreSQL.
| # | n8n | Escenario | Calidad | Nuevas | Persist. | Resueltas | Reaparec. | No verif. | Escritura / fila |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 130 | arreglado | completa | 0 | 0 | **7** (todas con respuesta real del destino) | 0 | 0 | guardada / **88** |
| 2 | 131 | mixto | completa | 3 | 0 | 0 | **1** (`/guias/01`) | 0 | guardada / **89** |
| 3 | 132 | mixto (repetido) | completa | 0 | **4** | 0 | 0 | 0 | guardada / **90** |
| 4 | 133 | parcial (3 enlaces cortados) | **parcial** | 3 | 0 | 2 | 0 | **2** | `no_procede` (`ejecucion_parcial`), sin fila |
| 5 | 134 | caída total | **parcial** | 7 | 0 | 0 | 0 | **4** | `no_procede`, sin fila |
| 6 | 135 | catálogo roto (500) | **parcial** | 1 | 0 | 3 | 0 | 1 | `no_procede`, sin fila |
| 7 | 136 | muchos enlaces (80; tope 60) | completa | 0 | 0 | 3 | 0 | 1 (**20 no visitados**) | guardada / **91** |
| 8 | 137 | arreglado (vuelta) | completa | 0 | 0 | 1 (`/marca/a`) | 0 | 0 | guardada / **92** |

Lo que queda demostrado:
- Nuevas / persistentes / resueltas / reaparecidas / no verificadas coinciden con los cambios reales del sitio.
- **Una incidencia solo se da por resuelta con evidencia de que el destino respondió** (en la 133 y 134 las incidencias no verificables pasan a «no verificadas», no a «resueltas»).
- Las ejecuciones parciales o de caída **no se guardan** ni degradan la última instantánea válida; la 137 se compara con la 136 (fila 91), no con las parciales.
- Una ejecución con tope de enlaces (136) se guarda como `completa` aunque haya 20 destinos no visitados; el informe lo muestra en `noVisitados`. **Observación:** si se quiere que eso cuente como cobertura insuficiente, requiere un cambio de criterio (no se hizo).
- Discrepancia en la 137 durante la prueba: el **oráculo del controlador** era simplista (no arrastraba las no verificadas del historial completo). Se corrigió el oráculo, **no el Auditor** (`paso5a-oraculo.mjs`: las 9 ejecuciones coinciden con el historial completo).
- Caída total del sitio ⇒ calidad `parcial` / `ejecucion_parcial` (no se trata como «auditoría fallida»).
- Peticiones: 14 por ejecución típica (5 enlaces + catálogo + rutas + salud), 10 en caída, **69** en `muchos_enlaces` (60 enlaces + resto); solo GET; todas al sitio sintético. Los marcadores de salud van a `/api/health` con token ficticio.

## 3. Fallos de persistencia (paso 5) — ejecuciones 138–151
Para forzar los fallos se usaron **variantes temporales** del Auditor (fuera del repo, `auditor-completo\etapa-persistencia\`), nunca el definitivo. Ejecuciones 141, 143, 144 y 146 son solo los renombrados y restauraciones de la tabla.
| Caso | n8n | Situación forzada | `tabla` | `escritura` | Confirmaciones | Filas |
|---|---|---|---|---|---|---|
| P1 | 138 | Insert con validación fallida (columna desconocida) | ok | **fallida / `sin_confirmacion`** | 1 | 0 nuevas |
| P2 | 139 | Insert contra tabla inexistente | ok | **fallida / `error_insert`** (mensaje de n8n) | 1 | 0 nuevas |
| P3 | 140 | «Leer historial» contra tabla inexistente | `error_lectura` | `no_procede` | 0 | 0 nuevas |
| P4 | 142 | Tabla renombrada con el nombre original como subcadena | `ambigua` | `no_procede` | 0 | 0 nuevas |
| P5 | 145 | Tabla renombrada a otro nombre | `no_encontrada` | `no_procede` | 0 | 0 nuevas |
| P6 | 147 | Insert **sin salida** (emulado), sin `alwaysOutputData` | ok | **`pendiente`** (no confirmada) | 0 | 0 nuevas |
| P7 | 148 | Insert sin salida (emulado), **con** `alwaysOutputData` | ok | fallida / `sin_confirmacion` | 1 | 0 nuevas |
| P8 | 149 | Validación fallida real + `alwaysOutputData` | ok | fallida / `sin_confirmacion` | 1 | 0 nuevas |
| **P9** | 150 | Tabla inexistente real + `alwaysOutputData` | ok | fallida / **`sin_confirmacion`** (esperado `error_insert`) | **2** | 0 nuevas |
| P10 | 151 | Éxito real + `alwaysOutputData` | ok | **guardada**, fila **93** | 1 | **+1** (93, `ex-151`) |

Resultado: en todos los casos el informe se generó, **nunca se indicó `guardada` sin fila real**, no se duplicaron filas, un error nunca se convirtió en éxito, y las tablas renombradas se restauraron con el mismo nombre, id y `md5` de datos. Las filas 82–92 permanecieron intactas.

### 3.1 Hallazgo P9 y decisión sobre `alwaysOutputData`
- **Hallazgo (P9, n8n 2.38.6):** con `alwaysOutputData: true` en el Insert y un **error real**, n8n emite `{}` por la salida 0 **y** el error por la salida 1. «Confirmar escritura» se ejecuta **dos veces** y la última pasada (`sin_confirmacion`) **enmascara** el motivo real `error_insert`. El resultado sigue siendo seguro (`fallida`, sin fila falsa) pero se **pierde el diagnóstico** y se duplica la confirmación.
- **Decisión técnica (responsable, 12/11/2026): NO incorporar `alwaysOutputData` al Insert definitivo.** El Auditor y 2c quedan **sin modificar**.
- Alternativas descartadas por ahora (no implementadas): ignorar el `{}` en `confirmarEscritura` cuando llega también el error, o confirmar mediante Merge. Cualquier cambio exigiría autorización y nueva prueba real.

### 3.2 `pendiente` = escritura NO confirmada
**`persistencia.escritura.resultado = "pendiente"` significa que se decidió guardar pero NO se recibió confirmación de que la fila se escribió.** No es «guardada» ni «probablemente guardada»: debe tratarse como **no confirmada**. Ocurre cuando el Insert no produce ninguna salida (P6: «Confirmar escritura» no se ejecuta). Consecuencias operativas:
- el informe sigue disponible y declara `pendiente`; nunca se presenta como guardado;
- el seguimiento de la siguiente ejecución solo cuenta las filas que realmente existen en la tabla (la siguiente auditoría compara con la última instantánea válida);
- quien revise el informe debe comprobar en la tabla si la fila existe antes de asumir la línea base; un `pendiente` aislado no es un fallo del Auditor, pero un `pendiente` repetido exige revisar la Data Table.
Solo `guardada` (con `filaId` real y `idEjecucion` propio) significa escrito.

## 4. Ejecución programada (paso 6) — ejecución 152
Copia temporal del Auditor local con un Schedule Trigger «cada minuto» (resto de nodos idéntico, sin `alwaysOutputData`), única programación de la instancia (0 workflows activos antes y después).
| Dato | Valor |
|---|---|
| Ejecución n8n | **152**, `mode = trigger`, `success`, 19 nodos (el primero, el Schedule Trigger) |
| `$execution.mode` | `production` (inferido: `origenDeModo` lo traduce a **`programada`**; otro valor aparecería literal) |
| Origen registrado | `programada` |
| Persistencia | `guardada`, `filaId` **94**, `idEjecucion` `ex-152`, comparado con el historial (`modo comparacion`) |
| Fila nueva | `94 / local / ex-152 / programada / completa` (12 → 13 filas; filas previas con el mismo md5) |
| Ejecuciones programadas | **1** (activación 21:22:00, disparo 21:22:19, fin 21:22:25,5, desactivación a los ~0,5 s) |
| Tras desactivar | 75 s de vigilancia: 0 ejecuciones nuevas; `active = false`; 0 workflows activos |

## 5. Filas de la tabla (estado final)
| Fila | Entorno | Ejecución | Origen | Qué es |
|---|---|---|---|---|
| 82–86 | `produccion` | ex-117, 118, 119, 124, 128 | manual | Pruebas previas T1–T7 (sintéticas, sin relación con producción real) |
| 87 | local | ex-129 | manual | Línea base |
| 88 | local | ex-130 | manual | Todo arreglado |
| 89 | local | ex-131 | manual | Mixto (reaparecida + 3 nuevas) |
| 90 | local | ex-132 | manual | Mixto repetido (persistentes) |
| 91 | local | ex-136 | manual | Muchos enlaces (tope 60) |
| 92 | local | ex-137 | manual | Vuelta a arreglado |
| 93 | local | ex-151 | manual | Éxito real de P10 (el último caso de la prueba de persistencia) |
| 94 | local | ex-152 | **programada** | Única ejecución programada |
No hay fila para 133, 134 y 135 (parciales: no se guardan por diseño). Las filas 82–86 llevan el entorno `produccion` como etiqueta de las pruebas T1–T7 anteriores, hechas en este mismo n8n aislado y con datos sintéticos; **no son datos de producción real**.

## 6. Qué queda VALIDADO en local y qué NO está probado en producción
**Validado (n8n 2.38.6 + PostgreSQL 17, red aislada, sitio sintético):**
- Auditoría base y líneas base; seguimiento nuevas/persistentes/resueltas/reaparecidas/no verificadas contra cambios reales.
- Resolución solo con evidencia; parciales y caídas sin guardar ni degradar la referencia.
- Lectura/escritura en Data Table real; `guardada` solo con fila real; fallos de tabla (inexistente, renombrada, ambigua), de lectura y de validación; `pendiente`.
- Origen `programada` con Schedule Trigger real y no repetición tras desactivar.
- Tope de 60 enlaces (con el sitio sintético). Sin secretos en informes. Aislamiento de red.

**NO probado / NO validado (sigue requiriendo trabajo y autorización):**
- Nada se ha ejecutado en **n8n de producción** (VPS/EasyPanel); la prueba usó una instancia local con la misma versión 2.38.6 pero otra base, otra red y otro `runner`.
- **Sitio real** `treidilor.com`: contenido real, latencia, tamaño de respuestas, bloqueos (WAF/rate-limit), contadores de analítica; el consumo medido (`AUDITOR-CONSUMO.md`) es de local.
- **`produccion.json`** (`maxEnlaces` 40, URL base real) y el workflow `auditor-general.produccion` no se ejecutaron en n8n real; solo cubre el simulador y las pruebas offline.
- Data Table en el n8n de **producción**: creación de la tabla, cuota, permisos del proyecto/usuario, límites de almacenamiento y poda (la tabla no se poda automáticamente).
- Comportamiento del **runner externo** de producción con el Code del Auditor (≈ 69 kB) y con 40 enlaces reales.
- Programación real (cron de producción), notificaciones/canal de avisos, y revisión periódica por un responsable.
- Copia y **restauración** de la base de producción (pendiente en F2B, punto C).
- Persistencia con Postgres de producción bajo concurrencia (dos ejecuciones simultáneas: diseñada, no probada; las instantáneas son inmutables, sin compare-and-set).
- El Investigador comercial y la API de automatización 2.2 no formaron parte de esta validación.

## 7. Limitaciones y riesgos que persisten
1. `pendiente` no se resuelve solo: requiere comprobar la tabla (§3.2).
2. P9: con la configuración actual no existe `alwaysOutputData`; un Insert sin ninguna salida (no observado en n8n real, solo emulado) deja `pendiente`.
3. Los marcadores `muchos_enlaces`/tope no cambian la calidad a `parcial` (20 no visitados con `completa`).
4. Las 13 filas son pruebas; antes de producción la tabla de producción debe empezar **vacía** (la primera ejecución real será línea base).
5. El valor crudo de `$execution.mode` solo se conoce por inferencia (`origenDeModo`); si n8n cambiara de versión, la prueba programada debe repetirse.
6. Los recursos de prueba (contenedores `tai-dt-*`, tabla, workflows `PRUEBA 2C …`, copia programada inactiva) **se conservan** a petición.

## 8. Pruebas y documentos relacionados
`scripts/tests/automation-persistencia.test.mjs`, `automation-sitio-prueba.test.mjs`, `automation-auditor-completo.test.mjs`; `AUDITOR-SEGUIMIENTO.md` §9; `PRUEBA-DATA-TABLES-LOCAL.md`; `AUDITOR-CONSUMO.md`; `GUIA-DESPLIEGUE-AUDITOR-PRODUCCION.md`; `F2B-CIERRE-PENDIENTES-ANTES-DE-F3.md`. Informes narrativos en `INFORMES/2026-11-12/` (no versionados).
