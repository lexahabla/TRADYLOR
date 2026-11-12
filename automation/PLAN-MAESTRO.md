# Plan Maestro de Treidilor AI

> Documento vivo. Consolida la estrategia de automatización, agentes IA, marketing, crecimiento, calidad y auditoría de Treidilor, a partir de los informes de las fases 1, 1B y 2.0 (`INFORMES/2026-11-12/`) y de las especialidades definidas por el propietario. Si existe un «Plan Maestro ampliado» externo, se integra aquí sin perder su contenido.

## 1. Misión
Treidilor es una plataforma de **comercio por afiliación y comparación de productos**. Treidilor AI es el sistema de agentes que **trabaja cada día** para: mejorar la calidad del catálogo, captar tráfico cualificado, aumentar conversiones, investigar programas de afiliación, optimizar el marketing y **maximizar la rentabilidad sostenible**, siempre con datos reales y bajo control humano. Incluye un **Auditor General** que supervisa de forma continua el funcionamiento técnico y comercial.

## 2. Principios innegociables
1. **Datos reales, siempre.** Ningún agente inventa precios, descuentos, valoraciones, ventas ni características. Un descuento sólo existe con observación verificada (regla ya codificada en Treidilor). Sin dato → «no consta».
2. **Los agentes proponen; las personas aprueban.** Publicar, activar, borrar, cambiar precios o importar exige aprobación explícita en el panel.
3. **Mínimo privilegio.** Cada agente, su propio permiso acotado. **Ningún agente usa `TRADYLOR_API_TOKEN`.**
4. **Sólo lectura primero.** Se empieza en lectura, luego borradores, luego propuestas con aprobación. La autonomía crece sólo con métricas y decisión expresa.
5. **Reversible y auditado.** Copias probadas, referencia de recuperación antes de cada despliegue, registro de cada acción y parada de emergencia.
6. **Despliegues tempranos y pequeños.** Cada agente útil se despliega en cuanto es seguro; no se espera a tenerlos todos.
7. **Producción no depende del PC.** Los workflows se diseñan para correr en el n8n del VPS; el PC sólo se usa para desarrollar y probar.
8. **Coste controlado.** Presupuesto por agente, por ejecución y por mes; el piloto no tiene coste.
9. **Cumplimiento.** Normas de afiliación y publicidad, términos de uso de las fuentes, RGPD/LSSI; los agentes no reciben datos de usuarios finales.

## 3. Agentes (fichas en `agents/`)
| Área | Agente | Primera versión |
|---|---|---|
| Dirección | Coordinador | 2.6 |
| Mercado | Investigador de tendencias y productos | **v0 (esta fase)** |
| Afiliación | Investigador de programas de afiliación | 2.5 |
| Importación | Importador (Amazon, Temu, AliExpress, eBay) | 2.5 (simulaciones) |
| Catálogo | Calidad y enriquecimiento | 2.4–2.5 |
| Precios | Analista de ofertas, precios y comparaciones | 2.4–2.5 |
| Portada | Diseñador de categorías, portada e historias | 2.5 |
| Marketing | Marketing multicanal y SEO | tras 2.6 |
| Contenido | Redactor y recursos visuales | tras 2.6 |
| Inteligencia | Competencia y expertos | tras 2.5 |
| Analítica | Conversión y optimización | tras 2.5 |
| Expansión | Webs nicho | tras 2.5 |
| Auditoría | **Auditor General** | **v0 (esta fase)** |
| Interfaz | Asistente conversacional (+ voz) | 2.6 / 2.7 |

## 4. Arquitectura
- **n8n** orquesta (horarios, webhooks, colas, aprobaciones y avisos). **Treidilor** es el sistema de registro y guardián de las reglas.
- **Workflows como código:** la lógica de cada agente vive en módulos puros con pruebas (`automation/lib`); `scripts/automation/build-workflows.mjs` la incrusta en el JSON de n8n (`automation/workflows`). El JSON es **generado, normalizado y comprobado** por el comprobador de seguridad antes de importarse.
- **Dos n8n:** pruebas (local, sin credenciales reales) y producción (VPS). A producción sólo llegan JSON revisados.
- **API de automatización de Treidilor** (Etapa 2.2): tokens por agente con alcances, límites, auditoría, cola de propuestas e interruptor de emergencia (`docs/API-AUTOMATIZACION-DISENO.md`).
- **Asistente IA** del administrador: chat (y luego voz) que consulta el estado **real** y gestiona aprobaciones.

## 5. Hoja de ruta (despliegues tempranos y controlados)
| Etapa | Entrega | Estado |
|---|---|---|
| **2.0** | Infraestructura de workflows versionados, comprobador de seguridad, datos de prueba saneados, Auditor General v0, Investigador comercial v0, Compose de n8n de pruebas | **Construido en local (esta rama)** |
| 2.1 | Ejecución real en n8n y Treidilor de pruebas; conexión de Claude (MCP/API) al n8n de pruebas | Pendiente de autorización (C1–C3) |
| 2.1b | **Auditor en producción, sólo lectura pública** (salud + páginas públicas) en el n8n del VPS | Pendiente de datos del VPS y autorización |
| 2.2 | API de automatización (lectura primero), tokens con alcances, auditoría, límites, interruptor | Diseño hecho |
| 2.3 | Retirada del token general de los flujos | — |
| 2.4 | Agentes de lectura con datos verificados (Calidad, Precios, Investigador v1) | — |
| 2.5 | Agentes que proponen + panel de aprobación (importación, portada/historias, afiliación) | — |
| 2.6 | Asistente IA (texto) | — |
| 2.7 | Voz | — |
| 2.8 | Autonomía limitada (opcional, con métricas) | — |

## 6. Gobierno y métricas
- **Cada etapa:** rama propia, pruebas automáticas, comprobación en navegador si hay interfaz, referencia de recuperación y autorización expresa antes de desplegar.
- **Indicadores:** incidencias detectadas por el Auditor antes que por un visitante; fichas completas; propuestas aprobadas/propuestas totales; coste por informe; tiempo de recuperación probado; tráfico cualificado y clics de salida (cuando haya analítica agregada).
- **Revisión semanal** del propietario con el informe del Coordinador (desde 2.6; antes, informe del Auditor).

## 7. Riesgos principales y mitigación
| Riesgo | Mitigación |
|---|---|
| Token general con `delete-all` | API de automatización con alcances; retirada del token (2.2–2.3) |
| Agentes que inventan datos | Reglas de honestidad en el código; esquemas de informe que exigen evidencia; revisión humana |
| Coste descontrolado | Presupuestos y límites por agente; piloto sin coste |
| Carga sobre el VPS | Una ejecución a la vez, ritmo limitado, ejecuciones programadas fuera de horas punta |
| Efectos secundarios de leer producción | La política de URLs prohíbe fichas, salida de afiliado y APIs con efectos; en producción sólo páginas públicas |
| Compromiso de n8n | Red interna, 2FA, sin nodos de comunidad, credenciales mínimas, copias cifradas |
| Pérdida de datos | Copias automáticas con restauración probada **antes** de permitir escrituras |
