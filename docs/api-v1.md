# API Pública v1 — Tradylor (automatización n8n)

Base URL: `https://tradylor.com` (o `http://localhost:4321` en desarrollo)

## Autenticación

Todas las rutas `/api/v1/*` requieren un token Bearer estático configurado en el
servidor (`.env`):

```
TRADYLOR_API_TOKEN="tu-token-largo-y-seguro"
```

Cabecera obligatoria en cada petición:

```
Authorization: Bearer tu-token-largo-y-seguro
```

Respuestas de error de autenticación:

| Código | Situación |
|---|---|
| 401 | Token ausente, malformado o incorrecto. Sin token configurado en `.env`, la API permanece cerrada. |

---

## 1. GET /api/v1/products — Feed del catálogo

Devuelve el catálogo activo de Tradylor (productos guardados + estáticos),
listo para que n8n evalúe rentabilidad y decida qué promocionar o retirar.

### Query params (opcionales)

| Parámetro | Tipo | Descripción |
|---|---|---|
| `category` | string | Filtra por nombre exacto de categoría (ej. `Audio y Sonido`) |
| `minPrice` | number | Precio mínimo en EUR |
| `maxPrice` | number | Precio máximo en EUR |
| `limit` | number | Productos por página (1–100, por defecto **24**) |
| `page` | number | Número de página (1-indexed, por defecto **1**) |

### Paginación

El feed se devuelve **paginado**: `total` es el número de productos que casan
con los filtros (antes de paginar) y `totalPages` el número de páginas con el
`limit` aplicado.

| Clave | Descripción |
|---|---|
| `total` | Productos que casan con los filtros (sin contar la paginación). |
| `page` | Página servida (1-indexed). |
| `limit` | Productos por página aplicados en la respuesta. |
| `totalPages` | Páginas totales (`ceil(total / limit)`). |
| `products` | Productos de la página actual. |

Para recorrerlo entero con n8n: `page = 1..totalPages` (o `limit=100` y
paginar mientras `page < totalPages`).

### Respuesta 200

```json
{
  "success": true,
  "total": 11,
  "page": 1,
  "limit": 24,
  "totalPages": 1,
  "generatedAt": "2026-09-16T10:30:00.000Z",
  "products": [
    {
      "id": "sony-wh-1000xm5",
      "title": "Sony WH-1000XM5 - Auriculares...",
      "description": "...",
      "price": 329.99,
      "originalPrice": 419.99,
      "currency": "EUR",
      "category": "Audio y Sonido",
      "merchant": "Amazon",
      "rating": 4.8,
      "reviewsCount": 1420,
      "badge": "Elección del Editor",
      "detailUrl": "https://tradylor.com/producto/sony-wh-1000xm5",
      "outboundUrl": "https://tradylor.com/out/sony-wh-1000xm5",
      "image": "https://..."
    }
  ]
}
```

> `outboundUrl` es el enlace enmascarado (link cloaking): redirige en servidor
> (302) al destino de compra sin exponer la URL de afiliado.

### Ejemplo n8n (HTTP Request)

```
Method: GET
URL: https://tradylor.com/api/v1/products?limit=100&page=1
Authentication: Generic Credential Type → Header Auth
  Name: Authorization
  Value: Bearer {{$env.TRADYLOR_API_TOKEN}}
```

---

## 2. POST /api/v1/products/import — Importación desatendida

Inserta o actualiza productos en el catálogo (`products.json`). El `id` se
genera desde el título si no se indica; si el `id` ya existe, el producto se
actualiza (upsert). Acepta un producto o un lote de hasta 50.

### Pipeline de automatización (4 etapas)

Cada producto pasa por un pipeline interno **aditivo** (no cambia el contrato,
sólo añade información):

| Etapa | Qué hace |
|---|---|
| **1. Ingesta** | Normaliza el contrato n8n y detecta **duplicados** (sourceId → URL canónica → título limpio). Un duplicado **no se persiste** y se informa con `duplicate:true`. |
| **2. Auditoría "Test & Proof"** | Score 0-100 (descuento verificado 40 + vendedor de confianza 30 + reseñas 30). `≥ 60` ⇒ `approved`; si no ⇒ `rejected` + motivos. |
| **3. Categorización** | Autasocia `category_id` + `subcategory_id` (crea la subcategoría si no existe), enriquece el texto (local + IA si hay claves) y calcula `conversion_score` y `normalized_tags`. |
| **4. Publicación** | Persiste en `products.json` (tombstones, `buyNowUrl` de Amazon) y estampa `audit_status`, `audit_score`, `audit_reasons` y `pipeline_version`. |

