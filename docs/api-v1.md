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
| `limit` | number | Máximo de resultados (1–200, por defecto 50) |

### Respuesta 200

```json
{
  "success": true,
  "total": 11,
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
URL: https://tradylor.com/api/v1/products?limit=100
Authentication: Generic Credential Type → Header Auth
  Name: Authorization
  Value: Bearer {{$env.TRADYLOR_API_TOKEN}}
```

---

## 2. POST /api/v1/products/import — Importación desatendida

Inserta o actualiza productos en el catálogo (`products.json`). El `id` se
genera desde el título si no se indica; si el `id` ya existe, el producto se
actualiza (upsert). Acepta un producto o un lote de hasta 50.

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

```json
{
  "success": true,
  "imported": 3,
  "failed": 0,
  "results": [
    { "id": "roborock-q-revo", "title": "Roborock Q Revo", "ok": true, "message": "Producto guardado con éxito.", "updated": false }
  ]
}
```

### Ejemplo n8n (flujo periódico sugerido)

```
Schedule Trigger (cada 6h)
  → HTTP Request: GET /api/v1/products            (estado actual)
  → Function: algoritmo de selección (rentabilidad/comisión/tendencia)
  → HTTP Request: POST /api/v1/products/import    (autoinyección de ganadores)
```

---

## 3. Flujo de Compra Delegada (Delegated Checkout)

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

## Notas operativas

- Máximo **50 productos** por petición de importación.
- Las escrituras son atómicas sobre `src/data/products.json` (persistencia inmediata).
- Los errores por producto no abortan el lote: cada entrada de `results` indica `ok`/`message`.
- Combinar con el panel interno: **Afiliados** (`/admin?section=afiliados`) para credenciales de redes y búsqueda multi-catálogo, y **Tráfico y ventas** (`/admin?section=analytics`) para el Índice de Oportunidad calculado sobre lo importado.
