# API de automatización de Treidilor (etapa 2.2)

Lectura limitada para los agentes de Treidilor AI (n8n). **Desactivada por defecto.** No usa ni sustituye a `TRADYLOR_API_TOKEN`.

## Activación
- Variable de entorno `AUTOMATION_API_ENABLED=true` (solo ese valor exacto). Sin ella, `/api/automation/v1/*` y `/api/admin/automation-clients` responden **404** (`{"success":false,"code":"no_encontrado"}`), indistinguible de una ruta inexistente, y no se crea ningún archivo.
- **No activar en producción sin autorización expresa.** Estado a 12/11/2026: solo probada en local.

## Clientes y tokens
- Un cliente por integración. Token `tai_<id de 16 hex>_<secreto de 43 caracteres>`; **se muestra una sola vez**. En disco (`automation-clients.json`, volumen, fuera de git) solo se guarda un hash SHA-256 con sal (el secreto no es recuperable).
- Caducidad obligatoria (1–90 días, por defecto 30), revocación inmediata, máximo 20 clientes activos, límite por minuto (1–120, por defecto 30) y cuota diaria (1–20 000, por defecto 2 000).
- Un token de automatización **no sirve** en `/api/v1/*` ni en el panel, y el token general **no sirve** aquí.
- Archivo ilegible o con datos incoherentes (p. ej. un alcance inexistente): la autenticación **falla cerrada** (401), no se crean clientes (423) y el archivo no se sobrescribe.

## Alcances
Solo existe `catalog:read`. **No hay ningún alcance de escritura**: no existe endpoint que acepte productos, precios, categorías, publicaciones ni portada. Crear un cliente con otro alcance → 400 `alcance_no_existe`. Los alcances futuros previstos están en `automation/docs/API-AUTOMATIZACION-DISENO.md`.

## Endpoints
### `GET /api/automation/v1/catalog?limit=1-100&page=1-10000[&category=…][&network=…]`
`Authorization: Bearer tai_…`. Parámetros desconocidos o repetidos → 400. Orden estable por id. Respuesta:
`{ success, schema:"automation-catalog/1", generatedAt, total, page, limit, totalPages, products:[…] }`. Cada producto trae **solo**:

| Campo | Qué es |
|---|---|
| `id`, `title` | Identificador y título |
| `category`, `categoryId`, `subcategoryId`, `network`, `merchant` | Clasificación y origen |
| `price`, `currency` | Precio actual (EUR) |
| `declaredPreviousPrice` | Precio anterior **declarado** por la fuente (no verificado) |
| `verifiedDiscount` | `{pct, previousPrice, asOf}` solo si una lectura verificada reciente lo demuestra y coincide con el precio publicado; si no, `null` |
| `stock` | `in_stock` / `low_stock` / `out_of_stock` / `unknown` (lo que declara la fuente) |
| `rating`, `reviewsCount`, `ratingFlag` | Valoración **sustentada** (mismas reglas que la web); el 4,8 / 100 por defecto del alta va a `null` con `ratingFlag:"por_defecto"` |
| `image` | Ruta o URL de la imagen |
| `descriptionLength` | Solo la longitud de la descripción (no el texto) |
| `hasAffiliateLink` | Booleano: **nunca** el enlace |
| `capturedAt`, `verifiedAt`, `addedAt` | Fechas de captura, verificación y alta (o `null`) |

**No se entrega**: enlaces de afiliado o de salida, comisiones, descripciones, el bloque interno `extra`, datos de usuarios, credenciales ni nada de Mi Radar.

### `GET /api/automation/v1/me`
Identidad del token (id, nombre, alcances, caducidad, límites). Sin datos del catálogo.

### Administración (solo administrador con sesión + CSRF) — `/api/admin/automation-clients`
- `GET [?audit=N]`: clientes (sin sal ni hash) y últimas N entradas de auditoría.
- `POST {action:'create', name, scopes:['catalog:read'], ttlDays?, ratePerMinute?, dailyQuota?}` → `{client, token}` (cabeceras `X-Automation-Admin: 1` + JSON; cuerpo ≤ 4 KiB).
- `POST {action:'revoke', id}`.
- En local sin sesión: `node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/automation/crear-cliente.mjs --datos <carpeta> --salida <fichero fuera del repo>`.

## Códigos de respuesta
401 token ausente/inválido/caducado/revocado (mensaje idéntico: no se puede enumerar clientes) · 403 alcance insuficiente · 400 parámetros · 404 API desactivada · 405 método (solo GET) · 423 almacén dañado · 429 límite por minuto, cuota diaria o IP bloqueada (20 intentos fallidos por minuto) con `Retry-After`.

## Auditoría
`automation-audit.jsonl` (volumen; solo añadir; rota a 2 MiB): hora, evento (`peticion`, `denegado`, `limite`, `cliente_creado`, `cliente_revocado`), cliente, alcance, ruta, parámetros, estado, motivo y nº de elementos. **Nunca** registra tokens; la IP se guarda como huella corta.

## Limitaciones conocidas
- Los contadores de límite por minuto y por día viven en memoria: se reinician al reiniciar el servicio.
- La auditoría registra el acceso, no el contenido devuelto.
- No hay aún endpoint de estado de los programadores internos (precios, alertas) ni de propuestas: previstos en el diseño.
- Detrás de un proxy, la IP se toma de `X-Forwarded-For` (primer valor): comprobar la configuración del proxy antes de confiar en el bloqueo por IP.

## Pruebas
`scripts/tests/automation-api.test.mjs` (desactivada por defecto, alta, rechazo de tokens, caducidad/revocación, límites, parámetros, ausencia de escrituras, auditoría, almacén dañado, contrato con los agentes).
