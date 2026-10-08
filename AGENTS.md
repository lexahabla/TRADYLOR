# Tradylor - Instrucciones para agentes de IA

## Qué es este proyecto

Tradylor es un portal de recomendación, curación y comparativas de productos de alta
conversión, orientado a marketing de afiliación. Genera recomendaciones de productos
usando datos de múltiples redes de afiliados (Amazon, AliExpress, eBay, Awin, CJ,
Admitad, Tradedoubler, Kwanko, Etsy) y enlaza a los programas de afiliación.

## Stack

- **Framework**: Astro 4.x con TypeScript
- **Adapter**: `@astrojs/node` en modo `standalone` (SSR, output `server`)
- **CSS**: CSS propio con variables + utilidades **Tailwind 3** (`tailwind.config.mjs`,
  `preflight` desactivado para no alterar el diseño existente)
- **IA**: OpenAI / Anthropic (texto) y OpenAI Images / Flux (imagen) vía SSR endpoints
- **Web**: sitio `https://tradylor.com`
- **Git**: repositorio ya inicializado en la raíz del proyecto

## Estructura principal

- `src/pages/` - Rutas de la web
  - `index.astro` - Portada
  - `producto/[slug].astro` - Ficha de producto / análisis técnico (acepta también el id legado)
  - `checkout/[id].astro` - Pantalla puente nativa de Compra Delegada (previa a la salida)
  - `out/[id].astro` - Redirecciones de afiliación (salida/out, legado)
  - `admin.astro` y `admin/curation.astro` - Panel de administración de curación
  - `api/` - Endpoints internos y la API pública `v1` (`docs/api-v1.md`)
  - `api/redirect.ts` - Salida registrada (302) al enlace de afiliado del checkout
  - `api/admin/add-product.ts` - Alta/actualización de producto con IA (texto + imagen)
- `src/lib/` - Lógica de negocio
  - `adminAuth.ts`, `apiAuth.ts` - Autenticación (admin y API)
  - `catalog.ts`, `catalogStore.ts` - Catálogo de productos en memoria/almacenamiento
  - `productStore.ts` - Persistencia de `products.json` (lectura/escritura/upsert)
  - `ai.ts` - Enriquecimiento de texto y generación de imágenes con IA
  - `categories.ts` - Categorías
  - `opportunity.ts` - Detección de oportunidades de contenido
  - `networks/` - Conectores con las redes de afiliación (registry, connectors, credentials, types)
- `src/data/` - Datos
  - `products.json`, `categories.json`, `analytics.json`
  - `credentials.json` - Credenciales de redes de afiliación (glitch: NO se sube a git)
- `public/images/products/` - Imágenes de producto generadas con IA (ignorado en git)

## Variables de entorno

- Copiar `.env.example` a `.env` para desarrollo local.
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`: credenciales del panel admin.
- `TRADYLOR_API_TOKEN`: token Bearer para la API pública v1.
- `N8N_CLICK_WEBHOOK_URL`: webhook opcional que recibe el evento `delegated_checkout_exit` en cada salida
  (sólo telemetría; el alta de productos ya no depende de n8n).
- **IA (opcional)**: `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` para el texto y
  `OPENAI_API_KEY` / `FLUX_API_KEY` para las imágenes; selectores
  `TEXT_AI_PROVIDER` y `IMAGE_AI_PROVIDER` (`openai` por defecto, `anthropic`/`flux`).
- Claves de cada red de afiliación (opcional; activa los conectores correspondientes).

## Comandos

- `npm run dev` - Servidor de desarrollo (http://localhost:4321)
- `npm run build` - Compilar a `dist/` (build standalone de Node)
- `npm run preview` - Previsualizar el build
- `npm run astro` - CLI de Astro

## Convenciones y avisos

- **Seguridad**: `src/data/credentials.json` y `.env` están en `.gitignore`. Nunca
  añadir credenciales reales, tokens ni claves de API al código ni a los commits.
- El panel admin y las rutas `/api/*` requieren autenticación; respetar `adminAuth.ts`
  y `apiAuth.ts`. **Excepción**: `/api/redirect` es público a propósito (es la salida
  del flujo de Compra Delegada) y no debe exigir token.
- Los redireccionamientos de afiliación salen por `src/pages/out/[id].astro`.
- Documentación de la API pública en `docs/api-v1.md`; mantenerla actualizada si se
  cambian los endpoints de `src/pages/api/v1/`.