Los productos rechazados **sí se persisten** (con `audit_status:'rejected'`) para
alimentar las métricas de transparencia.

### Body — producto individual

```json
{
  "title": "Roborock Q Revo",
  "affiliateUrl": "https://www.amazon.es/dp/...",
  "price": 549.0,
  "originalPrice": 699.0,
  "description": "Robot aspirador...",
  "image": "https://...",
  "category": "Hogar Inteligente",
  "merchant": "Amazon",
  "rating": 4.7,
  "reviewsCount": 890,
  "badge": "Mejor valorado",
  "pros": ["Vaciado automático", "Navegación LiDAR"],
  "cons": ["App mejorable"]
}
```

### Body — lote

```json
{
  "products": [ { "title": "...", "affiliateUrl": "...", "price": 99.9 }, { "...": "..." } ]
}
```

### Campos

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `title` | string | ✅ | Se usa para generar el `id` (slug) si falta |
| `affiliateUrl` | string | ✅* | URL de destino real (queda enmascarada en frontend) |
| `price` | number | ✅* | EUR |
| `originalPrice` | number | — | Precio tachado; habilita el badge de descuento |
| `description` | string | — | |
| `image` | string | — | Si falta, se usa una imagen por defecto |
| `category` | string | — | Por defecto `Tecnología` |
| `merchant` | string | — | Red/tienda de origen (alimenta la comisión estimada del Índice de Oportunidad) |
| `rating` / `reviewsCount` | number | — | Alimentan popularidad |
| `badge` | string | — | Ej. `Elección del Editor` |
| `pros` / `cons` | string[] | — | |
| `slug` | string | — | Ruta canónica `/producto/[slug]` (si falta, se usa el `id`) |
| `specs` | object | — | Ficha técnica: `{ "Autonomía": "30 horas", ... }` |
| `fulfillmentProvider` | string | — | Distribuidor que cobra/envía/garantiza (pantalla puente de checkout) |
| `buyNowUrl` | string | — | Enlace directo a cesta/checkout de la tienda. Si falta y el producto es de Amazon, se genera automáticamente desde el ASIN |

\* Acepta también los alias del contrato de n8n: `affiliateDeepLink` → `affiliateUrl`
y `referencePrice` → `price`.

### Contrato JSON de n8n (equivalencia)

Un payload de n8n con el contrato de curación se acepta tal cual en
`POST /api/v1/products/import` y se normaliza automáticamente:

```json
{
  "id": "prod_12345",
  "slug": "auriculares-wireless-pro",
  "title": "Auriculares Wireless Pro - Edición Estudio",
  "category": "Audio & Sonido",
  "referencePrice": 129.99,
  "specs": {
    "Autonomía": "30 horas",
    "Conectividad": "Bluetooth 5.3",
    "Cancelación de ruido": "Activa (ANC)"
  },
  "analystVerdict": "Ideal para profesionales que buscan aislamiento acústico y respuesta plana en movilidad.",
  "pros": ["Excelente autonomía", "Cancelación de ruido adaptativa", "Diseño ergonómico"],
  "cons": ["Sin carga inalámbrica", "Peso ligeramente elevado"],
  "fulfillmentProvider": "Distribuidor Oficial / Amazon Logistics",
  "affiliateDeepLink": "https://www.amazon.es/gp/aws/cart/add.html?..."
}
```

| Campo contrato n8n | Campo interno |
|---|---|
| `referencePrice` | `price` |
| `analystVerdict` | `verdict` |
| `affiliateDeepLink` | `affiliateUrl` |
| `slug` | `slug` (ruta `/producto/[slug]`) |
| `specs` | `specs` (ficha técnica) |
| `fulfillmentProvider` | `fulfillmentProvider` (pantalla puente) |

### Respuesta 200 (lote)

Las claves nuevas del pipeline son **aditivas** (ninguna elimina las históricas):

