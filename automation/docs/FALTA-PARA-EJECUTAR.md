# Estado y requisitos para el primer despliegue controlado

Estado (12/11/2026): los dos agentes **funcionan en un n8n real de pruebas (2.46.6, local)** aislado por red, contra un Treidilor de pruebas con datos saneados y **sin escrituras**. La API de automatización (etapa 2.2) está implementada y probada **solo en local**, desactivada por defecto. Claude está conectado por MCP **solo** al n8n local.

## A. Hecho en local
- n8n de pruebas aislado por red (`internal`), con comprobación real de aislamiento (`comprobar-aislamiento.mjs`).
- Auditor General v0.2 (feed por páginas bajo demanda, avisos del entorno local aparte, clasificación) e Investigador comercial v0.2 usando el feed de la **API de automatización con token propio** (nunca el token general).
- Informes JSON + Markdown validados por esquema; datos de prueba idénticos antes y después (SHA-256).
- MCP verificado (ver `MCP-N8N.md`).

## B. Para el primer despliegue controlado al VPS (nada de esto se ha hecho ni autorizado)
| # | Requisito | Quién |
|---|---|---|
| 1 | Datos del n8n del VPS: **versión y edición**, tipo de instalación en Easy Panel, base de datos, red compartida con Treidilor, RAM/CPU/disco, copias/snapshots, exposición y 2FA (sin pegar secretos) | Axel |
| 2 | Ejecutar allí `automation/dev/diagnostico-entorno-code.json` (mismas globales que en 2.46.6: sin `URL`) | Axel / con autorización |
| 3 | Salida del n8n del VPS a `https://treidilor.com` (o URL interna) y, si cambia, ajustar `config/produccion.json` | Axel + Claude |
| 4 | **Copia y restauración probadas** (volumen de Treidilor y datos de n8n incl. clave de cifrado) | Axel + Claude |
| 5 | Importar `auditor-general.produccion.json` **desactivado**, ejecutar a mano, revisar el informe y las ejecuciones (solo GET a páginas públicas) | con autorización (C6) |
| 6 | Programación diaria fuera de horas punta, primera semana con revisión diaria | con autorización (C9) |
| 7 | **Investigador en producción**: desplegar la API de automatización con `AUTOMATION_API_ENABLED=true` (decisión aparte), crear un cliente `catalog:read` desde el panel (token mostrado una vez), crearlo como credencial en el n8n del VPS y crear la variante `investigador-comercial.produccion` | con autorización aparte |
| 8 | Decidir canal de avisos del Auditor (correo/Telegram): credenciales nuevas | Axel |

## C. Pendientes técnicos conocidos
- Variante de producción del Investigador (no existe todavía; la política exige modo `completo` solo en local).
- Endpoint de estado de programadores internos (precios, alertas) para el Auditor.
- Interfaz del panel para gestionar clientes de la API (hoy: endpoint de administración y script local).
- Límites de la API en memoria (se reinician con el servicio); revisión de `X-Forwarded-For` detrás del proxy.
- Etapa 2.2 completa: propuestas con aprobación, borradores, simulación de importación (no iniciadas).
