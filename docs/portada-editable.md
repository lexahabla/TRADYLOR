# Portada editable — guía de activación, recuperación y operación

Editor visual en `/upayp1b4/portada` (sólo admin). La web pública sigue mostrando **la portada de siempre** salvo que estén abiertos **los tres candados** a la vez.

## Los tres candados

| # | Candado | Quién lo cambia | Si está cerrado |
|---|---|---|---|
| 1 | `HOME_LAYOUT_STAGE_ENABLED` (constante en `src/lib/homeLayout/store.ts`) | un commit | portada de siempre |
| 2 | Variable de entorno `HOME_LAYOUT_ENABLED=true` en el servidor (Easy Panel) | quien administra el servidor (requiere reinicio) | portada de siempre, **sin leer ningún archivo** |
| 3 | Activación del administrador: `activation.enabled` (en `home-layout.json`) **y** `active` + versión fijada (en `home-layout-activation.json`) | administrador, desde la pestaña «B · Publicación y versiones» | portada de siempre, de inmediato (sin reinicio) |

**Renderizado protegido.** Un error dentro de un componente se produce a mitad del flujo de salida de Astro y dejaría la página rota (HTTP 200 con «Internal server error»); un `try/catch` normal o `middleware.ts` no lo pueden capturar. Por eso `index.astro` renderiza primero «en seco», con `experimental_AstroContainer` y dentro de un `try/catch`, `HomeLayoutBlocks` (superior e inferior) y `HomeStories`. Si algo lanza, o el resultado queda vacío, se pinta la **portada de siempre completa** (se registra `[portada] el renderizado de prueba falló…` en el log). Los componentes no tienen efectos secundarios (no escriben, no consultan la red, no usan cookies) y los scripts del navegador no se ejecutan en el render de prueba, así que nada se duplica. No hay caché: el coste es de unos +15 ms (catálogo real) a +32 ms (2.000 productos) sólo cuando la portada nueva está activa; con la variable apagada o la portada desactivada es cero. Cubre errores deterministas ligados a los datos; no cubre un fallo aleatorio que ocurra sólo en el render real (la desactivación desde el panel o la variable del servidor siguen siendo la salida).

Cualquier otro fallo (archivos dañados o de esquema más nuevo, versión fijada inexistente, catálogo no disponible, ningún bloque visible, excepción) también devuelve la portada de siempre: `buildPublicHome()` (`src/lib/homeLayout/public.ts`) nunca lanza.

## Qué se ve cuando está activa

- Arriba (bajo la cabecera): círculos de **historias** publicadas y válidas, y los bloques de la versión **fijada** (manuales, automáticos, de sección, editoriales).
- El catálogo con búsqueda, filtros, SEO y el `<h1>` del hero no cambian. Con búsqueda o filtros activos no se pinta nada editorial (igual que hoy).
- Debajo del método: las secciones cuya posición es «debajo».
- Las secciones creadas con «Crear sección» se conservan: un bloque «Sección» las referencia por id (título, productos, velocidad y posición siguen en `sections.json`, que no se modifica) y conservan su `id="section-<id>"` (el menú de navegación enlaza a él). Las secciones publicadas que **ningún bloque referencia** siguen visibles en su posición actual, sin duplicarse.

## Versión fijada

Publicar una versión interna **no cambia la web**. La web sirve la versión que se **fijó al activar**. Para cambiarla hay que pulsar «Activar vN…» (con su validación y confirmación). Guardado en `home-layout-activation.json` (volumen, no va a git; escritura atómica + `.bak`; archivo dañado/no válido/más nuevo = no se sobrescribe y la web sirve la portada de siempre).

## Menú «Top Selecciones» (gestión manual)

El menú «Top Selecciones» del encabezado (junto a «Lo más vendido» y «Mejor valorados», que son fijos) lo administra el administrador desde **Secciones de la web → «Menú Top Selecciones»**: elegir qué secciones salen, ordenarlas con ▲▼, añadir/retirar (sin eliminar la sección) y «Guardar menú». Es independiente del `order` y de la posición de la portada y de la visibilidad de los bloques de la portada nueva, y funciona igual con la portada de siempre y con la nueva.

- **Almacenamiento:** `nav-top-sections.json` en el volumen (no va a git; atómico + `.bak`; control de revisión; un archivo dañado/no válido/más nuevo NO se sobrescribe: el menú vuelve al automático de siempre, el panel avisa y ofrece «Recuperar copia»). `sections.json` no se toca.
- **Inicio:** sin archivo el menú es AUTOMÁTICO (todas las publicadas, como hasta ahora). «Fijar el menú actual» (o guardar) lo pasa a manual conservando las actuales.
- **Crear una sección NO la añade:** `POST /api/admin/sections` fija antes el menú vigente si todavía no hay configuración manual; si no se puede fijar (archivo dañado o fallo de escritura) la sección NO se crea (423/500) y, si falla la creación después, se deshace la copia fija.
- **Enlaces válidos:** el encabezado sólo enlaza `/#section-<id>` si esa sección se renderiza en la portada `/`: portada de siempre = publicada y con productos; portada nueva = las que pinta el plan público (un bloque oculto o una sección no incluida ⇒ sin enlace). Lo guardado no se modifica; el administrador ve el aviso por sección. En búsquedas y filtros los enlaces siguen apuntando a `/#section-…` (la portada).
- **Reversión:** borrar `nav-top-sections.json` devuelve el menú al automático de siempre.
- **API:** `GET/PUT/POST /api/admin/top-selections` (admin, CSRF `sameOrigin` + `X-Home-Layout-Editor: 1`, ≤ 8 KiB, ≤ 30 secciones, sin duplicados). Código: `src/lib/topSelections.ts`, `src/scripts/topSelectionsAdmin.ts`. Pruebas: `top-selections.test.mjs`.