```json
{
  "success": true,
  "imported": 2,
  "failed": 1,
  "results": [
    {
      "id": "roborock-q-revo",
      "title": "Roborock Q Revo",
      "ok": true,
      "message": "Producto procesado por el pipeline.",
      "updated": false,
      "stage": "publish",
      "duplicate": false,
      "duplicate_reason": null,
      "audit_status": "approved",
      "audit_score": 86,
      "pipeline": { "ingest": true, "audit": true, "categorize": true, "publish": true, "version": 1, "durationMs": 42 }
    },
    {
      "id": "otro-id",
      "title": "Roborock Q Revo",
      "ok": false,
      "message": "Duplicado detectado (canonicalUrl) de «roborock-q-revo»: no se persiste.",
      "updated": false,
      "stage": "ingest",
      "duplicate": true,
      "duplicate_reason": "canonicalUrl",
      "audit_status": null,
      "audit_score": null,
      "pipeline": { "ingest": false, "audit": false, "categorize": false, "publish": false, "version": 1, "durationMs": 3 }
    }
  ]
}
```

| Clave nueva | Descripción |
|---|---|
| `stage` | Última etapa alcanzada: `ingest` \| `audit` \| `categorize` \| `publish`. |
| `duplicate` / `duplicate_reason` | `true` + `sourceId` \| `canonicalUrl` \| `cleanTitle` cuando el producto ya existía (no se persiste). |
| `audit_status` / `audit_score` | Resultado de la Etapa 2 (`approved`/`rejected`/`pending` y score 0-100). |
| `pipeline` | Trazabilidad por etapa, versión y duración en ms. |

### Ejemplo n8n (flujo periódico sugerido)

```
Schedule Trigger (cada 6h)
  → HTTP Request: GET /api/v1/products            (estado actual)
  → Function: algoritmo de selección (rentabilidad/comisión/tendencia)
  → HTTP Request: POST /api/v1/products/import    (autoinyección de ganadores)
```

---

## 3. POST /api/v1/products/build-catalog — Construcción automática del catálogo

Construye (o reconstruye) el catálogo completo `products.json` consultando
**todas las redes de afiliados conectadas**, sin pasar por n8n. Es el mismo
proceso que lanza el botón «🏗️ Construir Catálogo» del panel admin
(`/upayp1b4` → Afiliados y Multi-Catálogo).

Autenticación: `Authorization: Bearer <TRADYLOR_API_TOKEN>` (igual que el resto
de `/api/v1/*`).

| Query param | Tipo | Descripción |
|---|---|---|
| `dryRun` | `1` | Modo simulación: recorre todo el proceso y devuelve el reporte **sin escribir** en `products.json`. |

No acepta body. Devuelve `200` con el reporte del proceso o `500` si falla.

### Proceso

1. **Ingesta paralela** de todas las redes conectadas (con las keywords del
   catálogo) y normalización canónica.
2. **Filtro de calidad**: título válido, precio ≥ 1 € e imagen presente.
   Las categorías purgadas (recambios) se descartan.
3. **Deduplicación cross-merchant**: `sourceId` → URL canónica → similitud de
   título (Jaccard ≥ 0,75) → marca + título (≥ 0,6). Se queda el mejor precio,
   comisión, valoración y ventas, y se agrupan las URLs de cada red.
4. **Categorización**: sólo en categorías **existentes** (raíces + subcategorías
   con keywords). Los productos sin categoría válida quedan sin categoría.
5. **Ofertas estrella (HSR)**: descuento ≥ 15 %, comisión ≥ 3 % y score ≥ 50.
6. **Ordenación inteligente**: primero las HSR, luego por
   `ventas × comisión / precio`.
7. **Stamping del pipeline**: `audit_status`, `audit_score`, `audit_reasons`,
   `ia_status`, `link_status`, `normalized_tags`, `conversion_score`,
   `pipeline_version` y `pipeline_run_at`.
8. **Upsert atómico** en `products.json` (fichero temporal + `rename`).

Los productos **nuevos** se enriquecen con IA (texto y, si no tienen imagen,
imagen) cuando hay credenciales configuradas (`TEXT_AI_PROVIDER` /
`IMAGE_AI_PROVIDER`).

### Respuesta 200 (reporte)

