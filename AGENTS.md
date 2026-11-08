



# Treidilor - Instrucciones para agentes de IA

## Flujo de trabajo (obligatorio, cualquier modelo)

Estas reglas aplican **siempre**, sea cual sea el modelo activo en opencode
(Mimo, u otro seleccionado con `/model`): las carga opencode vía `opencode.json`
al abrir el proyecto, y el agente debe seguirlas en cada sesión.

0. **Preparación e inspección inicial al arrancar / tras un `/new`:**
   Antes de responder o procesar la primera instrucción del usuario, el agente DEBE:
   - Revisar el estado del repositorio (`git status` / último commit).
   - Inspeccionar la estructura de archivos actual (consultando `estructura_limpia.txt` o `estructura.txt` si están disponibles).
   - Confirmar mentalmente el contexto para estar listo sin asumir estados antiguos.

1. **El desarrollo se hace en local** (Antigravity + opencode en la copia del
   repo del PC). No desarrollar dentro del contenedor de producción: su working
   tree es efímero y se pierde en el siguiente redeploy.
2. **Al terminar cada tarea con cambios de código: publicarlos** sin pedir
   permiso adicional (el dueño del proyecto lo tiene configurado así):

   ```bash
   git add -A
   git commit -m "descripcion breve del cambio"
   git push origin main
   ```

3. El push a `main` **despliega automáticamente** en https://treidilor.com
   (webhook de GitHub → Easy Panel → build Docker, ~2-3 minutos). No hace falta
   tocar ningún panel. Para confirmar que el deploy terminó y **qué código
   contiene**:
   1. Calcular la huella esperada del commit pusheado:
      `node scripts/source-fingerprint.mjs --git <hash>` (campo `sourceHash`).
   2. `curl https://treidilor.com/api/health` debe devolver `"status":"ok"` **y un
      `sourceHash` igual al calculado**. Si es distinto o `null`, el despliegue
      NO contiene ese código (el build anterior sigue vivo o falló): esperar,
      volver a consultar y, si persiste, informar al usuario.
   - `sourceHash` lo estampa el `Dockerfile` en el build (`/app/BUILD_INFO.json`),
     calculado sobre los ficheros que entraron en la imagen. **Cubre**: `src/`,
     `public/` (sin `public/images/products`), `docker/`, `scripts/`,
     `package.json`, `package-lock.json`, `astro.config.mjs`,
     `tailwind.config.mjs`, `postcss.config.mjs` y `tsconfig.json`. **No cubre**:
     `Dockerfile`, `AGENTS.md`, `docs/`, `INFORMES/`, los archivos
     `estructura*.txt`, las variables de entorno ni la imagen base: un commit que
     sólo toque esos archivos no cambia el `sourceHash`.
   - `commit` es sólo referencia: aparece si la plataforma de build pasa
     `ARG GIT_COMMIT`; si no, es `null` y no es un fallo. `/api/health` ya no lee
     `.git` (el entrypoint lo recrea con el `main` del arranque, que no identifica
     la imagen).
4. **Los datos NO van en git**: productos, categorías, analytics,
   `credentials.json` e imágenes IA viven en el **volumen** del servidor
   (`/app/data`). Es normal que falten ficheros en `src/data/` o en
   `public/images/` respecto al entorno de producción: no intentar "regenerarlos"
   ni "arreglar" nada por eso.
5. **Nunca subir secretos**: `.env`, `credentials.json` y claves están en
   `.gitignore`; no forzar su inclusión ni pegar claves en el código.
6. Tras un push, si el deploy falla (webhook/health), informar al usuario en vez
   de reintentar deploys a ciegas.
7. **Cada tarea termina actualizando los archivos de estructura** (`estructura_limpia.txt` / `estructura.txt`) si se han añadido, modificado o eliminado archivos en el proyecto, seguido de commit + push + verificación de deploy + aviso al usuario con el resultado (y con el fallo si lo hay) en el mismo turno; esta regla es obligatoria también entre sesiones y agentes distintos.

## Qué es este proyecto

Treidilor es un portal de recomendación, curación y comparativas de productos de alta
conversión, orientado a marketing de afiliación. Genera recomendaciones de productos
usando datos de múltiples redes de afiliados (Amazon, AliExpress, eBay, Awin, CJ,
Admitad, Tradedoubler, Kwanko, Etsy) y enlaza a los programas de afiliación.

## Stack

