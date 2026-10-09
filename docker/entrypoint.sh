#!/bin/sh
# ==============================================================================
# TRADYLOR - Punto de entrada del contenedor de producción
#  1) Prepara el directorio persistente (volumen) y siembra los JSON de la imagen.
#  2) Copia las imágenes generadas con IA al build servible (dist/client).
#  3) Ajusta permisos y arranca el SSR como usuario no privilegiado (node).
# ==============================================================================
set -e

# El contenedor debe escuchar en todas las interfaces (detrás del proxy de Easy Panel).
HOST="${HOST:-0.0.0.0}"
export HOST

DATA_DIR="${TRADYLOR_DATA_DIR:-/app/data}"
IMAGES_DIR="${TRADYLOR_IMAGES_DIR:-$DATA_DIR/images/products}"
CLIENT_IMAGES_DIR="/app/dist/client/images/products"

mkdir -p "$DATA_DIR" "$IMAGES_DIR" "$CLIENT_IMAGES_DIR"

# Semilla inicial: JSON incluidos en la imagen sólo si el volumen aún no los tiene.
if [ -d /app/seed ]; then
  for name in products.json categories.json analytics.json; do
    if [ ! -f "$DATA_DIR/$name" ] && [ -f "/app/seed/$name" ]; then
      cp "/app/seed/$name" "$DATA_DIR/$name"
      echo "[entrypoint] Sembrado $name en $DATA_DIR"
    fi
  done
fi

# Restaura en el build servible las imágenes que ya existan en el volumen.
for pattern in "$IMAGES_DIR"/*.png "$IMAGES_DIR"/*.jpg "$IMAGES_DIR"/*.jpeg "$IMAGES_DIR"/*.webp; do
  [ -f "$pattern" ] || continue
  name=$(basename "$pattern")
  if [ ! -f "$CLIENT_IMAGES_DIR/$name" ]; then
    cp "$pattern" "$CLIENT_IMAGES_DIR/$name"
  fi
done

# El volumen puede llegar con propietario root desde Easy Panel: lo reclama node.
chown -R node:node "$DATA_DIR" "$CLIENT_IMAGES_DIR" 2>/dev/null || true

# ------------------------------------------------------------------------------
# Desarrollo remoto en el contenedor (git + opencode desde la Terminal de Easy Panel)
# ------------------------------------------------------------------------------
# EasyPanel construye la imagen SIN historial git (el contexto no incluye .git).
# Si falta, se recrea el repo desde el remoto público para poder commitear y
# pushear desde la consola. El working tree de la imagen es efímero: lo que no
# se haga `git push` se pierde en el siguiente redeploy.
if [ ! -d /app/.git ] && command -v git >/dev/null 2>&1; then
  echo "[entrypoint] /app/.git ausente: recreando historial desde GitHub"
  if git -C /app init -q \
     && git -C /app remote add origin https://github.com/lexahabla/TRADYLOR.git \
     && git -C /app fetch -q --depth 1 origin main \
     && git -C /app reset -q --hard FETCH_HEAD; then
    echo "[entrypoint] Repo git listo en /app (rama main)"
  else
    echo "[entrypoint] Aviso: no se pudo inicializar el repo git"
    rm -rf /app/.git 2>/dev/null || true
  fi
fi

if command -v git >/dev/null 2>&1; then
  git config --global safe.directory /app || true

  # Identidad de commit (opcional, definir en Easy Panel)
  if [ -n "${GIT_USER_NAME:-}" ]; then git config --global user.name "$GIT_USER_NAME"; fi
  if [ -n "${GIT_USER_EMAIL:-}" ]; then git config --global user.email "$GIT_USER_EMAIL"; fi

  # Push a GitHub con PAT opcional (env GITHUB_PAT en Easy Panel).
  # El token queda sólo en .git/config DENTRO del contenedor, nunca en la imagen.
  if [ -n "${GITHUB_PAT:-}" ]; then
    git remote set-url origin "https://x-access-token:${GITHUB_PAT}@github.com/lexahabla/TRADYLOR.git" || true
  fi
fi

# Persiste la config de opencode (proveedor/key de IA) en el volumen para que
# sobreviva a los redeploy. Best effort: si la ruta cambia, se reconecta a mano.
if [ -d "$DATA_DIR" ] && [ ! -e "$HOME/.config/opencode" ]; then
  mkdir -p "$DATA_DIR/opencode-config" "$HOME/.config"
  ln -s "$DATA_DIR/opencode-config" "$HOME/.config/opencode" 2>/dev/null || true
fi

echo "[entrypoint] DATA_DIR=$DATA_DIR | IMAGES_DIR=$IMAGES_DIR | PORT=${PORT:-4321} | HOST=$HOST"

cd /app
if [ "$#" -eq 0 ]; then
  set -- node dist/server/entry.mjs
fi

if [ "$(id -u)" = "0" ] && command -v gosu >/dev/null 2>&1; then
  exec gosu node:node "$@"
fi
exec "$@"