```json
{
  "success": true,
  "startedAt": "2026-10-22T10:00:00.000Z",
  "finishedAt": "2026-10-22T10:01:12.000Z",
  "durationMs": 72000,
  "networksQueried": ["aliexpress", "ebay"],
  "productsByNetwork": { "aliexpress": 240, "ebay": 104 },
  "rawTotal": 344,
  "afterQualityFilter": 318,
  "crossMerchantGroups": 296,
  "duplicatesResolved": 48,
  "uncategorized": 12,
  "hsrDetected": 9,
  "upserted": 210,
  "updated": 86,
  "truncated": 0,
  "aiEnrichedText": 198,
  "aiEnrichedImages": 24,
  "wouldUpsert": 210,
  "wouldUpdate": 86,
  "errors": [],
  "categoryBreakdown": [
    {
      "category": "Audio y Sonido",
      "categoryId": "audio-y-sonido",
      "subcategories": {
        "auriculares": { "name": "Auriculares", "id": "audio-y-sonido--auriculares", "count": 96 }
      },
      "total": 96
    }
  ],
  "filteredByReason": { "no_image": 14, "excluded_category": 12 }
}
```

| Clave | Descripción |
|---|---|
| `rawTotal` | Productos brutos ingeridos de las redes. |
| `afterQualityFilter` | Productos que superan el filtro de calidad. |
| `crossMerchantGroups` / `duplicatesResolved` | Grupos tras deduplicar / duplicados resueltos. |
| `uncategorized` | Productos sin categoría válida (no salen en el filtro por categoría). |
| `hsrDetected` | Ofertas estrella detectadas. |
| `upserted` / `updated` | Productos nuevos / actualizados (en `dryRun` van a `wouldUpsert` / `wouldUpdate`). |
| `aiEnrichedText` / `aiEnrichedImages` | Enriquecimientos con IA aplicados. |
| `categoryBreakdown` | Reparto por categoría y subcategoría. |
| `filteredByReason` | Descartes por motivo: `invalid_title`, `invalid_price`, `no_image`, `excluded_category`. |
| `errors` | Errores no fatales (red que no responde, producto descartado…). |

> Tras un build, los productos con `audit_status: 'approved'` +
> `ia_status: 'completed'` + `link_status: 'active'` son los que aparecen en el
> preset «⭐ Listos para Publicar» del panel. Los umbrales de auditoría se
> ajustan por entorno: `PIPELINE_MIN_AUDIT_SCORE`, `PIPELINE_MIN_RATING`,
> `PIPELINE_MIN_REVIEWS`, `PIPELINE_MIN_DISCOUNT_PERCENT`.

---

## 4. Flujo de Compra Delegada (Delegated Checkout)

Rutas internas del frontend (no requieren token; son parte de la experiencia de
usuario). El enlace de afiliado jamás se expone en el HTML ni en el JS.

```
/producto/[slug]  →  /checkout/[id]  →  /api/redirect?id=…  →  302  →  Tienda
   ficha técnica       resumen nativo      registro de clic       pasarela oficial
```

| Ruta | Qué hace |
|---|---|
| `/producto/[slug]` | Ficha de análisis neutral (specs, pros/contras, veredicto) con CTA «Tramitar pedido». Acepta también el `id` legado. |
| `/checkout/[id]` | Pantalla puente nativa: resumen del pedido, plazo estimado, distribuidor oficial, sellos de confianza y CTA «Proceder al pago seguro». `noindex`. |
| `/api/redirect?id=<slug\|id>&src=checkout` | Registra el clic (`outbound_click`) y devuelve **302** a la URL de compra directa (deep link de cesta de Amazon generado desde el ASIN, `buyNowUrl` si existe, o en su defecto el `affiliateUrl`) con `Cache-Control: no-store` y `X-Robots-Tag: noindex`. |

### GET /api/redirect

| Query param | Tipo | Descripción |
|---|---|---|
| `id` | string | Slug canónico o id legado del producto (también se acepta `slug`) |
| `src` | string | Origen del clic (ej. `checkout`) — se guarda en la analítica |

Respuesta: `302 Found` con cabecera `Location: <URL de compra directa>`
(deep link de cesta en Amazon, `buyNowUrl` del producto o `affiliateUrl`).
Si el producto no existe o no tiene enlace: `302` a `/`.

### Webhook opcional de n8n (`.env`)