## Portada inicial en una sola acción

Con la portada virgen (sin borrador, versiones ni activación) la pestaña «B · Publicación y versiones» muestra la tarjeta **«Portada inicial»**: «Cargar, publicar y activar la portada inicial…» (con confirmación) guarda 7 bloques conectados al catálogo real (bienvenida editorial, tarjetas de categoría, «Los más económicos», «Más económicos en Amazon» y carruseles de Portabilidad, Informática y Sonido por precio ascendente), publica la v1 y la deja fijada y activada internamente. NO sobrescribe nada (si existe cualquier borrador, versión o activación se rechaza con 409), se rechaza (422) si algún bloque no puede mostrarse con los datos reales, y si falla la escritura se deshace. La web pública no cambia hasta `HOME_LAYOUT_ENABLED=true`. API: `GET/POST /api/admin/home-layout/initial`; código en `homeLayout/initialLayout.ts`; pruebas `home-layout-initial.test.mjs`. Después todo se edita desde el editor.

## Procedimiento de activación (producción)

1. Publicar el código (merge a `main` + push → despliegue automático). Con `HOME_LAYOUT_ENABLED` sin definir **la web no cambia**. Comprobar `GET /api/health` (`sourceHash`).
2. En el panel: diseñar, guardar borrador, «Publicar versión» (interno) y revisar las vistas previas (escritorio y móvil) y las historias.
3. En Easy Panel: definir `HOME_LAYOUT_ENABLED=true` y reiniciar la aplicación. Sigue sin cambiar nada mientras el administrador no active.
4. En el panel (pestaña B): «Activar vN…». La validación completa se ejecuta con los datos actuales y bloquea si hay errores de referencias, enlaces o imágenes editoriales no admisibles, ningún bloque visible, o un bloque automático visible con «más recientes» sin fechas de alta fiables (corrígelo cambiando su orden a «precio»). Confirmar.
5. Comprobar la portada en un navegador (escritorio y móvil).

## Desactivación de emergencia (de la más rápida a la más drástica)

1. **Panel** → pestaña B → «Desactivar (volver a la portada de siempre)…» → confirmar. Efecto inmediato en la siguiente petición. Apaga los dos interruptores del administrador (siempre posible; ignora revisiones; se registra). No borra versiones ni borradores.
2. Si el panel no estuviera disponible: `POST /api/admin/home-layout/activation` con `{"action":"deactivate","confirm":true}` (sesión de admin, cabecera `X-Home-Layout-Editor: 1`).
3. Si nada de lo anterior fuera posible: definir `HOME_LAYOUT_ENABLED=false` (o quitarla) en Easy Panel y reiniciar. La web vuelve a la portada de siempre sin leer archivos.
4. Cualquier archivo dañado también devuelve la portada de siempre por sí solo.

## Archivos de datos (volumen `/app/data`, no van a git)

`home-layout.json` (borrador, versión publicada, historial ≤ 100) · `home-layout-activation.json` (interruptor, versión fijada, registro de operaciones ≤ 200) · `home-stories.json` (historias). Los tres, con `.bak`. Recuperar un archivo dañado es una acción explícita del responsable técnico (el original se conserva para diagnóstico).

## Historias

Sólo se muestran las **publicadas** sin errores contra el catálogo actual; los borradores nunca. Una pantalla con imagen inexistente o no admisible se omite; una historia sin pantallas válidas no aparece; el botón sólo existe con destino válido (producto/categoría por id o ruta propia pública; nunca `/api`, `/upayp1b4`, `/out`, `/checkout`, `/admin`). Imágenes: ruta propia o https externa con extensión jpg/jpeg/png/webp/avif/gif (nada de vídeo, IP, puertos, credenciales ni hosts internos). Visor: `<dialog>` accesible, teclado ← → Esc, pausa al mantener pulsado, `prefers-reduced-motion` sin avance automático. Sin redes sociales ni analítica.

## Pruebas

`home-layout-public.test.mjs`, `home-layout-activation.test.mjs`, `home-layout-stories-public.test.mjs` (más las de las etapas 1-5 actualizadas). Recuperación probada contra el build de producción con errores inyectados en un entorno aislado (fallo en bloque superior, inferior, historias, archivos dañados o ausentes, versión inexistente): siempre 200, página completa e idéntica a la portada de siempre. `import-actions.test.mjs` ya no usa esperas fijas: `wait()` espera a que termine el flujo del cliente simulado (máx. 10 s) y `waitDebounce()`/`waitFor()` esperan al antirrebote y al sondeo; la incidencia intermitente (fallaba con la CPU saturada) quedó resuelta.
