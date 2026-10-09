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
# Si falta, se recrea el repo desde el remoto (repo privado: usa GITHUB_PAT) para
# poder commitear y pushear desde la consola. El working tree de la imagen es
# efímero: lo que no se haga `git push` se pierde en el siguiente redeploy.
if [ -n "${GITHUB_PAT:-}" ]; then
  GIT_REMOTE="https://x-access-token:${GITHUB_PAT}@github.com/lexahabla/TRADYLOR.git"
else
  GIT_REMOTE="https://github.com/lexahabla/TRADYLOR.git"
fi

if [ ! -d /app/.git ] && command -v git >/dev/null 2>&1; then
  echo "[entrypoint] /app/.git ausente: recreando historial desde GitHub"
  if git -C /app init -q -b main \
     && git -C /app remote add origin "$GIT_REMOTE" \
     && git -C /app fetch -q --depth 1 origin main \
     && git -C /app reset -q --hard FETCH_HEAD; then
    # Doble seguro: el volumen montado en /app/data y el artefacto /app/seed
    # jamás entran en un commit.
    printf '/data/\n/seed/\n' >> /app/.git/info/exclude
    echo "[entrypoint] Repo git listo en /app (rama main)"
  else
    echo "[entrypoint] Aviso: no se pudo inicializar el repo git (¿GITHUB_PAT definido en Easy Panel?)"
    rm -rf /app/.git 2>/dev/null || true
  fi
fi

if command -v git >/dev/null 2>&1; then
  git config --global safe.directory /app || true

  # Identidad de commit (opcional, definir en Easy Panel)
  if [ -n "${GIT_USER_NAME:-}" ]; then git config --global user.name "$GIT_USER_NAME"; fi
  if [ -n "${GIT_USER_EMAIL:-}" ]; then git config --global user.email "$GIT_USER_EMAIL"; fi

  # Remote con PAT para push (el token queda sólo en .git/config DEL contenedor).
  if [ -n "${GITHUB_PAT:-}" ] && [ -d /app/.git ]; then
    git -C /app remote set-url origin "$GIT_REMOTE" || true
  fi
fi

# Persiste la configuración de opencode en el volumen para que las credenciales
# de IA (auth.json) y su estado sobrevivan a los redeploys:
#   ~/.config/opencode    -> $DATA_DIR/opencode-config  (config y plugins)
#   ~/.local/share/opencode -> $DATA_DIR/opencode-data   (auth.json de /connect, log, db)
# El directorio que traiga la imagen se migra al volumen (sin pisar lo que ya
# haya) y se sustituye por un symlink.
persist_dir() {
  _src="$1"
  _dst="$2"
  if [ -d "$_src" ] && [ ! -L "$_src" ]; then
    mkdir -p "$_dst"
    cp -a "$_src/." "$_dst/" 2>/dev/null || true
    rm -rf "$_src"
    ln -s "$_dst" "$_src" 2>/dev/null || true
  elif [ ! -e "$_src" ]; then
    mkdir -p "$_dst"
    ln -s "$_dst" "$_src" 2>/dev/null || true
  fi
  if [ -L "$_src" ]; then
    echo "[entrypoint] opencode $_src -> $_dst (persistente en el volumen)"
  fi
}
persist_dir "${HOME:-/root}/.config/opencode" "$DATA_DIR/opencode-config"
persist_dir "${HOME:-/root}/.local/share/opencode" "$DATA_DIR/opencode-data"

echo "[entrypoint] DATA_DIR=$DATA_DIR | IMAGES_DIR=$IMAGES_DIR | PORT=${PORT:-4321} | HOST=$HOST"

cd /app
if [ "$#" -eq 0 ]; then
  set -- node dist/server/entry.mjs
fi

if [ "$(id -u)" = "0" ] && command -v gosu >/dev/null 2>&1; then
  exec gosu node:node "$@"
fi
exec "$@"