Si defines `N8N_CLICK_WEBHOOK_URL`, cada salida dispara un `POST` JSON
(fire-and-forget, timeout 2 s) con este payload:

```json
{
  "event": "delegated_checkout_exit",
  "id": "prod_12345",
  "slug": "auriculares-wireless-pro",
  "title": "Auriculares Wireless Pro - Edición Estudio",
  "category": "Audio & Sonido",
  "referencePrice": 129.99,
  "specs": { "Autonomía": "30 horas" },
  "analystVerdict": "Ideal para profesionales...",
  "pros": ["Excelente autonomía"],
  "cons": ["Sin carga inalámbrica"],
  "fulfillmentProvider": "Distribuidor Oficial / Amazon Logistics",
  "affiliateDeepLink": "https://www.amazon.es/dp/...",
  "purchaseUrl": "https://www.amazon.es/gp/aws/cart/add.html?...",
  "source": "checkout",
  "clickedAt": "2026-10-04T10:30:00.000Z"
}
```

Uso sugerido en n8n: Webhook node → registrar conversión → (opcional) notificar
por Slack/Telegram o actualizar una hoja de cálculo de comisiones.

---

## 5. Reproceso del pipeline (admin, interno)

Endpoint **protegido por sesión de administrador** (cookie
`tradylor_admin_session`; NO usa el token de la API v1). Re-ejecuta las 4
etapas sobre productos ya existentes del catálogo.

### GET /api/admin/pipeline

Métricas de transparencia derivadas de `products.json` + `pipeline-metrics.json`:

```json
{
  "success": true,
  "approved": 12,
  "rejected": 3,
  "pending": 40,
  "avg_audit_score": 58.4,
  "by_reason": { "sin-descuento-verificado": 3, "vendedor-no-verificado": 1 },
  "duplicates_discarded": 2,
  "last_run": "2026-10-20T22:22:38.814Z",
  "runs": 24,
  "productsProcessed": 27
}
```

### POST /api/admin/pipeline

```json
{ "mode": "reprocess", "ids": ["roborock-q-revo"], "dryRun": false }
```

| Campo | Tipo | Descripción |
|---|---|---|
| `ids` | string[] | Opcional; vacío/ausente = todo el catálogo. |
| `dryRun` | boolean | `true` ejecuta ingest → audit → categorize **sin persistir** (etapa 4 omitida). |
| `enrich` | boolean | `false` desactiva la IA de texto (default `true`). |

Respuesta: `{ success, mode, total, processed, failed, results[] }` con el mismo
detalle por producto que la importación.

---

## 6. Reclasificación de productos por categoría (admin, interno)

Endpoint **protegido por sesión de administrador** (cookie `tradylor_admin_session`).
Reasigna los productos a la taxonomía **actual** del catálogo (las categorías raíz y
subcategorías que el admin haya creado). **No elimina ninguna categoría**.

### GET /api/admin/migrate-categories

Estado actual de la taxonomía (no escribe nada):

```json
{
  "success": true,
  "total": 9,
  "roots": 9,
  "subcategories": 2,
  "products": 55,
  "productsWithoutRoot": 0,
  "productsWithUnknownRoot": 0
}
```

### POST /api/admin/migrate-categories

```json
{ "dryRun": false, "manual": { "p_123": "audio-sonido" } }
```

| Campo | Tipo | Descripción |
|---|---|---|
| `dryRun` | boolean | `true` calcula el plan y devuelve el reporte **sin escribir nada**. |
| `manual` | object | Mapa `{ "<idProducto>": "<idRaíz>" }` para colocar productos concretos en la raíz indicada (tiene prioridad sobre el matching automático). |

> Un cuerpo que no sea JSON válido devuelve **HTTP 400** (`{"success":false,"error":"Cuerpo JSON inválido…"}`)
> **sin escribir nada**: la reclasificación real nunca se ejecuta por un body mal formado.

Proceso: (1) toma las categorías raíz actuales, (2) reasigna cada producto con
matching estricto por palabras clave (los que ya estaban en una categoría válida y
no encajan se dejan donde están y se listan para colocarlos a mano),
(3) **guarda copia de seguridad** de `categories.json` y `products.json` en
`DATA_DIR/backups/categories-<timestamp>/` antes de escribir, (4) devuelve el reporte.
No borra ni crea categorías: eso se hace desde el panel (o con `/api/categories`).

