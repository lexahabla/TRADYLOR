# Portada editable — guía de activación, recuperación y operación

Editor visual en `/upayp1b4/portada` (sólo admin). La web pública sigue mostrando **la portada de siempre** salvo que estén abiertos **los tres candados** a la vez.

## Los tres candados

| # | Candado | Quién lo cambia | Si está cerrado |
|---|---|---|---|
| 1 | `HOME_LAYOUT_STAGE_ENABLED` (constante en `src/lib/homeLayout/store.ts`) | un commit | portada de siempre |
| 2 | Variable de entorno `HOME_LAYOUT_ENABLED=true` en el servidor (Easy Panel) | quien administra el servidor (requiere reinicio) | portada de siempre, **sin leer ningún archivo** |
| 3 | Activación del administrador: `activation.enabled` (en `home-layout.json`) **y** `active` + versión fijada (en `home-layout-activation.json`) | administrador, desde la pestaña «B · Publicación y versiones» | portada de siempre, de inmediato (sin reinicio) |

Cualquier otro fallo (archivos dañados o de esquema más nuevo, versión fijada inexistente, catálogo no disponible, ningún bloque visible, excepción) también devuelve la portada de siempre: `buildPublicHome()` (`src/lib/homeLayout/public.ts`) nunca lanza.

## Qué se ve cuando está activa

- Arriba (bajo la cabecera): círculos de **historias** publicadas y válidas, y los bloques de la versión **fijada** (manuales, automáticos, de sección, editoriales).
- El catálogo con búsqueda, filtros, SEO y el `<h1>` del hero no cambian. Con búsqueda o filtros activos no se pinta nada editorial (igual que hoy).
- Debajo del método: las secciones cuya posición es «debajo».
- Las secciones creadas con «Crear sección» se conservan: un bloque «Sección» las referencia por id (título, productos, velocidad y posición siguen en `sections.json`, que no se modifica) y conservan su `id="section-<id>"` (el menú de navegación enlaza a él). Las secciones publicadas que **ningún bloque referencia** siguen visibles en su posición actual, sin duplicarse.

## Versión fijada

Publicar una versión interna **no cambia la web**. La web sirve la versión que se **fijó al activar**. Para cambiarla hay que pulsar «Activar vN…» (con su validación y confirmación). Guardado en `home-layout-activation.json` (volumen, no va a git; escritura atómica + `.bak`; archivo dañado/no válido/más nuevo = no se sobrescribe y la web sirve la portada de siempre).

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

`home-layout-public.test.mjs`, `home-layout-activation.test.mjs`, `home-layout-stories-public.test.mjs` (más las de las etapas 1-5 actualizadas). Incidencia intermitente conocida y ajena: `import-actions.test.mjs` («Importar y enriquecer con IA…») falla de forma esporádica en la suite completa y pasa aislada.
