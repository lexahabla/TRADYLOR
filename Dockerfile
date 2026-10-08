# ==============================================================================
# TRADYLOR - Imagen de producción (Easy Panel / Docker)
# Astro 4 (SSR) con adaptador @astrojs/node en modo standalone.
# ==============================================================================
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Forzar la IP y el puerto para producción
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000
CMD ["sh", "-c", "HOST=0.0.0.0 PORT=3000 node --experimental-global-webcrypto ./dist/server/entry.mjs"]
