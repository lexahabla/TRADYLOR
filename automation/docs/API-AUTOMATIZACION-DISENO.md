# Diseño de la API de automatización de Treidilor (Etapa 2.2)

> **Estado 12/11/2026:** implementada en local la parte de LECTURA (`catalog:read`, `me`, administración de clientes, límites, auditoría); desactivada por defecto. Ver `docs/api-automatizacion.md`. Lo demás de este diseño (propuestas, borradores, simulación de importación, estado de programadores) **sigue sin implementar**.

Objetivo: que n8n y los agentes **nunca necesiten `TRADYLOR_API_TOKEN`**, con permisos mínimos, límites, auditoría y aprobaciones.

## 1. Identidad y tokens
- Un **cliente** por integración (`n8n-lectura`, `n8n-investigacion`, `n8n-borradores`, `asistente-admin`).
- Token con formato `tai_<idCliente>_<secreto>`: **se muestra una sola vez**; en el servidor sólo se guarda su huella (SHA-256 con sal) en un fichero propio del volumen (`automation-clients.json`, atómico con `.bak`, fuera de git).
- Caducidad obligatoria (p. ej. 90 días), rotación y **revocación inmediata** desde el panel de administración (sesión admin + CSRF).
- Comparación en tiempo constante. Cabeceras obligatorias: `Authorization: Bearer`, `X-Agent`, `X-Execution-Id` (id de ejecución de n8n) y, en escrituras, `Idempotency-Key`.
- Opcional reforzado: firma HMAC con marca de tiempo (anti-repetición) y lista de redes/IP permitidas (red interna del VPS).

## 2. Alcances (scopes)
| Alcance | Permite |
|---|---|
| `catalog:read` | Feed de lectura **enriquecido** (observaciones verificadas, stock, subcategoría, estado del enlace, fechas) |
| `status:read` | Estado de los programadores internos (precios, alertas, recordatorios) y del servicio |
| `import:simulate` | `dryRun` del importador (nunca guarda) |
| `proposals:create` | Crear propuestas (con evidencias) |
| `research:write` | Guardar informes/notas |
| `drafts:write` | Crear borradores de historias/portada (siempre «borrador») |
| `tasks:read`, `tasks:write` | Registro de tareas del agente |
**No existen** para tokens de automatización: `catalog:write`, `prices:write`, `catalog:delete`, `portada:publish`, `portada:activate`, `versions:delete`, `users`, `credentials`, `ai-keys`. No es una casilla desactivada: **no hay endpoint** que los acepte. Una batería de pruebas recorre todas las rutas de automatización con cada token posible y falla si alguna borra, publica, activa o escribe precios.

## 3. Endpoints previstos (`/api/automation/v1`)
`GET /catalog` · `GET /status` · `POST /import/simulate` · `POST /proposals` · `GET /proposals/{id}` · `POST /research` · `POST /drafts/stories` · `POST /drafts/blocks` · `GET/POST /tasks`. Las **aprobaciones** NO están en esta API: se hacen en el panel (`/upayp1b4/…`, sesión admin + CSRF + confirmación; acciones destructivas con confirmación escrita).

## 4. Cola de propuestas y aprobación
Propuesta = `{id, agente, tipo, payload, vista previa/diff, evidencias (URL, captura, fecha), riesgo, estado, caducidad}`. Estados: `pendiente → aprobada → aplicada | fallida`, `rechazada`, `caducada`. Al aprobar, **Treidilor aplica** la propuesta con sus motores ya validados (simulación previa, reglas de identidad, tombstones, copia previa). Un agente nunca aplica. Los cambios de precio sólo salen de lecturas verificadas existentes; un agente puede proponer una corrección con evidencia, no escribirla.

## 5. Límites
Por token: ritmo por minuto (reutiliza `lib/rateLimit.ts`), cuota diaria (peticiones y registros), tamaño máximo de petición, **una escritura simultánea**, presupuesto en euros para servicios de pago (Apify/ScraperAPI/modelos). Interruptores: `AUTOMATION_ENABLED` (global, sin desplegar) y desactivación por cliente.

## 6. Auditoría
Registro de sólo añadir (`automation-audit.jsonl` en el volumen, con rotación): hora, cliente, alcance, ruta, resumen de parámetros (sin datos sensibles), resultado, id de ejecución de n8n, aprobador (si procede). Visible en el panel y para el Asistente IA.

## 7. Migración desde el token general
1) Desplegar la API con todo apagado. 2) Crear clientes y migrar los flujos. 3) Quitar `delete-all` (y `build-catalog`) del alcance del token general (cambio de comportamiento a coordinar). 4) Desactivar el token general cuando no lo use nadie.

## 8. Pruebas previstas
Matriz de alcances × rutas; token caducado/revocado/mal firmado; límites y cuotas; idempotencia; interruptor global; auditoría completa; propuestas (aprobar/rechazar/caducar/aplicar); no regresión de la web pública y del panel.
