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

echo "[entrypoint] DATA_DIR=$DATA_DIR | IMAGES_DIR=$IMAGES_DIR | PORT=${PORT:-3000} | HOST=$HOST"

cd /app
if [ "$(id -u)" = "0" ]; then
  exec su-exec node:node node dist/server/entry.mjs
fi
exec node dist/server/entry.mjs