- **Framework**: Astro 7.x con TypeScript (ver `package.json`)
- **Adapter**: `@astrojs/node` en modo `standalone` (SSR, output `server`)
- **CSS**: CSS propio con variables + utilidades **Tailwind 3** (`tailwind.config.mjs`,
  `preflight` desactivado para no alterar el diseño existente)
- **IA**: OpenAI / Anthropic (texto) y OpenAI Images / Flux (imagen) vía SSR endpoints
- **Web**: sitio `https://treidilor.com`
- **Git**: repositorio ya inicializado en la raíz del proyecto

## Estructura principal

- `src/pages/` - Rutas de la web
  - `index.astro` - Portada
  - `producto/[slug].astro` - Ficha de producto / análisis técnico (acepta también el id legado)
  - `checkout/[id].astro` - Pantalla puente nativa de Compra Delegada (previa a la salida)
  - `out/[id].astro` - Redirecciones de afiliación (salida/out, legado)
  - `upayp1b4.astro` y `upayp1b4/curation.astro` - Panel de administración (ruta `/upayp1b4`) y curación
  - `upayp1b4/perfil.astro` y `upayp1b4/usuarios.astro` - Perfil del usuario y gestión de usuarios del backend
  - `mi-radar.astro` - Panel personal del usuario final (anónimo LocalStorage + nube con sesión)
  - `api/` - Endpoints internos y la API pública `v1` (`docs/api-v1.md`)
  - `api/redirect.ts` - Salida registrada (302) al enlace de afiliado del checkout
  - `api/health.ts` - Healthcheck público para Docker / Easy Panel (sin auth)
  - `api/admin/add-product.ts` - Alta/actualización de producto con IA (texto + imagen)
  - Panel de importación JSON (`upayp1b4.astro`, sección 2): TODOS los métodos de carga (ASIN/URL individual, categoría Amazon/Temu, JSON pegado o archivo)
    alimentan una zona común con «Simular importación» (nunca guarda), «Importar al catálogo» (sin IA) e «Importar y enriquecer con IA»
    (vista previa gratuita + confirmación de créditos; enriquece con `/api/admin/enrich-bulk` solo las fichas NUEVAS, en lotes de 5, con
    reintento de las pendientes).
    Tras extraer una categoría (Amazon/Temu) o cargar un ASIN se hace SOLA una simulación gratuita (sin guardar ni llamar de nuevo al origen) y la zona
    muestra «Frente al catálogo y al stock»: nuevos, ya existentes (sin cambios / con cambios / vinculadas), agotados o sin stock, sin precio (no
    disponibles para comprar, se rechazan) y sin ficha en España. Enviar el mismo enlace de nuevo detecta lo que ya existe (sin duplicar).
    La casilla «Solo productos nuevos» (marcada por defecto; API: `onlyNew:true` en json-import) OMITE por completo los productos que ya existen (misma
    oferta o mismo anuncio con otro vendedor, también dentro del lote): no se actualizan, no se vinculan y no se vuelven a incluir (motivo `ya_existe_omitido`).
  - `api/admin/json-import/index.ts` - Importación JSON por bloques; admite `target:{categoryId,subcategoryId}` (destino de las fichas NUEVAS, validado contra categories.json; las existentes no se tocan)
  - `api/admin/pipeline/index.ts` - Métricas de auditoría y reproceso del catálogo
    (síncrono o en segundo plano con `background:true`; `mode:'cancel'` lo detiene)
  - `api/admin/users/` - CRUD de usuarios del backend (`index`, `[id]`, `[id]/avatar`)
  - `api/radar/` - Mi Radar: `auth/` (register, login, logout, session, forgot, reset, google/),
    sync de datos (`index.ts`) y Return Flow (`exits.ts`, `projects.ts`)
