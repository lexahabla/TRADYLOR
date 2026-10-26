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
| `sort` | string | Criterio de ordenación. Si se omite, usa el orden por defecto configurado en el panel (`upayp1b4` → Productos → «Orden por defecto de la tienda web»). |

Valores admitidos de `sort`: `precio_desc`, `precio_asc`, `valoracion`, `ventas`,
`publicados`, `score`, `nombre`, `categoria`, `comercio`, `descuento`, `default`
(no distingue mayúsculas/minúsculas). Un valor no reconocido se trata como `score`.

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
| **2. Auditoría "Test & Proof"** | Score 0-100 sobre 3 bloques ponderados (procedencia 50 + reseñas 30 + descuento verificado 20). `audit_reasons` sólo recoge **defectos**; la ausencia de dato en la fuente no penaliza. |
| **3. Categorización** | Autasocia `category_id` + `subcategory_id` (crea la subcategoría si no existe), enriquece el texto (local + IA si hay claves) y calcula `conversion_score` y `normalized_tags`. |
| **4. Publicación** | Persiste en `products.json` (tombstones, `buyNowUrl` de Amazon) y estampa `audit_status`, `audit_score`, `audit_reasons`, `pipeline_version`, `ai_enriched` y `ai_error`. |

Los productos rechazados **sí se persisten** (con `audit_status:'rejected'`) para
alimentar las métricas de transparencia.

> **Categorías y estados editoriales.** La subcategoría se infiere también
> cuando el producto ya tiene una categoría raíz curada a mano (antes se
> quedaba sin subcategoría y fuera del preset «⭐ Listos para Publicar» del
> panel). La inferencia sólo usa las subcategorías candidatas de esa raíz
> (`ROOT_SUBCATEGORIES` en `src/lib/pipeline/config.ts`), así que no se
> crean taxonomías absurdas ("Informática y Oficina > Altavoces"). El estado
> del enlace (`link_status`) es `active` en cuanto el producto tiene URL de
> afiliado (sólo se respeta `broken`); el estado de la IA (`ia_status`) pasa a
> `completed` cuando la ficha ya tiene descripción, veredicto, ficha técnica o
> especificaciones.

> **Escrituras atómicas.** `products.json`, `categories.json` y
> `deleted-product-ids.json` se escriben de forma atómica (fichero temporal +
> `rename`) y se leen con reintentos: si el JSON quedó truncado, se devuelve la
> última versión válida en vez de un `[]` vacío (un `[]` provocaba que el
> siguiente `upsert` **borrase el catálogo entero**).

### Etapa 2: auditoría "Test & Proof" (v2)

| Bloque | Peso | Evalúa | Motivo de rechazo |
|---|---|---|---|
| **Procedencia** | 50 | Marketplace/red con canal de confianza (Amazon, eBay, AliExpress, Etsy…) **o** marca de confianza (PCComponentes, MediaMarkt…). El `merchant` puede ser un vendedor individual: la compra la protege el marketplace. | `vendedor-no-verificado` (el vendedor existe pero no es de confianza) |
| **Reseñas** | 30 | Valoración (0-5) + volumen (escala log). Con los umbrales cumplidos (`rating ≥ 4`, `reviews ≥ 20`) el bloque vale completo. | `rating-insuficiente`, `pocas-resenas` |
| **Descuento verificado** | 20 | `originalPrice > price` con descuento ≥ 5 % y precio no por encima del máximo histórico. | `sin-descuento-verificado`, `precio-por-encima-del-historico` |

Estados: `approved` (sin defectos y con evidencia), `rejected` (con defectos) y
`pending` (sin datos suficientes para juzgar → `sin-datos-suficientes`).

> Si la fuente **no aporta** el dato (p.ej. un marketplace sin reseñas), el
> bloque no penaliza y no genera motivo: `audit_reasons` refleja defectos
> reales, no la ausencia de información.

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
| `enrich` | `0` | Publica el catálogo **sin llamar a la IA** (texto e imagen). Con muchos productos nuevos, el enriquecimiento puede tardar minutos y chocar con los límites de peticiones del proveedor; con `enrich=0` la publicación es inmediata y el enriquecimiento se hace después por lotes con `POST /api/admin/pipeline` (`mode:'reprocess'`). |

No acepta body. Devuelve `200` con el reporte del proceso o `500` si falla.

