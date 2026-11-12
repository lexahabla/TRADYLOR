# Auditor General v0.2 — seguimiento de incidencias (entregas 2a: motor puro y 2b: integración)

Estado (12/11/2026): entrega 2a (motor) y 2b (integración en el informe, ver §8) hechas y probadas en local. No hay persistencia; los workflows se regeneraron en la 2b pero **no se ha importado ni desplegado nada**, y la web y el VPS no se han tocado. La persistencia (2c, diseño en §9) requiere autorización aparte.

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
- Huella nueva del diagnóstico (`automation/dev/diagnostico-auditor-produccion.json`, SHA-256 LF `06d7dc902bf6102f206618eb9e2535b9e9d5488f6c88083aefa8777eb95c94a8`; comprobable con `node scripts/automation/verificar-fichero-diagnostico.mjs`). El ejecutado en producción el 12/11/2026 fue el de la huella original `e1e5e34a…` (commit `bf20454`).

## 9. Diseño de la entrega 2c (persistencia): cómo se introducirá y guardará el estado
**Nada de esto está implementado ni verificado.** Es el diseño propuesto, sujeto a verificación en el almacenamiento real.

**Flujo del workflow** (manual primero, programación después y con autorización):
1. `Ejecutar a mano` → **`Leer estado`** (nodo Data Table de n8n, «get» de la fila `auditor-general:<entorno>`; debe devolver salida vacía si no existe, sin fallar).
2. Nodos existentes (rutas, enlaces…).
3. **`Informe`** (Code): `estadoAnterior = JSON.parse(fila.estado)` dentro de un `try/catch` (cualquier fallo → `null`, y el informe lo dirá como `estado_invalido` o primera ejecución). Llama a `construirInformeAuditor({..., estadoAnterior})`: **ya está hecho en 2b**.
4. **`Preparar estado`** (Code): `ejecutarSeguimiento(estadoAnterior, informe).siguiente` → `{guardar, motivo, estado, revisionBase}`. Es determinista, así que recalcular aquí da el mismo resultado que el informe.
5. **`¿Guardar?`** (IF) → **`Guardar estado`** (Data Table, actualización **condicionada**: `clave = … AND revision = revisionBase`; si no existe la fila, inserción con `revision = 1`).

**Formato almacenado**: una fila por entorno con `clave` (única), `revision` (entero), `actualizadoEn` y `estado` (el JSON del estado, ≤ 64 KiB; esquema `estado-auditor.schema.json`). Solo claves públicas, gravedades y fechas.

**Concurrencia — qué está diseñado y qué NO está verificado**: el motor da `revisionBase` y `validarEscritura(almacenado, resultado)` (compare-and-set conceptual). **No se afirma protección transaccional** hasta comprobar en el almacenamiento real que la actualización condicionada es atómica y que devuelve cuántas filas cambió. Si no lo es, se mitiga con una sola ejecución a la vez (programación diaria, sin solapes) y con la comprobación posterior de `revision`. Ante un conflicto (0 filas actualizadas): releer, recalcular con el mismo informe (determinista) y reintentar una vez; si vuelve a fallar, **no sobrescribir** y registrar el conflicto en el informe.

**Qué hay que verificar antes de escribir 2c** (cada paso requiere autorización):
1. Que n8n 2.38.6 incluye el nodo Data Table y cargan sus operaciones (nodo deshabilitado dentro de un diagnóstico, como en F2: si aparece con «?», no existe).
2. En un n8n local (necesita arrancar Docker): lectura de fila inexistente, inserción, actualización condicionada y su atomicidad, límite de tamaño de una celda de texto, comportamiento en ejecución manual y con el runner externo.
3. Qué ocurre con la fila al importar de nuevo el workflow (no debería tocarse: viven en n8n, no en el workflow).
4. Si la Data Table no sirve: alternativa de datos de trabajo en el propio workflow (`$getWorkflowStaticData`, solo en ejecuciones de producción) o el modo manual (el informe incluye lo necesario para recalcular el estado y pasarlo a mano a la ejecución siguiente).

**Decisiones pendientes (suyas)**: si una ejecución **manual** puede actualizar la referencia o solo las programadas; cuántas ejecuciones se conservan en el historial; procedimiento de reinicio (borrar la fila = nueva línea base, sin pérdida de datos de Treidilor).

**Recuperación**: el estado es derivable y descartable. Perderlo o corromperlo solo provoca una nueva línea base; no afecta a Treidilor ni a n8n.
