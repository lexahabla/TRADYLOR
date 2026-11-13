# Auditor General v0.2 — consumo por ejecución y presupuesto de enlaces

Estado: implementado y probado **solo en local** (12/11/2026). Nada se ha importado, desplegado ni ejecutado en producción.

## 1. Qué añade el informe (`consumo`, opcional en el esquema)
El informe JSON (`informe.consumo`) y el Markdown (apartado «Consumo») incluyen:

| Bloque | Contenido | Naturaleza |
|---|---|---|
| `peticiones` | nº de peticiones HTTP realizadas | medido |
| `medido.bytesRecibidos`, `porTipo` | bytes UTF-8 del cuerpo de cada respuesta (salud, rutas, enlaces, feed, fichas) | **MEDIDO** en el workflow, ya descomprimido. Por la red puede viajar menos (compresión): el workflow no lo ve |
| `medido.paginasMasPesadas` | las 5 respuestas con más bytes | medido |
| `estimado.bytesHistorial` | tamaño que n8n **podría** guardar en su historial: suma del tamaño JSON de la salida de los nodos HTTP, de las listas de objetivos y del informe | **ESTIMACIÓN** (`esEstimacion: true`; el esquema no admite `false`). n8n no publica lo que guarda de verdad: contrastar con el tamaño real de la ejecución (F4) |
| `presupuesto` | tope de enlaces, descubiertos, pedidos y omitidos por el tope | medido |
| `escenarios` | para topes 10, 20 y 40: peticiones, bytes recibidos, historial estimado y secciones del sitio cubiertas | calculado con las respuestas **reales** de esa ejecución |

- Los enlaces se piden en orden estable (alfabético por URL), por lo que los N primeros de una ejecución son exactamente los que se habrían pedido con tope N: los escenarios no son extrapolaciones. Si una ejecución pidió menos enlaces que un tope y había más, ese escenario sale `calculable: false` y **no se inventan cifras**.
- 1 «MB» del informe = 1.048.576 bytes (MiB); las cifras exactas están en bytes en el JSON.
- **Compatibilidad:** `consumo` es opcional; los informes v0.2 anteriores siguen validando y su Markdown se genera sin ese apartado. El resto del informe no cambia.
- Código: `calcularConsumo`, `bytesUtf8` (sin `TextEncoder`/`Buffer`, que el entorno Code de n8n no garantiza), `descubrirEnlaces` (refactor de `crearObjetivosEnlaces`, mismo comportamiento y orden) y `formatearBytes` en `automation/lib/auditor.mjs`. Esquema: `automation/schemas/informe-auditor.schema.json`. Pruebas: `scripts/tests/automation-consumo.test.mjs` (8).

## 2. Escenarios de 10, 20 y 40 enlaces
**Qué es medición y qué no.** No hay una medición nueva: no se ha tocado producción. La única medición real de peso es la de la captura accidental anterior: **38 peticiones ≈ 9,3 MB** (≈ 251 kB por página; con 4 rutas + salud, de ahí **33 enlaces internos** descubiertos, por debajo del tope de 40). Los números de abajo son una **simulación calibrada** con esas cifras (33 enlaces, páginas de ≈ 251 kB, 4 secciones sintéticas): sirven para dimensionar, no son una medición del sitio.

| Tope | Peticiones | Cuerpo recibido | Historial estimado por ejecución | 7 días (1/día) | 14 días (1/día) | Secciones cubiertas (sintético) |
|---|---|---|---|---|---|---|
| 10 | 15 | 3,35 MB (3,52 millones de bytes) | ≈ 3,36 MB | ≈ 24 MB | ≈ 47 MB | 2/4 |
| 20 | 25 | 5,75 MB (6,03 M) | ≈ 5,76 MB | ≈ 40 MB | ≈ 81 MB | 3/4 |
| **40 (vigente)** | **38** (solo hay 33 enlaces) | **8,86 MB (9,29 M)** | **≈ 8,87 MB** | **≈ 62 MB** | **≈ 124 MB** | **4/4** |

## 3. Recomendación: **mantener 40**
1. **El volumen no es el cuello de botella.** Con una ejecución diaria, 40 enlaces cuestan ≈ 62 MB con retención de 7 días y ≈ 124 MB con la de 14 días por defecto, frente a un disco usado al 12 %. Bajar a 20 ahorraría ≈ 3 MB por ejecución (≈ 36 %) y a 10, ≈ 5,5 MB (≈ 62 %): poco, a costa de cobertura.
2. **Hoy el tope de 40 ni siquiera recorta** (33 enlaces existentes): bajarlo a 20 o 10 sí **perdería cobertura** (13 y 23 páginas sin revisar), y con el orden alfabético actual lo que se pierde es arbitrario (en la simulación, 10 enlaces cubren 2 de 4 secciones; con una distribución real en secciones por orden alfabético podría ser 1).
3. Cuándo reconsiderarlo: si los enlaces descubiertos superan 40 (el informe lo dice en `enlacesOmitidosPorTope`), si la frecuencia pasa de 1/día (cada hora serían ≈ 210 MB al día) o si el tamaño **real** estimado en F4 se aleja mucho de lo calculado aquí.
4. Perfil «ligero» opcional (no adoptado): tope 20 para ejecuciones frecuentes o de comprobación rápida.

**Mejora propuesta (no hecha, requiere autorización):** cuando haya más enlaces que tope, elegirlos repartiendo por sección (primer segmento de la ruta) en lugar de alfabéticamente. Así un tope menor mantendría la cobertura de todas las secciones. Se probaría con el mismo conjunto de pruebas.

**Impacto sobre D2 (retención):** con 1 ejecución al día y tope 40, fijar `EXECUTIONS_DATA_MAX_AGE` en 168 h (7 días) deja ≈ 62 MB; los valores por defecto (14 días) ≈ 124 MB. Ambos son asumibles; la decisión sigue siendo del administrador.

## 4. Cambios en archivos generados
Se han regenerado los tres workflows y el diagnóstico (todos incrustan `auditor.mjs`). **El fichero `automation/dev/diagnostico-auditor-produccion.json` tiene una huella nueva** (SHA-256 LF `c6dc2d716d05e8334321d7d4a0d7ae300e3ea0f8585fbca4119e83e22fe1b612`, comprobable con `node scripts/automation/verificar-fichero-diagnostico.mjs`). El diagnóstico que ya se ejecutó en producción fue el de la huella anterior (`e1e5e34a…`); si se vuelve a ejecutar, usar el nuevo o conservar el anterior desde el commit `bf20454`. `auditor-general.produccion.json` sigue siendo solo lectura, sin credenciales ni programación, `active: false`.
