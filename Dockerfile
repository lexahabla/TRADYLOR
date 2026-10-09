# ==============================================================================
# TRADYLOR - Imagen de producción (Easy Panel / Docker)
# Astro 4 (SSR) con adaptador @astrojs/node en modo standalone.
# Puerto de destino en Easy Panel: 4321 (tradylor.com / www.tradylor.com)
# ==============================================================================
FROM node:22-bookworm-slim

WORKDIR /app

# ca-certificates: TLS en el build (npm) y en runtime (redes de afiliación).
# git/openssh/curl: desarrollo remoto dentro del contenedor (commit/push).
# gosu: el entrypoint entra como root (reclama el volumen) y baja a `node`.
# Si gosu no estuviera disponible, el contenedor sigue arrancando como root.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client curl \
 && (apt-get install -y --no-install-recommends gosu || true) \
 && rm -rf /var/lib/apt/lists/*

# opencode: agente de desarrollo en la terminal (se usa desde la Terminal de
# Easy Panel). La config/keys se persisten en el volumen vía entrypoint.
RUN npm install -g opencode-ai && npm cache clean --force

# Dependencias (incluye devDependencies: astro, tailwind, etc.)
COPY package*.json ./
RUN npm ci && npm cache clean --force

# Fuentes + build SSR. /app/seed conserva los JSON originales para la siembra
# del volumen en el primer arranque (no lleva credentials.json: .dockerignore).
COPY . .
RUN npm run build && cp -r src/data /app/seed

# Volumen persistente (Easy Panel → /app/data) y escucha detrás del proxy.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    TRADYLOR_DATA_DIR=/app/data \
    TRADYLOR_IMAGES_DIR=/app/data/images/products

EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4321)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]
CMD ["node", "dist/server/entry.mjs"]
