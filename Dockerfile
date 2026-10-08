# ==============================================================================
# TRADYLOR - Imagen de producción (Easy Panel / Docker)
# Astro 4 (SSR) con adaptador @astrojs/node en modo standalone.
# ==============================================================================

# -----------------------------------------------
# Fase 1: build
# -----------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Dependencias (incluye devDependencies: astro, tailwind, etc.)
COPY package.json package-lock.json ./
RUN npm ci

# Fuentes necesarias para `astro build`
COPY astro.config.mjs tailwind.config.mjs tsconfig.json ./
COPY public ./public
COPY src ./src

RUN npm run build

# -----------------------------------------------
# Fase 2: runtime
# -----------------------------------------------
FROM node:20-alpine AS runner

WORKDIR /app

# su-exec: el entrypoint entra como root (para reclamar el volumen) y
# arranca el servidor como usuario `node` sin privilegios.
RUN apk add --no-cache su-exec

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    HOSTNAME=0.0.0.0 \
    TRADYLOR_DATA_DIR=/app/data \
    TRADYLOR_IMAGES_DIR=/app/data/images/products

# Sólo dependencias de producción en la imagen final
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Build SSR + datos semilla (products/categories/analytics) + entrypoint
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/src/data ./seed
COPY --chown=node:node docker/entrypoint.sh ./entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Arranca como root para poder escribir en el volumen; baja a `node` en el entrypoint.
ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
