# Auditor General v0.2 — seguimiento de incidencias (entrega 2a: motor puro)

Estado (12/11/2026): **solo el motor**, probado en local. No hay persistencia, los workflows **no se han tocado** (ni importado ni desplegado nada), la web y el VPS tampoco. Las entregas siguientes (2b integración en el informe, 2c persistencia) requieren autorización aparte.

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
- El `alcance` **aún no lo emite el Auditor** (entrega 2b): con los informes actuales todo lo que desaparece es «no verificada», nunca «resuelta». Es deliberado y conservador.
- Un parcial persistente (p. ej. un enlace que siempre agota el tiempo) no actualiza la referencia: aplicar el umbral del 20 % y revisar en la práctica.
- Si el estado se recorta (> 200 incidencias) las omitidas pueden reaparecer como «nuevas».
- Una URL renombrada se ve como resuelta + nueva.
- La persistencia (Data Table de n8n u otra) sigue **sin verificar** en n8n 2.38.6.