Respuesta:

```json
{
  "success": true,
  "dryRun": false,
  "backupDir": "/app/data/backups/categories-2026-10-21T18-56-13-073Z",
  "rootsInstalled": ["Informática y Oficina", "Audio y Sonido", "..."],
  "roots": [{ "id": "informatica-oficina", "name": "Informática y Oficina", "icon": "💻" }],
  "rootCategoriesRemoved": [],
  "subcategoriesRemoved": [],
  "productsReassigned": 12,
  "productsUnchanged": 43,
  "productsWithoutMatch": 1,
  "productsWithoutMatchSample": ["Chaleco de cuero para moto"],
  "productsWithoutMatchList": [
    { "id": "p_123", "title": "Chaleco de cuero para moto", "currentCategory": "Accesorios" }
  ],
  "manualApplied": ["p_123 -> audio-sonido"],
  "categoryCounts": { "audio-sonido": 23, "informatica-oficina": 32 },
  "durationMs": 42
}
```

| Campo de la respuesta | Descripción |
|---|---|
| `roots` | Las **categorías raíz actuales** (`id`, `name`, `icon`): son los únicos destinos admitidos en el mapa `manual`. |
| `productsWithoutMatchList` | Detalle (`id`, `title`, `currentCategory`) de los productos que el matching automático no clasificó y que no tenían una categoría válida (los que caen en la raíz por defecto). Máximo 200 entradas; el contador `productsWithoutMatch` es el total. |
| `manualApplied` | Asignaciones manuales efectivamente aplicadas (`"<idProducto> -> <idRaíz>"`). |

El panel admin (`/upayp1b4`, sección Categorías) usa la vista previa (`dryRun: true`) para
listar los productos sin coincidencia, dejar que el administrador elija la raíz de cada uno
y ejecutar la reclasificación con el mapa `manual`.

Es **idempotente**: al repetirla no vuelve a reasignar ni a podar nada.

---

## 7. Categorías y subcategorías (admin, interno)

CRUD de la taxonomía del catálogo. **Protegido por sesión de administrador**
(cookie `tradylor_admin_session`) en los métodos de escritura.

### GET /api/categories

Público. Devuelve todas las categorías con su conteo de productos:

```json
{
  "success": true,
  "total": 9,
  "categories": [
    { "id": "audio-sonido", "name": "Audio y Sonido", "slug": "audio-sonido", "icon": "🎧", "keywords": ["..."], "productCount": 23 }
  ]
}
```

Admite `?suggest=<texto>` para probar el matching por palabras clave.

### POST /api/categories — alta

```json
{ "name": "Iluminación", "icon": "💡", "keywords": ["led", "lampara"], "parentId": null }
```

| Campo | Tipo | Descripción |
|---|---|---|
| `name` | string | Obligatorio. |
| `icon` | string | Emoji (opcional). |
| `keywords` | string[] | Palabras clave de autodetección (opcional). |
| `parentId` | string\|null | **Vacío/null = categoría raíz**. Con valor = subcategoría de esa raíz (un solo nivel de profundidad). |

### PUT /api/categories/[id] — edición

Mismos campos que el alta. `parentId` **ausente** conserva el padre actual;
`null`/vacío convierte la categoría en raíz; con valor la mueve de rama. Si el
id cambia (renombrada) los productos que la tenían asignada se reapuntan al id
nuevo (`repointedProducts` en la respuesta).

### DELETE /api/categories/[id] — baja

Elimina la categoría y, en cascada, sus subcategorías. Los productos conservan
el texto de la categoría pero se les quitan los ids jerárquicos que quedaban
huérfanos (`cleanedProducts` en la respuesta).

---

## Notas operativas

- Máximo **50 productos** por petición de importación.
- Las escrituras son atómicas sobre `src/data/products.json` (persistencia inmediata).
- Los errores por producto no abortan el lote: cada entrada de `results` indica `ok`/`message`.
- Combinar con el panel interno: **Afiliados** (`/upayp1b4?section=afiliados`) para credenciales de redes y búsqueda multi-catálogo, y **Tráfico y ventas** (`/upayp1b4?section=analytics`) para el Índice de Oportunidad calculado sobre lo importado.