- `src/lib/` - Lógica de negocio
  - `adminAuth.ts`, `apiAuth.ts` - Autenticación (admin y API)
  - `userStore.ts` - Usuarios del backend (roles admin/usuario, cuenta master, contraseñas scrypt)
  - `radarAuth.ts` - Usuarios finales de Mi Radar (email+contraseña o Google; radar-users.json; cookie `tradylor_radar_session`)
  - `radarStore.ts` - Datos de Mi Radar en la nube (radar-data.json: carpetas, productos, salidas pendientes; merge en sync)
  - `paths.ts` - Rutas persistentes: `DATA_DIR` / `IMAGES_DIR` (en prod: volumen vía env)
  - `catalog.ts`, `catalogStore.ts` - Catálogo de productos en memoria/almacenamiento
  - `catalogListing.ts` - Listado público: búsqueda (sólo título, marca y categoría, sin tildes), filtros OR/AND, chips, tramos de precio y estado en la URL (`?q&category&brand&min&max&deal&f_<atributo>&sort&page`); `catalogFacets.ts` calcula atributos, facetas y recuentos reales
  - `iconLibrary.ts` + `api/admin/icon-library.ts` - Biblioteca local de iconos por palabra y palabras clave automáticas del formulario de categorías/subcategorías (sin IA). Las subcategorías NUNCA llevan icono de carpeta (📂/📁: se limpian al leer y al escribir; sin icono por defecto)
  - `brandResolve.ts` - Marca REAL del fabricante: una tienda («AliExpress», «ebay»…) no es marca; se toma de las especificaciones (Marca/Brand/Fabricante) y si no hay dato queda vacía (nunca se deduce del título). Se aplica en el punto único de escritura (`writeProductsToFile`) y al leer el catálogo
  - `productStore.ts` - Persistencia de `products.json` (lectura/escritura/upsert)
  - `ai.ts` - Enriquecimiento de texto y generación de imágenes con IA
  - `categories.ts` - Categorías
  - `pipeline/` - Pipeline de automatización de productos en 4 etapas
    (`index.ts` orquestador · `stageIngest/audit/categorize/publish.ts` ·
    `config.ts` umbrales · `metrics.ts` contadores · `job.ts` reproceso en
    segundo plano)
  - `networks/` - Conectores con las redes de afiliación (registry, connectors, credentials, types)
- `src/types/radar.ts` - Tipos compartidos cliente/servidor de Mi Radar
- `src/utils/` - Lógica de navegador (bundled por Astro)
  - `radarStore.ts` - Store Offline-First de Mi Radar (LocalStorage + sync con /api/radar)
  - `auth.ts` - Wrappers de auth del cliente (sesión, login, registro, reset, Google)
  - `amazon.ts`, `affiliate.ts` - Utilidades de enlaces de afiliación
- `src/data/` - Datos
  - `products.json`, `categories.json`, `analytics.json`
  - `credentials.json` - Credenciales de redes de afiliación (glitch: NO se sube a git)
  - `users.json` - Usuarios del backend (sólo en local/prod, NO se crea en el repo: se genera en el volumen)
  - `radar-users.json`, `radar-data.json` - Usuarios y datos de Mi Radar (volumen; NO se suben a git)
- `src/components/AdminNav.astro` - Nav del backend: píldora de contexto + secciones + menú de usuario (perfil, crear usuarios, cerrar sesión)
- `src/components/AuthModal.astro` - Modal de auth dual de Mi Radar (login/registro/reset + Google); se monta en Layout
- `src/components/CatalogFilters.astro` - Panel de filtros del catálogo (columna lateral en escritorio; drawer modal accesible en móvil con retorno del foco al botón «Filtrar»). Endpoint de recuentos en vivo: `GET /api/catalogo/facets` (público, solo lectura)
- `src/components/ProductCard.astro` - Tarjeta de producto con botón "Guardar en Mi Radar" (`[data-radar-toggle]`)
- `public/images/products/` - Imágenes de producto generadas con IA (ignorado en git)
- Despliegue
  - `Dockerfile` - Imagen de producción de un solo stage (build SSR en Node 22 Bookworm,
    con `git` + `opencode` para desarrollo remoto desde la Terminal de Easy Panel)
  - `docker/entrypoint.sh` - Siembra datos en el volumen y arranca el SSR
  - `.dockerignore` - Excluye `.env`, `credentials.json`, `node_modules`, etc.
  - `nixpacks.toml` - Build pack alternativo (Easy Panel / Railway)
  - `docs/deploy-easypanel.md` - Guía paso a paso del despliegue en Hostinger

## Variables de entorno

- Copiar `.env.example` a `.env` para desarrollo local.
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`: credenciales del panel admin.
- `TRADYLOR_API_TOKEN`: token Bearer para la API pública v1.
- `N8N_CLICK_WEBHOOK_URL`: webhook opcional que recibe el evento `delegated_checkout_exit` en cada salida
  (sólo telemetría; el alta de productos ya no depende de n8n).
- **Mi Radar (opcional)**: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` activan el login con Google
  (callback: `/api/radar/auth/google/callback`); sin ellas el botón muestra "próximamente".
  `N8N_RESET_WEBHOOK_URL` recibe el email de recuperación de contraseña (`{ to, name, resetUrl }`).
