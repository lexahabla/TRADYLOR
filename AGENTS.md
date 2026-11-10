



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
  - Seguridad de identidad del motor JSON (`lib/jsonImport/engine.ts`, etapa 1.5): un identificador fuerte (anuncio/ASIN, GTIN, marca+MPN) identifica el ANUNCIO, no la variante. Moneda, cantidad/pack, condición y variante distintas o no verificables, un anuncio presente en VARIAS fichas, un vendedor distinto en AliExpress/eBay (un vendedor por anuncio), marca/GTIN/MPN contradictorios, un título incompatible al vincular otra oferta e ids que contradicen su URL → REVISIÓN con su motivo (nunca crear, vincular ni actualizar «a ciegas»). El mismo anuncio y vendedor por API y JSON es la MISMA oferta (vendedor: `offerSeller` → `Tienda` → `fulfillmentProvider`, validado). Las ofertas nuevas guardan `variant`/`quantity` (sólo valores conocidos); las antiguas no se completan. Con «Solo productos nuevos» esas revisiones se omiten como «ya existe». `linkOffers` NO existe.
  - Correcciones del motor (09/11/2026, sólo aditivas en `extra`, sin migración): «Abierto, sin usar»/«Open box» = condición propia `open_box`; actualizar con otra condición, o sin condición sobre una ficha que la tiene, → REVISIÓN (`condicion_no_verificable`); el envío de la oferta principal (coste, gratis, plazo, texto) se guarda en `extra.priceReading.shipping` con `asOf` (captura, sólo si es fiable) y también en `shipping.asOf` de las ofertas vinculadas; un anuncio repetido en el lote con otro precio → revisión (`anuncio_repetido_en_lote_con_precio_distinto:a≠b`); al crear, título casi idéntico con GTIN/MPN contradictorios (`titulo_parecido_con_identificadores_contradictorios`) o sin marca en ambas fichas → revisión; la respuesta de `json-import` añade `reasonTexts` (`jsonImport/reasonLabels.ts`, los códigos no cambian y el panel los muestra en español)
  - Id contra URL (09/11/2026): `idFromUrl` (`comparableOffers.ts`) extrae el id de la URL en Amazon, AliExpress, eBay (`/itm/<id>` o `/itm/<slug>/<id>`, sólo dominio ebay.*) y Temu (`-g-<id>.html`, sólo temu.com). Un id que contradice su URL → revisión `identificadores_contradictorios` ANTES de resolver (no crea, no actualiza, conserva el registro); URL malformada, de otro dominio o sin id extraíble = sin contradicción. Pruebas: `id-from-url.test.mjs`
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
  - `commercialClaims.ts` - Qué se puede afirmar con evidencia (sólo lectura): fecha de captura vs verificación, coste de envío de eBay en `specs['Coste de envío']`, valoración con procedencia (eBay = vendedor; 4,8★/100 y el recuento 100 de AliExpress son valores por defecto del alta y se ocultan), descuento verificado sólo con `extra.observations`, condición «Abierto, sin usar». Ficha y checkout ya NO afirman «devolución a 30 días», plazos por defecto ni «verificado hoy» sin dato; `resolveProductShipping` ya no deduce «≤ 3 días ⇒ gratis»
  - `offersView.ts` + `components/OffersComparator.astro` - Comparador de OFERTAS del mismo producto (`#ofertas`, sólo lectura sobre `getComparableOffers`): 7 columnas en escritorio y una tarjeta por oferta en móvil (sin scroll horizontal); orden por precio o por total (el total sólo si todos los envíos constan); filtro de envío rápido sólo con datos; «más barata» sólo con totales comparables; lo que no consta → «No indicado». Cada botón sale por `/api/redirect?id=<ficha>&offer=<offerId>` (`offerRedirect.ts`: sólo ofertas de ESA ficha, un `offerId` desconocido vuelve a `#ofertas`, sólo http(s)). El enlace de afiliado nunca va en el HTML (tampoco en el JSON-LD)
  - `publicClaims.ts` - Saneado de LECTURA de los textos generados (pros, contras, veredicto, descripción) en la ficha: descarta recuentos de reseñas, % de descuento, análisis propios inexistentes, datos internos (comisión) y rendimiento con cifras ausentes de título/specs; respeta `extra.fieldSources.<campo> = manual`; no muta ni guarda nada
  - `specsView.ts` - Ficha técnica desplegable (`#ficha-tecnica`): 6 características principales según la familia del producto (ordenador: procesador, RAM, almacenamiento, pantalla…; auriculares: autonomía, conectividad…) y el resto tras un `<details>` «Ver todas las características» / «Mostrar menos». No elimina datos
  - Actualización de precios como fuente central (`offerRefresh.ts`): una consulta por ANUNCIO (varias fichas del mismo anuncio comparten lectura y fallo), prioridad a las fichas con alerta activa, cadencia adaptativa (precio estable en 3 lecturas → el doble de espera, máx. 72 h; con alerta, nunca) y, tras cada ciclo con observaciones, evaluación del centro «Alertas de precio» sin nuevas consultas. El centro aplica las mismas salvaguardas que Mi Radar (lectura vigente, EUR, precio por JSON verificado). Las fichas verificadas ya no anotan el precio del catálogo en cada visita y el historial usa sólo lecturas verificadas cuando hay ≥ 2. `offerRefreshExtra.ts`: AliExpress y eBay por id con APIs oficiales, OPT-IN (`OFFER_REFRESH_EXTRA_SOURCES=aliexpress,ebay`; programación apagada hasta habilitarla en el panel; un salto > 50 % va a revisión; aún no contrastado con respuestas reales). Temu sigue sin fuente (sólo Apify, de pago). Ficha técnica: el desplegable sólo existe con 12 o más características (se ven 6)
  - `priceAlertAdvice.ts` - Recomendación del precio objetivo en la caja de alerta de la ficha: barra con zonas de color (rojo poco probable / ámbar posible / verde realista) y «Precio recomendado». Sólo guía cualitativa: con ≥ 3 lecturas reales usa mínimo, máximo y volatilidad del historial; si no, una referencia ORIENTATIVA rotulada como tal; cerca del Black Friday amplía la zona «posible». Nunca da probabilidades numéricas ni predice. Pruebas: `price-alert-advice.test.mjs`
  - `priceHistoryView.ts` + `components/PriceHistoryChart.astro` - Historial de precios 1/3/6/12 meses con lecturas REALES (`priceHistory` = precio del catálogo al visitar la ficha; `extra.observations` verificadas): escalón, sin puntos inventados, mínimo/máximo con fecha, envío aparte, «sin historial suficiente»; NO hay actualización automática diaria. Incluye la caja «Activar alerta de precio»
  - `priceAlertCenter.ts` + `alertsHttp.ts` + `api/alertas-precio/*` + `pages/alertas-precio.astro` - Centro «Alertas de precio» INDEPENDIENTE de Mi Radar (datos en `price-alert-center.json`; sólo comparte la sesión de cuenta y el SMTP). A) alertas por precio objetivo (con/sin envío; notificación interna + correo; una sola vez por objetivo; topes de 3 correos por usuario y día y 40 por ejecución; vigilante cada 30 min con registro de ejecuciones; `PRICE_ALERT_CENTER_ENABLED`). B) bajadas de productos visitados: APAGADO por defecto (`PRICE_DROP_VISITS_ENABLED=true` lo activa; sin él no registra visitas ni envía nada) hasta resolver RGPD/LSSI; exige señal verificada posterior a la visita. Campana con punto rojo en el menú de usuario. Preferencias independientes (interno/correo) por tipo
  - `stock.ts` + `components/StockBadge.astro` + `components/StockAlert.astro` - Disponibilidad a la vista de antemano en la tarjeta, la ficha, el checkout y el comparador de modelos: sólo lo que declara la fuente (`inStock`; sin dato = «Stock no indicado», con su fecha de captura). Con «Agotado» se ofrece «Avísame cuando vuelva a haber stock»: guarda el producto en Mi Radar y activa su `notifyStock` (manejador en `Layout.astro`; lo vigila el worker existente `priceAlerts.ts`, no se duplica). `specExtract.ts` completa las especificaciones vacías del comparador desde el TÍTULO (RAM, almacenamiento, procesador, pantalla, GPU, Bluetooth, autonomía; marcadas «del título»); el comparador se titula «Comparar {subcategoría o familia} de {categoría}» (p. ej. «Comparar Portátiles de Informática»)
  - `modelComparison.ts` + `components/ModelComparison.astro` - Comparador de MODELOS (`#comparativa`): un modelo por columna, atributos normalizados, «Sin dato»; excluye accesorios, fichas gemelas del mismo anuncio y productos de OTRA función (familia deducida del título o misma subcategoría; sin datos → excluido con motivo en `excluded`); sólo presentación, las fichas no se tocan. `satisfaction.ts` comparte el indicador de satisfacción con `ProductCard` Cabecera de cada columna = tarjeta estilo Product Card (foto del propio producto, nombre, precio, pastilla de descuento SOLO verificado, pastilla de valoración fiable, barra de pros y contras con el mismo indicador que ProductCard, botón «Ver ficha»); precio/valoración/indicador no se repiten como filas. Sin enlaces de afiliación ni redirecciones (sólo a la ficha)
  - `comparableOffers.ts` - Capa de LECTURA (Etapa 1, sin publicar): `getComparableOffers(product, {catalog})` devuelve las ofertas comparables de una ficha (implícita + `extra.offers`) con una oferta por identidad comercial (plataforma + anuncio + vendedor). Vendedor: `extra.offerSeller` → `extra.Tienda` → `fulfillmentProvider`, validado (ni plataforma, ni logística, ni malformado); si no hay, «Vendedor no indicado». Nunca fusiona por título ni por marca+modelo, no escribe ni reescribe claves, ignora `crossMerchant`. `linkOffers` NO existe (desactivada)
  - `homeLayout/` (`types.ts`, `validate.ts`, `store.ts`) + `pages/upayp1b4/portada.astro` + `api/admin/home-layout` - Portada editable, ETAPA 1 (rama `feature/portada-etapa-1`, sin publicar): apartado «Portada» del backend (sólo admin; sólo lectura) y modelo de bloques. Un bloque separa modalidad (provisional: manual, automática, sección, editorial), formato (banner, cuadrícula 2×2, carrusel), ancho (12 columnas: 3,4,6,8,9,12), tarjeta reutilizable (producto, categoría, promoción) y referencias por id (nunca copia productos). Registros extensibles en `validate.ts`. La modalidad automática sólo admite criterios con datos fiables (categoría, subcategoría, comercio, recientes, precio) y RECHAZA descuento, bajada de precio, popularidad y ventas; el motor NO existe todavía. `home-layout.json` (volumen, no git, independiente de `sections.json`): escritura atómica + `.bak`; un archivo corrupto/inválido/de esquema más nuevo NO se sobrescribe (se conserva para diagnóstico); `recoverHomeLayoutFromBackup()` es explícita. La portada nueva está DESACTIVADA: `resolveHomeMode()` devuelve siempre «legacy» (candado `HOME_LAYOUT_STAGE_ENABLED=false` en el código + `HOME_LAYOUT_ENABLED` + `activation.enabled` + portada publicada válida; cualquier fallo vuelve a la actual) y `index.astro` NO consulta este módulo. Pruebas: `home-layout.test.mjs`.
  - Portada editable, ETAPA 2 (solo lectura; `sources.ts`, `resolve.ts`, `sectionsProposal.ts` + `api/admin/home-layout/{resolve,options}`): comprueba por id que lo referenciado existe sin escribir NADA (no usa `getCategories()`, que puede reescribir `categories.json`: lee el archivo directamente y, si falta, usa las categorías base en memoria; lee `sections.json` directamente). Gravedad error/aviso/info; `visible` = referencias válidas + mínimo del formato (banner 1, carrusel 1, cuadrícula 2×2 → 4 productos presentables = título y precio; la falta de stock NUNCA oculta; automática = null, selección sin ejecutar). Propuesta en memoria: secciones publicadas → bloques «Sección» con la misma lógica que `index.astro` (orden, arriba/abajo, velocidad, productos existentes). Contrato: `GET /api/admin/home-layout/resolve?source=draft|published|proposal`; `GET /api/admin/home-layout/options?kind=product|category|section|merchant[&q (≤80)][&limit 1-50 (20)][&offset 0-10000]`; sólo admin (401), parámetro desconocido/repetido 400, otro método 405 (Allow: GET), 500 sin detalles; sin enlaces de afiliado ni comisiones. Pruebas: `home-layout-resolve.test.mjs`.
  - Portada editable, ETAPA 3 (editor visual del BORRADOR; `homeLayout/draft.ts` + `src/scripts/homeLayoutEditor.ts` + `api/admin/home-layout/draft`): editor en `/upayp1b4/portada` (lienzo de 12 columnas, anchos ¼-1, arrastrar + ▲▼, propiedades por modalidad, selectores conectados a `options`, vista previa de escritorio y móvil). `draft.ts` es PURO (válido en el navegador): operaciones sobre bloques y `prepareDraftSave`. API `GET/PUT /api/admin/home-layout/draft`: PUT sólo guarda el borrador (nunca publica ni activa); cuerpo `{baseRevision, blocks}`; revisión = `draft.updatedAt` ("inicial" si no hay) → 409 `conflicto` si está obsoleta; validación estricta (≤60 bloques, ≤256 KiB); escritura atómica + `.bak`; archivo dañado → 423 y no se sobrescribe; CSRF: `sameOrigin` + cabecera `X-Home-Layout-Editor: 1` + JSON; 401 sin admin, 405 otros métodos. Sin guardado automático: sólo al pulsar «Guardar borrador». La modalidad Automática se configura pero NO se ejecuta. Pruebas: `home-layout-draft.test.mjs`.
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
  Automatización por plataforma (`docs/actualizacion-precios-activacion.md`, guía de activación): estado por plataforma en el panel (`refreshPlatforms.ts`; tabla en «Precios» con estado, fichas con fuente, última verificación, consumo del día, frecuencia 12/24/48/72 h/semanal y tope diario; respuesta `platforms` de `GET /api/admin/offers/refresh`); parada automática de una fuente ante fallo de autenticación o cuota (`classifyFailure`; el programador la deja desactivada con `pausedReason`); lista blanca `OFFER_REFRESH_SOURCES` (p. ej. `ebay`) para que el programador sólo consulte esas fuentes. Pruebas: `refresh-platform-guards.test.mjs`, `refresh-adapters-raw.test.mjs` (respuestas simuladas de eBay, AliExpress y ScraperAPI; NO sustituyen a la verificación con la API real).
  Límites por fuente del programador (`offerRefresh.ts`): cada fuente usa su propio `batchSize` y un tope diario opcional `maxPerDay` (Amazon nace con 10; Temu con 2; eBay y AliExpress sin tope), descontando los intentos de hoy del registro `offer-refresh-runs.json` (últimas 60 ejecuciones: intentos por fuente, errores saneados sin claves; `GET /api/admin/offers/refresh` devuelve `runs` y `attemptsToday`). Se configura en el panel con `{action:'config', network, enabled, everyHours, maxPerDay}` (0 = pausa, null = sin tope) y persiste en `offer-refresh.json` del volumen. Temu (`OFFER_REFRESH_EXTRA_SOURCES=temu` + `APIFY_TOKEN`, DE PAGO): `temuAdapter` reutiliza la extracción de Apify (una ejecución por ficha, `limit` 1) y `apifyTemu`; un precio dudoso (desde, variante, relámpago, cupón, moneda no EUR, otro goodsId) NO se aplica y ningún fallo se reintenta. Pruebas: `refresh-source-limits.test.mjs`, `temu-refresh-adapter.test.mjs`.
  AliExpress «Validar conexión» (`AliExpressConnector.validate`): comprueba el `resp_code` DENTRO de la respuesta (401 «This publisher is not registered», 404 «System Error»…) además de los errores de firma/transporte; ya no da «Conexión verificada» con la cuenta de afiliado bloqueada (`aliexpress-validate.test.mjs`).
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
- Actualización manual `POST /api/admin/offers/refresh` con `evaluateAlerts:false` (sólo admin, sólo con `ids`; por defecto las alertas se evalúan): omite el barrido de Mi Radar y del centro «Alertas de precio» tras el refresco. Como los vigilantes independientes notificarían igualmente tras guardar el precio, se RECHAZA (409 `alertas_vigilando`, con el recuento `alertExposure` sin datos de usuarios) si alguna alerta del centro o de Mi Radar vigila esas fichas (`refreshAlertGuard.ts`; pruebas `refresh-alert-guard.test.mjs`).
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