> **Tombstones.** Los productos borrados desde el panel quedan bloqueados para
> siempre (tombstone en `deleted-product-ids.json`): el build no puede volver a
> publicarlos. Para deshacer un vaciado de catálogo hay que limpiar los
> tombstones (`DELETE /api/admin/tombstones`, sesión de admin) —si no, el
> catálogo se queda bloqueado y no crece.
>
> **Productos rechazados.** Los productos con `audit_status:'rejected'` se
> persisten (alimentan las métricas de transparencia y el panel) pero **no se
> publican en la web pública**: el catálogo público sólo muestra los aprobados
> (y los que aún no han pasado por la auditoría).

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
  "approved": 201,
  "rejected": 53,
  "pending": 0,
  "avg_audit_score": 77.3,
  "by_reason": { "pocas-resenas": 40, "sin-descuento-verificado": 10, "rating-insuficiente": 3 },
  "duplicates_discarded": 217,
  "duplicate_groups": 0,
  "duplicate_products": 0,
  "last_run": "2026-10-22T11:25:18.858Z",
  "runs": 314,
  "productsProcessed": 1086,
  "ai_enriched": 51,
  "ai_failed": 211,
  "ai_pending": 0,
  "job": null
}
```

`duplicate_groups` / `duplicate_products` son los duplicados **reales que siguen
en el catálogo** (mismo `sourceId` o misma URL canónica), no el contador
histórico de descartes.

`ai_enriched` / `ai_failed` / `ai_pending` miden el **enriquecimiento con IA**
de la Etapa 3: productos con `ai_enriched:true`, productos con `ai_error` (la IA
se intentó y falló) y productos aún sin ese dato. Antes este dato no se
guardaba y el fallo era **silencioso**: con el proveedor por defecto (Groq, límite
de peticiones bajo) media parte del catálogo se quedaba con la plantilla local
sin que nadie lo notase.

`job` describe el último reproceso en segundo plano (§5.2): `null` si no hay
ninguno.

### POST /api/admin/pipeline

El cuerpo **siempre** tiene que ser JSON válido (si no, responde `400`; nunca
reprocesa el catálogo por defecto). Hay dos modos:

```json
{ "mode": "reprocess", "ids": ["roborock-q-revo"], "dryRun": false }
```

```json
{ "mode": "reprocess", "scope": "all", "confirm": true, "dryRun": false, "enrich": false }
```

```json
{ "mode": "dedupe", "dryRun": true }
```

| Campo | Tipo | Descripción |
|---|---|---|
| `mode` | string | `reprocess` (default), `dedupe` o `cancel`. Cualquier otro valor → `400`. |
| `ids` | string[] | Sólo con `mode:'reprocess'`. Ámbito `ids`: reprocesa esos productos. |
| `scope` | string | `ids` (por defecto si hay `ids`) o `all`. |
| `confirm` | boolean | **Obligatorio** (`true`) para escribir sobre todo el catálogo (`scope:'all'` sin `dryRun`). Sin él → `400`. |
| `dryRun` | boolean | `true` = ingest → audit → categorize **sin persistir**. En `mode:'dedupe'` es la simulación (default: simulación). |
| `enrich` | boolean | `false` desactiva la IA de texto (default `true`). |
| `provider` | string | Fuerza el proveedor de IA para esta tanda: `openai`, `anthropic` o `groq`. Útil cuando el proveedor por defecto (`TEXT_AI_PROVIDER`) agota su límite de peticiones y hay otro con claves configuradas. |
| `model` | string | Fuerza el **modelo** de IA para esta tanda (p. ej. `openai/gpt-oss-120b`). Los límites de Groq son **por modelo** (TPD): agotar uno no agota el resto. Vacío = el modelo por defecto del proveedor. |
| `background` | boolean | `true` lanza el reproceso en **segundo plano** y responde al instante con `202` (§5.2). Es la única forma viable de reprocesar el catálogo entero con IA. |

Respuesta (reprocess síncrono): `{ success, mode, scope, dryRun, total, processed, failed, ai_enriched, ai_failed, results[] }`
con el mismo detalle por producto que la importación (`stage`, `duplicate`,
`audit_status`, `audit_score`, `audit_reasons`, `ai_enriched`, `ai_error`).

Respuesta (dedupe): `{ success, mode, dryRun, groups, removed, removedIds[], details[], total, remaining }`.
La purga conserva la ficha **más completa** de cada grupo (y, a igualdad, el id
canónico sin sufijo `-2`, para no romper las URLs ya publicadas) y deja
tombstone en `deleted-product-ids.json` para que no reaparezcan.

> La purga deja tombstones: si luego se limpia el catálogo con «Vaciar
> Catálogo» hay que limpiar también los tombstones (§5.1) o el catálogo no
> podrá volver a publicar esos productos.

---


## 5.1 Tombstones del catálogo (admin, interno)

Endpoint **protegido por sesión de administrador** (cookie
`tradylor_admin_session`).

| Método | Descripción |
|---|---|
| `GET /api/admin/tombstones` | `{ success, count, ids }` — ids bloqueados para el build/import. |
| `DELETE /api/admin/tombstones` | `{ success, cleared, message }` — limpia los tombstones (conserva los ids integrados). |

También disponible desde el panel admin (`/upayp1b4` → botón «🧹 Limpiar
Tombstones»).

---

## 5.2 Reproceso en segundo plano (jobs)

Reprocesar el catálogo entero con la IA de texto es una operación LENTA: cada
producto tarda ~10-20 s en la llamada al proveedor (262 productos ≈ 1 hora).
Dentro de una petición HTTP síncrona el proxy la cortaba a mitad y **el trabajo
se perdía**. Por eso el reproceso puede lanzarse **en segundo plano**: la tarea
sigue en el proceso SSR (Node standalone) y el avance se consulta con `GET`.

### Lanzar un job

```json
{
  "mode": "reprocess",
  "scope": "all",
  "confirm": true,
  "enrich": true,
  "provider": "openai",
  "model": "gpt-4o-mini",
  "background": true
}
```

Responde `202 Accepted` de inmediato:

```json
{
  "success": true,
  "mode": "reprocess",
  "background": true,
  "scope": "all",
  "dryRun": false,
  "provider": "openai",
  "total": 262,
  "job": { "id": "2026-10-22T14:02:11.004Z", "status": "running", "total": 262, "processed": 0, "...": "..." },
  "message": "Reproceso lanzado en segundo plano. El avance se consulta con GET /api/admin/pipeline."
}
```

- Si ya hay un job en marcha → `409` con `{"success":false,"message":"Ya hay un reproceso en marcha…"}`.
- Si el ámbito no contiene productos → `409` con `{"success":false,"message":"No hay productos que reprocesar con ese ámbito."}`.

### Consultar el avance

`GET /api/admin/pipeline` → clave `job`:

```json
{
  "id": "2026-10-22T14:02:11.004Z",
  "status": "running",
  "scope": "all",
  "total": 262,
  "processed": 87,
  "failed": 0,
  "aiFailed": 3,
  "aiEnriched": 84,
  "current": "auriculares-inalambricos-modelo-destacado-7-amazon",
  "currentTitle": "Auriculares inalámbricos — modelo destacado 7",
  "provider": "openai",
  "enrich": true,
  "dryRun": false,
  "startedAt": "2026-10-22T14:02:11.004Z",
  "finishedAt": null,
  "message": "Procesados 87 de 262…",
  "errors": [{ "id": "…", "title": "…", "message": "Sin credenciales de IA para el proveedor \"openai\"" }],
  "recent": [{ "id": "…", "title": "…", "ok": true, "stage": "publish", "audit_status": "approved", "audit_score": 88, "ai_enriched": true }]
}
```

| `status` | Significado |
|---|---|
| `running` | En marcha. |
| `done` | Terminado correctamente. |
| `cancelled` | Detenido a petición del operador. |
| `interrupted` | El servidor se reinició a mitad (el lote quedó incompleto). |
| `error` | Error inesperado. |

El estado se persiste en `DATA_DIR/pipeline-job.json` (volumen en prod) y se
sobrevive a un reinicio del servidor: si el proceso se cae, la siguiente
lectura lo marca como `interrupted` en vez de mostrar un progreso fantasma.

### Detener el job

```json
{ "mode": "cancel" }
```

Termina tras el producto en curso (`409` si no hay ningún job en marcha).

### Reintentos ante límite de peticiones

Si el proveedor responde con un error de límite de peticiones (429), el job
espera 20 s y **reintenta el producto una vez** antes de darlo por perdido
(marcado con `ai_error`). Entre producto y producto hay una pausa de
`PIPELINE_JOB_DELAY_MS` (por defecto `500` ms) para no saturar al proveedor.

### Un fallo de IA no destruye una ficha ya enriquecida

Si la Etapa 3 **no** consigue texto de IA (sin cuota, sin clave, error del
proveedor) pero el producto ya tenía `ai_enriched:true`, se **conserva** su
descripción, pros, contras, veredicto y ficha técnica: la plantilla local no
pisa la redacción editorial anterior. El fallo queda registrado en `ai_error`
(visible en el panel) y se limpia solo en el siguiente enriquecimiento exitoso.

### Proveedores y credenciales

| Proveedor | Variable | Notas |
|---|---|---|
| `openai` | `OPENAI_API_KEY` (+ `OPENAI_MODEL`) | Requiere saldo en la cuenta: sin créditos responde `429 insufficient_quota`. |
| `anthropic` | `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`) | Si la clave **no** está vinculada a un workspace, hace falta además `ANTHROPIC_WORKSPACE_ID` (cabecera `anthropic-workspace-id`); si falta, la API responde `400`. |
| `groq` | `GROQ_API_KEY` (+ `GROQ_MODEL`) | Plan gratuito con **límite diario de tokens por modelo** (`TPD`): al agotarse responde `429` y el lote se queda sin enriquecer. Se puede forzar otro modelo con `model` (o `GROQ_MODEL`) porque los cubos de cuota son independientes. |

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

## 8. Centro de Herramientas y secciones inteligentes (admin/usuario, interno)

### GET /api/admin/sections/suggestions

Protegido por sesión de administrador. Devuelve sugerencias **100% automáticas** de
secciones para la portada (`src/lib/sectionSuggestions.ts`): según la fecha actual
elige eventos del calendario comercial (Black Friday, Navidad, rebajas de enero,
San Valentín, Día de la Madre, verano, vuelta al cole, Halloween, 11.11…) y, si no
hay ninguno activo, dos sugerencias "evergreen" (mayor ahorro / novedades). Cada
sugerencia ya trae su `productIds` calculado con una heurística determinista sobre
el catálogo (descuento %, valoración o fecha de alta) — cero trabajo manual.

```json
{
  "success": true,
  "suggestions": [
    {
      "key": "black-friday",
      "title": "🔥 Black Friday",
      "description": "Los descuentos más agresivos del catálogo ahora mismo.",
      "icon": "🔥",
      "productIds": ["..."],
      "reason": "Ordenado por % de descuento",
      "existingSectionId": "black-friday"
    }
  ]
}
```

`existingSectionId` sólo aparece si ya existe una sección publicada con ese id (el
panel ofrece "Actualizar" en vez de "Crear"). El panel crea la sección con el POST
ya existente de `/api/admin/sections` (`action:'create'`, mismo `id` que `key`).

### GET /api/redirect — parámetro `network` (comparativa multitienda)

`GET /api/redirect?id=<producto>&network=<red>&src=multistore` sale hacia la URL de
afiliado de **otra** red detectada automáticamente por "Construir Catálogo"
(`extra.crossMerchant`, ver `src/lib/productNetwork.ts#getCrossMerchantOffers`), en
vez de la tienda principal del producto. Sin `network` (o sin match), el
comportamiento es el de siempre. El enlace real nunca se expone en el HTML.