- **IA (opcional)**: `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` para el texto y
  `OPENAI_API_KEY` / `FLUX_API_KEY` para las imágenes; selectores
  `TEXT_AI_PROVIDER` y `IMAGE_AI_PROVIDER` (`openai` por defecto, `anthropic`/`flux`).
  También `GROQ_API_KEY` + `TEXT_AI_PROVIDER=groq` (plan gratuito; **es el
  proveedor por defecto en producción y tiene un límite de peticiones bajo**:
  si se agota, la ficha se queda con la plantilla local. Para esa situación el
  reproceso acepta `provider: 'openai' | 'anthropic' | 'groq'` por tanda).
  `ANTHROPIC_WORKSPACE_ID` es opcional: sólo hace falta si la clave de Anthropic
  NO está vinculada a un workspace (las claves de administración de la organización
  lo exigen en la cabecera `anthropic-workspace-id`; sin él la API responde 400).
  También `GEMINI_API_KEY` + `TEXT_AI_PROVIDER=gemini` (Google AI Studio,
  ai.google.dev; modelo por defecto `gemini-3.5-flash`, sobreescribible con
  `GEMINI_MODEL`; las versiones 3.6-3.8 dieron 503/429 por alta demanda/cuota
  en pruebas reales, 3.5 es estable). Todos los proveedores de texto (`lib/ai.ts`) alimentan tanto
  la consola de IA del backend (`/api/admin/ai-console`, panel admin) como el
  Asistente IA del frontend (`/api/asistente-ia`, widget flotante).
- Claves de cada red de afiliación (opcional; activa los conectores correspondientes).
  ScraperAPI (importación/«Obtener JSON» de Amazon por ASIN): `SCRAPER_API_KEY`;
  `SCRAPER_API_TLD` (opcional, por defecto `es`) fija la tienda de Amazon y se envía
  SIEMPRE explícita (sin ella ScraperAPI deduce el dominio de `country_code` y un valor
  distinto de `es` consulta amazon.com → 404 «Page Not Found»); `SCRAPER_API_COUNTRY_CODE`
  se alinea con ese dominio (ver `src/lib/scraperMarket.ts`).
  Extracción de una categoría de Amazon (Importar › JSON › «URL de categoría»): `APIFY_TOKEN`
  (Apify, actor `junglee/Amazon-crawler`; sólo servidor, nunca en el navegador ni en logs). Opcionales:
  `APIFY_MAX_ITEMS` (tope de productos por extracción, 50 por defecto, máx. 100), `APIFY_RUN_TIMEOUT_SECS`
  (900), `APIFY_MAX_RUNS_PER_DAY` (20), `APIFY_MAX_COST_USD` (tope de gasto por ejecución, 2),
  `APIFY_LANGUAGE` (idioma de Amazon; por defecto `es`, valor del enum del actor admitido por amazon.es; no altera dominio, mercado ni moneda EUR) y
  `APIFY_PROXY_COUNTRY` (sólo si se define se envía). El límite de productos
  viaja a Apify (`maxItemsPerStartUrl`); la fecha de captura de lo extraído es el FIN de la ejecución (aproximación: no es la hora exacta en que
  se observó cada producto); no se envían `countryCode`/`zipCode` (cobran 0,06 USD por resultado).
  Temu (mismo bloque, selector «Origen»): actor `hypebridge/temu-scraper` (id 2CKn7F7pA4eH2mVRm; `APIFY_TEMU_ACTOR` lo
  sobreescribe) con el mismo `APIFY_TOKEN`. Admite URL de producto (…-g-<id>.html) y de categoría (…-o3-<id>.html) CON
  prefijo de mercado /es/ (sin él el actor responde con EE. UU. en USD; se rechaza antes de gastar); rechaza
  búsquedas, colecciones, ofertas relámpago, tiendas y portada. El límite viaja como `maxItems`; `getProductDetails` va activado
  (`APIFY_TEMU_GET_DETAILS=false` lo desactiva) y se pide 1 GB de memoria (arranque 0,03 USD + 0,016 USD por producto; medido: 10 productos = 0,19 USD).
  Producto individual de Temu: bloque propio «URL de producto de Temu» en el panel (reutiliza la extracción; una ejecución, límite 1); una URL de producto SIN
  mercado se normaliza a la ficha española `/es/-g-<id>.html` (el goodsId es el mismo en todos los mercados); otro mercado explícito (/us/…) se rechaza.
  Enlace corto de AFILIADO de Temu (temu.to/k/…, share.temu.com/…): el servidor lo resuelve (sólo dominios de Temu, 6 saltos, sin cookies; `src/lib/temuShortLink.ts`) al goodsId,
  pide la ficha española `/es/-g-<id>` y guarda el corto como `affiliateUrl` (enlace de afiliado, ficha `active`) separado del de origen. Prueba gratuita sin Apify:
  `GET /api/admin/category-extract?resolve=<enlace>`.
  La URL se envía limpia (sin parámetros de seguimiento). OJO: `/es/` no garantiza el mercado español: hay categorías (p. ej. o3-1893)
  que el actor sirve siempre en USD y canoniza sin `/es/` (medido con ejecuciones reales); el panel muestra la moneda devuelta ANTES de importar.
  Categorías de Temu = DOS FASES (ver docs/temu-actor-mercado-es.md): 1) descubrir ids (sin detalle, sólo ids) y 2) fichas españolas
  /es/-g-<id> en UNA ejecución; las dos cuentan en APIFY_MAX_RUNS_PER_DAY; POST admite `budgetUsd` (presupuesto máximo de todo el trabajo).
  Coste medido con 2 productos: 0,104 USD. OJO: se descubre en otro mercado, así que selección y orden pueden no coincidir con la categoría española.
  Sólo EUR del mercado español se importa solo: otra moneda, «desde», precio variable, oferta relámpago o cupón → revisión.
  `EBAY_COMMISSION_RATE` (opcional): % base de comisión EPN que usa el catálogo de
  eBay para la columna "Comisión %" (4-6%; por defecto 5).
