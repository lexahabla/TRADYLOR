# Tradylor - Instrucciones para agentes de IA

## Flujo de trabajo (obligatorio, cualquier modelo)

Estas reglas aplican **siempre**, sea cual sea el modelo activo en opencode
(Mimo, u otro seleccionado con `/model`): las carga opencode vía `opencode.json`
al abrir el proyecto, y el agente debe seguirlas en cada sesión.

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

3. El push a `main` **despliega automáticamente** en https://tradylor.com
   (webhook de GitHub → Easy Panel → build Docker, ~2-3 minutos). No hace falta
   tocar ningún panel. Para confirmar que el deploy terminó:
   `curl https://tradylor.com/api/health` debe devolver `"status":"ok"`.
4. **Los datos NO van en git**: productos, categorías, analytics,
   `credentials.json` e imágenes IA viven en el **volumen** del servidor
   (`/app/data`). Es normal que falten ficheros en `src/data/` o en
   `public/images/` respecto al entorno de producción: no intentar "regenerarlos"
   ni "arreglar" nada por eso.
5. **Nunca subir secretos**: `.env`, `credentials.json` y claves están en
   `.gitignore`; no forzar su inclusión ni pegar claves en el código.
6. Tras un push, si el deploy falla (webhook/health), informar al usuario en vez
   de reintentar deploys a ciegas.

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
  - `admin/perfil.astro` y `admin/usuarios.astro` - Perfil del usuario y gestión de usuarios del backend
  - `mi-radar.astro` - Panel personal del usuario final (anónimo LocalStorage + nube con sesión)
  - `api/` - Endpoints internos y la API pública `v1` (`docs/api-v1.md`)
  - `api/redirect.ts` - Salida registrada (302) al enlace de afiliado del checkout
  - `api/health.ts` - Healthcheck público para Docker / Easy Panel (sin auth)
  - `api/admin/add-product.ts` - Alta/actualización de producto con IA (texto + imagen)
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
  - `productStore.ts` - Persistencia de `products.json` (lectura/escritura/upsert)
  - `ai.ts` - Enriquecimiento de texto y generación de imágenes con IA
  - `categories.ts` - Categorías
  - `opportunity.ts` - Detección de oportunidades de contenido
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
- Claves de cada red de afiliación (opcional; activa los conectores correspondientes).
- **Desarrollo remoto (opcional)**: `GITHUB_PAT` (push a GitHub desde el contenedor),
  `GIT_USER_NAME` / `GIT_USER_EMAIL` (identidad de commit).
- **Producción (contenedor)**: `TRADYLOR_DATA_DIR` (por defecto `src/data`, en prod
  `/app/data` = volumen), `TRADYLOR_IMAGES_DIR` (imágenes IA), `PORT=4321`, `HOST=0.0.0.0`.

## Comandos

- `npm run dev` - Servidor de desarrollo (http://localhost:4321)
- `npm run build` - Compilar a `dist/` (build standalone de Node)
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

- **Seguridad**: `src/data/credentials.json` y `.env` están en `.gitignore`. Nunca
  añadir credenciales reales, tokens ni claves de API al código ni a los commits.
- El panel admin y las rutas `/api/*` requieren autenticación; respetar `adminAuth.ts`
  y `apiAuth.ts`. **Excepción**: `/api/redirect` es público a propósito (es la salida
  del flujo de Compra Delegada) y no debe exigir token.
- Los redireccionamientos de afiliación salen por `src/pages/out/[id].astro`.
- Documentación de la API pública en `docs/api-v1.md`; mantenerla actualizada si se
  cambian los endpoints de `src/pages/api/v1/`.