### POST /api/radar/ai-assistant — Dependiente IA

Público (usuarios anónimos y con sesión de Mi Radar); limitado por IP/usuario
(`src/lib/rateLimit.ts`). Reutiliza el **mismo motor de IA ya configurado** en el
servidor (`chatComplete`, el que usa la consola del panel admin) con un prompt
acotado a recomendar **sólo** productos reales del catálogo aprobado.

```json
// Body
{ "messages": [{ "role": "user", "content": "busco auriculares para deporte, 80€" }] }
```

```json
// Respuesta (sin sesión): recortada
{ "success": true, "reply": "Te recomiendo los…", "locked": true }
// Respuesta (con sesión): completa
{ "success": true, "reply": "Te recomiendo los Jesebang…", "locked": false }
```

Sin proveedor de IA configurado responde `503`. El cliente guarda la conversación
completa en la cuenta del usuario vía el store de Mi Radar (`utils/radarStore.ts`
`saveAiChat`), igual que los perfiles de comprador (`saveBuyerProfile`) y las
comparativas guardadas (`addComparatorHistoryEntry`) — todo viaja en el mismo
`POST /api/radar` de sincronización que ya usa el resto de Mi Radar.

---

## Notas operativas

- Máximo **50 productos** por petición de importación.
- Las escrituras son atómicas sobre `src/data/products.json` (persistencia inmediata).
- Los errores por producto no abortan el lote: cada entrada de `results` indica `ok`/`message`.
- Combinar con el panel interno: **Afiliados** (`/upayp1b4?section=afiliados`) para credenciales de redes y búsqueda multi-catálogo, y **Tráfico y ventas** (`/upayp1b4?section=analytics`) para el Índice de Oportunidad calculado sobre lo importado.