- **Desarrollo remoto (opcional)**: `GITHUB_PAT` (push a GitHub desde el contenedor),
  `GIT_USER_NAME` / `GIT_USER_EMAIL` (identidad de commit).
- **Producción (contenedor)**: `TRADYLOR_DATA_DIR` (por defecto `src/data`, en prod
  `/app/data` = volumen), `TRADYLOR_IMAGES_DIR` (imágenes IA), `PORT=4321`, `HOST=0.0.0.0`.

## Comandos

- `npm run dev` - Servidor de desarrollo (http://localhost:4321)
- `npm run build` - Compilar a `dist/` (build standalone de Node). Ejecuta antes `check:inline`.
- `npm run check:inline` - Valida la sintaxis de los `<script is:inline>` de los `.astro`
- `npm start` - Arrancar el build de producción (`node dist/server/entry.mjs`)
- `npm run preview` - Previsualizar el build
- `npm run astro` - CLI de Astro

## Despliegue en producción (Easy Panel / Hostinger)

- Build pack **Dockerfile**, puerto **4321**, healthcheck **`/api/health`**, rama `main`
  con auto-redeploy. Guía completa en `docs/deploy-easypanel.md`.
- **Volumen obligatorio en `/app/data`**: ahí viven `products.json`, `categories.json`,
  `analytics.json`, `credentials.json` y las imágenes IA. Sin volumen se pierden al redeploy.
- Las variables (sobre todo `ADMIN_USERNAME`/`ADMIN_PASSWORD` y `TRADYLOR_API_TOKEN`)
  se configuran en Easy Panel, nunca en el repositorio.
- **Desarrollo dentro del contenedor**: la Terminal de Easy Panel trae `git` + `opencode`
  (config y contexto en la imagen/volumen). Los cambios sólo se publican con
  `git push origin main` (requiere `GITHUB_PAT`); ver `docs/deploy-easypanel.md` §6.
- `/api/health` y `/api/redirect` son públicos a propósito (healthcheck y salida de afiliado).

## Convenciones y avisos

- **Listado público con filtros** (`src/pages/index.astro` + `CatalogFilters.astro`): TODO el estado vive en la URL (Atrás, recarga y enlaces
  directos lo restauran; la posición de scroll se guarda por URL en `sessionStorage`). Con búsqueda o filtros se omiten la diversidad y los
  módulos editoriales. La URL manda siempre sobre la cookie `tradylor_session_sort`. Los enlaces de título e imagen de `ProductCard` abren la
  ficha en la MISMA pestaña (sólo el CTA de salida de afiliado usa `target="_blank"`). «Gangas» = descuento ≥ 20 % con precio anterior
  VERIFICADO (última observación con `verifiedAt` vigente ≤ 7 días y coherente con el precio publicado; el «precio de lista» del proveedor no
  cuenta). Bluetooth sólo se ofrece si lo declaran las especificaciones. Las categorías se resuelven por `category_id` y, sin él, por nombre
  (`makeCategoryResolver`); el texto libre fragmentado («Sonido»/«Audio & Sonido») cuenta como una sola categoría.

- **`<script is:inline>` NO admite TypeScript**: Astro no procesa esos bloques
  (no pasan por Vite), así que una anotación de tipo (`let x: string[] = []`,
  `function f(a: number)`, `as any`, `declare global`) provoca un **error de
  sintaxis que mata el script entero**: la página se queda sin JS (filtros que
  no se pintan, paginación muerta, botones que no responden) sin aviso en el
  HTML. Escribe JavaScript puro ahí y valida con `npm run check:inline` (se
  ejecuta también en `npm run build`).
- **Seguridad**: `src/data/credentials.json` y `.env` están en `.gitignore`. Nunca
  añadir credenciales reales, tokens ni claves de API al código ni a los commits.
- El panel admin y las rutas `/api/*` requieren autenticación; respetar `adminAuth.ts`
  y `apiAuth.ts`. **Excepción**: `/api/redirect` es público a propósito (es la salida
  del flujo de Compra Delegada) y no debe exigir token.
- Botón «🔄 Actualizar Precios» (`/api/admin/sync-prices` → `lib/offerRefresh.ts`): sin selección toma las 10 fichas ACTUALIZABLES (Amazon con ASIN; `isRefreshable`) con la
  comprobación más antigua (las nunca verificadas, como las importadas, primero); las de otras redes ya no ocupan puestos. Los precios de Amazon se leen con
  `parsePrice` (miles y decimales europeos/anglosajones). Consume créditos de ScraperAPI.
- Los redireccionamientos de afiliación salen por `src/pages/out/[id].astro`.
  Amazon: la salida lleva a la FICHA del producto con el tag (`/dp/<ASIN>?tag=…`, `getAmazonProductUrl`), nunca a la cesta; los enlaces de cesta antiguos
  guardados en `buyNowUrl` se convierten al vuelo (`amazonCartToProductUrl`).
- Documentación de la API pública en `docs/api-v1.md`; mantenerla actualizada si se
  cambian los endpoints de `src/pages/api/v1/`.

## Diseño y UX (tareas con cambios visuales)

- **Reutilizar antes de crear**: buscar primero en `src/components/` (y
  `src/components/admin/`) y ampliar el componente existente (p. ej. `ProductCard`
  con `layout="compact"`, `MetricCard`, `PeriodPicker`). No duplicar botones ni
  tarjetas dentro de una página.
- **Identidad**: usar sólo las variables de `src/layouts/Layout.astro` (`:root`:
  `--color-*`, `--border-radius-*`, `--font-body`/`--font-heading`, `--max-width`,
  `--shadow-*`). No introducir colores literales nuevos si existe variable.
  El panel admin (`/upayp1b4`) hereda esas variables y sus clases base
  (`.admin-card`, `.card-title`, `.card-desc`, `.header-icon`).
- **Tailwind** sólo en las zonas del `content` de `tailwind.config.mjs`
  (`trafico-ventas`, `components/admin`, `mi-radar`). Para ampliar el alcance,
  avisar al usuario antes: puede activar clases "dormidas" en otras páginas.
- **Accesibilidad**: foco visible (`:focus-visible`), `aria-label` en controles sólo
  de icono, objetivos táctiles ≥ 44 px, contraste suficiente, navegación por
  teclado, y estados comunicados también con texto o icono (no sólo color).
- **Estados**: prever carga, vacío, error, éxito y datos incompletos; conservar el
  contexto (filtros, página, scroll) al volver al listado o cerrar un panel.
- **Escritorio y móvil**: comprobar ambos (breakpoints en uso: 960, 640, 600 y
  480 px). Si cambia un patrón existente, explicar el problema y presentar la
  solución para revisión antes de generalizarla.
- **Bocetos**: si la tarea los pide, presentarlos antes de implementar.
- **Verificación**: indicar qué se comprobó (`npm run check:inline`, `npm run build`,
  prueba visual) y qué quedó pendiente; si no se puede renderizar la web, decirlo
  expresamente en vez de darlo por verificado.