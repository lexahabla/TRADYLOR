# Despliegue en producción — Easy Panel (Hostinger)

Tradylor corre como **SSR de Astro (adaptador Node standalone)** dentro de un contenedor
Docker. En Easy Panel la app se sirve detrás de su proxy (HTTPS con Let's Encrypt) y
escucha en el puerto **4321**.

## 1. Crear la aplicación en Easy Panel

1. Easy Panel → **Create App** → **App from GitHub** (o *Git repository*).
2. Repositorio: `https://github.com/lexahabla/TRADYLOR.git`, rama `main`.
3. **Build pack**: `Dockerfile` (recomendado). Si se elige Nixpacks, usa `nixpacks.toml`
   (mismo build y mismo `start`), pero sin volumen configurado los datos no persisten.
4. **Puerto / port detection**: `4321`.
5. **Health check path**: `/api/health` (devuelve `200` con JSON `status: ok`).
6. Activar **Auto redeploy** (o desplegar a mano tras cada `git push`).

## 2. Volumen persistente (obligatorio)

Todo lo que la app escribe en tiempo de ejecución vive en `TRADYLOR_DATA_DIR`
(**`/app/data`** en el contenedor):

| Ruta en el volumen                  | Contenido                              |
| ----------------------------------- | -------------------------------------- |
| `/app/data/products.json`           | Catálogo de productos (admin/API)      |
| `/app/data/categories.json`         | Categorías (CRUD desde el panel)       |
| `/app/data/analytics.json`          | Analítica del panel                    |
| `/app/data/credentials.json`        | Credenciales de redes de afiliación    |
| `/app/data/images/products/`        | Imágenes PNG generadas con IA          |

En Easy Panel → pestaña **Volumes** (o *Mounts*) del servicio, añadir:

```
Host path (nombre):  tradylor-data
Mount path:          /app/data
```

**Importante**: sin este volumen, cada rebuild borra productos, categorías e imágenes.

Al primer arranque, `docker/entrypoint.sh` copia al volumen los JSON incluidos en la
imagen (semilla desde `src/data/`) sólo si aún no existen; después restaura en
`dist/client/images/products` las imágenes que ya estén en el volumen (esas son las que
sirve el servidor).

## 3. Variables de entorno

Easy Panel → pestaña **Environment**. Copiar `.env.example` como referencia y definir,
como mínimo:

```bash
# Obligatorio en producción
ADMIN_USERNAME=<usuario admin>
ADMIN_PASSWORD=<contraseña fuerte y única>
TRADYLOR_API_TOKEN=<token largo para la API pública v1>

# Recomendado
HOST=0.0.0.0
PORT=4321
N8N_CLICK_WEBHOOK_URL=https://<tu-n8n>/webhook/tradylor-click   # opcional

# IA (alta de productos con texto + imagen)
TEXT_AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
IMAGE_AI_PROVIDER=openai        # o flux + FLUX_API_KEY
```

Notas:

- **No** subir `.env` al repositorio ni a la imagen (`.dockerignore` lo excluye).
- Si `ADMIN_PASSWORD` no está definida, `adminAuth.ts` usa un valor por defecto
  incluido en el código: **siempre hay que sobreescribirla en Easy Panel**.
- Las credenciales de las redes de afiliación no van por entorno: se guardan desde el
  panel admin y quedan en `/app/data/credentials.json` (volumen).
- El resto de claves de `N8N`/marketing de `.env.example` son opcionales.

## 4. Dominio

1. Easy Panel → app → **Domains**: añadir `tradylor.com` y `www.tradylor.com`.
2. En Hostinger, apuntar los DNS del dominio a la IP del VPS con Easy Panel
   (registro `A`, y `CNAME` para `www`).
3. Easy Panel emite certificado Let's Encrypt y redirige HTTP → HTTPS.

## 5. Verificación posterior al deploy

```bash
curl -I https://tradylor.com/api/health     # 200 + {"status":"ok",...}
open https://tradylor.com/admin             # login con ADMIN_USERNAME/PASSWORD
```

Comprobar también: portada con productos, ficha `/producto/<slug>`, salida `/out/<id>`
y un alta desde el panel admin (escribe en el volumen).

## 6. Comandos de mantenimiento

- **Actualizar**: `git push origin main` → Easy Panel reconstruye la imagen y reinicia.
  Los datos siguen en el volumen.
- **Logs**: Easy Panel → pestaña *Terminal / Logs* del servicio.
- **Consola Node**: `npm run build` ya está hecho dentro de la imagen; para una sesión
  interactiva usar el terminal de Easy Panel (`node dist/server/entry.mjs`).

## 7. Estructura del contenedor

- `Dockerfile` (un solo stage, `node:22-bookworm-slim`): `npm ci` + `npm run build`
  y arranque del SSR con `node dist/server/entry.mjs`.
- `docker/entrypoint.sh`: siembra datos, sincroniza imágenes, baja a usuario `node`
  (vía `gosu`) y lanza el servidor.
- `nixpacks.toml`: alternativa de build pack (mismo `start`).
- Variables: `TRADYLOR_DATA_DIR=/app/data`, `TRADYLOR_IMAGES_DIR=/app/data/images/products`,
  `PORT=4321`, `HOST=0.0.0.0`.
