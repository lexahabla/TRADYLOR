# Qué falta para ejecutar los dos primeros agentes

Estado actual (Fase 2.0, rama local): lógica, workflows, comprobador de seguridad, datos de prueba y Compose **construidos y probados con un simulador**. **Todavía no se han ejecutado en n8n real.**

## A. Ejecutarlos EN LOCAL (n8n de pruebas en tu PC)
| # | Qué falta | Quién | Autorización |
|---|---|---|---|
| 1 | **Arrancar Docker Desktop** (hoy el motor está parado) | tú | C1 |
| 2 | Elegir la **versión exacta de n8n** (la de producción cuando se conozca; mientras tanto una versión estable reciente fijada) y crear `automation/dev/.env.n8n` (con una clave de cifrado SÓLO de pruebas) | Claude con tu visto bueno | C1 |
| 3 | `docker compose … up -d` (descarga ≈ 1 GB, sin coste), crear el propietario local en `http://127.0.0.1:5678` | tú (2 minutos) | C1 |
| 4 | Crear los **datos de prueba saneados** y arrancar el **Treidilor de pruebas** en `127.0.0.1:4350` con su token desechable | Claude | C2 |
| 5 | En n8n: crear la credencial «Treidilor pruebas (solo lectura)» e **importar** los dos workflows locales | tú / Claude (si se conecta MCP) | C1–C3 |
| 6 | **Ejecución manual** del Auditor (local) y del Investigador; revisar informes y contrastarlos con el catálogo local | Claude + tú | — |
| 7 | (Opcional) conectar Claude al n8n de pruebas por MCP/API para iterar | Claude | C3 |

**Verificaciones que sólo se podrán hacer en este paso** (el simulador no las cubre): que el código de los nodos Code funcione en el entorno real de n8n (`URL`, `Intl`, `Date`), que el nodo HTTP con la configuración de ritmo, redirecciones y «continuar ante error» produzca los campos esperados (`statusCode`, `body`, `error`), que `host.docker.internal` llegue al Treidilor de pruebas y que la credencial de cabecera funcione. Si algo difiere, se corrige en `automation/lib` o en el constructor y se regenera.

**Criterio de aceptación:** el Auditor genera un informe con incidencias reales del catálogo local y **cero escrituras** (los ficheros de datos de pruebas tienen las mismas sumas antes y después); el Investigador genera su informe; ambos cumplen el esquema de `automation/schemas`.

## B. Trasladarlos al n8n del VPS (Hostinger)
| Agente | ¿Puede ir a producción ya? | Qué falta |
|---|---|---|
| **Auditor General** (`auditor-general.produccion.json`) | **Sí, tras la fase A**: sólo lee `/api/health` y páginas públicas por HTTPS, sin credenciales | (1) Versión y edición de n8n del VPS; (2) acceso saliente a `https://treidilor.com` desde ese n8n; (3) importar el JSON, ejecutarlo a mano y comprobar el informe; (4) elegir horario y activar (autorización C9); (5) canal de avisos (opcional); (6) **copia y restauración probadas** antes de activar |
| **Investigador comercial** | **No todavía** | Necesita el feed del catálogo con un **token de lectura propio** (no `TRADYLOR_API_TOKEN`): la Etapa 2.2 (API de automatización, aprobada y desplegada) o, como alternativa interina, ejecutarlo sólo en local |

### Información del VPS/n8n que sigue pendiente (ver informe 02, §2)
Versión y edición de n8n · tipo de instalación en Easy Panel · base de datos (SQLite/PostgreSQL) · si n8n y Treidilor comparten red (nombre del servicio) · RAM/CPU/disco disponibles · volúmenes · copias/snapshots · exposición y 2FA · API pública y MCP activos · workflows existentes. **No pegues secretos**: sólo nombres y valores no sensibles.

### Decisiones que necesito de ti
1. Autorizar **C1+C2** para arrancar Docker y ejecutar el piloto en local (ver `PROCEDIMIENTOS.md` §2).
2. Que me indiques la **versión de n8n de producción** (para fijar la misma en pruebas).
3. Si quieres que el Auditor de producción avise por correo/Telegram (requiere credenciales nuevas y autorización aparte).
4. Prioridad tras el piloto: ¿Etapa 2.2 (API de automatización) para habilitar al Investigador en producción?
